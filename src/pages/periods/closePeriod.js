import { supabase } from '../../supabaseClient'
import { scopedFrom, scopedInsert, scopedUpdate } from '../../shared/scopedDb'
import { withTimeout } from '../../utils/withTimeout'
import { generateMonthlyReport, saveGeneratedReport } from '../../modules/ownerReport/generateMonthlyReport'
import { BS_MONTHS } from '../../utils/bsCalendar'

/**
 * Closing a period, as ONE routine.
 *
 * WHY (S683): the product had two closes. `Periods.js` closed the month, opened the next one,
 * carried the closing count forward as opening stock and minted the frozen Monthly Report —
 * behind a closing-count preflight (S613). The Dashboard's "End Bhadra & Start Ashwin →" button,
 * the one an Owner actually presses from the "has ended" banner, updated the status and inserted
 * the next row, and did nothing else — under a dialog that promised all three. The IMS module
 * guide had noticed, and taught the workaround ("always close from Periods") instead of the fix.
 *
 * Every close now goes through `performPeriodClose()`, and every close dialog gets its notes from
 * the two preflights here, so the sentence and the write cannot disagree again. The Dashboard's
 * ConfirmModal, the client's Close on Periods and the admin's two closes are four ASKS with four
 * different framings; they share one COMMIT.
 *
 * `hr_payroll_runs` is the second preflight, and it is deliberately a NOTE and not a LOCK. HR does
 * its month's work AFTER the stock month closes — the count is on the 1st, payroll is finalized by
 * the 5th — so an IMS-style `isLocked` on HR pages would block every HR client's payroll run. HR's
 * lock is Payroll Run's own finalize. The close dialog says so, and says what the frozen report
 * carries in the meantime (an estimate, until an admin regenerates it).
 */

export function nextBsMonth(period) {
  return period.bs_month === 12
    ? { bs_year: period.bs_year + 1, bs_month: 1 }
    : { bs_year: period.bs_year, bs_month: period.bs_month + 1 }
}

export function periodLabel(period) {
  return `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`
}

// ── Preflights ────────────────────────────────────────────────────────────────

// Closing a period is the product's highest-stakes action: it locks the month AND mints the
// frozen Monthly Report, and COGS subtracts closing stock — so a period closed without a count
// freezes "closing = 0 for every item" into the immutable artifact. Payroll Finalize earned a
// data-derived gate (S570); the close only ever had advisory prose. This is that gate (S613):
// the confirm states how much of the month's count exists, in red when none does. It never
// BLOCKS — an admin correcting history legitimately closes uncounted months — it makes the
// consequence unmissable at the moment of commitment.
export async function closingCountPreflight(periodId, clientId) {
  try {
    const [countedRes, itemsRes] = await withTimeout(Promise.all([
      // Rows with a real physical count only — carryForwardOpeningStock uses the same test.
      supabase.from('closing_stock').select('item_id', { count: 'exact', head: true })
        .eq('period_id', periodId).not('physical_qty', 'is', null),
      // NO is_sub_recipe filter, deliberately: Stock.js counts active items WITHOUT that
      // filter, so sub-recipe mirror items get closing_stock rows like any other. Excluding
      // them here measured the two sides against different populations — a client with 200
      // raw items and 30 sub-recipes who counted every sub-recipe and 170 raw items scored
      // 200 of 200 and was told "All 200 active items have a closing count", with 30 items
      // heading into the frozen report at zero. Both sides must mean what the count screen
      // means, or the all-clear is the one branch that can be wrong (S616).
      supabase.from('items').select('id', { count: 'exact', head: true })
        .eq('client_id', clientId).eq('is_active', true),
    ]), 10000, 'Checking closing counts')
    if (countedRes.error || itemsRes.error) return null
    return { counted: countedRes.count ?? 0, items: itemsRes.count ?? 0 }
  } catch {
    return null // a failed preflight must not block the close — the note says it couldn't check
  }
}

/**
 * Whether this month's payroll has been finalized. Only meaningful for a client with HR on —
 * the caller decides that; an IMS-only client has no payroll run and must not be told its
 * payroll "is not finalized".
 *
 * @returns {{status: 'finalized'|'draft'|'none'}|null} null when the check itself failed.
 */
export async function payrollPreflight(periodId, clientId) {
  try {
    const { data, error } = await withTimeout(
      scopedFrom('hr_payroll_runs', clientId, 'id, status').eq('period_id', periodId).maybeSingle(),
      10000, 'Checking payroll'
    )
    if (error) return null
    return { status: data?.status || 'none' }
  } catch {
    return null
  }
}

/**
 * The sentence the close dialog shows about payroll. Advisory in every branch — `warn` (amber)
 * when payroll is open, because the close is permitted and this is the not-usual case; never
 * `danger`, because nothing here zeroes a figure the way an uncounted month does.
 *
 * @param {{status: string}|null} pre - null when the preflight failed.
 * @param {string} monthLabel - e.g. "Bhadra 2083".
 * @returns {{danger: boolean, warn: boolean, text: string}}
 */
export function payrollNote(pre, monthLabel) {
  if (!pre) return { danger: false, warn: false, text: `Couldn't check whether ${monthLabel}'s payroll is finalized. If it is not, the frozen Monthly Report carries an estimated labour cost until an admin regenerates it after Finalize.` }
  if (pre.status === 'finalized') return { danger: false, warn: false, text: `${monthLabel}'s payroll is finalized — the frozen Monthly Report carries the exact payroll figure.` }
  return { danger: false, warn: true, text: `${monthLabel}'s payroll is not finalized yet. HR pages stay open after the close and Payroll Run has its own lock — but the frozen Monthly Report will carry an ESTIMATED labour cost until an admin regenerates it after Finalize.` }
}

