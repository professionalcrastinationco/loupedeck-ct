// Loupedeck CT config UI. Edits auto-save (debounced) so the physical device
// updates live while you edit. Ctrl+Z / Undo walks back through edits.
const $ = sel => document.querySelector(sel)
const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue
        if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
        else if (k === 'class') el.className = v
        else if (k === 'html') el.innerHTML = v
        else if (v === true) el.setAttribute(k, '')
        else el.setAttribute(k, v)
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(kid))
    return el
}
const clone = o => JSON.parse(JSON.stringify(o))

const KNOBS_LEFT = ['knobTL', 'knobCL', 'knobBL']
const KNOBS_RIGHT = ['knobTR', 'knobCR', 'knobBR']
const KNOB_NAMES = { knobTL: 'Top-left knob', knobCL: 'Middle-left knob', knobBL: 'Bottom-left knob', knobTR: 'Top-right knob', knobCR: 'Middle-right knob', knobBR: 'Bottom-right knob' }
const SQUARE_LEFT = ['home', 'undo', 'keyboard', 'enter', 'save', 'fnL']
const SQUARE_RIGHT = ['a', 'b', 'c', 'd', 'fnR', 'e']
const SQUARE_NAMES = { home: 'Home', undo: 'Undo', keyboard: 'Keyboard', enter: 'Enter', save: 'Save', fnL: 'Fn (left)', fnR: 'Fn (right)', a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' }

const ACTION_FIELDS = {
    none: [],
    hotkey: [['keys', 'text', 'Keys', 'e.g. ctrl+shift+m. For a sequence, separate combos with commas']],
    hold: [['keys', 'text', 'Keys held while pressed', 'e.g. shift or ctrl+alt']],
    type: [['text', 'textarea', 'Text to type']],
    open: [['target', 'text', 'URL, file, folder or app alias', 'e.g. https://..., C:\\Folder, ms-settings:, wt, code, spotify:']],
    launch: [['path', 'text', 'Program path'], ['args', 'list', 'Arguments (one per line)'], ['cwd', 'text', 'Working folder']],
    shell: [['command', 'textarea', 'Command'], ['shell', 'select:powershell,cmd', 'Shell']],
    media: [['key', 'select:playpause,next,prev,stop', 'Media key']],
    volume: [['target', 'select:speakers,mic', 'Device'], ['step', 'number', 'Step per click (0.02 = 2%)'], ['set', 'number', 'Or set to level (0-1)']],
    mute: [['target', 'select:speakers,mic', 'Device'], ['mode', 'select:toggle,on,off', 'Mode']],
    scroll: [['amount', 'number', 'Notches per click (negative = down)'], ['horizontal', 'checkbox', 'Horizontal']],
    page: [['page', 'page', 'Go to page']],
    lutron: [['op', 'select:toggle,on,off,level,fan,scene', 'What to do'], ['zone', 'lutronZone', 'Light / shade / fan'], ['scene', 'lutronScene', 'Scene (for "scene")'], ['set', 'number', 'Level 0-100 (for on/level)'], ['step', 'number', 'Step per click (for level, e.g. 5)'], ['speed', 'select:High,MediumHigh,Medium,Low,Off', 'Fan speed (for fan)']],
    light: [['op', 'select:toggle,on,off,brightness,temperature', 'What to do'], ['step', 'number', 'Step per click (brightness 0.05 = 5%, temperature in K)'], ['set', 'number', 'Or set to (brightness 0-1, temperature 2700-6500)']],
    brightness: [['step', 'number', 'Step'], ['set', 'number', 'Or set to (0.1-1)']],
    haptic: [['pattern', 'select:SHORT,MEDIUM,LONG,LOW,SHORT_LOW,SHORT_LOWER,LOWER,LOWEST,DESCEND_SLOW,DESCEND_MED,DESCEND_FAST,ASCEND_SLOW,ASCEND_MED,ASCEND_FAST,RISE_FALL,BUZZ,RUMBLE1,RUMBLE2,RUMBLE3,RUMBLE4,RUMBLE5', 'Pattern']],
    http: [['method', 'select:GET,POST,PUT,PATCH,DELETE', 'Method'], ['url', 'text', 'URL'], ['body', 'json', 'Body (JSON or text)']],
    toggle: [['id', 'text', 'Toggle name (show it with a "toggle" widget)'], ['on', 'json', 'Action when turned on'], ['off', 'json', 'Action when turned off']],
    delay: [['ms', 'number', 'Milliseconds']],
    multi: [['actions', 'json', 'Actions (JSON array, run in order)'], ['delay', 'number', 'Delay between (ms)']],
}
const ACTION_LABELS = { none: 'Do nothing', hotkey: 'Keyboard shortcut', hold: 'Hold key(s)', type: 'Type text', open: 'Open URL / file / app', launch: 'Launch program', shell: 'Run command', media: 'Media key', volume: 'Volume', mute: 'Mute', scroll: 'Scroll', page: 'Switch page', light: 'Litra light', lutron: 'Lutron (lights, shades, scenes)', brightness: 'Deck brightness', haptic: 'Vibrate', http: 'HTTP request', toggle: 'Toggle (on/off state)', delay: 'Wait', multi: 'Multiple actions' }

const WIDGET_FIELDS = {
    clock: [['format', 'select:12h,24h', 'Format']],
    date: [],
    cpu: [],
    memory: [],
    volume: [['target', 'select:speakers,mic', 'Device']],
    mute: [['target', 'select:mic,speakers', 'Device']],
    light: [['show', 'select:brightness,temperature', 'Show']],
    lutron: [['zone', 'lutronZone', 'Light / shade / fan']],
    toggle: [['id', 'text', 'Toggle name'], ['onText', 'text', 'Text when on'], ['offText', 'text', 'Text when off']],
    page: [],
    command: [['command', 'textarea', 'PowerShell command (first line = value, second = caption)'], ['interval', 'number', 'Refresh every (s)']],
    http: [['url', 'text', 'URL'], ['path', 'text', 'JSON path, e.g. data.price'], ['prefix', 'text', 'Prefix'], ['suffix', 'text', 'Suffix'], ['decimals', 'number', 'Decimals'], ['interval', 'number', 'Refresh every (s)']],
}
const WIDGET_LABELS = { clock: 'Clock', date: 'Date', cpu: 'CPU usage', memory: 'Memory usage', volume: 'Volume level', mute: 'Mute state (turns red)', light: 'Litra light state', lutron: 'Lutron level / state', toggle: 'Toggle state', page: 'Current page name', command: 'Command output', http: 'Web / JSON value' }

let config = null
let status = null
let selected = null        // { kind: 'key'|'knob'|'button'|'wheel', id }
let currentPageId = null   // page being edited
let undoStack = []
let saveTimer = null
let previewBust = Date.now()
let icons = []
let lutronInfo = { state: 'unknown', zones: [], scenes: [] }

// ---- API ------------------------------------------------------------------

async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || res.statusText)
    return data
}

