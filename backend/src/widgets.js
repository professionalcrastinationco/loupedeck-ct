// Live data for keys / knob strips. A widget definition like {type:"cpu"} maps
// to a value object: { text, sub, level (0..1, drawn as a bar), active (bool) }.
import os from 'node:os'
import { execFile } from 'node:child_process'
import * as win from './win32.js'
import { log } from './log.js'
import { getLightState } from './light.js'
import { lutron } from './lutron.js'

const pct = v => `${Math.round(v * 100)}%`

export class WidgetEngine {
    constructor(controller) {
        this.controller = controller
        this.cpu = { level: 0, prev: os.cpus() }
        this.audio = { speakers: null, mic: null }
        this.light = null
        this.lightPolling = false
        this.cache = new Map() // key -> { value, at, running }
    }

    // Called once per second by the controller
    tick() {
        const cur = os.cpus()
        let idle = 0, total = 0
        cur.forEach((c, i) => {
            const p = this.cpu.prev[i]?.times
            if (!p) return
            for (const k of Object.keys(c.times)) total += c.times[k] - p[k]
            idle += c.times.idle - p.idle
        })
        this.cpu.prev = cur
        if (total > 0) this.cpu.level = 1 - idle / total
    }

    refreshAudio() {
        for (const target of ['speakers', 'mic']) {
            try { this.audio[target] = win.getVolume(target) } catch { this.audio[target] = null }
        }
    }

    async refreshLight() {
        if (this.lightPolling) return
        this.lightPolling = true
        try { this.light = await getLightState() } catch { this.light = null }
        finally { this.lightPolling = false }
    }

    // Periodically refreshed async sources (shell command, http)
    cached(key, intervalSec, fetcher) {
        let entry = this.cache.get(key)
        if (!entry) { entry = { value: { text: '…' }, at: 0, running: false }; this.cache.set(key, entry) }
        const due = Date.now() - entry.at > intervalSec * 1000
        if (due && !entry.running) {
            entry.running = true
            fetcher()
                .then(value => { entry.value = value })
                .catch(err => { entry.value = { text: 'ERR', sub: err.message.slice(0, 40) }; log.warn(`Widget ${key}: ${err.message}`) })
                .finally(() => { entry.at = Date.now(); entry.running = false; this.controller.requestRender() })
        }
        return entry.value
    }

    value(w) {
        if (!w || !w.type) return null
        switch (w.type) {
            case 'clock': {
                const d = new Date()
                const h24 = w.format === '24h'
                const text = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: !h24 }).replace(/\s?[AP]M$/, '')
                const sub = h24 ? d.toLocaleDateString('en-US', { weekday: 'short' }) : (d.getHours() < 12 ? 'AM' : 'PM')
                return { text, sub }
            }
            case 'date': {
                const d = new Date()
                return { text: String(d.getDate()), sub: d.toLocaleDateString('en-US', { weekday: 'short', month: 'short' }) }
            }
            case 'cpu':
                return { text: pct(this.cpu.level), level: this.cpu.level, sub: 'CPU' }
            case 'memory': {
                const used = 1 - os.freemem() / os.totalmem()
                return { text: pct(used), level: used, sub: `${(os.totalmem() / 2 ** 30).toFixed(0)} GB RAM` }
            }
            case 'volume': {
                const a = this.audio[w.target || 'speakers']
                if (!a) return { text: 'n/a' }
                return { text: a.muted ? 'MUTED' : pct(a.level), level: a.level, active: a.muted }
            }
            case 'mute': {
                const a = this.audio[w.target || 'mic']
                if (!a) return { text: 'n/a' }
                return { text: a.muted ? 'MUTED' : 'LIVE', active: a.muted }
            }
            case 'light': {
                const l = this.light
                if (!l) return { text: 'n/a', sub: 'Light' }
                if (w.show === 'temperature') return { text: `${l.kelvin}K`, level: (l.kelvin - l.minKelvin) / (l.maxKelvin - l.minKelvin), active: l.on }
                return { text: l.on ? `${Math.round(l.level * 100)}%` : 'OFF', sub: l.on ? `${l.kelvin}K` : 'Light', level: l.on ? l.level : undefined, active: l.on }
            }
            case 'lutron': {
                const z = lutron.zone(w.zone)
                if (!z) return { text: lutron.state === 'connected' ? '?' : 'n/a', sub: 'Lutron' }
                const on = (z.level ?? 0) > 0
                if (z.level === null) return { text: '…', sub: z.name }
                if (z.type === 'Switched') return { text: on ? 'ON' : 'OFF', sub: z.name, active: on }
                return { text: on ? `${z.level}%` : 'OFF', sub: z.name, level: on ? z.level / 100 : undefined, active: on }
            }
            case 'toggle': {
                const on = !!this.controller.toggles[w.id]
                return { text: on ? (w.onText ?? 'ON') : (w.offText ?? 'OFF'), active: on }
            }
            case 'page':
                return { text: this.controller.page?.name ?? '' }
            case 'command':
                return this.cached(`cmd:${w.command}`, w.interval ?? 30, () => new Promise((res, rej) => {
                    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', w.command],
                        { timeout: (w.timeout ?? 10) * 1000, windowsHide: true },
                        (err, stdout) => {
                            if (err) return rej(err)
                            const lines = stdout.trim().split(/\r?\n/)
                            res({ text: lines[0] ?? '', sub: lines[1] })
                        })
                }))
            case 'http':
                return this.cached(`http:${w.url}:${w.path}`, w.interval ?? 60, async () => {
                    const r = await fetch(w.url, { headers: w.headers, signal: AbortSignal.timeout(10000) })
                    if (!r.ok) throw new Error(`HTTP ${r.status}`)
                    if (!w.path) return { text: (await r.text()).trim().slice(0, 40) }
                    let v = await r.json()
                    for (const part of w.path.split('.')) v = v?.[part]
                    const text = typeof v === 'number' && w.decimals !== undefined ? v.toFixed(w.decimals) : String(v ?? '')
                    return { text: `${w.prefix ?? ''}${text}${w.suffix ?? ''}` }
                })
            default:
                return { text: `?${w.type}` }
        }
    }
}