// ── The commit ────────────────────────────────────────────────────────────────

/** Copies the closed month's counted closing stock into the new month's opening stock. */
export async function carryForwardOpeningStock(closedPeriodId, newPeriodId) {
  if (!closedPeriodId || !newPeriodId) return { error: null }
  const { data: closingRows, error: readErr } = await supabase.from('closing_stock')
    .select('item_id, physical_qty').eq('period_id', closedPeriodId)
  if (readErr) return { error: readErr }
  const rows = (closingRows || [])
    .filter(r => r.physical_qty != null)
    .map(r => ({ period_id: newPeriodId, item_id: r.item_id, qty: r.physical_qty }))
  if (rows.length === 0) return { error: null }
  const { error: writeErr } = await supabase.from('opening_stock').upsert(rows, { onConflict: 'period_id,item_id' })
  return { error: writeErr || null }
}

/**
 * Close a period: mark it closed, open the next month (unless `openNext` is false — the admin's
 * "End Period"), carry the closing count forward, and mint the frozen Monthly Report.
 *
 * Nothing here throws. Each stage that fails is recorded with its `stage`, and the later stages
 * still run where they can — a failed carry-forward must not stop the report, and a failed
 * report (best-effort by design; `MonthlyOwnerReport.jsx` lazily generates one on first view)
 * must never stop the month from closing. The ONE exception is the close itself: if the status
 * update fails, nothing else runs, because every other stage is about a month that is closed.
 *
 * Callers turn `failures[0]` into a sentence with `closeFailureText()` — the stages are ordered
 * by how much the reader has to do about them.
 *
 * @returns {Promise<{closed: boolean, nextPeriodId: string|null, reportSaved: boolean,
 *   failures: Array<{stage: 'close'|'open_next'|'carry_forward'|'report', error: any}>}>}
 */
export async function performPeriodClose({ clientId, period, openNext = true, actorId = null }) {
  const failures = []
  const { error: closeErr } = await scopedUpdate('monthly_periods', clientId, { status: 'closed' }).eq('id', period.id)
  if (closeErr) {
    failures.push({ stage: 'close', error: closeErr })
    return { closed: false, nextPeriodId: null, reportSaved: false, failures }
  }

  let nextPeriodId = null
  if (openNext) {
    const next = nextBsMonth(period)
    const { data: newPeriod, error: newErr } = await scopedInsert(
      'monthly_periods', clientId, { bs_year: next.bs_year, bs_month: next.bs_month, status: 'open' }, { single: true }
    )
    if (!newErr) {
      nextPeriodId = newPeriod?.id ?? null
    } else if (newErr.code === '23505' || /unique/i.test(newErr.message || '')) {
      // The next period already exists (a retried click after a slow response) — the close
      // above still succeeded, so carry forward into the row that is there.
      const { data: existing, error: exErr } = await scopedFrom('monthly_periods', clientId, 'id')
        .eq('bs_year', next.bs_year).eq('bs_month', next.bs_month).maybeSingle()
      if (exErr || !existing?.id) failures.push({ stage: 'open_next', error: exErr || newErr })
      else nextPeriodId = existing.id
    } else {
      // A dropped error here closed the month and opened NOTHING — every entry page then reads
      // "no open period" with no explanation, and "+ Create Period" is admin-only, so a client
      // owner cannot recover alone (S613).
      failures.push({ stage: 'open_next', error: newErr })
    }
    if (nextPeriodId) {
      const { error: cfErr } = await carryForwardOpeningStock(period.id, nextPeriodId)
      if (cfErr) failures.push({ stage: 'carry_forward', error: cfErr })
    }
  }

  let reportSaved = false
  try {
    const closed = { ...period, status: 'closed' }
    const { snapshot, modulesIncluded } = await generateMonthlyReport({ clientId, period: closed })
    await saveGeneratedReport({ clientId, period: closed, snapshot, modulesIncluded, actorId, source: 'period_close' })
    reportSaved = true
  } catch (e) {
    console.error('Monthly owner report generation failed (non-blocking):', e)
    failures.push({ stage: 'report', error: e })
  }

  return { closed: true, nextPeriodId, reportSaved, failures }
}

/**
 * The consequence sentence for a failed stage — what state the month is in NOW and what to do,
 * never the constraint (see errorText.js). The technical detail rides along separately as
 * ActionError's fine print; this is the headline.
 */
export function closeFailureText({ stage, period, isAdmin = false }) {
  const m = periodLabel(period)
  const n = nextBsMonth(period)
  const nextLabel = `${BS_MONTHS[n.bs_month - 1]} ${n.bs_year}`
  switch (stage) {
    case 'close':
      // A dead fetch does not prove the update did not land — say "may not", and send them to
      // look, rather than inviting a retry over a month that is already closed.
      return `${m} may not have closed. Reload to check its status before trying again.`
    case 'open_next':
      return `${m} was closed, but ${nextLabel} could not be opened. ` + (isAdmin
        ? 'Use "+ Create Period" for this client, then "Resync Opening Stock" to carry the closing count forward.'
        : 'Until the new month is opened you will not be able to record purchases, sales or stock. Please contact your Crest consultant.')
    case 'carry_forward':
      return `${m} was closed and ${nextLabel} opened, but the closing count could not be carried into it as opening stock — ` +
        `${nextLabel}'s Stock Count currently opens with no opening figures. ` +
        `Use "Resync Opening Stock" on the ${m} row in Periods to carry it forward before anyone enters purchases or sales.`
    case 'report':
      return `${m} closed, but its frozen Monthly Report could not be generated now. It will be generated the first time the report is opened.`
    default:
      return `${m} may not have closed completely. Check Periods before continuing.`
  }
}
