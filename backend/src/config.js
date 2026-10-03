// Config store: loads data/config.json (seeded from config/default-config.json),
// validates it, watches it for hand edits, and saves atomically with a backup.
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { CONFIG_FILE, DEFAULT_CONFIG_FILE, DATA_DIR, ICONS_DIR } from './paths.js'
import { log } from './log.js'

export const KNOB_IDS = ['knobTL', 'knobCL', 'knobBL', 'knobTR', 'knobCR', 'knobBR']
export const ROUND_BUTTONS = ['0', '1', '2', '3', '4', '5', '6', '7']
export const SQUARE_BUTTONS = ['home', 'undo', 'keyboard', 'enter', 'save', 'fnL', 'a', 'b', 'c', 'd', 'fnR', 'e']
export const KEY_COUNT = 12

export function validateConfig(cfg) {
    const errors = []
    if (!cfg || typeof cfg !== 'object') return ['Config must be an object']
    if (!Array.isArray(cfg.pages) || cfg.pages.length === 0) errors.push('"pages" must be a non-empty array')
    const ids = new Set()
    for (const [i, p] of (cfg.pages || []).entries()) {
        if (!p.id) errors.push(`pages[${i}] is missing "id"`)
        else if (ids.has(p.id)) errors.push(`Duplicate page id "${p.id}"`)
        ids.add(p.id)
        for (const k of Object.keys(p.keys || {})) {
            if (!(Number(k) >= 0 && Number(k) < KEY_COUNT)) errors.push(`Page "${p.id}": key "${k}" must be 0-${KEY_COUNT - 1}`)
        }
    }
    for (const r of cfg.appRules || []) {
        if (!r.page || !ids.has(r.page)) errors.push(`appRules entry for "${r.exe || r.title}" points to unknown page "${r.page}"`)
    }
    if (cfg.startPage && !ids.has(cfg.startPage)) errors.push(`startPage "${cfg.startPage}" is not a page id`)
    return errors
}

export class ConfigStore extends EventEmitter {
    constructor() {
        super()
        this.config = null
        this.lastWrite = 0
    }

    load() {
        fs.mkdirSync(DATA_DIR, { recursive: true })
        fs.mkdirSync(ICONS_DIR, { recursive: true })
        if (!fs.existsSync(CONFIG_FILE)) {
            fs.copyFileSync(DEFAULT_CONFIG_FILE, CONFIG_FILE)
            log.info(`Created ${CONFIG_FILE} from defaults`)
        }
        const cfg = this.readFile(CONFIG_FILE)
        if (!cfg) {
            // Broken config on startup: fall back to last good backup, then defaults
            const fallback = this.readFile(CONFIG_FILE + '.bak') || this.readFile(DEFAULT_CONFIG_FILE)
            log.error('Config invalid on startup, using fallback (your file was left untouched)')
            this.config = fallback
        } else {
            this.config = cfg
        }
        this.watch()
        return this.config
    }

    readFile(file) {
        try {
            const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
            const errors = validateConfig(cfg)
            if (errors.length) {
                log.error(`Config ${file} invalid: ${errors.join('; ')}`)
                return null
            }
            return cfg
        } catch (err) {
            log.error(`Failed to read ${file}: ${err.message}`)
            return null
        }
    }

    save(cfg) {
        const errors = validateConfig(cfg)
        if (errors.length) {
            const err = new Error(errors.join('; '))
            err.validation = errors
            throw err
        }
        const json = JSON.stringify(cfg, null, 2)
        if (fs.existsSync(CONFIG_FILE)) fs.copyFileSync(CONFIG_FILE, CONFIG_FILE + '.bak')
        const tmp = CONFIG_FILE + '.tmp'
        fs.writeFileSync(tmp, json)
        fs.renameSync(tmp, CONFIG_FILE)
        this.lastWrite = Date.now()
        this.config = cfg
        this.emit('change', cfg)
    }

    // Hot-reload when the file is edited by hand
    watch() {
        let timer
        try {
            fs.watch(DATA_DIR, (event, filename) => {
                if (filename !== path.basename(CONFIG_FILE)) return
                clearTimeout(timer)
                timer = setTimeout(() => {
                    if (Date.now() - this.lastWrite < 1000) return // our own save
                    const cfg = this.readFile(CONFIG_FILE)
                    if (!cfg) return
                    if (JSON.stringify(cfg) === JSON.stringify(this.config)) return
                    log.info('Config file changed on disk, reloading')
                    this.config = cfg
                    this.emit('change', cfg)
                }, 250)
            })
        } catch (err) {
            log.warn(`Config watch unavailable: ${err.message}`)
        }
    }
}