function toast(msg, error = false) {
    const t = $('#toast')
    t.textContent = msg
    t.className = 'toast' + (error ? ' error' : '')
    t.hidden = false
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => { t.hidden = true }, error ? 6000 : 2500)
}

// ---- Editing & saving -----------------------------------------------------

function mutate(fn, { rerenderEditor = false } = {}) {
    undoStack.push(JSON.stringify(config))
    if (undoStack.length > 100) undoStack.shift()
    fn(config)
    scheduleSave()
    if (rerenderEditor) renderEditor()
}

function scheduleSave() {
    $('#saveState').textContent = 'Saving…'
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 350)
}

async function save() {
    saveTimer = null
    try {
        await api('PUT', '/api/config', config)
        $('#saveState').textContent = 'Saved'
        previewBust = Date.now()
        renderDevice()
        renderPages()
    } catch (err) {
        $('#saveState').textContent = 'Not saved'
        toast(err.message, true)
    }
}

function undo() {
    const prev = undoStack.pop()
    if (!prev) return toast('Nothing to undo')
    config = JSON.parse(prev)
    if (!config.pages.some(p => p.id === currentPageId)) currentPageId = config.pages[0].id
    scheduleSave()
    renderAll()
}

const page = () => config.pages.find(p => p.id === currentPageId) ?? config.pages[0]

// ---- Device mockup ----------------------------------------------------------

function previewUrl(kind, idx) {
    const pid = encodeURIComponent(page().id)
    return kind === 'wheel' ? `/api/preview/wheel/${pid}.png?b=${previewBust}` : `/api/preview/${kind}/${pid}/${idx}.png?b=${previewBust}`
}

function bindingFor(section, id) {
    const own = page()[section]?.[id]
    return { def: own ?? config.global?.[section]?.[id], scope: own ? 'page' : (config.global?.[section]?.[id] ? 'global' : null) }
}

function isSel(kind, id) { return selected && selected.kind === kind && String(selected.id) === String(id) }

function select(kind, id) {
    selected = { kind, id: String(id) }
    renderDevice()
    renderEditor()
}

