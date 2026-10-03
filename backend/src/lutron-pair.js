// Lutron LEAP bridge discovery + one-time pairing.
// Used by the web UI (Settings -> Lutron) and from the command line:
//   node src/lutron-pair.js [bridge-ip]     (omit the IP to auto-discover)
// Pairing needs a short TAP of the button on the back of the bridge (do not
// hold it: ~15 s held is a factory reset). Saves data/lutron.json.
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import forge from 'node-forge'
import leap from 'lutron-leap'
import { DATA_DIR } from './paths.js'

export const CRED_FILE = path.join(DATA_DIR, 'lutron.json')
const WINDOW_MS = 3 * 60 * 1000

// Find bridges: mDNS first, then a quick scan of local /24 subnets for hosts
// with both LEAP ports open (mDNS is often blocked on Windows).
export async function discoverBridges(ms = 5000) {
    const viaMdns = await mdnsBridges(ms)
    return viaMdns.length ? viaMdns : scanBridges()
}

const portOpen = (host, port) => new Promise(resolve => {
    const s = net.connect({ host, port, timeout: 700 })
    s.on('connect', () => { s.destroy(); resolve(true) })
    s.on('timeout', () => { s.destroy(); resolve(false) })
    s.on('error', () => resolve(false))
})

export async function scanBridges() {
    const prefixes = new Set()
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family === 'IPv4' && !a.internal && /^(192\.168|10)\./.test(a.address) && a.netmask === '255.255.255.0') {
                prefixes.add(a.address.split('.').slice(0, 3).join('.'))
            }
        }
    }
    const found = []
    for (const prefix of prefixes) {
        await Promise.all(Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`).map(async ip => {
            if (await portOpen(ip, 8083) && await portOpen(ip, 8081)) found.push({ id: ip, ip, type: 'LEAP bridge' })
        }))
    }
    return found
}

function mdnsBridges(ms) {
    return new Promise(resolve => {
        const found = new Map()
        const finder = new leap.BridgeFinder()
        finder.on('discovered', info => found.set(info.bridgeid, { id: info.bridgeid, ip: info.ipAddr, type: info.systype }))
        finder.on('failed', () => {})
        finder.beginSearching()
        setTimeout(() => { finder.destroy(); resolve([...found.values()]) }, ms)
    })
}

// Resolves once paired; onStatus(text) reports progress
export async function pairBridge(host, onStatus = () => {}) {
    onStatus('Generating key…')
    const keys = await new Promise((res, rej) => forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, k) => (err ? rej(err) : res(k))))
    const csr = forge.pki.createCertificationRequest()
    csr.publicKey = keys.publicKey
    csr.setSubject([{ name: 'commonName', value: 'loupedeck-ct' }])
    csr.sign(keys.privateKey)

    const client = new leap.PairingClient(host, 8083)
    await client.connect()
    onStatus('Tap the button on the back of the Lutron bridge now (a quick tap, do not hold).')

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for the bridge button (3 minutes)')), WINDOW_MS)
        client.on('message', async msg => {
            if (msg?.Body?.Status?.Permissions?.includes('PhysicalAccess')) {
                onStatus('Button press detected, requesting certificate…')
                await client.requestPair(forge.pki.certificationRequestToPem(csr))
            } else if (msg?.Body?.SigningResult) {
                clearTimeout(timer)
                const { Certificate, RootCertificate } = msg.Body.SigningResult
                fs.mkdirSync(DATA_DIR, { recursive: true })
                fs.writeFileSync(CRED_FILE, JSON.stringify({ host, ca: RootCertificate, cert: Certificate, key: forge.pki.privateKeyToPem(keys.privateKey) }, null, 2))
                onStatus('Paired.')
                resolve({ host })
            } else if (msg?.Body?.Exception) {
                onStatus(`Bridge refused: ${msg.Body.Exception.Message}`)
            }
        })
    })
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    let host = process.argv[2]
    if (!host) {
        console.log('Searching for Lutron bridges…')
        const bridges = await discoverBridges()
        if (!bridges.length) { console.error('No bridge found. Pass its IP: node src/lutron-pair.js <ip>'); process.exit(1) }
        host = bridges[0].ip
        console.log(`Found ${bridges.map(b => `${b.ip} (${b.type ?? 'bridge'})`).join(', ')}; using ${host}`)
    }
    try {
        await pairBridge(host, s => console.log(s))
        console.log(`Saved ${CRED_FILE}. Restart the daemon (development/restart.ps1).`)
        process.exit(0)
    } catch (err) {
        console.error(err.message)
        process.exit(1)
    }
}
