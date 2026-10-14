'use strict'
// Sends printer bytes to a network printer's raw port (9100 by default) over TCP, and turns network
// errors into plain reasons a restaurant owner can act on (at most 200 characters, as the device
// report allows).
const net = require('node:net')

const CONNECT_TIMEOUT_MS = 5000
const TOTAL_TIMEOUT_MS = 15000
// After the last byte is handed over, wait this long for the printer to close its side.
const CLOSE_GRACE_MS = 1500
const REASON_MAX = 200

class PrintError extends Error {
  constructor(reason, code) {
    super(reason)
    this.name = 'PrintError'
    this.reason = reason
    this.code = code
  }
}

const clip = s => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s)

/** A plain reason for a failed send. `stage` is 'connect' or 'send'. */
function plainReason(code, host, port, stage) {
  const p = `Printer ${host}`
  switch (code) {
    case 'ECONNREFUSED':
      return clip(`${p} refused the connection on port ${port} — check the port in POS Setup → Printers, or switch the printer off and on`)
    case 'CONNECT_TIMEOUT':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'EHOSTDOWN':
      return clip(`${p} did not answer — check it is switched on and plugged into the router`)
    case 'ENETUNREACH':
    case 'ENETDOWN':
    case 'EADDRNOTAVAIL':
      return clip(`This computer is not on the printer's network (${host}) — check this computer's network cable or Wi-Fi`)
    case 'SEND_TIMEOUT':
      return clip(`${p} stopped taking the ticket — check it has paper and the cover is closed`)
    case 'ECONNRESET':
    case 'EPIPE':
    case 'ECONNABORTED':
      return clip(stage === 'connect'
        ? `${p} dropped the connection — switch the printer off and on`
        : `${p} dropped the connection while printing — check it has paper and the cover is closed`)
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return clip(`Printer address ${host} was not found — check the address in POS Setup → Printers`)
    case 'BAD_ADDRESS':
      return clip(`The printer address "${host}" or port "${port}" is not valid — check it in POS Setup → Printers`)
    default:
      return clip(`${p} could not be reached (${code || 'unknown error'}) — check it is switched on and plugged into the router`)
  }
}

/**
 * Send bytes to host:port. Resolves when every byte has been handed to the network and the printer
 * closed its side (or a short grace passed); rejects with a PrintError carrying a plain reason.
 * An error after every byte went out is logged by the caller but counted as printed, because the
 * printer already has the whole ticket and a retry would print it twice.
 */
function sendToPrinter({ host, port = 9100, data, connectTimeoutMs = CONNECT_TIMEOUT_MS, totalTimeoutMs = TOTAL_TIMEOUT_MS, closeGraceMs = CLOSE_GRACE_MS, createSocket = () => new net.Socket(), onLateError }) {
  return new Promise((resolve, reject) => {
    const portNum = Number(port)
    if (typeof host !== 'string' || !host || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      reject(new PrintError(plainReason('BAD_ADDRESS', host, port, 'connect'), 'BAD_ADDRESS'))
      return
    }
    const sock = createSocket()
    let connected = false
    let flushed = false
    let settled = false
    let graceTimer = null
    const timers = []
    const settle = (err) => {
      if (settled) return
      settled = true
      for (const t of timers) clearTimeout(t)
      if (graceTimer) clearTimeout(graceTimer)
      try { sock.destroy() } catch { /* already gone */ }
      if (err) reject(err)
      else resolve()
    }
    const fail = code => settle(new PrintError(plainReason(code, host, portNum, connected ? 'send' : 'connect'), code))

    timers.push(setTimeout(() => { if (!connected) fail('CONNECT_TIMEOUT') }, connectTimeoutMs))
    timers.push(setTimeout(() => {
      if (!connected) fail('CONNECT_TIMEOUT')
      else if (flushed) settle(null)
      else fail('SEND_TIMEOUT')
    }, totalTimeoutMs))

    sock.on('error', (e) => {
      if (flushed) { if (onLateError) onLateError(e); settle(null); return }
      fail(e && e.code ? e.code : 'UNKNOWN')
    })
    sock.on('data', () => { /* printers may send status bytes; ignore them */ })
    sock.once('connect', () => {
      connected = true
      if (typeof sock.setNoDelay === 'function') sock.setNoDelay(true)
      sock.end(data)
    })
    sock.once('finish', () => {
      flushed = true
      graceTimer = setTimeout(() => settle(null), closeGraceMs)
    })
    sock.once('close', () => {
      if (flushed) settle(null)
      else if (!settled) fail(connected ? 'ECONNRESET' : 'ECONNREFUSED')
    })
    sock.connect({ host, port: portNum })
  })
}

/** Connect and close at once, to see whether a printer is there. Resolves { ok, error }. */
function probePrinter({ host, port = 9100, timeoutMs = 3000, createSocket = () => new net.Socket() }) {
  return new Promise((resolve) => {
    const portNum = Number(port)
    if (typeof host !== 'string' || !host || !Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      resolve({ ok: false, error: plainReason('BAD_ADDRESS', host, port, 'connect') })
      return
    }
    const sock = createSocket()
    let done = false
    const finish = (r) => { if (done) return; done = true; clearTimeout(t); try { sock.destroy() } catch { /* gone */ } resolve(r) }
    const t = setTimeout(() => finish({ ok: false, error: plainReason('CONNECT_TIMEOUT', host, portNum, 'connect') }), timeoutMs)
    sock.on('error', e => finish({ ok: false, error: plainReason(e && e.code, host, portNum, 'connect') }))
    sock.once('connect', () => { sock.end(); finish({ ok: true, error: null }) })
    sock.connect({ host, port: portNum })
  })
}

module.exports = { sendToPrinter, probePrinter, plainReason, PrintError, REASON_MAX }
