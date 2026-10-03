// Renders README images of the device from the DEFAULT config with sample data
// (no personal config, no live device needed).
//   cd backend && node ../development/render-screenshots.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const { createCanvas } = createRequire(path.join(root, 'backend/package.json'))('canvas')
process.env.LD_DATA_DIR = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'ldshots-'))
const { drawKey, drawStrip, drawWheel } = await import('../backend/src/renderer.js')

const cfg = JSON.parse(fs.readFileSync(path.join(root, 'backend/config/default-config.json'), 'utf8'))
const theme = { background: '#000000', key: '#1f2937', text: '#f8fafc', accent: '#38bdf8', active: '#dc2626', ...cfg.theme }
const OUT = path.join(root, 'docs/images')
fs.mkdirSync(OUT, { recursive: true })

// Demo Lutron page (generic names) to show the integration without real data
const demoZones = [
    ['Living Room', 72], ['Kitchen', 100], ['Dining', 0], ['Hallway', 35], ['Office', 100], ['Bedroom', 0],
    ['Porch', 100, 'Switched'], ['Patio', 0, 'Switched'], ['Office Fan', 0, 'Switched'], ['Nook', 55], ['Den', 0],
]
const lutronValue = ([name, level, type]) => {
    const on = level > 0
    if (type === 'Switched') return { text: on ? 'ON' : 'OFF', active: on }
    return { text: on ? `${level}%` : 'OFF', level: on ? level / 100 : undefined, active: on }
}
cfg.pages.push({
    id: 'lights', name: 'Lights', color: '#eab308',
    keys: Object.fromEntries([
        ...demoZones.map((z, i) => [i, { label: z[0], widget: { type: 'demo', value: lutronValue(z) }, color: '#1e293b', activeColor: '#b45309' }]),
        [11, { label: 'All off', icon: '🌙', color: '#334155' }],
    ]),
    knobs: Object.fromEntries(['knobTL', 'knobCL', 'knobBL', 'knobTR', 'knobCR', 'knobBR'].map((k, i) => {
        const z = demoZones[[0, 1, 3, 4, 9, 10][i]]
        return [k, { label: z[0].split(' ')[0], icon: '💡', activeColor: '#f59e0b', widget: { type: 'demo', value: lutronValue(z) } }]
    })),
})

const sample = {
    clock: { text: '9:41', sub: 'AM' }, cpu: { text: '23%', level: 0.23, sub: 'CPU' }, memory: { text: '48%', level: 0.48, sub: '32 GB RAM' },
    mute: { text: 'LIVE', active: false }, light: { text: '60%', sub: '4500K', level: 0.6, active: true },
    volume: { text: '35%', level: 0.35, active: false },
}
const valueOf = w => (!w ? null : w.type === 'demo' ? w.value : sample[w.type] ?? { text: '…' })

function renderDevice(page, file) {
    const pick = (section, id) => page[section]?.[id] ?? cfg.global?.[section]?.[id]
    const W = 900, H = 640
    const c = createCanvas(W, H)
    const x = c.getContext('2d')
    // Body
    x.fillStyle = '#0f172a'; x.fillRect(0, 0, W, H)
    const body = (bx, by, bw, bh, r) => { x.beginPath(); x.roundRect(bx, by, bw, bh, r); x.fill() }
    x.fillStyle = '#1e293b'; body(20, 20, W - 40, H - 40, 28)
    x.fillStyle = '#111827'; body(26, 26, W - 52, H - 52, 24)

    // Screens
    const sx = 140, sy = 50
    const strip = side => {
        const ids = side === 'left' ? ['knobTL', 'knobCL', 'knobBL'] : ['knobTR', 'knobCR', 'knobBR']
        const sc = createCanvas(60, 270)
        drawStrip(sc.getContext('2d'), 60, 270, { knobs: ids.map(id => { const def = pick('knobs', id); return { def, value: valueOf(def?.widget) } }), theme, accent: page.color, side })
        return sc
    }
    x.drawImage(strip('left'), sx, sy)
    for (let i = 0; i < 12; i++) {
        const kc = createCanvas(90, 90)
        const def = page.keys?.[i]
        drawKey(kc.getContext('2d'), 90, 90, { def, value: valueOf(def?.widget), pressed: false, theme })
        x.drawImage(kc, sx + 60 + (i % 4) * 90, sy + Math.floor(i / 4) * 90)
    }
    x.drawImage(strip('right'), sx + 420, sy)

    // Knobs
    const knob = (kx, ky) => {
        const g = x.createRadialGradient(kx - 8, ky - 8, 4, kx, ky, 30)
        g.addColorStop(0, '#64748b'); g.addColorStop(1, '#1e293b')
        x.fillStyle = g; x.beginPath(); x.arc(kx, ky, 28, 0, Math.PI * 2); x.fill()
    }
    for (let i = 0; i < 3; i++) { knob(85, sy + 45 + i * 90); knob(W - 85, sy + 45 + i * 90) }

    // Round buttons with LED colors
    for (let i = 0; i < 8; i++) {
        const b = pick('buttons', String(i))
        let col = '#1f2937'
        if (b?.action?.type === 'page') {
            const tp = cfg.pages.find(p => p.id === b.action.page)
            col = tp?.id === page.id ? tp.color : '#334155'
        } else if (b?.widget) col = valueOf(b.widget)?.active ? (b.activeColor || theme.active) : (b.color || '#1f2937')
        else if (b?.color) col = b.color
        const bx = sx + 30 + i * 60, by = sy + 300
        x.fillStyle = '#0b0f19'; x.beginPath(); x.arc(bx, by, 17, 0, Math.PI * 2); x.fill()
        x.fillStyle = col; x.beginPath(); x.arc(bx, by, 12, 0, Math.PI * 2); x.fill()
    }

    // Wheel
    const wc = createCanvas(240, 240)
    const wdef = page.wheel ?? cfg.global?.wheel
    drawWheel(wc.getContext('2d'), 240, 240, { page, pages: cfg.pages, def: wdef, value: valueOf(wdef?.widget), theme })
    const wx = W / 2, wy = 500
    x.fillStyle = '#334155'; x.beginPath(); x.arc(wx, wy, 140, 0, Math.PI * 2); x.fill()
    x.save(); x.beginPath(); x.arc(wx, wy, 104, 0, Math.PI * 2); x.clip()
    x.drawImage(wc, wx - 120, wy - 120); x.restore()

    // Square buttons
    for (const [ox, sign] of [[120, 1], [W - 120, -1]]) {
        for (let r = 0; r < 3; r++) for (let col = 0; col < 2; col++) {
            x.fillStyle = '#1f2937'; body(ox + sign * col * 64 - (sign < 0 ? 52 : 0), 400 + r * 58, 52, 44, 8)
        }
    }

    fs.writeFileSync(path.join(OUT, file), c.toBuffer('image/png'))
    console.log('wrote', file)
}

for (const id of ['home', 'media', 'figma', 'onshape', 'terminal', 'lights']) {
    const page = cfg.pages.find(p => p.id === id)
    if (page) renderDevice(page, `device-${id}.png`)
}
