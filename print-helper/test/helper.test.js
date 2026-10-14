'use strict'
// The whole poll → print → report loop against a mock Crest and a capturing printer.
const test = require('node:test')
const assert = require('node:assert/strict')
const { FontSet } = require('../src/fonts')
const { renderDoc } = require('../src/render')
const { buildEscPos } = require('../src/escpos')
const { sendToPrinter, probePrinter } = require('../src/printer')
const { createApi } = require('../src/api')
const { Store } = require('../src/store')
const { ConsoleUi } = require('../src/ui')
const { Helper, PAIR_MESSAGES, REMOVED_MESSAGE, OFFLINE_MESSAGE, PAUSED_MESSAGE } = require('../src/helper')
const { tmpDir, captureServer, closedPort, waitFor, mockCrest, job } = require('./support')

let fonts
test.before(async () => { fonts = await FontSet.load() })

/** A helper wired to the mock, with instant sleeps and scripted pairing answers. */
function makeHelper(crest, { answers = [], url, store = new Store(tmpDir()) } = {}) {
  const screen = []
  const sleeps = []
  const docs = []
  const queue = [...answers]
  const asked = []
  const h = new Helper({
    api: createApi({ url: url || crest.url, key: crest.key, timeoutMs: 3000 }),
    store,
    ui: new ConsoleUi({ write: (s) => { screen.push(s.replace(/^\d\d:\d\d {2}/, '').trimEnd()) } }),
    fonts,
    ask: async (prompt) => {
      asked.push(prompt)
      if (queue.length) return queue.shift()
      // Out of answers: wait until the test stops the helper.
      await waitFor(() => h.stopped, { timeout: 30000, what: 'stop' })
      return null
    },
    sleep: async (ms) => { sleeps.push(ms); await new Promise(r => setTimeout(r, 5)) },
    send: opts => sendToPrinter({ ...opts, connectTimeoutMs: 1000, closeGraceMs: 300 }),
    probe: opts => probePrinter({ ...opts, timeoutMs: 1000 }),
    render: (doc, width) => { docs.push({ doc, width }); return buildEscPos(renderDoc(doc, fonts, width)) },
  })
  const running = h.run()
  return { h, screen, sleeps, docs, asked, store, running, stop: async () => { h.stop(); return running } }
}

const said = (screen, re) => screen.some(l => (typeof re === 'string' ? l.includes(re) : re.test(l)))

test('pairing: a malformed code, a wrong code and a page code are refused in plain words, then a good code pairs', async () => {
  const crest = await mockCrest({ codes: { GOOD2345: 'helper', PAGE2345: 'page' } })
  const t = makeHelper(crest, { answers: ['abc', 'WRNG-CODE', 'page-2345', ' good 2345 '] })
  try {
    await waitFor(() => t.store.loadConfig(), { what: 'pairing saved' })
    const cfg = t.store.loadConfig()
    assert.equal(cfg.deviceId, crest.state.device.id)
    assert.equal(cfg.secret, crest.state.secret)
    assert.equal(cfg.deviceName, 'Counter PC')
    assert.equal(cfg.clientName, 'Himalayan Kitchen')
    assert.ok(said(t.screen, 'A pairing code has 8 letters and numbers'))
    assert.ok(said(t.screen, PAIR_MESSAGES.pair_code_invalid))
    assert.ok(said(t.screen, PAIR_MESSAGES.wrong_kind))
    assert.ok(said(t.screen, 'Paired: this helper is "Counter PC" for Himalayan Kitchen.'))
    const pairs = crest.callsOf('pair')
    assert.equal(pairs.length, 3, 'the malformed code never reached Crest')
    for (const c of pairs) {
      assert.ok(c.auth, 'apikey and bearer headers are sent')
      assert.deepEqual(c.params.p_info, { kind: 'helper', app_version: '1.0.0' })
    }
    assert.equal(pairs[2].params.p_code, 'GOOD2345')
    await waitFor(() => crest.callsOf('poll').length > 0, { what: 'first poll' })
    assert.equal(crest.callsOf('poll')[0].params.p_info.app_version, '1.0.0')
    await waitFor(() => said(t.screen, 'Connected to Crest — outlet: Himalayan Kitchen, this helper: Counter PC'), { what: 'connected line' })
  } finally { await t.stop(); await crest.close() }
})

