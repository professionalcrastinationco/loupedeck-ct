// Lutron LEAP bridge integration (Caseta Smart Bridge, RA3, QSX).
// Keeps a persistent TLS connection, tracks every zone's level live via
// subscriptions, and reconnects forever with backoff. Pair first with
// src/lutron-pair.js (creates data/lutron.json).
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import leap from 'lutron-leap'
import { DATA_DIR } from './paths.js'
import { log } from './log.js'

const CRED_FILE = path.join(DATA_DIR, 'lutron.json')
const PING_MS = 30_000
const REQUEST_TIMEOUT = 5000
// After we command a level, ignore the bridge's reports for this long. While a
// light fades it reports intermediate levels; if those overwrite our value,
// fast knob turns step from stale numbers and the level bounces up and down.
const HOLD_REPORTS_MS = 1500

const withTimeout = (p, ms, what) => {
    let t
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms) })]).finally(() => clearTimeout(t))
}
const idOf = href => href?.split('/').pop()

export class Lutron extends EventEmitter {
    constructor() {
        super()
        this.state = 'disabled'
        this.zones = new Map()   // id -> { id, name, area, type, level, fanSpeed }
        this.scenes = new Map()  // id -> { id, name }
        this.client = null
        this.backoff = 2000
    }

    get configured() { return fs.existsSync(CRED_FILE) }

    start() {
        if (!this.configured) { this.state = 'not paired'; return }
        this.connect()
    }

