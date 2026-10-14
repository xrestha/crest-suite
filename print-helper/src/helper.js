'use strict'
// The helper's work: pair once, then poll Crest every 2 s, print each claimed job on the printer set
// for its station, and report what printed and what failed (docs/kitchen-printers.md). A report that
// did not get through is retried before the next poll, so its jobs are not claimed and printed again
// once their 60 s claim runs out; ids printed in the last 30 minutes are never printed twice.
const { renderDoc, withLateLine } = require('./render')
const { buildEscPos } = require('./escpos')
const { sendToPrinter, probePrinter, plainReason, REASON_MAX } = require('./printer')
const { plain } = require('./ui')
const { ApiError } = require('./api')
const APP_VERSION = require('../package.json').version

const INTERVALS = {
  poll: 2000,
  offline: 10000,
  paused: 15000,
  probe: 60000,
}
const RECENT_KEEP_MS = 30 * 60 * 1000
const MAX_REPORT_REFUSALS = 3

const STATION_NAMES = { KOT: 'Kitchen printer', BOT: 'Bar printer' }
const stationName = s => STATION_NAMES[s] || `${plain(s) || 'Unknown'} printer`
const KIND_WORDS = { ticket: 'ticket', reprint: 'reprint', void: 'VOID slip', move: 'MOVED slip', test: 'test print' }

const PAIR_MESSAGES = {
  pair_code_invalid: 'That code did not work. Check it, or make a new one in POS Setup → Printers (a code works once, for 15 minutes).',
  wrong_kind: 'That code is for a print station page, not this helper. In POS Setup → Printers, add the device as a Crest Print Helper and use its code.',
  too_many_attempts: 'Too many wrong codes from this network. Wait 15 minutes, then try again.',
  pos_off: 'POS is switched off for this outlet. Turn it on in Crest first, then type the code again.',
}

const REMOVED_MESSAGE = 'This helper was removed or paired again elsewhere — type a new pairing code from POS Setup → Printers'
const OFFLINE_MESSAGE = "Can't reach Crest — retrying"
const PAUSED_MESSAGE = 'Paused: POS is off for this outlet'

const clip = s => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s)

function defaultSleep(helper) {
  return ms => new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done() { clearTimeout(t); helper.wake = null; resolve() }
    helper.wake = done
  })
}

/** The printers a device lists, kept only when usable: { station, host, port, width }. */
function cleanPrinters(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const p of list) {
    if (!p || typeof p !== 'object' || typeof p.station !== 'string' || typeof p.host !== 'string' || !p.host.trim()) continue
    const port = Number.isInteger(Number(p.port)) && Number(p.port) > 0 && Number(p.port) < 65536 ? Number(p.port) : 9100
    const width = Number(p.width) === 58 ? 58 : 80
    if (!out.some(x => x.station === p.station)) out.push({ station: p.station, host: p.host.trim(), port, width })
  }
  return out
}

class Helper {
  constructor({ api, store, ui, log, fonts, ask, sleep, send = sendToPrinter, probe = probePrinter, render, onPaired, now = () => Date.now(), intervals = {} }) {
    this.api = api
    this.store = store
    this.ui = ui
    this.log = log || { info() {}, warn() {}, error() {} }
    this.fonts = fonts
    this.ask = ask
    this.sleep = sleep || defaultSleep(this)
    this.send = send
    this.probe = probe
    this.render = render || ((doc, width) => buildEscPos(renderDoc(doc, this.fonts, width)))
    this.onPaired = onPaired
    this.now = now
    this.iv = { ...INTERVALS, ...intervals }
    this.stopped = false
    this.wake = null
    this.cfg = null
    this.printers = []
    this.stations = []
    this.status = new Map()
    this.printersKey = null
    this.lastProbe = 0
    this.reportRefusals = 0
    this.pending = { printed: [], failed: [] }
    this.recent = new Map()
  }

  stop() {
    this.stopped = true
    if (this.wake) this.wake()
  }

  // ---- state that survives a restart ---------------------------------------------------------

  loadState() {
    const s = this.store.loadState()
    this.pending = s.pending
    const cutoff = this.now() - RECENT_KEEP_MS
    this.recent = new Map(s.recent.filter(([, t]) => t > cutoff))
  }

  saveState() {
    const cutoff = this.now() - RECENT_KEEP_MS
    for (const [id, t] of this.recent) if (t <= cutoff) this.recent.delete(id)
    try {
      this.store.saveState({ pending: this.pending, recent: [...this.recent] })
    } catch (e) {
      this.log.error('could not save state.json', e)
    }
  }

  resetState() {
    this.pending = { printed: [], failed: [] }
    this.recent = new Map()
    this.status = new Map()
    this.printers = []
    this.stations = []
    this.printersKey = null
    this.reportRefusals = 0
  }

