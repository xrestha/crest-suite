import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { scopedInsert as scopedInsertRaw, scopedUpdate as scopedUpdateRaw } from '../shared/scopedDb'
import { useScopedDb } from '../shared/hooks/useScopedDb'
import { BS_MONTHS, BS_YEAR_MAX, getBsToday, formatBsDay } from '../utils/bsCalendar'
import { nepalBs, nepalDateAd } from '../shared/nepalTime'
import { fetchAllRows } from '../shared/fetchAllRows'
import { useNavigate, Navigate } from 'react-router-dom'
import Tip from '../components/Tip'
import ConfirmModal from '../components/ConfirmModal'
import { closingCountPreflight, payrollPreflight, payrollNote, performPeriodClose, closeFailureText, carryForwardOpeningStock } from './periods/closePeriod'
import CloseConfirmBody from './periods/CloseConfirmBody'
import { backfillPosOrdersToIms, countUnpostedForPeriod } from '../modules/pos/orders/backfillPosToIms'
import { withTimeout } from '../utils/withTimeout'
import { closingCountNote } from './periods/closingCountNote'
import { errorInfo, errorLine } from '../shared/errorText'
import ActionError from '../components/ActionError'
import ReportLoadError from '../components/ReportLoadError'

// The BS year a period may be created or edited into. The floor is a typo guard — 2070 BS is
// 2013 AD, well before any client existed. The ceiling is the verified calendar table's own limit
// and must NEVER be typed out here (it was "2100" in five places): past BS_YEAR_MAX,
// daysInBsMonth() falls back to a flat 30-day approximation, so a period out there carries dates
// the app converts wrongly — and the table moves, see .claude/rules/bs-calendar.md.
const YEAR_MIN = 2070
const YEAR_MAX = BS_YEAR_MAX
const yearRangeError = `Enter a valid BS year (${YEAR_MIN}–${YEAR_MAX}).`

// The Created cell. Every other date on this page is BS, and this one was
// `new Date(created_at).toLocaleDateString()` — AD, in the VIEWER's locale and timezone, so an
// operator reviewing a client's periods from outside Nepal read a period as created on a
// different day than the client did (the S670 rule: a timestamptz is rendered by nepalTime.js,
// never by a bare toLocale*). `nepalBs` returns null past the verified calendar table, where the
// AD date is the honest fallback rather than a confident wrong BS one.
function createdLabel(ts) {
  const bs = nepalBs(ts)
  return bs ? `${formatBsDay(bs.day, bs.month)} ${bs.year}` : nepalDateAd(ts)
}

