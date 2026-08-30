import { useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import QtyInput from '../../../components/QtyInput'
import { computeDepreciationPreview } from './depreciationCompute'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

// Preview (pure computation, writes nothing) -> Post (manager-only, writes via one atomic RPC,
// locks the resulting rows). Deliberately never uses sessionDataCache — a preview must always
// compute from live, current data right before a Post, never a stale cached baseline (the same
// "batch action trusting on-screen state" risk flagged for Stock.js's Save All).
export default function DepreciationRunTab({ assets, onReload }) {
  const { clientId, hasImsAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
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

  const canPost = hasImsAccess('manager')
  const assetsById = Object.fromEntries(assets.map(a => [a.id, a]))

  async function preview() {
    if (!periodStart || !periodEnd) { setErr('Pick both a period start and end date before previewing the run.'); return }
    setLoading(true); setMsg(''); setErr(null)

    const { data: postedRows } = await scopedFrom('assets_depreciation_schedule')
      .eq('is_posted', true).order('period_end', { ascending: true })
    const priorScheduleByAssetId = {}
    ;(postedRows || []).forEach(row => { priorScheduleByAssetId[row.asset_id] = row }) // last write wins (ascending)

    const activeAssets = assets.filter(a => a.status === 'active')
    const preview = computeDepreciationPreview({
      assets: activeAssets, priorScheduleByAssetId, periodStart, periodEnd,
    })
    setLines(preview.map(l => ({ ...l, override_amount: '', override_reason: '' })))
    setLoading(false)
  }

  function updateLine(assetId, field, value) {
    setLines(prev => prev.map(l => l.asset_id === assetId ? { ...l, [field]: value } : l))
  }

  const invalidOverride = (lines || []).some(l => l.override_amount !== '' && !l.override_reason?.trim())

  async function post() {
    if (!lines || lines.length === 0) return
    if (invalidOverride) { setErr('Every line you have overridden needs a reason — the reason is what an auditor reads to understand why the computed figure was changed.'); return }
    setPosting(true); setMsg(''); setErr(null)

    const payloadLines = lines.map(l => {
      const override = l.override_amount === '' ? null : parseFloat(l.override_amount)
      const closingNbv = override != null ? l.opening_nbv - override : l.closing_nbv
      return {
        asset_id: l.asset_id,
        opening_nbv: l.opening_nbv,
        annual_depreciation: l.annual_depreciation,
        depreciation_amount: l.depreciation_amount,
        override_amount: override,
        override_reason: l.override_reason?.trim() || null,
        closing_nbv: closingNbv,
      }
    })

    const { error } = await supabase.rpc('post_asset_depreciation_run', {
      p_client_id: clientId, p_period_start: periodStart, p_period_end: periodEnd,
      p_lines: payloadLines, p_notes: null,
    })

    setPosting(false)
    if (error) {
      const { text, detail } = asActionError(error)
      setErr({ text: `The depreciation run was not posted, so this period is still open and nothing has been locked.

${text}`, detail })
      return
    }
    setMsg('ok:Posted — depreciation schedule locked for this period.')
    setLines(null)
    onReload()
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field">
            <label htmlFor="deprec-f1">Period Start</label>
            <input id="deprec-f1" type="date" className="form-input" value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
          </div>
          <div className="form-field">
            <label htmlFor="deprec-f2">Period End</label>
            <input id="deprec-f2" type="date" className="form-input" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={preview} disabled={loading}>{loading ? 'Computing…' : 'Preview'}</button>
          {lines && (
            <Tip text={canPost ? 'Writes the schedule rows and locks them — corrections after this need a new adjustment run, never an edit to this one.' : 'Only a Manager or Owner login can post a depreciation run.'} width={280}>
              <button className="btn btn-primary" onClick={post} disabled={!canPost || posting || invalidOverride} style={{ opacity: canPost ? 1 : 0.5 }}>
                {posting ? 'Posting…' : 'Post'}
              </button>
            </Tip>
          )}
          {msg && <span style={{ fontSize: 12, color: 'var(--theme-green-text)' }}>{msg.split(':').slice(1).join(':')}</span>}
        </div>
        <ActionError error={err} />
      </div>

      {lines && (
        lines.length === 0 ? (
          <div className="card"><div className="empty-state"><p className="empty-state-text">No active assets to depreciate for this period.</p></div></div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net Book Value — cost minus depreciation charged so far — at the start of this period." width={230}>Opening NBV</Tip></th>
                  <th style={{ textAlign: 'right' }}>Computed Depreciation</th>
                  <th style={{ textAlign: 'right', width: 140 }}><Tip text="Leave blank to use the computed figure. Set an amount (e.g. for impairment) and you must also give a reason." width={280}>Override</Tip></th>
                  <th style={{ width: 220 }}>Reason</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net Book Value after this period's depreciation — carries forward as next period's Opening NBV." width={250}>Closing NBV</Tip></th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => {
                  const asset = assetsById[l.asset_id]
                  const override = l.override_amount === '' ? null : parseFloat(l.override_amount)
                  const closingNbv = override != null ? l.opening_nbv - override : l.closing_nbv
                  return (
                    <tr key={l.asset_id}>
                      <td>{asset?.asset_code} — {asset?.name}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(l.opening_nbv)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(l.depreciation_amount)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <QtyInput value={l.override_amount} onChange={v => updateLine(l.asset_id, 'override_amount', v)} className="form-input" style={{ width: 110, textAlign: 'right' }} />
                      </td>
                      <td>
                        <input className="form-input" value={l.override_reason} onChange={e => updateLine(l.asset_id, 'override_reason', e.target.value)}
                          placeholder={l.override_amount !== '' ? 'Required' : ''} style={{ width: '100%' }} />
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(closingNbv)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  )
}