  // ---- main loop -----------------------------------------------------------------------------

  /** Runs until stop() or until the pairing prompt gets no more input. */
  async run({ forcePair = false } = {}) {
    this.loadState()
    let force = forcePair
    while (!this.stopped) {
      if (force) {
        this.store.clearPairing()
        this.resetState()
        force = false
      }
      let cfg = this.store.loadConfig()
      if (!cfg) {
        cfg = await this.pair()
        if (!cfg) return this.stopped ? 'stopped' : 'no-input'
        if (this.onPaired) {
          try { await this.onPaired(cfg) } catch (e) { this.log.error('after-pairing step failed', e) }
        }
      }
      const r = await this.serve(cfg)
      if (r === 'stop') break
    }
    return 'stopped'
  }

  async pair() {
    this.ui.say('This helper is not connected to Crest yet.')
    this.ui.say('In Crest, open POS Setup → Printers, add a Crest Print Helper (or ask for a new pairing code), then type the code shown there.')
    while (!this.stopped) {
      const input = await this.ask('Pairing code: ')
      if (input === null || input === undefined) return null
      const code = String(input).replace(/[\s-]+/g, '').toUpperCase()
      if (!code) continue
      if (!/^[A-Z0-9]{8}$/.test(code)) {
        this.ui.say('A pairing code has 8 letters and numbers, like ABCD-2345. Please type it again.')
        continue
      }
      let res
      try {
        res = await this.api.pair(code, { kind: 'helper', app_version: APP_VERSION })
      } catch (e) {
        this.log.warn('pairing call failed', e)
        this.ui.say("Can't reach Crest — check this computer's internet connection, then type the code again.")
        continue
      }
      if (res.ok === true && typeof res.device_id === 'string' && typeof res.secret === 'string' && res.device_id && res.secret) {
        if (res.kind && res.kind !== 'helper') {
          this.ui.say(PAIR_MESSAGES.wrong_kind)
          continue
        }
        const cfg = {
          deviceId: res.device_id,
          secret: res.secret,
          deviceName: plain(res.device_name),
          clientName: plain(res.client_name),
          pairedAt: new Date(this.now()).toISOString(),
        }
        this.store.saveConfig(cfg)
        this.resetState()
        this.saveState()
        this.log.info(`paired as device ${cfg.deviceId}`)
        this.ui.say(`Paired: this helper is "${cfg.deviceName}" for ${cfg.clientName}.`)
        return cfg
      }
      this.log.warn(`pairing refused: ${plain(res.code)} ${plain(res.message)}`)
      this.ui.say(PAIR_MESSAGES[res.code] || `Crest did not accept the code (${plain(res.message || res.code) || 'no reason given'}). Please try again.`)
    }
    return null
  }

  async serve(cfg) {
    this.cfg = cfg
    this.ui.forget('crest')
    while (!this.stopped) {
      // A report that did not get through goes first, so its jobs are never printed twice.
      if (this.hasPending()) {
        const r = await this.flushReport()
        if (r === 'not_active') return this.removed()
        if (r !== 'ok') { await this.sleep(this.iv.offline); continue }
      }
      let res
      try {
        res = await this.api.poll(cfg.deviceId, cfg.secret, this.pollInfo())
      } catch (e) {
        this.callFailed('poll', e)
        await this.sleep(this.iv.offline)
        continue
      }
      if (this.stopped) break
      if (res.ok !== true) {
        if (res.code === 'device_not_active') return this.removed()
        this.log.warn(`poll refused: ${plain(res.code)} ${plain(res.message)}`)
        this.ui.status('crest', `Crest did not accept this helper's check-in (${plain(res.message || res.code) || 'no reason given'}) — retrying`)
        await this.sleep(this.iv.offline)
        continue
      }
      if (res.paused) {
        this.ui.status('crest', PAUSED_MESSAGE)
        await this.sleep(this.iv.paused)
        continue
      }
      this.onDevice(res)
      const jobs = Array.isArray(res.jobs) ? res.jobs : []
      if (jobs.length) {
        await this.printJobs(jobs)
        const r = await this.flushReport()
        if (r === 'not_active') return this.removed()
        if (r !== 'ok') { await this.sleep(this.iv.offline); continue }
      } else {
        await this.maybeProbe()
      }
      await this.sleep(this.iv.poll)
    }
    return 'stop'
  }

  removed() {
    this.log.warn('device_not_active: forgetting the pairing')
    for (const station of this.status.keys()) this.ui.forget(`printer:${station}`)
    this.store.clearPairing()
    this.resetState()
    this.cfg = null
    this.ui.forget('crest')
    this.ui.say(REMOVED_MESSAGE)
    return 'repair'
  }

