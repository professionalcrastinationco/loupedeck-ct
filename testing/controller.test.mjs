// Run: cd backend && npm test
// Uses a fake device so no hardware is needed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.LD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ldtest-'))

const { Controller } = await import('../backend/src/controller.js')
const { validateConfig } = await import('../backend/src/config.js')
const { parseCombo } = await import('../backend/src/win32.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

class FakeDevice extends EventEmitter {
    connected = true
    calls = []
    status() { return { state: 'connected' } }
    drawKey(i) { this.calls.push(`key:${i}`) }
    drawScreen(id) { this.calls.push(`screen:${id}`) }
    setButtonColor(id, c) { this.calls.push(`color:${id}:${c}`) }
    setBrightness(v) { this.calls.push(`brightness:${v}`) }
    vibrate() { this.calls.push('vibrate') }
}

function makeConfig() {
    return {
        haptics: false,
        autoSwitch: false,
        startPage: 'a',
        appRules: [],
        global: {
            knobs: { knobTL: { left: { type: 'none', tag: 'L' }, right: { type: 'none', tag: 'R' }, press: { type: 'none', tag: 'P' } } },
            buttons: {
                0: { action: { type: 'page', page: 'a' } },
                1: { action: { type: 'page', page: 'b' } },
                home: { action: { type: 'none', tag: 'short' }, longPress: { type: 'none', tag: 'long' } },
            },
        },
        pages: [
            { id: 'a', name: 'A', color: '#ff0000', keys: { 0: { label: 'go b', action: { type: 'page', page: 'b' } }, 1: { label: 'held', action: { type: 'none', tag: 'tap1' }, longPress: { type: 'none', tag: 'long1' } } } },
            { id: 'b', name: 'B', color: '#00ff00', keys: {}, knobs: { knobTL: { rotate: { type: 'none', tag: 'pageRotate' } } } },
            { id: 'c', name: 'C', keys: {} },
        ],
    }
}

let device, store, ctl, ran
before(() => {
    device = new FakeDevice()
    store = Object.assign(new EventEmitter(), { config: makeConfig() })
    ctl = new Controller(device, store)
    ran = []
    const realRun = ctl.run.bind(ctl)
    ctl.run = (action, extra) => { if (action) ran.push({ tag: action.tag, ...extra }); return realRun(action, extra) }
})
after(() => ctl.dispose())

const reset = () => { ran.length = 0; ctl.manualPageId = 'a'; ctl.autoPageId = null; ctl.overrideApp = null }
const touch = (ev, x, y, id = 1) => device.emit('input', ev, { changedTouches: [{ id, x, y, target: target(x, y) }] })
const target = (x, y) => x < 60 ? { screen: 'left' } : x >= 420 ? { screen: 'right' } : { screen: 'center', key: Math.floor(y / 90) * 4 + Math.floor((x - 60) / 90) }

test('validateConfig catches common mistakes', () => {
    assert.deepEqual(validateConfig(makeConfig()), [])
    const bad = makeConfig()
    bad.pages.push({ id: 'a' })
    bad.pages[0].keys[12] = {}
    bad.appRules = [{ exe: 'x.exe', page: 'nope' }]
    const errors = validateConfig(bad).join('\n')
    assert.match(errors, /Duplicate page id "a"/)
    assert.match(errors, /key "12"/)
    assert.match(errors, /unknown page "nope"/)
    assert.deepEqual(validateConfig({ pages: [] }), ['"pages" must be a non-empty array'])
})

test('parseCombo maps names to virtual keys and rejects unknown keys', () => {
    assert.deepEqual(parseCombo('ctrl+shift+f5'), [0x11, 0x10, 0x74])
    assert.deepEqual(parseCombo('Win + .'), [0x5b, 0xbe])
    assert.throws(() => parseCombo('ctrl+banana'), /Unknown key "banana"/)
})

test('render only sends what changed', async () => {
    reset()
    ctl.signatures.clear()
    device.calls = []
    ctl.render()
    const first = device.calls.filter(c => c.startsWith('key:') || c.startsWith('screen:'))
    assert.equal(first.length, 12 + 3) // 12 keys + left/right strips + wheel
    device.calls = []
    ctl.render()
    assert.deepEqual(device.calls, [])
})

test('tapping a key runs its action; page-switch LEDs follow the page', async () => {
    reset()
    touch('touchstart', 100, 40)
    touch('touchend', 102, 42)
    assert.equal(ctl.page.id, 'b')
    device.calls = []
    ctl.render()
    assert.ok(device.calls.includes('color:1:#00ff00'), 'active page button lit in page color')
    assert.ok(device.calls.some(c => c.startsWith('color:0:rgb(')), 'inactive page button dimmed')
})

test('swiping the screen changes pages and does not trigger the key', () => {
    reset()
    touch('touchstart', 380, 40)
    touch('touchmove', 300, 45)
    touch('touchend', 150, 45)
    assert.equal(ctl.page.id, 'b')
    touch('touchstart', 150, 40)
    touch('touchend', 380, 40)
    assert.equal(ctl.page.id, 'a')
    assert.equal(ran.length, 0)
})

test('long press on a key runs longPress instead of the tap action', async () => {
    reset()
    touch('touchstart', 200, 40) // key 1
    await sleep(600)
    touch('touchend', 200, 40)
    assert.deepEqual(ran.map(r => r.tag), ['long1'])
    reset()
    touch('touchstart', 200, 40)
    await sleep(50)
    touch('touchend', 200, 40)
    assert.deepEqual(ran.map(r => r.tag), ['tap1'])
})

test('physical button: short vs long press', async () => {
    reset()
    device.emit('input', 'down', { id: 'home' })
    device.emit('input', 'up', { id: 'home' })
    assert.deepEqual(ran.map(r => r.tag), ['short'])
    reset()
    device.emit('input', 'down', { id: 'home' })
    await sleep(600)
    device.emit('input', 'up', { id: 'home' })
    assert.deepEqual(ran.map(r => r.tag), ['long'])
})

test('knob left/right repeats per detent; page binding overrides global', async () => {
    reset()
    await ctl.onRotate('knobTL', 3)
    await ctl.onRotate('knobTL', -2)
    assert.deepEqual(ran.map(r => r.tag), ['R', 'R', 'R', 'L', 'L'])
    reset()
    ctl.goToPage('b')
    ran.length = 0
    await ctl.onRotate('knobTL', -2)
    assert.deepEqual(ran.map(r => [r.tag, r.delta]), [['pageRotate', -2]])
    // pressing still falls back to... the page binding has no press, so nothing runs
    device.emit('input', 'down', { id: 'knobTL' })
    assert.equal(ran.length, 1)
})

test('next/prev/back paging wraps around', () => {
    reset()
    ctl.goToPage('prev')
    assert.equal(ctl.page.id, 'c')
    ctl.goToPage('next')
    assert.equal(ctl.page.id, 'a')
    ctl.goToPage('b')
    ctl.goToPage('back')
    assert.equal(ctl.page.id, 'a')
})

test('a bad action never throws out of the input handler', async () => {
    reset()
    const res = await ctl.run({ type: 'hotkey', keys: 'ctrl+notakey' }, {})
    assert.equal(res.ok, false)
    assert.match(res.error, /Unknown key/)
    const res2 = await ctl.run({ type: 'doesNotExist' }, {})
    assert.equal(res2.ok, false)
})

test('app rules: exe, browser title, and bad regex never throws', async () => {
    const { matchRule } = await import('../backend/src/controller.js')
    const rules = [
        { title: '(unclosed', page: 'bad' },
        { title: 'Onshape', page: 'onshape' },
        { exe: 'figma.exe', page: 'figma' },
        { title: '[–-] Figma( - |$)', page: 'figma' },
    ]
    assert.equal(matchRule(rules, { exe: 'chrome.exe', title: 'Home – Figma - Google Chrome' })?.page, 'figma')
    assert.equal(matchRule(rules, { exe: 'figma.exe', title: 'Home' })?.page, 'figma')
    assert.equal(matchRule(rules, { exe: 'msedge.exe', title: 'Part Studio | Onshape' })?.page, 'onshape')
    assert.equal(matchRule(rules, { exe: 'chrome.exe', title: 'Figma tips - Google Search' }), undefined)
})
