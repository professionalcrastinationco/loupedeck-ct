// Logitech Litra (Glow / Beam) control via the `litra` package (USB HID).
// The device handle is cached and re-discovered on any error, so unplugging
// the light or Logi Tune grabbing it briefly just costs one retry.
import * as litra from 'litra'
import { log } from './log.js'

let device = null
let missingUntil = 0
const RESCAN_MS = 30_000 // when no light is plugged in, don't enumerate USB HID every poll

function getDevice() {
    if (!device) {
        if (Date.now() < missingUntil) throw new Error('No Logitech Litra light found')
        device = litra.findDevice()
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
        try { device?.hid?.close?.() } catch { /* ignore */ }
        device = null
        return fn(getDevice())
    }
}

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
const readOn = d => query(d, 0x01)[4] === 1
const readLumen = d => { const r = query(d, 0x31); return (r[4] << 8) | r[5] }
const readKelvin = d => { const r = query(d, 0x81); return (r[4] << 8) | r[5] }

export async function getLightState() {
    return withDevice(async d => {
        const min = litra.getMinimumBrightnessInLumenForDevice(d)
        const max = litra.getMaximumBrightnessInLumenForDevice(d)
        const lumen = readLumen(d)
        return {
            name: litra.getNameForDevice(d),
            on: readOn(d),
            lumen,
            level: Math.max(0, Math.min(1, (lumen - min) / (max - min))),
            kelvin: readKelvin(d),
            minKelvin: litra.getMinimumTemperatureInKelvinForDevice(d),
            maxKelvin: litra.getMaximumTemperatureInKelvinForDevice(d),
        }
    })
}

// op: toggle | on | off | brightness | temperature
// brightness: set (0-1) or step (fraction, scaled by knob delta)
// temperature: set (kelvin) or step (kelvin, scaled by knob delta)
export async function lightAction({ op = 'toggle', set, step }, delta = 1) {
    return withDevice(async d => {
        if (op === 'on') return litra.turnOn(d)
        if (op === 'off') return litra.turnOff(d)
        if (op === 'toggle') return readOn(d) ? litra.turnOff(d) : litra.turnOn(d)
        if (op === 'brightness') {
            const min = litra.getMinimumBrightnessInLumenForDevice(d)
            const max = litra.getMaximumBrightnessInLumenForDevice(d)
            let level = set
            if (level === undefined) {
                const cur = (readLumen(d) - min) / (max - min)
                level = cur + (step ?? 0.05) * delta
            }
            level = Math.max(0, Math.min(1, level))
            // Adjusting brightness on a dark light should light it up
            if (!readOn(d)) litra.turnOn(d)
            return litra.setBrightnessInLumen(d, Math.round(min + level * (max - min)))
        }
        if (op === 'temperature') {
            const lo = litra.getMinimumTemperatureInKelvinForDevice(d)
            const hi = litra.getMaximumTemperatureInKelvinForDevice(d)
            let k = set ?? readKelvin(d) + (step ?? 100) * delta
            k = Math.max(lo, Math.min(hi, Math.round(k / 100) * 100)) // device only accepts multiples of 100
            return litra.setTemperatureInKelvin(d, k)
        }
        throw new Error(`Unknown light op "${op}"`)
    })
}

export function lightAvailable() {
    try { return !!getDevice() } catch (err) { log.debug(err.message); return false }
}
