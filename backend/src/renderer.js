// Pure drawing functions for the CT's screens. Everything is drawn with the
// Canvas API; device.js turns it into RGB565 frames.
//   keys:   12 x 90x90 on the center screen
//   strips: left/right 60x270, one third per knob
//   wheel:  240x240 round display in the jog wheel
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadImage } from 'canvas'
import { ICONS_DIR } from './paths.js'
import { log } from './log.js'

const FONT = '"Segoe UI", Arial, sans-serif'
const ICON_FONT = '"Segoe UI Emoji", "Segoe UI Symbol", sans-serif'

const images = new Map() // file or phosphor ref -> Image | null (failed)
const require = createRequire(import.meta.url)

// Phosphor icons (phosphoricons.com) are tinted to the key's text color, so the ref includes it
export function imageRef(def, theme) {
    if (def?.image) return def.image
    if (!def?.phosphor) return null
    return `phosphor:${def.phosphorWeight || 'fill'}:${def.phosphor}:${def.textColor || theme.text}`
}

async function readImage(ref) {
    if (!ref.startsWith('phosphor:')) return loadImage(fs.readFileSync(path.isAbsolute(ref) ? ref : path.join(ICONS_DIR, ref)))
    const [, weight, name, color] = ref.split(':')
    if (!/^[a-z0-9-]+$/.test(name) || !/^[a-z]+$/.test(weight)) throw new Error('bad Phosphor icon name')
    const file = require.resolve(`@phosphor-icons/core/${weight}/${weight === 'regular' ? name : `${name}-${weight}`}.svg`)
    const svg = fs.readFileSync(file, 'utf8').replace('fill="currentColor"', `fill="${color}" width="256" height="256"`)
    return loadImage(Buffer.from(svg))
}

export async function preloadImages(refs) {
    await Promise.all([...new Set(refs)].filter(f => f && !images.has(f)).map(async f => {
        try {
            images.set(f, await readImage(f))
        } catch (err) {
            log.warn(`Icon "${f}" failed to load: ${err.message}`)
            images.set(f, null)
        }
    }))
}

export function forgetImages() { images.clear() }

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
}

// Shrink font until text fits the width
function fitText(ctx, text, maxWidth, size, weight = '600', min = 9) {
    let s = size
    do {
        ctx.font = `${weight} ${s}px ${FONT}`
        if (ctx.measureText(text).width <= maxWidth) break
        s -= 1
    } while (s > min)
    return s
}

function wrapLabel(ctx, text, maxWidth, size) {
    ctx.font = `600 ${size}px ${FONT}`
    if (ctx.measureText(text).width <= maxWidth || !text.includes(' ')) return [text]
    const words = text.split(' ')
    let best = [text]
    for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ')
        if (ctx.measureText(a).width <= maxWidth && ctx.measureText(b).width <= maxWidth) return [a, b]
        best = [a, b]
    }
    return best
}

export function drawKey(ctx, w, h, { def, value, pressed, theme }) {
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, w, h)
    if (!def) return

    const active = value?.active
    let bg = def.color || theme.key
    if (active) bg = def.activeColor || theme.active
    const fg = def.textColor || theme.text

    const inset = pressed ? 7 : 4
    roundRect(ctx, inset, inset, w - inset * 2, h - inset * 2, 12)
    ctx.fillStyle = bg
    ctx.fill()
    if (pressed) {
        ctx.fillStyle = 'rgba(255,255,255,0.25)'
        ctx.fill()
    }

    ctx.fillStyle = fg
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const cx = w / 2
    const ref = imageRef(def, theme)
    const img = ref ? images.get(ref) : null
    const hasLabel = !!def.label

    if (value && value.text !== undefined && !def.icon && !img) {
        // Widget layout: big value, small sub-label, optional level bar
        const hasBar = typeof value.level === 'number'
        const sub = def.label ?? value.sub
        const size = fitText(ctx, String(value.text), w - 16, 26, '700')
        ctx.fillText(String(value.text), cx, sub ? h / 2 - 6 : h / 2)
        if (sub) {
            fitText(ctx, String(sub), w - 16, 13, '500')
            ctx.globalAlpha = 0.8
            ctx.fillText(String(sub), cx, h / 2 + size / 2 + 6)
            ctx.globalAlpha = 1
        }
        if (hasBar) {
            const bw = w - 24, by = h - 16
            ctx.fillStyle = 'rgba(255,255,255,0.18)'
            roundRect(ctx, 12, by, bw, 5, 2.5); ctx.fill()
            ctx.fillStyle = fg
            roundRect(ctx, 12, by, Math.max(5, bw * Math.min(1, value.level)), 5, 2.5); ctx.fill()
        }
        return
    }

    // Icon + label layout, plus a level bar for widgets that report one (dimmers)
    const hasBar = typeof value?.level === 'number'
    const iconY = hasLabel ? h / 2 - (hasBar ? 15 : 11) : h / 2
    const iconSize = hasLabel ? (hasBar ? 32 : 36) : 46
    if (img) {
        const s = def.imageScale ?? iconSize
        const ratio = Math.min(s / img.width, s / img.height)
        const iw = img.width * ratio, ih = img.height * ratio
        ctx.drawImage(img, cx - iw / 2, iconY - ih / 2, iw, ih)
    } else if (def.icon) {
        ctx.font = `${iconSize}px ${ICON_FONT}`
        ctx.fillText(def.icon, cx, iconY + 2)
    }
    if (hasLabel) {
        // hideValue: the icon + background color already show the state, so skip "ON"/"OFF"
        const label = value?.text !== undefined && !def.hideValue ? `${def.label} ${value.text}` : def.label
        if (!img && !def.icon) {
            const lines = wrapLabel(ctx, label, w - 14, 16)
            lines.forEach((line, i) => {
                fitText(ctx, line, w - 14, 16)
                ctx.fillText(line, cx, h / 2 + (i - (lines.length - 1) / 2) * 19)
            })
        } else {
            fitText(ctx, label, w - 12, 13)
            ctx.fillText(label, cx, h - (hasBar ? 32 : 24))
        }
    }
    if (hasBar && (img || def.icon)) {
        const bw = w - 24, by = h - 21
        ctx.fillStyle = 'rgba(255,255,255,0.18)'
        roundRect(ctx, 12, by, bw, 5, 2.5); ctx.fill()
        ctx.fillStyle = fg
        roundRect(ctx, 12, by, Math.max(5, bw * Math.min(1, value.level)), 5, 2.5); ctx.fill()
    }
}

