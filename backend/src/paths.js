import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export const BACKEND_DIR = path.resolve(here, '..')
export const ROOT_DIR = path.resolve(BACKEND_DIR, '..')
export const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend')
// Runtime data (user config, logs, uploaded icons). Overridable for tests.
export const DATA_DIR = process.env.LD_DATA_DIR || path.join(BACKEND_DIR, 'data')
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
export const ICONS_DIR = path.join(DATA_DIR, 'icons')
export const DEFAULT_CONFIG_FILE = path.join(BACKEND_DIR, 'config', 'default-config.json')