function renderDevice() {
    const keys = $('#keys')
    keys.replaceChildren(...Array.from({ length: 12 }, (_, i) =>
        h('img', { src: previewUrl('key', i), class: isSel('key', i) ? 'selected' : '', 'data-sel': `key:${i}`, title: `Key ${i + 1}`, onclick: () => select('key', i) })))
    $('#stripLeft').src = previewUrl('strip', 'left')
    $('#stripRight').src = previewUrl('strip', 'right')
    $('#wheelImg').src = previewUrl('wheel')
    $('.wheel').classList.toggle('selected', isSel('wheel', 'wheel'))

    const knob = id => h('div', { class: 'knob' + (isSel('knob', id) ? ' selected' : ''), 'data-sel': `knob:${id}`, title: KNOB_NAMES[id], onclick: () => select('knob', id) })
    $('#knobsLeft').replaceChildren(...KNOBS_LEFT.map(knob))
    $('#knobsRight').replaceChildren(...KNOBS_RIGHT.map(knob))
    document.querySelectorAll('.strip').forEach(s => {
        s.onclick = ev => {
            const side = s.dataset.sel.split(':')[1]
            const idx = Math.min(2, Math.floor(ev.offsetY / 90))
            select('knob', (side === 'left' ? KNOBS_LEFT : KNOBS_RIGHT)[idx])
        }
    })
    $('.wheel').onclick = () => select('wheel', 'wheel')

    $('#roundButtons').replaceChildren(...Array.from({ length: 8 }, (_, i) => {
        const { def } = bindingFor('buttons', String(i))
        let color = def?.color
        if (def?.action?.type === 'page') color = color || config.pages.find(p => p.id === def.action.page)?.color
        return h('div', {
            class: 'round-btn' + (isSel('button', i) ? ' selected' : ''), 'data-sel': `button:${i}`,
            style: color ? `background:${color}; box-shadow: 0 0 10px ${color}88` : '',
            title: def?.label || `Round button ${i + 1}`, onclick: () => select('button', i),
        }, String(i + 1))
    }))
    const sq = id => {
        const { def } = bindingFor('buttons', id)
        return h('div', { class: 'sq-btn' + (def ? ' bound' : '') + (isSel('button', id) ? ' selected' : ''), 'data-sel': `button:${id}`, onclick: () => select('button', id), title: SQUARE_NAMES[id] },
            def?.label || SQUARE_NAMES[id])
    }
    $('#squareLeft').replaceChildren(...SQUARE_LEFT.map(sq))
    $('#squareRight').replaceChildren(...SQUARE_RIGHT.map(sq))
}

function flash(sel) {
    const el = document.querySelector(`[data-sel="${sel}"]`)
    if (!el) return
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash')
}

// ---- Pages ------------------------------------------------------------------

function renderPages() {
    const livePage = status?.page
    $('#pageList').replaceChildren(...config.pages.map(p => h('span', {
        class: 'page-chip' + (p.id === currentPageId ? ' active' : '') + (p.id === livePage ? ' live' : ''),
        onclick: () => { currentPageId = p.id; selected = null; renderAll(); api('POST', '/api/page', { page: p.id }).catch(() => {}) },
    }, h('span', { class: 'dot', style: `background:${p.color || '#38bdf8'}` }), p.name || p.id)))

    const p = page()
    const idx = config.pages.indexOf(p)
    $('#pageMeta').replaceChildren(
        h('h4', {}, 'Page settings'),
        h('div', { class: 'row' },
            h('label', {}, 'Name', h('input', { value: p.name || '', oninput: e => mutate(() => { p.name = e.target.value }) })),
            h('label', { class: 'shrink' }, 'Color', h('input', { type: 'color', value: p.color || '#38bdf8', oninput: e => mutate(() => { p.color = e.target.value }) })),
        ),
        h('div', { class: 'btn-row' },
            h('button', { class: 'outline secondary', disabled: idx === 0, onclick: () => mutate(c => { c.pages.splice(idx, 1); c.pages.splice(idx - 1, 0, p) }, {}) || renderAll() }, '◀ Move left'),
            h('button', { class: 'outline secondary', disabled: idx === config.pages.length - 1, onclick: () => mutate(c => { c.pages.splice(idx, 1); c.pages.splice(idx + 1, 0, p) }) || renderAll() }, 'Move right ▶'),
            h('button', { class: 'outline secondary', onclick: duplicatePage }, 'Duplicate'),
            h('button', { class: 'outline contrast', disabled: config.pages.length === 1, onclick: deletePage }, 'Delete page'),
        ),
        h('p', { class: 'hint' }, `Page id: ${p.id}. Keys, knobs and buttons set "for this page" override the global ones.`),
    )
}

function uniqueId(base) {
    let id = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page'
    let n = 1, out = id
    while (config.pages.some(p => p.id === out)) out = `${id}-${++n}`
    return out
}

function addPage() {
    const name = prompt('Page name?', 'New page')
    if (!name) return
    const id = uniqueId(name)
    mutate(c => c.pages.push({ id, name, color: '#14b8a6', keys: {} }))
    currentPageId = id
    renderAll()
}

function duplicatePage() {
    const p = clone(page())
    p.name = `${p.name} copy`
    p.id = uniqueId(p.name)
    mutate(c => c.pages.splice(c.pages.indexOf(page()) + 1, 0, p))
    currentPageId = p.id
    renderAll()
}

