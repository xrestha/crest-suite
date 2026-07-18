import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { bsToAd, formatAd, daysInBsMonth } from '../../../utils/bsCalendar'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import * as XLSX from 'xlsx'
import { getCf } from './purchasesHelpers'
import PurchaseBillModal from './PurchaseBillModal'
import PurchaseBillPrint from './PurchaseBillPrint'
import ReturnsTab from './ReturnsTab'
import { printWithTitle } from '../../../utils/printTitle'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function Purchases() {
  const { clientId, profile, loading: authLoading, isAdmin } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedDelete } = useScopedDb()

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
  const [filterDay, setFilterDay]           = useState('all')
  const [filterItem, setFilterItem]         = useState('all')
  const [editingGroupId, setEditingGroupId] = useState(null)
  const [rateUpdateItems, setRateUpdateItems]       = useState([])
  const [rateUpdateSelected, setRateUpdateSelected] = useState(new Set())
  const [printBill, setPrintBill]           = useState(null)
  // Company letterhead for the auto-printed purchase voucher — same source fields the payslip
  // print uses (settings.vat_number is Nepal's PAN, reused as-is — not a new ID).
  const [bizInfo, setBizInfo]               = useState({ name: '', address: '', vatNumber: '' })

  // Returns tab
  const [returns, setReturns]               = useState([])

  // Daily Register tab
  const [collapsedRegisterCats, setCollapsedRegisterCats] = useState(new Set())

  // "Delete All" typed-confirmation (purchases/returns) — a whole-period wipe gets a heavier
  // confirmation than a routine single-bill delete, which still uses window.confirm.
  const [deleteAllTarget, setDeleteAllTarget] = useState(null) // 'purchases' | 'returns' | null
  const [deleteAllTyped, setDeleteAllTyped]   = useState('')

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!effectiveClientId) return
    Promise.all([
      supabase.from('clients').select('name').eq('id', effectiveClientId).single(),
      supabase.from('settings').select('property_address, vat_number').eq('client_id', effectiveClientId).maybeSingle(),
    ]).then(([{ data: client }, { data: settings }]) => {
      setBizInfo({ name: client?.name || '', address: settings?.property_address || '', vatNumber: settings?.vat_number || '' })
    })
  }, [effectiveClientId])

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: i }, { data: v }] = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('items', '*, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('name'),
      scopedFrom('vendors').eq('is_active', true).order('name')
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
    const { data } = await scopedFrom('vendor_returns', '*, items(name, uom, purchase_unit, conversion_factor), vendors(name), purchase_entries(bs_day, qty, rate)')
      .eq('period_id', periodId)
      .order('created_at')
    setReturns(data || [])
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
    setShowForm(true)
  }

  function openEditGroup(groupId) {
    setEditingGroupId(groupId)
    setShowForm(true)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Auto-print a new bill's voucher right after save (not on edits — see feedback captured
  // during S404+1 design discussion) so it can be stapled to the vendor's physical bill for
  // record-keeping/approval.
  function printPurchaseBill(header, validLines) {
    const vendor = vendors.find(v => v.id === header.vendor_id)
    setPrintBill({ header, lines: validLines, vendorName: vendor?.name || '' })
    setTimeout(() => {
      printWithTitle(`Purchase Voucher - ${vendor?.name || 'No Vendor'} - ${periodLabel} Day ${header.bs_day}`)
      setPrintBill(null)
    }, 60)
  }

  // Called by PurchaseBillModal after it successfully saves — reloads the list and checks
  // whether any entered rate differs from Item Master, offering to sync it (previously the tail
  // end of this component's own saveBill()).
  async function handleBillSaved(header, validLines) {
    const wasNew = !editingGroupId
    setShowForm(false)
    setEditingGroupId(null)
    loadPurchases(selectedPeriod.id)
    if (wasNew) printPurchaseBill(header, validLines)

    const changed = []
    for (const l of validLines) {
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
  // Return form/list logic lives in ReturnsTab.jsx; this component only owns the "delete all"
  // bulk action (triggered from the tab bar above the tab content, not from within the tab).

  async function performDeleteAllPurchases() {
    if (!selectedPeriod || purchases.length === 0) return
    await supabase.from('purchase_entries').delete().eq('period_id', selectedPeriod.id)
    await Promise.all([loadPurchases(selectedPeriod.id), loadReturns(selectedPeriod.id)])
  }

  async function performDeleteAllReturns() {
    if (!selectedPeriod || returns.length === 0) return
    await scopedDelete('vendor_returns').eq('period_id', selectedPeriod.id)
    loadReturns(selectedPeriod.id)
  }

  async function confirmDeleteAll() {
    if (deleteAllTarget === 'purchases') await performDeleteAllPurchases()
    else if (deleteAllTarget === 'returns') await performDeleteAllReturns()
    setDeleteAllTarget(null)
    setDeleteAllTyped('')
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
    <>
    <div className={printBill ? 'no-print' : ''}>

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

      {/* Delete All confirmation — a whole-period wipe needs more friction than a routine
          single-bill delete, so it requires typing the period label rather than one confirm(). */}
      {deleteAllTarget && (() => {
        const count = deleteAllTarget === 'purchases' ? purchases.length : returns.length
        const noun = deleteAllTarget === 'purchases' ? 'purchase' : 'return'
        const matches = deleteAllTyped.trim().toLowerCase() === periodLabel.trim().toLowerCase()
        return (
          <Modal title={`⚠ Delete all ${noun} entries?`} maxWidth={440} onClose={() => { setDeleteAllTarget(null); setDeleteAllTyped('') }}>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', marginTop: 0 }}>
              This permanently deletes <strong style={{ color: 'var(--theme-red)' }}>all {count} {noun} entr{count !== 1 ? 'ies' : 'y'}</strong> for <strong>{periodLabel}</strong>. This cannot be undone.
            </p>
            <p style={{ fontSize: 12, color: 'var(--theme-text3)', marginBottom: 6 }}>
              Type <strong style={{ color: 'var(--theme-text1)' }}>{periodLabel}</strong> to confirm.
            </p>
            <input
              autoFocus
              className="form-select"
              style={{ width: '100%', marginBottom: 16 }}
              value={deleteAllTyped}
              onChange={e => setDeleteAllTyped(e.target.value)}
              placeholder={periodLabel}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-danger" disabled={!matches} onClick={confirmDeleteAll} style={{ fontSize: 12, padding: '7px 16px' }}>
                Delete All {count} Entries
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '7px 16px' }}
                onClick={() => { setDeleteAllTarget(null); setDeleteAllTyped('') }}>
                Cancel
              </button>
            </div>
          </Modal>
        )
      })()}

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
              // Switching tabs unmounts ReturnsTab, which resets its own form state naturally.
              setActiveTab(tab.id); setShowForm(false)
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
            onClick={() => setDeleteAllTarget(activeTab === 'purchases' ? 'purchases' : 'returns')}
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
            <PurchaseBillModal
              period={selectedPeriod}
              items={items}
              itemOptions={itemOptions}
              vendors={vendors}
              editingGroupId={editingGroupId}
              editingEntries={editingGroupId ? purchases.filter(p => (p.purchase_group_id || p.id) === editingGroupId) : null}
              onClose={() => { setShowForm(false); setEditingGroupId(null) }}
              onSaved={handleBillSaved}
            />
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
                  D{d}
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
                                  <button className="btn btn-ghost" style={{ fontSize: 11, padding: '7px 11px' }} onClick={() => openEditGroup(gid)}>Edit</button>
                                  <button className="btn btn-danger" style={{ fontSize: 11, padding: '7px 11px' }} onClick={() => deleteGroup(gid)}>Del</button>
                                </>}
                              </div>
                            </td>
                          </tr>,
                          // Item sub-rows
                          ...groupEntries.map(entry => (
                            <tr key={entry.id} style={{ background: 'rgba(0,0,0,0.12)', borderBottom: '1px solid var(--theme-card)' }}>
                              <td></td>
                              <td style={{ fontWeight: 500, color: 'var(--theme-text2)', paddingLeft: 20, fontSize: 13 }}>{entry.items?.name}</td>
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
        <ReturnsTab
          period={selectedPeriod}
          purchases={purchases}
          returns={returns}
          isLocked={isLocked}
          effectiveClientId={effectiveClientId}
          onChanged={() => loadReturns(selectedPeriod.id)}
        />
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
              let total = 0
              days.forEach(d => {
                const qty = dayMatrix[item.id]?.[d]
                if (qty) total += qty
                row[String(d)] = qty ? parseFloat(qty.toFixed(3)) : ''
              })
              row['Total'] = parseFloat(total.toFixed(3))
              rows.push(row)
            })
          })
          const ws = XLSX.utils.json_to_sheet(rows)
          XLSX.utils.book_append_sheet(wb, ws, 'Daily Register')
          XLSX.writeFile(wb, `Purchase-Register-${BS_MONTHS[selectedPeriod.bs_month - 1]}-${selectedPeriod.bs_year}.xlsx`)
        }

        const thStyle = { fontSize: 11, color: 'var(--theme-text2)', padding: '6px 8px', textTransform: 'uppercase', letterSpacing: '0.05em', background: 'var(--theme-card)', borderBottom: '2px solid var(--theme-border)', whiteSpace: 'nowrap', textAlign: 'right', position: 'sticky', top: 0, zIndex: 2 }
        const tdStyle = { padding: '5px 8px', fontSize: 12, borderBottom: '1px solid var(--theme-card)', textAlign: 'right', whiteSpace: 'nowrap' }

        function toggleRegisterCat(cat) {
          setCollapsedRegisterCats(prev => {
            const next = new Set(prev)
            if (next.has(cat)) next.delete(cat); else next.add(cat)
            return next
          })
        }

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
                <div className="empty-state-icon">▤</div>
                <p className="empty-state-text">No purchases recorded this period.</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, textAlign: 'center', width: 36 }}>S.No</th>
                      <th style={{ ...thStyle, textAlign: 'left', minWidth: 160 }}>Item Name</th>
                      <th style={{ ...thStyle, width: 48 }}>UOM</th>
                      {days.map(d => (
                        <th key={d} style={{ ...thStyle, width: 52, color: d % 2 === 0 ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>{d}</th>
                      ))}
                      <th style={{ ...thStyle, width: 68, color: 'var(--theme-accent)', borderLeft: '1px solid var(--theme-border)', position: 'sticky', right: 0, zIndex: 3 }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCats.map(cat => {
                      const collapsed = collapsedRegisterCats.has(cat)
                      return (
                      <>
                        {/* Category header — click to collapse/expand, so a long item list can be
                            narrowed down without scrolling past categories you don't need right now */}
                        <tr key={`cat-${cat}`} style={{ background: 'rgba(201,168,76,0.06)', cursor: 'pointer' }} onClick={() => toggleRegisterCat(cat)}>
                          <td colSpan={3 + numDays + 1} style={{ padding: '6px 10px', fontWeight: 700, fontSize: 11, color: 'var(--theme-accent)', letterSpacing: '0.08em', textTransform: 'uppercase', borderBottom: '1px solid var(--theme-border)' }}>
                            <span style={{ display: 'inline-block', width: 14 }}>{collapsed ? '▸' : '▾'}</span>{cat}
                            <span style={{ fontWeight: 400, color: 'var(--theme-text3)', textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>({byCategory[cat].length})</span>
                          </td>
                        </tr>
                        {!collapsed && byCategory[cat].map((item, idx) => {
                          const total = Object.values(dayMatrix[item.id] || {}).reduce((s, q) => s + q, 0)
                          // The sticky Total cell needs a fully opaque background (unlike the row's own
                          // translucent stripe tint) so horizontally-scrolled-away cells don't show through
                          // underneath it — layering the tint over the opaque card color bakes them into one paint.
                          const rowBg = idx % 2 === 0 ? 'var(--theme-card)' : 'linear-gradient(rgba(255,255,255,0.03), rgba(255,255,255,0.03)), var(--theme-card)'
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
                              <td style={{ ...tdStyle, color: 'var(--theme-accent)', fontWeight: 700, borderLeft: '1px solid var(--theme-border)', position: 'sticky', right: 0, background: rowBg }}>
                                {total.toLocaleString('en-NP', { maximumFractionDigits: 2 })}
                              </td>
                            </tr>
                          )
                        })}
                      </>
                    )})}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })()}

    </div>

      {/* Print-only purchase voucher — see printPurchaseBill(); mounted only for the brief
          setTimeout window it takes to fire the browser print dialog, then unmounted. */}
      {printBill && (
        <div className="print-only">
          <PurchaseBillPrint
            header={printBill.header}
            lines={printBill.lines}
            items={items}
            vendorName={printBill.vendorName}
            period={selectedPeriod}
            bizInfo={bizInfo}
            enteredBy={profile?.full_name || profile?.email || ''}
          />
        </div>
      )}
    </>
  )
}
