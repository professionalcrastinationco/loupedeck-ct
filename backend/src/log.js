// Tiny file + console logger with size-based rotation.
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './paths.js'

const LOG_DIR = path.join(DATA_DIR, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'loupedeck.log')
const MAX_BYTES = 2 * 1024 * 1024

fs.mkdirSync(LOG_DIR, { recursive: true })

const listeners = new Set()

function rotateIfNeeded() {
    try {
        if (fs.statSync(LOG_FILE).size > MAX_BYTES) {
            fs.renameSync(LOG_FILE, LOG_FILE + '.1')
        }
    } catch { /* file doesn't exist yet */ }
}

function write(level, args) {
    const msg = args.map(a => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    const line = `${new Date().toISOString()} [${level}] ${msg}`
    if (level === 'ERROR') console.error(line)
    else console.log(line)
    try {
        rotateIfNeeded()
        fs.appendFileSync(LOG_FILE, line + '\n')
    } catch { /* never let logging crash the app */ }
    for (const fn of listeners) {
        try { fn({ level, msg, ts: Date.now() }) } catch { /* ignore */ }
    }
}

export const log = {
    info: (...a) => write('INFO', a),
    warn: (...a) => write('WARN', a),
    error: (...a) => write('ERROR', a),
    debug: (...a) => { if (process.env.LD_DEBUG) write('DEBUG', a) },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    file: LOG_FILE,
}
