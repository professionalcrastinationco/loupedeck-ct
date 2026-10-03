// Direct Win32 access via koffi FFI (no native build step):
//   - keyboard input (SendInput): hotkeys, media keys, unicode text
//   - foreground window / process detection (for per-app pages)
//   - Core Audio endpoint volume + mute for speakers and microphone
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const kernel32 = koffi.load('kernel32.dll')
const ole32 = koffi.load('ole32.dll')

// ---- Keyboard ---------------------------------------------------------------

const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
})
const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
    dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
})
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
const INPUT = koffi.struct('INPUT', {
    type: 'uint32',
    u: koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
})
const SendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int32'])
const MapVirtualKeyW = user32.func('__stdcall', 'MapVirtualKeyW', 'uint32', ['uint32', 'uint32'])

const INPUT_KEYBOARD = 1
const INPUT_MOUSE = 0
const KEYEVENTF_EXTENDEDKEY = 0x1
const KEYEVENTF_KEYUP = 0x2
const KEYEVENTF_UNICODE = 0x4
const MOUSEEVENTF_WHEEL = 0x0800
const MOUSEEVENTF_HWHEEL = 0x1000

const VK = {
    backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12,
    pause: 0x13, capslock: 0x14, esc: 0x1b, escape: 0x1b, space: 0x20, pageup: 0x21, pagedown: 0x22,
    end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28, printscreen: 0x2c,
    insert: 0x2d, delete: 0x2e, del: 0x2e, win: 0x5b, meta: 0x5b, cmd: 0x5b, menu: 0x5d, apps: 0x5d,
    numlock: 0x90, scrolllock: 0x91,
    volumemute: 0xad, volumedown: 0xae, volumeup: 0xaf,
    medianext: 0xb0, mediaprev: 0xb1, mediastop: 0xb2, playpause: 0xb3,
    ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
    '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
    plus: 0xbb, minus: 0xbd, comma: 0xbc, period: 0xbe, slash: 0xbf, backslash: 0xdc,
    semicolon: 0xba, quote: 0xde, backtick: 0xc0, lbracket: 0xdb, rbracket: 0xdd, equals: 0xbb,
    numadd: 0x6b, numsub: 0x6d, nummul: 0x6a, numdiv: 0x6f, numdec: 0x6e,
}
for (let i = 0; i < 26; i++) VK[String.fromCharCode(97 + i)] = 0x41 + i
for (let i = 0; i < 10; i++) { VK[String(i)] = 0x30 + i; VK[`num${i}`] = 0x60 + i }
for (let i = 1; i <= 24; i++) VK[`f${i}`] = 0x6f + i

const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5d, 0x6f, 0x90, 0x2c])

export const KEY_NAMES = Object.keys(VK)

function keyEvent(vk, up) {
    let flags = up ? KEYEVENTF_KEYUP : 0
    if (EXTENDED.has(vk)) flags |= KEYEVENTF_EXTENDEDKEY
    return { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: MapVirtualKeyW(vk, 0), dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
}

export function parseCombo(combo) {
    return String(combo).toLowerCase().split('+').map(s => s.trim()).filter(Boolean).map(name => {
        const vk = VK[name]
        if (vk === undefined) throw new Error(`Unknown key "${name}" in "${combo}"`)
        return vk
    })
}

// Press a combo like "ctrl+shift+m": modifiers down in order, then up in reverse.
export function sendCombo(combo) {
    const vks = parseCombo(combo)
    const events = [...vks.map(vk => keyEvent(vk, false)), ...[...vks].reverse().map(vk => keyEvent(vk, true))]
    return SendInput(events.length, events, koffi.sizeof(INPUT))
}

export function keyDown(combo) {
    const events = parseCombo(combo).map(vk => keyEvent(vk, false))
    return SendInput(events.length, events, koffi.sizeof(INPUT))
}

export function keyUp(combo) {
    const events = parseCombo(combo).reverse().map(vk => keyEvent(vk, true))
    return SendInput(events.length, events, koffi.sizeof(INPUT))
}

export function typeText(text) {
    const events = []
    for (const ch of String(text)) {
        if (ch === '\n') { events.push(keyEvent(VK.enter, false), keyEvent(VK.enter, true)); continue }
        // Surrogate pairs (emoji) are sent as two UTF-16 units
        for (let i = 0; i < ch.length; i++) {
            const code = ch.charCodeAt(i)
            for (const up of [false, true]) {
                events.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: code, dwFlags: KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0 } } })
            }
        }
    }
    return events.length ? SendInput(events.length, events, koffi.sizeof(INPUT)) : 0
}

