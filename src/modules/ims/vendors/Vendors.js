import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import UsageChip from '../../../components/UsageChip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { Navigate, Link } from 'react-router-dom'
import { FileText, Pencil, Eye, EyeOff, Trash2, Archive as ArchiveIcon, ArchiveRestore, Lock } from 'lucide-react'
import { printWithTitle } from '../../../utils/printTitle'
import { readPageCache, writePageCache } from '../../../shared/sessionDataCache'
import { fetchAllRowsChunked } from '../../../shared/fetchAllRows'

const EMPTY_FORM = { name: '', contact_person: '', phone: '', address: '', pan_vat_no: '', payment_terms: '' }

// Every table that points at a vendor. A vendor with any of these attached must not be hard-deleted,
// and the two reasons are different: purchase_entries and purchase_orders hold a plain FK, so
// Postgres refuses and the vendor survives — but vendor_returns and ims_gate_passes are ON DELETE
// SET NULL, so the delete SUCCEEDS and those rows quietly lose their supplier. vendor_returns keeps
// no name of its own, so that loss is unrecoverable and nothing on screen would say it happened.
// payable_payments hangs off purchase_entries rather than the vendor, so it is covered by that row.
// `code` is what the row's usage chip shows; P and VR mean the same here as they do in Item
// Master's Used In column, deliberately — one vocabulary across the two pages that use it.
const VENDOR_REF_TABLES = [
  { table: 'purchase_entries', code: 'P', label: 'Purchases', one: 'purchase entry', many: 'purchase entries' },
  { table: 'purchase_orders', code: 'PO', label: 'Purchase Orders', one: 'purchase order', many: 'purchase orders' },
  { table: 'vendor_returns', code: 'VR', label: 'Vendor Returns', one: 'vendor return', many: 'vendor returns' },
  { table: 'ims_gate_passes', code: 'GP', label: 'Gate Passes', one: 'gate pass', many: 'gate passes' },
]

// "12 purchase entries and 1 vendor return" — named in the reader's terms, not the table's, so the
// refusal says which screen to go look at.
function usagePhrase(counts) {
  const parts = VENDOR_REF_TABLES
    .filter(t => counts[t.table] > 0)
    .map(t => `${counts[t.table]} ${counts[t.table] === 1 ? t.one : t.many}`)
  if (parts.length === 0) return null
  const total = VENDOR_REF_TABLES.reduce((sum, t) => sum + (counts[t.table] || 0), 0)
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return { text, total }
}

