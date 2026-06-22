import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { bsToAd, formatAd, daysInBsMonth } from '../utils/bsCalendar'
import BsDatePicker from '../components/BsDatePicker'
import Tip from '../components/Tip'
import * as XLSX from 'xlsx'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

const EMPTY_HEADER = { vendor_id: '', bs_day: '', invoice_ref: '', payment_method: 'Cash', discount: '' }
const EMPTY_RETURN = { purchase_entry_id: '', qty: '', notes: '' }
const PAYMENT_METHODS = ['Cash', 'Credit', 'FonePay']
const newLine = () => ({ _key: Date.now() + Math.random(), item_id: '', qty: '', rate: '', expiry_date: '', shelf_life: '', vat_inclusive: false })

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
  const [saving, setSaving]                 = useState(false)
  const [error, setError]                   = useState('')
  const [filterDay, setFilterDay]           = useState('all')
  const [filterItem, setFilterItem]         = useState('all')
  const [editingGroupId, setEditingGroupId] = useState(null)
  const [rateUpdateItems, setRateUpdateItems]       = useState([])
  const [rateUpdateSelected, setRateUpdateSelected] = useState(new Set())
  // Bill (multi-row add) state
  const [billHeader, setBillHeader]         = useState(EMPTY_HEADER)
  const [billLines, setBillLines]           = useState([newLine()])


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
      supabase.from('items').select('*, categories(name)').eq('client_id', effectiveClientId).eq('is_active', true).eq('is_sub_recipe', false).order('name'),
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
    setEditingGroupId(null)
    setBillHeader({ ...EMPTY_HEADER })
    setBillLines([newLine()])
    setError('')
    setShowForm(true)
  }

  function openEditGroup(groupId) {
    const groupEntries = purchases.filter(p => (p.purchase_group_id || p.id) === groupId)
    if (groupEntries.length === 0) return
    const first = groupEntries[0]
    setEditingGroupId(groupId)
    setBillHeader({
      vendor_id: first.vendor_id || '',
      bs_day: String(first.bs_day),
      invoice_ref: first.invoice_ref || '',
      payment_method: first.payment_method || 'Cash',
      discount: first.discount_amount ? String(first.discount_amount) : ''
    })
    setBillLines(groupEntries.map(e => {
      const item = items.find(i => i.id === e.item_id)
      const cf = getCf(item)
      return {
        _key: Date.now() + Math.random(),
        item_id: e.item_id,
        qty: String(cf > 1 ? e.qty / cf : e.qty),
        rate: String(cf > 1 ? e.rate * cf : e.rate),
        expiry_date: e.expiry_date || '',
        shelf_life: '',
        vat_inclusive: e.vat_inclusive || false,
      }
    }))
    setError('')
    setShowForm(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // ─── BILL (multi-row add) ────────────────────────────────

  function handleHeaderDayChange(day) {
    setBillHeader(h => ({ ...h, bs_day: day }))
    if (day && selectedPeriod) {
      setBillLines(prev => prev.map(l => {
        if (!l.shelf_life) return l
        const ad = bsToAd(selectedPeriod.bs_year, selectedPeriod.bs_month, parseInt(day))
        const exp = new Date(ad); exp.setDate(exp.getDate() + parseInt(l.shelf_life))
        return { ...l, expiry_date: formatAd(exp) }
      }))
    }
  }

  function updateBillLine(key, field, val) {
    setBillLines(prev => prev.map(l => {
      if (l._key !== key) return l
      const updated = { ...l, [field]: val }
      if (field === 'item_id') {
        const item = items.find(i => i.id === val)
        if (item?.rate) updated.rate = String(item.rate)
      }
      if (field === 'shelf_life' && val && billHeader.bs_day && selectedPeriod) {
        const ad = bsToAd(selectedPeriod.bs_year, selectedPeriod.bs_month, parseInt(billHeader.bs_day))
        const exp = new Date(ad); exp.setDate(exp.getDate() + parseInt(val))
        updated.expiry_date = formatAd(exp)
      }
      return updated
    }))
  }

  function addBillLine() { setBillLines(prev => [...prev, newLine()]) }
  function removeBillLine(key) { setBillLines(prev => prev.length > 1 ? prev.filter(l => l._key !== key) : prev) }

  async function saveBill() {
    const maxDay = selectedPeriod ? daysInBsMonth(selectedPeriod.bs_year, selectedPeriod.bs_month) : 32
    if (!billHeader.bs_day || billHeader.bs_day < 1 || billHeader.bs_day > maxDay) {
      setError(`Enter a valid BS day (1–${maxDay}).`); return
    }
    const valid = billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0)
    if (valid.length === 0) { setError('Add at least one item with item, qty and rate filled.'); return }

    setSaving(true); setError('')

    const discountAmt = parseFloat(billHeader.discount) || 0
    const entries = valid.map(l => {
      const item = items.find(i => i.id === l.item_id)
      const cf = getCf(item)
      const exVatRate = parseFloat(l.rate)  // entered rate is always ex-VAT (NetRate on bill)
      return {
        period_id:       selectedPeriod.id,
        item_id:         l.item_id,
        vendor_id:       billHeader.vendor_id || null,
        bs_day:          parseInt(billHeader.bs_day),
        qty:             parseFloat(l.qty) * cf,
        rate:            exVatRate / cf,
        invoice_ref:     billHeader.invoice_ref.trim() || null,
        expiry_date:     l.expiry_date || null,
        payment_method:  billHeader.payment_method || 'Cash',
        vat_inclusive:   l.vat_inclusive || false,
        discount_amount: discountAmt,
      }
    })

    if (editingGroupId) {
      const { error: delErr } = await supabase.from('purchase_entries').delete().eq('purchase_group_id', editingGroupId)
      if (delErr) { setError(delErr.message); setSaving(false); return }
      const { error: insErr } = await supabase.from('purchase_entries').insert(entries.map(e => ({ ...e, purchase_group_id: editingGroupId })))
      if (insErr) { setError(insErr.message); setSaving(false); return }
    } else {
      const groupId = crypto.randomUUID()
      const { error: insErr } = await supabase.from('purchase_entries').insert(entries.map(e => ({ ...e, purchase_group_id: groupId })))
      if (insErr) { setError(insErr.message); setSaving(false); return }
    }

    setSaving(false)
    setShowForm(false)
    setEditingGroupId(null)
    loadPurchases(selectedPeriod.id)

    // Rate update check — collect ALL items whose entered rate differs from Item Master
    const changed = []
    for (const l of valid) {
      const capturedRate = parseFloat(l.rate)
      const { data: fi } = await supabase.from('items').select('id, name, rate, purchase_qty').eq('id', l.item_id).single()
      if (fi && capturedRate !== parseFloat(fi.rate)) {
        changed.push({ itemId: fi.id, itemName: fi.name, oldRate: parseFloat(fi.rate), newRate: capturedRate, purchaseQty: parseFloat(fi.purchase_qty) })
      }
    }
    if (changed.length > 0) {
      setRateUpdateItems(changed)
      setRateUpdateSelected(new Set(changed.map(i => i.itemId)))
    }
  }

  async function applyRateUpdates() {
    const toUpdate = rateUpdateItems.filter(i => rateUpdateSelected.has(i.itemId))
    await Promise.all(toUpdate.map(i => supabase.from('items').update({ rate: i.newRate }).eq('id', i.itemId)))
    setItems(prev => prev.map(i => {
      const upd = toUpdate.find(r => r.itemId === i.id)
      return upd ? { ...i, rate: upd.newRate } : i
    }))
    setRateUpdateItems([])
    setRateUpdateSelected(new Set())
  }

  async function deleteGroup(groupId) {
    const groupEntries = purchases.filter(p => (p.purchase_group_id || p.id) === groupId)
    const n = groupEntries.length
    const groupTotal = groupEntries.reduce((s, e) => s + e.qty * e.rate, 0)
    if (!window.confirm(`Delete this bill (${n} item${n !== 1 ? 's' : ''}, NPR ${Math.round(groupTotal).toLocaleString('en-NP')})? Any returns linked to these entries will be unlinked. This cannot be undone.`)) return
    const hasGroupId = groupEntries[0]?.purchase_group_id
    if (hasGroupId) {
      await supabase.from('purchase_entries').delete().eq('purchase_group_id', groupId)
    } else {
      for (const e of groupEntries) {
        await supabase.from('purchase_entries').delete().eq('id', e.id)
      }
    }
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
    if (!acc[day]) acc[day] = {}
    const gid = p.purchase_group_id || p.id
    if (!acc[day][gid]) acc[day][gid] = []
    acc[day][gid].push(p)
    return acc
  }, {})

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const isLocked = !isAdmin && selectedPeriod?.status === 'closed'

  return (
    <div>

      {/* Rate update modal */}
      {rateUpdateItems.length > 0 && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#181c27', border: '1px solid rgba(201,168,76,0.3)', borderRadius: 12, padding: '24px 28px', maxWidth: 520, width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#e8e0d0', marginBottom: 4 }}>📦 Rate changes detected</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>Select items to update in the Item Master. This affects recipe costing going forward.</div>

            {/* Select all */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#9ca3af', marginBottom: 10, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox"
                checked={rateUpdateSelected.size === rateUpdateItems.length}
                onChange={e => setRateUpdateSelected(e.target.checked ? new Set(rateUpdateItems.map(i => i.itemId)) : new Set())} />
              Select all ({rateUpdateItems.length} item{rateUpdateItems.length !== 1 ? 's' : ''})
            </label>

            {/* Item rows */}
            <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
              {rateUpdateItems.map(item => (
                <label key={item.itemId} style={{ display: 'flex', alignItems: 'center', gap: 12, background: '#0f1117', borderRadius: 7, padding: '10px 12px', cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox"
                    checked={rateUpdateSelected.has(item.itemId)}
                    onChange={e => {
                      const next = new Set(rateUpdateSelected)
                      e.target.checked ? next.add(item.itemId) : next.delete(item.itemId)
                      setRateUpdateSelected(next)
                    }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#e8e0d0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.itemName}</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>per-unit → NPR {(item.newRate / item.purchaseQty).toFixed(4)}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 13 }}>
                    <span style={{ color: '#f87171', fontWeight: 600 }}>NPR {item.oldRate.toLocaleString()}</span>
                    <span style={{ color: '#6b7280' }}> → </span>
                    <span style={{ color: '#34d399', fontWeight: 600 }}>NPR {item.newRate.toLocaleString()}</span>
                  </div>
                </label>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" style={{ fontSize: 12, padding: '7px 16px' }}
                onClick={applyRateUpdates} disabled={rateUpdateSelected.size === 0}>
                Update {rateUpdateSelected.size} item{rateUpdateSelected.size !== 1 ? 's' : ''}
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '7px 16px' }}
                onClick={() => { setRateUpdateItems([]); setRateUpdateSelected(new Set()) }}>
                Skip all
              </button>
            </div>
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
            { id: 'returns',   label: `Returns (${returns.length})` },
            { id: 'register',  label: 'Daily Register' },
          ].map(tab => (
            <button key={tab.id} onClick={() => {
              setActiveTab(tab.id); setShowForm(false); setShowReturnForm(false)
            }} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '10px 20px', fontSize: 13, fontWeight: 500,
              color: activeTab === tab.id ? '#c9a84c' : '#6b7280',
              borderBottom: activeTab === tab.id ? '2px solid #c9a84c' : '2px solid transparent',
              marginBottom: -1
            }}>{tab.label}</button>
          ))}
        </div>
        {!isLocked && activeTab !== 'register' && (
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
          {/* ── BILL FORM (new or edit) ── */}
          {showForm && (
            <div className="card" style={{ marginBottom: 24 }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 15, color: '#e8e0d0' }}>{editingGroupId ? 'Edit Purchase Bill' : 'Add Purchase Bill'}</h3>

              {/* Header row */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr 1fr', gap: 14, marginBottom: 20 }}>
                <div className="form-field">
                  <label>Vendor</label>
                  <select className="form-select" value={billHeader.vendor_id} onChange={e => setBillHeader(h => ({ ...h, vendor_id: e.target.value }))}>
                    <option value="">— None —</option>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label>Day (BS) *</label>
                  <BsDatePicker bsYear={selectedPeriod?.bs_year} bsMonth={selectedPeriod?.bs_month} value={billHeader.bs_day} onChange={handleHeaderDayChange} />
                </div>
                <div className="form-field">
                  <label><Tip text="Vendor's invoice or bill number. Shared across all items on this bill." width={240}>Invoice Ref</Tip></label>
                  <input value={billHeader.invoice_ref} onChange={e => setBillHeader(h => ({ ...h, invoice_ref: e.target.value }))} placeholder="Optional" />
                </div>
                <div className="form-field">
                  <label><Tip text="Cash: paid on delivery. Credit: pay later. FonePay: digital payment. Applied to all items on this bill.">Payment</Tip></label>
                  <select className="form-select" value={billHeader.payment_method} onChange={e => setBillHeader(h => ({ ...h, payment_method: e.target.value }))}>
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ borderTop: '1px solid #2a2f3d', marginBottom: 16 }} />

              {/* Line items table — mirrors vendor bill: Item | Qty | NetRate | NetAmt | VAT */}
              <div className="table-wrap">
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', fontSize: 11, color: '#6b7280', padding: '0 8px 10px 0', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                        <Tip text="Select the item. Expiry date and shelf-life days appear below the dropdown." width={230}>Item *</Tip>
                      </th>
                      <th style={{ textAlign: 'right', fontSize: 11, color: '#6b7280', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 100 }}>Qty *</th>
                      <th style={{ textAlign: 'right', fontSize: 11, color: '#6b7280', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 120 }}>
                        <Tip text="Enter the ex-VAT rate per unit (NetRate on the vendor bill). For VAT items the amount column will show the VAT-inclusive total." width={260}>Rate (NPR) *</Tip>
                      </th>
                      <th style={{ textAlign: 'right', fontSize: 11, color: '#6b7280', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 120 }}>
                        <Tip text="Amount = Qty × Rate. For VAT items: Qty × Rate × 1.13 (what you actually pay)." width={240}>Amount</Tip>
                      </th>
                      <th style={{ textAlign: 'center', fontSize: 11, color: '#6b7280', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 50 }}>
                        <Tip text="Tick if this item attracts 13% VAT. Enter the ex-VAT NetRate — the Amount column will show what you pay including VAT." width={250}>VAT</Tip>
                      </th>
                      <th style={{ width: 32 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {billLines.map((line) => {
                      const selItem = items.find(i => i.id === line.item_id)
                      const cf = getCf(selItem)
                      const inputUnit = cf > 1 ? selItem.purchase_unit : (selItem?.uom || '')
                      const lineBase = (parseFloat(line.qty) || 0) * (parseFloat(line.rate) || 0)
                      const lineAmount = line.vat_inclusive ? lineBase * 1.13 : lineBase
                      return (
                        <tr key={line._key} style={{ borderBottom: '1px solid #1a1f2e' }}>
                          <td style={{ padding: '6px 8px 6px 0', verticalAlign: 'top' }}>
                            <select className="form-select" style={{ width: '100%' }} value={line.item_id}
                              onChange={e => updateBillLine(line._key, 'item_id', e.target.value)}>
                              <option value="">— Select item —</option>
                              {items.map(i => <option key={i.id} value={i.id}>{i.name}{i.categories?.name ? ` (${i.categories.name})` : ''}</option>)}
                            </select>
                            <div style={{ display: 'flex', gap: 6, marginTop: 5, alignItems: 'center' }}>
                              <span style={{ fontSize: 10, color: '#4b5563', whiteSpace: 'nowrap' }}>Expiry</span>
                              <input type="date" value={line.expiry_date}
                                onChange={e => updateBillLine(line._key, 'expiry_date', e.target.value)}
                                style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 4, padding: '3px 6px', fontSize: 11, color: line.expiry_date ? '#9ca3af' : '#4b5563', outline: 'none', flex: 1 }} />
                              <span style={{ fontSize: 10, color: '#4b5563', whiteSpace: 'nowrap' }}>Shelf life</span>
                              <input type="number" min="0" value={line.shelf_life} placeholder="days"
                                onChange={e => updateBillLine(line._key, 'shelf_life', e.target.value)}
                                title="Enter days to auto-fill expiry date"
                                style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 4, padding: '3px 6px', fontSize: 11, color: '#9ca3af', outline: 'none', width: 52, textAlign: 'right' }} />
                            </div>
                          </td>
                          <td style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                            <input type="number" min="0" step="any" value={line.qty} placeholder="0"
                              onChange={e => updateBillLine(line._key, 'qty', e.target.value)}
                              style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: '100%', textAlign: 'right' }} />
                            {inputUnit && <div style={{ fontSize: 10, color: '#6b7280', textAlign: 'right', marginTop: 2 }}>{inputUnit}</div>}
                            {cf > 1 && line.qty && <div style={{ fontSize: 10, color: '#9ca3af', textAlign: 'right' }}>= {(parseFloat(line.qty) * cf).toLocaleString()} {selItem?.uom}</div>}
                          </td>
                          <td style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                            <input type="number" min="0" step="any" value={line.rate} placeholder="0"
                              onChange={e => updateBillLine(line._key, 'rate', e.target.value)}
                              style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: '100%', textAlign: 'right' }} />
                            {line.vat_inclusive && parseFloat(line.rate) > 0 && (
                              <div style={{ fontSize: 10, color: '#fbbf24', textAlign: 'right', marginTop: 2 }}>
                                +VAT: {(parseFloat(line.rate) * 0.13).toFixed(2)} → {(parseFloat(line.rate) * 1.13).toFixed(2)}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '6px 8px', verticalAlign: 'top', textAlign: 'right' }}>
                            {lineAmount > 0 && (
                              <>
                                <div style={{ fontSize: 13, color: '#c9a84c', fontWeight: 600 }}>
                                  {lineAmount.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </div>
                                {line.vat_inclusive && <div style={{ fontSize: 10, color: '#fbbf24', marginTop: 1 }}>incl. VAT</div>}
                              </>
                            )}
                          </td>
                          <td style={{ padding: '6px 8px', verticalAlign: 'top', textAlign: 'center' }}>
                            <input type="checkbox" checked={line.vat_inclusive}
                              onChange={e => updateBillLine(line._key, 'vat_inclusive', e.target.checked)}
                              style={{ width: 16, height: 16, accentColor: '#c9a84c', cursor: 'pointer', marginTop: 10 }} />
                          </td>
                          <td style={{ padding: '6px 0', verticalAlign: 'top', textAlign: 'right' }}>
                            <button onClick={() => removeBillLine(line._key)}
                              style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: 18, padding: '4px', lineHeight: 1 }}>×</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 14, gap: 16 }}>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 14px' }} onClick={addBillLine}>+ Add Item</button>
                {(() => {
                  const subTotal   = billLines.reduce((s, l) => s + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0), 0)
                  const vatTotal   = billLines.filter(l => l.vat_inclusive).reduce((s, l) => s + (parseFloat(l.qty) || 0) * (parseFloat(l.rate) || 0) * 0.13, 0)
                  const grossTotal = subTotal + vatTotal
                  const discount   = parseFloat(billHeader.discount) || 0
                  const grandTotal = grossTotal - discount
                  if (subTotal === 0) return null
                  return (
                    <div style={{ textAlign: 'right', fontSize: 13, minWidth: 280 }}>
                      <div style={{ color: '#9ca3af', marginBottom: 3 }}>
                        Subtotal (ex-VAT): <span style={{ color: '#e8e0d0', fontWeight: 600, marginLeft: 8 }}>NPR {subTotal.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                      {vatTotal > 0 && (
                        <div style={{ color: '#9ca3af', marginBottom: 3 }}>
                          VAT (13%): <span style={{ color: '#fbbf24', fontWeight: 600, marginLeft: 8 }}>NPR {vatTotal.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                        </div>
                      )}
                      <div style={{ color: '#9ca3af', marginBottom: 3 }}>
                        Gross Total: <span style={{ color: '#e8e0d0', fontWeight: 600, marginLeft: 8 }}>NPR {grossTotal.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginBottom: 6 }}>
                        <span style={{ color: '#9ca3af', fontSize: 12 }}><Tip text="Promo or trade discount given by the vendor on the total bill. Stored against all items on this bill." width={240}>Discount (NPR):</Tip></span>
                        <span style={{ color: '#f87171', fontSize: 12 }}>−</span>
                        <input
                          type="number" min="0" step="any"
                          value={billHeader.discount}
                          onChange={e => setBillHeader(h => ({ ...h, discount: e.target.value }))}
                          placeholder="0.00"
                          style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5, padding: '5px 8px', fontSize: 12, color: '#f87171', outline: 'none', width: 90, textAlign: 'right' }}
                        />
                      </div>
                      <div style={{ color: '#c9a84c', fontWeight: 700, fontSize: 14, borderTop: '1px solid #2a2f3d', paddingTop: 6 }}>
                        Grand Total: NPR {grandTotal.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </div>
                    </div>
                  )
                })()}
              </div>

              {error && <p style={{ color: '#f87171', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}
              <div className="form-actions">
                <button className="btn btn-ghost" onClick={() => { setShowForm(false); setEditingGroupId(null) }}>Cancel</button>
                <button className="btn btn-primary" onClick={saveBill} disabled={saving}>
                  {saving ? 'Saving…' : editingGroupId ? 'Update Bill' : `Save ${billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0).length || ''} Entr${billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0).length === 1 ? 'y' : 'ies'}`}
                </button>
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
            {!isLocked && (
              <button className="btn btn-primary" style={{ marginLeft: 'auto', fontSize: 12, padding: '5px 14px' }} onClick={openNew} disabled={!selectedPeriod}>+ Add Purchase</button>
            )}
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
                      <th>Invoice / Expiry</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(byDay).sort((a, b) => a - b).flatMap(day => {
                      const dayGroupsObj = byDay[day]
                      const groupIds = Object.keys(dayGroupsObj)
                      return groupIds.flatMap((gid, gIdx) => {
                        const groupEntries = dayGroupsObj[gid]
                        const first = groupEntries[0]
                        const groupTotal   = groupEntries.reduce((s, e) => s + e.qty * e.rate, 0)
                        const vatAmount    = groupEntries.filter(e => e.vat_inclusive).reduce((s, e) => s + e.qty * e.rate * 0.13, 0)
                        const discountAmt  = parseFloat(first.discount_amount) || 0
                        return [
                          // Group header row
                          <tr key={`gh-${gid}`} style={{ background: 'rgba(201,168,76,0.04)', borderTop: gIdx > 0 ? '2px solid #1a1f2e' : undefined }}>
                            <td style={{ fontWeight: 700, color: '#c9a84c', fontSize: 14, borderRight: '1px solid #2a2f3d', verticalAlign: 'middle', paddingTop: 10, paddingBottom: 10 }}>
                              {gIdx === 0 ? (
                                <>
                                  {day}
                                  {selectedPeriod && (
                                    <div style={{ fontSize: 10, fontWeight: 400, color: '#9ca3af', marginTop: 2 }}>
                                      {formatAd(bsToAd(selectedPeriod.bs_year, selectedPeriod.bs_month, parseInt(day)))}
                                    </div>
                                  )}
                                </>
                              ) : null}
                            </td>
                            <td colSpan={3} style={{ verticalAlign: 'middle' }}>
                              <span style={{ fontWeight: 600, color: '#e8e0d0' }}>{first.vendors?.name || <span style={{ color: '#6b7280' }}>No Vendor</span>}</span>
                              {first.invoice_ref && <span style={{ color: '#6b7280', fontSize: 12, marginLeft: 10 }}>#{first.invoice_ref}</span>}
                              <span style={{ color: '#4b5563', fontSize: 11, marginLeft: 10 }}>{groupEntries.length} item{groupEntries.length !== 1 ? 's' : ''}</span>
                            </td>
                            <td colSpan={3}></td>
                            <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', fontSize: 13, verticalAlign: 'middle' }}>
                              {(groupTotal + vatAmount - discountAmt).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              {vatAmount > 0 && <div style={{ fontSize: 10, color: '#fbbf24', fontWeight: 400 }}>+VAT: {vatAmount.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
                              {discountAmt > 0 && <div style={{ fontSize: 10, color: '#f87171', fontWeight: 400 }}>−Disc: {discountAmt.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
                            </td>
                            <td></td>
                            <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
                                <span className={`badge ${first.payment_method === 'Cash' ? 'badge-green' : first.payment_method === 'Credit' ? 'badge-red' : 'badge-yellow'}`}>
                                  {first.payment_method || 'Cash'}
                                </span>
                                {!isLocked && <>
                                  <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEditGroup(gid)}>Edit</button>
                                  <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteGroup(gid)}>Del</button>
                                </>}
                              </div>
                            </td>
                          </tr>,
                          // Item sub-rows
                          ...groupEntries.map(entry => (
                            <tr key={entry.id} style={{ background: 'rgba(0,0,0,0.12)', borderBottom: '1px solid #1a1f2e' }}>
                              <td></td>
                              <td style={{ fontWeight: 500, color: '#b8b0a0', paddingLeft: 20, fontSize: 13 }}>{entry.items?.name}</td>
                              <td>{entry.items?.categories?.name ? <span className="badge badge-yellow">{entry.items.categories.name}</span> : <span style={{ color: '#9ca3af' }}>—</span>}</td>
                              <td></td>
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
                              <td style={{ textAlign: 'right', color: '#c9a84c' }}>
                                {(entry.qty * entry.rate).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td style={{ fontSize: 12, color: '#6b7280' }}>
                                {entry.expiry_date ? <span style={{ color: '#c9a84c', fontSize: 11 }}>{entry.expiry_date}</span> : '—'}
                              </td>
                              <td></td>
                            </tr>
                          ))
                        ]
                      })
                    })}
                    <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                      <td colSpan={7} style={{ fontWeight: 700, color: '#6b7280', paddingTop: 12 }}>Total</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', fontSize: 15, paddingTop: 12 }}>
                        NPR {filteredValue.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Bottom Add Purchase — saves scrolling back up on long lists */}
          {!isLocked && purchases.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 14px' }} onClick={openNew} disabled={!selectedPeriod}>+ Add Purchase</button>
            </div>
          )}
        </>
      )}

      {/* ── RETURNS TAB ── */}
      {activeTab === 'returns' && (
        <>
          {!isLocked && purchases.length > 0 && !showReturnForm && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
              <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 14px', background: '#7f1d1d', borderColor: '#f87171' }}
                onClick={openNewReturn}>+ Add Return</button>
            </div>
          )}
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
                          −NPR {(ret.qty * ret.rate).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
                        −NPR {returnTotal.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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

      {/* ── DAILY REGISTER TAB ── */}
      {activeTab === 'register' && (() => {
        if (!selectedPeriod) return null
        const numDays = daysInBsMonth(selectedPeriod.bs_year, selectedPeriod.bs_month)
        const days = Array.from({ length: numDays }, (_, i) => i + 1)

        // day matrix: item_id → { day → base qty }
        const dayMatrix = {}
        purchases.forEach(p => {
          if (!dayMatrix[p.item_id]) dayMatrix[p.item_id] = {}
          dayMatrix[p.item_id][p.bs_day] = (dayMatrix[p.item_id][p.bs_day] || 0) + parseFloat(p.qty || 0)
        })

        // items with at least one purchase, grouped by category
        const purchasedIds = new Set(purchases.map(p => p.item_id))
        const byCategory = {}
        items.filter(i => purchasedIds.has(i.id)).forEach(item => {
          const cat = item.categories?.name || 'Uncategorized'
          if (!byCategory[cat]) byCategory[cat] = []
          byCategory[cat].push(item)
        })
        const sortedCats = Object.keys(byCategory).sort()

        function exportRegisterExcel() {
          const wb = XLSX.utils.book_new()
          const rows = []
          sortedCats.forEach(cat => {
            rows.push({ 'S.No': '', 'Item Name': cat.toUpperCase(), UOM: '' })
            byCategory[cat].forEach((item, idx) => {
              const row = {
                'S.No': idx + 1,
                'Item Name': item.name,
                'UOM': item.uom,
              }
              days.forEach(d => {
                const qty = dayMatrix[item.id]?.[d]
                row[String(d)] = qty ? parseFloat(qty.toFixed(3)) : ''
              })
              rows.push(row)
            })
          })
          const ws = XLSX.utils.json_to_sheet(rows)
          XLSX.utils.book_append_sheet(wb, ws, 'Daily Register')
          XLSX.writeFile(wb, `Purchase-Register-${BS_MONTHS[selectedPeriod.bs_month - 1]}-${selectedPeriod.bs_year}.xlsx`)
        }

        const thStyle = { fontSize: 11, color: '#6b7280', padding: '6px 8px', textTransform: 'uppercase', letterSpacing: '0.05em', background: '#13172100', borderBottom: '2px solid #2a2f3d', whiteSpace: 'nowrap', textAlign: 'right' }
        const tdStyle = { padding: '5px 8px', fontSize: 12, borderBottom: '1px solid #1a1f2e', textAlign: 'right', whiteSpace: 'nowrap' }

        return (
          <div className="card" style={{ padding: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px 10px' }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#e8e0d0' }}>Daily Purchase Register</span>
                <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 12 }}>{BS_MONTHS[selectedPeriod.bs_month - 1]} {selectedPeriod.bs_year} · {purchases.length} entries</span>
              </div>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 14px' }} onClick={exportRegisterExcel} disabled={purchases.length === 0}>
                Export Excel
              </button>
            </div>
            {purchases.length === 0 ? (
              <div className="empty-state" style={{ padding: '40px 0' }}>
                <div className="empty-state-icon">📋</div>
                <p className="empty-state-text">No purchases recorded this period.</p>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, textAlign: 'center', width: 36 }}>S.No</th>
                      <th style={{ ...thStyle, textAlign: 'left', minWidth: 160 }}>Item Name</th>
                      <th style={{ ...thStyle, width: 48 }}>UOM</th>
                      {days.map(d => (
                        <th key={d} style={{ ...thStyle, width: 52, color: d % 2 === 0 ? '#6b7280' : '#9ca3af' }}>{d}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCats.map(cat => (
                      <>
                        {/* Category header */}
                        <tr key={`cat-${cat}`} style={{ background: 'rgba(201,168,76,0.06)' }}>
                          <td colSpan={3 + numDays} style={{ padding: '6px 10px', fontWeight: 700, fontSize: 11, color: '#c9a84c', letterSpacing: '0.08em', textTransform: 'uppercase', borderBottom: '1px solid #2a2f3d' }}>
                            {cat}
                          </td>
                        </tr>
                        {byCategory[cat].map((item, idx) => {
                          return (
                            <tr key={item.id} style={{ background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                              <td style={{ ...tdStyle, textAlign: 'center', color: '#4b5563' }}>{idx + 1}</td>
                              <td style={{ ...tdStyle, textAlign: 'left', color: '#e8e0d0', fontWeight: 500 }}>{item.name}</td>
                              <td style={{ ...tdStyle, color: '#6b7280' }}>{item.uom}</td>
                              {days.map(d => {
                                const qty = dayMatrix[item.id]?.[d]
                                return (
                                  <td key={d} style={{ ...tdStyle, color: qty ? '#e8e0d0' : '#2a2f3d', background: qty ? 'rgba(201,168,76,0.06)' : undefined, fontWeight: qty ? 600 : 400 }}>
                                    {qty ? qty.toLocaleString('en-NP', { maximumFractionDigits: 2 }) : '·'}
                                  </td>
                                )
                              })}
                            </tr>
                          )
                        })}
                      </>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })()}

    </div>
  )
}
