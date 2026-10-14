'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const { EventEmitter } = require('node:events')
const { sendToPrinter, probePrinter, plainReason, PrintError } = require('../src/printer')
const { captureServer, closedPort } = require('./support')

test('sends every byte to the printer and resolves', async () => {
  const printer = await captureServer()
  try {
    const data = Buffer.alloc(200 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xFF
    await sendToPrinter({ host: '127.0.0.1', port: printer.port, data })
    assert.equal(printer.prints.length, 1)
    assert.ok(printer.prints[0].equals(data))
  } finally { await printer.close() }
})

test('a printer that keeps the connection open still counts as printed after a short grace', async () => {
  const got = []
  const server = net.createServer((s) => { s.on('data', c => got.push(c)); s.on('error', () => {}) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    const t0 = Date.now()
    await sendToPrinter({ host: '127.0.0.1', port: server.address().port, data: Buffer.from('hello'), closeGraceMs: 200 })
    assert.ok(Date.now() - t0 < 2000)
    assert.equal(Buffer.concat(got).toString(), 'hello')
  } finally { server.close() }
})

test('a refused connection gives a plain reason', async () => {
  const port = await closedPort()
  await assert.rejects(sendToPrinter({ host: '127.0.0.1', port, data: Buffer.from('x') }), (e) => {
    assert.ok(e instanceof PrintError)
    assert.equal(e.code, 'ECONNREFUSED')
    assert.match(e.reason, /^Printer 127\.0\.0\.1 refused the connection on port \d+ — /)
    return true
  })
})

test('a printer that never answers times out with "did not answer"', async () => {
  const fake = new EventEmitter()
  fake.connect = () => {}
  fake.destroy = () => {}
  const t0 = Date.now()
  await assert.rejects(sendToPrinter({ host: '192.168.1.50', port: 9100, data: Buffer.from('x'), connectTimeoutMs: 150, createSocket: () => fake }), (e) => {
    assert.equal(e.code, 'CONNECT_TIMEOUT')
    assert.equal(e.reason, 'Printer 192.168.1.50 did not answer — check it is switched on and plugged into the router')
    return true
  })
  assert.ok(Date.now() - t0 < 1000)
})

test('a printer that stops taking bytes fails with "stopped taking the ticket"', async () => {
  const server = net.createServer((s) => { s.pause(); s.on('error', () => {}) })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    await assert.rejects(sendToPrinter({ host: '127.0.0.1', port: server.address().port, data: Buffer.alloc(48 * 1024 * 1024), totalTimeoutMs: 600 }), (e) => {
      assert.equal(e.code, 'SEND_TIMEOUT')
      assert.match(e.reason, /stopped taking the ticket — check it has paper and the cover is closed/)
      return true
    })
  } finally { server.close() }
})

test('a bad address is refused before connecting', async () => {
  await assert.rejects(sendToPrinter({ host: '', port: 9100, data: Buffer.from('x') }), e => e.code === 'BAD_ADDRESS')
  await assert.rejects(sendToPrinter({ host: '10.0.0.5', port: 70000, data: Buffer.from('x') }), e => e.code === 'BAD_ADDRESS')
})

test('every error code maps to a plain reason of at most 200 characters', () => {
  const host = '192.168.100.200'
  const cases = {
    EHOSTUNREACH: /did not answer/,
    ETIMEDOUT: /did not answer/,
    ENETUNREACH: /not on the printer's network/,
    ECONNRESET: /dropped the connection/,
    ENOTFOUND: /was not found/,
    WEIRD: /could not be reached \(WEIRD\)/,
  }
  for (const [code, re] of Object.entries(cases)) {
    const r = plainReason(code, host, 9100, 'send')
    assert.match(r, re)
    assert.ok(r.length <= 200, `${code} reason is ${r.length} characters`)
  }
  assert.ok(plainReason('ECONNREFUSED', 'x'.repeat(300), 9100, 'connect').length <= 200)
})

test('probe: ok for a listening printer, a reason for a closed port', async () => {
  const printer = await captureServer()
  try {
    assert.deepEqual(await probePrinter({ host: '127.0.0.1', port: printer.port }), { ok: true, error: null })
  } finally { await printer.close() }
  const r = await probePrinter({ host: '127.0.0.1', port: await closedPort() })
  assert.equal(r.ok, false)
  assert.match(r.error, /refused the connection/)
})
