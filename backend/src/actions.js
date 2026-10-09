// Action runner. Every action is a plain JSON object with a "type".
// Actions never throw out of run(): failures are logged and reported back so a
// bad binding can't take the daemon down.
import { spawn } from 'node:child_process'
import * as win from './win32.js'
import { log } from './log.js'
import { HAPTIC } from './device.js'
import { lightAction } from './light.js'
import { lutron } from './lutron.js'
import { ha } from './ha.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function spawnDetached(cmd, args, opts = {}) {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts })
    child.on('error', err => log.error(`Failed to start ${cmd}: ${err.message}`))
    child.unref()
}

// "start" resolves URLs, files, folders, ms-settings: URIs, app aliases (wt, code...)
function shellOpen(target, args = []) {
    spawnDetached('cmd.exe', ['/d', '/s', '/c', 'start', '""', target, ...args], { windowsVerbatimArguments: false })
}

const MEDIA_KEYS = { playpause: 'playpause', play: 'playpause', pause: 'playpause', next: 'medianext', prev: 'mediaprev', previous: 'mediaprev', stop: 'mediastop' }

// Each handler: async (action, ctx) => result. ctx.delta is set for knob rotation.
export const ACTIONS = {
    none: async () => {},

    hotkey: async a => {
        const list = Array.isArray(a.keys) ? a.keys : [a.keys]
        for (const [i, combo] of list.entries()) {
            if (i) await sleep(a.delay ?? 40)
            win.sendCombo(combo)
        }
    },

    // Hold keys while the control is held (ctx.phase = 'down' | 'up')
    hold: async (a, ctx) => {
        if (ctx.phase === 'up') win.keyUp(a.keys)
        else win.keyDown(a.keys)
    },

    type: async a => { win.typeText(a.text ?? '') },

    open: async a => shellOpen(a.target, a.args || []),

    launch: async a => spawnDetached(a.path, a.args || [], { cwd: a.cwd }),

    shell: async a => {
        const shell = (a.shell || 'powershell').toLowerCase()
        if (shell === 'cmd') spawnDetached('cmd.exe', ['/d', '/s', '/c', a.command])
        else spawnDetached('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', a.command])
    },

    media: async a => {
        const key = MEDIA_KEYS[a.key]
        if (!key) throw new Error(`Unknown media key "${a.key}"`)
        win.sendCombo(key)
    },

    // Absolute set, or relative step (multiplied by knob delta when rotating)
    volume: async (a, ctx) => {
        const target = a.target || 'speakers'
        if (a.set !== undefined) win.setVolume(target, a.set)
        else win.changeVolume(target, (a.step ?? 0.02) * (ctx.delta ?? 1))
        ctx.controller?.refreshAudio()
    },

    mute: async (a, ctx) => {
        const target = a.target || 'speakers'
        if (a.mode === 'on') win.setMute(target, true)
        else if (a.mode === 'off') win.setMute(target, false)
        else win.toggleMute(target)
        ctx.controller?.refreshAudio()
    },

    scroll: async (a, ctx) => win.scroll((a.amount ?? 1) * (ctx.delta ?? 1), !!a.horizontal),

    page: async (a, ctx) => ctx.controller.goToPage(a.page),

    // Logitech Litra light
    light: async (a, ctx) => {
        await lightAction(a, ctx.delta ?? 1)
        ctx.controller?.refreshLight()
    },

    // Lutron lights / shades / fans / scenes
    lutron: async (a, ctx) => {
        await lutron.action(a, ctx.delta ?? 1)
        ctx.controller?.requestRender()
    },

    // Home Assistant lights / switches / fans / scripts / scenes
    ha: async (a, ctx) => {
        await ha.action(a, ctx.delta ?? 1)
        ctx.controller?.requestRender()
    },

    brightness: async (a, ctx) => {
        const c = ctx.controller
        if (a.set !== undefined) c.setBrightness(a.set)
        else c.setBrightness(c.brightness + (a.step ?? 0.1) * (ctx.delta ?? 1))
    },

    haptic: async (a, ctx) => ctx.controller.device.vibrate(HAPTIC[a.pattern] ?? HAPTIC.SHORT),

    http: async a => {
        const res = await fetch(a.url, {
            method: a.method || 'GET',
            headers: a.headers,
            body: a.body === undefined ? undefined : typeof a.body === 'string' ? a.body : JSON.stringify(a.body),
            signal: AbortSignal.timeout(a.timeout ?? 5000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${a.url}`)
    },

    // Flip a named toggle (shown on keys via widget {type:"toggle"}) and run on/off actions
    toggle: async (a, ctx) => {
        const c = ctx.controller
        const next = !c.toggles[a.id]
        c.toggles[a.id] = next
        c.requestRender()
        const sub = next ? a.on : a.off
        if (sub) await runAction(sub, ctx)
    },

    delay: async a => sleep(a.ms ?? 100),

    multi: async (a, ctx) => {
        for (const sub of a.actions || []) {
            await runAction(sub, ctx)
            if (a.delay) await sleep(a.delay)
        }
    },
}

export const ACTION_TYPES = Object.keys(ACTIONS)

export async function runAction(action, ctx = {}) {
    if (!action || !action.type) return { ok: true }
    const handler = ACTIONS[action.type]
    if (!handler) {
        log.warn(`Unknown action type "${action.type}"`)
        return { ok: false, error: `Unknown action type "${action.type}"` }
    }
    try {
        await handler(action, ctx)
        return { ok: true }
    } catch (err) {
        log.error(`Action ${action.type} failed: ${err.message}`)
        return { ok: false, error: err.message }
    }
}