test('a job is printed on its station printer and reported printed', async () => {
  const printer = await captureServer()
  const crest = await mockCrest({ codes: { GOOD2345: 'helper' }, device: { printers: [{ station: 'KOT', host: '127.0.0.1', port: printer.port, width: 80 }] } })
  const t = makeHelper(crest, { answers: ['GOOD-2345'] })
  try {
    await waitFor(() => crest.callsOf('poll').length > 0)
    const j = job()
    crest.state.queue.push(j)
    await waitFor(() => crest.state.printed.includes(j.id), { what: 'report' })
    assert.equal(printer.prints.length, 1)
    const bytes = printer.prints[0]
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1B, 0x40])
    assert.deepEqual([...bytes.subarray(-4)], [0x1D, 0x56, 66, 0])
    assert.equal(bytes[2], 0x1D); assert.equal(bytes[3], 0x76)
    assert.equal(bytes[6], 72, '80 mm paper is 72 bytes a row')
    assert.deepEqual(crest.state.failed, [])
    assert.ok(said(t.screen, `Printed kitchen ticket "${j.label}"`))
    await waitFor(() => crest.callsOf('poll').some(c => c.params.p_info.printers.some(p => p.station === 'KOT' && p.ok === true && p.error === null)), { what: 'printer status ok' })
  } finally { await t.stop(); await crest.close(); await printer.close() }
})

test('a printer that is down: the job is reported failed with a plain reason, and the status says so', async () => {
  const down = await closedPort()
  const crest = await mockCrest({ device: { stations: ['KOT', 'BOT'], printers: [{ station: 'BOT', host: '127.0.0.1', port: down, width: 58 }] } })
  const store = new Store(tmpDir())
  store.saveConfig(crest.pairDirect())
  const t = makeHelper(crest, { store })
  try {
    await waitFor(() => crest.callsOf('poll').length > 0)
    const bar = job({ station: 'BOT', label: 'Table 2 · #7' })
    const noPrinter = job({ station: 'KOT', label: 'Table 3 · #8' })
    crest.state.queue.push(bar, noPrinter)
    await waitFor(() => crest.state.failed.length === 2, { what: 'failed report' })
    const byId = Object.fromEntries(crest.state.failed.map(f => [f.id, f.reason]))
    assert.match(byId[bar.id], /^Printer 127\.0\.0\.1 refused the connection on port \d+ — /)
    assert.match(byId[noPrinter.id], /^No printer is set for kitchen printer tickets \(KOT\) on this helper/)
    for (const r of Object.values(byId)) assert.ok(r.length <= 200)
    assert.deepEqual(crest.state.printed, [])
    await waitFor(() => {
      const last = crest.callsOf('poll').at(-1).params.p_info.printers
      const bot = last.find(p => p.station === 'BOT')
      return bot && bot.ok === false && /refused/.test(bot.error)
    }, { what: 'BOT status not ok' })
    const kot = crest.callsOf('poll').at(-1).params.p_info.printers.find(p => p.station === 'KOT')
    assert.equal(kot.ok, false)
    assert.ok(said(t.screen, /Bar printer 127\.0\.0\.1: NOT WORKING — Printer 127\.0\.0\.1 refused/))
    assert.ok(said(t.screen, `Could not print bar ticket "Table 2 · #7"`))
  } finally { await t.stop(); await crest.close() }
})

