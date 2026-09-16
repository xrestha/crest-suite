import { nprInt } from '../../../shared/nepalMoney'
import { useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import FieldError, { fieldAria } from '../../../components/FieldError'
import QtyInput from '../../../components/QtyInput'
import {
  computeDepreciationPreview, latestPostedByAsset, effectiveDepreciation,
  regularOverrideError, adjustmentOverrideError,
} from './depreciationCompute'
import { chipKeys } from '../../../shared/rovingFocus'

const fmt = nprInt
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

// An adjustment run is recorded through the same RPC as any other run; what marks it is its
// `notes`, which name the run it reverses. That is what lets the run picker say a run has already
// been reversed, and the overlap warning say a period's earlier run nets to nothing (S756).
const ADJ_PREFIX = 'Adjustment: reverses run '
const reversedIdOf = run => {
  const m = /^Adjustment: reverses run ([0-9a-f-]{36})/i.exec(run?.notes || '')
  return m ? m[1] : null
}
const runLabel = r => `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}`

// The posted schedule, paged: one row per asset per run, so a client with 100 assets and monthly
// runs crosses the silent 1000-row cap inside a year — and a truncated read here would open every
// asset past the cut at its full cost, in a preview that can be POSTED (S756). The created_at and
// id tiebreakers are what latestPostedByAsset() needs to pick an adjustment over the run it
// reverses when the two share a period_end.
function readPostedSchedule(scopedFrom) {
  return fetchAllRows(() => scopedFrom('assets_depreciation_schedule')
    .eq('is_posted', true)
    .order('period_end', { ascending: true }).order('created_at', { ascending: true }).order('id'))
}

// Preview (pure computation, writes nothing) -> Post (manager-only, writes via one atomic RPC,
// locks the resulting rows). Deliberately never uses sessionDataCache — a preview must always
// compute from live, current data right before a Post, never a stale cached baseline (the same
// "batch action trusting on-screen state" risk flagged for Stock.js's Save All).
export default function DepreciationRunTab({ assets, onReload }) {
  const { clientId, hasImsAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  // 'regular' charges a period; 'adjust' reverses a posted run (D24, S756). Posted rows are
  // immutable in the database, so a reversal is the only correction the books can carry.
  const [mode, setMode] = useState('regular')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [lines, setLines] = useState(null)
  const [loading, setLoading] = useState(false)
  const [posting, setPosting] = useState(false)
  const [msg, setMsg] = useState('')
  // Errors moved out of `msg` and into their own state (S658): the toolbar span they shared is one
  // line beside the Post button, which is fine for "Posted — schedule locked" and much too small
  // for a failure that has to say what happened AND carry its technical detail.
  const [err, setErr] = useState(null)
  // Adjustment mode: the posted runs to choose from, and the one chosen.
  const [runs, setRuns] = useState(null)
  const [runId, setRunId] = useState('')
  const [adjReason, setAdjReason] = useState('')
  const [adjSkipped, setAdjSkipped] = useState([])

  const canPost = hasImsAccess('manager')
  const assetsById = Object.fromEntries(assets.map(a => [a.id, a]))
  const reversedIds = new Set((runs || []).map(reversedIdOf).filter(Boolean))
  const chosenRun = (runs || []).find(r => r.id === runId) || null

  function switchMode(next) {
    if (next === mode) return
    setMode(next); setLines(null); setMsg(''); setErr(null); setAdjSkipped([])
    if (next === 'adjust' && runs === null) loadRuns()
  }

  async function loadRuns() {
    const { data, error } = await fetchAllRows(() => scopedFrom('assets_depreciation_runs', 'id, period_start, period_end, posted_at, notes, created_at')
      .eq('status', 'posted')
      .order('period_end', { ascending: false }).order('created_at', { ascending: false }).order('id'))
    if (error) {
      const a = asActionError(error)
      setErr({ text: 'Could not read the posted depreciation runs, so there is nothing to choose a reversal from. Try again. ' + a.text, detail: a.detail })
      return
    }
    setRuns(data || [])
  }

  async function preview() {
    if (!periodStart || !periodEnd) { setErr('Pick both a period start and end date before previewing the run.'); return }
    if (periodEnd < periodStart) { setErr('The period end is before its start. Swap the two dates.'); return }
    setLoading(true); setMsg(''); setErr(null)

    const { data: postedRows, error: postedErr } = await readPostedSchedule(scopedFrom)
    // A failed read used to compute every asset's opening NBV from cost — a preview that read as
    // a first-ever run and could be POSTED as one (S682). Refuse to compute instead.
    if (postedErr) {
      const a = asActionError(postedErr)
      setErr({ text: 'Could not read the posted depreciation runs, so no preview was computed — every opening figure would have been wrong. Try again. ' + a.text, detail: a.detail })
      setLoading(false)
      return
    }
    const priorScheduleByAssetId = latestPostedByAsset(postedRows)

    const activeAssets = assets.filter(a => a.status === 'active')
    const preview = computeDepreciationPreview({
      assets: activeAssets, priorScheduleByAssetId, periodStart, periodEnd,
    })
    setLines(preview.map(l => ({ ...l, override_amount: '', override_reason: '' })))
    setLoading(false)
  }

  // Adjustment preview: each line of the chosen run becomes a line whose override is minus what
  // that line charged, opening from the asset's CURRENT NBV (which may already include later runs).
  async function previewReversal() {
    if (!chosenRun) { setErr('Choose the posted run to reverse.'); return }
    setLoading(true); setMsg(''); setErr(null); setAdjSkipped([])
    const [runRes, postedRes] = await Promise.all([
      fetchAllRows(() => scopedFrom('assets_depreciation_schedule').eq('run_id', chosenRun.id).order('id')),
      readPostedSchedule(scopedFrom),
    ])
    const failed = runRes.error || postedRes.error
    if (failed) {
      const a = asActionError(failed)
      setErr({ text: 'Could not read that run or the current book values, so no reversal was computed. Try again. ' + a.text, detail: a.detail })
      setLoading(false)
      return
    }
    const latest = latestPostedByAsset(postedRes.data)
    const skipped = []
    const next = []
    for (const row of runRes.data || []) {
      const charged = effectiveDepreciation(row)
      if (Math.abs(charged) < 0.005) continue
      const asset = assetsById[row.asset_id]
      // A disposed asset's gain or loss was struck against the NBV it had then. Writing its
      // depreciation back afterwards would move a book value the disposal already froze.
      if (!asset || asset.status !== 'active') { skipped.push(asset ? `${asset.asset_code} — ${asset.name}` : row.asset_id); continue }
      const opening = parseFloat(latest[row.asset_id]?.closing_nbv ?? asset.total_cost) || 0
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
    if (!lines || lines.length === 0) return
    if (anyLineError) { setErr('Some lines have an amount outside what that line allows — the message under each one says the limit.'); return }
    if (invalidOverride) {
      setErr(mode === 'adjust'
        ? 'An adjustment needs a reason — it is what an auditor reads to understand why posted depreciation was reversed.'
        : 'Every line you have overridden needs a reason — the reason is what an auditor reads to understand why the computed figure was changed.')
      return
    }
    setMsg(''); setErr(null)

    if (mode === 'adjust') {
      const payload = buildPayload()
      if (payload.length === 0) { setErr('Every line is set to 0, so there is nothing to reverse.'); return }
      askConfirm({
        title: 'Post this reversal?',
        body: <p style={{ margin: 0 }}>A new run is posted for {runLabel(chosenRun)} that writes NPR {fmt(-payload.reduce((s, l) => s + l.override_amount, 0))} of depreciation back onto {payload.length} asset{payload.length === 1 ? '' : 's'}. It is locked once posted, like every run; the run it reverses stays on the record beside it.</p>,
        confirmLabel: 'Post reversal',
        run: () => submit(chosenRun.period_start, chosenRun.period_end, payload, `${ADJ_PREFIX}${chosenRun.id} (${chosenRun.period_start} to ${chosenRun.period_end})`),
      })
      return
    }

    // A period can be posted twice, and each post charges its depreciation again, permanently —
    // the schedule is immutable and there is deliberately no unique period constraint, because a
    // correction is a new run. So look before posting and make a second charge a decision (S756).
    setPosting(true)
    const { data: overlapping, error: overlapErr } = await scopedFrom('assets_depreciation_runs', 'id, period_start, period_end, posted_at, notes')
      .eq('status', 'posted').lte('period_start', periodEnd).gte('period_end', periodStart)
      .order('period_start').order('id')
    setPosting(false)
    if (overlapErr) {
      // A check that could not run has not passed.
      const a = asActionError(overlapErr)
      setErr({ text: 'Could not check whether this period already has a posted run, so nothing was posted — posting twice charges the same depreciation twice. Try again. ' + a.text, detail: a.detail })
      return
    }
    const payload = buildPayload()
    const earlier = (overlapping || []).filter(r => !reversedIdOf(r))
    if (earlier.length === 0) { await submit(periodStart, periodEnd, payload, null); return }
    const reversedSet = new Set((overlapping || []).map(reversedIdOf).filter(Boolean))
    askConfirm({
      title: 'This period already has depreciation posted',
      danger: true,
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>These posted runs cover some of the same dates:</p>
          <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            {earlier.map(r => (
              <li key={r.id}>
                {runLabel(r)}, posted {fmtDate(r.posted_at)}
                {r.notes?.startsWith('Disposal:') ? ' (charged at a disposal)' : ''}
                {reversedSet.has(r.id) ? ' — already reversed by an adjustment' : ''}
              </li>
            ))}
          </ul>
          <p style={{ margin: 0 }}>Posting now charges depreciation for the overlapping days again, on top of what is already there, and it cannot be edited afterwards. If one of those runs was wrong, reverse it with an adjustment run first.</p>
        </>
      ),
      confirmLabel: 'Post anyway',
      run: () => submit(periodStart, periodEnd, payload, null),
    })
  }

  async function submit(start, end, payload, notes) {
    setPosting(true); setErr(null)
    const { error } = await supabase.rpc('post_asset_depreciation_run', {
      p_client_id: clientId, p_period_start: start, p_period_end: end,
      p_lines: payload, p_notes: notes,
    })
    setPosting(false)
    if (error) {
      // An ims_rank refusal (S756: posting needs an IMS manager or the owner) is worded by the
      // error table; the consequence line stays true because the RPC is one transaction.
      const { text, detail } = asActionError(error)
      setErr({ text: `The ${notes ? 'adjustment' : 'depreciation'} run was not posted, so nothing has been locked.

${text}`, detail })
      return
    }
    setMsg(notes ? 'ok:Reversal posted — the depreciation is written back and locked.' : 'ok:Posted — depreciation schedule locked for this period.')
    setLines(null)
    if (notes) { setRunId(''); setAdjReason(''); setAdjSkipped([]); loadRuns() }
    onReload()
  }

  const selectableRuns = (runs || []).filter(r => !reversedIdOf(r))

  return (
    <div>
      <div className="tab-bar" style={{ marginBottom: 12 }} role="group" aria-label="Run type" onKeyDown={chipKeys}>
        <button type="button" className={`tab-btn${mode === 'regular' ? ' tab-btn--active' : ''}`} aria-pressed={mode === 'regular'} onClick={() => switchMode('regular')}>Depreciation run</button>
        <Tip text="Reverses a posted run that was wrong. Posted runs can never be edited, so the correction is a new run that writes the depreciation back — then post the right figures as a normal run." width={300}>
          <button type="button" className={`tab-btn${mode === 'adjust' ? ' tab-btn--active' : ''}`} aria-pressed={mode === 'adjust'} onClick={() => switchMode('adjust')}>Adjustment (reverse a run)</button>
        </Tip>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {mode === 'regular' ? (
            <>
              <div className="form-field">
                <label htmlFor="deprec-f1">Period Start</label>
                <input id="deprec-f1" type="date" className="form-input" value={periodStart} onChange={e => { setPeriodStart(e.target.value); setLines(null) }} />
              </div>
              <div className="form-field">
                <label htmlFor="deprec-f2">Period End</label>
                <input id="deprec-f2" type="date" className="form-input" value={periodEnd} onChange={e => { setPeriodEnd(e.target.value); setLines(null) }} />
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
                      {runLabel(r)} · posted {fmtDate(r.posted_at)}{reversedIds.has(r.id) ? ' · already reversed' : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-field" style={{ flex: 1, minWidth: 220 }}>
                <label htmlFor="deprec-adj-reason">Reason</label>
                <input id="deprec-adj-reason" className="form-input" value={adjReason} onChange={e => setAdjReason(e.target.value)} placeholder="Required — why this run is being reversed" />
              </div>
              <button className="btn btn-primary" onClick={previewReversal} disabled={loading || !runId}>{loading ? 'Computing…' : 'Preview reversal'}</button>
            </>
          )}
          {lines && (
            <Tip text={canPost ? 'Writes the schedule rows and locks them — corrections after this need a new adjustment run, never an edit to this one.' : 'Only a Manager or Owner login can post a depreciation run.'} width={280}>
              <button className="btn btn-primary" onClick={post} disabled={!canPost || posting || invalidOverride || anyLineError} style={{ opacity: canPost ? 1 : 0.5 }}>
                {posting ? 'Posting…' : mode === 'adjust' ? 'Post reversal' : 'Post'}
              </button>
            </Tip>
          )}
          {msg && <span style={{ fontSize: 12, color: 'var(--theme-green-text)' }}>{msg.split(':').slice(1).join(':')}</span>}
        </div>
        {mode === 'adjust' && adjSkipped.length > 0 && (
          <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--theme-amber-text)', lineHeight: 1.6 }}>
            △ Left out because they are no longer active — their disposal already fixed their book value: {adjSkipped.join(', ')}.
          </p>
        )}
        <ActionError error={err} />
      </div>

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
                      ? <Tip text="Minus what that run charged, to reverse it in full. Enter a smaller negative amount to reverse part of it, or 0 to leave this asset out." width={280}>Reversal</Tip>
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
                      <td>{asset?.asset_code} — {asset?.name}</td>
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
      {confirmEl}
    </div>
  )
}