    async connect() {
        clearTimeout(this.retryTimer)
        clearInterval(this.pingTimer)
        let creds
        try { creds = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) } catch (err) { this.state = `bad credentials: ${err.message}`; return }
        this.state = 'connecting'
        this.emit('change')
        const client = new leap.LeapClient(creds.host, 8081, creds.ca, creds.key, creds.cert)
        this.client = client
        try {
            await withTimeout(client.connect(), REQUEST_TIMEOUT, 'Lutron connect')
            client.on('disconnected', () => this.onLost('disconnected'))
            client.on('unsolicited', r => this.onUnsolicited(r))
            await this.loadInventory()
            this.state = 'connected'
            this.backoff = 2000
            log.info(`Lutron bridge ${creds.host} connected: ${this.zones.size} zones, ${this.scenes.size} scenes`)
            this.pingTimer = setInterval(() => {
                withTimeout(client.ping(), REQUEST_TIMEOUT, 'Lutron ping').catch(err => this.onLost(err.message))
            }, PING_MS)
            this.emit('change')
        } catch (err) {
            this.onLost(err.message)
        }
    }

    onLost(reason) {
        if (this.state === 'reconnecting') return
        log.warn(`Lutron connection lost (${reason}); retrying in ${this.backoff / 1000}s`)
        this.state = 'reconnecting'
        clearInterval(this.pingTimer)
        try { this.client?.close() } catch { /* ignore */ }
        this.client = null
        this.emit('change')
        this.retryTimer = setTimeout(() => this.connect(), this.backoff)
        this.backoff = Math.min(this.backoff * 2, 60_000)
    }

    async get(url) {
        const r = await withTimeout(this.client.request('ReadRequest', url), REQUEST_TIMEOUT, `GET ${url}`)
        return r.Body
    }

    async loadInventory() {
        const areas = new Map(((await this.get('/area')).Areas || []).map(a => [a.href, a.Name]))
        // Caseta zones point at their device; the device knows its room
        const deviceArea = new Map()
        try {
            for (const d of (await this.get('/device')).Devices || []) deviceArea.set(d.href, areas.get(d.AssociatedArea?.href))
        } catch { /* QSX may not list devices here */ }
        const zones = (await this.get('/zone')).Zones || []
        this.zones.clear()
        for (const z of zones) {
            const id = idOf(z.href)
            const area = areas.get(z.AssociatedArea?.href) ?? deviceArea.get(z.Device?.href) ?? ''
            this.zones.set(id, { id, name: z.Name, area, type: z.ControlType, category: z.Category?.Type, level: null })
        }
        // Scenes ("virtual buttons") on Caseta; not every bridge has them
        try {
            const vbs = (await this.get('/virtualbutton')).VirtualButtons || []
            this.scenes.clear()
            for (const b of vbs) if (b.IsProgrammed) this.scenes.set(idOf(b.href), { id: idOf(b.href), name: b.Name })
        } catch { /* not supported */ }
        // Live level updates for every zone
        await withTimeout(this.client.subscribe('/zone/status', r => this.onZoneStatus(r)), REQUEST_TIMEOUT, 'subscribe').catch(async () => {
            for (const id of this.zones.keys()) await this.client.subscribe(`/zone/${id}/status`, r => this.onZoneStatus(r)).catch(() => {})
        })
        for (const id of this.zones.keys()) {
            try { this.applyStatus((await this.get(`/zone/${id}/status`)).ZoneStatus) } catch { /* ignore one bad zone */ }
        }
    }

    onUnsolicited(r) { if (r?.Body) this.onZoneStatus(r) }

    onZoneStatus(r) {
        const b = r?.Body
        if (b?.ZoneStatus) this.applyStatus(b.ZoneStatus)
        for (const s of b?.ZoneStatuses || []) this.applyStatus(s)
    }

    applyStatus(s) {
        const z = this.zones.get(idOf(s?.Zone?.href))
        if (!z) return
        if (Date.now() < (z.holdUntil ?? 0)) return // our own command is still settling
        if (typeof s.Level === 'number') z.level = s.Level
        if (s.SwitchedLevel) z.level = s.SwitchedLevel === 'On' ? 100 : 0
        if (s.FanSpeed) z.fanSpeed = s.FanSpeed
        this.emit('change')
    }

    // Drop the current connection and start over (after pairing / unpairing)
    restart() {
        clearTimeout(this.retryTimer)
        clearInterval(this.pingTimer)
        try { this.client?.close() } catch { /* ignore */ }
        this.client = null
        this.zones.clear()
        this.scenes.clear()
        this.backoff = 2000
        this.state = 'disabled'
        this.start()
        this.emit('change')
    }

    unpair() {
        try { fs.renameSync(CRED_FILE, CRED_FILE + '.removed') } catch { /* not paired */ }
        this.restart()
    }

    host() {
        try { return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')).host } catch { return null }
    }

    list() {
        return {
            state: this.state,
            host: this.host(),
            pairing: this.pairing ?? null,
            zones: [...this.zones.values()].sort((a, b) => `${a.area} ${a.name}`.localeCompare(`${b.area} ${b.name}`)),
            scenes: [...this.scenes.values()],
        }
    }

    zone(id) { return this.zones.get(String(id)) }

    async command(url, Command) {
        if (this.state !== 'connected') throw new Error(`Lutron bridge is ${this.state}`)
        const r = await withTimeout(this.client.request('CreateRequest', url, { Command }), REQUEST_TIMEOUT, 'Lutron command')
        const code = r?.Header?.StatusCode
        if (code && !String(code).startsWith('2')) throw new Error(`Lutron: ${code} ${r?.Body?.Message ?? ''}`)
    }

    setLevel(id, level) {
        const z = this.zone(id)
        if (!z) throw new Error(`Unknown Lutron zone ${id}`)
        level = Math.round(Math.max(0, Math.min(100, level)))
        // Our requested level becomes the truth until the bridge settles
        z.level = level
        z.holdUntil = Date.now() + HOLD_REPORTS_MS
        this.emit('change')
        clearTimeout(z.settleTimer)
        z.settleTimer = setTimeout(() => this.refreshZone(id), HOLD_REPORTS_MS + 100)
        return this.sendLevel(z)
    }

    // At most one command in flight per zone; while it's out, only the newest
    // requested level is kept and sent next (a fast spin = a few commands, not 30).
    async sendLevel(z) {
        if (z.sending) { z.dirty = true; return z.sending }
        z.sending = (async () => {
            try {
                do {
                    z.dirty = false
                    await this.command(`/zone/${z.id}/commandprocessor`, { CommandType: 'GoToLevel', Parameter: [{ Type: 'Level', Value: z.level }] })
                } while (z.dirty)
            } finally {
                z.sending = null
            }
        })()
        return z.sending
    }

    async refreshZone(id) {
        const z = this.zone(id)
        if (!z || Date.now() < z.holdUntil || this.state !== 'connected') return
        try { this.applyStatus((await this.get(`/zone/${id}/status`)).ZoneStatus) } catch { /* next report fixes it */ }
    }

    setFan(id, speed) {
        return this.command(`/zone/${id}/commandprocessor`, { CommandType: 'GoToFanSpeed', FanSpeedParameters: { FanSpeed: speed } })
    }

    scene(id) {
        return this.command(`/virtualbutton/${id}/commandprocessor`, { CommandType: 'PressAndRelease' })
    }

    // op: toggle | on | off | level (set 0-100 or step, scaled by knob delta) | fan | scene
    async action({ op = 'toggle', zone, scene, set, step, speed }, delta = 1) {
        if (op === 'scene') return this.scene(scene)
        const z = this.zone(zone)
        if (!z) throw new Error(`Unknown Lutron zone "${zone}"`)
        if (op === 'fan') return this.setFan(zone, speed || 'High')
        if (op === 'on') return this.setLevel(zone, set ?? 100)
        if (op === 'off') return this.setLevel(zone, 0)
        if (op === 'toggle') return this.setLevel(zone, (z.level ?? 0) > 0 ? 0 : (set ?? 100))
        if (op === 'level') return this.setLevel(zone, set ?? (z.level ?? 0) + (step ?? 5) * delta)
        throw new Error(`Unknown Lutron op "${op}"`)
    }
}

export const lutron = new Lutron()