  callFailed(what, e) {
    // An ApiError's message says it all; its stack would fill the log during a long outage.
    if (e instanceof ApiError) this.log.warn(`${what} failed: ${e.message}`)
    else this.log.warn(`${what} failed`, e)
    if (e instanceof ApiError && e.kind === 'http' && e.status < 500) {
      this.ui.status('crest', `Crest is not answering properly (error ${e.status}) — retrying`)
    } else {
      this.ui.status('crest', OFFLINE_MESSAGE)
    }
  }

  // ---- device and printers -------------------------------------------------------------------

  onDevice(res) {
    const device = res.device && typeof res.device === 'object' ? res.device : {}
    const deviceName = plain(device.name) || this.cfg.deviceName
    const clientName = plain(res.client_name) || this.cfg.clientName
    if (deviceName !== this.cfg.deviceName || clientName !== this.cfg.clientName) {
      this.cfg = { ...this.cfg, deviceName, clientName }
      try { this.store.updateConfig({ deviceName, clientName }) } catch (e) { this.log.warn('could not update config', e) }
    }
    this.ui.status('crest', `Connected to Crest — outlet: ${clientName}, this helper: ${deviceName}`)

    const printers = cleanPrinters(device.printers)
    const stations = Array.isArray(device.stations) ? device.stations.filter(s => typeof s === 'string') : printers.map(p => p.station)
    const key = JSON.stringify([printers, stations])
    if (key !== this.printersKey) {
      this.printersKey = key
      // Keep a station's last result only while its printer is unchanged.
      const before = new Map(this.printers.map(p => [p.station, `${p.host}:${p.port}`]))
      for (const s of [...this.status.keys()]) {
        const p = printers.find(x => x.station === s)
        if (!p || before.get(s) !== `${p.host}:${p.port}`) this.status.delete(s)
      }
      this.printers = printers
      this.stations = stations
      for (const p of printers) this.ui.say(`${stationName(p.station)} (${p.station}): ${p.host} port ${p.port}, ${p.width} mm paper`)
      for (const s of stations) {
        if (!printers.some(p => p.station === s)) {
          const error = `No printer is set for ${stationName(s).toLowerCase()} tickets on this helper — add one in POS Setup → Printers`
          this.setStatus(s, false, error)
        }
      }
      this.lastProbe = 0
    }
  }

  printerFor(station) { return this.printers.find(p => p.station === station) || null }

  setStatus(station, ok, error) {
    this.status.set(station, { ok, error: error || null })
    const p = this.printerFor(station)
    const where = p ? ` ${p.host}` : ''
    this.ui.status(`printer:${station}`, ok
      ? `${stationName(station)}${where}: ready`
      : `${stationName(station)}${where}: NOT WORKING — ${error}`)
  }

  pollInfo() {
    return {
      app_version: APP_VERSION,
      printers: [...this.status].map(([station, s]) => ({ station, ok: s.ok, error: s.error })),
    }
  }

  async maybeProbe() {
    if (!this.printers.length || this.now() - this.lastProbe < this.iv.probe) return
    this.lastProbe = this.now()
    const seen = new Map()
    await Promise.all(this.printers.map(async (p) => {
      const k = `${p.host}:${p.port}`
      if (!seen.has(k)) seen.set(k, this.probe({ host: p.host, port: p.port }))
      let r
      try { r = await seen.get(k) } catch (e) { r = { ok: false, error: plainReason(e && e.code, p.host, p.port, 'connect') } }
      this.setStatus(p.station, r.ok, r.ok ? null : r.error)
    }))
  }

  // ---- printing ------------------------------------------------------------------------------

  async printJobs(jobs) {
    const printed = []
    const failed = []
    const groups = new Map()
    for (const job of jobs) {
      if (!job || typeof job !== 'object' || typeof job.id !== 'string' || !job.id) continue
      if (this.recent.has(job.id)) {
        // Printed already, but Crest never heard: report it again without printing it twice.
        this.log.info(`job ${job.id} was printed already; reporting it again`)
        printed.push(job.id)
        continue
      }
      const printer = this.printerFor(job.station)
      if (!printer) {
        const reason = clip(`No printer is set for ${stationName(job.station).toLowerCase()} tickets (${plain(job.station)}) on this helper — add one in POS Setup → Printers`)
        failed.push({ id: job.id, reason })
        this.setStatus(plain(job.station) || 'unknown', false, reason)
        this.ui.say(`Could not print ${this.describe(job)}: ${reason}`)
        continue
      }
      const k = `${printer.host}:${printer.port}`
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push({ job, printer })
    }
    await Promise.all([...groups.values()].map(list => this.printGroup(list, printed, failed)))
    this.addPending(printed, failed)
  }

