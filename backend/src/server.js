// Local web UI + JSON API + live websocket. Bound to 127.0.0.1 only.
// Because bindings can run shell commands, every request is checked against
// Host/Origin so other websites (or DNS rebinding) can't drive this API.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { createCanvas } from 'canvas'
import { FRONTEND_DIR, ICONS_DIR } from './paths.js'
import { log } from './log.js'
import { runAction, ACTION_TYPES } from './actions.js'
import { KEY_NAMES } from './win32.js'
import { KNOB_IDS, ROUND_BUTTONS, SQUARE_BUTTONS } from './config.js'
import { drawKey, drawStrip, drawWheel, preloadImages, imageRef } from './renderer.js'
import { lutron } from './lutron.js'
import { ha } from './ha.js'
import { discoverBridges, pairBridge } from './lutron-pair.js'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp', '.gif': 'image/gif' }
const WIDGET_TYPES = ['clock', 'date', 'cpu', 'memory', 'volume', 'mute', 'light', 'lutron', 'ha', 'toggle', 'page', 'command', 'http']

export function startServer({ port, controller, store }) {
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
    const allowedOrigins = new Set([...allowedHosts].map(h => `http://${h}`))

    const isTrusted = req => {
        if (!allowedHosts.has(req.headers.host)) return false
        const origin = req.headers.origin
        return !origin || allowedOrigins.has(origin)
    }

    const send = (res, code, body, type = 'application/json') => {
        res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
        res.end(type === 'application/json' ? JSON.stringify(body) : body)
    }

    const readBody = (req, limit = 5 * 1024 * 1024) => new Promise((resolve, reject) => {
        const chunks = []
        let size = 0
        req.on('data', c => {
            size += c.length
            if (size > limit) { reject(new Error('Body too large')); req.destroy() }
            else chunks.push(c)
        })
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', reject)
    })
    const readJson = async req => {
        if (!String(req.headers['content-type']).startsWith('application/json')) throw new Error('Content-Type must be application/json')
        return JSON.parse((await readBody(req)).toString('utf8') || '{}')
    }

    const serveFile = (res, base, rel) => {
        const file = path.resolve(base, '.' + path.sep + rel)
        if (!file.startsWith(path.resolve(base))) return send(res, 403, { error: 'forbidden' })
        fs.readFile(file, (err, data) => {
            if (err) return send(res, 404, { error: 'not found' })
            send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
        })
    }

    // Render what a given page looks like on the device, as PNG
    const renderPreview = async (kind, pageId, idx) => {
        const page = store.config.pages.find(p => p.id === pageId) ?? controller.page
        const theme = controller.theme
        const pick = (section, id) => page?.[section]?.[id] ?? store.config.global?.[section]?.[id]
        const val = def => (def?.widget ? controller.widgets.value(def.widget) : null)
        let canvas
        if (kind === 'key') {
            const def = page?.keys?.[idx]
            await preloadImages([imageRef(def, theme)])
            canvas = createCanvas(90, 90)
            drawKey(canvas.getContext('2d'), 90, 90, { def, value: val(def), pressed: false, theme })
        } else if (kind === 'strip') {
            const ids = idx === 'left' ? ['knobTL', 'knobCL', 'knobBL'] : ['knobTR', 'knobCR', 'knobBR']
            const knobs = ids.map(id => { const def = pick('knobs', id); return { def, value: val(def) } })
            canvas = createCanvas(60, 270)
            drawStrip(canvas.getContext('2d'), 60, 270, { knobs, theme, accent: page?.color || theme.accent, side: idx })
        } else {
            const def = page?.wheel ?? store.config.global?.wheel
            canvas = createCanvas(240, 240)
            drawWheel(canvas.getContext('2d'), 240, 240, { page, pages: store.config.pages, def, value: val(def), theme })
        }
        return canvas.toBuffer('image/png')
    }

    const server = http.createServer(async (req, res) => {
        if (!isTrusted(req)) return send(res, 403, { error: 'Forbidden: untrusted host/origin' })
        const url = new URL(req.url, `http://${req.headers.host}`)
        const p = url.pathname
        try {
            if (req.method === 'GET' && p === '/api/config') return send(res, 200, store.config)
            if (req.method === 'PUT' && p === '/api/config') {
                try {
                    store.save(await readJson(req))
                    return send(res, 200, { ok: true })
                } catch (err) {
                    return send(res, 400, { error: err.message, validation: err.validation })
                }
            }
            if (req.method === 'GET' && p === '/api/status') return send(res, 200, controller.status())
            if (req.method === 'GET' && p === '/api/lutron') return send(res, 200, lutron.list())
            if (req.method === 'POST' && p === '/api/lutron/discover') return send(res, 200, { bridges: await discoverBridges() })
            if (req.method === 'POST' && p === '/api/lutron/pair') {
                const { host } = await readJson(req)
                if (!/^[\w.-]+$/.test(host || '')) return send(res, 400, { error: 'Enter the bridge IP address' })
                if (lutron.pairing?.active) return send(res, 409, { error: 'Pairing already in progress' })
                lutron.pairing = { active: true, message: 'Connecting to bridge…' }
                lutron.emit('change')
                pairBridge(host, message => { lutron.pairing = { active: true, message }; lutron.emit('change') })
                    .then(() => { lutron.pairing = { active: false, ok: true, message: 'Paired!' }; lutron.restart() })
                    .catch(err => { lutron.pairing = { active: false, ok: false, message: err.message }; lutron.emit('change') })
                return send(res, 202, { ok: true })
            }
            if (req.method === 'POST' && p === '/api/lutron/unpair') {
                lutron.unpair()
                return send(res, 200, { ok: true })
            }
            if (req.method === 'GET' && p === '/api/ha') return send(res, 200, ha.list())
            if (req.method === 'POST' && p === '/api/ha/settings') {
                try { ha.saveSettings(await readJson(req)) } catch (err) { return send(res, 400, { error: err.message }) }
                return send(res, 200, { ok: true })
            }
            if (req.method === 'POST' && p === '/api/ha/forget') { ha.forget(); return send(res, 200, { ok: true }) }
            if (req.method === 'GET' && p === '/api/snapshot') return send(res, 200, controller.snapshot())
            if (req.method === 'GET' && p === '/api/meta') {
                return send(res, 200, {
                    actionTypes: ACTION_TYPES, keyNames: KEY_NAMES, widgetTypes: WIDGET_TYPES,
                    knobs: KNOB_IDS, roundButtons: ROUND_BUTTONS, squareButtons: SQUARE_BUTTONS,
                })
            }
            if (req.method === 'POST' && p === '/api/test-action') {
                const { action } = await readJson(req)
                return send(res, 200, await runAction(action, { controller }))
            }
            if (req.method === 'POST' && p === '/api/page') {
                const { page } = await readJson(req)
                controller.goToPage(page)
                return send(res, 200, { ok: true, page: controller.page.id })
            }
            if (req.method === 'POST' && p === '/api/reconnect') {
                controller.device.onLost('manual reconnect requested')
                return send(res, 200, { ok: true })
            }
            if (req.method === 'POST' && p === '/api/shutdown') {
                send(res, 200, { ok: true })
                setTimeout(() => controller.emit('shutdown'), 100)
                return
            }
            if (req.method === 'GET' && p === '/api/logs') {
                const text = fs.existsSync(log.file) ? fs.readFileSync(log.file, 'utf8') : ''
                return send(res, 200, { lines: text.trim().split('\n').slice(-300) })
            }
            if (req.method === 'GET' && p === '/api/icons') {
                const files = fs.readdirSync(ICONS_DIR).filter(f => MIME[path.extname(f).toLowerCase()]?.startsWith('image/'))
                return send(res, 200, { icons: files })
            }
            if (req.method === 'POST' && p === '/api/icons') {
                const name = path.basename(url.searchParams.get('name') || '').replace(/[^\w.\- ]/g, '_')
                if (!name || !/\.(png|jpe?g|svg|webp|gif)$/i.test(name)) return send(res, 400, { error: 'Name must end in .png/.jpg/.svg/.webp/.gif' })
                if (!String(req.headers['content-type']).startsWith('application/octet-stream')) return send(res, 400, { error: 'Upload as application/octet-stream' })
                fs.writeFileSync(path.join(ICONS_DIR, name), await readBody(req))
                controller.preloadAndRender(true)
                return send(res, 200, { ok: true, name })
            }
            const preview = /^\/api\/preview\/(key|strip|wheel)\/([^/]+)(?:\/([^/]+))?\.png$/.exec(p)
            if (req.method === 'GET' && preview) {
                const [, kind, pageId, idx] = preview
                return send(res, 200, await renderPreview(kind, decodeURIComponent(pageId), idx), 'image/png')
            }
            if (req.method === 'GET' && p.startsWith('/icons/')) return serveFile(res, ICONS_DIR, decodeURIComponent(p.slice(7)))
            if (req.method === 'GET') return serveFile(res, FRONTEND_DIR, p === '/' ? 'index.html' : decodeURIComponent(p.slice(1)))
            send(res, 404, { error: 'not found' })
        } catch (err) {
            log.error(`HTTP ${req.method} ${p} failed: ${err.message}`)
            if (!res.headersSent) send(res, 500, { error: err.message })
        }
    })

    // Live events to the UI
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => {
        if (!isTrusted(req) || req.url !== '/ws') return socket.destroy()
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws))
    })
    const broadcast = msg => {
        let data
        try { data = JSON.stringify(msg) } catch (err) {
            // Never let a UI update take the daemon down
            log.error(`Could not send ${msg?.type} update to the UI: ${err.message}`)
            return
        }
        for (const c of wss.clients) if (c.readyState === 1) c.send(data)
    }
    wss.on('connection', ws => ws.send(JSON.stringify({ type: 'status', data: controller.status() })))
    controller.on('status', data => broadcast({ type: 'status', data }))
    controller.on('input', data => broadcast({ type: 'input', data }))
    controller.on('action', data => broadcast({ type: 'action', data }))
    controller.on('page', data => broadcast({ type: 'page', data }))
    store.on('change', () => broadcast({ type: 'config' }))
    let lutronTimer
    lutron.on('change', () => {
        clearTimeout(lutronTimer)
        lutronTimer = setTimeout(() => broadcast({ type: 'lutron', data: lutron.list() }), 200)
    })
    let haTimer
    ha.on('change', () => {
        clearTimeout(haTimer)
        haTimer = setTimeout(() => broadcast({ type: 'ha', data: ha.list() }), 200)
    })
    log.subscribe(entry => broadcast({ type: 'log', data: entry }))

    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
            log.info(`Config UI at http://127.0.0.1:${port}`)
            resolve(server)
        })
    })
}
