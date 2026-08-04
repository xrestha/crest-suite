import { useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { POOL_SHORT_LABELS, POOL_EXAMPLES } from './taxPoolConstants'

const emptyRow = () => ({ id: null, name: '', default_useful_life_years: '', tax_pool_hint: '', _dirty: true })

// Manage asset_categories — name + default useful life + Nepal tax pool hint (seeds
// AssetFormModal's category picker, per CLAUDE.md's seed-then-freely-editable pattern).
export default function AssetCategoryModal({ categories, onClose, onSaved }) {
  const { scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [rows, setRows] = useState(() =>
    categories.length > 0
      ? categories.map(c => ({ id: c.id, name: c.name, default_useful_life_years: c.default_useful_life_years ?? '', tax_pool_hint: c.tax_pool_hint || '', _dirty: false }))
      : [emptyRow()]
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  function update(idx, field, value) {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: value, _dirty: true } : r))
  }

  function addRow() { setRows(prev => [...prev, emptyRow()]) }

  async function removeRow(idx) {
    const row = rows[idx]
    if (row.id) {
      const { error: delErr } = await scopedDelete('assets_categories').eq('id', row.id)
      if (delErr) { setError(delErr.message); return }
    }
    setRows(prev => prev.filter((_, i) => i !== idx))
  }

  async function save() {
    setSaving(true); setError('')
    for (const row of rows) {
      if (!row.name?.trim() || !row._dirty) continue
      const payload = {
        name: row.name.trim(),
        default_useful_life_years: row.default_useful_life_years === '' ? null : parseFloat(row.default_useful_life_years),
        tax_pool_hint: row.tax_pool_hint || null,
      }
      const { error: err } = row.id
        ? await scopedUpdate('assets_categories', payload).eq('id', row.id)
        : await scopedInsert('assets_categories', payload)
      if (err) { setError(err.message); setSaving(false); return }
    }
    setSaving(false)
    onSaved()
  }

  return (
    <Modal onClose={onClose} title="Manage Asset Categories" maxWidth={640}>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th style={{ width: 140 }}>
                <Tip text="Default useful life (years) for a new asset in this category — overridable per asset." width={240}>Useful Life (yrs)</Tip>
              </th>
              <th style={{ width: 160 }}>
                <Tip text="For the annual tax filing (Tax Depreciation (IRD) tab). Nepal groups assets into 5 pools by type instead of depreciating each item alone. This seeds each new asset's own Tax Pool field — still editable per asset. Not sure? Leave it blank for now." width={300}>Tax Pool</Tip>
              </th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={row.id || `new-${idx}`}>
                <td>
                  <input
                    value={row.name}
                    onChange={e => update(idx, 'name', e.target.value)}
                    placeholder="e.g. Kitchen Equipment"
                    className="form-select"
                    style={{ width: '100%' }}
                  />
                </td>
                <td>
                  <input
                    type="number" min="0" step="0.5"
                    value={row.default_useful_life_years}
                    onChange={e => update(idx, 'default_useful_life_years', e.target.value)}
                    className="form-select"
                    style={{ width: '100%' }}
                  />
                </td>
                <td>
                  <Tip text={row.tax_pool_hint ? POOL_EXAMPLES[row.tax_pool_hint] : 'Which pool this category\'s equipment usually falls in — hover the column header for what each pool means.'} width={280}>
                    <select
                      value={row.tax_pool_hint}
                      onChange={e => update(idx, 'tax_pool_hint', e.target.value)}
                      className="form-select"
                      style={{ width: '100%' }}
                    >
                      <option value="">— Not set —</option>
                      {['A', 'B', 'C', 'D', 'E'].map(p => <option key={p} value={p}>{POOL_SHORT_LABELS[p]}</option>)}
                    </select>
                  </Tip>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <button className="btn btn-ghost" style={{ fontSize: 16, padding: '2px 8px' }} onClick={() => removeRow(idx)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={addRow}>+ Add Category</button>
        {error && <span style={{ color: 'var(--theme-red)', fontSize: 12 }}>{error}</span>}
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  )
}
