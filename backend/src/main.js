// Daemon entry point. Normally started by run.js (which restarts it on crash).
import { DeviceSupervisor } from './device.js'
import { ConfigStore } from './config.js'
import { Controller } from './controller.js'
import { startServer } from './server.js'
import { log } from './log.js'
import { lutron } from './lutron.js'

export const EXIT_ALREADY_RUNNING = 3
const PORT = Number(process.env.LD_PORT || 20010)

process.on('unhandledRejection', err => log.error('Unhandled rejection:', err))
process.on('uncaughtException', err => {
    log.error('Uncaught exception, exiting for restart:', err)
    process.exit(1)
})

const store = new ConfigStore()
store.load()
const device = new DeviceSupervisor({ path: store.config.devicePath })
const controller = new Controller(device, store)

try {
    await startServer({ port: PORT, controller, store })
} catch (err) {
    if (err.code === 'EADDRINUSE') {
        log.error(`Port ${PORT} in use - is the Loupedeck daemon already running?`)
        process.exit(EXIT_ALREADY_RUNNING)
    }
    throw err
}

log.info(`Loupedeck CT daemon started (pid ${process.pid})`)
device.start()
lutron.start()

let stopping = false
async function shutdown(signal) {
    if (stopping) return
    stopping = true
    log.info(`Shutting down (${signal})`)
    const timer = setTimeout(() => process.exit(0), 3000)
    try {
        if (device.connected) {
            // Leave the device dark rather than frozen on a stale frame
            for (const id of ['0', '1', '2', '3', '4', '5', '6', '7']) device.setButtonColor(Number(id), '#000000')
            device.setBrightness(0)
            await new Promise(r => setTimeout(r, 300))
        }
        await device.stop()
    } finally {
        clearTimeout(timer)
        process.exit(0)
    }
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
// run.js asks for a graceful stop over IPC (signals are unreliable on Windows)
process.on('message', msg => { if (msg === 'shutdown') shutdown('ipc') })
// If the run.js watchdog dies, don't linger as an orphan holding the COM port
process.on('disconnect', () => shutdown('watchdog gone'))
controller.on('shutdown', () => shutdown('api'))