// Mouse wheel scroll; amount in "notches" (positive = up / right)
export function scroll(amount, horizontal = false) {
    const ev = { type: INPUT_MOUSE, u: { mi: { dx: 0, dy: 0, mouseData: Math.round(amount * 120), dwFlags: horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, time: 0, dwExtraInfo: 0 } } }
    return SendInput(1, [ev], koffi.sizeof(INPUT))
}

// ---- Foreground window ------------------------------------------------------

const GetForegroundWindow = user32.func('__stdcall', 'GetForegroundWindow', 'void *', [])
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', ['void *', koffi.out(koffi.pointer('uint32'))])
const GetWindowTextW = user32.func('__stdcall', 'GetWindowTextW', 'int', ['void *', koffi.out(koffi.pointer('char16_t')), 'int'])
const OpenProcess = kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'bool', 'uint32'])
const CloseHandle = kernel32.func('__stdcall', 'CloseHandle', 'bool', ['void *'])
const QueryFullProcessImageNameW = kernel32.func('__stdcall', 'QueryFullProcessImageNameW', 'bool', ['void *', 'uint32', koffi.out(koffi.pointer('char16_t')), koffi.inout(koffi.pointer('uint32'))])
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

export function getForegroundApp() {
    const hwnd = GetForegroundWindow()
    if (!hwnd) return null
    const pidOut = [0]
    GetWindowThreadProcessId(hwnd, pidOut)
    const pid = pidOut[0]
    const titleBuf = Buffer.alloc(512 * 2)
    const titleLen = GetWindowTextW(hwnd, titleBuf, 512)
    const title = titleBuf.toString('utf16le', 0, titleLen * 2)
    let exePath = ''
    const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
    if (h) {
        const buf = Buffer.alloc(1024 * 2)
        const size = [1024]
        if (QueryFullProcessImageNameW(h, 0, buf, size)) exePath = buf.toString('utf16le', 0, size[0] * 2)
        CloseHandle(h)
    }
    const exe = exePath.split('\\').pop().toLowerCase()
    return { pid, title, exe, exePath }
}

// ---- Core Audio (IAudioEndpointVolume) ---------------------------------------

