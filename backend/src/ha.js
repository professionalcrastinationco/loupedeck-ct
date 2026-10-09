// Home Assistant integration over the WebSocket API (home-assistant-js-websocket).
// Keeps one connection, mirrors entity state live (so keys update when a wall
// switch, voice assistant or automation changes something) and reconnects
// forever with backoff. Settings live in data/homeassistant.json: { url, token }
// where token is a long-lived access token (HA profile -> Security).
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createConnection, createLongLivedTokenAuth, subscribeEntities, callService, ERR_INVALID_AUTH } from 'home-assistant-js-websocket'
import { DATA_DIR } from './paths.js'
import { log } from './log.js'

const CONF_FILE = path.join(DATA_DIR, 'homeassistant.json')
// Last on-brightness per dimmable light. Some lights (e.g. Zigbee dimmers) come
// back at 100% on a bare turn_on, so "on" re-sends the level they had before.
const LEVELS_FILE = path.join(DATA_DIR, 'ha-levels.json')
const REQUEST_TIMEOUT = 5000
// Same rule as Lutron: after we command a level, HA echoes intermediate or
// stale states while the light transitions. Ignore them for this long so fast
// knob turns step from our own value instead of bouncing.
const HOLD_REPORTS_MS = 1500
export const HA_DOMAINS = ['light', 'switch', 'fan', 'input_boolean', 'script', 'scene']

const withTimeout = (p, ms, what) => {
    let t
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms) })]).finally(() => clearTimeout(t))
}
// The library rejects with numeric codes, not Errors
const errText = err => err === ERR_INVALID_AUTH ? 'invalid token' : typeof err === 'number' ? `cannot connect (code ${err})` : err?.message ?? String(err)
const pctOf = e => e.state !== 'on' ? 0 : typeof e.attributes.brightness === 'number' ? e.attributes.brightness / 2.55 : 100

export class HomeAssistant extends EventEmitter {
    constructor() {
        super()
        this.state = 'disabled'
        this.entities = new Map() // id -> { id, name, domain, state, level (0-100 or null), dimmable }
        // Per-entity runtime bookkeeping (timers, in-flight sends), kept out of
        // the entity objects so list() stays plain, JSON-serializable data.
        this.rt = new Map()       // id -> { holdUntil, settleTimer, level, sending, dirty }
        this.raw = {}             // last full entity snapshot from HA
        this.lastOn = this.loadLevels() // id -> last brightness (0-100) while on
        this.conn = null
        this.unsub = null
        this.backoff = 2000
    }

    settings() {
        try {
            const s = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'))
            return s?.url && s?.token ? s : null
        } catch { return null }
    }

    get configured() { return !!this.settings() }

    loadLevels() {
        try { return new Map(Object.entries(JSON.parse(fs.readFileSync(LEVELS_FILE, 'utf8')))) } catch { return new Map() }
    }

    rememberLevel(id, level) {
        if (!(level > 0) || this.lastOn.get(id) === level) return
        this.lastOn.set(id, level)
        clearTimeout(this.levelsTimer)
        this.levelsTimer = setTimeout(() => {
            try { fs.writeFileSync(LEVELS_FILE, JSON.stringify(Object.fromEntries(this.lastOn))) } catch { /* not critical */ }
        }, 2000)
        this.levelsTimer.unref?.()
    }

    start() {
        if (!this.configured) { this.state = 'not configured'; return }
        this.connect()
    }

    async connect() {
        clearTimeout(this.retryTimer)
        const s = this.settings()
        if (!s) { this.state = 'not configured'; this.emit('change'); return }
        this.state = 'connecting'
        this.emit('change')
        try {
            const auth = createLongLivedTokenAuth(s.url.replace(/\/+$/, ''), s.token)
            const conn = await withTimeout(createConnection({ auth, setupRetry: 0 }), 15_000, 'Home Assistant connect')
            this.conn = conn
            // After the first connect the library reconnects by itself
            conn.addEventListener('disconnected', () => { this.state = 'reconnecting'; log.warn('Home Assistant connection lost; library is reconnecting'); this.emit('change') })
            conn.addEventListener('ready', () => { if (this.state !== 'connected') log.info('Home Assistant reconnected'); this.state = 'connected'; this.emit('change') })
            conn.addEventListener('reconnect-error', (_, err) => {
                // The library gives up on a bad token; anything else it retries
                if (err === ERR_INVALID_AUTH) this.onLost('invalid token')
            })
            this.unsub = subscribeEntities(conn, ents => this.onEntities(ents))
            this.state = 'connected'
            this.backoff = 2000
            log.info(`Home Assistant ${s.url} connected (HA ${conn.haVersion})`)
            this.emit('change')
        } catch (err) {
            this.onLost(errText(err))
        }
    }

    onLost(reason) {
        if (this.state === 'retrying') return
        log.warn(`Home Assistant unavailable (${reason}); retrying in ${this.backoff / 1000}s`)
        this.state = 'retrying'
        this.close()
        this.emit('change')
        this.retryTimer = setTimeout(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, 60_000)
    }

    close() {
        try { this.unsub?.() } catch { /* ignore */ }
        try { this.conn?.close() } catch { /* ignore */ }
        this.unsub = null
        this.conn = null
    }

