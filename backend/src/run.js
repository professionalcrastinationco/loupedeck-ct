// Watchdog: runs main.js as a child and restarts it if it ever crashes.
// Exit code 0 (requested shutdown) or 3 (already running) stops the watchdog too.
import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './log.js'

const MAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js')
const STABLE_MS = 60_000
let backoff = 1000
let child = null
let stopping = false

function start() {
    const startedAt = Date.now()
    child = fork(MAIN, [], { stdio: 'inherit' })
    child.on('exit', (code, signal) => {
        child = null
        if (stopping || code === 0 || code === 3) {
            if (code === 3) log.warn('Daemon already running elsewhere; watchdog exiting')
            process.exit(0)
        }
        if (Date.now() - startedAt > STABLE_MS) backoff = 1000
        log.error(`Daemon exited (code ${code}, signal ${signal}); restarting in ${backoff}ms`)
        setTimeout(start, backoff)
        backoff = Math.min(backoff * 2, 30_000)
    })
}

function stop() {
    stopping = true
    if (child?.connected) child.send('shutdown')
    else process.exit(0)
    setTimeout(() => process.exit(0), 4000)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

// Scheduled re-launches are a safety net: if an instance is already answering, exit quietly
const port = Number(process.env.LD_PORT || 20010)
try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) })
    if (res.ok) process.exit(0)
} catch { /* not running */ }

log.info(`Watchdog started (pid ${process.pid})`)
start()
