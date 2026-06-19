import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { bsToAd, formatAd, daysInBsMonth } from '../utils/bsCalendar'
import BsDatePicker from '../components/BsDatePicker'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

const EMPTY_FORM = { item_id: '', vendor_id: '', bs_day: '', qty: '', rate: '', invoice_ref: '', expiry_date: '', payment_method: 'Cash', vat_inclusive: false }
const EMPTY_RETURN = { purchase_entry_id: '', qty: '', notes: '' }
const PAYMENT_METHODS = ['Cash', 'Credit', 'FonePay']

export default function Purchases() {
  const { clientId, profile, loading: authLoading, isAdmin } = useAuth()
  const effectiveClientId = clientId || profile?.client_id

  // Shared
  const [periods, setPeriods]               = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [items, setItems]                   = useState([])
  const [vendors, setVendors]               = useState([])
  const [loading, setLoading]               = useState(true)
  const [activeTab, setActiveTab]           = useState('purchases')

  // Purchases tab
  const [purchases, setPurchases]           = useState([])
  const [showForm, setShowForm]             = useState(false)
  const [form, setForm]                     = useState(EMPTY_FORM)
  const [saving, setSaving]                 = useState(false)
  const [error, setError]                   = useState('')
  const [filterDay, setFilterDay]           = useState('all')
  const [filterItem, setFilterItem]         = useState('all')
  const [editingId, setEditingId]           = useState(null)
  const [shelfLifeDays, setShelfLifeDays]   = useState('')
  const [rateUpdatePrompt, setRateUpdatePrompt] = useState(null)

  // Returns tab
  const [returns, setReturns]               = useState([])
  const [showReturnForm, setShowReturnForm] = useState(false)
  const [returnForm, setReturnForm]         = useState(EMPTY_RETURN)
  const [returnSaving, setReturnSaving]     = useState(false)
  const [returnError, setReturnError]       = useState('')
  const [editingReturnId, setEditingReturnId] = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: i }, { data: v }] = await Promise.all([
      supabase.from('monthly_periods').select('*').eq('client_id', effectiveClientId).order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('items').select('*, categories(name)').eq('client_id', effectiveClientId).eq('is_active', true).order('name'),
      supabase.from('vendors').select('*').eq('client_id', effectiveClientId).eq('is_active', true).order('name')
    ])
    setPeriods(p || [])
    setItems(i || [])
    setVendors(v || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) {
      setSelectedPeriod(open)
      await Promise.all([loadPurchases(open.id), loadReturns(open.id)])
    }
    setLoading(false)
  }

  async function loadPurchases(periodId) {
    const { data } = await supabase
      .from('purchase_entries')
      .select('*, items(name, uom, purchase_unit, conversion_factor, categories(name)), vendors(name)')
      .eq('period_id', periodId)
      .order('bs_day')
      .order('created_at')
    setPurchases(data || [])
  }

  async function loadReturns(periodId) {
    const { data } = await supabase
      .from('vendor_returns')
      .select('*, items(name, uom, purchase_unit, conversion_factor), vendors(name), purchase_entries(bs_day, qty, rate)')
      .eq('period_id', periodId)
      .order('created_at')
    setReturns(data || [])
  }

  // Returns the effective conversion factor (>1) for an item, or 1 if no conversion set
  function getCf(item) {
    const cf = parseFloat(item?.conversion_factor)
    return (cf > 1 && item?.purchase_unit) ? cf : 1
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setFilterDay('all')
    setFilterItem('all')
    await Promise.all([loadPurchases(periodId), loadReturns(periodId)])
  }

  // ─── PURCHASES ───────────────────────────────────────────

  function openNew() {
    setEditingId(null)
    setForm({ ...EMPTY_FORM, rate: '', bs_day: '' })
    setShelfLifeDays('')
    setError('')
    setShowForm(true)
  }

  function openEdit(entry) {
    setEditingId(entry.id)
    const cf = getCf(entry.items)
    setForm({
      item_id: entry.item_id,
      vendor_id: entry.vendor_id || '',
      bs_day: entry.bs_day,
      qty:  cf > 1 ? entry.qty / cf  : entry.qty,
      rate: cf > 1 ? entry.rate * cf : entry.rate,
      invoice_ref: entry.invoice_ref || '',
      expiry_date: entry.expiry_date || '',
      payment_method: entry.payment_method || 'Cash',
      vat_inclusive: entry.vat_inclusive || false
    })
    setShelfLifeDays('')
    setError('')
    setShowForm(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function handleItemChange(itemId) {
    const item = items.find(i => i.id === itemId)
    setForm(f => ({ ...f, item_id: itemId, rate: item ? item.rate : '' }))
  }

  function handleBsDayChange(day) {
    setForm(f => ({ ...f, bs_day: day }))
    if (shelfLifeDays && day && selectedPeriod) recalcExpiry(day, shelfLifeDays)
  }

  function recalcExpiry(bsDay, days) {
    if (!bsDay || !days || !selectedPeriod) return
    const purchaseAd = bsToAd(selectedPeriod.bs_year, selectedPeriod.bs_month, parseInt(bsDay))
    const expiry = new Date(purchaseAd)
    expiry.setDate(expiry.getDate() + parseInt(days))
    setForm(f => ({ ...f, expiry_date: formatAd(expiry) }))
  }

  function handleShelfLifeChange(days) {
    setShelfLifeDays(days)
    if (days && form.bs_day) recalcExpiry(form.bs_day, days)
  }

  async function save() {
    if (!form.item_id) { setError('Select an item.'); return }
    const maxDay = selectedPeriod ? daysInBsMonth(selectedPeriod.bs_year, selectedPeriod.bs_month) : 32
    if (!form.bs_day || form.bs_day < 1 || form.bs_day > maxDay) { setError(`Select a valid day (1–${maxDay}).`); return }
    if (!form.qty || parseFloat(form.qty) <= 0) { setError('Enter a valid quantity.'); return }
    if (!form.rate || parseFloat(form.rate) <= 0) { setError('Enter a valid rate.'); return }

    const capturedItemId = form.item_id
    const capturedRate = form.vat_inclusive ? parseFloat(form.rate) / 1.13 : parseFloat(form.rate)

    setSaving(true)
    setError('')

    const selectedItem = items.find(i => i.id === form.item_id)
    const cf = getCf(selectedItem)
    const baseQty     = parseFloat(form.qty) * cf
    const enteredRate = parseFloat(form.rate)
    const exVatRate   = form.vat_inclusive ? enteredRate / 1.13 : enteredRate
    const baseRate    = exVatRate / cf

    const payload = {
      period_id: selectedPeriod.id,
      item_id: form.item_id,
      vendor_id: form.vendor_id || null,
      bs_day: parseInt(form.bs_day),
      qty: baseQty,
      rate: baseRate,
      invoice_ref: form.invoice_ref.trim() || null,
      expiry_date: form.expiry_date || null,
      payment_method: form.payment_method || 'Cash',
      vat_inclusive: form.vat_inclusive || false,
    }

    if (editingId) {
      const { error } = await supabase.from('purchase_entries').update(payload).eq('id', editingId)
      if (error) { setError(error.message); setSaving(false); return }
    } else {
      const { error } = await supabase.from('purchase_entries').insert(payload)
      if (error) { setError(error.message); setSaving(false); return }
    }

    setSaving(false)
    setShowForm(false)
    setEditingId(null)
    loadPurchases(selectedPeriod.id)

    const { data: freshItem } = await supabase
      .from('items').select('id, name, rate, purchase_qty').eq('id', capturedItemId).single()
    if (freshItem) {
      const oldRate = parseFloat(freshItem.rate)
      if (capturedRate !== oldRate) {
        setRateUpdatePrompt({ itemId: freshItem.id, itemName: freshItem.name, oldRate, newRate: capturedRate, purchaseQty: parseFloat(freshItem.purchase_qty) })
      }
    }
  }

  async function applyRateUpdate() {
    if (!rateUpdatePrompt) return
    const { itemId, newRate } = rateUpdatePrompt
    const { error } = await supabase.from('items').update({ rate: newRate }).eq('id', itemId)
    if (!error) setItems(prev => prev.map(i => i.id === itemId ? { ...i, rate: newRate } : i))
    setRateUpdatePrompt(null)
  }

  async function deleteEntry(id) {
    if (!window.confirm('Delete this purchase entry? Any returns linked to it will be unlinked.')) return
    await supabase.from('purchase_entries').delete().eq('id', id)
    loadPurchases(selectedPeriod.id)
    loadReturns(selectedPeriod.id)
  }

  // ─── RETURNS ─────────────────────────────────────────────

  function openNewReturn() {
    setEditingReturnId(null)
    setReturnForm(EMPTY_RETURN)
    setReturnError('')
    setShowReturnForm(true)
  }

  function openEditReturn(ret) {
    setEditingReturnId(ret.id)
    const cf = getCf(ret.items)
    setReturnForm({
      purchase_entry_id: ret.purchase_entry_id || '',
      qty: cf > 1 ? ret.qty / cf : ret.qty,   // DB stores base units; form shows purchase units
      notes: ret.notes || ''
    })
    setReturnError('')
    setShowReturnForm(true)
  }

  // When a purchase is selected, auto-derive item/vendor/rate/payment from it
  function getLinkedPurchase(purchaseEntryId) {
    return purchases.find(p => p.id === purchaseEntryId) || null
  }

  async function saveReturn() {
    if (!returnForm.purchase_entry_id) { setReturnError('Select a purchase entry to return against.'); return }
    const linked = getLinkedPurchase(returnForm.purchase_entry_id)
    if (!linked) { setReturnError('Linked purchase not found.'); return }
    const retQty = parseFloat(returnForm.qty)
    if (!returnForm.qty || retQty <= 0) { setReturnError('Enter a valid return quantity.'); return }
    const retCf = getCf(linked.items)
    const baseRetQty = retQty * retCf
    const linkedQty = parseFloat(linked.qty)
    if (baseRetQty > linkedQty) {
      const maxDisplay = retCf > 1 ? `${(linkedQty / retCf).toFixed(3)} ${linked.items?.purchase_unit}` : `${linkedQty} ${linked.items?.uom}`
      setReturnError(`Return qty cannot exceed original purchase qty (${maxDisplay}).`)
      return
    }

    setReturnSaving(true)
    setReturnError('')

    const payload = {
      client_id:          effectiveClientId,
      period_id:          selectedPeriod.id,
      purchase_entry_id:  linked.id,
      item_id:            linked.item_id,
      vendor_id:          linked.vendor_id || null,
      qty:                baseRetQty,
      rate:               parseFloat(linked.rate),
      payment_method:     linked.payment_method || 'Cash',
      bs_day:             linked.bs_day,
      notes:              returnForm.notes.trim() || null
    }

    if (editingReturnId) {
      const { error } = await supabase.from('vendor_returns').update(payload).eq('id', editingReturnId)
      if (error) { setReturnError(error.message); setReturnSaving(false); return }
    } else {
      const { error } = await supabase.from('vendor_returns').insert(payload)
      if (error) { setReturnError(error.message); setReturnSaving(false); return }
    }

    setReturnSaving(false)
    setShowReturnForm(false)
    setEditingReturnId(null)
    loadReturns(selectedPeriod.id)
  }

  async function deleteReturn(id) {
    if (!window.confirm('Delete this return entry?')) return
    await supabase.from('vendor_returns').delete().eq('id', id)
    loadReturns(selectedPeriod.id)
  }

  async function deleteAllPurchases() {
    if (!selectedPeriod || purchases.length === 0) return
    if (!window.confirm(`Delete ALL ${purchases.length} purchase entries for ${periodLabel}? This cannot be undone.`)) return
    await supabase.from('purchase_entries').delete().eq('period_id', selectedPeriod.id)
    await Promise.all([loadPurchases(selectedPeriod.id), loadReturns(selectedPeriod.id)])
  }

  async function deleteAllReturns() {
    if (!selectedPeriod || returns.length === 0) return
    if (!window.confirm(`Delete ALL ${returns.length} return entries for ${periodLabel}? This cannot be undone.`)) return
    await supabase.from('vendor_returns').delete().eq('period_id', selectedPeriod.id)
    loadReturns(selectedPeriod.id)
  }

  // ─── DERIVED ─────────────────────────────────────────────

  const filtered = purchases.filter(p => {
    const matchDay  = filterDay  === 'all' || p.bs_day === parseInt(filterDay)
    const matchItem = filterItem === 'all' || p.item_id === filterItem
    return matchDay && matchItem
  })

  const grossTotal  = purchases.reduce((s, p) => s + p.qty * p.rate, 0)
  const returnTotal = returns.reduce((s, r) => s + r.qty * r.rate, 0)
  const netTotal    = grossTotal - returnTotal
  const filteredValue = filtered.reduce((s, p) => s + p.qty * p.rate, 0)
  const uniqueDays  = [...new Set(purchases.map(p => p.bs_day))].sort((a, b) => a - b)

  const byDay = filtered.reduce((acc, p) => {
    const day = p.bs_day
    if (!acc[day]) acc[day] = []
    acc[day].push(p)
    return acc
  }, {})

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const isLocked = !isAdmin && selectedPeriod?.status === 'closed'

  return (
    <div>

      {/* Rate update toast */}
      {rateUpdatePrompt && (
        <div style={{ position: 'fixed', bottom: 28, right: 28, zIndex: 1000, background: '#181c27', border: '1px solid rgba(201,168,76,0.45)', borderRadius: 10, padding: '16px 20px', maxWidth: 360, boxShadow: '0 8px 32px rgba(0,0,0,0.55)' }}>
          <div style={{ fontSize: 13, color: '#e8e0d0', marginBottom: 4, fontWeight: 600 }}>
            📦 Rate changed — {rateUpdatePrompt.itemName}
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 14 }}>
            Item master: <span style={{ color: '#f87171', fontWeight: 600 }}>NPR {rateUpdatePrompt.oldRate.toLocaleString()}</span>
            {' → '}
            <span style={{ color: '#34d399', fontWeight: 600 }}>NPR {rateUpdatePrompt.newRate.toLocaleString()}</span>
            <br />
            <span style={{ color: '#6b7280' }}>New per-unit rate: NPR {(rateUpdatePrompt.newRate / rateUpdatePrompt.purchaseQty).toFixed(4)}</span>
            <br />
            <span style={{ color: '#6b7280', fontSize: 11, marginTop: 2, display: 'block' }}>This will update the Item Master and affect recipe costing.</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" style={{ fontSize: 12, padding: '6px 14px' }} onClick={applyRateUpdate}>Yes, update item master</button>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 14px' }} onClick={() => setRateUpdatePrompt(null)}>No, keep old rate</button>
          </div>
        </div>
      )}

      {/* Locked banner */}
      {isLocked && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: '#f87171' }}>
          🔒 <strong>This period is closed.</strong> Data is read-only. Contact your admin to re-open if needed.
        </div>
      )}

      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Purchases</h1>
          <p className="page-subtitle">Daily ingredient purchases & returns — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}</option>
            ))}
          </select>
          {activeTab === 'purchases'
            ? <button className="btn btn-primary" onClick={openNew} disabled={!selectedPeriod || isLocked}>+ Add Purchase</button>
            : <button className="btn btn-primary" onClick={openNewReturn} disabled={!selectedPeriod || isLocked || purchases.length === 0}>+ Add Return</button>
          }
        </div>
      </div>

      {/* Stats */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Total Entries</div>
          <div className="stat-value">{purchases.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Gross Purchases</div>
          <div className="stat-value gold" style={{ fontSize: 16 }}>NPR {grossTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Returns</div>
          <div className="stat-value" style={{ fontSize: 16, color: returnTotal > 0 ? '#f87171' : '#6b7280' }}>
            {returnTotal > 0 ? `−NPR ${returnTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
          </div>
          <div className="stat-sub">{returns.length} entr{returns.length !== 1 ? 'ies' : 'y'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net Purchases</div>
          <div className="stat-value gold" style={{ fontSize: 16 }}>NPR {netTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Period Status</div>
          <div className="stat-value" style={{ fontSize: 16 }}>
            <span className={`badge ${selectedPeriod?.status === 'open' ? 'badge-green' : 'badge-gray'}`}>{selectedPeriod?.status || '—'}</span>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '1px solid #2a2f3d', marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { id: 'purchases', label: `Purchases (${purchases.length})` },
            { id: 'returns',   label: `Returns (${returns.length})` }
          ].map(tab => (
            <button key={tab.id} onClick={() => { setActiveTab(tab.id); setShowForm(false); setShowReturnForm(false) }} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '10px 20px', fontSize: 13, fontWeight: 500,
              color: activeTab === tab.id ? '#c9a84c' : '#6b7280',
              borderBottom: activeTab === tab.id ? '2px solid #c9a84c' : '2px solid transparent',
              marginBottom: -1
            }}>{tab.label}</button>
          ))}
        </div>
        {!isLocked && (
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '5px 12px', marginBottom: 4, color: '#f87171', borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.07)' }}
            onClick={activeTab === 'purchases' ? deleteAllPurchases : deleteAllReturns}
            disabled={activeTab === 'purchases' ? purchases.length === 0 : returns.length === 0}
          >
            Delete All
          </button>
        )}
      </div>

      {/* ── PURCHASES TAB ── */}
      {activeTab === 'purchases' && (
        <>
          {/* Add/Edit Form */}
          {showForm && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h3 style={{ margin: '0 0 20px', fontSize: 15, color: '#e8e0d0' }}>
                {editingId ? 'Edit Purchase Entry' : 'Add Purchase Entry'}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr', gap: 14 }}>
                <div className="form-field">
                  <label>Item *</label>
                  <select value={form.item_id} onChange={e => handleItemChange(e.target.value)}>
                    <option value="">— Select item —</option>
                    {items.map(i => <option key={i.id} value={i.id}>{i.name} ({i.categories?.name || 'Uncategorised'})</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label>Vendor</label>
                  <select value={form.vendor_id} onChange={e => setForm(f => ({ ...f, vendor_id: e.target.value }))}>
                    <option value="">— None —</option>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label>Day (BS) *</label>
                  <BsDatePicker bsYear={selectedPeriod?.bs_year} bsMonth={selectedPeriod?.bs_month} value={form.bs_day} onChange={handleBsDayChange} />
                </div>
                <div className="form-field">
                  {(() => {
                    const selItem = items.find(i => i.id === form.item_id)
                    const cf = getCf(selItem)
                    const inputUnit = cf > 1 ? selItem.purchase_unit : (selItem?.uom || '')
                    return (
                      <>
                        <label>Qty {inputUnit ? `(${inputUnit})` : ''} *</label>
                        <input type="number" value={form.qty} onChange={e => setForm(f => ({ ...f, qty: e.target.value }))} placeholder="0" />
                        {cf > 1 && form.qty && (
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
                            = {(parseFloat(form.qty) * cf).toLocaleString()} {selItem?.uom}
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>
                <div className="form-field">
                  {(() => {
                    const selItem = items.find(i => i.id === form.item_id)
                    const cf = getCf(selItem)
                    return (
                      <>
                        <label>Rate{cf > 1 ? ` /${selItem.purchase_unit}` : ''} (NPR) *</label>
                        <input type="number" value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} placeholder="0" />
                      </>
                    )
                  })()}
                </div>
                <div className="form-field">
                  <label><Tip text="Optional reference to the vendor's bill or invoice number. Used in the FIFO report and for audit trail." width={240}>Invoice Ref</Tip></label>
                  <input value={form.invoice_ref} onChange={e => setForm(f => ({ ...f, invoice_ref: e.target.value }))} placeholder="Optional" />
                </div>
                <div className="form-field">
                  <label><Tip text="Optional. Best-before or use-by date. Used in the FIFO / expiry tracking report." width={220}>Expiry Date</Tip></label>
                  <input type="date" value={form.expiry_date} onChange={e => setForm(f => ({ ...f, expiry_date: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label><Tip text="Enter how many days this item stays fresh — expiry date is auto-calculated from the purchase day." width={240}>Shelf Life (days)</Tip></label>
                  <input type="number" min="0" value={shelfLifeDays} onChange={e => handleShelfLifeChange(e.target.value)} placeholder="Auto-fill" />
                </div>
                <div className="form-field">
                  <label><Tip text="Cash: paid on delivery. Credit: pay later (tracked in payables). FonePay: digital payment.">Payment</Tip></label>
                  <select value={form.payment_method} onChange={e => setForm(f => ({ ...f, payment_method: e.target.value }))}>
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div className="form-field" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                  <label style={{ visibility: 'hidden' }}>VAT</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: form.vat_inclusive ? '#c9a84c' : '#9ca3af', userSelect: 'none' }}>
                    <input type="checkbox" checked={form.vat_inclusive} onChange={e => setForm(f => ({ ...f, vat_inclusive: e.target.checked }))}
                      style={{ width: 15, height: 15, accentColor: '#c9a84c', cursor: 'pointer' }} />
                    <Tip text="Tick if the rate you entered includes 13% VAT. The system strips the VAT and stores the ex-VAT rate for accurate costing." width={240}>VAT Incl. (13%)</Tip>
                  </label>
                </div>
              </div>

              {form.qty && form.rate && (
                <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(201,168,76,0.08)', borderRadius: 6, display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
                  {(() => {
                    const selItem = items.find(i => i.id === form.item_id)
                    const cf = getCf(selItem)
                    const enteredQty = parseFloat(form.qty)
                    const enteredRate = parseFloat(form.rate)
                    const total = enteredQty * enteredRate
                    const perBase = cf > 1 ? enteredRate / cf : null
                    const vatBase = form.vat_inclusive ? total / 1.13 : null
                    const vatAmt  = form.vat_inclusive ? total - vatBase : null
                    return (
                      <>
                        <span style={{ fontSize: 13, color: '#c9a84c' }}>
                          Total: NPR {total.toLocaleString('en-NP', { maximumFractionDigits: 2 })}
                        </span>
                        {form.vat_inclusive && (
                          <>
                            <span style={{ fontSize: 12, color: '#9ca3af' }}>
                              Base (ex-VAT): NPR {vatBase.toLocaleString('en-NP', { maximumFractionDigits: 2 })}
                            </span>
                            <span style={{ fontSize: 12, color: '#fbbf24' }}>
                              VAT (13%): NPR {vatAmt.toLocaleString('en-NP', { maximumFractionDigits: 2 })}
                            </span>
                          </>
                        )}
                        {cf > 1 && selItem && (
                          <span style={{ fontSize: 13, color: '#6b7280' }}>
                            {enteredQty} {selItem.purchase_unit} × NPR {enteredRate.toLocaleString()} = {(enteredQty * cf).toLocaleString()} {selItem.uom}
                          </span>
                        )}
                        {perBase !== null && (
                          <span style={{ fontSize: 12, color: '#9ca3af' }}>
                            Per {selItem?.uom}: NPR {(form.vat_inclusive ? perBase / 1.13 : perBase).toFixed(4)}
                            {form.vat_inclusive && <span style={{ color: '#6b7280' }}> (ex-VAT)</span>}
                          </span>
                        )}
                        {cf === 1 && selItem?.purchase_qty && (
                          <span style={{ fontSize: 12, color: '#9ca3af' }}>
                            Per {selItem?.uom}: NPR {((form.vat_inclusive ? enteredRate / 1.13 : enteredRate) / parseFloat(selItem.purchase_qty)).toFixed(4)}
                            {form.vat_inclusive && <span style={{ color: '#6b7280' }}> (ex-VAT)</span>}
                          </span>
                        )}
                      </>
                    )
                  })()}
                </div>
              )}

              {error && <p style={{ color: '#f87171', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}
              <div className="form-actions">
                <button className="btn btn-ghost" onClick={() => { setShowForm(false); setEditingId(null) }}>Cancel</button>
                <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : editingId ? 'Update' : 'Add Entry'}</button>
              </div>
            </div>
          )}

          {/* Filters */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <select className="form-select" value={filterDay} onChange={e => setFilterDay(e.target.value)}>
              <option value="all">All Days</option>
              {uniqueDays.map(d => <option key={d} value={d}>Day {d}</option>)}
            </select>
            <select className="form-select" value={filterItem} onChange={e => setFilterItem(e.target.value)}>
              <option value="all">All Items</option>
              {items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
            {(filterDay !== 'all' || filterItem !== 'all') && (
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => { setFilterDay('all'); setFilterItem('all') }}>Clear Filters</button>
            )}
            <span style={{ fontSize: 13, color: '#6b7280' }}>{filtered.length} entr{filtered.length !== 1 ? 'ies' : 'y'}</span>
          </div>

          {/* Purchases table */}
          <div className="card">
            {loading ? (
              <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
            ) : purchases.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">↓</div>
                <p className="empty-state-text">No purchases recorded yet. Click + Add Purchase to start.</p>
              </div>
            ) : Object.keys(byDay).length === 0 ? (
              <div className="empty-state"><p className="empty-state-text">No entries match your filters.</p></div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Day</th><th>Item</th><th>Category</th><th>Vendor</th>
                      <th style={{ textAlign: 'right' }}>Qty</th><th>UOM</th>
                      <th style={{ textAlign: 'right' }}>Rate</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                      <th>Invoice / Expiry</th><th>Payment</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(byDay).sort((a, b) => a - b).map(day =>
                      byDay[day].map((entry, idx) => (
                        <tr key={entry.id}>
                          {idx === 0 && (
                            <td rowSpan={byDay[day].length} style={{ fontWeight: 700, color: '#c9a84c', fontSize: 14, borderRight: '1px solid #2a2f3d', verticalAlign: 'top', paddingTop: 14 }}>
                              {day}
                              {selectedPeriod && (
                                <div style={{ fontSize: 10, fontWeight: 400, color: '#9ca3af', marginTop: 2 }}>
                                  {formatAd(bsToAd(selectedPeriod.bs_year, selectedPeriod.bs_month, parseInt(day)))}
                                </div>
                              )}
                            </td>
                          )}
                          <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{entry.items?.name}</td>
                          <td>{entry.items?.categories?.name ? <span className="badge badge-yellow">{entry.items.categories.name}</span> : <span style={{ color: '#9ca3af' }}>—</span>}</td>
                          <td style={{ color: '#6b7280' }}>{entry.vendors?.name || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                          {(() => {
                            const cf = getCf(entry.items)
                            const displayQty  = cf > 1 ? entry.qty / cf : entry.qty
                            const displayUnit = cf > 1 ? entry.items.purchase_unit : entry.items?.uom
                            const displayRate = cf > 1 ? entry.rate * cf : entry.rate
                            return (
                              <>
                                <td style={{ textAlign: 'right' }}>
                                  {Number(displayQty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                                  {cf > 1 && <div style={{ fontSize: 10, color: '#6b7280' }}>{Number(entry.qty).toLocaleString()} {entry.items?.uom}</div>}
                                </td>
                                <td style={{ color: '#6b7280' }}>{displayUnit}</td>
                                <td style={{ textAlign: 'right' }}>
                                  {Number(displayRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                  {cf > 1 && <div style={{ fontSize: 10, color: '#6b7280' }}>NPR {Number(entry.rate).toFixed(4)}/{entry.items?.uom}</div>}
                                </td>
                              </>
                            )
                          })()}
                          <td style={{ textAlign: 'right', color: '#c9a84c', fontWeight: 600 }}>
                            {(entry.qty * entry.rate).toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                          </td>
                          <td style={{ fontSize: 12, color: '#6b7280' }}>
                            {entry.invoice_ref && <div>{entry.invoice_ref}</div>}
                            {entry.expiry_date && <div style={{ color: '#c9a84c', fontSize: 11 }}>{entry.expiry_date}</div>}
                            {!entry.invoice_ref && !entry.expiry_date && '—'}
                          </td>
                          <td>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                              <span className={`badge ${entry.payment_method === 'Cash' ? 'badge-green' : entry.payment_method === 'Credit' ? 'badge-red' : 'badge-yellow'}`}>
                                {entry.payment_method || 'Cash'}
                              </span>
                              {entry.vat_inclusive && <span style={{ color: '#fbbf24', fontWeight: 700, fontSize: 10 }}>+VAT</span>}
                            </div>
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {!isLocked && (
                              <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEdit(entry)}>Edit</button>
                                <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteEntry(entry.id)}>Del</button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                    <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                      <td colSpan={7} style={{ fontWeight: 700, color: '#6b7280', paddingTop: 12 }}>Total</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', fontSize: 15, paddingTop: 12 }}>
                        NPR {filteredValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── RETURNS TAB ── */}
      {activeTab === 'returns' && (
        <>
          {purchases.length === 0 && (
            <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#c9a84c' }}>
              No purchases exist for this period yet. Add purchases first before recording returns.
            </div>
          )}

          {/* Return Add/Edit Form */}
          {showReturnForm && (
            <div className="card" style={{ marginBottom: 24, borderColor: 'rgba(248,113,113,0.3)' }}>
              <h3 style={{ margin: '0 0 20px', fontSize: 15, color: '#f87171' }}>
                {editingReturnId ? 'Edit Return' : 'Record Return to Vendor'}
              </h3>

              <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 2fr', gap: 16 }}>
                <div className="form-field">
                  <label>Purchase Entry to Return *</label>
                  <select
                    value={returnForm.purchase_entry_id}
                    onChange={e => setReturnForm(f => ({ ...f, purchase_entry_id: e.target.value, qty: '' }))}
                  >
                    <option value="">— Select a purchase entry —</option>
                    {purchases.map(p => {
                      const cf = getCf(p.items)
                      const dQty  = cf > 1 ? p.qty / cf : p.qty
                      const dUnit = cf > 1 ? p.items?.purchase_unit : p.items?.uom
                      const dRate = cf > 1 ? p.rate * cf : p.rate
                      return (
                        <option key={p.id} value={p.id}>
                          Day {p.bs_day} · {p.items?.name} · {Number(dQty).toLocaleString(undefined, { maximumFractionDigits: 3 })} {dUnit} @ NPR {Number(dRate).toLocaleString(undefined, { maximumFractionDigits: 2 })} ({p.payment_method || 'Cash'}) {p.vendors?.name ? `— ${p.vendors.name}` : ''}
                        </option>
                      )
                    })}
                  </select>
                </div>

                <div className="form-field">
                  {(() => {
                    const linked = getLinkedPurchase(returnForm.purchase_entry_id)
                    const cf = getCf(linked?.items)
                    const inputUnit = cf > 1 ? linked.items.purchase_unit : (linked?.items?.uom || '')
                    const maxInInputUnits = linked ? (cf > 1 ? linked.qty / cf : linked.qty) : ''
                    return (
                      <>
                        <label>Return Qty {inputUnit ? `(${inputUnit})` : ''} *</label>
                        <input
                          type="number" min="0.001" step="any"
                          value={returnForm.qty}
                          onChange={e => setReturnForm(f => ({ ...f, qty: e.target.value }))}
                          placeholder={maxInInputUnits ? `Max ${Number(maxInInputUnits).toLocaleString(undefined, { maximumFractionDigits: 3 })}` : '0'}
                        />
                        {linked && (
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                            Original: {cf > 1
                              ? `${(linked.qty / cf).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${linked.items.purchase_unit} (${Number(linked.qty).toLocaleString()} ${linked.items?.uom})`
                              : `${Number(linked.qty).toLocaleString()} ${linked.items?.uom}`}
                          </div>
                        )}
                        {cf > 1 && returnForm.qty && (
                          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                            = {(parseFloat(returnForm.qty) * cf).toLocaleString()} {linked?.items?.uom}
                          </div>
                        )}
                      </>
                    )
                  })()}
                </div>

                <div className="form-field">
                  <label>Notes (optional)</label>
                  <input
                    value={returnForm.notes}
                    onChange={e => setReturnForm(f => ({ ...f, notes: e.target.value }))}
                    placeholder="Reason for return, damaged batch, etc."
                  />
                </div>
              </div>

              {/* Auto-inherited fields preview */}
              {returnForm.purchase_entry_id && (() => {
                const linked = getLinkedPurchase(returnForm.purchase_entry_id)
                if (!linked) return null
                const cf = getCf(linked.items)
                const displayRate = cf > 1 ? linked.rate * cf : linked.rate
                const displayRateUnit = cf > 1 ? linked.items?.purchase_unit : linked.items?.uom
                const baseRetQty = returnForm.qty ? parseFloat(returnForm.qty) * cf : 0
                const retValue = baseRetQty * linked.rate
                return (
                  <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: 6, fontSize: 13, color: '#6b7280', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                    <span>Rate: <strong style={{ color: '#e8e0d0' }}>NPR {Number(displayRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}/{displayRateUnit}</strong></span>
                    <span>Vendor: <strong style={{ color: '#e8e0d0' }}>{linked.vendors?.name || '—'}</strong></span>
                    <span>Payment: <strong style={{ color: '#e8e0d0' }}>{linked.payment_method || 'Cash'}</strong></span>
                    {retValue > 0 && <span>Return Value: <strong style={{ color: '#f87171' }}>−NPR {retValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</strong></span>}
                    <span style={{ color: '#9ca3af', fontSize: 11 }}>Rate, vendor & payment inherited from original purchase</span>
                  </div>
                )
              })()}

              {returnError && <p style={{ color: '#f87171', fontSize: 13, margin: '10px 0 0' }}>{returnError}</p>}
              <div className="form-actions">
                <button className="btn btn-ghost" onClick={() => { setShowReturnForm(false); setEditingReturnId(null) }}>Cancel</button>
                <button className="btn btn-primary" style={{ background: '#7f1d1d', borderColor: '#f87171' }} onClick={saveReturn} disabled={returnSaving}>
                  {returnSaving ? 'Saving…' : editingReturnId ? 'Update Return' : 'Record Return'}
                </button>
              </div>
            </div>
          )}

          {/* Returns table */}
          <div className="card">
            {returns.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">↩</div>
                <p className="empty-state-text">No returns recorded for this period. Click + Add Return to record a vendor return.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Day</th><th>Item</th><th>Vendor</th>
                      <th style={{ textAlign: 'right' }}>Returned Qty</th><th>UOM</th>
                      <th style={{ textAlign: 'right' }}>Rate</th>
                      <th style={{ textAlign: 'right' }}>Return Value</th>
                      <th>Payment</th><th>Notes</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {returns.map(ret => (
                      <tr key={ret.id}>
                        <td style={{ fontWeight: 700, color: '#c9a84c' }}>{ret.bs_day || '—'}</td>
                        <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{ret.items?.name}</td>
                        <td style={{ color: '#6b7280' }}>{ret.vendors?.name || <span style={{ color: '#9ca3af' }}>—</span>}</td>
                        {(() => {
                          const cf = getCf(ret.items)
                          const displayQty  = cf > 1 ? ret.qty / cf : ret.qty
                          const displayUnit = cf > 1 ? ret.items.purchase_unit : ret.items?.uom
                          const displayRate = cf > 1 ? ret.rate * cf : ret.rate
                          return (
                            <>
                              <td style={{ textAlign: 'right', color: '#f87171', fontWeight: 600 }}>
                                −{Number(displayQty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                                {cf > 1 && <div style={{ fontSize: 10, color: '#9ca3af' }}>{Number(ret.qty).toLocaleString()} {ret.items?.uom}</div>}
                              </td>
                              <td style={{ color: '#6b7280' }}>{displayUnit}</td>
                              <td style={{ textAlign: 'right' }}>{Number(displayRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            </>
                          )
                        })()}
                        <td style={{ textAlign: 'right', color: '#f87171', fontWeight: 700 }}>
                          −NPR {(ret.qty * ret.rate).toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                        </td>
                        <td>
                          <span className={`badge ${ret.payment_method === 'Cash' ? 'badge-green' : ret.payment_method === 'Credit' ? 'badge-red' : 'badge-yellow'}`}>
                            {ret.payment_method || 'Cash'}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: '#6b7280' }}>{ret.notes || '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          {!isLocked && (
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEditReturn(ret)}>Edit</button>
                              <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteReturn(ret.id)}>Del</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                      <td colSpan={6} style={{ fontWeight: 700, color: '#6b7280', paddingTop: 12 }}>Total Returns</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#f87171', fontSize: 15, paddingTop: 12 }}>
                        −NPR {returnTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                      </td>
                      <td colSpan={3}></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

    </div>
  )
}