  // One printer's jobs, in order. Once it fails, the rest fail with the same reason at once instead
  // of each waiting out its own timeout; Crest gives them back on a later poll.
  async printGroup(list, printed, failed) {
    let down = null
    for (const { job, printer } of list) {
      if (down) { failed.push({ id: job.id, reason: down }); continue }
      let bytes
      try {
        if (!job.doc || typeof job.doc !== 'object' || !Array.isArray(job.doc.lines) || !job.doc.lines.length) throw new Error('empty doc')
        const doc = job.late === true ? withLateLine(job.doc, job.created_at) : job.doc
        bytes = this.render(doc, printer.width)
      } catch (e) {
        this.log.error(`job ${job.id}: could not draw the ticket`, e)
        const reason = 'This ticket could not be drawn (its content is damaged or empty) — print it from the till'
        failed.push({ id: job.id, reason })
        this.ui.say(`Could not print ${this.describe(job)}: ${reason}`)
        continue
      }
      try {
        await this.send({ host: printer.host, port: printer.port, data: bytes, onLateError: e => this.log.warn(`job ${job.id}: error after the whole ticket was sent (counted as printed)`, e) })
        printed.push(job.id)
        this.recent.set(job.id, this.now())
        this.setStatus(job.station, true, null)
        this.ui.say(`Printed ${this.describe(job)}${job.late === true ? ' (late)' : ''}`)
      } catch (e) {
        const reason = clip(e && e.reason ? e.reason : plainReason(e && e.code, printer.host, printer.port, 'send'))
        this.log.warn(`job ${job.id}: print failed on ${printer.host}:${printer.port}`, e)
        failed.push({ id: job.id, reason })
        this.setStatus(job.station, false, reason)
        this.ui.say(`Could not print ${this.describe(job)}: ${reason}`)
        down = reason
      }
    }
  }

  describe(job) {
    const where = job.station === 'BOT' ? 'bar' : job.station === 'KOT' ? 'kitchen' : plain(job.station)
    const what = KIND_WORDS[job.kind] || 'ticket'
    const label = plain(job.label).slice(0, 80)
    return `${where} ${what}${label ? ` "${label}"` : ''}`
  }

  // ---- reporting -----------------------------------------------------------------------------

  hasPending() { return this.pending.printed.length > 0 || this.pending.failed.length > 0 }

  addPending(printed, failed) {
    const p = new Set(this.pending.printed)
    for (const id of printed) p.add(id)
    const f = new Map(this.pending.failed.map(x => [x.id, x]))
    for (const x of failed) if (!p.has(x.id)) f.set(x.id, { id: x.id, reason: clip(String(x.reason || 'Could not print')) })
    for (const id of p) f.delete(id)
    this.pending = { printed: [...p], failed: [...f.values()] }
    this.saveState()
  }

  /** 'ok', 'not_active' or 'error'. */
  async flushReport() {
    if (!this.hasPending()) return 'ok'
    const printed = [...this.pending.printed]
    const failed = this.pending.failed.map(x => ({ id: x.id, reason: x.reason }))
    let res
    try {
      res = await this.api.report(this.cfg.deviceId, this.cfg.secret, printed, failed)
    } catch (e) {
      this.callFailed('report', e)
      if (e instanceof ApiError && e.kind === 'http' && e.status >= 400 && e.status < 500) return this.refused(`HTTP ${e.status}`)
      return 'error'
    }
    if (res.ok !== true) {
      if (res.code === 'device_not_active') return 'not_active'
      return this.refused(`${plain(res.code)} ${plain(res.message)}`)
    }
    this.reportRefusals = 0
    this.pending = { printed: [], failed: [] }
    this.saveState()
    return 'ok'
  }

  // A report Crest keeps refusing (not a network failure) is dropped after a few tries, so one bad
  // report cannot stop every later ticket. Its printed jobs stay in the recent list.
  refused(why) {
    this.reportRefusals += 1
    this.log.warn(`report refused (${this.reportRefusals}/${MAX_REPORT_REFUSALS}): ${why}`)
    if (this.reportRefusals >= MAX_REPORT_REFUSALS) {
      this.log.error(`dropping a report Crest keeps refusing: ${JSON.stringify(this.pending)}`)
      this.pending = { printed: [], failed: [] }
      this.reportRefusals = 0
      this.saveState()
      return 'ok'
    }
    return 'error'
  }
}

module.exports = { Helper, cleanPrinters, INTERVALS, PAIR_MESSAGES, REMOVED_MESSAGE, OFFLINE_MESSAGE, PAUSED_MESSAGE, APP_VERSION }
