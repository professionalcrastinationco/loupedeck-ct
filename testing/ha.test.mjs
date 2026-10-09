// Home Assistant level/state handling under fast knob turns (no HA needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.LD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ldtest-'))
const { HomeAssistant } = await import('../backend/src/ha.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))
const cleanup = h => { for (const r of h.rt.values()) clearTimeout(r.settleTimer) }

// Entity objects in the shape subscribeEntities delivers
const lightEnt = (state, pct) => ({
    entity_id: 'light.lamp', state,
    attributes: { friendly_name: 'Lamp', supported_color_modes: ['brightness'], ...(state === 'on' ? { brightness: Math.round(pct * 2.55) } : {}) },
    last_changed: '', last_updated: '', context: { id: '', user_id: null, parent_id: null },
})
const switchEnt = state => ({ entity_id: 'switch.fan', state, attributes: { friendly_name: 'Fan' }, last_changed: '', last_updated: '', context: { id: '', user_id: null, parent_id: null } })

function makeHa() {
    const h = new HomeAssistant()
    h.state = 'connected'
    const sent = []
    // The real callService() calls conn.sendMessagePromise with a call_service message
    h.conn = {
        sendMessagePromise: async msg => {
            assert.equal(msg.type, 'call_service')
            sent.push(msg)
            await sleep(30) // network round trip
            return { context: { id: 'x' } }
        },
    }
    h.onEntities({ 'light.lamp': lightEnt('on', 40), 'switch.fan': switchEnt('on'), 'sensor.temp': { entity_id: 'sensor.temp', state: '20', attributes: {} } })
    return { h, sent }
}

test('fast spin only moves one way despite stale state echoes', async () => {
    const { h, sent } = makeHa()
    const seen = []
    for (let i = 0; i < 12; i++) {
        h.action({ op: 'level', entity: 'light.lamp', step: 4 }, 1)
        h.onEntities({ 'light.lamp': lightEnt('on', 40 + i), 'switch.fan': switchEnt('on') }) // HA still transitioning
        seen.push(h.entity('light.lamp').level)
        await sleep(5)
    }
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `level went ${seen[i - 1]} -> ${seen[i]}`)
    assert.equal(seen.at(-1), 88)
    await sleep(120)
    const pcts = sent.map(m => m.service_data.brightness_pct)
    assert.equal(pcts.at(-1), 88, 'final call is the final level')
    assert.ok(sent.length < 12, `coalesced: ${sent.length} calls for 12 detents`)
    for (let i = 1; i < pcts.length; i++) assert.ok(pcts[i] > pcts[i - 1], 'calls are monotonic')
    assert.deepEqual(sent[0].target, { entity_id: 'light.lamp' })
    cleanup(h)
})

test('small steps keep an unrounded level (no drift)', async () => {
    const { h } = makeHa()
    for (let i = 0; i < 10; i++) await h.action({ op: 'level', entity: 'light.lamp', step: 0.5 }, 1)
    assert.equal(h.entity('light.lamp').level, 45)
    cleanup(h)
})

test('dimming to 0 turns the light off', async () => {
    const { h, sent } = makeHa()
    await h.action({ op: 'level', entity: 'light.lamp', set: 0 })
    assert.equal(sent.at(-1).service, 'turn_off')
    assert.equal(h.entity('light.lamp').state, 'off')
    cleanup(h)
})

test('echoes are ignored during the hold, then the latest state is re-applied', async () => {
    const { h } = makeHa()
    await h.action({ op: 'level', entity: 'light.lamp', set: 70 })
    h.onEntities({ 'light.lamp': lightEnt('on', 10), 'switch.fan': switchEnt('on') })
    assert.equal(h.entity('light.lamp').level, 70)
    // Pretend the hold window ran out: the settle step applies HA's last snapshot
    h.runtime('light.lamp').holdUntil = 0
    h.onEntities(h.raw)
    assert.equal(h.entity('light.lamp').level, 10)
    cleanup(h)
})

test('toggling a dimmable light back on restores its previous brightness (regression: came back at 100%)', async () => {
    const { h, sent } = makeHa() // lamp is on at 40%
    await h.action({ op: 'toggle', entity: 'light.lamp' })
    assert.equal(sent.at(-1).service, 'turn_off')
    h.runtime('light.lamp').holdUntil = 0
    h.onEntities({ 'light.lamp': lightEnt('off'), 'switch.fan': switchEnt('on') })
    await h.action({ op: 'toggle', entity: 'light.lamp' })
    assert.equal(sent.at(-1).service, 'turn_on')
    assert.equal(sent.at(-1).service_data.brightness_pct, 40)
    cleanup(h)
})

test('an explicit "set" still wins over the remembered level', async () => {
    const { h, sent } = makeHa()
    await h.action({ op: 'on', entity: 'light.lamp', set: 100 })
    assert.equal(sent.at(-1).service_data.brightness_pct, 100)
    cleanup(h)
})

test('remembered levels survive a restart', async () => {
    const { h } = makeHa()
    h.onEntities({ 'light.lamp': lightEnt('on', 25), 'switch.fan': switchEnt('on') })
    await sleep(2200) // debounced save
    const h2 = new HomeAssistant()
    assert.ok(Math.abs(h2.lastOn.get('light.lamp') - 25) < 0.5)
    cleanup(h)
})

test('toggle uses explicit on/off from the known state', async () => {
    const { h, sent } = makeHa()
    await h.action({ op: 'toggle', entity: 'switch.fan' })
    assert.equal(sent.at(-1).domain, 'switch')
    assert.equal(sent.at(-1).service, 'turn_off')
    assert.equal(h.entity('switch.fan').state, 'off')
    cleanup(h)
})

test('only controllable domains are tracked', () => {
    const { h } = makeHa()
    assert.equal(h.entity('sensor.temp'), undefined)
    cleanup(h)
})

test('state is JSON-serializable mid-action', async () => {
    const { h } = makeHa()
    const p = h.action({ op: 'level', entity: 'light.lamp', step: 5 }, 1)
    assert.doesNotThrow(() => JSON.stringify(h.list()))
    await p
    cleanup(h)
})

test('offline HA rejects cleanly instead of throwing synchronously', async () => {
    const h = new HomeAssistant()
    h.state = 'retrying'
    await assert.rejects(h.action({ op: 'toggle', entity: 'light.lamp' }), /Home Assistant is retrying/)
})

test('no settings file means "not configured", no connection attempt', () => {
    const h = new HomeAssistant()
    h.start()
    assert.equal(h.state, 'not configured')
})
