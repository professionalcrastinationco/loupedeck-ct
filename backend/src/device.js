// DeviceSupervisor: owns the physical connection to the Loupedeck CT.
//
// The upstream `loupedeck` library handles the wire protocol, but it has no
// timeouts anywhere (handshake, acks, open) and its reconnect logic gives up on
// "clean" disconnects. This class wraps it so that:
//   - every connect / command has a timeout
//   - a heartbeat detects a wedged device and forces a reconnect
//   - reconnects retry forever with capped backoff (unplug / replug / sleep / wake)
//   - output commands go through a coalescing queue: one in flight at a time,
//     and a newer draw to the same target replaces an older queued one
import { EventEmitter } from 'node:events'
import { LoupedeckDevice, LoupedeckCT, HAPTIC } from 'loupedeck'
import LoupedeckSerialConnection from 'loupedeck/connections/serial.js'
import { MagicByteLengthParser } from 'loupedeck/parser.js'
import { SerialPort } from 'serialport'
import { log } from './log.js'

const CONNECT_TIMEOUT = 5000
const HANDSHAKE_RETRY_MS = 400
const HANDSHAKE_MAX_TRIES = 10
const COMMAND_TIMEOUT = 3000
const HEARTBEAT_INTERVAL = 4000
const HEARTBEAT_FAILS_BEFORE_RECONNECT = 2
const BACKOFF_MIN = 1000
const BACKOFF_MAX = 5000
const VERSION_CMD = 0x07

export { HAPTIC }

class TimeoutError extends Error {}

function withTimeout(promise, ms, what) {
    let timer
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new TimeoutError(`${what} timed out after ${ms}ms`)), ms) }),
    ]).finally(() => clearTimeout(timer))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const WS_UPGRADE_HEADER = 'GET /index.html\nHTTP/1.1\nConnection: Upgrade\nUpgrade: websocket\nSec-WebSocket-Key: 123abc\n\n'

// The CT frequently ignores the first websocket-over-serial handshake after the
// port was used by a previous session (measured: it answers every other
// request). Upstream sends it once and waits forever. This version re-sends it
// on the same open port until the device answers.
class RobustSerialConnection extends LoupedeckSerialConnection {
    async connect() {
        this.connection = new SerialPort({ path: this.path, baudRate: 256000 })
        this.connection.on('error', this.onError.bind(this))
        this.connection.on('close', this.onDisconnect.bind(this))
        await new Promise((res, rej) => {
            this.connection.once('open', res)
            this.connection.once('error', rej)
        })
        // Pulse DTR. Measured: when the CT stops answering on serial entirely
        // (no reply to anything, even a close frame), dropping and re-raising
        // DTR revives it immediately. Doing it on every open costs ~200ms.
        await this.pulseDtr()
        await new Promise((res, rej) => {
            let received = ''
            let tries = 0
            const cleanup = () => { clearInterval(timer); this.connection.off('data', onData) }
            const onData = buf => {
                received += buf.toString('latin1')
                if (received.includes('HTTP/1.1 101')) { cleanup(); res() }
            }
            const send = () => {
                if (++tries > HANDSHAKE_MAX_TRIES) { cleanup(); rej(new Error('Device never answered the handshake')); return }
                if (tries > 1) log.debug(`Handshake retry ${tries}`)
                // Every third retry, pulse DTR again before re-sending
                const pre = tries % 3 === 0 ? this.pulseDtr() : Promise.resolve()
                pre.then(() => this.send(Buffer.from(WS_UPGRADE_HEADER), true)).catch(() => {})
            }
            this.connection.on('data', onData)
            const timer = setInterval(send, HANDSHAKE_RETRY_MS)
            send()
        })
        // Late duplicate handshake replies are plain ASCII (no 0x82 frame marker),
        // so the frame parser skips them.
        const parser = new MagicByteLengthParser({ magicByte: 0x82 })
        this.connection.pipe(parser)
        parser.on('data', this.emit.bind(this, 'message'))
        this.emit('connect', { address: this.path })
    }