test('a report that failed is retried before the next poll, and the job is not printed twice', async () => {
  const printer = await captureServer()
  const crest = await mockCrest({ device: { printers: [{ station: 'KOT', host: '127.0.0.1', port: printer.port, width: 80 }] } })
  const store = new Store(tmpDir())
  store.saveConfig(crest.pairDirect())
  const t = makeHelper(crest, { store })
  try {
    await waitFor(() => crest.callsOf('poll').length > 0)
    crest.state.failReports = 2
    const j = job()
    crest.state.queue.push(j)
    await waitFor(() => crest.state.printed.includes(j.id), { what: 'report got through' })
    const seq = crest.state.calls.map(c => c.fn.replace('pos_print_device_', ''))
    const firstReport = seq.indexOf('report')
    assert.deepEqual(seq.slice(firstReport, firstReport + 3), ['report', 'report', 'report'], 'no poll between the failed reports and the retry')
    assert.ok(t.sleeps.includes(10000), 'backs off 10 s after a failed report')
    assert.ok(said(t.screen, /Crest is not answering properly \(error 503\) — retrying|Can't reach Crest — retrying/))
    // The claim ran out while the report was failing and Crest hands the same job back: it is
    // reported printed again, not printed twice.
    crest.state.queue.push(j)
    await waitFor(() => crest.state.printed.filter(id => id === j.id).length === 2, { what: 'second report' })
    assert.equal(printer.prints.length, 1)
  } finally { await t.stop(); await crest.close(); await printer.close() }
})

test('device_not_active: stops printing, says so, forgets the pairing and asks for a new code', async () => {
  const printer = await captureServer()
  const crest = await mockCrest({ codes: { NEWC2345: 'helper' }, device: { printers: [{ station: 'KOT', host: '127.0.0.1', port: printer.port, width: 80 }] } })
  const store = new Store(tmpDir())
  store.saveConfig(crest.pairDirect())
  const t = makeHelper(crest, { store, answers: [] })
  try {
    await waitFor(() => crest.callsOf('poll').length > 0)
    crest.deactivate()
    crest.state.queue.push(job())
    await waitFor(() => t.asked.length > 0, { what: 'pairing prompt' })
    assert.ok(said(t.screen, REMOVED_MESSAGE))
    assert.equal(store.loadConfig(), null)
    assert.equal(printer.prints.length, 0)
  } finally { await t.stop(); await crest.close(); await printer.close() }
})

test('a late job gets the PRINTED LATE line under its title', async () => {
  const printer = await captureServer()
  const crest = await mockCrest({ device: { printers: [{ station: 'KOT', host: '127.0.0.1', port: printer.port, width: 58 }] } })
  const store = new Store(tmpDir())
  store.saveConfig(crest.pairDirect())
  const t = makeHelper(crest, { store })
  try {
    await waitFor(() => crest.callsOf('poll').length > 0)
    const j = job({ late: true, created_at: '2026-10-14T08:20:00.000Z' })
    crest.state.queue.push(j)
    await waitFor(() => crest.state.printed.includes(j.id))
    const { doc, width } = t.docs.at(-1)
    assert.equal(width, 58)
    assert.equal(doc.lines[0].t, 'KITCHEN ORDER TICKET')
    assert.deepEqual(doc.lines[1], { k: 'text', t: 'PRINTED LATE — sent 14:05', align: 'center', bold: true, size: 'md' })
    assert.equal(j.doc.lines.length, 3, 'the job itself is untouched')
    assert.equal(printer.prints[0][6], 48, '58 mm paper is 48 bytes a row')
  } finally { await t.stop(); await crest.close(); await printer.close() }
})

test('paused: says POS is off and polls every 15 s', async () => {
  const crest = await mockCrest()
  const store = new Store(tmpDir())
  store.saveConfig(crest.pairDirect())
  crest.state.paused = true
  const t = makeHelper(crest, { store })
  try {
    await waitFor(() => t.sleeps.includes(15000), { what: 'slow poll' })
    assert.ok(said(t.screen, PAUSED_MESSAGE))
    assert.equal(t.screen.filter(l => l === PAUSED_MESSAGE).length, 1, 'said once, not on every poll')
  } finally { await t.stop(); await crest.close() }
})

test('Crest unreachable: keeps running, backs off 10 s and says it is retrying', async () => {
  const crest = await mockCrest()
  const store = new Store(tmpDir())
  store.saveConfig(crest.pairDirect())
  const t = makeHelper(crest, { store, url: `http://127.0.0.1:${await closedPort()}` })
  try {
    await waitFor(() => t.sleeps.filter(ms => ms === 10000).length >= 2, { what: 'back-off' })
    assert.ok(said(t.screen, OFFLINE_MESSAGE))
    assert.equal(t.screen.filter(l => l === OFFLINE_MESSAGE).length, 1)
    assert.equal(store.loadConfig().deviceId, crest.state.device.id, 'the pairing is kept')
  } finally { await t.stop(); await crest.close() }
})

test('a report still owed when the helper restarts is sent before anything else', async () => {
  const crest = await mockCrest()
  const store = new Store(tmpDir())
  store.saveConfig(crest.pairDirect())
  const owed = job()
  store.saveState({ pending: { printed: [owed.id], failed: [] }, recent: [[owed.id, Date.now()]] })
  const t = makeHelper(crest, { store })
  try {
    await waitFor(() => crest.state.printed.includes(owed.id))
    assert.equal(crest.state.calls[0].fn, 'pos_print_device_report')
  } finally { await t.stop(); await crest.close() }
})
