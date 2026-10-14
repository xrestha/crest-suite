// The print station page's job loop (S837; contract in docs/kitchen-printers.md), kept free of React
// and the DOM so it can be tested with a fake server and a fake printer.
//
// One tick: resend any report the server never heard, then poll (which claims up to 10 jobs), print
// each job in order, and report what printed and what failed. Three rules hold it together:
//
// - A report the server did not hear is resent BEFORE anything new is printed. A claim lapses after
//   60 s and the job is then claimed again, so a lost report means the kitchen gets that ticket
//   twice; printing more on top of it only widens the window.
// - Only one tick runs at a time (`busy`), and a printer test goes through the same lock, so two
//   print windows never interleave on one printer.
// - A failed call slows the loop to SLOW_TICK_MS until a call succeeds. The tills print for
//   themselves while this computer cannot be reached, so nothing is gained by hammering.

import { isNetworkError } from '../../../shared/errorText'
import { isTimeout } from '../../../utils/withTimeout'

export const TICK_MS = 2000
export const SLOW_TICK_MS = 10000
export const FAIL_REASON_MAX = 200

/** True when the call got no answer at all: a timeout or a dropped connection. */
export function isNoAnswer(err) {
  return !!err && (isTimeout(err) || isNetworkError(err))
}

/** The reason a print failed, as the report sends it (≤ 200 characters). */
export function failReason(err) {
  const raw = err instanceof Error ? err.message : (typeof err === 'string' ? err : err?.message)
  const text = String(raw || 'The print did not start.').trim() || 'The print did not start.'
  return text.slice(0, FAIL_REASON_MAX)
}

/**
 * @param {object}   o
 * @param {{deviceId: string, secret: string}} o.device
 * @param {Function} o.rpc        (fn, params) → Promise<{ data, error }>; never throws
 * @param {Function} o.printHtml  (html) → Promise, rejects when the print could not start
 * @param {Function} o.renderDoc  (doc) → html
 * @param {Function} o.withLate   (doc, createdAtIso) → doc with the PRINTED LATE line
 * @param {string}   o.appVersion
 * @param {Function} [o.now]      → ms; the clock
 * @param {Function} [o.onEvent]  ({ type: 'job-start'|'job-printed'|'job-failed'|'report-refused', … })
 */
export function createPrintRunner({ device, rpc, printHtml, renderDoc, withLate, appVersion, now = Date.now, onEvent = () => {} }) {
  let busy = false
  let stopped = false
  let pendingReport = null // { printed: uuid[], failed: [{ id, reason }] }
  let nextAt = 0           // the earliest a tick may run again after a failed call

  const creds = () => ({ p_device_id: device.deviceId, p_secret: device.secret })
  const emit = e => { try { onEvent(e) } catch (err) { console.error('print station event handler failed:', err) } }

  const failedCall = (error, during) => {
    nextAt = now() + SLOW_TICK_MS
    return { kind: 'unreachable', during, error, noAnswer: isNoAnswer(error) }
  }
  const succeeded = () => { nextAt = 0 }
  const removed = () => {
    stopped = true
    pendingReport = null
    return { kind: 'removed' }
  }

  // → null when the report is settled (heard, or refused for good), else the outcome to return.
  async function sendReport() {
    const { data, error } = await rpc('pos_print_device_report', {
      ...creds(), p_printed: pendingReport.printed, p_failed: pendingReport.failed,
    })
    if (error) return failedCall(error, 'report')
    succeeded()
    if (data && data.ok === false) {
      if (data.code === 'device_not_active') return removed()
      // A refusal is the server's decision, and resending it would block every ticket behind it.
      emit({ type: 'report-refused', code: data.code, message: data.message })
    }
    pendingReport = null
    return null
  }

  async function printJob(job) {
    emit({ type: 'job-start', job })
    try {
      const doc = job.late ? withLate(job.doc, job.created_at) : job.doc
      await printHtml(renderDoc(doc))
      emit({ type: 'job-printed', job, at: now() })
      return null
    } catch (err) {
      const reason = failReason(err)
      emit({ type: 'job-failed', job, reason, at: now() })
      return reason
    }
  }

  async function run() {
    if (pendingReport) {
      const blocked = await sendReport()
      if (blocked) return blocked
    }

    const { data, error } = await rpc('pos_print_device_poll', {
      ...creds(), p_info: { app_version: appVersion, printers: [] },
    })
    if (error) return failedCall(error, 'poll')
    if (!data || typeof data !== 'object') return failedCall(new Error('Crest sent an answer this page does not understand.'), 'poll')
    if (data.ok === false) {
      if (data.code === 'device_not_active') return removed()
      return failedCall({ message: data.message || data.code || 'Crest refused the check for tickets.', code: data.code }, 'poll')
    }
    succeeded()
    const info = { device: data.device || null, clientName: data.client_name || '' }
    if (data.paused) return { kind: 'paused', reason: data.paused, ...info }

    const jobs = Array.isArray(data.jobs) ? data.jobs.filter(j => j && j.id) : []
    if (jobs.length === 0) return { kind: 'ok', printed: 0, failed: 0, ...info }

    const printed = []
    const failed = []
    for (const job of jobs) {
      const reason = await printJob(job)
      if (reason) failed.push({ id: job.id, reason })
      else printed.push(job.id)
    }
    pendingReport = { printed, failed }
    const blocked = await sendReport()
    if (blocked) return { ...blocked, printed: printed.length, failed: failed.length }
    return { kind: 'ok', printed: printed.length, failed: failed.length, ...info }
  }

  return {
    get busy() { return busy },
    get stopped() { return stopped },
    get hasPendingReport() { return !!pendingReport },
    /** Nothing in flight and nothing unheard: a reload now loses nothing. */
    get safeToReload() { return !busy && !pendingReport },
    /** Whether a tick would run now (not busy, not stopped, not inside a slowdown). */
    due() { return !busy && !stopped && now() >= nextAt },

    async tick() {
      if (stopped) return { kind: 'stopped' }
      if (busy) return { kind: 'busy' }
      if (now() < nextAt) return { kind: 'skipped' }
      busy = true
      try {
        return await run()
      } finally {
        busy = false
      }
    },

    /** A test ticket, through the same lock and the same printer path; no server call. */
    async printLocal(html) {
      if (busy) return { ok: false, busy: true }
      busy = true
      try {
        await printHtml(html)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: failReason(error) }
      } finally {
        busy = false
      }
    },
  }
}