    async pulseDtr() {
        const set = opts => new Promise((res, rej) => this.connection.set(opts, err => (err ? rej(err) : res())))
        await set({ dtr: false })
        await sleep(100)
        await set({ dtr: true })
        await sleep(100)
    }
}

function attachConnection(device, path) {
    const conn = new RobustSerialConnection({ path })
    device.connection = conn
    conn.on('connect', device.onConnect.bind(device))
    conn.on('message', device.onReceive.bind(device))
    conn.on('disconnect', device.onDisconnect.bind(device))
    return conn.connect()
}

export class DeviceSupervisor extends EventEmitter {
    constructor({ path } = {}) {
        super()
        this.preferredPath = path
        this.device = null
        this.state = 'stopped'
        this.info = null
        this.generation = 0
        this.queue = new Map() // target key -> () => Promise
        this.pumping = false
        this.heartbeatTimer = null
        this.heartbeatFails = 0
        this.stopped = false
        this.stats = { connects: 0, reconnects: 0, commandTimeouts: 0, lastConnectedAt: null, lastError: null }
    }

    get connected() { return this.state === 'connected' }

    setState(state) {
        if (this.state === state) return
        this.state = state
        this.emit('state', state)
    }

    start() {
        this.stopped = false
        this.loop()
    }

    async stop() {
        this.stopped = true
        clearInterval(this.heartbeatTimer)
        this.generation++ // ignore the disconnect event our own close triggers
        this.setState('stopped')
        await this.teardown('stopping')
    }

    // Main connect loop. Runs until connected, then returns; a disconnect calls it again.
    async loop() {
        if (this.looping) return
        this.looping = true
        let backoff = BACKOFF_MIN
        try {
            while (!this.stopped && !this.connected) {
                this.setState('searching')
                try {
                    await this.connectOnce()
                    return
                } catch (err) {
                    this.stats.lastError = err.message
                    // Only log when the message changes so a missing device doesn't spam the log
                    this._failCount = (this._failCount || 0) + 1
                    if (err.message !== this._lastLoggedError || this._failCount % 10 === 0) {
                        log.warn(`Device connect failed (attempt ${this._failCount}): ${err.message}`)
                        this._lastLoggedError = err.message
                    }
                    await this.teardown('connect failed')
                    await sleep(backoff)
                    backoff = Math.min(backoff * 2, BACKOFF_MAX)
                }
            }
        } finally {
            this.looping = false
        }
    }

    async findPath() {
        const devices = await withTimeout(LoupedeckDevice.list({ ignoreWebsocket: true }), 5000, 'device scan')
        const cts = devices.filter(d => d.productId === LoupedeckCT.productId)
        if (this.preferredPath && devices.some(d => d.path === this.preferredPath)) return this.preferredPath
        if (cts.length) return cts[0].path
        if (devices.length) throw new Error(`Found Loupedeck device(s) but no CT: ${devices.map(d => d.path).join(', ')}`)
        throw new Error('No Loupedeck CT found (is it plugged in?)')
    }

    async connectOnce() {
        const path = await this.findPath()
        this.setState('connecting')
        const gen = ++this.generation
        const device = new LoupedeckCT({ path, autoConnect: false, reconnectInterval: false })
        this.device = device

        // Forward input events, tagged so stale devices can't leak events
        for (const ev of ['down', 'up', 'rotate', 'touchstart', 'touchmove', 'touchend']) {
            device.on(ev, payload => { if (gen === this.generation) this.emit('input', ev, payload) })
        }
        device.on('disconnect', err => {
            if (gen !== this.generation) return
            this.onLost(err ? `disconnected: ${err.message || err}` : 'disconnected')
        })

        try {
            await withTimeout(attachConnection(device, path), CONNECT_TIMEOUT, `open ${path}`)
        } catch (err) {
            const msg = String(err?.message || err)
            if (/access denied|busy|in use/i.test(msg)) {
                throw new Error(`${path} is in use by another program (close Loupedeck / Logi Plugin Service): ${msg}`)
            }
            throw err
        }
        const info = await withTimeout(device.getInfo(), COMMAND_TIMEOUT, 'getInfo')
        this.info = { ...info, path }
        this.heartbeatFails = 0
        this.queue.clear()
        this.stats.connects++
        this.stats.lastConnectedAt = new Date().toISOString()
        this.stats.lastError = null
        this._lastLoggedError = null
        this._failCount = 0
        log.info(`Connected to Loupedeck CT on ${path} (serial ${info.serial}, firmware ${info.version})`)
        this.setState('connected')
        this.startHeartbeat()
        this.emit('connected', this.info)
    }

