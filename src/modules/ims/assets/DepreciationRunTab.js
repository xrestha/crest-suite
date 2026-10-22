import { nprInt, npr } from '../../../shared/nepalMoney'
import { useMemo, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Tabs, { TabPanel } from '../../../components/Tabs'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import ActionError, { asActionError } from '../../../components/ActionError'
import FieldError, { fieldAria } from '../../../components/FieldError'
import QtyInput from '../../../components/QtyInput'
import {
  computeDepreciationPreview, bookPositionsByAsset, bookValue, effectiveDepreciation,
  regularOverrideError, adjustmentOverrideError, chargeGaps, addDaysIso, bsSpanLabel,
} from './depreciationCompute'
import { formatAdAsBs, bsToAd, daysInBsMonth, formatAd, getBsToday, getBsFiscalYear, getBsFiscalYearStart, BS_MONTHS } from '../../../utils/bsCalendar'
import { nepalBsLong, nepalTime } from '../../../shared/nepalTime'
import { settleWithin } from '../../../utils/withTimeout'
import { readRegister, answerLost, refusedWith, notActiveCodes, ASSET_CALL_MS } from './assetReads'

const fmt = nprInt
// Period dates are stored AD dates: shown as the BS date they fall on (S792, COSTS-11). `posted_at`
// is a timestamp, so it is dated in Nepal whatever the viewer's zone.
const fmtDate = d => formatAdAsBs(d)
const fmtPosted = ts => nepalBsLong(ts) || '—'

// An adjustment run is recorded through the same RPC as any other run; what marks it is its
// `notes`, which name the run it reverses. That is what lets the run picker say a run has already
// been reversed, and the overlap warning say a period's earlier run nets to nothing (S756).
const ADJ_PREFIX = 'Adjustment: reverses run '
const reversedIdOf = run => {
  const m = /^Adjustment: reverses run ([0-9a-f-]{36})/i.exec(run?.notes || '')
  return m ? m[1] : null
}
const runLabel = r => `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}`
const assetsText = n => `${n} asset${n === 1 ? '' : 's'}`

// S857: charging a period and reversing a run are two sections of this tab, each with its own form
// and table, so the row is a real tab list. It was a hand-rolled chip row (role="group" +
// aria-pressed), which told a screen reader it narrowed one view.
const RUN_TABS = [
  { key: 'regular', label: 'Depreciation run' },
  { key: 'adjust', label: 'Adjustment (reverse a run)' },
]

// What a payload charges in total: the override where one is set, else the computed figure. A
// reversal is all overrides, so its total is negative (depreciation written back).
const payloadTotal = payload => payload.reduce((s, l) => s + (l.override_amount != null ? l.override_amount : (l.depreciation_amount || 0)), 0)

// S849 (ASSETS-8): the period can be filled from a BS month (its 1st to its last day) or a whole
// fiscal year (1 Shrawan to the last day of Ashadh), instead of hunting both ends in the AD boxes.
// Months of this fiscal year so far and all of last year's, newest first; this year and the two
// before it. Built through formatAd, never toISOString on a bsToAd Date.
function periodPresets() {
  const today = getBsToday()
  const fy = getBsFiscalYearStart(today.year, today.month)
  const months = []
  let y = today.year, m = today.month
  while (getBsFiscalYearStart(y, m) >= fy - 1) {
    months.push({ value: `m:${y}:${m}`, label: `${BS_MONTHS[m - 1]} ${y}`, start: formatAd(bsToAd(y, m, 1)), end: formatAd(bsToAd(y, m, daysInBsMonth(y, m))) })
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
  }
  const years = [fy, fy - 1, fy - 2].map(f => ({
    value: `fy:${f}`, label: `FY ${getBsFiscalYear(f, 4)} (whole year)`,
    start: formatAd(bsToAd(f, 4, 1)), end: formatAd(bsToAd(f + 1, 3, daysInBsMonth(f + 1, 3))),
  }))
  return { years, months }
}

// The posted schedule, paged: one row per asset per run, so a client with 100 assets and monthly
// runs crosses the silent 1000-row cap inside a year — and a truncated read here would open every
// asset past the cut at its full cost, in a preview that can be POSTED (S756). The id tiebreaker
// is what paging needs. Book values come from bookPositionsByAsset(), which sums every row, so
// the order no longer picks anything (S792, COSTS-2).
function readPostedSchedule(scopedFrom) {
  return fetchAllRows(() => scopedFrom('assets_depreciation_schedule')
    .eq('is_posted', true)
    .order('period_end', { ascending: true }).order('created_at', { ascending: true }).order('id'))
}

// Preview (pure computation, writes nothing) -> Post (manager-only, writes via one atomic RPC,
// locks the resulting rows). Deliberately never uses sessionDataCache — a preview must always
// compute from live, current data right before a Post, never a stale cached baseline (the same
// "batch action trusting on-screen state" risk flagged for Stock.js's Save All).
export default function DepreciationRunTab({ assets, onReload, onOpenTab }) {
  const { clientId, hasImsAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  // 'regular' charges a period; 'adjust' reverses a posted run (D24, S756). Posted rows are
  // immutable in the database, so a reversal is the only correction the books can carry.
  const [mode, setMode] = useState('regular')
  // Stored AD date strings, as before. BsCalendarPicker picks a BS day and hands back
  // formatAd(bsToAd(...)) (S857): a BS product had asked for these two in AD boxes.
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [lines, setLines] = useState(null)
  const [loading, setLoading] = useState(false)
  const [posting, setPosting] = useState(false)
  // S857: what the last post wrote (amount, assets, BS period, which kind), for the success panel.
  // It was a 12px green "Posted" beside the button, which said neither what nor what next.
  const [posted, setPosted] = useState(null)
  // Errors moved out of `msg` and into their own state (S658): the toolbar span they shared is one
  // line beside the Post button, which is fine for "Posted — schedule locked" and much too small
  // for a failure that has to say what happened AND carry its technical detail.
  const [err, setErr] = useState(null)
  // Adjustment mode: the posted runs to choose from, and the one chosen.
  const [runs, setRuns] = useState(null)
  const [runId, setRunId] = useState('')
  const [adjReason, setAdjReason] = useState('')
  const [adjSkipped, setAdjSkipped] = useState([])
  // S849 (ASSETS-12): the register as each preview read it. The list the page loaded at open can be
  // hours old; a run built from it could charge an asset disposed of in another tab since.
  const [register, setRegister] = useState(null)
  // ASSETS-17: after a post whose answer never arrived, what a fresh read found posted.
  const [recheck, setRecheck] = useState(null)
  const presets = useMemo(() => periodPresets(), [])

  const canPost = hasImsAccess('manager')
  const assetsById = Object.fromEntries((register || assets).map(a => [a.id, a]))
  const reversedIds = new Set((runs || []).map(reversedIdOf).filter(Boolean))
  const chosenRun = (runs || []).find(r => r.id === runId) || null

  function switchMode(next) {
    if (next === mode) return
    setMode(next); setLines(null); setPosted(null); setErr(null); setAdjSkipped([]); setRecheck(null)
    if (next === 'adjust' && runs === null) loadRuns()
  }

  // After a reversal: the right figures for the same dates, as a normal run, from the success panel.
  function startCorrectRun(p) {
    switchMode('regular')
    setPeriodStart(p.start); setPeriodEnd(p.end)
  }

  async function loadRuns() {
    const { data, error } = await settleWithin(fetchAllRows(() => scopedFrom('assets_depreciation_runs', 'id, period_start, period_end, posted_at, notes, created_at')
      .eq('status', 'posted')
      .order('period_end', { ascending: false }).order('created_at', { ascending: false }).order('id')), ASSET_CALL_MS, 'Reading the posted runs')
    if (error) {
      const a = asActionError(error)
      setErr({ text: 'Could not read the posted depreciation runs, so there is nothing to choose a reversal from. Try again. ' + a.text, detail: a.detail })
      return
    }
    setRuns(data || [])
  }

  // Fills both boxes from a BS month or fiscal year (ASSETS-8), and drops a preview built for others.
  function fillPeriod(value) {
    const pick = [...presets.years, ...presets.months].find(x => x.value === value)
    if (!pick) return
    setPeriodStart(pick.start); setPeriodEnd(pick.end); setLines(null); setErr(null); setPosted(null)
  }

  async function preview() {
    if (!periodStart || !periodEnd) { setErr('Pick both a period start and end date before previewing the run.'); return }
    if (periodEnd < periodStart) { setErr('The period end is before its start. Swap the two dates.'); return }
    setLoading(true); setPosted(null); setErr(null); setRecheck(null)

    // ASSETS-12: the register is read again with the posted schedule, so the run is built from the
    // assets that are active NOW. Both bounded (ASSETS-15).
    const [{ data: postedRows, error: postedErr }, { data: freshAssets, error: registerErr }] = await Promise.all([
      settleWithin(readPostedSchedule(scopedFrom), ASSET_CALL_MS, 'Reading the posted depreciation'),
      settleWithin(readRegister(scopedFrom), ASSET_CALL_MS, 'Reading the asset register'),
    ])
    // A failed read used to compute every asset's opening NBV from cost — a preview that read as
    // a first-ever run and could be POSTED as one (S682). Refuse to compute instead.
    if (postedErr) {
      const a = asActionError(postedErr)
      setErr({ text: 'Could not read the posted depreciation runs, so no preview was computed — every opening figure would have been wrong. Try again. ' + a.text, detail: a.detail })
      setLoading(false)
      return
    }
    if (registerErr) {
      const a = asActionError(registerErr)
      setErr({ text: 'Could not read the asset register, so no preview was computed — the run would not know which assets are still active. Try again. ' + a.text, detail: a.detail })
      setLoading(false)
      return
    }
    setRegister(freshAssets || [])
    // Each asset opens at cost less everything posted against it, in whatever order it was posted
    // (S792, COSTS-2) — a back-dated run or a reversal for an earlier period included.
    const positions = bookPositionsByAsset(postedRows)

    const activeAssets = (freshAssets || []).filter(a => a.status === 'active')
    const byId = Object.fromEntries(activeAssets.map(a => [a.id, a]))
    const preview = computeDepreciationPreview({
      assets: activeAssets, positions, periodStart, periodEnd,
    })
    // ASSETS-8: the days before this period no run stands charged for, per asset. A gap ending the
    // day before the period is a month skipped (`lead`); one further back sits behind a later run
    // (`hole`), so only a run posted for those dates can charge it.
    const dayBefore = addDaysIso(periodStart, -1)
    setLines(preview.map(l => {
      const gaps = chargeGaps({ asset: byId[l.asset_id], position: positions[l.asset_id], upTo: dayBefore })
      return {
        ...l, override_amount: '', override_reason: '',
        lead: gaps.find(g => g.end === dayBefore) || null,
        holes: gaps.filter(g => g.end !== dayBefore),
      }
    }))
    setLoading(false)
  }

  // Adjustment preview: each line of the chosen run becomes a line whose override is minus what
  // that line charged, opening from the asset's CURRENT NBV (which may already include later runs).
  async function previewReversal() {
    if (!chosenRun) { setErr('Choose the posted run to reverse.'); return }
    setLoading(true); setPosted(null); setErr(null); setAdjSkipped([]); setRecheck(null)
    const [runRes, postedRes, registerRes] = await Promise.all([
      settleWithin(fetchAllRows(() => scopedFrom('assets_depreciation_schedule').eq('run_id', chosenRun.id).order('id')), ASSET_CALL_MS, 'Reading that run'),
      settleWithin(readPostedSchedule(scopedFrom), ASSET_CALL_MS, 'Reading the posted depreciation'),
      // ASSETS-12: which assets are still active is judged on the register as it is now.
      settleWithin(readRegister(scopedFrom), ASSET_CALL_MS, 'Reading the asset register'),
    ])
    const failed = runRes.error || postedRes.error || registerRes.error
    if (failed) {
      const a = asActionError(failed)
      setErr({ text: 'Could not read that run, the current book values or the register, so no reversal was computed. Try again. ' + a.text, detail: a.detail })
      setLoading(false)
      return
    }
    setRegister(registerRes.data || [])
    const freshById = Object.fromEntries((registerRes.data || []).map(a => [a.id, a]))
    const positions = bookPositionsByAsset(postedRes.data)
    const skipped = []
    const next = []
    for (const row of runRes.data || []) {
      const charged = effectiveDepreciation(row)
      if (Math.abs(charged) < 0.005) continue
      const asset = freshById[row.asset_id]
      // A disposed asset's gain or loss was struck against the NBV it had then. Writing its
      // depreciation back afterwards would move a book value the disposal already froze.
      if (!asset || asset.status !== 'active') { skipped.push(asset ? `${asset.asset_code} — ${asset.name}` : row.asset_id); continue }
      const opening = bookValue(asset, positions[row.asset_id])
      next.push({
        asset_id: row.asset_id,
        opening_nbv: opening,
        annual_depreciation: parseFloat(row.annual_depreciation) || 0,
        depreciation_amount: 0,
        closing_nbv: opening + charged,
        override_amount: -charged,
        override_reason: '',
        charged,
      })
    }
    setAdjSkipped(skipped)
    setAdjReason(r => r || `Reverses the run posted for ${runLabel(chosenRun)}`)
    setLines(next)
    setLoading(false)
  }

  function updateLine(assetId, field, value) {
    setLines(prev => prev.map(l => l.asset_id === assetId ? { ...l, [field]: value } : l))
  }

  const lineError = l => mode === 'adjust'
    ? adjustmentOverrideError({ override: l.override_amount, charged: l.charged })
    : regularOverrideError({ override: l.override_amount, openingNbv: l.opening_nbv, salvageValue: assetsById[l.asset_id]?.salvage_value })
  const anyLineError = (lines || []).some(l => lineError(l))
  const invalidOverride = mode === 'regular'
    ? (lines || []).some(l => l.override_amount !== '' && !l.override_reason?.trim())
    : !adjReason.trim()
  // S857: while one of these holds, Post is aria-disabled rather than disabled, so it keeps its
  // Tip and its focus, and pressing it says which one (post()). `disabled` is only for a post in flight.
  const postBlocked = !canPost || !lines || lines.length === 0 || anyLineError || invalidOverride

  function buildPayload() {
    return lines
      .map(l => {
        const override = l.override_amount === '' ? null : parseFloat(l.override_amount)
        if (mode === 'adjust' && !override) return null // 0 = leave this asset out of the reversal
        const closingNbv = override != null ? l.opening_nbv - override : l.closing_nbv
        return {
          asset_id: l.asset_id,
          opening_nbv: l.opening_nbv,
          annual_depreciation: l.annual_depreciation,
          depreciation_amount: l.depreciation_amount,
          override_amount: override,
          override_reason: mode === 'adjust' ? adjReason.trim() : (l.override_reason?.trim() || null),
          closing_nbv: Math.round(closingNbv * 100) / 100,
        }
      })
      .filter(Boolean)
  }

  async function post() {
    // S857: the button stays pressable while something is missing (aria-disabled), so every
    // precondition is answered here, in words, rather than by a button that does nothing.
    if (!canPost) { setErr('Only a Manager or Owner login can post a depreciation run. Ask one of them to post it.'); return }
    if (!lines || lines.length === 0) { setErr('There is nothing to post for this period.'); return }
    if (anyLineError) { setErr('Some lines have an amount outside what that line allows — the message under each one says the limit.'); return }
    if (invalidOverride) {
      setErr(mode === 'adjust'
        ? 'An adjustment needs a reason — it is what an auditor reads to understand why posted depreciation was reversed.'
        : 'Every line you have overridden needs a reason — the reason is what an auditor reads to understand why the computed figure was changed.')
      return
    }
    setPosted(null); setErr(null)

    // S857: every post asks first, in ONE dialog that names the money, the assets and the BS
    // period. A regular run with no overlap used to post at a single press, permanently: it was
    // the one irreversible write in Suite Pro without a confirm.
    const lockLine = (
      <p style={{ margin: 0 }}>
        Once posted, the run is locked. It cannot be edited afterwards; it can only be reversed by a new adjustment run.
      </p>
    )

    if (mode === 'adjust') {
      const payload = buildPayload()
      if (payload.length === 0) { setErr('Every line is set to 0, so there is nothing to reverse.'); return }
      const summary = { reversal: true, amount: -payloadTotal(payload), count: payload.length, start: chosenRun.period_start, end: chosenRun.period_end }
      askConfirm({
        title: 'Post this reversal?',
        danger: true,
        body: (
          <>
            <p style={{ margin: '0 0 8px' }}>
              This writes <strong>{npr(summary.amount)}</strong> of depreciation back onto <strong>{assetsText(summary.count)}</strong>,
              for <strong>{fmtDate(summary.start)} to {fmtDate(summary.end)}</strong>. The run it reverses stays on the record beside it.
            </p>
            {lockLine}
          </>
        ),
        confirmLabel: 'Post reversal',
        busyLabel: 'Posting…',
        run: () => submit(chosenRun.period_start, chosenRun.period_end, payload, `${ADJ_PREFIX}${chosenRun.id} (${chosenRun.period_start} to ${chosenRun.period_end})`, summary),
      })
      return
    }

    // A period can be posted twice, and each post charges its depreciation again, permanently —
    // the schedule is immutable and there is deliberately no unique period constraint, because a
    // correction is a new run. So look before posting and make a second charge a decision (S756).
    // The overlap is folded into the one confirm below rather than asked as a second question (S857).
    setPosting(true)
    const { data: overlapping, error: overlapErr } = await settleWithin(scopedFrom('assets_depreciation_runs', 'id, period_start, period_end, posted_at, notes')
      .eq('status', 'posted').lte('period_start', periodEnd).gte('period_end', periodStart)
      .order('period_start').order('id'), ASSET_CALL_MS, 'Checking for runs over these dates')
    setPosting(false)
    if (overlapErr) {
      // A check that could not run has not passed.
      const a = asActionError(overlapErr)
      setErr({ text: 'Could not check whether this period already has a posted run, so nothing was posted — posting twice charges the same depreciation twice. Try again. ' + a.text, detail: a.detail })
      return
    }
    const payload = buildPayload()
    const summary = { reversal: false, amount: payloadTotal(payload), count: payload.length, start: periodStart, end: periodEnd }
    const earlier = (overlapping || []).filter(r => !reversedIdOf(r))
    const reversedSet = new Set((overlapping || []).map(reversedIdOf).filter(Boolean))
    askConfirm({
      title: earlier.length > 0 ? 'This period already has depreciation posted' : 'Post this depreciation run?',
      danger: earlier.length > 0,
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            This posts <strong>{npr(summary.amount)}</strong> of depreciation on <strong>{assetsText(summary.count)}</strong>,
            for <strong>{fmtDate(summary.start)} to {fmtDate(summary.end)}</strong>.
          </p>
          {earlier.length > 0 && (
            <>
              <p style={{ margin: '0 0 8px' }}>These posted runs already cover some of the same dates:</p>
              <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
                {earlier.map(r => (
                  <li key={r.id}>
                    {runLabel(r)}, posted {fmtPosted(r.posted_at)}
                    {r.notes?.startsWith('Disposal:') ? ' (charged at a disposal)' : ''}
                    {reversedSet.has(r.id) ? ' — already reversed by an adjustment' : ''}
                  </li>
                ))}
              </ul>
              <p style={{ margin: '0 0 8px' }}>
                Posting now charges the overlapping days again, on top of what is already there. If one of those runs was wrong, reverse it with an adjustment run first.
              </p>
            </>
          )}
          {lockLine}
        </>
      ),
      confirmLabel: earlier.length > 0 ? 'Post depreciation again' : 'Post depreciation',
      busyLabel: 'Posting…',
      run: () => submit(periodStart, periodEnd, payload, null, summary),
    })
  }

  async function submit(start, end, payload, notes, summary) {
    setPosting(true); setErr(null); setRecheck(null)
    const { error } = await settleWithin(supabase.rpc('post_asset_depreciation_run', {
      p_client_id: clientId, p_period_start: start, p_period_end: end,
      p_lines: payload, p_notes: notes,
    }), ASSET_CALL_MS, 'Posting the depreciation run')
    setPosting(false)
    if (error) {
      const { text, detail } = asActionError(error)
      // ASSETS-17: no answer is not a refusal — the server may have posted the run after the
      // connection dropped. Say so, and re-read what is posted, instead of "nothing was locked".
      if (answerLost(error)) {
        setErr({ text: 'The connection dropped before the server answered, so this run may have been posted. The runs below were re-read: check them before posting again.', detail })
        if (mode === 'adjust') loadRuns()
        else setLines(null)
        recheckRuns(start, end)
        onReload()
        return
      }
      if (refusedWith(error, 'dep_run_duplicate')) {
        setErr({ text: 'This run was posted moments ago (from this page or another), so it was not posted again.', detail })
        if (mode === 'adjust') loadRuns()
        recheckRuns(start, end)
        return
      }
      // ASSETS-12: an asset disposed of (or removed) in another tab since this page opened.
      if (refusedWith(error, 'dep_run_asset_not_active')) {
        const codes = notActiveCodes(error)
        const many = codes.includes(',')
        setErr({ text: `${codes || 'An asset in this run'} ${many ? 'were' : 'was'} disposed of or removed since this page opened, so nothing was posted. Press Preview again.`, detail })
        setLines(null)
        onReload()
        return
      }
      // An ims_rank refusal (S756: posting needs an IMS manager or the owner) is worded by the
      // error table; the consequence line stays true because the RPC is one transaction.
      setErr({ text: `The ${notes ? 'adjustment' : 'depreciation'} run was not posted, so nothing has been locked.

${text}`, detail })
      return
    }
    setPosted(summary)
    setLines(null)
    if (notes) { setRunId(''); setAdjReason(''); setAdjSkipped([]); loadRuns() }
    onReload()
  }

  // ASSETS-17: the posted runs covering these dates, re-read after a lost answer, shown under the error.
  async function recheckRuns(start, end) {
    const { data, error } = await settleWithin(scopedFrom('assets_depreciation_runs', 'id, period_start, period_end, posted_at, notes')
      .eq('status', 'posted').lte('period_start', end).gte('period_end', start)
      .order('posted_at').order('id'), ASSET_CALL_MS, 'Re-reading the posted runs')
    setRecheck({ start, end, runs: data || [], error: error ? asActionError(error, 'operator') : null })
  }

  const selectableRuns = (runs || []).filter(r => !reversedIdOf(r))
  // ASSETS-8: the earliest skipped day just before the period, over every line.
  const leadStart = mode === 'regular' && lines
    ? lines.reduce((min, l) => (l.lead && (!min || l.lead.start < min) ? l.lead.start : min), null)
    : null
  const leadCount = leadStart ? lines.filter(l => l.lead).length : 0

  return (
    <div>
      <Tabs
        idBase="deprec-mode"
        hasPanel
        label="Run type"
        style={{ marginBottom: 12 }}
        tabs={RUN_TABS}
        active={mode}
        onChange={switchMode}
      />

      <TabPanel idBase="deprec-mode" active={mode}>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {mode === 'regular' ? (
            <>
              <div className="form-field">
                <label htmlFor="deprec-fill"><Tip text="Fills Period Start and End with a whole BS month (its 1st to its last day) or a whole fiscal year (1 Shrawan to the last day of Ashadh)." width={280}>Fill from BS</Tip></label>
                <select id="deprec-fill" className="form-select" value="" onChange={e => fillPeriod(e.target.value)}>
                  <option value="">Choose a month or year…</option>
                  <optgroup label="Fiscal year">
                    {presets.years.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
                  </optgroup>
                  <optgroup label="Month">
                    {presets.months.map(x => <option key={x.value} value={x.value}>{x.label}</option>)}
                  </optgroup>
                </select>
              </div>
              {/* BS pickers (S857): the value stays the stored AD string, converted by the picker
                  through formatAd(bsToAd(...)), never toISOString. */}
              <div className="form-field">
                <label htmlFor="deprec-f1">Period Start</label>
                <BsCalendarPicker id="deprec-f1" value={periodStart} placeholder="Pick a BS date"
                  onChange={v => { setPeriodStart(v); setLines(null); setPosted(null) }} />
              </div>
              <div className="form-field">
                <label htmlFor="deprec-f2">Period End</label>
                <BsCalendarPicker id="deprec-f2" value={periodEnd} placeholder="Pick a BS date"
                  onChange={v => { setPeriodEnd(v); setLines(null); setPosted(null) }} />
              </div>
              <button className="btn btn-primary" onClick={preview} disabled={loading}>{loading ? 'Computing…' : 'Preview'}</button>
            </>
          ) : (
            <>
              <div className="form-field">
                <label htmlFor="deprec-run">Run to reverse</label>
                <select id="deprec-run" className="form-select" value={runId} onChange={e => { setRunId(e.target.value); setLines(null); setAdjReason('') }} disabled={runs === null}>
                  <option value="">{runs === null ? 'Loading…' : selectableRuns.length === 0 ? 'No posted runs' : 'Choose a posted run'}</option>
                  {selectableRuns.map(r => (
                    <option key={r.id} value={r.id} disabled={reversedIds.has(r.id)}>
                      {runLabel(r)} · posted {fmtPosted(r.posted_at)}{reversedIds.has(r.id) ? ' · already reversed' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ flex: 1, minWidth: 220 }}>
                <label htmlFor="deprec-adj-reason">Reason</label>
                <input id="deprec-adj-reason" className="form-input" value={adjReason} onChange={e => setAdjReason(e.target.value)} placeholder="Required — why this run is being reversed" />
              </div>
              {/* Pressable with no run chosen, so the press can say so (previewReversal). */}
              <button className="btn btn-primary" onClick={previewReversal} disabled={loading} aria-disabled={!runId ? 'true' : undefined}>{loading ? 'Computing…' : 'Preview reversal'}</button>
            </>
          )}
          {lines && (
            // S857: aria-disabled, not disabled, while something is missing: a disabled button
            // takes no focus, so its Tip (the one place saying why) was out of reach, and the
            // hand-faked opacity said nothing to a screen reader. The press now says what is missing.
            <Tip text={canPost ? 'Writes the schedule rows and locks them — corrections after this need a new adjustment run, never an edit to this one.' : 'Only a Manager or Owner login can post a depreciation run.'} width={280}>
              <button className="btn btn-primary" onClick={post} disabled={posting} aria-disabled={postBlocked ? 'true' : undefined}>
                {posting ? 'Posting…' : mode === 'adjust' ? 'Post reversal' : 'Post'}
              </button>
            </Tip>
          )}
        </div>
        {mode === 'adjust' && (
          <p className="page-footnote">
            Posted runs can never be edited. To correct one, reverse it here, then post the right figures as a normal depreciation run.
          </p>
        )}
        {mode === 'adjust' && adjSkipped.length > 0 && (
          <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--theme-amber-text)', lineHeight: 1.6 }}>
            △ Left out because they are no longer active — their disposal already fixed their book value: {adjSkipped.join(', ')}.
          </p>
        )}
        <ActionError error={err} />
        {/* S857: what was posted and what to do next, announced. The preview table closes on a
            post, so this is the only record on screen of what just became permanent. */}
        {posted && (
          <div role="status" className="note-banner" style={{ margin: '12px 0 0' }}>
            <strong>✓ {posted.reversal ? 'Reversal posted' : 'Depreciation posted'}.</strong>{' '}
            {npr(posted.amount)} {posted.reversal ? 'written back onto' : 'charged on'} {assetsText(posted.count)},
            for {fmtDate(posted.start)} to {fmtDate(posted.end)}. It is locked now.{' '}
            {posted.reversal
              ? 'Next, post the right figures for these dates as a normal depreciation run.'
              : 'Next, check the new book values on the Valuation Report.'}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              {posted.reversal && (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => startCorrectRun(posted)}>Post the right figures</button>
              )}
              {onOpenTab && (
                <button type="button" className={`btn btn-sm ${posted.reversal ? 'btn-ghost' : 'btn-primary'}`} onClick={() => onOpenTab('valuation')}>Open the Valuation Report</button>
              )}
              {onOpenTab && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => onOpenTab('register')}>Open the asset register</button>
              )}
            </div>
          </div>
        )}
        {recheck && (
          <div role="status" className="note-banner" style={{ margin: '10px 0 0' }}>
            {recheck.error
              ? <>The posted runs could not be re-read either, so whether it was posted is not known. Reload the page before posting again. ({recheck.error.text})</>
              : recheck.runs.length === 0
                ? <><strong>No run is posted over {fmtDate(recheck.start)} – {fmtDate(recheck.end)}</strong> as of this re-read.</>
                : <>
                    <strong>Posted over {fmtDate(recheck.start)} – {fmtDate(recheck.end)}</strong>, as of this re-read:
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {recheck.runs.map(r => (
                        <li key={r.id}>{runLabel(r)}, posted {fmtPosted(r.posted_at)} {r.posted_at ? nepalTime(r.posted_at) : ''}{reversedIdOf(r) ? ' (an adjustment)' : ''}</li>
                      ))}
                    </ul>
                  </>}
          </div>
        )}
      </div>

      {/* S849 (ASSETS-8): days just before the period that no run charged, e.g. a month skipped. */}
      {leadStart && (
        <div className="note-banner" role="status">
          <strong>{leadCount === 1 ? 'One asset was' : `${leadCount} assets were`} not charged for some days just before this period.</strong>{' '}
          Starting the period on {fmtDate(leadStart)} charges those days in this run; Post then warns about any run already covering
          some of them.{' '}
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => { setPeriodStart(leadStart); setLines(null) }}>Start the period on {fmtDate(leadStart)}</button>
        </div>
      )}

      {lines && (
        lines.length === 0 ? (
          <div className="card"><div className="empty-state"><p className="empty-state-text">
            {mode === 'adjust' ? 'That run charged nothing to any active asset, so there is nothing to reverse.' : 'No active assets to depreciate for this period.'}
          </p></div></div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net Book Value — cost minus depreciation charged so far — at the start of this period." width={230}>Opening NBV</Tip></th>
                  <th style={{ textAlign: 'right' }}>{mode === 'adjust' ? 'Charged by that run' : 'Computed Depreciation'}</th>
                  <th style={{ textAlign: 'right', width: 150 }}>
                    {mode === 'adjust'
                      ? <Tip text="Minus what that run charged reverses it in full. A smaller negative amount reverses part of it, taken off the last days of the run. Enter 0 to leave this asset out." width={300}>Reversal</Tip>
                      : <Tip text="Leave blank to use the computed figure. Set an amount (e.g. for impairment) and you must also give a reason. It cannot be negative or take the asset below its salvage value." width={280}>Override</Tip>}
                  </th>
                  {mode === 'regular' && <th style={{ width: 220 }}>Reason</th>}
                  <th style={{ textAlign: 'right' }}><Tip text="Net Book Value after this period's depreciation — carries forward as next period's Opening NBV." width={250}>Closing NBV</Tip></th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => {
                  const asset = assetsById[l.asset_id]
                  const override = l.override_amount === '' ? null : parseFloat(l.override_amount)
                  const closingNbv = override != null && isFinite(override) ? l.opening_nbv - override : l.closing_nbv
                  const fieldId = `deprec-ovr-${l.asset_id}`
                  const message = lineError(l)
                  return (
                    <tr key={l.asset_id}>
                      <td>
                        {asset?.asset_code} — {asset?.name}
                        {l.lead && (
                          <div style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 2 }}>
                            △ Not charged {bsSpanLabel(l.lead.start, l.lead.end)} (≈ NPR {fmt(l.lead.amount)})
                          </div>
                        )}
                        {(l.holes || []).map(g => (
                          <div key={g.start} style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 2 }}>
                            △ Not charged {bsSpanLabel(g.start, g.end)} (≈ NPR {fmt(g.amount)}): post a run for those dates.
                          </div>
                        ))}
                      </td>
                      <td style={{ textAlign: 'right' }}>{fmt(l.opening_nbv)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(mode === 'adjust' ? l.charged : l.depreciation_amount)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <QtyInput id={fieldId} value={l.override_amount} onChange={v => updateLine(l.asset_id, 'override_amount', v)} className="form-input" style={{ width: 120, textAlign: 'right' }}
                          aria-label={`${mode === 'adjust' ? 'Reversal' : 'Override'} for ${asset?.name || l.asset_id}`} {...fieldAria(fieldId, message)} />
                        <FieldError id={fieldId} message={message} />
                      </td>
                      {mode === 'regular' && (
                        <td>
                          <input className="form-input" value={l.override_reason} onChange={e => updateLine(l.asset_id, 'override_reason', e.target.value)}
                            aria-label={`Override reason for ${asset?.name || l.asset_id}`}
                            placeholder={l.override_amount !== '' ? 'Required' : ''} style={{ width: '100%' }} />
                        </td>
                      )}
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(closingNbv)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}
      </TabPanel>
      {confirmEl}
    </div>
  )
}
