// Logitech Litra (Glow / Beam) control via the `litra` package (USB HID).
// The device handle is cached and re-discovered on any error, so unplugging
// the light or Logi Tune grabbing it briefly just costs one retry.
//
// Knob turns: the light applies a change slightly after we send it, so reading
// it back during a fast spin returns stale values and steps would bounce. We
// keep the state we last commanded and treat it as the truth for HOLD_MS; each
// action computes absolute target values first, then writes them (idempotent,
// so a retry after a USB hiccup can't apply a step twice).
import * as litra from 'litra'
import { log } from './log.js'

const RESCAN_MS = 30_000 // when no light is plugged in, don't enumerate USB HID every poll
const HOLD_MS = 1500

// The library's getters use a blocking readSync() and take whatever report comes
// next, which can be an unsolicited notification (wrong values) or never come
// (daemon hangs). This drains stale reports, then waits with a timeout for the
// reply whose feature/function bytes match the request.
function query(d, fn) {
    const feature = d.type === 'litra_beam_lx' ? 0x06 : 0x04
    const hid = d.hid
    while (hid.readTimeout(0).length) { /* drain */ }
    const req = new Array(20).fill(0)
    req.splice(0, 4, 0x11, 0xff, feature, fn)
    hid.write(req)
    for (let i = 0; i < 6; i++) {
        const data = hid.readTimeout(150)
        if (data.length >= 6 && data[2] === feature && data[3] === fn) return data
    }
    throw new Error(`Litra did not answer query 0x${fn.toString(16)}`)
}

const litraDriver = {
    find: () => litra.findDevice(),
    close: d => d?.hid?.close?.(),
    info: d => ({
        name: litra.getNameForDevice(d),
        minLumen: litra.getMinimumBrightnessInLumenForDevice(d),
        maxLumen: litra.getMaximumBrightnessInLumenForDevice(d),
        minKelvin: litra.getMinimumTemperatureInKelvinForDevice(d),
        maxKelvin: litra.getMaximumTemperatureInKelvinForDevice(d),
    }),
    readOn: d => query(d, 0x01)[4] === 1,
    readLumen: d => { const r = query(d, 0x31); return (r[4] << 8) | r[5] },
    readKelvin: d => { const r = query(d, 0x81); return (r[4] << 8) | r[5] },
    setOn: (d, on) => (on ? litra.turnOn(d) : litra.turnOff(d)),
    setLumen: (d, lumen) => litra.setBrightnessInLumen(d, lumen),
    setKelvin: (d, k) => litra.setTemperatureInKelvin(d, k),
}

let driver = litraDriver
let device = null
let missingUntil = 0
let commanded = null   // { on, lumen, kelvin } we last sent
let holdUntil = 0

// Tests swap in a fake driver
export function _setDriver(d) { driver = d ?? litraDriver; device = null; missingUntil = 0; commanded = null; holdUntil = 0 }

function getDevice() {
    if (!device) {
        if (Date.now() < missingUntil) throw new Error('No Logitech Litra light found')
        device = driver.find()
        if (!device) {
            missingUntil = Date.now() + RESCAN_MS
            throw new Error('No Logitech Litra light found')
        }
    }
    return device
}

async function withDevice(fn) {
    try {
        return await fn(getDevice())
    } catch (err) {
        // Stale handle (unplugged / re-enumerated): retry once with a fresh one
        try { driver.close(device) } catch { /* ignore */ }
        device = null
        return fn(getDevice())
    }
}

const holding = () => commanded && Date.now() < holdUntil

// Current state: what we commanded while settling, otherwise read from the light
// `level` (0-1) is kept unrounded while commanding so repeated steps don't drift
async function currentState(info) {
    if (holding()) return { ...commanded }
    const s = await withDevice(async d => ({ on: driver.readOn(d), lumen: driver.readLumen(d), kelvin: driver.readKelvin(d) }))
    s.level = (s.lumen - info.minLumen) / (info.maxLumen - info.minLumen)
    return s
}

export async function getLightState() {
    const info = await withDevice(async d => driver.info(d))
    const s = await currentState(info)
    return {
        name: info.name,
        on: s.on,
        lumen: s.lumen,
        level: Math.max(0, Math.min(1, s.level)),
        kelvin: s.kelvin,
        minKelvin: info.minKelvin,
        maxKelvin: info.maxKelvin,
    }
}

// op: toggle | on | off | brightness | temperature
// brightness: set (0-1) or step (fraction, scaled by knob delta)
// temperature: set (kelvin) or step (kelvin, scaled by knob delta)
// Actions run one at a time so concurrent knob detents each build on the last
let queue = Promise.resolve()
export function lightAction(action, delta = 1) {
    const run = queue.then(() => applyAction(action, delta))
    queue = run.catch(() => {})
    return run
}

async function applyAction({ op = 'toggle', set, step }, delta) {
    const info = await withDevice(async d => driver.info(d))
    const cur = await currentState(info)
    const next = { ...cur }

    if (op === 'on') next.on = true
    else if (op === 'off') next.on = false
    else if (op === 'toggle') next.on = !cur.on
    else if (op === 'brightness') {
        const range = info.maxLumen - info.minLumen
        let level = set ?? cur.level + (step ?? 0.05) * delta
        level = Math.max(0, Math.min(1, level))
        next.level = level
        next.lumen = Math.round(info.minLumen + level * range)
        next.on = true // adjusting brightness on a dark light should light it up
    } else if (op === 'temperature') {
        const k = set ?? cur.kelvin + (step ?? 100) * delta
        next.kelvin = Math.max(info.minKelvin, Math.min(info.maxKelvin, Math.round(k / 100) * 100)) // multiples of 100 only
    } else {
        throw new Error(`Unknown light op "${op}"`)
    }

    commanded = next
    holdUntil = Date.now() + HOLD_MS
    await withDevice(async d => {
        if (next.on !== cur.on) driver.setOn(d, next.on)
        if (next.lumen !== cur.lumen) driver.setLumen(d, next.lumen)
        if (next.kelvin !== cur.kelvin) driver.setKelvin(d, next.kelvin)
    })
}

export function lightAvailable() {
    try { return !!getDevice() } catch (err) { log.debug(err.message); return false }
}
