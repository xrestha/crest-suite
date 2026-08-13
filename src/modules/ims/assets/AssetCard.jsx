import { useEffect, useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { computeDisposalGainLoss } from './depreciationCompute'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-NP', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

// Full detail view for one asset: header stats, complete posted depreciation schedule history,
// and a Dispose/Write Off action that freezes further depreciation and computes gain/loss.
export default function AssetCard({ asset, onClose, onChanged }) {
  const { hasImsAccess } = useAuth()
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const [schedule, setSchedule] = useState([])
  const [loading, setLoading] = useState(true)
  const [disposing, setDisposing] = useState(false)
  const [disposalForm, setDisposalForm] = useState({ status: 'disposed', disposal_date: '', disposal_proceeds: '', disposal_reason: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true)
    const { data } = await scopedFrom('assets_depreciation_schedule')
      .eq('asset_id', asset.id).eq('is_posted', true)
      .order('period_end', { ascending: true })
    setSchedule(data || [])
    setLoading(false)
  }

  const latestSchedule = schedule[schedule.length - 1]
  const currentNbv = latestSchedule ? latestSchedule.closing_nbv : asset.total_cost
  const accumulatedDepreciation = asset.total_cost - currentNbv
  const pctDepreciated = asset.total_cost > 0 ? (accumulatedDepreciation / asset.total_cost) * 100 : 0

  async function submitDisposal() {
    if (!disposalForm.disposal_date) { setError('Disposal date is required.'); return }
    setSaving(true); setError('')
    const proceeds = parseFloat(disposalForm.disposal_proceeds) || 0
    const gainLoss = computeDisposalGainLoss({ closingNbvAtDisposal: currentNbv, disposalProceeds: proceeds })
    const { error: err } = await scopedUpdate('assets_register', {
      status: disposalForm.status,
      disposal_date: disposalForm.disposal_date,
      disposal_proceeds: proceeds,
      disposal_gain_loss: gainLoss,
      disposal_reason: disposalForm.disposal_reason.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('id', asset.id)
    setSaving(false)
    if (err) { setError(err.message); return }
    onChanged()
  }

  const canPost = hasImsAccess('manager')

  return (
    <Modal onClose={onClose} title={`${asset.asset_code || ''} — ${asset.name}`} maxWidth={860}>
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Total Cost</div>
          <div className="stat-value">NPR {fmt(asset.total_cost)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Book value as of the latest posted depreciation run, or total cost if never posted." width={250}>Current NBV</Tip></div>
          <div className="stat-value" style={{ color: 'var(--theme-accent-ink)' }}>NPR {fmt(currentNbv)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Accumulated Depreciation</div>
          <div className="stat-value" style={{ color: 'var(--theme-red-text)' }}>NPR {fmt(accumulatedDepreciation)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">% Depreciated</div>
          <div className="stat-value">{pctDepreciated.toFixed(1)}%</div>
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
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', fontSize: 13 }}>
          <strong style={{ color: 'var(--theme-red-text)' }}>{asset.status === 'disposed' ? 'Disposed' : 'Written Off'}</strong> on {fmtDate(asset.disposal_date)} —
          {' '}Proceeds NPR {fmt(asset.disposal_proceeds)}, {asset.disposal_gain_loss >= 0 ? 'Gain' : 'Loss'} of NPR {fmt(Math.abs(asset.disposal_gain_loss))}.
          {asset.disposal_reason && <div style={{ marginTop: 4, color: 'var(--theme-text2)' }}>{asset.disposal_reason}</div>}
        </div>
      ) : !disposing ? (
        canPost && (
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
              <input id="assetc-f2" type="date" className="form-select" value={disposalForm.disposal_date} onChange={e => setDisposalForm(f => ({ ...f, disposal_date: e.target.value }))} />
            </div>
            <div className="form-field">
              <label htmlFor="assetc-f3">Proceeds (NPR)</label>
              <input id="assetc-f3" type="number" className="form-select" value={disposalForm.disposal_proceeds} onChange={e => setDisposalForm(f => ({ ...f, disposal_proceeds: e.target.value }))} />
            </div>
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label htmlFor="assetc-f4">Reason</label>
              <input id="assetc-f4" className="form-select" value={disposalForm.disposal_reason} onChange={e => setDisposalForm(f => ({ ...f, disposal_reason: e.target.value }))} style={{ width: '100%' }} />
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
            {error && <span style={{ color: 'var(--theme-red-text)', fontSize: 12 }}>{error}</span>}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setDisposing(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitDisposal} disabled={saving}>{saving ? 'Saving…' : 'Confirm Disposal'}</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}