// One strip shows three knobs stacked (top / center / bottom)
export function drawStrip(ctx, w, h, { knobs, theme, accent, side }) {
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, w, h)
    const sh = h / 3
    knobs.forEach(({ def, value, highlight }, i) => {
        const y = i * sh
        if (i > 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.08)'
            ctx.fillRect(6, y, w - 12, 1)
        }
        if (!def) return
        if (highlight) {
            ctx.fillStyle = 'rgba(255,255,255,0.12)'
            ctx.fillRect(0, y + 1, w, sh - 2)
        }
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const activeColor = def.activeColor || theme.active
        const color = value?.active ? activeColor : (def.color || accent)
        // Level arc-ish bar along the outer edge
        if (typeof value?.level === 'number') {
            const bx = side === 'left' ? 3 : w - 7
            ctx.fillStyle = 'rgba(255,255,255,0.12)'
            ctx.fillRect(bx, y + 12, 4, sh - 24)
            const fh = (sh - 24) * Math.min(1, value.level)
            ctx.fillStyle = color
            ctx.fillRect(bx, y + 12 + (sh - 24 - fh), 4, fh)
        }
        ctx.fillStyle = theme.text
        const cx = side === 'left' ? w / 2 + 3 : w / 2 - 3
        if (def.icon) {
            ctx.font = `22px ${ICON_FONT}`
            ctx.fillText(def.icon, cx, y + sh / 2 - 18)
        }
        const label = def.label || ''
        fitText(ctx, label, w - 14, 12, '600', 8)
        ctx.globalAlpha = 0.85
        ctx.fillText(label, cx, y + sh / 2 + (def.icon ? 6 : -8))
        ctx.globalAlpha = 1
        if (value?.text !== undefined) {
            fitText(ctx, String(value.text), w - 14, 16, '700', 9)
            ctx.fillStyle = value.active ? activeColor : theme.text
            ctx.fillText(String(value.text), cx, y + sh / 2 + (def.icon ? 26 : 12))
        }
    })
}

export function drawWheel(ctx, w, h, { page, pages, def, value, theme, flash }) {
    ctx.fillStyle = theme.background
    ctx.fillRect(0, 0, w, h)
    const cx = w / 2, cy = h / 2
    const accent = page?.color || theme.accent

    // Page dots around the bottom
    const n = pages.length
    const idx = pages.findIndex(p => p.id === page?.id)
    const spread = Math.min(Math.PI * 0.6, n * 0.16)
    pages.forEach((p, i) => {
        // Bottom arc, first page on the left
        const a = Math.PI / 2 - (n > 1 ? (i / (n - 1) - 0.5) * spread : 0)
        ctx.beginPath()
        ctx.arc(cx + Math.cos(a) * 100, cy + Math.sin(a) * 100, i === idx ? 6 : 4, 0, Math.PI * 2)
        ctx.fillStyle = i === idx ? accent : 'rgba(255,255,255,0.25)'
        ctx.fill()
    })

    // Ring
    ctx.beginPath()
    ctx.arc(cx, cy, 112, 0, Math.PI * 2)
    ctx.strokeStyle = accent
    ctx.lineWidth = 4
    ctx.stroke()

    if (typeof value?.level === 'number') {
        ctx.beginPath()
        ctx.arc(cx, cy, 104, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, value.level))
        ctx.strokeStyle = theme.text
        ctx.lineWidth = 6
        ctx.stroke()
    }

    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = theme.text
    const title = flash || page?.name || ''
    fitText(ctx, title, 170, 30, '700')
    ctx.fillText(title, cx, cy - 26)

    if (def?.label) {
        ctx.globalAlpha = 0.7
        fitText(ctx, def.label, 160, 16, '500')
        ctx.fillText(def.label, cx, cy + 10)
        ctx.globalAlpha = 1
    }
    if (value?.text !== undefined) {
        fitText(ctx, String(value.text), 150, 26, '700')
        ctx.fillStyle = value.active ? theme.active : accent
        ctx.fillText(String(value.text), cx, cy + 42)
    }
}
