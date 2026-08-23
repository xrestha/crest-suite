import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { Navigate, Link } from 'react-router-dom'
import { printWithTitle } from '../../../utils/printTitle'

const EMPTY_FORM = { name: '', contact_person: '', phone: '', address: '', pan_vat_no: '', payment_terms: '' }

export default function Vendors() {
  const { clientId, isAdmin, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  const { scopedFrom, scopedInsert } = useScopedDb()
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Per-field validation. `error` above stays the form-level channel (no client selected, a write
  // the server rejected); a message about one box belongs under that box (S603).
  const [fieldErr, setFieldErr] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => { if (clientId) loadVendors() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadVendors() {
    setLoading(true)
    const { data } = await scopedFrom('vendors').order('name')
    setVendors(data || [])
    setLoading(false)
  }

  function openNew() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError('')
    setFieldErr('')
    setShowForm(true)
  }

  function openEdit(vendor) {
    setEditing(vendor.id)
    setForm({
      name: vendor.name,
      contact_person: vendor.contact_person || '',
      phone: vendor.phone || '',
      address: vendor.address || '',
      pan_vat_no: vendor.pan_vat_no || '',
      payment_terms: vendor.payment_terms || ''
    })
    setError('')
    setFieldErr('')
    setShowForm(true)
  }

  // Core save — returns true on success; does not close/reload (lets callers chain "save & next").
  async function doSave() {
    if (!clientId) { setError('No client selected. Pick a client in the top-left switcher before saving.'); return false }
    if (!form.name.trim()) { setFieldErr('Vendor name is required.'); return false }
    setFieldErr('')
    setSaving(true)
    setError('')
    if (editing) {
      const { error } = await supabase.from('vendors').update({
        name: form.name.trim(),
        contact_person: form.contact_person.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        pan_vat_no: form.pan_vat_no.trim(),
        payment_terms: form.payment_terms.trim() || null
      }).eq('id', editing)
      if (error) { setError(error.message); setSaving(false); return false }
    } else {
      const { error } = await scopedInsert('vendors', {
        vendor_code: getNextVendorCode(),
        name: form.name.trim(),
        contact_person: form.contact_person.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        pan_vat_no: form.pan_vat_no.trim(),
        payment_terms: form.payment_terms.trim() || null
      })
      if (error) { setError(error.message); setSaving(false); return false }
    }
    setSaving(false)
    return true
  }

  async function save() {
    if (await doSave()) { setShowForm(false); loadVendors() }
  }

  // Save current vendor, then open the adjacent one (dir = +1 next / -1 prev) in the visible order.
  async function saveAndGo(dir) {
    const idx = filtered.findIndex(v => v.id === editing)
    const target = filtered[idx + dir]
    if (!target) return
    if (await doSave()) { loadVendors(); openEdit(target) }
  }

  function getNextVendorCode() {
    const prefix = (settings?.vendor_code_prefix || 'VND').toUpperCase()
    let maxNum = 0
    vendors.forEach(v => {
      const match = (v.vendor_code || '').match(new RegExp(`^${prefix}-(\\d+)$`))
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10))
    })
    return `${prefix}-${String(maxNum + 1).padStart(3, '0')}`
  }

  async function toggleActive(vendor) {
    await supabase.from('vendors').update({ is_active: !vendor.is_active }).eq('id', vendor.id)
    loadVendors()
  }

  async function deleteVendor(vendor) {
    const { count } = await supabase
      .from('purchase_entries')
      .select('*', { count: 'exact', head: true })
      .eq('vendor_id', vendor.id)
    if (count > 0) {
      alert(`Cannot delete "${vendor.name}" — it has ${count} purchase entr${count === 1 ? 'y' : 'ies'} linked to it. Deactivate instead.`)
      return
    }
    if (!window.confirm(`Permanently delete "${vendor.name}"? This cannot be undone.`)) return
    await supabase.from('vendors').delete().eq('id', vendor.id)
    loadVendors()
  }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  const filtered = vendors.filter(v =>
    !search ||
    v.name.toLowerCase().includes(search.toLowerCase()) ||
    (v.vendor_code || '').toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div>
      {/* Print-only header */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Vendors</h2>
      </div>

      <div className="page-header no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Vendors</h1>
          <p className="page-subtitle">Manage your supplier list — linked to daily purchase entries</p>
        </div>
        <button className="btn btn-ghost" onClick={() => printWithTitle('Vendors')}>Print</button>
      </div>

      {showForm && (
        <Modal onClose={() => setShowForm(false)} title={editing ? 'Edit Vendor' : 'Add Vendor'}>
          <div className="form-grid form-grid-3">
            <div className="form-field">
              <label htmlFor="vendor-f1">Vendor Name *</label>
              <input id="vendor-f1"
                value={form.name}
                onChange={e => { setFieldErr(''); setForm({ ...form, name: e.target.value }) }}
                placeholder="e.g. Big Mart, Arawat Suppliers"
                autoFocus
                {...fieldAria('vendor-f1', fieldErr)}
              />
              <FieldError id="vendor-f1" message={fieldErr} />
            </div>
            <div className="form-field">
              <label htmlFor="vendor-f2"><Tip text="Name of the sales rep or account manager at this supplier. Useful for direct contact on order issues.">Contact Person</Tip></label>
              <input id="vendor-f2"
                value={form.contact_person}
                onChange={e => setForm({ ...form, contact_person: e.target.value })}
                placeholder="Name"
              />
            </div>
            <div className="form-field">
              <label htmlFor="vendor-f3">Phone</label>
              <input id="vendor-f3"
                value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })}
                placeholder="98XXXXXXXX"
              />
            </div>
          </div>
          <div className="form-grid form-grid-3" style={{ marginTop: 18 }}>
            <div className="form-field" style={{ gridColumn: 'span 2' }}>
              <label htmlFor="vendor-f4">Address</label>
              <input id="vendor-f4"
                value={form.address}
                onChange={e => setForm({ ...form, address: e.target.value })}
                placeholder="e.g. Balaju, Kathmandu"
              />
            </div>
            <div className="form-field">
              <label htmlFor="vendor-f5"><Tip text="Supplier's PAN (Permanent Account Number) or VAT registration number. Required for VAT invoice reconciliation and IRD compliance." width={280}>PAN / VAT No.</Tip></label>
              <input id="vendor-f5"
                value={form.pan_vat_no}
                onChange={e => setForm({ ...form, pan_vat_no: e.target.value })}
                placeholder="e.g. 123456789"
              />
            </div>
          </div>
          <div className="form-grid form-grid-3" style={{ marginTop: 18 }}>
            <div className="form-field">
              <label htmlFor="vendor-f6"><Tip text="Standard credit period or payment arrangement agreed with this supplier, e.g. 'Net 30', 'COD', '50% Advance'. Shown on Outstanding Payables for reference.">Payment Terms</Tip></label>
              <input id="vendor-f6"
                value={form.payment_terms}
                onChange={e => setForm({ ...form, payment_terms: e.target.value })}
                placeholder="e.g. Net 30, COD"
              />
            </div>
          </div>
          {error && <p style={{ color: 'var(--theme-red-text)', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}
          <div className="form-actions" style={{ justifyContent: 'space-between' }}>
            {editing ? (() => {
              const idx = filtered.findIndex(v => v.id === editing)
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className="btn btn-ghost" onClick={() => saveAndGo(-1)} disabled={saving || idx <= 0}
                    title="Save & edit previous vendor" style={{ padding: '7px 12px' }}>← Prev</button>
                  <span style={{ fontSize: 12, color: 'var(--theme-text3)', minWidth: 64, textAlign: 'center' }}>
                    {idx >= 0 ? `${idx + 1} of ${filtered.length}` : ''}
                  </span>
                  <button className="btn btn-ghost" onClick={() => saveAndGo(1)} disabled={saving || idx < 0 || idx >= filtered.length - 1}
                    title="Save & edit next vendor" style={{ padding: '7px 12px' }}>Next →</button>
                </div>
              )
            })() : <span />}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Update Vendor' : 'Add Vendor'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      <div className="no-print" style={{ marginBottom: 16 }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search vendor name or code…"
          style={{
            background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)',
            padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 280
          }}
        />
        {search && (
          <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--theme-text2)' }}>
            {vendors.filter(v => v.name.toLowerCase().includes(search.toLowerCase()) || (v.vendor_code || '').toLowerCase().includes(search.toLowerCase())).length} matched
          </span>
        )}
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
        ) : vendors.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⊙</div>
            <p className="empty-state-text">No vendors yet. Add your suppliers to get started.</p>
          </div>
        ) : (
          <div className="table-wrap table-wrap--fab-clear">
            <table className="data-table">
              <thead>
                <tr>
                  <th><Tip text="Auto-generated vendor code used as a short reference on purchase entries and reports.">Code</Tip></th>
                  <th>Vendor Name</th>
                  <th>Contact Person</th>
                  <th>Phone</th>
                  <th><Tip text="Supplier's PAN or VAT registration number — needed for VAT invoice reconciliation." width={260}>PAN/VAT No.</Tip></th>
                  <th>Payment Terms</th>
                  <th>Address</th>
                  <th><Tip text="Active vendors appear in purchase entry dropdowns. Inactive vendors are hidden but their purchase history is preserved." width={280}>Status</Tip></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(v => (
                  <tr key={v.id}>
                    <td style={{ color: 'var(--theme-accent-ink)', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                      {v.vendor_code || '—'}
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{v.name}</td>
                    <td>{v.contact_person || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                    <td>{v.phone || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                    <td>{v.pan_vat_no || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                    <td>{v.payment_terms || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                    <td style={{ maxWidth: 220, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {v.address || <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                    </td>
                    <td>
                      {/* gray, not red: deactivating a vendor is routine housekeeping, not an error state, and red
                          is this module's overdue/loss colour everywhere else. Matches Items. */}
                      <span className={`badge ${v.is_active ? 'badge-green' : 'badge-gray'}`}>
                        {v.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <Link className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }}
                        to={`/vendor-balance-confirmation?vendor=${v.id}`}
                        title="Generate a printable balance confirmation letter for IRD Annexure 13 reconciliation with this vendor.">
                        Confirm Balance
                      </Link>
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }}
                        onClick={() => openEdit(v)}>
                        Edit
                      </button>
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }}
                        onClick={() => toggleActive(v)}>
                        {v.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                      {isAdmin && (
                        <button className="btn btn-danger" style={{ fontSize: 12, padding: '5px 12px' }}
                          onClick={() => deleteVendor(v)}>
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Fab onClick={openNew} label="+ Add Vendor" show={!showForm} />
    </div>
  )
}
