// Controller: the brain. Maps device input -> actions, keeps page/toggle state,
// and renders only what changed to the device.
import { EventEmitter } from 'node:events'
import { runAction } from './actions.js'
import { WidgetEngine } from './widgets.js'
import { drawKey, drawStrip, drawWheel, preloadImages, forgetImages, imageRef } from './renderer.js'
import { KNOB_IDS, KEY_COUNT } from './config.js'
import { HAPTIC } from './device.js'
import { getForegroundApp } from './win32.js'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'
import { log } from './log.js'
import { lutron } from './lutron.js'
import { ha } from './ha.js'

const LONG_PRESS_MS = 500
// Remembers the current page so an unexpected restart doesn't jump back to the start page
const STATE_FILE = path.join(DATA_DIR, 'state.json')
const TAP_SLOP = 30
const SWIPE_MIN = 110

const DEFAULT_THEME = { background: '#000000', key: '#1f2937', text: '#f8fafc', accent: '#38bdf8', active: '#dc2626' }

function dim(hex, factor) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
    if (!m) return hex
    const n = parseInt(m[1], 16)
    const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v * factor))
    return `rgb(${c.join(',')})`
}

// First rule whose exe and/or title regex matches the focused window
export function matchRule(rules, fg) {
    return rules.find(r => {
        if (!r.exe && !r.title) return false
        if (r.exe && r.exe.toLowerCase() !== fg.exe) return false
        if (r.title) {
            try { if (!new RegExp(r.title, 'i').test(fg.title)) return false } catch { return false }
        }
        return true
    })
}

export class Controller extends EventEmitter {
    constructor(device, store) {
        super()
        this.device = device
        this.store = store
        this.widgets = new WidgetEngine(this)
        this.toggles = {}
        this.pressed = new Set()      // center keys currently touched
        this.touches = new Map()      // touch id -> { start, timer, longFired }
        this.holds = new Map()        // button id -> { timer, longFired, binding }
        this.highlightKnob = null
        this.signatures = new Map()   // render target -> last drawn signature
        this.foreground = null
        this.manualPageId = null
        this.autoPageId = null
        this.overrideApp = null
        this.currentRule = 'none'
        this.renderQueued = false
        this.lightTicks = 0
        this.applyConfig(store.config, true)

        store.on('change', cfg => this.applyConfig(cfg))
        device.on('connected', () => this.onConnected())
        device.on('disconnected', () => { this.signatures.clear(); this.emitStatus() })
        device.on('state', () => this.emitStatus())
        device.on('input', (ev, payload) => this.onInput(ev, payload))
        lutron.on('change', () => this.requestRender())
        ha.on('change', () => this.requestRender())
        // A dropped frame would otherwise stay stale until its content changes
        device.on('commandFailed', () => { this.signatures.clear(); this.requestRender() })

        this.tickTimer = setInterval(() => this.tick(), 1000)
        this.appTimer = setInterval(() => this.pollForegroundApp(), 700)
        this.widgets.refreshAudio()
        this.refreshLight()
    }

    dispose() {
        clearInterval(this.tickTimer)
        clearInterval(this.appTimer)
        clearTimeout(this.highlightTimer)
    }

    get config() { return this.store.config }
    get theme() { return { ...DEFAULT_THEME, ...(this.config.theme || {}) } }
    get pages() { return this.config.pages }
    get pageId() { return this.autoPageId ?? this.manualPageId }
    get page() { return this.pages.find(p => p.id === this.pageId) ?? this.pages[0] }