    onEntities(ents) {
        this.raw = ents
        const now = Date.now()
        for (const [id, e] of Object.entries(ents)) {
            const domain = id.split('.')[0]
            if (!HA_DOMAINS.includes(domain)) continue
            const prev = this.entities.get(id)
            const held = now < (this.rt.get(id)?.holdUntil ?? 0) // our own command is still settling
            const modes = e.attributes.supported_color_modes || []
            const dimmable = domain === 'light' && modes.some(m => m !== 'onoff')
            if (dimmable && !held && e.state === 'on' && typeof e.attributes.brightness === 'number') this.rememberLevel(id, pctOf(e))
            this.entities.set(id, {
                id, domain,
                name: e.attributes.friendly_name || id,
                state: held && prev ? prev.state : e.state,
                level: domain !== 'light' ? null : held && prev ? prev.level : Math.round(pctOf(e)),
                dimmable,
            })
        }
        for (const id of this.entities.keys()) if (!(id in ents)) this.entities.delete(id)
        this.emit('change')
    }

    restart() {
        clearTimeout(this.retryTimer)
        this.close()
        for (const r of this.rt.values()) clearTimeout(r.settleTimer)
        this.rt.clear()
        this.entities.clear()
        this.backoff = 2000
        this.state = 'disabled'
        this.start()
        this.emit('change')
    }

    // Saved to the gitignored data folder (like the Lutron certificate), never sent back to the UI
    saveSettings({ url, token }) {
        url = String(url || '').trim().replace(/\/+$/, '')
        token = String(token || '').trim() || this.settings()?.token
        if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error('URL must look like http://homeassistant.local:8123')
        if (!token) throw new Error('A long-lived access token is required')
        fs.mkdirSync(DATA_DIR, { recursive: true })
        fs.writeFileSync(CONF_FILE, JSON.stringify({ url, token }, null, 2))
        this.restart()
    }

    forget() {
        try { fs.renameSync(CONF_FILE, CONF_FILE + '.removed') } catch { /* not configured */ }
        this.restart()
    }

    list() {
        return {
            state: this.state,
            url: this.settings()?.url ?? null,
            entities: [...this.entities.values()].map(e => ({ ...e })).sort((a, b) => a.name.localeCompare(b.name)),
        }
    }

    entity(id) { return this.entities.get(String(id)) }

    runtime(id) {
        let r = this.rt.get(id)
        if (!r) { r = { holdUntil: 0, settleTimer: null, level: null, sending: null, dirty: false }; this.rt.set(id, r) }
        return r
    }

    // Start (or extend) the window where HA's echoes are ignored. When it ends,
    // re-apply HA's latest state so changes made meanwhile still show up.
    hold(id) {
        const rt = this.runtime(id)
        rt.holdUntil = Date.now() + HOLD_REPORTS_MS
        clearTimeout(rt.settleTimer)
        rt.settleTimer = setTimeout(() => { if (!rt.sending) this.onEntities(this.raw) }, HOLD_REPORTS_MS + 100)
    }

    async service(domain, service, entityId, data = {}) {
        if (this.state !== 'connected' || !this.conn) throw new Error(`Home Assistant is ${this.state}`)
        await withTimeout(callService(this.conn, domain, service, data, { entity_id: entityId }), REQUEST_TIMEOUT, `${domain}.${service}`)
    }

    // Absolute brightness writes only, so a retry can never apply a step twice
    setLevel(id, level) {
        const e = this.entity(id)
        const rt = this.runtime(id)
        rt.level = Math.max(0, Math.min(100, level)) // unrounded; rounded only when sent/shown
        this.rememberLevel(id, rt.level)
        this.hold(id)
        e.level = Math.round(rt.level)
        e.state = e.level > 0 ? 'on' : 'off'
        this.emit('change')
        return this.sendLevel(id)
    }

    // At most one call in flight per entity; the newest level wins
    async sendLevel(id) {
        const rt = this.runtime(id)
        if (rt.sending) { rt.dirty = true; return rt.sending }
        rt.sending = (async () => {
            try {
                do {
                    rt.dirty = false
                    const pct = Math.round(rt.level)
                    if (pct > 0) await this.service('light', 'turn_on', id, { brightness_pct: pct })
                    else await this.service('light', 'turn_off', id)
                    this.hold(id)
                } while (rt.dirty)
            } finally {
                rt.sending = null
            }
        })()
        return rt.sending
    }

    setOnOff(id, on) {
        const e = this.entity(id)
        this.hold(id)
        e.state = on ? 'on' : 'off'
        this.emit('change')
        return this.service(e.domain, on ? 'turn_on' : 'turn_off', e.id)
    }

    // op: toggle | on | off | level (set 0-100 or step, scaled by knob delta) | run (script / scene)
    async action({ op = 'toggle', entity, set, step }, delta = 1) {
        const e = this.entity(entity)
        if (!e) throw new Error(this.state === 'connected' ? `Unknown Home Assistant entity "${entity}"` : `Home Assistant is ${this.state}`)
        if (e.domain === 'script' || e.domain === 'scene' || op === 'run') return this.service(e.domain, 'turn_on', e.id)
        const isOn = e.state === 'on'
        if (e.domain === 'light' && e.dimmable) {
            const rt = this.runtime(e.id)
            const current = Date.now() < rt.holdUntil && rt.level !== null ? rt.level : e.level ?? 0
            if (op === 'level') return this.setLevel(e.id, set ?? current + (step ?? 5) * delta)
            // Turning on: an explicit level, else the level it had last time it was on
            const onLevel = set ?? this.lastOn.get(e.id)
            if ((op === 'on' || (op === 'toggle' && !isOn)) && onLevel !== undefined) return this.setLevel(e.id, onLevel)
        }
        if (op === 'on') return this.setOnOff(e.id, true)
        if (op === 'off') return this.setOnOff(e.id, false)
        if (op === 'toggle') return this.setOnOff(e.id, !isOn)
        if (op === 'level') return this.setOnOff(e.id, set !== undefined ? set > 0 : delta > 0)
        throw new Error(`Unknown Home Assistant op "${op}"`)
    }
}

export const ha = new HomeAssistant()
