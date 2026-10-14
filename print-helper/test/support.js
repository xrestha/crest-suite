'use strict'
// Test helpers: a printer that captures bytes, a free port with nothing behind it, a temporary
// helper home, and a mock Crest implementing the three print-device functions of the contract.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const http = require('node:http')
const crypto = require('node:crypto')

function tmpDir(prefix = 'crest-helper-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A fake network printer: collects every connection's bytes. */
async function captureServer() {
  const prints = []
  const probes = []
  const sockets = new Set()
  const server = net.createServer((sock) => {
    sockets.add(sock)
    const chunks = []
    sock.on('data', c => chunks.push(c))
    // A connection that sends nothing is the helper checking the printer is there, not a print.
    sock.on('end', () => { const b = Buffer.concat(chunks); if (b.length) prints.push(b); else probes.push(Date.now()); sock.end() })
    sock.on('error', () => {})
    sock.on('close', () => sockets.delete(sock))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port,
    prints,
    probes,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()) }),
  }
}

/** A port on 127.0.0.1 that nothing listens on (connections are refused). */
async function closedPort() {
  const s = net.createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise(r => s.close(r))
  return port
}

async function waitFor(cond, { timeout = 10000, every = 10, what = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const v = await cond()
    if (v) return v
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, every))
  }
}

const ANON_KEY = 'test-anon-key'

/**
 * A mock Crest. `codes` maps a normalised pair code to 'helper' | 'page' (wrong kind). Jobs pushed
 * to `queue` are handed out (claimed) by the next poll. Set `failReports` to make that many report
 * calls answer HTTP 503, `paused` to answer polls with paused, or call deactivate().
 */
async function mockCrest({ codes = {}, device = {}, clientName = 'Himalayan Kitchen' } = {}) {
  const state = {
    codes: { ...codes },
    device: { id: crypto.randomUUID(), name: 'Counter PC', kind: 'helper', stations: ['KOT'], printers: [], ...device },
    secret: null,
    active: false,
    paused: false,
    queue: [],
    failReports: 0,
    calls: [],
    printed: [],
    failed: [],
    clientName,
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const fn = req.url.replace(/^\/rest\/v1\/rpc\//, '')
      let params = null
      try { params = JSON.parse(body) } catch { params = null }
      const auth = req.headers.apikey === ANON_KEY && req.headers.authorization === `Bearer ${ANON_KEY}` && /application\/json/.test(req.headers['content-type'] || '')
      state.calls.push({ fn, params, auth })
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
      if (req.method !== 'POST' || !auth) return send(401, { message: 'bad request headers' })
      if (fn === 'pos_print_device_pair') {
        const code = String(params.p_code || '').replace(/[\s-]/g, '').toUpperCase()
        const kind = state.codes[code]
        if (!kind) return send(200, { ok: false, code: 'pair_code_invalid', message: 'That pairing code is not valid' })
        if (kind !== params.p_info?.kind) return send(200, { ok: false, code: 'wrong_kind', message: 'That code is for another kind of device' })
        delete state.codes[code]
        state.secret = crypto.randomBytes(16).toString('hex')
        state.active = true
        return send(200, { ok: true, device_id: state.device.id, secret: state.secret, device_name: state.device.name, kind: 'helper', client_name: state.clientName })
      }
      if (fn === 'pos_print_device_poll') {
        if (!state.active || params.p_device_id !== state.device.id || params.p_secret !== state.secret) return send(200, { ok: false, code: 'device_not_active', message: 'This device was removed' })
        if (state.paused) return send(200, { ok: true, paused: 'pos_off', jobs: [] })
        const jobs = state.queue.splice(0, 10)
        return send(200, { ok: true, device: { id: state.device.id, name: state.device.name, kind: 'helper', stations: state.device.stations, printers: state.device.printers }, client_name: state.clientName, server_time: new Date().toISOString(), jobs })
      }
      if (fn === 'pos_print_device_report') {
        if (state.failReports > 0) { state.failReports -= 1; return send(503, { message: 'temporarily unavailable' }) }
        if (!state.active || params.p_device_id !== state.device.id || params.p_secret !== state.secret) return send(200, { ok: false, code: 'device_not_active', message: 'This device was removed' })
        state.printed.push(...(params.p_printed || []))
        state.failed.push(...(params.p_failed || []))
        return send(200, { ok: true })
      }
      return send(404, { message: 'no such function' })
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    key: ANON_KEY,
    pairDirect() {
      state.secret = crypto.randomBytes(16).toString('hex')
      state.active = true
      return { deviceId: state.device.id, secret: state.secret, deviceName: state.device.name, clientName: state.clientName }
    },
    deactivate() { state.active = false },
    callsOf: fn => state.calls.filter(c => c.fn === `pos_print_device_${fn}`),
    close: () => new Promise(r => server.close(() => r())),
  }
}

let jobSeq = 0
function job(over = {}) {
  jobSeq += 1
  return {
    id: crypto.randomUUID(),
    station: 'KOT',
    kind: 'ticket',
    label: `Table ${jobSeq} · #${20 + jobSeq}`,
    created_at: new Date().toISOString(),
    late: false,
    doc: { v: 1, title: 'KOT', lines: [{ k: 'text', t: 'KITCHEN ORDER TICKET', align: 'center', bold: true, size: 'lg' }, { k: 'hr' }, { k: 'row', l: 'VEG MOMO', r: '×2', lBold: true, rBold: true, rSize: 'md' }] },
    ...over,
  }
}

module.exports = { tmpDir, captureServer, closedPort, waitFor, mockCrest, job, ANON_KEY }
