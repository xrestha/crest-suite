import { useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { POOL_SHORT_LABELS, POOL_EXAMPLES } from './taxPoolConstants'
import { settleWithin } from '../../../utils/withTimeout'
import { answerLost, ASSET_CALL_MS } from './assetReads'

// `_key` is a row's identity on screen, stable while rows are added, removed and saved; `id` is its
// database id, null until the insert lands.
let nextKey = 0
const emptyRow = () => ({ _key: `new-${++nextKey}`, id: null, name: '', default_useful_life_years: '', tax_pool_hint: '', _dirty: true })

/**
 * The rows once `saved` (the row as it was sent) has landed, with `newId` the id an insert returned.
 *
 * Keeps what the database now holds (S792, COSTS-13): Save writes row by row, and it used to throw
 * the inserted id away — so after a LATER row failed, Save again inserted every row above it a
 * second time. The id and a clean flag are written back as each save lands; a field edited while
 * the save was in flight keeps the row dirty, so that edit is not lost either. Exported for the test.
 */
export function afterCategorySaved(rows, saved, newId) {
  return rows.map(r => r._key !== saved._key ? r : {
    ...r,
    id: r.id || newId || null,
    _dirty: r.name !== saved.name || r.default_useful_life_years !== saved.default_useful_life_years || r.tax_pool_hint !== saved.tax_pool_hint,
  })
}

// Manage asset_categories — name + default useful life + Nepal tax pool hint (seeds
// AssetFormModal's category picker, per CLAUDE.md's seed-then-freely-editable pattern).
export default function AssetCategoryModal({ categories, onClose, onSaved }) {
  const { scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [rows, setRows] = useState(() =>
    categories.length > 0
      ? categories.map(c => ({ _key: c.id, id: c.id, name: c.name, default_useful_life_years: c.default_useful_life_years ?? '', tax_pool_hint: c.tax_pool_hint || '', _dirty: false }))
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
      // Bounded (S857), like every other read and write on the page (ASSETS-15).
      const { error: delErr } = await settleWithin(scopedDelete('assets_categories').eq('id', row.id), ASSET_CALL_MS, 'Removing the category')
      if (delErr) {
        const { text, detail } = asActionError(delErr)
        // No answer is not a refusal: the delete may have landed after the clock ran out.
        if (answerLost(delErr)) {
          setError({ text: `No answer came back, so whether "${row.name || 'that category'}" was removed is not known. Close this window and open Manage Categories again to see what is stored.`, detail })
          return
        }
        setError({ text: `"${row.name || 'That category'}" could not be removed — it is probably still assigned to one or more assets. ${text}`, detail })
        return
      }
    }
    setRows(prev => prev.filter(r => r._key !== row._key))
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
      // Bounded (S857): a write that never answers used to hold Save on "Saving…" for good.
      const { data: inserted, error: err } = await settleWithin(row.id
        ? scopedUpdate('assets_categories', payload).eq('id', row.id)
        : scopedInsert('assets_categories', payload, { single: true }), ASSET_CALL_MS, 'Saving the category')
      if (!err) setRows(prev => afterCategorySaved(prev, row, inserted?.id))
      if (err) {
        // The loop saves row by row, so anything before this one is already committed.
        const { text, detail } = asActionError(err)
        // A lost answer may still have saved this row, and a new row saved twice is two categories:
        // send the reader to look rather than to press Save again (errorText: never "not saved").
        if (answerLost(err)) {
          setError({ text: `Stopped at "${row.name.trim()}": no answer came back, so whether it saved is not known. Categories above it in the list were saved, and the ones below it were not sent. Close this window and open it again to check before saving again.`, detail })
          setSaving(false); return
        }
        setError({ text: `Stopped at "${row.name.trim()}" — any categories above it in the list were saved, and it and anything below it were not.

${text}`, detail })
        setSaving(false); return
      }
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
                <Tip text="For the yearly tax filing. Nepal groups assets into 5 pools by type. New assets in this category start in this pool, and you can change it per asset. Not sure? Leave it blank." width={300}>Tax Pool</Tip>
              </th>
              <th style={{ width: 40 }}><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={row._key}>
                <td>
                  <input aria-label="Category name"
                    value={row.name}
                    onChange={e => update(idx, 'name', e.target.value)}
                    placeholder="e.g. Kitchen Equipment"
                    className="form-input"
                    style={{ width: '100%' }}
                  />
                </td>
                <td>
                  <input aria-label="Default useful life in years"
                    type="number" min="0" step="0.5"
                    value={row.default_useful_life_years}
                    onChange={e => update(idx, 'default_useful_life_years', e.target.value)}
                    className="form-input"
                    style={{ width: '100%' }}
                  />
                </td>
                <td>
                  <Tip text={row.tax_pool_hint ? POOL_EXAMPLES[row.tax_pool_hint] : 'Which pool this category\'s equipment usually falls in — hover the column header for what each pool means.'} width={280}>
                    <select aria-label="Tax depreciation pool"
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
                  {/* S765: aria-label — an icon has no accessible name, and this one deletes a row. */}
                  <button className="btn btn-icon btn-ghost"
                    aria-label={`Remove ${row.name || 'this category'}`}
                    title={`Remove ${row.name || 'this category'}`}
                    onClick={() => removeRow(idx)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
        <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={addRow}>+ Add Category</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>

      <ActionError error={error} />
    </Modal>
  )
}
