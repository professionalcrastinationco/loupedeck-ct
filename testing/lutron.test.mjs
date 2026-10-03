// Lutron level handling under fast knob turns (no bridge needed).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.LD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ldtest-'))
const { Lutron } = await import('../backend/src/lutron.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeBridge() {
    const l = new Lutron()
    l.state = 'connected'
    l.zones.set('5', { id: '5', name: 'Main', area: 'Living', type: 'Dimmed', level: 40 })
    const sent = []
    // Fake client: each command takes 30ms, like a real round trip
    l.client = {
        request: async (type, url, body) => {
            if (type === 'CreateRequest') { sent.push(body.Command.Parameter[0].Value); await sleep(30) }
            return { Header: { StatusCode: '200 OK' }, Body: { ZoneStatus: { Zone: { href: '/zone/5' }, Level: 40 } } }
        },
    }
    return { l, sent }
}

const report = (l, level) => l.onZoneStatus({ Body: { ZoneStatus: { Zone: { href: '/zone/5' }, Level: level } } })

test('fast spin only moves one way despite stale fade reports', async () => {
    const { l, sent } = makeBridge()
    const seen = []
    for (let i = 0; i < 12; i++) {
        l.action({ op: 'level', zone: '5', step: 4 }, 1)
        report(l, 40 + i) // bridge still fading, reports old-ish values
        seen.push(l.zone('5').level)
        await sleep(5)
    }
    for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], `level went ${seen[i - 1]} -> ${seen[i]}`)
    assert.equal(seen.at(-1), 88)
    await sleep(100)
    assert.equal(sent.at(-1), 88, 'final command is the final level')
    assert.ok(sent.length < 12, `coalesced: ${sent.length} commands for 12 detents`)
    for (let i = 1; i < sent.length; i++) assert.ok(sent[i] > sent[i - 1], 'commands are monotonic')
})

test('reports are accepted again once the hold window passes', async () => {
    const { l } = makeBridge()
    await l.action({ op: 'level', zone: '5', set: 70 })
    report(l, 10)
    assert.equal(l.zone('5').level, 70)
    l.zone('5').holdUntil = 0
    report(l, 10)
    assert.equal(l.zone('5').level, 10)
    clearTimeout(l.zone('5').settleTimer)
})

test('level clamps to 0-100', async () => {
    const { l } = makeBridge()
    await l.action({ op: 'level', zone: '5', set: 150 })
    assert.equal(l.zone('5').level, 100)
    await l.action({ op: 'level', zone: '5', step: 10 }, -20)
    assert.equal(l.zone('5').level, 0)
    clearTimeout(l.zone('5').settleTimer)
})
