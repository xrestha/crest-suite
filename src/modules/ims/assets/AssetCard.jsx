import { nprInt } from '../../../shared/nepalMoney'
import { useEffect, useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import ReportLoadError from '../../../components/ReportLoadError'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { computeDisposalGainLoss, computeDisposalDepreciation, latestPostedByAsset } from './depreciationCompute'

const fmt = nprInt
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

// Full detail view for one asset: header stats, complete posted depreciation schedule history,
// and a Dispose/Write Off action that freezes further depreciation and computes gain/loss.
export default function AssetCard({ asset, onClose, onChanged }) {
  const { clientId, hasImsAccess } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const [schedule, setSchedule] = useState([])
  const [loading, setLoading] = useState(true)
  // A failed schedule read is not "never depreciated" (S756). It used to fall through to an empty
  // history, so Current NBV read as the full cost — and the disposal below then struck its gain or
  // loss against that cost and wrote it to the register permanently. While this is set the card
  // shows no figures and offers no disposal.
  const [loadError, setLoadError] = useState(null)
  const [disposing, setDisposing] = useState(false)
  const [disposalForm, setDisposalForm] = useState({ status: 'disposed', disposal_date: '', disposal_proceeds: '', disposal_reason: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Per-field validation; `error` above stays the form-level channel for a rejected write (S603).
  const [dateErr, setDateErr] = useState('')

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true)
    const { data, error: readErr } = await scopedFrom('assets_depreciation_schedule')
      .eq('asset_id', asset.id).eq('is_posted', true)
      .order('period_end', { ascending: true }).order('created_at', { ascending: true }).order('id')
    if (readErr) { setLoadError(readErr); setLoading(false); return false }
    setLoadError(null)
    setSchedule(data || [])
    setLoading(false)
    return true
  }

  // The latest row by period_end, then created_at — an adjustment run shares the period of the
  // run it reverses, and only the later one carries the current NBV (S756).
  const latestSchedule = latestPostedByAsset(schedule)[asset.id] || null
  const currentNbv = latestSchedule ? parseFloat(latestSchedule.closing_nbv) : asset.total_cost
  const accumulatedDepreciation = asset.total_cost - currentNbv
  const pctDepreciated = asset.total_cost > 0 ? (accumulatedDepreciation / asset.total_cost) * 100 : 0

  // D24: the disposal charges depreciation up to its own date, and the gain or loss is measured
  // against the NBV that leaves. Recomputed as the date is typed so the figures below are the ones
  // Confirm will write.
  const acquired = String(asset.acquisition_date || '').slice(0, 10)
  const dateBeforeAcquisition = !!disposalForm.disposal_date && disposalForm.disposal_date < acquired
  const disposalCalc = disposalForm.disposal_date && !dateBeforeAcquisition && !loadError && !loading
    ? computeDisposalDepreciation({ asset, lastPosted: latestSchedule, disposalDate: disposalForm.disposal_date })
    : null
  const proceedsNum = parseFloat(disposalForm.disposal_proceeds) || 0
  const previewGainLoss = disposalCalc ? computeDisposalGainLoss({ closingNbvAtDisposal: disposalCalc.nbvAtDisposal, disposalProceeds: proceedsNum }) : null

  async function submitDisposal() {
    if (loadError || loading) {
      setError('The depreciation history for this asset could not be read, so its book value at disposal is unknown and nothing was disposed. Close this card and open it again.')
      return
    }
    if (!disposalForm.disposal_date) { setDateErr('Disposal date is required.'); return }
    if (dateBeforeAcquisition) { setDateErr(`The disposal date is before the asset was acquired (${fmtDate(acquired)}).`); return }
    setDateErr('')
    setSaving(true); setError('')
    const calc = computeDisposalDepreciation({ asset, lastPosted: latestSchedule, disposalDate: disposalForm.disposal_date })

    // Depreciation up to the disposal date is posted FIRST, as its own run through the same
    // atomic RPC every run uses. It is the half that can refuse (an IMS manager or the owner,
    // S756), and while it has not landed nothing about the asset has changed. If the register
    // update below then fails, a second Confirm is safe: this card re-reads the schedule, the new
    // run is now the latest, and there are no uncharged days left to post twice.
    if (calc.line) {
      const { error: postErr } = await supabase.rpc('post_asset_depreciation_run', {
        p_client_id: clientId, p_period_start: calc.periodStart, p_period_end: calc.periodEnd,
        p_lines: [{ ...calc.line, override_amount: null, override_reason: null }],
        p_notes: `Disposal: depreciation to ${calc.periodEnd} for ${asset.asset_code || asset.id}`,
      })
      if (postErr) {
        const { text, detail } = asActionError(postErr)
        setError({ text: `Nothing was disposed and no depreciation was posted — the asset is still active at its previous book value.

${text}`, detail })
        setSaving(false)
        return
      }
    }

    const gainLoss = computeDisposalGainLoss({ closingNbvAtDisposal: calc.nbvAtDisposal, disposalProceeds: proceedsNum })
    const { error: err } = await scopedUpdate('assets_register', {
      status: disposalForm.status,
      disposal_date: disposalForm.disposal_date,
      disposal_proceeds: proceedsNum,
      disposal_gain_loss: gainLoss,
      disposal_reason: disposalForm.disposal_reason.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('id', asset.id)
    setSaving(false)
    if (err) {
      // Disposal is the one write on this card that changes what the asset is worth on the books,
      // so an unsaved one must not be mistaken for a saved one.
      const { text, detail } = asActionError(err)
      if (calc.line) {
        await load()
        setError({ text: `Depreciation up to the disposal date (NPR ${fmt(calc.extraDepreciation)}) was posted, but the disposal itself did not save — the asset is still on the register as active. Press Confirm Disposal again; that depreciation will not be charged a second time.

${text}`, detail })
      } else {
        setError({ text: `${text}

The asset is still on the register as active.`, detail })
      }
      return
    }
    onChanged()
  }

  const canPost = hasImsAccess('manager')
  const figuresReal = !loading && !loadError

  return (
    <Modal onClose={onClose} title={`${asset.asset_code || ''} — ${asset.name}`} maxWidth={860}>
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Total Cost</div>
          <div className="stat-value">NPR {fmt(asset.total_cost)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Book value as of the latest posted depreciation run, or total cost if never posted." width={250}>Current NBV</Tip></div>
          <div className="stat-value" style={{ color: 'var(--theme-accent-ink)' }}>{figuresReal ? `NPR ${fmt(currentNbv)}` : '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Accumulated Depreciation</div>
          <div className="stat-value" style={{ color: 'var(--theme-red-text)' }}>{figuresReal ? `NPR ${fmt(accumulatedDepreciation)}` : '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">% Depreciated</div>
          <div className="stat-value">{figuresReal ? `${pctDepreciated.toFixed(1)}%` : '—'}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 24, marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)', flexWrap: 'wrap' }}>
        <span>Category: <strong style={{ color: 'var(--theme-text1)' }}>{asset.assets_categories?.name || '—'}</strong></span>
        <span>Acquired: <strong style={{ color: 'var(--theme-text1)' }}>{fmtDate(asset.acquisition_date)}</strong></span>
        <span>Location: <strong style={{ color: 'var(--theme-text1)' }}>{asset.location || '—'}</strong></span>
        <span>Status: <strong style={{ color: asset.status === 'active' ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>{asset.status}</strong></span>
      </div>

      <h3 style={{ fontSize: 13, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Depreciation History (Book)</h3>
      {loading ? (
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
      ) : loadError ? (
        <div style={{ marginBottom: 20 }}>
          <ReportLoadError error={loadError} />
          <button className="btn btn-ghost" style={{ marginTop: 10 }} onClick={load}>Try again</button>
        </div>
      ) : schedule.length === 0 ? (
        <div className="empty-state">
          <p className="empty-state-text">No posted depreciation runs yet for this asset.</p>
        </div>
      ) : (
        <div className="table-wrap" style={{ marginBottom: 20 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Period</th>
                <th style={{ textAlign: 'right' }}><Tip text="Net Book Value — cost minus depreciation charged so far — at the start of this period." width={230}>Opening NBV</Tip></th>
                <th style={{ textAlign: 'right' }}>Depreciation</th>
                <th style={{ textAlign: 'right' }}><Tip text="Net Book Value after this period's depreciation — carries forward as next period's Opening NBV." width={250}>Closing NBV</Tip></th>
                <th>Override Reason</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map(s => (
                <tr key={s.id}>
                  <td>{fmtDate(s.period_start)} – {fmtDate(s.period_end)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(s.opening_nbv)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(s.override_amount ?? s.depreciation_amount)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(s.closing_nbv)}</td>
                  <td style={{ color: 'var(--theme-text2)' }}>{s.override_reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {asset.status !== 'active' ? (
        <div style={{ background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', fontSize: 13 }}>
          <strong style={{ color: 'var(--theme-red-text)' }}>{asset.status === 'disposed' ? 'Disposed' : 'Written Off'}</strong> on {fmtDate(asset.disposal_date)} —
          {' '}Proceeds NPR {fmt(asset.disposal_proceeds)}, {asset.disposal_gain_loss >= 0 ? 'Gain' : 'Loss'} of NPR {fmt(Math.abs(asset.disposal_gain_loss))}.
          {asset.disposal_reason && <div style={{ marginTop: 4, color: 'var(--theme-text2)' }}>{asset.disposal_reason}</div>}
        </div>
      ) : !disposing ? (
        // No Dispose button over a history that could not be read: the gain or loss it would
        // write depends on that history.
        canPost && figuresReal && (
          <button className="btn btn-ghost" onClick={() => setDisposing(true)} style={{ fontSize: 12 }}>Dispose / Write Off</button>
        )
      ) : (
        <div className="card" style={{ background: 'var(--theme-bg)' }}>
          <div className="form-grid form-grid-3">
            <div className="form-field">
              <label htmlFor="assetc-f1">Outcome</label>
              <select id="assetc-f1" className="form-select" value={disposalForm.status} onChange={e => setDisposalForm(f => ({ ...f, status: e.target.value }))}>
                <option value="disposed">Disposed (sold/scrapped for proceeds)</option>
                <option value="written_off">Written Off (no proceeds)</option>
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="assetc-f2">Disposal Date</label>
              <input id="assetc-f2" type="date" className="form-input" value={disposalForm.disposal_date} onChange={e => { setDateErr(''); setDisposalForm(f => ({ ...f, disposal_date: e.target.value })) }} {...fieldAria('assetc-f2', dateErr)} />
              <FieldError id="assetc-f2" message={dateErr} />
            </div>
            <div className="form-field">
              <label htmlFor="assetc-f3">Proceeds (NPR)</label>
              <input id="assetc-f3" type="number" className="form-input" value={disposalForm.disposal_proceeds} onChange={e => setDisposalForm(f => ({ ...f, disposal_proceeds: e.target.value }))} />
            </div>
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="assetc-f4">Reason</label>
              <input id="assetc-f4" className="form-input" value={disposalForm.disposal_reason} onChange={e => setDisposalForm(f => ({ ...f, disposal_reason: e.target.value }))} style={{ width: '100%' }} />
            </div>
          </div>

          {disposalCalc && (
            <div style={{ marginTop: 12, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.7 }}>
              <div>
                <Tip text="Straight-line depreciation for the days since the last posted run (or since acquisition), at the same rate every run uses and never below salvage value. It is posted as its own locked run when you confirm." width={300}>Depreciation to the disposal date</Tip>:{' '}
                <strong style={{ color: 'var(--theme-text1)' }}>NPR {fmt(disposalCalc.extraDepreciation)}</strong>
                {disposalCalc.line ? ` (${fmtDate(disposalCalc.periodStart)} – ${fmtDate(disposalCalc.periodEnd)})` : ' — nothing left to charge'}
              </div>
              <div>Book value at disposal: <strong style={{ color: 'var(--theme-text1)' }}>NPR {fmt(disposalCalc.nbvAtDisposal)}</strong></div>
              <div>
                {previewGainLoss >= 0 ? 'Gain' : 'Loss'} on disposal:{' '}
                <strong style={{ color: 'var(--theme-text1)' }}>NPR {fmt(Math.abs(previewGainLoss))}</strong>
              </div>
              {disposalCalc.postedPastDisposal && (
                <p style={{ margin: '6px 0 0', color: 'var(--theme-amber-text)' }}>
                  △ A posted run already charges depreciation through {fmtDate(latestSchedule?.period_end)}, after this disposal date, so the book value above includes depreciation for days the asset was no longer held. To take that back out, reverse that run on the Depreciation Runs tab (Adjustment) before disposing.
                </p>
              )}
            </div>
          )}

          <ActionError error={error} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <button className="btn btn-ghost" onClick={() => setDisposing(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={submitDisposal} disabled={saving || !figuresReal}>{saving ? 'Saving…' : 'Confirm Disposal'}</button>
          </div>
        </div>
      )}
    </Modal>
  )
}