export default function Vendors() {
  const { clientId, isAdmin, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  const { scopedFrom, scopedInsert } = useScopedDb()
  // Seeded from the short-lived session cache so a revisit paints the last-known list instantly
  // while the fresh read reloads quietly underneath (S460 pattern). Safe here: every save on this
  // page writes only the one vendor being edited, never a baseline derived from this list.
  const [cachedVendors] = useState(() => readPageCache('vendors', 'vendors', clientId))
  const [vendors, setVendors] = useState(cachedVendors ?? [])
  const [loading, setLoading] = useState(!cachedVendors)
  const [showForm, setShowForm] = useState(false)
  // Separate from the form's `error`, which only ever renders inside the Add/Edit modal — a delete
  // or a hide that fails happens from the LIST, where that message has nowhere to appear. Both
  // writes below used to discard their error entirely: the row simply reloaded unchanged, which
  // reads as "nothing was wrong with that" rather than as a refusal.
  const [listError, setListError] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Per-field validation. `error` above stays the form-level channel (no client selected, a write
  // the server rejected); a message about one box belongs under that box (S603).
  const [fieldErr, setFieldErr] = useState('')
  const [search, setSearch] = useState('')
  // Which vendors have records pointing at them. Two jobs: the usage chip beside every vendor name
  // (the same 🔗 mark Item Master shows, for anyone who can open this page), and gating the admin
  // Delete to the rows where it can actually succeed. `status` matters as much as `map`: 'loading'
  // hides the delete control rather than showing one that may vanish, and 'failed' SHOWS it — not
  // knowing is not the same as knowing it is clean, and the authoritative re-check in
  // deleteVendor() is what fails closed.
  const [usage, setUsage] = useState({ status: 'loading', map: {} })
  const [deleting, setDeleting] = useState(null) // vendor id whose delete is mid-flight
  const [showArchived, setShowArchived] = useState(false) // admin-only view of vendors taken off the page

  useEffect(() => { if (clientId) loadVendors() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadVendors() {
    if (vendors.length === 0) setLoading(true) // a cached (or already-loaded) list keeps showing while this refreshes
    const { data } = await scopedFrom('vendors').order('name')
    setVendors(data || [])
    writePageCache('vendors', 'vendors', clientId, data || [])
    setLoading(false)
    loadUsage(data || []) // deliberately not awaited — the list paints first, chips fill in after
  }

  // One read per referencing table over every vendor at once, rather than a count per vendor per
  // table (which would be 4 requests a row). Chunked and paged because purchase_entries alone
  // crosses PostgREST's silent 1000-row cap on any real client, and a truncated read here would
  // report a used vendor as unused — the exact shape S528 found on Items. Same cost and the same
  // shape as Items' own `checkAllUsage`, which runs this for every visitor across eight tables.
  async function loadUsage(list) {
    const ids = list.map(v => v.id)
    if (ids.length === 0) { setUsage({ status: 'ready', map: {} }); return }
    setUsage(u => ({ ...u, status: 'loading' }))
    // try/catch, not just the returned `error`: 'loading' renders NOTHING in the row's last slot,
    // so anything that throws rather than resolving (a rejected fetch, a table the schema cache has
    // not reloaded) would leave the control permanently absent with no error anywhere — the page
    // silently losing a feature instead of failing. 'failed' shows the button and lets the
    // click-time check refuse.
    let results
    try {
      results = await Promise.all(VENDOR_REF_TABLES.map(({ table }) =>
        fetchAllRowsChunked(ids, chunk =>
          supabase.from(table).select('vendor_id').in('vendor_id', chunk).order('id'))))
    } catch (e) {
      console.error('vendor usage check failed', e)
      setUsage({ status: 'failed', map: {} })
      return
    }
    if (results.some(r => r.error)) { setUsage({ status: 'failed', map: {} }); return }
    const map = {}
    results.forEach(({ data }, i) => {
      const key = VENDOR_REF_TABLES[i].table
      data.forEach(row => {
        if (!row.vendor_id) return
        if (!map[row.vendor_id]) map[row.vendor_id] = {}
        map[row.vendor_id][key] = (map[row.vendor_id][key] || 0) + 1
      })
    })
    setUsage({ status: 'ready', map })
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
      if (error) { setError(asActionError(error)); setSaving(false); return false }
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
      if (error) { setError(asActionError(error)); setSaving(false); return false }
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
    setListError(null)
    const { error } = await supabase.from('vendors').update({ is_active: !vendor.is_active }).eq('id', vendor.id)
    if (error) { setListError(asActionError(error)); return }
    loadVendors()
  }

  // Admin only, and the row-level gate below already hides this where `usage` says it cannot work.
  // The counts are re-read here anyway: the map is a page-load snapshot, and a bill entered on
  // another till since then must still be able to stop the delete.
  async function deleteVendor(vendor) {
    setListError(null)
    setDeleting(vendor.id)
    const results = await Promise.all(VENDOR_REF_TABLES.map(({ table }) =>
      supabase.from(table).select('*', { count: 'exact', head: true }).eq('vendor_id', vendor.id)))
    setDeleting(null)
    const failed = results.find(r => r.error)
    if (failed) {
      // Fail CLOSED. `count` is null on a failed read and `null > 0` is false, so the natural form
      // of this check would let a dropped connection wave the delete through — the guard stopping
      // working exactly when the network does (the shape named in CLAUDE.md).
      const { text, detail } = asActionError(failed.error)
      setListError({ text: `"${vendor.name}" was not deleted. What is attached to it could not be checked, and deleting without that check could take purchase history with the vendor. Nothing has changed — try again in a moment. ${text}`, detail })
      return
    }
    const counts = {}
    results.forEach((r, i) => { if (r.count > 0) counts[VENDOR_REF_TABLES[i].table] = r.count })
    const attached = usagePhrase(counts)
    if (attached) {
      // Not an error the user caused — it is the system protecting purchase history. Say what the
      // alternative is, and that it achieves what they actually wanted.
      setListError(`"${vendor.name}" can't be deleted — ${attached.text} ${attached.total === 1 ? 'is' : 'are'} recorded against it, and deleting the vendor would take that history with it. ${vendor.is_active ? 'Deactivate it first; an inactive vendor can then be archived, which' : 'Archive it instead: that'} takes it off this page and out of the purchase dropdowns while every past record keeps its supplier.`)
      setUsage(u => (u.status === 'ready' ? { status: 'ready', map: { ...u.map, [vendor.id]: counts } } : u))
      return
    }
    if (!window.confirm(`Permanently delete "${vendor.name}"? Nothing is recorded against it, so no history is lost — but this cannot be undone.`)) return
    setDeleting(vendor.id)
    const { error } = await supabase.from('vendors').delete().eq('id', vendor.id)
    setDeleting(null)
    if (error) { setListError(asActionError(error)); return }
    loadVendors()
  }

  // The answer for a vendor that HAS been bought from. The row leaves this page and every vendor
  // picker; the row itself stays, which is the only reason its name still resolves on the purchase
  // bills, returns and reports that reference it — those store `vendor_id` and nothing else.
  async function archiveVendor(vendor) {
    const attached = usagePhrase(usage.map[vendor.id] || {})
    const what = attached ? `Its ${attached.text} keep this name on every report.` : 'Its history keeps this name on every report.'
    if (!window.confirm(`Remove "${vendor.name}" from the Vendors page?

${what} This only takes it off this page and out of the vendor dropdowns.

You can put it back from "Show archived".`)) return
    setListError(null)
    setDeleting(vendor.id)
    // is_active goes with it: the DB CHECK requires it, and `is_active` is what every picker
    // filters on, so an archived-but-active vendor would keep appearing where it was archived to leave.
    const { error } = await supabase.from('vendors')
      .update({ archived_at: new Date().toISOString(), is_active: false }).eq('id', vendor.id)
    setDeleting(null)
    if (error) { setListError(asActionError(error)); return }
    loadVendors()
  }

  // Back on the page, and deliberately still inactive — restoring is undoing the removal, not
  // deciding the vendor is one you buy from again. Activate is a separate, visible click.
  async function restoreVendor(vendor) {
    setListError(null)
    setDeleting(vendor.id)
    const { error } = await supabase.from('vendors').update({ archived_at: null }).eq('id', vendor.id)
    setDeleting(null)
    if (error) { setListError(asActionError(error)); return }
    loadVendors()
  }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  // Archived vendors are off the page by default and invisible to anyone but an admin. They stay in
  // `vendors` (so getNextVendorCode still sees their codes and can't reuse one) and are split out here.
  const archivedCount = vendors.filter(v => v.archived_at).length
  const viewing = vendors.filter(v => (isAdmin && showArchived ? !!v.archived_at : !v.archived_at))
  const filtered = viewing.filter(v =>
    !search ||
    v.name.toLowerCase().includes(search.toLowerCase()) ||
    (v.vendor_code || '').toLowerCase().includes(search.toLowerCase())
  )

  // The 🔗 mark beside a vendor's code, so "have we actually bought from this one?" is answerable by
  // scanning the list rather than by opening a report. Same chip and the same short codes as Item
  // Master's Used In column — P and VR mean the same thing on both. Nothing renders while the usage
  // read is in flight or if it failed: an absent chip must only ever mean "no records", so a chip
  // that could also mean "we could not check" would be worse than no chip at all.
  function usageChip(v) {
    if (usage.status !== 'ready') return null
    const counts = usage.map[v.id] || {}
    const used = VENDOR_REF_TABLES.filter(t => counts[t.table] > 0)
    if (used.length === 0) return null
    const detail = used.map(t => `${counts[t.table]} ${counts[t.table] === 1 ? t.one : t.many}`).join(', ')
    return <UsageChip width={280} codes={used.map(t => t.code)}
      text={`Has records: ${detail}. A vendor with records can't be deleted — deactivate it, then archive it to take it off this page while every past record keeps its supplier.`} />
  }

  // What sits in the row's last slot for an admin — one of three, never a control whose answer is
  // already known (the S632 reading of a gate that can only refuse):
  //   nothing references it        → Delete, a real hard delete
  //   referenced, already inactive → Archive: off this page, name kept on every record
  //   referenced, still active     → neither; Deactivate is the step before Archive
  function adminSlot(v) {
    if (usage.status === 'loading') return null // resolves in a moment; better than a button that vanishes
    const attached = usage.status === 'ready' ? usagePhrase(usage.map[v.id] || {}) : null
    if (attached && !v.is_active) {
      return (
        <button className="btn btn-danger btn-icon"
          onClick={() => archiveVendor(v)} disabled={deleting === v.id}
          aria-label={`Archive ${v.name}`}
          title={`Archive ${v.name} — take it off the Vendors page. Its ${attached.text} keep the name, because the vendor row is what every report reads it from, so it is kept and hidden rather than deleted.`}>
          <ArchiveIcon />
        </button>
      )
    }
    if (attached) {
      // Not a disabled button: there is no action here, only a reason. The slot still holds
      // something, because an empty gap where every other row has a control explains nothing.
      return (
        <Tip width={300} style={{ alignSelf: 'center', border: 'none', display: 'inline-flex', color: 'var(--theme-text3)' }}
          text={`${attached.text} ${attached.total === 1 ? 'is' : 'are'} recorded against this vendor, so it can't be deleted without taking that history with it. Deactivate it first — an inactive vendor can then be archived, which removes it from this page while every past record keeps its supplier.`}>
          <Lock size={15} aria-label={`${v.name} is in use and cannot be deleted`} />
        </Tip>
      )
    }
    // status 'failed' lands here too: not knowing is not the same as knowing it is clean, and
    // deleteVendor() re-reads the counts and refuses on its own.
    return (
      <button className="btn btn-danger btn-icon"
        onClick={() => deleteVendor(v)} disabled={deleting === v.id}
        aria-label={`Delete ${v.name}`}
        title={`Permanently delete ${v.name}. Offered because no purchase, order, return or gate pass is recorded against it.`}>
        <Trash2 />
      </button>
    )
  }

  return (
    <div>
      {/* Print-only header */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Vendors</h2>
      </div>

      <div className="page-header page-header--split no-print">
        <div>
          <h1 className="page-title">Vendors</h1>
          <p className="page-subtitle">Manage your supplier list — linked to daily purchase entries</p>
        </div>
        <button className="btn btn-ghost" onClick={() => printWithTitle('Vendors')}>Print</button>
      </div>

      <ActionError error={listError} />

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
          <ActionError error={error} />
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
            {filtered.length} matched
          </span>
        )}
        {isAdmin && (archivedCount > 0 || showArchived) && (
          <button className="tab-btn" style={{ marginLeft: 10 }} aria-pressed={showArchived}
            onClick={() => setShowArchived(a => !a)}>
            {showArchived ? '← Back to vendor list' : `Show archived (${archivedCount})`}
          </button>
        )}
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
        ) : viewing.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⊙</div>
            <p className="empty-state-text">
              {showArchived
                ? 'Nothing archived. A vendor you have bought from can be archived once it is deactivated — it leaves this page and keeps its name on every past record.'
                : 'No vendors yet. Add your suppliers to get started.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap table-wrap--fab-clear">
            {/* Seven columns, not nine. Code moved under the name and the contact person under the
                phone — both are supporting detail, and a column of its own for each cost ~180px on a
                table that was already scrolling horizontally. Same move (and the same `.cell-sub`)
                as the Purchases bill list's "#3066 · 5 items", which took that column 223→122px.
                `--sticky-first` then works on the column that actually says WHICH vendor a row is:
                the identity stays put while the rest scrolls, which was the reported complaint. */}
            <table className="data-table data-table--sticky-first">
              <thead>
                <tr>
                  {/* The floor is what stops this column paying for every other one. Every column
                      right of it is nowrap — a phone, a PAN, a badge, a row of controls, none of
                      which can give width back — so under `table-layout: auto` the name is the only
                      thing left to squeeze, and at a 1024px window it collapsed to 111px and broke
                      real vendor names over five lines (rows 145px tall). At 180px they take two
                      lines and the row is 86px, for 59px more horizontal scroll — a trade worth
                      making only because this column is STICKY, so that scroll never takes the name
                      off screen. Inert at 1280+ where the column is already 238px. */}
                  <th style={{ minWidth: 180 }}><Tip width={300} text="The vendor's name, with its auto-generated code underneath — that code is the short reference used on purchase entries and reports. A 🔗 chip beside the code means this vendor already has records: P = Purchases, PO = Purchase Orders, VR = Vendor Returns, GP = Gate Passes. No chip means nothing has ever been bought from or issued against it.">Vendor</Tip></th>
                  <th><Tip text="Phone, with the sales rep or account manager's name underneath when one is recorded.">Phone / Contact</Tip></th>
                  <th><Tip text="Supplier's PAN or VAT registration number — needed for VAT invoice reconciliation." width={260}>PAN/VAT<span style={{ display: 'block' }}>No.</span></Tip></th>
                  <th><Tip text="Standard credit period or payment arrangement agreed with this supplier.">Payment<span style={{ display: 'block' }}>Terms</span></Tip></th>
                  <th>Address</th>
                  <th><Tip text="Active vendors appear in purchase entry dropdowns. Inactive vendors are hidden but their purchase history is preserved." width={280}>Status</Tip></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(v => (
                  <tr key={v.id}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {v.name}
                      <span className="cell-sub" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontFamily: 'monospace', color: 'var(--theme-accent-ink)' }}>
                          {v.vendor_code || '—'}
                        </span>
                        {usageChip(v)}
                      </span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {v.phone || <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                      {v.contact_person && <span className="cell-sub">{v.contact_person}</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{v.pan_vat_no || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                    <td>{v.payment_terms || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                    {/* The column that absorbs the squeeze: everything else here is a name, a number or
                        a control, all of which a line break either corrupts or cuts (S649). */}
                    <td style={{ maxWidth: 180 }}>
                      {v.address || <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                    </td>
                    <td>
                      {/* gray, not red: deactivating a vendor is routine housekeeping, not an error state, and red
                          is this module's overdue/loss colour everywhere else. Matches Items. */}
                      <span className={`badge ${v.archived_at ? 'badge-gray' : v.is_active ? 'badge-green' : 'badge-gray'}`}>
                        {v.archived_at ? 'Archived' : v.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    {/* Icon-only, so every control carries an aria-label (an icon has no accessible
                        name) and the same string on title for the pointer. Four text buttons were
                        ~340px of this table — see the .btn-icon comment in Layout.css. */}
                    <td style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <Link className="btn btn-ghost btn-icon"
                        to={`/vendor-balance-confirmation?vendor=${v.id}`}
                        aria-label={`Balance confirmation letter for ${v.name}`}
                        title={`Balance confirmation letter for ${v.name} — the printable IRD Annexure 13 reconciliation.`}>
                        <FileText />
                      </Link>
                      {/* An archived vendor is off the page on purpose: editing or activating it would put
                          it back in the purchase dropdowns by a side door (and Activate would trip the DB's
                          archived-implies-inactive CHECK). Restore first, then it is an ordinary row again.
                          Confirm Balance stays — reading its history is the reason the row was kept. */}
                      {v.archived_at ? (
                        <button className="btn btn-ghost btn-icon"
                          onClick={() => restoreVendor(v)} disabled={deleting === v.id}
                          aria-label={`Restore ${v.name}`}
                          title={`Restore ${v.name} to the Vendors page, still inactive.`}>
                          <ArchiveRestore />
                        </button>
                      ) : (
                        <>
                          <button className="btn btn-ghost btn-icon" onClick={() => openEdit(v)}
                            aria-label={`Edit ${v.name}`} title={`Edit ${v.name}`}>
                            <Pencil />
                          </button>
                          <button className="btn btn-ghost btn-icon" onClick={() => toggleActive(v)}
                            aria-label={v.is_active ? `Deactivate ${v.name}` : `Activate ${v.name}`}
                            title={v.is_active
                              ? `Deactivate ${v.name} — it stops appearing in purchase entry, and every past bill keeps it.`
                              : `Activate ${v.name} — it starts appearing in purchase entry again.`}>
                            {v.is_active ? <EyeOff /> : <Eye />}
                          </button>
                          {isAdmin && adminSlot(v)}
                        </>
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