const GUID = koffi.struct('GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) })
function guid(str) {
    const h = str.replace(/[{}-]/g, '')
    return {
        Data1: parseInt(h.slice(0, 8), 16), Data2: parseInt(h.slice(8, 12), 16), Data3: parseInt(h.slice(12, 16), 16),
        Data4: Array.from({ length: 8 }, (_, i) => parseInt(h.slice(16 + i * 2, 18 + i * 2), 16)),
    }
}
const CLSID_MMDeviceEnumerator = guid('BCDE0395-E52F-467C-8E3D-C4579291692E')
const IID_IMMDeviceEnumerator = guid('A95664D2-9614-4F35-A746-DE8DB63617E6')
const IID_IAudioEndpointVolume = guid('5CDF2C82-841E-4546-9722-0CF74078229A')
const CLSCTX_ALL = 0x17

const CoInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32'])
const CoCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', [koffi.pointer(GUID), 'void *', 'uint32', koffi.pointer(GUID), koffi.out(koffi.pointer('void *'))])

// vtable method prototypes
const P_Release = koffi.proto('__stdcall', 'P_Release', 'uint32', ['void *'])
const P_GetDefaultAudioEndpoint = koffi.proto('__stdcall', 'P_GetDefaultAudioEndpoint', 'int32', ['void *', 'int32', 'int32', koffi.out(koffi.pointer('void *'))])
const P_Activate = koffi.proto('__stdcall', 'P_Activate', 'int32', ['void *', koffi.pointer(GUID), 'uint32', 'void *', koffi.out(koffi.pointer('void *'))])
const P_SetScalar = koffi.proto('__stdcall', 'P_SetScalar', 'int32', ['void *', 'float', 'void *'])
const P_GetScalar = koffi.proto('__stdcall', 'P_GetScalar', 'int32', ['void *', koffi.out(koffi.pointer('float'))])
const P_SetMute = koffi.proto('__stdcall', 'P_SetMute', 'int32', ['void *', 'int32', 'void *'])
const P_GetMute = koffi.proto('__stdcall', 'P_GetMute', 'int32', ['void *', koffi.out(koffi.pointer('int32'))])

function vcall(obj, index, proto, ...args) {
    const vtbl = koffi.decode(obj, 'void *')
    const fn = koffi.decode(vtbl, index * koffi.sizeof('void *'), 'void *')
    return koffi.call(fn, proto, obj, ...args)
}
function check(hr, what) {
    if (hr < 0) throw new Error(`${what} failed: HRESULT 0x${(hr >>> 0).toString(16)}`)
}

let comReady = false
function ensureCom() {
    if (comReady) return
    // S_OK, S_FALSE (already initialised) and RPC_E_CHANGED_MODE are all fine for our use
    CoInitializeEx(null, 0x0)
    comReady = true
}

// Opens the *current* default endpoint every call so device switches (headset
// plugged in, etc.) are picked up automatically.
function withEndpointVolume(flow, fn) {
    ensureCom()
    const enumOut = [null]
    check(CoCreateInstance(CLSID_MMDeviceEnumerator, null, CLSCTX_ALL, IID_IMMDeviceEnumerator, enumOut), 'CoCreateInstance')
    const enumerator = enumOut[0]
    let device = null, vol = null
    try {
        const devOut = [null]
        // role 1 = eMultimedia
        check(vcall(enumerator, 4, P_GetDefaultAudioEndpoint, flow, 1, devOut), 'GetDefaultAudioEndpoint')
        device = devOut[0]
        const volOut = [null]
        check(vcall(device, 3, P_Activate, IID_IAudioEndpointVolume, CLSCTX_ALL, null, volOut), 'Activate')
        vol = volOut[0]
        return fn(vol)
    } finally {
        if (vol) vcall(vol, 2, P_Release)
        if (device) vcall(device, 2, P_Release)
        vcall(enumerator, 2, P_Release)
    }
}

const FLOW = { speakers: 0, output: 0, mic: 1, microphone: 1, input: 1 }
function flowOf(target = 'speakers') {
    const f = FLOW[target]
    if (f === undefined) throw new Error(`Unknown audio target "${target}" (use speakers or mic)`)
    return f
}

export function getVolume(target) {
    return withEndpointVolume(flowOf(target), vol => {
        const level = [0], mute = [0]
        check(vcall(vol, 9, P_GetScalar, level), 'GetMasterVolumeLevelScalar')
        check(vcall(vol, 15, P_GetMute, mute), 'GetMute')
        return { level: level[0], muted: !!mute[0] }
    })
}

export function setVolume(target, level) {
    const clamped = Math.max(0, Math.min(1, level))
    withEndpointVolume(flowOf(target), vol => check(vcall(vol, 7, P_SetScalar, clamped, null), 'SetMasterVolumeLevelScalar'))
    return clamped
}

export function changeVolume(target, delta) {
    const { level } = getVolume(target)
    return setVolume(target, level + delta)
}

export function setMute(target, muted) {
    withEndpointVolume(flowOf(target), vol => check(vcall(vol, 14, P_SetMute, muted ? 1 : 0, null), 'SetMute'))
    return muted
}

export function toggleMute(target) {
    const { muted } = getVolume(target)
    return setMute(target, !muted)
}
