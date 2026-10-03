// Litra knob handling with a fake light that applies changes late (no hardware).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.LD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ldtest-'))
const light = await import('../backend/src/light.js')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Reads return the OLD value until 60 ms after a write, like the real light
function fakeLight() {
    const actual = { on: true, lumen: 100, kelvin: 4500 }
    const pending = []
    const settle = () => { const now = Date.now(); while (pending.length && pending[0].at <= now) Object.assign(actual, pending.shift().patch) }
    const write = patch => pending.push({ at: Date.now() + 60, patch })
    const writes = []
    return {
        writes, actual, flush: () => { while (pending.length) Object.assign(actual, pending.shift().patch) },
        driver: {
            find: () => ({ type: 'fake' }), close: () => {},
            info: () => ({ name: 'Fake Litra', minLumen: 20, maxLumen: 250, minKelvin: 2700, maxKelvin: 6500 }),
            readOn: () => (settle(), actual.on),
            readLumen: () => (settle(), actual.lumen),
            readKelvin: () => (settle(), actual.kelvin),
            setOn: (d, on) => { writes.push(['on', on]); write({ on }) },
            setLumen: (d, lumen) => { writes.push(['lumen', lumen]); write({ lumen }) },
            setKelvin: (d, kelvin) => { writes.push(['kelvin', kelvin]); write({ kelvin }) },
        },
    }
}

let fake
beforeEach(() => { fake = fakeLight(); light._setDriver(fake.driver) })

test('fast brightness spin only moves one way and lands on the right value', async () => {
    // 10 detents fired without waiting, like a fast knob spin
    await Promise.all(Array.from({ length: 10 }, () => light.lightAction({ op: 'brightness', step: 0.05 }, 1)))
    const lumens = fake.writes.filter(w => w[0] === 'lumen').map(w => w[1])
    assert.equal(lumens.length, 10)
    for (let i = 1; i < lumens.length; i++) assert.ok(lumens[i] > lumens[i - 1], `went ${lumens[i - 1]} -> ${lumens[i]}`)
    // 100 lm start = 34.8% of 20-250; +50% => 84.8% => 215 lm
    assert.equal(lumens.at(-1), 215)
    const state = await light.getLightState()
    assert.equal(state.lumen, 215, 'display shows the commanded value while the light settles')
})

test('mixed directions during a spin net out correctly', async () => {
    for (const d of [1, 1, 1, -1, 1, -1, -1]) light.lightAction({ op: 'brightness', step: 0.1 }, d)
    await light.lightAction({ op: 'brightness', step: 0 }, 1)
    // net +1 step of 10% from 34.8% => 44.8% => 123 lm
    assert.equal(fake.writes.filter(w => w[0] === 'lumen').at(-1)[1], 123)
})

test('temperature steps snap to 100 K and clamp', async () => {
    for (let i = 0; i < 30; i++) light.lightAction({ op: 'temperature', step: 100 }, 1)
    await light.lightAction({ op: 'temperature', step: 0 }, 1)
    assert.equal((await light.getLightState()).kelvin, 6500)
})

test('toggle twice quickly ends where it started', async () => {
    light.lightAction({ op: 'toggle' })
    await light.lightAction({ op: 'toggle' })
    assert.deepEqual(fake.writes, [['on', false], ['on', true]])
})

test('state reads from the light again after the hold window', async () => {
    await light.lightAction({ op: 'brightness', set: 0.5 })
    fake.flush() // the light finished applying our write
    fake.actual.lumen = 40 // someone changed it on the light itself
    await sleep(1600)
    assert.equal((await light.getLightState()).lumen, 40)
})