export default function Periods() {
  const { isAdmin, isOwner, clientId, profile, switchAdminClient, hasImsAccess, clientModules } = useAuth()
  const posEnabled = !!clientModules?.pos
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()
  const navigate = useNavigate()
  const [periods, setPeriods] = useState([])
  const [backfillBusy, setBackfillBusy] = useState(null) // period id currently posting POS bills
  const [closeBusy, setCloseBusy] = useState(false) // preflighting or committing a close
  // One shared ConfirmModal for the page's consequential actions (S575 rule — period close is that
  // rule's #1 named case, and this page ran it on window.confirm until S612). Shape:
  // { title, body, confirmLabel, danger, run }. Rendered in BOTH returns below — this page has two.
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null) // a failed periods read is not "no periods yet"
  // One page-level notice for the outcome of a period action (close, reopen, resync, POS backfill).
  // These were ten window.alert()s until S682 — a blocking native box with no theme, no
  // role="status", and a Postgres message where an owner needs a consequence. `fail()` writes the
  // consequence as the headline and keeps the raw detail as ActionError's fine print.
  //
  // EVERY action calls setNotice(null) before it starts, not only the ones that end by writing
  // one. A close, a resync, a create or a reactivate that SUCCEEDS writes no notice at all — so
  // without that reset the red ActionError from the failed attempt before it stayed on screen and
  // read as the verdict on the action that had just worked. Only reopenPeriod was doing it.
  const [notice, setNotice] = useState(null) // { kind: 'ok' | 'error', text, detail }
  const fail = (text, err) => setNotice({
    kind: 'error', text,
    detail: !err ? '' : typeof err === 'string' ? err : errorInfo(err, 'operator').detail,
  })
  const ok = text => setNotice({ kind: 'ok', text })
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ bs_year: 2082, bs_month: 1 })
  const [showForm, setShowForm] = useState(false)
  const [error, setError] = useState('')

  // Inline edit state
  const [editingId, setEditingId] = useState(null)
  const [editForm, setEditForm] = useState({ bs_year: '', bs_month: 1 })
  const [editError, setEditError] = useState('')
  const [saving, setSaving] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // Admin all-clients state
  const [allClients, setAllClients] = useState([])
  const [allClientPeriods, setAllClientPeriods] = useState({})
  const [allLoading, setAllLoading] = useState(false)
  const [actionClientId, setActionClientId] = useState(null)
  const [editingAllClientId, setEditingAllClientId] = useState(null)
  const [editAllForm, setEditAllForm] = useState({ bs_year: '', bs_month: 1 })
  const [editAllError, setEditAllError] = useState('')
  const [savingAll, setSavingAll] = useState(false)

  // Set right after a client-view close — surfaces a "your report is ready" banner. Not used in
  // the admin all-clients batch-close loop (a redirect/nudge per client there would be
  // disruptive across many clients closed in a row).
  const [justClosedReport, setJustClosedReport] = useState(null)

  const bsToday = getBsToday()

  useEffect(() => {
    if (isAdmin && !clientId) loadAllClientPeriods()
    else if (clientId) loadPeriods()
    else setLoading(false)
  }, [clientId, isAdmin]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAllClientPeriods() {
    setAllLoading(true)
    const results = await Promise.all([
      supabase.from('clients').select('id, name, is_active, hr_enabled').order('name'),
      // Every period of every client: rows are clients × months, so 30 clients over three years
      // is already past PostgREST's 1000-row cap — and the sort drops the OLDEST rows first,
      // which means the client this read silently erases is the dormant one whose open period is
      // months behind. That is precisely the client `needsAttention` and the amber count below
      // exist to surface: it would render as "NO PERIOD" with a + Create Period button, and every
      // Total in the table would be short. `.order('id')` is the unique tiebreaker paging needs.
      fetchAllRows(() => supabase.from('monthly_periods')
        .select('id, client_id, bs_year, bs_month, status')
        .order('bs_year', { ascending: false })
        .order('bs_month', { ascending: false })
        .order('id')),
    ])
    const failed = results.find(r => r && r.error)
    if (failed) {
      // A failed read is not "no clients" — keep the last-good list and say so.
      fail('Could not load the clients and their periods — the list below is from the last successful load.', failed.error)
      setAllLoading(false)
      return
    }
    const [{ data: clients }, { data: allPeriods }] = results
    setAllClients(clients || [])
    const map = {}
    for (const p of (allPeriods || [])) {
      if (!map[p.client_id]) map[p.client_id] = []
      map[p.client_id].push(p)
    }
    setAllClientPeriods(map)
    setAllLoading(false)
  }

  // The close itself — carry-forward, report minting, both preflights — lives in
  // ./periods/closePeriod.js since S683, shared with the Dashboard. Nothing period-closing is local.

  // All four closes — the two admin ones here, the client's below, and the Dashboard's — share
  // ONE commit, performPeriodClose(), and one pair of preflights (S683). The framing differs per
  // ask; the notes and the write do not. See .claude/rules/closed-periods.md.
  async function closeNotes(period, cid, hrOn) {
    const [count, payroll] = await Promise.all([
      closingCountPreflight(period.id, cid),
      hrOn ? payrollPreflight(period.id, cid) : Promise.resolve(undefined),
    ])
    const label = `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`
    return [closingCountNote(count), hrOn ? payrollNote(payroll, label) : null]
  }

  // HR pages are deliberately NOT locked by the close — payroll is finalized after the stock
  // month closes — so the sentence names exactly what locks, for whoever is reading it.
  const locksSentence = (period, hrOn, audience) =>
    `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}'s IMS entry pages lock for ` +
    (audience === 'admin' ? "the client's own logins" : 'your team') +
    (hrOn ? ' (HR pages stay open — Payroll Run locks itself once finalized)' : '')

  function surfaceCloseFailures(result, period) {
    const first = result.failures[0]
    if (first) fail(closeFailureText({ stage: first.stage, period, isAdmin }), first.error)
  }

  const adminHrOn = cid => !!allClients.find(c => c.id === cid)?.hr_enabled

  async function adminCloseAndAdvance(period, cid) {
    const nextMonth = period.bs_month === 12 ? 1 : period.bs_month + 1
    const nextYear  = period.bs_month === 12 ? period.bs_year + 1 : period.bs_year
    const hrOn = adminHrOn(cid)
    setNotice(null)
    setActionClientId(cid)
    const notes = await closeNotes(period, cid, hrOn)
    setActionClientId(null)
    setPendingConfirm({
      title: `Close ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`,
      confirmLabel: 'Close & Start Next',
      danger: notes.some(n => n?.danger),
      body: <CloseConfirmBody main={`${locksSentence(period, hrOn, 'admin')} and ${BS_MONTHS[nextMonth - 1]} ${nextYear} opens. Closing stock carries forward as the new month's opening stock, and the frozen Monthly Report for ${BS_MONTHS[period.bs_month - 1]} is generated from the figures as they stand now.`} notes={notes} />,
      run: () => performAdminCloseAndAdvance(period, cid),
    })
  }

  async function performAdminCloseAndAdvance(period, cid) {
    setActionClientId(cid)
    const result = await performPeriodClose({ clientId: cid, period, openNext: true, actorId: profile?.id })
    surfaceCloseFailures(result, period)
    await loadAllClientPeriods()
    setActionClientId(null)
  }

  async function adminEndPeriod(period, cid) {
    const hrOn = adminHrOn(cid)
    setNotice(null)
    setActionClientId(cid)
    const notes = await closeNotes(period, cid, hrOn)
    setActionClientId(null)
    setPendingConfirm({
      title: `End ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`,
      confirmLabel: 'End Period',
      danger: true,
      body: <CloseConfirmBody main={`${BS_MONTHS[period.bs_month - 1]} ${period.bs_year} closes with no new period started — the client is blocked from recording any data until one is created. The frozen Monthly Report is generated from the figures as they stand now.`} notes={notes} />,
      run: () => performAdminEndPeriod(period, cid),
    })
  }

  async function performAdminEndPeriod(period, cid) {
    setActionClientId(cid)
    const result = await performPeriodClose({ clientId: cid, period, openNext: false, actorId: profile?.id })
    surfaceCloseFailures(result, period)
    await loadAllClientPeriods()
    setActionClientId(null)
  }

  async function adminCreatePeriod(cid) {
    setNotice(null)
    setActionClientId(cid)
    const existing = (allClientPeriods[cid] || []).find(
      p => p.bs_year === bsToday.year && p.bs_month === bsToday.month
    )
    const label = `${BS_MONTHS[bsToday.month - 1]} ${bsToday.year}`
    // BOTH branches surface their error. The reactivate branch used to be a bare `await` with
    // nothing destructured — supabase-js RESOLVES with { data, error } rather than throwing, so a
    // refusal there was a click, a "Working…", a reload, and a row that had not changed, with
    // nothing said (CLAUDE.md: a bare await discards the only evidence the call failed).
    const { error } = existing
      ? await scopedUpdateRaw('monthly_periods', cid, { status: 'open' }).eq('id', existing.id)
      : await scopedInsertRaw('monthly_periods', cid, {
          bs_year: bsToday.year, bs_month: bsToday.month, status: 'open'
        })
    if (error) {
      fail(existing
        ? `${label} was not reopened for this client — it is still closed, so they still cannot record anything.`
        : `${label} was not created for this client — they still have no open period, so no purchases, sales or stock can be recorded.`,
        error)
    }
    await loadAllClientPeriods()
    setActionClientId(null)
  }

  async function saveAllEdit(periodId, cid) {
    setEditAllError('')
    const year = parseInt(editAllForm.bs_year)
    const month = parseInt(editAllForm.bs_month)
    if (!year || year < YEAR_MIN || year > YEAR_MAX) { setEditAllError(yearRangeError); return }
    const duplicate = (allClientPeriods[cid] || []).find(p => p.id !== periodId && p.bs_year === year && p.bs_month === month)
    if (duplicate) { setEditAllError('A period for this month already exists.'); return }
    setSavingAll(true)
    const { error } = await scopedUpdateRaw('monthly_periods', cid, { bs_year: year, bs_month: month }).eq('id', periodId).eq('status', 'open')
    // `errorLine`, not `error.message` — the sentence leads and the raw `code · message` rides
    // along in parentheses (S619). These three edit paths were the ones S682's alert sweep did
    // not reach. `.message` is also optional-chained: a fetch that never reached Postgres has no
    // message, and `.includes` on undefined throws inside the very handler meant to report it.
    if (error) { setEditAllError(/unique/i.test(error.message || '') ? 'A period for this month already exists.' : errorLine(error, 'operator')) }
    else { setEditingAllClientId(null); await loadAllClientPeriods() }
    setSavingAll(false)
  }

  async function loadPeriods() {
    setLoading(true)
    const { data, error } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
    // A failed read used to render the "No periods yet" empty state — on the page every empty
    // IMS page links to, so an auth stall told a new owner they had no periods (S682).
    if (error) { setLoadError(error); setLoading(false); return }
    setLoadError(null)
    setPeriods(data || [])
    setLoading(false)
  }

  async function createPeriod() {
    if (!clientId) { setError('No client selected. Pick a client in the top-left switcher before creating a period.'); return }
    const year = parseInt(form.bs_year)
    const month = parseInt(form.bs_month)
    // Both inline edit paths validated the year and this one — the path that MINTS a period —
    // did not, so a cleared field posted NaN and came back as a Postgres type error.
    if (!year || year < YEAR_MIN || year > YEAR_MAX) { setError(yearRangeError); return }
    setError('')
    setCreating(true)
    const { error } = await scopedInsert('monthly_periods', {
      bs_year: year,
      bs_month: month,
      status: 'open'
    })
    if (error) {
      // Two distinct unique constraints can fire here — the message must distinguish them, or
      // trying to open a new period while a DIFFERENT month is already open would confusingly
      // say "a period for THIS month already exists" (the wrong constraint's message).
      setError(
        (error.message || '').includes('one_open_per_client') ? 'A period is already open for this client. Close it before opening another.'
          : /unique/i.test(error.message || '') ? 'A period for this month already exists.'
          : errorLine(error, 'operator')
      )
    } else {
      setShowForm(false)
      loadPeriods()
    }
    setCreating(false)
  }

  async function closeAndAdvance(period) {
    const nextMonth = period.bs_month === 12 ? 1 : period.bs_month + 1
    const nextYear  = period.bs_month === 12 ? period.bs_year + 1 : period.bs_year
    const hrOn = !!clientModules?.hr
    // The two preflights are each bounded at 10s by withTimeout, so on a bad connection this
    // await is ten seconds long — and it runs BEFORE the dialog appears. The admin paths show
    // "Working…" through it (setActionClientId); this one, the Owner's month-end button, showed
    // nothing at all, so pressing it looked like nothing happening.
    setNotice(null)
    setCloseBusy(true)
    const notes = await closeNotes(period, clientId || profile?.client_id, hrOn)
    setCloseBusy(false)
    setPendingConfirm({
      title: `Close ${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`,
      confirmLabel: 'Close & Start Next',
      danger: notes.some(n => n?.danger),
      body: <CloseConfirmBody main={`${locksSentence(period, hrOn, 'client')} and ${BS_MONTHS[nextMonth - 1]} ${nextYear} opens. Closing stock carries forward as the new month's opening stock, and the frozen Monthly Report for ${BS_MONTHS[period.bs_month - 1]} is generated from the figures as they stand now.`} notes={notes} />,
      run: () => performCloseAndAdvance(period),
    })
  }

  async function performCloseAndAdvance(period) {
    setCloseBusy(true)
    try {
      const result = await performPeriodClose({ clientId: clientId || profile?.client_id, period, openNext: true, actorId: profile?.id })
      surfaceCloseFailures(result, period)
      // "Report is ready" only when it is — a failed generation used to show this banner anyway.
      if (result.reportSaved) setJustClosedReport({ bsYear: period.bs_year, bsMonth: period.bs_month })
      await loadPeriods()
    } finally {
      // performPeriodClose is contractually non-throwing, but a stuck busy flag would leave the
      // month with no way to close it — the finally costs nothing and removes that branch.
      setCloseBusy(false)
    }
  }

  async function reopenPeriod(id) {
    // monthly_periods_one_open_per_client (a partial unique index on client_id WHERE status='open')
    // blocks this whenever a later period is already open — which is virtually always true, since
    // the only real reason to reopen a PAST period is to fix a mistake discovered after the client
    // already moved on to the current one. Previously this error was silently swallowed, so the
    // button looked broken with zero explanation. Surfaced here; "Resync Opening Stock" below is
    // the actual fix for that scenario — it doesn't touch status at all, so it can never hit this.
    setNotice(null)
    const { error } = await scopedUpdate('monthly_periods', { status: 'open' }).eq('id', id)
    if (error) {
      if (error.code === '23505' || error.message?.includes('one_open_per_client')) {
        fail('Can\'t reopen — a more recent period is already open for this client (only one period can be open at a time). You do not need to: as admin, a closed period is still editable. Use "Add missing bills" on this row for a purchase bill that was missed, edit Stock Count or Sales for this month directly, and use "Resync Opening Stock" to push a corrected closing count into whatever period comes next. Reopening is only needed to hand entry back to the client\'s own logins.')
      } else {
        fail('This period was not reopened — it is still closed.', error)
      }
      return
    }
    loadPeriods()
  }

  // Admin-only correction path that never touches status, so it can never collide with
  // monthly_periods_one_open_per_client — admin can already edit a closed period's Closing Stock
  // directly (Stock.js's isLocked is `!isAdmin && closed`), this just re-runs the same carry-
  // forward a normal Close & Start Next would have done, into whichever period comes right after.
  // Posts POS bills that closed while no period existed for their date. Idempotent: it only ever
  // reads bills whose ims_posted_at is still NULL, so running it twice cannot double-post.
  async function runPosBackfill(period) {
    const label = `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`
    // try/catch/FINALLY, and every await bounded. Without the finally, a throw anywhere below
    // left the button stuck on "Posting…" forever with no error shown — and without withTimeout,
    // a supabase-js call that hangs never settles at all, so even the finally would never run
    // (see CLAUDE.md: .abortSignal() does not save you, only a wall clock does). Found the hard
    // way immediately after shipping this button.
    setNotice(null)
    setBackfillBusy(period.id)
    try {
      const waiting = await withTimeout(
        countUnpostedForPeriod({ supabase, scopedFrom, period }), 20000, 'Checking for unposted bills')
      if (waiting === 0) {
        ok(`No unposted POS bills for ${label} — everything the till sold that month is already in Inventory.`)
        return
      }
      setPendingConfirm({
        title: 'Post POS bills into Inventory',
        confirmLabel: `Post ${waiting} bill${waiting === 1 ? '' : 's'}`,
        body: `${waiting} POS bill${waiting === 1 ? '' : 's'} from ${label} post${waiting === 1 ? 's' : ''} into Inventory — their revenue and ingredient usage are added to this period, so Inventory reports and stock levels catch up with what the till already sold.`,
        run: () => performPosBackfill(period, label),
      })
    } catch (err) {
      console.error('POS backfill failed:', err)
      fail(`Could not post POS bills for ${label}. Nothing was left half-written — a bill is only stamped once its revenue has landed, so re-running picks up wherever it stopped.`, err)
    } finally {
      setBackfillBusy(null)
    }
  }

  async function performPosBackfill(period, label) {
    setBackfillBusy(period.id)
    try {
      // Generous: this walks every unposted bill, exploding recipes and writing two tables per
      // order, so a large backfill is legitimately slow — but it must still end.
      const { posted, skipped, error } = await withTimeout(
        backfillPosOrdersToIms({ supabase, scopedFrom, scopedInsert, scopedUpdate, period }),
        120000, 'Posting POS bills')
      if (error) { fail(`The POS bills for ${label} were not posted — re-running picks up wherever it stopped.`, error); return }
      ok(
        `Posted ${posted} bill${posted === 1 ? '' : 's'} into ${label}.` +
        (skipped > 0 ? ` ${skipped} skipped (nothing to post, or the write failed — check the browser console).` : '')
      )
    } catch (err) {
      console.error('POS backfill failed:', err)
      fail(`Could not post POS bills for ${label}. Nothing was left half-written — a bill is only stamped once its revenue has landed, so re-running picks up wherever it stopped.`, err)
    } finally {
      setBackfillBusy(null)
    }
  }

  async function resyncOpeningStock(period) {
    setNotice(null)
    const nextMonth = period.bs_month === 12 ? 1 : period.bs_month + 1
    const nextYear  = period.bs_month === 12 ? period.bs_year + 1 : period.bs_year
    const { data: nextPeriod, error: nextErr } = await scopedFrom('monthly_periods', 'id')
      .eq('bs_year', nextYear).eq('bs_month', nextMonth).maybeSingle()
    // A failed read is not "no period exists" — that sentence is a confident claim about the data,
    // and it was being made on a dropped connection (S682).
    if (nextErr) {
      fail(`Could not check whether a ${BS_MONTHS[nextMonth - 1]} ${nextYear} period exists, so nothing was synced. Try again.`, nextErr)
      return
    }
    if (!nextPeriod) {
      fail(`No ${BS_MONTHS[nextMonth - 1]} ${nextYear} period exists yet for this client — nothing to sync into.`)
      return
    }
    const fromLabel = `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}`
    const toLabel = `${BS_MONTHS[nextMonth - 1]} ${nextYear}`
    setPendingConfirm({
      title: 'Resync Opening Stock',
      confirmLabel: 'Overwrite & Resync',
      danger: true,
      body: `${fromLabel}'s closing stock copies into ${toLabel}'s opening stock. ${toLabel}'s existing opening stock is overwritten for every item that has a closing count in ${fromLabel}.`,
      run: async () => {
        const { error } = await carryForwardOpeningStock(period.id, nextPeriod.id)
        if (error) fail(`${toLabel}'s opening stock was not re-synced — it still holds whatever it had before. Try again.`, error)
        else ok(`Opening stock re-synced into ${toLabel} from ${fromLabel}'s closing count.`)
      },
    })
  }

  function startEdit(p) {
    setEditingId(p.id)
    setEditForm({ bs_year: p.bs_year, bs_month: p.bs_month })
    setEditError('')
  }

  function cancelEdit() {
    setEditingId(null)
    setEditError('')
  }

  async function saveEdit(id) {
    setEditError('')
    const year = parseInt(editForm.bs_year)
    const month = parseInt(editForm.bs_month)

    if (!year || year < YEAR_MIN || year > YEAR_MAX) {
      setEditError(yearRangeError)
      return
    }

    // Check for duplicate (exclude current row)
    const duplicate = periods.find(
      p => p.id !== id && p.bs_year === year && p.bs_month === month
    )
    if (duplicate) {
      setEditError('A period for this month already exists.')
      return
    }

    setSaving(true)
    const { error } = await scopedUpdate('monthly_periods', { bs_year: year, bs_month: month })
      .eq('id', id)
      .eq('status', 'open') // safety guard — DB-level protection

    if (error) {
      setEditError(/unique/i.test(error.message || '') ? 'A period for this month already exists.' : errorLine(error, 'operator'))
    } else {
      setEditingId(null)
      loadPeriods()
    }
    setSaving(false)
  }

  // Archive: hide closed periods older than 12 months by default
  function isRecent(p) {
    const monthsAgo = (bsToday.year - p.bs_year) * 12 + (bsToday.month - p.bs_month)
    return monthsAgo <= 12
  }
  // Periods is a shared cross-module page — an HR-only or POS-only client has periods too — and
  // hasImsAccess() returns false for EVERYONE but admin once ims_enabled is off (AuthContext),
  // so the IMS rank alone would lock a POS-only client's own Owner out of their own periods.
  //
  // The previous shape carved that out by skipping the check entirely when IMS is off, which
  // left the page role-LESS for exactly those clients: the nav item is tagged
  // minImsRole:'supervisor', but a pos_role:'staff' waiter who typed /periods got in, and got
  // the "Post POS bills to Inventory" button with it — a write into sales_entries and
  // stock_movements, and backfillPosToIms.js carries no check of its own. That is the S601
  // shape: a page reachable by URL needs the guard its nav item implies, and a gate that is
  // conditional on a module can be no gate at all for the clients without it. Fall back to the
  // rank the module system always has an answer for (admin/Owner) instead of to nothing.
  if (!isAdmin && !isOwner && !hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  const visiblePeriods = showAll ? periods : periods.filter(p => p.status === 'open' || isRecent(p))
  const archivedCount  = periods.length - visiblePeriods.length

  const openCount   = periods.filter(p => p.status === 'open').length
  const openPeriod  = periods.find(p => p.status === 'open')
  const periodExpired = !isAdmin && openPeriod && (
    openPeriod.bs_year < bsToday.year ||
    (openPeriod.bs_year === bsToday.year && openPeriod.bs_month < bsToday.month)
  )
  const nextAdvMonth = openPeriod ? (openPeriod.bs_month === 12 ? 1 : openPeriod.bs_month + 1) : null

  // Rendered in BOTH returns below — this page has two (admin all-clients view and the per-client
  // view), and a modal that lives in only one of them silently never opens from the other (the
  // S578 PosOrders two-returns trap).
  const confirmModalEl = pendingConfirm && (
    <ConfirmModal
      title={pendingConfirm.title}
      confirmLabel={pendingConfirm.confirmLabel}
      danger={pendingConfirm.danger}
      onCancel={() => setPendingConfirm(null)}
      onConfirm={() => { const run = pendingConfirm.run; setPendingConfirm(null); run() }}
    >
      {pendingConfirm.body}
    </ConfirmModal>
  )

  const noticeEl = !notice ? null : notice.kind === 'error'
    ? <ActionError error={{ text: notice.text, detail: notice.detail }} />
    : (
      <div className="card" role="status" style={{ marginBottom: 16, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: 'var(--theme-text1)' }}>
        <span style={{ flex: 1 }}>{notice.text}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotice(null)}>Dismiss</button>
      </div>
    )

  // ── Admin all-clients view ───────────────────────────────────────────────
  if (isAdmin && !clientId) {
    const needsAttention = allClients.filter(c => {
      if (!c.is_active) return false
      const cp = allClientPeriods[c.id] || []
      const open = cp.find(p => p.status === 'open')
      if (!open) return true
      return open.bs_year < bsToday.year || (open.bs_year === bsToday.year && open.bs_month < bsToday.month)
    })

    return (
      <div>
        <div className="page-header">
          <div>
            <h1 className="page-title">Periods</h1>
            <p className="page-subtitle">
              Manage BS periods across all properties
              {needsAttention.length > 0 && (
                <span style={{ marginLeft: 12, color: 'var(--theme-amber-text)', fontWeight: 600 }}>
                  · {needsAttention.length} need{needsAttention.length === 1 ? 's' : ''} attention
                </span>
              )}
            </p>
          </div>
        </div>

        {noticeEl}

        <div className="card" style={{ padding: 0 }}>
          {allLoading ? (
            <p style={{ padding: 20, color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Open Period</th>
                    <th>Status</th>
                    <th>Total</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {allClients.map(c => {
                    const cp = allClientPeriods[c.id] || []
                    const openPeriod = cp.find(p => p.status === 'open')
                    const expired = openPeriod && (
                      openPeriod.bs_year < bsToday.year ||
                      (openPeriod.bs_year === bsToday.year && openPeriod.bs_month < bsToday.month)
                    )
                    const isWorking = actionClientId === c.id
                    const isEditingThis = editingAllClientId === c.id

                    return (
                      <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.45 }}>
                        <td>
                          <button
                            onClick={() => { switchAdminClient(c.id, c.name); navigate('/periods') }}
                            style={{ background: 'none', border: 'none', color: 'var(--theme-text1)', fontWeight: 600, cursor: 'pointer', fontSize: 13, padding: 0, textAlign: 'left' }}
                          >
                            {c.name}
                          </button>
                        </td>

                        {isEditingThis ? (
                          <td colSpan={2}>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <input aria-label="BS year"
                                type="number" value={editAllForm.bs_year}
                                onChange={e => setEditAllForm(f => ({ ...f, bs_year: e.target.value }))}
                                min={YEAR_MIN} max={YEAR_MAX}
                                style={{ width: 90, padding: '4px 8px', fontSize: 13, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', color: 'var(--theme-text1)' }}
                              />
                              <select aria-label="BS month"
                                value={editAllForm.bs_month}
                                onChange={e => setEditAllForm(f => ({ ...f, bs_month: parseInt(e.target.value) }))}
                                style={{ padding: '4px 8px', fontSize: 13, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', color: 'var(--theme-text1)' }}
                              >
                                {BS_MONTHS.map((m, i) => <option key={i} value={i + 1}>{i + 1} — {m}</option>)}
                              </select>
                              {editAllError && <span style={{ color: 'var(--theme-red-text)', fontSize: 11 }}>{editAllError}</span>}
                            </div>
                          </td>
                        ) : (
                          <>
                            <td style={{ color: expired ? 'var(--theme-amber-text)' : 'var(--theme-text1)' }}>
                              {openPeriod ? `${BS_MONTHS[openPeriod.bs_month - 1]} ${openPeriod.bs_year}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                            </td>
                            <td>
                              {openPeriod
                                ? expired
                                  ? <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-xs)', color: 'var(--theme-amber-text)', background: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)' }}>EXPIRED</span>
                                  : <span className="badge badge-green">OPEN</span>
                                : <span className="badge badge-gray">NO PERIOD</span>
                              }
                            </td>
                          </>
                        )}

                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{cp.length}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                            {isEditingThis ? (
                              <>
                                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 10px' }}
                                  onClick={() => { setEditingAllClientId(null); setEditAllError('') }} disabled={savingAll}>
                                  Cancel
                                </button>
                                <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 10px' }}
                                  onClick={() => saveAllEdit(openPeriod.id, c.id)} disabled={savingAll}>
                                  {savingAll ? 'Saving…' : 'Save'}
                                </button>
                              </>
                            ) : isWorking ? (
                              <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Working…</span>
                            ) : (
                              <>
                                {openPeriod && (
                                  <button
                                    title="Edit period"
                                    onClick={() => { setEditingAllClientId(c.id); setEditAllForm({ bs_year: openPeriod.bs_year, bs_month: openPeriod.bs_month }); setEditAllError('') }}
                                    style={{ fontSize: 13, padding: '4px 9px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: 'color-mix(in srgb, var(--theme-accent) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 35%, transparent)', color: 'var(--theme-accent-ink)' }}
                                  >✏</button>
                                )}
                                {openPeriod ? (
                                  <>
                                    <button
                                      onClick={() => adminCloseAndAdvance(openPeriod, c.id)}
                                      style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: 'color-mix(in srgb, var(--theme-red) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 30%, transparent)', color: 'var(--theme-red-text)' }}
                                    >
                                      Close & Start Next
                                    </button>
                                    <button
                                      onClick={() => adminEndPeriod(openPeriod, c.id)}
                                      // Was three undocumented reds (rgba(127,29,29), rgba(185,28,28), #b91c1c) — a
                                      // second red with no home in the palette. Now the documented alpha-tint pattern:
                                      // tinted fill and border off --theme-red, text on the contrast-safe variant.
                                      style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: 'color-mix(in srgb, var(--theme-red) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 35%, transparent)', color: 'var(--theme-red-text)' }}
                                    >
                                      End Period
                                    </button>
                                    <Tip text="Closes this period without opening the next one. The client will be blocked from recording data until a new period is created." width={240}>ⓘ</Tip>
                                  </>
                                ) : (
                                  <button
                                    onClick={() => adminCreatePeriod(c.id)}
                                    style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: 'color-mix(in srgb, var(--theme-green) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 30%, transparent)', color: 'var(--theme-green-text)' }}
                                  >
                                    + Create Period
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {confirmModalEl}
      </div>
    )
  }

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Periods</h1>
          <p className="page-subtitle">One period per BS month — all inventory entries are linked to a period</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {archivedCount > 0 && (
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setShowAll(v => !v)}>
              {showAll ? '▴ Hide Archived' : `▾ Show Archived (${archivedCount})`}
            </button>
          )}
          {isAdmin && (
            <button className="btn btn-primary" onClick={() => { setShowForm(!showForm); setError('') }}>
              + New Period
            </button>
          )}
        </div>
      </div>

      {isAdmin && showForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 20px', fontSize: 15, color: 'var(--theme-text1)' }}>Create Period</h3>
          <div className="form-grid form-grid-2" style={{ maxWidth: 400 }}>
            <div className="form-field">
              <label htmlFor="per-bs-year"><Tip text="Bikram Sambat year. Nepal fiscal year runs Shrawan (month 4) to Ashadh (month 3) of the following BS year." width={270}>BS Year</Tip></label>
              <input
                id="per-bs-year"
                type="number"
                value={form.bs_year}
                onChange={e => setForm({ ...form, bs_year: e.target.value })}
                min={YEAR_MIN} max={YEAR_MAX}
              />
            </div>
            <div className="form-field">
              <label htmlFor="per-bs-month"><Tip text="Bikram Sambat month (1 = Baisakh … 12 = Chaitra). One period per month — purchases, stock, and sales are all scoped to this period." width={280}>BS Month</Tip></label>
              <select id="per-bs-month" value={form.bs_month} onChange={e => setForm({ ...form, bs_month: e.target.value })}>
                {BS_MONTHS.map((m, i) => (
                  <option key={i} value={i + 1}>{i + 1} — {m}</option>
                ))}
              </select>
            </div>
          </div>
          {error && <p style={{ color: 'var(--theme-red-text)', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createPeriod} disabled={creating}>
              {creating ? 'Creating…' : 'Create Period'}
            </button>
          </div>
        </div>
      )}

      {periodExpired && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 4%, transparent)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <div>
              <p style={{ color: 'var(--theme-amber-text)', margin: 0, fontSize: 14, fontWeight: 600 }}>
                ◷ {BS_MONTHS[openPeriod.bs_month - 1]} {openPeriod.bs_year} has ended
              </p>
              <p style={{ color: 'var(--theme-text2)', margin: '4px 0 0', fontSize: 12 }}>
                Finish your month-end stock count, then close this period and open {BS_MONTHS[nextAdvMonth - 1]}.
              </p>
            </div>
            {/* Inline-styled, so it escapes `.btn:disabled`'s shared treatment (design-system.md)
                — the disabled look has to be stated here. `aria-busy` is the in-flight signal for
                the one button just pressed. */}
            <button
              onClick={() => closeAndAdvance(openPeriod)}
              disabled={closeBusy}
              aria-busy={closeBusy}
              style={{
                flexShrink: 0, background: 'color-mix(in srgb, var(--theme-amber) 12%, transparent)',
                border: '1px solid color-mix(in srgb, var(--theme-amber) 40%, transparent)', color: 'var(--theme-amber-text)',
                borderRadius: 'var(--radius-sm)', padding: '8px 18px',
                cursor: closeBusy ? 'default' : 'pointer', opacity: closeBusy ? 0.55 : 1,
                fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap'
              }}
            >
              {closeBusy
                ? 'Working…'
                : `End ${BS_MONTHS[openPeriod.bs_month - 1]} & Start ${BS_MONTHS[nextAdvMonth - 1]} →`}
            </button>
          </div>
        </div>
      )}

      {justClosedReport && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
            <p style={{ color: 'var(--theme-text1)', margin: 0, fontSize: 13 }}>
              Report for {BS_MONTHS[justClosedReport.bsMonth - 1]} {justClosedReport.bsYear} is ready.
            </p>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 14px' }} onClick={() => navigate('/owner-report')}>
                View Report →
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 10px' }} onClick={() => setJustClosedReport(null)} aria-label="Dismiss">×</button>
            </div>
          </div>
        </div>
      )}

      {/* Unreachable under monthly_periods_one_open_per_client, the partial unique index added
          2026-07-13 — and kept deliberately rather than deleted. The wording is the tell that it
          predates the index ("it's recommended"), and if a second open row ever does appear, the
          app breaks quietly (every page resolves the current period with a bare
          `.eq('status','open').limit(1).single()`), so a page that says so is worth its 6 lines.
          See .claude/rules/closed-periods.md. */}
      {openCount > 1 && (
        <div className="card" style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--theme-amber) 30%, transparent)' }}>
          <p style={{ color: 'var(--theme-amber-text)', fontSize: 13, margin: 0 }}>
            ⚠ You have {openCount} open periods. It's recommended to keep only one open at a time.
          </p>
        </div>
      )}

      {noticeEl}

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
        ) : loadError ? (
          <ReportLoadError error={loadError} />
        ) : periods.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">◷</div>
            <p className="empty-state-text">No periods yet. Create one to start tracking inventory.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Period</th>
                  <th><Tip text="Bikram Sambat year this period belongs to." width={200}>BS Year</Tip></th>
                  <th><Tip text="Bikram Sambat month (1 = Baisakh … 12 = Chaitra)." width={220}>BS Month</Tip></th>
                  <th><Tip text="Open: data entry is active. Closed: period is locked — no further purchases, stock, or sales can be added." width={280}>Status</Tip></th>
                  <th><Tip text="Date the period was created in the system." width={200}>Created</Tip></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {visiblePeriods.map(p => {
                  const isEditing = editingId === p.id
                  const canEdit = p.status === 'open' // both admin and client can edit open periods

                  return (
                    <tr key={p.id}>
                      {isEditing ? (
                        <>
                          {/* Inline edit row */}
                          <td colSpan={3}>
                            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                              <input aria-label="BS year"
                                type="number"
                                value={editForm.bs_year}
                                onChange={e => setEditForm({ ...editForm, bs_year: e.target.value })}
                                min={YEAR_MIN} max={YEAR_MAX}
                                style={{
                                  width: 90, padding: '4px 8px', fontSize: 13,
                                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                  borderRadius: 'var(--radius-sm)', color: 'var(--theme-text1)'
                                }}
                              />
                              <select aria-label="BS month"
                                value={editForm.bs_month}
                                onChange={e => setEditForm({ ...editForm, bs_month: parseInt(e.target.value) })}
                                style={{
                                  padding: '4px 8px', fontSize: 13,
                                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                  borderRadius: 'var(--radius-sm)', color: 'var(--theme-text1)'
                                }}
                              >
                                {BS_MONTHS.map((m, i) => (
                                  <option key={i} value={i + 1}>{i + 1} — {m}</option>
                                ))}
                              </select>
                              {editError && (
                                <span style={{ color: 'var(--theme-red-text)', fontSize: 12 }}>{editError}</span>
                              )}
                            </div>
                          </td>
                          <td>
                            <span className="badge badge-green">OPEN</span>
                          </td>
                          <td style={{ color: 'var(--theme-text2)' }}>
                            {createdLabel(p.created_at)}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 12, padding: '5px 12px' }}
                                onClick={cancelEdit}
                              >
                                Cancel
                              </button>
                              <button
                                className="btn btn-primary"
                                style={{ fontSize: 12, padding: '5px 12px' }}
                                onClick={() => saveEdit(p.id)}
                                disabled={saving}
                              >
                                {saving ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </td>
                        </>
                      ) : (
                        <>
                          {/* Normal display row */}
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                            {BS_MONTHS[p.bs_month - 1]} {p.bs_year}
                          </td>
                          <td>{p.bs_year}</td>
                          <td>{BS_MONTHS[p.bs_month - 1]}</td>
                          <td>
                            {p.status === 'open' ? (
                              <span className="badge badge-green">OPEN</span>
                            ) : (
                              <span className="badge badge-red">CLOSED</span>
                            )}
                          </td>
                          <td style={{ color: 'var(--theme-text2)' }}>
                            {createdLabel(p.created_at)}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
                              {/* Edit pencil — open periods, admin only */}
                              {canEdit && isAdmin && (
                                <button
                                  className="btn btn-ghost"
                                  title="Edit period"
                                  style={{ fontSize: 13, padding: '5px 10px', lineHeight: 1, color: 'var(--theme-accent-ink)', borderColor: 'color-mix(in srgb, var(--theme-accent) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-accent) 7%, transparent)' }}
                                  onClick={() => startEdit(p)}
                                >
                                  ✏
                                </button>
                              )}
                              {/* Backfills POS bills whose revenue and stock never reached IMS
                                  because no period was open for their date (S573). Available on
                                  any period, open or closed — the whole point is that the period
                                  didn't exist when the bills were rung. */}
                              {posEnabled && (
                                <Tip text="Posts POS bills from this month that closed while no Inventory period existed — their revenue and ingredient usage are missing from Inventory reports until this runs. Safe to run more than once; already-posted bills are skipped." width={300}>
                                  <button
                                    className="btn btn-ghost"
                                    style={{ fontSize: 12, padding: '5px 12px', color: 'var(--theme-amber-text)', borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)' }}
                                    onClick={() => runPosBackfill(p)}
                                    disabled={backfillBusy === p.id}
                                  >
                                    {backfillBusy === p.id ? 'Posting…' : 'Post POS bills to Inventory'}
                                  </button>
                                </Tip>
                              )}
                              {/* Close / Reopen / Resync — admin only */}
                              {isAdmin && (p.status === 'open' ? (
                                <button
                                  className="btn btn-ghost"
                                  style={{ fontSize: 12, padding: '5px 12px', color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-red) 7%, transparent)' }}
                                  onClick={() => closeAndAdvance(p)}
                                  disabled={closeBusy}
                                  aria-busy={closeBusy}
                                >
                                  {closeBusy ? 'Working…' : <>Close &amp; Start Next</>}
                                </button>
                              ) : (
                                <>
                                  {/* The answer to "reopen this month so I can enter a bill I
                                      missed". Reopening is blocked by
                                      monthly_periods_one_open_per_client whenever a later month is
                                      already open — which is exactly when a missing bill gets
                                      discovered — but admin never needed it: every IMS entry page
                                      locks on `!isAdmin && closed`, so a closed month is already
                                      writable for admin. All that was missing was a way in, since
                                      Purchases opens on the OPEN period by default. */}
                                  {clientModules?.ims && (
                                    <Tip text="Opens Purchases on this month so a bill that was missed at the time can still be entered. Closed months stay editable for admin, so this needs no reopening — and it works even when a later month is already open, which Reopen cannot." width={300}>
                                      <button
                                        className="btn btn-ghost"
                                        style={{ fontSize: 12, padding: '5px 12px' }}
                                        onClick={() => navigate(`/purchases?period=${p.id}`)}
                                      >
                                        Add missing bills →
                                      </button>
                                    </Tip>
                                  )}
                                  <Tip text="Fix a mistake in this closed period directly (Stock Count already lets admin edit a closed period), then use this to push the correction into the next period's opening stock — no reopening needed.">
                                    <button
                                      className="btn btn-ghost"
                                      style={{ fontSize: 12, padding: '5px 12px', color: 'var(--theme-accent-ink)', borderColor: 'color-mix(in srgb, var(--theme-accent) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-accent) 7%, transparent)' }}
                                      onClick={() => resyncOpeningStock(p)}
                                    >
                                      Resync Opening Stock →
                                    </button>
                                  </Tip>
                                  <Tip text="Hands data entry for this month back to the CLIENT'S own logins — blocked whenever a later period is already open (only one period can be open per client). Admin does not need it: use Add missing bills for a purchase that was missed, or Resync Opening Stock for a corrected count." width={300}>
                                    <button
                                      className="btn btn-ghost"
                                      style={{ fontSize: 12, padding: '5px 12px', color: 'var(--theme-green-text)', borderColor: 'color-mix(in srgb, var(--theme-green) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-green) 7%, transparent)' }}
                                      onClick={() => reopenPeriod(p.id)}
                                    >
                                      Reopen
                                    </button>
                                  </Tip>
                                </>
                              ))}
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {confirmModalEl}
    </div>
  )
}
