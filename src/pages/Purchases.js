import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import { bsToAd, formatAd, daysInBsMonth } from '../utils/bsCalendar'
import BsCalendarPicker from '../components/BsCalendarPicker'
import Tip from '../components/Tip'
import Fab from '../components/Fab'
import Modal from '../components/Modal'
import SearchableSelect from '../components/SearchableSelect'
import * as XLSX from 'xlsx'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

const EMPTY_HEADER = { vendor_id: '', bs_day: '', invoice_ref: '', payment_method: 'Cash', discount: '', vat_inclusive: false }
const EMPTY_RETURN = { purchase_entry_id: '', qty: '', notes: '' }
const PAYMENT_METHODS = ['Cash', 'Credit', 'FonePay']
const newLine = () => ({ _key: Date.now() + Math.random(), item_id: '', qty: '', rate: '', expiry_date: '', shelf_life: '', vat_inclusive: false, _amtDraft: '' })

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
      discount: first.discount_amount ? String(first.discount_amount) : '',
      vat_inclusive: first.vat_inclusive || false,
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
        _amtDraft: '',
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
        updated._amtDraft = ''
      }
      if (field === 'rate' || field === 'vat_inclusive') updated._amtDraft = ''
      if (field === 'shelf_life' && val && billHeader.bs_day && selectedPeriod) {
        const ad = bsToAd(selectedPeriod.bs_year, selectedPeriod.bs_month, parseInt(billHeader.bs_day))
        const exp = new Date(ad); exp.setDate(exp.getDate() + parseInt(val))
        updated.expiry_date = formatAd(exp)
      }
      return updated
    }))
  }

  function setLineTotal(key, amtStr) {
    setBillLines(prev => prev.map(l => {
      if (l._key !== key) return l
      const qty = parseFloat(l.qty)
      const amt = parseFloat(amtStr)
      const rate = (qty > 0 && amt > 0)
        ? String((amt / qty / (l.vat_inclusive ? 1.13 : 1)).toFixed(5))
        : l.rate
      return { ...l, _amtDraft: amtStr, rate }
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
    if (!effectiveClientId) { setReturnError('No client selected. Pick a client in the top-left switcher before saving.'); return }
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

  // Options for the searchable item picker (built once per items change).
  const itemOptions = useMemo(
    () => items.map(i => ({ value: i.id, label: `${i.name}${i.categories?.name ? ` (${i.categories.name})` : ''}` })),
    [items]
  )

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

  // Number of distinct bills (groups) per day — shown on each day pill
  const billCountPerDay = useMemo(() => {
    const map = {}
    purchases.forEach(p => {
      const gid = p.purchase_group_id || p.id
      if (!map[p.bs_day]) map[p.bs_day] = new Set()
      map[p.bs_day].add(gid)
    })
    return Object.fromEntries(Object.entries(map).map(([d, s]) => [parseInt(d), s.size]))
  }, [purchases])

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
          <div style={{ background: 'var(--theme-card)', border: '1px solid rgba(201,168,76,0.3)', borderRadius: 12, padding: '24px 28px', maxWidth: 520, width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 4 }}>📦 Rate changes detected</div>
            <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 16 }}>Select items to update in the Item Master. This affects recipe costing going forward.</div>

            {/* Select all */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--theme-text3)', marginBottom: 10, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox"
                checked={rateUpdateSelected.size === rateUpdateItems.length}
                onChange={e => setRateUpdateSelected(e.target.checked ? new Set(rateUpdateItems.map(i => i.itemId)) : new Set())} />
              Select all ({rateUpdateItems.length} item{rateUpdateItems.length !== 1 ? 's' : ''})
            </label>

            {/* Item rows */}
            <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
              {rateUpdateItems.map(item => (
                <label key={item.itemId} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--theme-bg)', borderRadius: 7, padding: '10px 12px', cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox"
                    checked={rateUpdateSelected.has(item.itemId)}
                    onChange={e => {
                      const next = new Set(rateUpdateSelected)
                      e.target.checked ? next.add(item.itemId) : next.delete(item.itemId)
                      setRateUpdateSelected(next)
                    }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.itemName}</div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>per-unit → NPR {(item.newRate / item.purchaseQty).toFixed(4)}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 13 }}>
                    <span style={{ color: 'var(--theme-red)', fontWeight: 600 }}>NPR {item.oldRate.toLocaleString()}</span>
                    <span style={{ color: 'var(--theme-text2)' }}> → </span>
                    <span style={{ color: 'var(--theme-green)', fontWeight: 600 }}>NPR {item.newRate.toLocaleString()}</span>
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
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red)' }}>
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
          <div className="stat-value" style={{ fontSize: 16, color: returnTotal > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '1px solid var(--theme-border)', marginBottom: 24 }}>
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
              color: activeTab === tab.id ? 'var(--theme-accent)' : 'var(--theme-text2)',
              borderBottom: activeTab === tab.id ? '2px solid var(--theme-accent)' : '2px solid transparent',
              marginBottom: -1
            }}>{tab.label}</button>
          ))}
        </div>
        {!isLocked && activeTab !== 'register' && (
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '5px 12px', marginBottom: 4, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.07)' }}
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
            <Modal onClose={() => { setShowForm(false); setEditingGroupId(null) }} title={editingGroupId ? 'Edit Purchase Bill' : 'Add Purchase Bill'}>
              {/* Header row */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.4fr auto 90px 1fr', gap: 14, marginBottom: 20, alignItems: 'end' }}>
                <div className="form-field">
                  <label>Vendor</label>
                  <select className="form-select" style={{ fontSize: 13 }} value={billHeader.vendor_id} onChange={e => setBillHeader(h => ({ ...h, vendor_id: e.target.value }))}>
                    <option value="">— None —</option>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label>Day (BS) *</label>
                  <BsCalendarPicker lockYear={selectedPeriod?.bs_year} lockMonth={selectedPeriod?.bs_month} value={billHeader.bs_day} onChange={handleHeaderDayChange} placeholder="Pick day" />
                </div>
                <div className="form-field">
                  <label><Tip text="Vendor's invoice or bill number. Shared across all items on this bill." width={240}>Invoice Ref</Tip></label>
                  <input value={billHeader.invoice_ref} onChange={e => setBillHeader(h => ({ ...h, invoice_ref: e.target.value }))} placeholder="Optional"
                    style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', boxSizing: 'border-box' }} />
                </div>
                <div className="form-field">
                  <label><Tip text="Apply 13% VAT to all line items at once. You can also toggle VAT on each individual line row." width={270}>VAT</Tip></label>
                  {(() => {
                    const allVat  = billLines.every(l => l.vat_inclusive)
                    const someVat = billLines.some(l => l.vat_inclusive)
                    return (
                      <button
                        type="button"
                        onClick={() => setBillLines(ls => ls.map(l => ({ ...l, vat_inclusive: !allVat })))}
                        style={{ cursor: 'pointer', background: 'none', border: 'none', padding: '8px 4px', display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
                      >
                        <div style={{ width: 34, height: 18, borderRadius: 9, background: allVat ? '#f59e0b' : someVat ? '#b45309' : 'var(--theme-border)', position: 'relative', transition: 'background 0.2s', flexShrink: 0 }}>
                          <div style={{ position: 'absolute', top: 3, left: allVat ? 17 : someVat ? 11 : 3, width: 12, height: 12, borderRadius: '50%', background: '#fff', transition: 'left 0.2s' }} />
                        </div>
                        <span style={{ fontSize: 13, fontWeight: someVat ? 700 : 400, color: allVat ? '#f59e0b' : someVat ? '#b45309' : 'var(--theme-text3)', letterSpacing: '0.04em' }}>
                          {allVat ? 'VAT 13%' : someVat ? 'VAT Mixed' : 'No VAT'}
                        </span>
                      </button>
                    )
                  })()}
                </div>
                <div className="form-field">
                  <label><Tip text="Promo or trade discount on the total bill. Applied before VAT — VAT is levied only on the net taxable amount." width={260}>Discount (NPR)</Tip></label>
                  <input type="number" min="0" step="any"
                    value={billHeader.discount}
                    onChange={e => setBillHeader(h => ({ ...h, discount: e.target.value }))}
                    placeholder="0"
                    style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: 'var(--theme-red)', outline: 'none', width: '90px', textAlign: 'right' }} />
                </div>
                <div className="form-field">
                  <label><Tip text="Cash: paid on delivery. Credit: pay later. FonePay: digital payment. Applied to all items on this bill.">Payment</Tip></label>
                  <select className="form-select" style={{ fontSize: 13 }} value={billHeader.payment_method} onChange={e => setBillHeader(h => ({ ...h, payment_method: e.target.value }))}>
                    {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--theme-border)', marginBottom: 16 }} />

              {/* Line items table — mirrors vendor bill: Item | Qty | NetRate | NetAmt | VAT */}
              <div className="table-wrap">
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px 0', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                        <Tip text="Select the item. Expiry date and shelf-life days appear below the dropdown." width={230}>Item *</Tip>
                      </th>
                      <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 90 }}>Qty *</th>
                      <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 115 }}>
                        <Tip text="Enter the ex-VAT rate per unit. Check the VAT box on each line for items attracting 13% VAT." width={270}>Rate (NPR) *</Tip>
                      </th>
                      <th style={{ textAlign: 'center', fontSize: 11, color: 'var(--theme-text2)', padding: '0 4px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 44 }}>
                        <Tip text="Check to apply 13% VAT to this line item only." width={210}>VAT</Tip>
                      </th>
                      <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 115 }}>
                        <Tip text="Enter total paid for this line — Rate is back-calculated automatically." width={230}>Total (NPR)</Tip>
                      </th>
                      <th style={{ textAlign: 'right', fontSize: 11, color: 'var(--theme-text2)', padding: '0 8px 10px', textTransform: 'uppercase', letterSpacing: '0.07em', width: 115 }}>
                        <Tip text="Amount = Qty × Rate. For VAT items: Qty × Rate × 1.13 (what you actually pay)." width={240}>Amount</Tip>
                      </th>
                      <th style={{ width: 32 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {billLines.map((line, lineIdx) => {
                      const selItem = items.find(i => i.id === line.item_id)
                      const cf = getCf(selItem)
                      const inputUnit = cf > 1 ? selItem.purchase_unit : (selItem?.uom || '')
                      const lineBase = (parseFloat(line.qty) || 0) * (parseFloat(line.rate) || 0)
                      const lineAmount = line.vat_inclusive ? lineBase * 1.13 : lineBase
                      const cellInput = { background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', textAlign: 'right' }
                      return (
                        <>
                          <tr key={line._key}>
                            <td style={{ padding: '6px 8px 4px 0', verticalAlign: 'middle' }}>
                              <SearchableSelect
                                value={line.item_id}
                                onChange={v => updateBillLine(line._key, 'item_id', v)}
                                options={itemOptions}
                                placeholder="— Select item —"
                              />
                            </td>
                            <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle' }}>
                              <input type="number" min="0" step="any" value={line.qty} placeholder="0"
                                onChange={e => updateBillLine(line._key, 'qty', e.target.value)}
                                style={cellInput} />
                              {inputUnit && <div style={{ fontSize: 10, color: 'var(--theme-text2)', textAlign: 'right', marginTop: 2 }}>{inputUnit}</div>}
                              {cf > 1 && line.qty && <div style={{ fontSize: 10, color: 'var(--theme-text3)', textAlign: 'right' }}>= {(parseFloat(line.qty) * cf).toLocaleString()} {selItem?.uom}</div>}
                            </td>
                            <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle' }}>
                              <input type="number" min="0" step="any" value={line.rate} placeholder="0"
                                onChange={e => updateBillLine(line._key, 'rate', e.target.value)}
                                style={cellInput} />
                            </td>
                            <td style={{ padding: '6px 4px 4px', verticalAlign: 'middle', textAlign: 'center' }}>
                              <input
                                type="checkbox"
                                checked={line.vat_inclusive}
                                onChange={() => updateBillLine(line._key, 'vat_inclusive', !line.vat_inclusive)}
                                style={{ cursor: 'pointer', width: 15, height: 15, accentColor: '#f59e0b' }}
                              />
                              {line.vat_inclusive && <div style={{ fontSize: 9, color: '#f59e0b', marginTop: 2, fontWeight: 700 }}>13%</div>}
                            </td>
                            <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle' }}>
                              <input
                                type="number" min="0" step="any"
                                value={line._amtDraft}
                                placeholder={lineAmount > 0 ? lineAmount.toFixed(2) : ''}
                                onChange={e => setLineTotal(line._key, e.target.value)}
                                style={cellInput}
                              />
                            </td>
                            <td style={{ padding: '6px 8px 4px', verticalAlign: 'middle', textAlign: 'right' }}>
                              {lineAmount > 0 && (
                                <>
                                  <div style={{ fontSize: 13, color: 'var(--theme-accent)', fontWeight: 600, paddingTop: 7 }}>
                                    {lineAmount.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </div>
                                  {line.vat_inclusive && parseFloat(line.rate) > 0 && (
                                    <div style={{ fontSize: 10, color: 'var(--theme-amber)', marginTop: 2 }}>
                                      +VAT {(parseFloat(line.rate) * 0.13 * (parseFloat(line.qty) || 1)).toFixed(2)}
                                    </div>
                                  )}
                                </>
                              )}
                            </td>
                            <td style={{ padding: '6px 0 4px', verticalAlign: 'middle', textAlign: 'right' }}>
                              <button onClick={() => removeBillLine(line._key)}
                                style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', cursor: 'pointer', fontSize: 18, padding: '4px', lineHeight: 1 }}>×</button>
                            </td>
                          </tr>
                          <tr key={`${line._key}-sub`} style={{ borderBottom: '1px solid var(--theme-card)' }}>
                            <td colSpan={7} style={{ padding: '0 8px 8px 0' }}>
                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <input type="date" value={line.expiry_date}
                                  onChange={e => updateBillLine(line._key, 'expiry_date', e.target.value)}
                                  style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text2)', outline: 'none', width: 170 }} />
                                <input type="number" min="0" value={line.shelf_life} placeholder="Shelf life (days)"
                                  onChange={e => updateBillLine(line._key, 'shelf_life', e.target.value)}
                                  title="Enter days to auto-fill expiry date"
                                  style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: 'var(--theme-text2)', outline: 'none', width: 160, textAlign: 'right' }} />
                              </div>
                            </td>
                          </tr>
                        </>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-end', marginTop: 14, gap: 16 }}>
                {(() => {
                  const taxableBase    = billLines.reduce((s, l) => l.vat_inclusive ? s + (parseFloat(l.qty)||0) * (parseFloat(l.rate)||0) : s, 0)
                  const nonTaxableBase = billLines.reduce((s, l) => !l.vat_inclusive ? s + (parseFloat(l.qty)||0) * (parseFloat(l.rate)||0) : s, 0)
                  const subTotal       = taxableBase + nonTaxableBase
                  const discount       = parseFloat(billHeader.discount) || 0
                  // Discount spread proportionally; VAT levied only on taxable portion after discount
                  const vatTaxable     = subTotal > 0 ? taxableBase * (1 - discount / subTotal) : 0
                  const vatTotal       = vatTaxable * 0.13
                  const grandTotal     = subTotal - discount + vatTotal
                  if (subTotal === 0) return null
                  const fmt = n => n.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  return (
                    <div style={{ textAlign: 'right', fontSize: 13, minWidth: 300 }}>
                      {taxableBase > 0 && (
                        <div style={{ color: 'var(--theme-text3)', marginBottom: 3 }}>
                          Taxable (ex-VAT): <span style={{ color: 'var(--theme-text1)', fontWeight: 600, marginLeft: 8 }}>NPR {fmt(taxableBase)}</span>
                        </div>
                      )}
                      {nonTaxableBase > 0 && (
                        <div style={{ color: 'var(--theme-text3)', marginBottom: 3 }}>
                          Non-taxable: <span style={{ color: 'var(--theme-text1)', fontWeight: 600, marginLeft: 8 }}>NPR {fmt(nonTaxableBase)}</span>
                        </div>
                      )}
                      {discount > 0 && (
                        <div style={{ color: 'var(--theme-text3)', marginBottom: 3 }}>
                          Discount: <span style={{ color: 'var(--theme-red)', fontWeight: 600, marginLeft: 8 }}>− NPR {fmt(discount)}</span>
                        </div>
                      )}
                      {vatTotal > 0 && (
                        <div style={{ color: 'var(--theme-text3)', marginBottom: 3 }}>
                          VAT (13%): <span style={{ color: 'var(--theme-amber)', fontWeight: 600, marginLeft: 8 }}>NPR {fmt(vatTotal)}</span>
                        </div>
                      )}
                      <div style={{ color: 'var(--theme-accent)', fontWeight: 700, fontSize: 14, borderTop: '1px solid var(--theme-border)', paddingTop: 6 }}>
                        Grand Total: NPR {fmt(grandTotal)}
                      </div>
                    </div>
                  )
                })()}
              </div>

              {error && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '12px 0 0' }}>{error}</p>}
              <div className="form-actions" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center' }}>
                <button className="btn btn-ghost" onClick={() => { setShowForm(false); setEditingGroupId(null) }}
                  style={{ justifySelf: 'start', fontSize: 13, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.07)' }}>Cancel</button>
                <button className="btn" onClick={addBillLine}
                  style={{ fontSize: 13, background: 'var(--theme-amber)', color: '#000', borderColor: 'var(--theme-amber)' }}>
                  + Add Item
                </button>
                <button className="btn btn-primary" onClick={saveBill} disabled={saving} style={{ justifySelf: 'end', fontSize: 13 }}>
                  {saving ? 'Saving…' : editingGroupId ? 'Update Bill' : `Save ${billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0).length || ''} Entr${billLines.filter(l => l.item_id && parseFloat(l.qty) > 0 && parseFloat(l.rate) > 0).length === 1 ? 'y' : 'ies'}`}
                </button>
              </div>
            </Modal>
          )}

          {/* Filters */}
          <div style={{ marginBottom: 16 }}>
            {/* Day pill strip */}
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4, marginBottom: 10 }}>
              <button
                className={`tab-btn${filterDay === 'all' ? ' tab-btn--active' : ''}`}
                onClick={() => setFilterDay('all')}
              >
                All Days
              </button>
              {uniqueDays.map(d => (
                <button
                  key={d}
                  className={`tab-btn${filterDay === String(d) ? ' tab-btn--active' : ''}`}
                  onClick={() => setFilterDay(String(d))}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  Day {d}
                  {billCountPerDay[d] > 0 && (
                    <span style={{ marginLeft: 5, fontSize: 10, opacity: 0.65 }}>
                      · {billCountPerDay[d]} {billCountPerDay[d] === 1 ? 'bill' : 'bills'}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {/* Item filter + count */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="form-select" value={filterItem} onChange={e => setFilterItem(e.target.value)}>
                <option value="all">All Items</option>
                {items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
              {(filterDay !== 'all' || filterItem !== 'all') && (
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => { setFilterDay('all'); setFilterItem('all') }}>Clear Filters</button>
              )}
              <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{filtered.length} entr{filtered.length !== 1 ? 'ies' : 'y'}</span>
            </div>
          </div>

          {/* Purchases table */}
          <div className="card">
            {loading ? (
              <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
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
                        const groupTotal    = groupEntries.reduce((s, e) => s + e.qty * e.rate, 0)
                        const vatSubtotalG  = groupEntries.filter(e => e.vat_inclusive).reduce((s, e) => s + e.qty * e.rate, 0)
                        const discountAmt   = parseFloat(first.discount_amount) || 0
                        const vatTaxableG   = groupTotal > 0 ? vatSubtotalG * (1 - discountAmt / groupTotal) : 0
                        const vatAmount     = vatTaxableG * 0.13
                        const groupGrand    = (groupTotal - discountAmt) + vatAmount
                        return [
                          // Group header row
                          <tr key={`gh-${gid}`} style={{ background: 'rgba(201,168,76,0.04)', borderTop: gIdx > 0 ? '2px solid var(--theme-card)' : undefined }}>
                            <td style={{ fontWeight: 700, color: 'var(--theme-accent)', fontSize: 14, borderRight: '1px solid var(--theme-border)', verticalAlign: 'middle', paddingTop: 10, paddingBottom: 10 }}>
                              {gIdx === 0 ? (
                                <>
                                  {day}
                                  {selectedPeriod && (
                                    <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--theme-text3)', marginTop: 2 }}>
                                      {formatAd(bsToAd(selectedPeriod.bs_year, selectedPeriod.bs_month, parseInt(day)))}
                                    </div>
                                  )}
                                </>
                              ) : null}
                            </td>
                            <td colSpan={3} style={{ verticalAlign: 'middle' }}>
                              <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{first.vendors?.name || <span style={{ color: 'var(--theme-text2)' }}>No Vendor</span>}</span>
                              {first.invoice_ref && <span style={{ color: 'var(--theme-text2)', fontSize: 12, marginLeft: 10 }}>#{first.invoice_ref}</span>}
                              <span style={{ color: 'var(--theme-text3)', fontSize: 11, marginLeft: 10 }}>{groupEntries.length} item{groupEntries.length !== 1 ? 's' : ''}</span>
                            </td>
                            <td colSpan={3}></td>
                            <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', fontSize: 13, verticalAlign: 'middle' }}>
                              {groupGrand.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              {vatAmount > 0 && <div style={{ fontSize: 10, color: 'var(--theme-amber)', fontWeight: 400 }}>+VAT: {vatAmount.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
                              {discountAmt > 0 && <div style={{ fontSize: 10, color: 'var(--theme-red)', fontWeight: 400 }}>−Disc: {discountAmt.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
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
                            <tr key={entry.id} style={{ background: 'rgba(0,0,0,0.12)', borderBottom: '1px solid var(--theme-card)' }}>
                              <td></td>
                              <td style={{ fontWeight: 500, color: '#b8b0a0', paddingLeft: 20, fontSize: 13 }}>{entry.items?.name}</td>
                              <td>{entry.items?.categories?.name ? <span className="badge badge-yellow">{entry.items.categories.name}</span> : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
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
                                      {cf > 1 && <div style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{Number(entry.qty).toLocaleString()} {entry.items?.uom}</div>}
                                    </td>
                                    <td style={{ color: 'var(--theme-text2)' }}>{displayUnit}</td>
                                    <td style={{ textAlign: 'right' }}>
                                      {Number(displayRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                      {cf > 1 && <div style={{ fontSize: 10, color: 'var(--theme-text2)' }}>NPR {Number(entry.rate).toFixed(4)}/{entry.items?.uom}</div>}
                                    </td>
                                  </>
                                )
                              })()}
                              <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>
                                {(entry.qty * entry.rate).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                                {entry.expiry_date ? <span style={{ color: 'var(--theme-accent)', fontSize: 11 }}>{entry.expiry_date}</span> : '—'}
                              </td>
                              <td></td>
                            </tr>
                          ))
                        ]
                      })
                    })}
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td colSpan={7} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', fontSize: 15, paddingTop: 12 }}>
                        NPR {filteredValue.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <Fab onClick={openNew} label="+ Add Purchase" show={!isLocked && !showForm && !!selectedPeriod} />
        </>
      )}

      {/* ── RETURNS TAB ── */}
      {activeTab === 'returns' && (
        <>
          {purchases.length === 0 && (
            <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent)' }}>
              No purchases exist for this period yet. Add purchases first before recording returns.
            </div>
          )}

          {/* Return Add/Edit Form */}
          {showReturnForm && (
            <Modal onClose={() => { setShowReturnForm(false); setEditingReturnId(null) }} title={editingReturnId ? 'Edit Return' : 'Record Return to Vendor'}>
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
                          <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 4 }}>
                            Original: {cf > 1
                              ? `${(linked.qty / cf).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${linked.items.purchase_unit} (${Number(linked.qty).toLocaleString()} ${linked.items?.uom})`
                              : `${Number(linked.qty).toLocaleString()} ${linked.items?.uom}`}
                          </div>
                        )}
                        {cf > 1 && returnForm.qty && (
                          <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 2 }}>
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
                  <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.15)', borderRadius: 6, fontSize: 13, color: 'var(--theme-text2)', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                    <span>Rate: <strong style={{ color: 'var(--theme-text1)' }}>NPR {Number(displayRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}/{displayRateUnit}</strong></span>
                    <span>Vendor: <strong style={{ color: 'var(--theme-text1)' }}>{linked.vendors?.name || '—'}</strong></span>
                    <span>Payment: <strong style={{ color: 'var(--theme-text1)' }}>{linked.payment_method || 'Cash'}</strong></span>
                    {retValue > 0 && <span>Return Value: <strong style={{ color: 'var(--theme-red)' }}>−NPR {retValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</strong></span>}
                    <span style={{ color: 'var(--theme-text3)', fontSize: 11 }}>Rate, vendor & payment inherited from original purchase</span>
                  </div>
                )
              })()}

              {returnError && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '10px 0 0' }}>{returnError}</p>}
              <div className="form-actions">
                <button className="btn btn-ghost" onClick={() => { setShowReturnForm(false); setEditingReturnId(null) }}>Cancel</button>
                <button className="btn btn-primary" style={{ background: '#7f1d1d', borderColor: 'var(--theme-red)' }} onClick={saveReturn} disabled={returnSaving}>
                  {returnSaving ? 'Saving…' : editingReturnId ? 'Update Return' : 'Record Return'}
                </button>
              </div>
            </Modal>
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
                        <td style={{ fontWeight: 700, color: 'var(--theme-accent)' }}>{ret.bs_day || '—'}</td>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{ret.items?.name}</td>
                        <td style={{ color: 'var(--theme-text2)' }}>{ret.vendors?.name || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                        {(() => {
                          const cf = getCf(ret.items)
                          const displayQty  = cf > 1 ? ret.qty / cf : ret.qty
                          const displayUnit = cf > 1 ? ret.items.purchase_unit : ret.items?.uom
                          const displayRate = cf > 1 ? ret.rate * cf : ret.rate
                          return (
                            <>
                              <td style={{ textAlign: 'right', color: 'var(--theme-red)', fontWeight: 600 }}>
                                −{Number(displayQty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                                {cf > 1 && <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{Number(ret.qty).toLocaleString()} {ret.items?.uom}</div>}
                              </td>
                              <td style={{ color: 'var(--theme-text2)' }}>{displayUnit}</td>
                              <td style={{ textAlign: 'right' }}>{Number(displayRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                            </>
                          )
                        })()}
                        <td style={{ textAlign: 'right', color: 'var(--theme-red)', fontWeight: 700 }}>
                          −NPR {(ret.qty * ret.rate).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td>
                          <span className={`badge ${ret.payment_method === 'Cash' ? 'badge-green' : ret.payment_method === 'Credit' ? 'badge-red' : 'badge-yellow'}`}>
                            {ret.payment_method || 'Cash'}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{ret.notes || '—'}</td>
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
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td colSpan={6} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total Returns</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)', fontSize: 15, paddingTop: 12 }}>
                        −NPR {returnTotal.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td colSpan={3}></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <Fab onClick={openNewReturn} label="+ Add Return" show={!isLocked && !showReturnForm && purchases.length > 0} />
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

        const thStyle = { fontSize: 11, color: 'var(--theme-text2)', padding: '6px 8px', textTransform: 'uppercase', letterSpacing: '0.05em', background: 'var(--theme-bg)00', borderBottom: '2px solid var(--theme-border)', whiteSpace: 'nowrap', textAlign: 'right' }
        const tdStyle = { padding: '5px 8px', fontSize: 12, borderBottom: '1px solid var(--theme-card)', textAlign: 'right', whiteSpace: 'nowrap' }

        return (
          <div className="card" style={{ padding: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px 10px' }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--theme-text1)' }}>Daily Purchase Register</span>
                <span style={{ fontSize: 12, color: 'var(--theme-text2)', marginLeft: 12 }}>{BS_MONTHS[selectedPeriod.bs_month - 1]} {selectedPeriod.bs_year} · {purchases.length} entries</span>
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
                        <th key={d} style={{ ...thStyle, width: 52, color: d % 2 === 0 ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>{d}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCats.map(cat => (
                      <>
                        {/* Category header */}
                        <tr key={`cat-${cat}`} style={{ background: 'rgba(201,168,76,0.06)' }}>
                          <td colSpan={3 + numDays} style={{ padding: '6px 10px', fontWeight: 700, fontSize: 11, color: 'var(--theme-accent)', letterSpacing: '0.08em', textTransform: 'uppercase', borderBottom: '1px solid var(--theme-border)' }}>
                            {cat}
                          </td>
                        </tr>
                        {byCategory[cat].map((item, idx) => {
                          return (
                            <tr key={item.id} style={{ background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}>
                              <td style={{ ...tdStyle, textAlign: 'center', color: 'var(--theme-text3)' }}>{idx + 1}</td>
                              <td style={{ ...tdStyle, textAlign: 'left', color: 'var(--theme-text1)', fontWeight: 500 }}>{item.name}</td>
                              <td style={{ ...tdStyle, color: 'var(--theme-text2)' }}>{item.uom}</td>
                              {days.map(d => {
                                const qty = dayMatrix[item.id]?.[d]
                                return (
                                  <td key={d} style={{ ...tdStyle, color: qty ? 'var(--theme-text1)' : 'var(--theme-border)', background: qty ? 'rgba(201,168,76,0.06)' : undefined, fontWeight: qty ? 600 : 400 }}>
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