function deletePage() {
    const p = page()
    if (!confirm(`Delete page "${p.name}"? (Undo can bring it back)`)) return
    mutate(c => {
        c.pages = c.pages.filter(x => x !== p)
        c.appRules = (c.appRules || []).filter(r => r.page !== p.id)
        if (c.startPage === p.id) c.startPage = c.pages[0].id
    })
    currentPageId = config.pages[0].id
    renderAll()
}

// ---- Form builders --------------------------------------------------------------

function fieldInput(obj, [name, type, label, hint], onChange) {
    const val = obj[name]
    const set = v => { if (v === '' || v === undefined || (typeof v === 'number' && Number.isNaN(v))) delete obj[name]; else obj[name] = v; onChange() }
    let input
    if (type === 'textarea') input = h('textarea', { oninput: e => set(e.target.value) }, val ?? '')
    else if (type === 'number') input = h('input', { type: 'number', step: 'any', value: val ?? '', oninput: e => set(e.target.value === '' ? '' : Number(e.target.value)) })
    else if (type === 'checkbox') return h('label', {}, h('input', { type: 'checkbox', checked: !!val, onchange: e => set(e.target.checked || '') }), ' ', label)
    else if (type === 'list') input = h('textarea', { oninput: e => set(e.target.value.split('\n').filter(Boolean)) }, (val || []).join('\n'))
    else if (type === 'json') {
        input = h('textarea', {
            oninput: e => {
                const raw = e.target.value.trim()
                if (!raw) return set('')
                try { set(JSON.parse(raw)); e.target.setAttribute('aria-invalid', 'false') } catch {
                    if (name === 'body') set(raw)
                    else e.target.setAttribute('aria-invalid', 'true')
                }
            },
        }, val === undefined ? '' : typeof val === 'string' ? val : JSON.stringify(val, null, 2))
    } else if (type === 'page') {
        const opts = [...config.pages.map(p => [p.id, p.name]), ['next', '→ Next page'], ['prev', '← Previous page'], ['back', '↩ Last page']]
        input = h('select', { onchange: e => set(e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)))
        if (val === undefined) queueMicrotask(() => set(opts[0][0]))
    } else if (type === 'lutronZone' || type === 'lutronScene') {
        const items = type === 'lutronZone' ? lutronInfo.zones.map(z => [z.id, `${z.area ? z.area + ' · ' : ''}${z.name} (${z.type})`]) : lutronInfo.scenes.map(s => [s.id, s.name])
        if (!items.length) return h('label', {}, label, h('div', { class: 'hint' }, `Lutron bridge: ${lutronInfo.state}. Nothing to pick yet.`))
        input = h('select', { onchange: e => set(e.target.value) }, h('option', { value: '' }, '— choose —'), items.map(([v, l]) => h('option', { value: v, selected: String(val) === v }, l)))
    } else if (type.startsWith('select:')) {
        const opts = type.slice(7).split(',')
        input = h('select', { onchange: e => set(e.target.value) }, opts.map(o => h('option', { value: o, selected: o === val }, o)))
    } else input = h('input', { value: val ?? '', oninput: e => set(e.target.value) })
    return h('label', {}, label, input, hint ? h('div', { class: 'hint' }, hint) : null)
}

// Edits obj[prop] (an action object). Rerenders itself on type change.
function actionEditor(title, obj, prop, onChange, { optional = true, help } = {}) {
    const box = h('fieldset', {})
    const draw = () => {
        const action = obj[prop]
        const type = action?.type ?? ''
        const typeSel = h('select', {
            onchange: e => {
                const t = e.target.value
                if (!t) delete obj[prop]
                else {
                    obj[prop] = { type: t }
                    if (t === 'hotkey' && action?.keys) obj[prop].keys = action.keys
                }
                onChange(); draw()
            },
        }, optional ? h('option', { value: '' }, '— none —') : null,
        Object.keys(ACTION_FIELDS).filter(t => t !== 'none').map(t => h('option', { value: t, selected: t === type }, ACTION_LABELS[t] || t)))
        const fields = type ? (ACTION_FIELDS[type] || []).map(f => {
            // hotkey sequence: present as comma-separated text
            if (type === 'hotkey' && f[0] === 'keys') {
                const v = Array.isArray(action.keys) ? action.keys.join(', ') : action.keys ?? ''
                return h('label', {}, f[2], h('input', {
                    value: v, placeholder: 'ctrl+c',
                    oninput: e => { const parts = e.target.value.split(',').map(s => s.trim()).filter(Boolean); action.keys = parts.length > 1 ? parts : parts[0]; onChange() },
                }), h('div', { class: 'hint' }, f[3]))
            }
            return fieldInput(action, f, onChange)
        }) : []
        const test = type ? h('div', { class: 'btn-row' }, h('button', {
            class: 'outline secondary',
            onclick: async () => {
                try {
                    const r = await api('POST', '/api/test-action', { action: obj[prop] })
                    toast(r.ok ? 'Action ran' : `Failed: ${r.error}`, !r.ok)
                } catch (err) { toast(err.message, true) }
            },
        }, '▶ Test')) : null
        box.replaceChildren(...[h('legend', {}, title), help ? h('div', { class: 'hint' }, help) : null, typeSel, ...fields, test].filter(Boolean))
    }
    draw()
    return box
}