    startHeartbeat() {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = setInterval(async () => {
            if (!this.connected) return
            try {
                await withTimeout(this.device.send(VERSION_CMD), COMMAND_TIMEOUT, 'heartbeat')
                this.heartbeatFails = 0
            } catch (err) {
                this.heartbeatFails++
                log.warn(`Heartbeat failed (${this.heartbeatFails}/${HEARTBEAT_FAILS_BEFORE_RECONNECT}): ${err.message}`)
                if (this.heartbeatFails >= HEARTBEAT_FAILS_BEFORE_RECONNECT) this.onLost('heartbeat lost')
            }
        }, HEARTBEAT_INTERVAL)
    }

    async onLost(reason) {
        // While connecting, the connect attempt's own timeout/failure handles retries
        if (this.state !== 'connected') return
        log.warn(`Lost device: ${reason}. Reconnecting...`)
        this.stats.reconnects++
        clearInterval(this.heartbeatTimer)
        this.generation++ // invalidate the old device's events
        this.setState('searching')
        this.emit('disconnected', reason)
        await this.teardown(reason)
        if (!this.stopped) this.loop()
    }

    async teardown() {
        const device = this.device
        this.device = null
        this.queue.clear()
        if (!device) return
        try {
            // Polite close first (sends the protocol's close frame) so the device
            // accepts the next handshake immediately
            if (device.connection?.isReady?.()) await withTimeout(device.close(), 1500, 'close device')
        } catch { /* fall through to a hard close */ }
        try {
            const port = device.connection?.connection
            if (port?.isOpen) {
                await withTimeout(new Promise(res => port.close(() => res())), 2000, 'close port')
            }
        } catch { /* best effort */ }
        try { device.removeAllListeners() } catch { /* ignore */ }
    }

    // ---- Output queue -------------------------------------------------------

    // Queue a device operation. Operations with the same key replace older
    // queued ones (e.g. redrawing key 3 twice only sends the latest frame).
    enqueue(key, op) {
        if (!this.connected) return
        this.queue.delete(key) // re-insert at the end to keep ordering sane
        this.queue.set(key, op)
        this.pump()
    }

    async pump() {
        if (this.pumping) return
        this.pumping = true
        try {
            while (this.queue.size && this.connected) {
                const [key, op] = this.queue.entries().next().value
                this.queue.delete(key)
                const device = this.device
                try {
                    await withTimeout(op(device), COMMAND_TIMEOUT, `command ${key}`)
                } catch (err) {
                    if (err instanceof TimeoutError) this.stats.commandTimeouts++
                    log.warn(`Device command ${key} failed: ${err.message}`)
                    this.emit('commandFailed', key)
                }
            }
        } finally {
            this.pumping = false
        }
    }

    drawKey(index, cb) { this.enqueue(`key:${index}`, d => d.drawKey(index, cb)) }
    drawScreen(id, cb) { this.enqueue(`screen:${id}`, d => d.drawScreen(id, cb)) }
    setButtonColor(id, color) { this.enqueue(`color:${id}`, d => d.setButtonColor({ id, color })) }
    setBrightness(value) { this.enqueue('brightness', d => d.setBrightness(value)) }
    vibrate(pattern = HAPTIC.SHORT) { this.enqueue(`vibrate:${Date.now()}`, d => d.vibrate(pattern)) }

    status() {
        return { state: this.state, info: this.info, queued: this.queue.size, stats: this.stats }
    }
}
