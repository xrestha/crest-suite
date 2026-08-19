import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { readPageCache, writePageCache } from '../../../shared/sessionDataCache'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import AssetFormModal from './AssetFormModal'
import AssetCategoryModal from './AssetCategoryModal'
import AssetCard from './AssetCard'

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-NP', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

export default function AssetRegisterTab({ categories, assets, onReload }) {
  const { clientId, isAdmin } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [nbvByAssetId, setNbvByAssetId] = useState(() => readPageCache('fixed-assets', 'nbv', clientId) ?? {})
  const [filterCategory, setFilterCategory] = useState('all')
  const [filterStatus, setFilterStatus] = useState('active')
  const [filterLocation, setFilterLocation] = useState('all')
  const [showForm, setShowForm] = useState(false)
  const [showCategories, setShowCategories] = useState(false)
  const [editingAsset, setEditingAsset] = useState(null)
  const [viewingAsset, setViewingAsset] = useState(null)
  const [deletingId, setDeletingId] = useState(null)

  useEffect(() => { loadNbv() }, [assets]) // eslint-disable-line react-hooks/exhaustive-deps

  // Latest posted closing_nbv per asset, resolved once here (not one query per asset) — this is
  // the ONE view allowed sessionDataCache's read-revisit cache (a pure display read, never a
  // batch-save baseline like Stock.js's "Save All").
  async function loadNbv() {
    if (assets.length === 0) { setNbvByAssetId({}); return }
    const { data } = await scopedFrom('assets_depreciation_schedule', 'asset_id, period_end, closing_nbv')
      .eq('is_posted', true).order('period_end', { ascending: true })
    const map = {}
    ;(data || []).forEach(row => { map[row.asset_id] = row.closing_nbv }) // last write wins (ascending order)
    setNbvByAssetId(map)
    writePageCache('fixed-assets', 'nbv', clientId, map)
  }

  const locations = useMemo(() => [...new Set(assets.map(a => a.location).filter(Boolean))], [assets])

  const filtered = assets.filter(a =>
    (filterCategory === 'all' || a.category_id === filterCategory) &&
    (filterStatus === 'all' || a.status === filterStatus) &&
    (filterLocation === 'all' || a.location === filterLocation)
  )

  function nbvOf(asset) { return nbvByAssetId[asset.id] ?? asset.total_cost }
  function pctDepreciatedOf(asset) {
    return asset.total_cost > 0 ? ((asset.total_cost - nbvOf(asset)) / asset.total_cost) * 100 : 0
  }

  function handleSaved() { setShowForm(false); setEditingAsset(null); onReload() }

  // Admin-only, never exposed to any client login (not even Owner rank) — a posted asset's
  // depreciation history is blocked by the DB's immutability trigger for every normal session,
  // so this routes through admin-user-ops' service-role client (same mechanism Danger Zone uses)
  // rather than a plain scopedDelete, which would just fail with the trigger's exception.
  async function handleDelete(asset) {
    if (!window.confirm(`Permanently delete ${asset.asset_code} — ${asset.name}? This also deletes its posted depreciation history and cannot be undone.`)) return
    setDeletingId(asset.id)
    const { data, error } = await supabase.functions.invoke('admin-user-ops', {
      body: { action: 'deleteAsset', clientId, assetId: asset.id },
    })
    setDeletingId(null)
    if (error || data?.error) { alert('Delete failed: ' + (data?.error || error.message)); return }
    onReload()
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <select aria-label="Filter by category" className="form-select" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select aria-label="Filter by status" className="form-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
          <option value="active">Active</option>
          <option value="disposed">Disposed</option>
          <option value="written_off">Written Off</option>
          <option value="all">All Statuses</option>
        </select>
        <select aria-label="Filter by location" className="form-select" value={filterLocation} onChange={e => setFilterLocation(e.target.value)}>
          <option value="all">All Locations</option>
          {locations.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
        <button className="btn btn-ghost" style={{ fontSize: 12, marginLeft: 'auto' }} onClick={() => setShowCategories(true)}>Manage Categories</button>
      </div>

      {filtered.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">⊙</div>
            <p className="empty-state-text">No assets match these filters.</p>
          </div>
        </div>
      ) : (
        <div className="table-wrap table-wrap--fab-clear">
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Unit Cost</th>
                <th style={{ textAlign: 'right' }}>Total Cost</th>
                <th>Acquired</th>
                <th style={{ textAlign: 'right' }}><Tip text="Book value as of the latest posted depreciation run, or total cost if never posted." width={250}>Current NBV</Tip></th>
                <th style={{ textAlign: 'right' }}>% Depreciated</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(a => (
                <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => setViewingAsset(a)}>
                  <td>{a.asset_code}</td>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{a.name}</td>
                  <td>{a.assets_categories?.name || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{a.quantity}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(a.unit_cost)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(a.total_cost)}</td>
                  <td>{fmtDate(a.acquisition_date)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmt(nbvOf(a))}</td>
                  <td style={{ textAlign: 'right' }}>{pctDepreciatedOf(a).toFixed(1)}%</td>
                  <td>
                    <span className={`badge ${a.status === 'active' ? 'badge-green' : 'badge-red'}`}>{a.status}</span>
                  </td>
                  <td onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => setEditingAsset(a)}>Edit</button>
                    {isAdmin && (
                      <Tip text="Admin only — permanently deletes the asset and its posted depreciation history. Never available to a client login." width={260}>
                        <button className="btn btn-ghost" style={{ fontSize: 11, color: 'var(--theme-red-text)' }} onClick={() => handleDelete(a)} disabled={deletingId === a.id}>
                          {deletingId === a.id ? 'Deleting…' : 'Delete'}
                        </button>
                      </Tip>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Fab onClick={() => setShowForm(true)} label="+ Add Asset" />

      {showForm && (
        <AssetFormModal categories={categories} onClose={() => setShowForm(false)} onSaved={handleSaved} />
      )}
      {editingAsset && (
        <AssetFormModal categories={categories} asset={editingAsset} onClose={() => setEditingAsset(null)} onSaved={handleSaved} />
      )}
      {showCategories && (
        <AssetCategoryModal categories={categories} onClose={() => setShowCategories(false)} onSaved={() => { setShowCategories(false); onReload() }} />
      )}
      {viewingAsset && (
        <AssetCard asset={viewingAsset} onClose={() => setViewingAsset(null)} onChanged={() => { setViewingAsset(null); onReload() }} />
      )}
    </div>
  )
}