function widgetEditor(def, onChange) {
    const box = h('fieldset', {})
    const draw = () => {
        const w = def.widget
        const typeSel = h('select', {
            onchange: e => { if (e.target.value) def.widget = { type: e.target.value }; else delete def.widget; onChange(); draw() },
        }, h('option', { value: '' }, '— none —'), Object.keys(WIDGET_FIELDS).map(t => h('option', { value: t, selected: t === w?.type }, WIDGET_LABELS[t])))
        const fields = w ? (WIDGET_FIELDS[w.type] || []).map(f => fieldInput(w, f, onChange)) : []
        box.replaceChildren(h('legend', {}, 'Live display'), h('div', { class: 'hint' }, 'Shows live data. If it has an on/off state (mute, toggle), the active color is used when on.'), typeSel, ...fields)
    }
    draw()
    return box
}

function appearanceEditor(def, onChange, { image = true } = {}) {
    const box = h('fieldset', {}, h('legend', {}, 'Appearance'))
    box.append(
        h('div', { class: 'row' },
            fieldInput(def, ['label', 'text', 'Label'], onChange),
            fieldInput(def, ['icon', 'text', 'Icon (emoji)'], onChange),
        ),
        h('div', { class: 'row' },
            colorField(def, 'color', 'Background', onChange),
            colorField(def, 'activeColor', 'Active color', onChange),
            colorField(def, 'textColor', 'Text', onChange),
        ),
    )
    if (image) {
        const pick = h('div', { class: 'icons-pick' },
            icons.map(name => h('img', {
                src: `/icons/${encodeURIComponent(name)}`, title: name, class: def.image === name ? 'on' : '',
                onclick: () => { if (def.image === name) delete def.image; else def.image = name; onChange(); renderEditor() },
            })))
        const upload = h('input', {
            type: 'file', accept: 'image/png,image/jpeg,image/svg+xml,image/webp',
            onchange: async e => {
                const file = e.target.files[0]
                if (!file) return
                const res = await fetch(`/api/icons?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file })
                const data = await res.json()
                if (!res.ok) return toast(data.error, true)
                await loadIcons()
                def.image = data.name
                onChange(); renderEditor()
            },
        })
        box.append(h('label', {}, 'Image (overrides the emoji icon; click again to remove)'), pick, upload)
    }
    return box
}

function colorField(def, prop, label, onChange) {
    const has = !!def[prop]
    return h('label', {}, label, h('div', { class: 'row' },
        h('input', { type: 'color', value: def[prop] || '#1e293b', oninput: e => { def[prop] = e.target.value; onChange() } }),
        has ? h('button', { class: 'outline secondary shrink small-btn', title: 'Use default', onclick: () => { delete def[prop]; onChange(); renderEditor() } }, '×') : null,
    ))
}

// ---- Editor panel -------------------------------------------------------------

function renderEditor() {
    const ed = $('#editor')
    if (!selected) { ed.replaceChildren(h('p', { class: 'muted' }, 'Click a key, knob, button or the wheel to edit it. Or just press it on the device.')); return }
    const p = page()
    const changed = () => mutate(() => {})

    if (selected.kind === 'key') {
        const i = selected.id
        p.keys ||= {}
        const def = p.keys[i] ? p.keys[i] : {}
        const commit = () => { if (Object.keys(def).length) p.keys[i] = def; else delete p.keys[i]; changed() }
        ed.replaceChildren(
            h('h3', {}, `Key ${Number(i) + 1}`), h('p', { class: 'hint' }, `On page "${p.name}". Tap = action; hold ½s = long-press action.`),
            appearanceEditor(def, commit),
            widgetEditor(def, commit),
            actionEditor('Tap action', def, 'action', commit),
            actionEditor('Long-press action (optional)', def, 'longPress', commit),
            keyTools(i),
        )
        return
    }

    const section = selected.kind === 'knob' ? 'knobs' : selected.kind === 'button' ? 'buttons' : 'wheel'
    const id = selected.id
    const title = selected.kind === 'knob' ? KNOB_NAMES[id] : selected.kind === 'wheel' ? 'Jog wheel' : (/^\d$/.test(id) ? `Round button ${Number(id) + 1}` : `${SQUARE_NAMES[id]} button`)

    const get = scope => scope === 'page' ? (section === 'wheel' ? p.wheel : p[section]?.[id]) : (section === 'wheel' ? config.global?.wheel : config.global?.[section]?.[id])
    const put = (scope, def) => {
        const root = scope === 'page' ? p : (config.global ||= {})
        if (section === 'wheel') { if (def) root.wheel = def; else delete root.wheel; return }
        root[section] ||= {}
        if (def) root[section][id] = def; else delete root[section][id]
    }
    let scope = get('page') ? 'page' : 'global'
    const def = get(scope) ? get(scope) : {}
    const commit = () => { put(scope, Object.keys(def).length ? def : null); changed() }

    const scopeBox = h('div', { class: 'scope' },
        h('label', {}, h('input', { type: 'radio', name: 'scope', checked: scope === 'global', onchange: () => switchScope('global') }), 'All pages'),
        h('label', {}, h('input', { type: 'radio', name: 'scope', checked: scope === 'page', onchange: () => switchScope('page') }), `Only "${p.name}"`),
    )
    function switchScope(next) {
        if (next === scope) return
        mutate(() => {
            if (next === 'page') put('page', clone(get('global') || {}))
            else put('page', null)
        }, { rerenderEditor: true })
    }

    const parts = [h('h3', {}, title), scopeBox]
    if (section === 'buttons') {
        parts.push(
            h('fieldset', {}, h('legend', {}, 'Appearance'),
                fieldInput(def, ['label', 'text', 'Label (shown here only)'], commit),
                h('div', { class: 'row' }, colorField(def, 'color', 'LED color', commit), colorField(def, 'activeColor', 'LED when active', commit)),
                h('div', { class: 'hint' }, 'Page-switch buttons light up in the page color automatically.')),
            widgetEditor(def, commit),
            actionEditor('Press action', def, 'action', commit),
            actionEditor('Long-press action (optional)', def, 'longPress', commit),
        )
    } else {
        const rotateMode = def.rotate ? 'rotate' : (def.left || def.right) ? 'lr' : 'rotate'
        const rotBox = h('div', {})
        const drawRot = mode => {
            rotBox.replaceChildren(
                h('div', { class: 'scope' },
                    h('label', {}, h('input', { type: 'radio', name: 'rot', checked: mode === 'rotate', onchange: () => drawRot('rotate') }), 'One action, scaled by direction'),
                    h('label', {}, h('input', { type: 'radio', name: 'rot', checked: mode === 'lr', onchange: () => drawRot('lr') }), 'Separate left / right'),
                ),
                mode === 'rotate'
                    ? actionEditor('Turn', def, 'rotate', commit, { help: 'Volume, scroll and brightness follow the turn direction.' })
                    : h('div', {}, actionEditor('Turn left', def, 'left', commit), actionEditor('Turn right', def, 'right', commit)),
            )
        }
        drawRot(rotateMode)
        parts.push(
            h('fieldset', {}, h('legend', {}, 'Appearance'),
                h('div', { class: 'row' }, fieldInput(def, ['label', 'text', 'Label'], commit), fieldInput(def, ['icon', 'text', 'Icon (emoji)'], commit)),
                fieldInput(def, ['sensitivity', 'number', 'Sensitivity multiplier', 'Only for "one action" mode. 0.5 = half speed'], commit)),
            widgetEditor(def, commit),
            rotBox,
            actionEditor('Press action', def, 'press', commit),
        )
        if (section === 'wheel') parts.push(actionEditor('Touch the wheel screen (optional)', def, 'touch', commit))
    }
    if (scope === 'page') parts.push(h('div', { class: 'btn-row' }, h('button', { class: 'outline contrast', onclick: () => switchScope('global') }, 'Remove page override')))
    ed.replaceChildren(...parts)
}

let clipboard = null
function keyTools(i) {
    const p = page()
    return h('div', { class: 'btn-row' },
        h('button', { class: 'outline secondary', onclick: () => { clipboard = clone(p.keys[i] || {}); toast('Key copied') } }, 'Copy'),
        h('button', { class: 'outline secondary', disabled: !clipboard, onclick: () => mutate(() => { p.keys[i] = clone(clipboard) }, { rerenderEditor: true }) }, 'Paste'),
        h('button', { class: 'outline contrast', onclick: () => mutate(() => { delete p.keys[i] }, { rerenderEditor: true }) }, 'Clear key'),
    )
}

// ---- Other tabs -------------------------------------------------------------------

function renderApps() {
    $('#autoSwitch').checked = config.autoSwitch !== false
    const rules = config.appRules ||= []
    $('#rulesBody').replaceChildren(...rules.map((r, i) => h('tr', {},
        h('td', {}, h('input', { value: r.exe || '', placeholder: 'chrome.exe', oninput: e => mutate(() => { r.exe = e.target.value.trim().toLowerCase() || undefined }) })),
        h('td', {}, h('input', { value: r.title || '', placeholder: 'YouTube', oninput: e => mutate(() => { r.title = e.target.value || undefined }) })),
        h('td', {}, h('select', { onchange: e => mutate(() => { r.page = e.target.value }) }, config.pages.map(p => h('option', { value: p.id, selected: p.id === r.page }, p.name)))),
        h('td', {}, h('button', { class: 'outline contrast small-btn', onclick: () => { mutate(() => rules.splice(i, 1)); renderApps() } }, 'Remove')),
    )))
}

function renderSettings() {
    $('#brightness').value = config.brightness ?? 0.8
    $('#haptics').checked = config.haptics !== false
    $('#swipePages').checked = config.swipePages !== false
    $('#startPage').replaceChildren(...config.pages.map(p => h('option', { value: p.id, selected: p.id === config.startPage }, p.name)))
    const theme = config.theme ||= {}
    const names = { background: 'Screen background', key: 'Default key color', text: 'Text', accent: 'Accent', active: 'Active / alert' }
    $('#themeGrid').replaceChildren(...Object.entries(names).map(([k, label]) =>
        h('label', {}, label, h('input', { type: 'color', value: theme[k] || '#000000', oninput: e => mutate(() => { theme[k] = e.target.value }) }))))
}

function renderLutron() {
    const box = $('#lutronBox')
    const L = lutronInfo
    const msg = L.pairing?.message ? h('p', { class: L.pairing.ok === false ? 'error-text' : 'small' }, L.pairing.message) : null
    if (L.host) {
        box.replaceChildren(
            h('p', {}, `Bridge ${L.host}: `, h('strong', {}, L.state), ` · ${L.zones.length} zones, ${L.scenes.length} scenes`),
            h('p', { class: 'hint' }, 'Use the "Lutron" action and live display on any key or knob.'),
            msg,
            h('div', { class: 'btn-row' }, h('button', { class: 'outline contrast', onclick: async () => {
                if (!confirm('Forget this bridge? You will need to pair again to use Lutron controls.')) return
                await api('POST', '/api/lutron/unpair')
            } }, 'Forget bridge')),
        )
        return
    }
    const ip = h('input', { placeholder: 'Bridge IP, e.g. 192.168.1.50', value: box.dataset.ip || '' })
    const busy = !!L.pairing?.active
    box.replaceChildren(
        h('p', { class: 'muted' }, 'Control Lutron Caseta / RadioRA 3 / HomeWorks QSX lights, shades and fans. Pairing adds this app to the bridge; your existing devices and integrations are not affected.'),
        h('div', { class: 'row' }, ip,
            h('button', { class: 'outline secondary shrink', disabled: busy, onclick: async e => {
                e.target.textContent = 'Searching…'; e.target.disabled = true
                try {
                    const { bridges } = await api('POST', '/api/lutron/discover')
                    if (bridges.length) { ip.value = bridges[0].ip; box.dataset.ip = ip.value; toast(`Found ${bridges.map(b => b.ip).join(', ')}`) }
                    else toast('No bridge found. Enter its IP address (check your router or the Lutron app).', true)
                } finally { e.target.textContent = 'Find bridge'; e.target.disabled = false }
            } }, 'Find bridge'),
            h('button', { class: 'shrink', disabled: busy, onclick: async () => {
                box.dataset.ip = ip.value.trim()
                try { await api('POST', '/api/lutron/pair', { host: ip.value.trim() }) } catch (err) { toast(err.message, true) }
            } }, 'Pair'),
        ),
        msg,
        h('p', { class: 'hint' }, 'After clicking Pair, give the small button on the back of the bridge a quick tap. Do not hold it: holding it for ~15 seconds factory-resets the bridge.'),
    )
}

function renderJson() { $('#jsonText').value = JSON.stringify(config, null, 2) }

function renderAll() {
    if (!config.pages.some(p => p.id === currentPageId)) currentPageId = config.pages[0].id
    renderPages(); renderDevice(); renderEditor(); renderApps(); renderSettings(); renderLutron(); renderJson()
}

async function loadIcons() { icons = (await api('GET', '/api/icons')).icons }

// ---- Live connection ------------------------------------------------------------------

function setStatus(s) {
    status = s
    const st = s.device.state
    const pill = $('#status')
    pill.className = `pill ${st}`
    pill.textContent = st === 'connected' ? `Connected · fw ${s.device.info?.version}` : st === 'searching' ? 'Searching for device…' : st
    $('#fg').textContent = s.foreground ? `Focused: ${s.foreground.exe}${s.autoPage ? ` → ${s.autoPage}` : ''}` : ''
    $('#fgNow').textContent = s.foreground?.exe || '-'
    $('#statusJson').textContent = JSON.stringify(s, null, 2)
    if (config) renderPages()
}

function appendLog(el, line) {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 10
    el.textContent += line + '\n'
    if (el.textContent.length > 60000) el.textContent = el.textContent.slice(-40000)
    if (atBottom) el.scrollTop = el.scrollHeight
}

function onDeviceInput(d) {
    const t = d.touch
    appendLog($('#inputLog'), `${new Date().toLocaleTimeString()}  ${d.ev}  ${d.id ?? ''}${d.delta ? ` Δ${d.delta}` : ''}${t ? ` (${t.x},${t.y}) ${t.target?.screen ?? ''}${t.target?.key !== undefined ? ` key ${t.target.key}` : ''}` : ''}`)
    let sel = null
    if ((d.ev === 'down' || d.ev === 'rotate') && d.id !== undefined) {
        const id = String(d.id)
        if (id === 'knobCT') sel = ['wheel', 'wheel']
        else if (id.startsWith('knob')) sel = ['knob', id]
        else sel = ['button', id]
    } else if (d.ev === 'touchstart' && t?.target) {
        if (t.target.key !== undefined && t.target.screen === 'center') sel = ['key', t.target.key]
        else if (t.target.screen === 'knob') sel = ['wheel', 'wheel']
    }
    if (!sel) return
    const [kind, id] = sel
    flash(kind === 'wheel' ? 'wheel' : `${kind}:${id}`)
    if ($('#follow').checked && $('[data-panel=layout]').hidden === false && !isSel(kind, id)) {
        if (status?.page && status.page !== currentPageId) currentPageId = status.page
        select(kind, id)
        renderPages()
    }
}

function connectWs() {
    const ws = new WebSocket(`ws://${location.host}/ws`)
    ws.onmessage = async ev => {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'status') setStatus(msg.data)
        else if (msg.type === 'input') onDeviceInput(msg.data)
        else if (msg.type === 'lutron') { lutronInfo = msg.data; renderLutron() }
        else if (msg.type === 'log') appendLog($('#daemonLog'), `${new Date(msg.data.ts).toLocaleTimeString()} [${msg.data.level}] ${msg.data.msg}`)
        else if (msg.type === 'page') {
            if (status) status.page = msg.data
            if ($('#follow').checked) { currentPageId = msg.data; selected = null; renderAll() } else renderPages()
        } else if (msg.type === 'config') {
            // Reload if changed outside this tab (file edit / other tab)
            const fresh = await api('GET', '/api/config')
            if (JSON.stringify(fresh) !== JSON.stringify(config) && !saveTimer) { config = fresh; renderAll() }
        }
    }
    ws.onclose = () => {
        const pill = $('#status')
        pill.className = 'pill'
        pill.textContent = 'Daemon offline, retrying…'
        setTimeout(connectWs, 2000)
    }
}

// ---- Init -------------------------------------------------------------------------

async function init() {
    config = await api('GET', '/api/config')
    const s = await api('GET', '/api/status')
    currentPageId = s.page
    setStatus(s)
    await loadIcons()
    lutronInfo = await api('GET', '/api/lutron').catch(() => lutronInfo)
    renderAll()
    connectWs()

    $('#tabs').onclick = e => {
        const tab = e.target.dataset.tab
        if (!tab) return
        document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b === e.target))
        document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab })
        if (tab === 'json') renderJson()
        if (tab === 'log') api('GET', '/api/logs').then(r => { $('#daemonLog').textContent = r.lines.join('\n') + '\n'; $('#daemonLog').scrollTop = 1e9 })
    }
    $('#addPage').onclick = addPage
    $('#undoBtn').onclick = undo
    $('#reconnectBtn').onclick = () => api('POST', '/api/reconnect').then(() => toast('Reconnecting…'))
    document.addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === 'z' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); undo() }
    })
    $('#autoSwitch').onchange = e => mutate(() => { config.autoSwitch = e.target.checked })
    $('#addRule').onclick = () => { mutate(c => (c.appRules ||= []).push({ exe: '', page: currentPageId })); renderApps() }
    $('#addFromFg').onclick = () => {
        const exe = status?.foreground?.exe
        if (!exe) return toast('No focused app detected yet', true)
        mutate(c => (c.appRules ||= []).push({ exe, page: currentPageId }))
        renderApps()
    }
    $('#brightness').oninput = e => mutate(() => { config.brightness = Number(e.target.value) })
    $('#haptics').onchange = e => mutate(() => { config.haptics = e.target.checked })
    $('#swipePages').onchange = e => mutate(() => { config.swipePages = e.target.checked })
    $('#startPage').onchange = e => mutate(() => { config.startPage = e.target.value })
    $('#jsonSave').onclick = () => {
        try {
            const next = JSON.parse($('#jsonText').value)
            mutate(() => { config = next })
            renderAll()
        } catch (err) { toast(`Invalid JSON: ${err.message}`, true) }
    }
}

init().catch(err => toast(`Failed to load: ${err.message}`, true))