    applyConfig(cfg, initial = false) {
        const ids = cfg.pages.map(p => p.id)
        if (initial) {
            try { this.manualPageId = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).page } catch { /* first run */ }
        }
        if (!ids.includes(this.manualPageId)) this.manualPageId = ids.includes(cfg.startPage) ? cfg.startPage : ids[0]
        if (this.autoPageId && !ids.includes(this.autoPageId)) this.autoPageId = null
        if (initial || this.brightness === undefined) this.brightness = cfg.brightness ?? 0.8
        else this.setBrightness(cfg.brightness ?? this.brightness)
        forgetImages()
        this.preloadAndRender(true)
        if (!initial) log.info('Config applied')
    }

    async preloadAndRender(force = false) {
        const files = []
        for (const p of this.pages) for (const k of Object.values(p.keys || {})) files.push(imageRef(k, this.theme))
        await preloadImages(files)
        if (force) this.signatures.clear()
        this.requestRender()
    }

    onConnected() {
        this.signatures.clear()
        this.device.setBrightness(this.brightness)
        this.requestRender()
        this.emitStatus()
    }

    emitStatus() { this.emit('status', this.status()) }

    status() {
        return {
            device: this.device.status(),
            page: this.page?.id,
            manualPage: this.manualPageId,
            autoPage: this.autoPageId,
            foreground: this.foreground,
            toggles: this.toggles,
            brightness: this.brightness,
        }
    }

    // ---- Bindings -----------------------------------------------------------

    // Page bindings override global ones
    binding(section, id) {
        const p = this.page?.[section]?.[id]
        if (p) return p
        return this.config.global?.[section]?.[id]
    }

    wheelBinding() { return this.page?.wheel ?? this.config.global?.wheel }

    keyDef(i) { return this.page?.keys?.[i] }

    // ---- Paging -------------------------------------------------------------

    goToPage(target) {
        const ids = this.pages.map(p => p.id)
        let idx = ids.indexOf(this.pageId)
        let id = target
        if (target === 'next') id = ids[(idx + 1) % ids.length]
        else if (target === 'prev') id = ids[(idx - 1 + ids.length) % ids.length]
        else if (target === 'back') id = this.previousPageId ?? ids[0]
        if (!ids.includes(id)) { log.warn(`goToPage: unknown page "${target}"`); return }
        if (id === this.pageId) return
        this.previousPageId = this.pageId
        // A manual change while an app rule is active sticks until the app changes
        if (this.autoPageId) this.overrideApp = this.currentRule ?? 'none'
        this.autoPageId = null
        this.manualPageId = id
        this.onPageChanged()
    }

    onPageChanged() {
        this.pressed.clear()
        try { fs.writeFileSync(STATE_FILE, JSON.stringify({ page: this.manualPageId })) } catch { /* not critical */ }
        this.requestRender()
        this.emit('page', this.page.id)
        this.emitStatus()
    }

    pollForegroundApp() {
        const rules = this.config.appRules || []
        if (this.config.autoSwitch === false || !rules.length) {
            if (this.autoPageId) { this.autoPageId = null; this.onPageChanged() }
            return
        }
        let fg
        try { fg = getForegroundApp() } catch { return }
        if (!fg) return
        const changed = fg.exe !== this.foreground?.exe || fg.title !== this.foreground?.title
        this.foreground = fg
        if (!changed) return
        const rule = matchRule(rules, fg)
        // A manual page pick sticks until a different rule (or none) matches,
        // so switching browser tabs away from e.g. Figma ends the override.
        if (this.overrideApp !== null && this.overrideApp !== (rule ?? 'none')) this.overrideApp = null
        if (this.overrideApp !== null) return
        this.currentRule = rule ?? 'none'
        const next = rule ? rule.page : null
        if (next !== this.autoPageId) {
            const before = this.pageId
            this.autoPageId = next
            if (this.pageId !== before) {
                log.info(`App "${fg.exe}" -> page "${this.pageId}"`)
                this.onPageChanged()
            }
        }
    }

    setBrightness(v) {
        this.brightness = Math.max(0.1, Math.min(1, v))
        this.device.setBrightness(this.brightness)
        this.emitStatus()
    }

    refreshAudio() {
        this.widgets.refreshAudio()
        this.requestRender()
    }

    refreshLight() {
        this.widgets.refreshLight().then(() => this.requestRender())
    }

    tick() {
        this.widgets.tick()
        this.widgets.refreshAudio()
        // Light state can also change from Logi Tune or the light's own button
        if (this.usesWidget('light') && ++this.lightTicks % 2 === 0) this.refreshLight()
        this.requestRender()
    }

    usesWidget(type) {
        const has = d => d?.widget?.type === type
        const g = this.config.global || {}
        return this.pages.some(p => Object.values(p.keys || {}).some(has) || Object.values(p.knobs || {}).some(has) || Object.values(p.buttons || {}).some(has) || has(p.wheel))
            || Object.values(g.knobs || {}).some(has) || Object.values(g.buttons || {}).some(has) || has(g.wheel)
    }

    // ---- Input --------------------------------------------------------------

    run(action, extra = {}) {
        if (!action) return
        this.emit('action', { action, ...extra })
        return runAction(action, { controller: this, ...extra })
    }

    onInput(ev, payload) {
        this.emit('input', { ev, ...payload, changedTouches: undefined, touches: undefined, touch: payload.changedTouches?.[0] })
        try {
            switch (ev) {
                case 'down': return this.onButtonDown(String(payload.id))
                case 'up': return this.onButtonUp(String(payload.id))
                case 'rotate': return this.onRotate(String(payload.id), payload.delta)
                case 'touchstart': return this.onTouchStart(payload.changedTouches[0])
                case 'touchmove': return this.onTouchMove(payload.changedTouches[0])
                case 'touchend': return this.onTouchEnd(payload.changedTouches[0])
            }
        } catch (err) {
            log.error(`Input handler error (${ev}): ${err.stack || err.message}`)
        }
    }

    // Resolve what a physical press means: knobs use .press, wheel is "wheel", buttons use .action
    pressBinding(id) {
        if (id === 'knobCT') {
            const w = this.wheelBinding()
            return w && { ...w, action: w.press, longPress: w.longPress }
        }
        if (KNOB_IDS.includes(id)) {
            const k = this.binding('knobs', id)
            return k && { ...k, action: k.press, longPress: k.longPress }
        }
        return this.binding('buttons', id)
    }

    onButtonDown(id) {
        const b = this.pressBinding(id)
        if (!b?.action && !b?.longPress) return
        if (b.action?.type === 'hold') { this.run(b.action, { phase: 'down', source: id }); this.holds.set(id, { binding: b }); return }
        if (!b.longPress) { this.run(b.action, { source: id }); return }
        const state = { binding: b, longFired: false }
        state.timer = setTimeout(() => {
            state.longFired = true
            this.device.vibrate(HAPTIC.SHORT)
            this.run(b.longPress, { source: id, long: true })
        }, LONG_PRESS_MS)
        this.holds.set(id, state)
    }

    onButtonUp(id) {
        const state = this.holds.get(id)
        if (!state) return
        this.holds.delete(id)
        clearTimeout(state.timer)
        if (state.binding.action?.type === 'hold') return this.run(state.binding.action, { phase: 'up', source: id })
        if (!state.longFired) this.run(state.binding.action, { source: id })
    }

    async onRotate(id, delta) {
        const b = id === 'knobCT' ? this.wheelBinding() : this.binding('knobs', id)
        if (!b) return
        if (id !== 'knobCT') {
            this.highlightKnob = id
            clearTimeout(this.highlightTimer)
            this.highlightTimer = setTimeout(() => { this.highlightKnob = null; this.requestRender() }, 700)
        }
        const scaled = delta * (b.sensitivity ?? 1)
        if (b.rotate) await this.run(b.rotate, { delta: scaled, source: id })
        else {
            const a = delta > 0 ? b.right : b.left
            for (let i = 0; i < Math.abs(delta); i++) await this.run(a, { source: id })
        }
        this.requestRender()
    }

    onTouchStart(t) {
        const entry = { start: t, last: t, longFired: false }
        this.touches.set(t.id, entry)
        const { screen, key } = t.target || {}
        if (screen === 'center' && key !== undefined) {
            this.pressed.add(key)
            this.requestRender()
            const def = this.keyDef(key)
            if (def?.longPress) {
                entry.timer = setTimeout(() => {
                    entry.longFired = true
                    this.pressed.delete(key)
                    this.requestRender()
                    this.device.vibrate(HAPTIC.SHORT)
                    this.run(def.longPress, { source: `key${key}`, long: true })
                }, LONG_PRESS_MS)
            }
        }
    }

    onTouchMove(t) {
        const entry = this.touches.get(t.id)
        if (!entry) return
        entry.last = t
        if (Math.hypot(t.x - entry.start.x, t.y - entry.start.y) > TAP_SLOP) {
            clearTimeout(entry.timer)
            const key = entry.start.target?.key
            if (key !== undefined && this.pressed.delete(key)) this.requestRender()
        }
    }

    onTouchEnd(t) {
        const entry = this.touches.get(t.id)
        this.touches.delete(t.id)
        if (!entry) return
        clearTimeout(entry.timer)
        const { screen, key } = entry.start.target || {}
        if (key !== undefined && this.pressed.delete(key)) this.requestRender()
        if (entry.longFired) return

        const dx = t.x - entry.start.x, dy = t.y - entry.start.y
        const moved = Math.hypot(dx, dy)

        if (screen === 'center' && Math.abs(dx) > SWIPE_MIN && Math.abs(dy) < 90 && this.config.swipePages !== false) {
            return this.goToPage(dx < 0 ? 'next' : 'prev')
        }
        if (moved > TAP_SLOP) return

        if (screen === 'center' && key !== undefined) {
            const def = this.keyDef(key)
            if (def?.action) {
                if (this.config.haptics !== false) this.device.vibrate(HAPTIC.SHORT_LOWER)
                this.run(def.action, { source: `key${key}` })
            }
        } else if (screen === 'left' || screen === 'right') {
            // Tapping a strip section acts like pressing that knob
            const idx = Math.min(2, Math.floor(entry.start.y / 90))
            const knob = (screen === 'left' ? ['knobTL', 'knobCL', 'knobBL'] : ['knobTR', 'knobCR', 'knobBR'])[idx]
            const k = this.binding('knobs', knob)
            if (k?.press) this.run(k.press, { source: knob })
        } else if (screen === 'knob') {
            const w = this.wheelBinding()
            if (w?.touch || w?.press) this.run(w.touch || w.press, { source: 'wheelTouch' })
        }
    }

    // ---- Rendering ----------------------------------------------------------

    requestRender() {
        if (this.renderQueued) return
        this.renderQueued = true
        setImmediate(() => {
            this.renderQueued = false
            try { this.render() } catch (err) { log.error(`Render failed: ${err.stack || err.message}`) }
        })
    }

    // Only send a frame when its inputs changed since the last draw
    changed(target, data) {
        const sig = JSON.stringify(data)
        if (this.signatures.get(target) === sig) return false
        this.signatures.set(target, sig)
        return true
    }

    render() {
        if (!this.device.connected) return
        const theme = this.theme
        const page = this.page

        for (let i = 0; i < KEY_COUNT; i++) {
            const def = this.keyDef(i)
            const value = def?.widget ? this.widgets.value(def.widget) : null
            const pressed = this.pressed.has(i)
            const imgSig = imageRef(def, theme) ? 1 : 0
            if (this.changed(`key:${i}`, { def, value, pressed, theme, imgSig })) {
                this.device.drawKey(i, (ctx, w, h) => drawKey(ctx, w, h, { def, value, pressed, theme }))
            }
        }

        for (const side of ['left', 'right']) {
            const ids = side === 'left' ? ['knobTL', 'knobCL', 'knobBL'] : ['knobTR', 'knobCR', 'knobBR']
            const knobs = ids.map(id => {
                const def = this.binding('knobs', id)
                return { def, value: def?.widget ? this.widgets.value(def.widget) : null, highlight: this.highlightKnob === id }
            })
            const accent = page?.color || theme.accent
            if (this.changed(`strip:${side}`, { knobs, theme, accent })) {
                this.device.drawScreen(side, (ctx, w, h) => drawStrip(ctx, w, h, { knobs, theme, accent, side }))
            }
        }

        const wheelDef = this.wheelBinding()
        const wheelValue = wheelDef?.widget ? this.widgets.value(wheelDef.widget) : null
        const pageList = this.pages.map(p => ({ id: p.id }))
        if (this.changed('wheel', { page: { id: page.id, name: page.name, color: page.color }, wheelDef, wheelValue, theme, pageList })) {
            this.device.drawScreen('knob', (ctx, w, h) => drawWheel(ctx, w, h, { page, pages: this.pages, def: wheelDef, value: wheelValue, theme }))
        }

        this.renderLeds(theme)
    }

    renderLeds(theme) {
        const ids = ['0', '1', '2', '3', '4', '5', '6', '7', 'home', 'undo', 'keyboard', 'enter', 'save', 'fnL', 'a', 'b', 'c', 'd', 'fnR', 'e']
        for (const id of ids) {
            const b = this.binding('buttons', id)
            let color = '#000000'
            if (b) {
                if (b.action?.type === 'page' && !['next', 'prev', 'back'].includes(b.action.page)) {
                    const target = this.pages.find(p => p.id === b.action.page)
                    const c = b.color || target?.color || theme.accent
                    color = b.action.page === this.page.id ? c : dim(c, 0.12)
                } else if (b.widget) {
                    const v = this.widgets.value(b.widget)
                    color = v?.active ? (b.activeColor || theme.active) : (b.color || '#000000')
                } else {
                    color = b.color || '#000000'
                }
            }
            const key = /^\d$/.test(id) ? Number(id) : id
            if (this.changed(`led:${id}`, color)) this.device.setButtonColor(key, color)
        }
    }

    // Snapshot for the web UI preview
    snapshot() {
        const page = this.page
        return {
            page: page.id,
            keys: Array.from({ length: KEY_COUNT }, (_, i) => {
                const def = this.keyDef(i)
                return def?.widget ? this.widgets.value(def.widget) : null
            }),
            knobs: Object.fromEntries(KNOB_IDS.map(id => {
                const def = this.binding('knobs', id)
                return [id, def?.widget ? this.widgets.value(def.widget) : null]
            })),
        }
    }
}
