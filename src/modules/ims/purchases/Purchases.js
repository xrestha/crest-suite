import { useEffect, useState, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import { BS_MONTHS, bsToAd, formatAd, daysInBsMonth, formatBsDay } from '../../../utils/bsCalendar'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'
import { getCf, calcBillTotals, fmtRate } from './purchasesHelpers'
import PurchaseBillModal from './PurchaseBillModal'
import PurchaseBillPrint from './PurchaseBillPrint'
import ReturnsTab from './ReturnsTab'
import { printWithTitle } from '../../../utils/printTitle'
import { readPageCache, writePageCache } from '../../../shared/sessionDataCache'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'

export default function Purchases() {
  const { clientId, profile, loading: authLoading, isAdmin, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedDelete } = useScopedDb()

  // Shared — seeded from a short-lived per-tab cache (sessionDataCache.js) so revisiting this
  // page shows the last-known data instantly instead of a blank "Loading…" while it re-fetches.
  // setAndCache below (defined after effectiveClientId) writes to the same cache alongside every
  // existing setter, at the same call sites, with no change to any value being computed.
  const [cachedPeriods] = useState(() => readPageCache('purchases', 'periods', effectiveClientId))
  const cachedOpenPeriod = (cachedPeriods || []).find(x => x.status === 'open') || null
  const [periods, setPeriods]               = useState(cachedPeriods ?? [])
  const periodReq = useLatestRequest()
  const [selectedPeriod, setSelectedPeriod] = useState(cachedOpenPeriod)
  const [items, setItems]                   = useState(() => readPageCache('purchases', 'items', effectiveClientId) ?? [])
  const [vendors, setVendors]               = useState(() => readPageCache('purchases', 'vendors', effectiveClientId) ?? [])
  const [loading, setLoading]               = useState(!cachedPeriods)
  const [activeTab, setActiveTab]           = useState('purchases')

  // Wraps a normal setState call to also persist the same value to the shared session cache —
  // see the equivalent helper + comment in ClientDashboard.jsx for the tenant-isolation reasoning
  // (safe because this is only ever called after a load already resolved for the current client).
  function setAndCache(setter, section, value) {
    setter(value)
    writePageCache('purchases', section, effectiveClientId, value)
  }

  // Purchases tab
  const [purchases, setPurchases]           = useState(() =>
    (cachedOpenPeriod ? readPageCache('purchases', `purchases_${cachedOpenPeriod.id}`, effectiveClientId) : null) ?? [])
  const [showForm, setShowForm]             = useState(false)
  const [filterDay, setFilterDay]           = useState('all')
  const [filterItem, setFilterItem]         = useState('all')
  const [filterVendor, setFilterVendor]     = useState('all')
  const [editingGroupId, setEditingGroupId] = useState(null)
  const [rateUpdateItems, setRateUpdateItems]       = useState([])
  const [rateUpdateSelected, setRateUpdateSelected] = useState(new Set())
  const [printBill, setPrintBill]           = useState(null)
  // Company letterhead for the auto-printed purchase voucher — same source fields the payslip
  // print uses (settings.vat_number is Nepal's PAN, reused as-is — not a new ID).
  const [bizInfo, setBizInfo]               = useState({ name: '', address: '', vatNumber: '' })

  // Returns tab
  const [returns, setReturns]               = useState(() =>
    (cachedOpenPeriod ? readPageCache('purchases', `returns_${cachedOpenPeriod.id}`, effectiveClientId) : null) ?? [])

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
    // Only show "Loading…" when there's nothing cached to display yet — a revisit within the
    // cache window keeps showing last-known data while this reloads quietly underneath.
    if (periods.length === 0) setLoading(true)
    const [{ data: p }, { data: i }, { data: v }] = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('items', '*, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('name'),
      scopedFrom('vendors').eq('is_active', true).order('name')
    ])
    setAndCache(setPeriods, 'periods', p || [])
    setAndCache(setItems, 'items', i || [])
    setAndCache(setVendors, 'vendors', v || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) {
      setSelectedPeriod(open)
      await Promise.all([loadPurchases(open.id), loadReturns(open.id)])
    }
    setLoading(false)
  }

  async function loadPurchases(periodId) {
    // Paged — the purchases table itself, one row per bill line for the period (S529).
    const { data } = await fetchAllRows(() => supabase
      .from('purchase_entries')
      .select('*, items(name, uom, purchase_unit, conversion_factor, categories(name)), vendors(name)')
      .eq('period_id', periodId)
      .order('bs_day')
      .order('created_at')
      .order('id'))
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    setAndCache(setPurchases, `purchases_${periodId}`, data || [])
  }

  async function loadReturns(periodId) {
    const { data } = await scopedFrom('vendor_returns', '*, items(name, uom, purchase_unit, conversion_factor), vendors(name), purchase_entries(bs_day, qty, rate)')
      .eq('period_id', periodId)
      .order('created_at')
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    setAndCache(setReturns, `returns_${periodId}`, data || [])
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setFilterDay('all')
    setFilterItem('all')
    setFilterVendor('all')
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
      printWithTitle(`Purchase Voucher - ${vendor?.name || 'No Vendor'} - ${formatBsDay(header.bs_day, selectedPeriod?.bs_month) || periodLabel} ${selectedPeriod?.bs_year || ''}`.trim())
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

    // Compare both sides in the SAME unit the bill's rate box uses — per base unit, or per purchase
    // unit where the item has a conversion. Comparing against items.rate only worked while that
    // column happened to hold a per-unit figure; it is now always per BASE unit (items are stored in
    // their smallest unit), which a conversion item's rate box is not. An exact !== on floats also
    // re-fired this prompt on rates that had not moved.
    // One .in() read for every line's item, not one .single() per line — a 20-line bill was
    // paying 20 serial round trips here, after the save had already visibly completed.
    const { data: freshItems } = await supabase.from('items')
      .select('id, name, uom, per_uom_rate, purchase_unit, conversion_factor')
      .in('id', [...new Set(validLines.map(l => l.item_id))])
    const freshById = new Map((freshItems || []).map(i => [i.id, i]))
    const changed = []
    for (const l of validLines) {
      const capturedRate = parseFloat(l.rate)
      const fi = freshById.get(l.item_id)
      if (!fi) continue
      const cf = getCf(fi)
      const masterRate = (parseFloat(fi.per_uom_rate) || 0) * cf
      if (Math.abs(capturedRate - masterRate) > 0.000001) {
        changed.push({
          itemId: fi.id, itemName: fi.name, cf,
          unit: cf > 1 ? (fi.purchase_unit || fi.uom) : fi.uom,
          baseUom: fi.uom,
          oldRate: masterRate, newRate: capturedRate,
        })
      }
    }
    if (changed.length > 0) {
      setRateUpdateItems(changed)
      setRateUpdateSelected(new Set(changed.map(i => i.itemId)))
    }
  }

  // items.rate is the price of ONE base unit (purchase_qty is always 1), so a rate typed against a
  // purchase unit has to come back down by the conversion factor before it lands. Writing the
  // entered figure raw put a per-CTN price in the column every valuation reads as per-BTL.
  const toPerBase = r => parseFloat((r.newRate / (r.cf || 1)).toFixed(6))

  async function applyRateUpdates() {
    const toUpdate = rateUpdateItems.filter(i => rateUpdateSelected.has(i.itemId))
    await Promise.all(toUpdate.map(i => supabase.from('items').update({ rate: toPerBase(i) }).eq('id', i.itemId)))
    setItems(prev => {
      const next = prev.map(i => {
        const upd = toUpdate.find(r => r.itemId === i.id)
        return upd ? { ...i, rate: toPerBase(upd), per_uom_rate: toPerBase(upd) } : i
      })
      writePageCache('purchases', 'items', effectiveClientId, next)
      return next
    })
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
      // Legacy pre-purchase_group_id bills: one .in() delete, not one round trip per entry.
      await supabase.from('purchase_entries').delete().in('id', groupEntries.map(e => e.id))
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
  const itemFilterOptions = useMemo(
    () => [{ value: 'all', label: 'All Items' }, ...itemOptions],
    [itemOptions]
  )
  const vendorFilterOptions = useMemo(
    () => [{ value: 'all', label: 'All Vendors' }, ...vendors.map(v => ({ value: v.id, label: v.name }))],
    [vendors]
  )

  const filtered = purchases.filter(p => {
    const matchDay    = filterDay    === 'all' || p.bs_day === parseInt(filterDay)
    const matchItem   = filterItem   === 'all' || p.item_id === filterItem
    const matchVendor = filterVendor === 'all' || p.vendor_id === filterVendor
    return matchDay && matchItem && matchVendor
  })

  const vendorTotal = filterVendor === 'all' ? 0 : purchases
    .filter(p => p.vendor_id === filterVendor)
    .reduce((s, p) => s + p.qty * p.rate, 0)

  const grossTotal  = purchases.reduce((s, p) => s + p.qty * p.rate, 0)
  const returnTotal = returns.reduce((s, r) => s + r.qty * r.rate, 0)
  const netTotal    = grossTotal - returnTotal
  const filteredValue = filtered.reduce((s, p) => s + p.qty * p.rate, 0)
  // Only meaningful when one specific item is filtered — summing raw qty across
  // different items (potentially different UOMs) would be a nonsense figure.
  const filteredQty = filterItem !== 'all'
    ? filtered.reduce((s, p) => { const cf = getCf(p.items); return s + (cf > 1 ? p.qty / cf : p.qty) }, 0)
    : null
  const filteredQtyUnit = filterItem !== 'all' && filtered[0]
    ? (getCf(filtered[0].items) > 1 ? filtered[0].items.purchase_unit : filtered[0].items?.uom)
    : ''
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

  // The Total column on each bill row shows what was actually PAYABLE (incl. VAT, after the
  // bill's discount) while the footer and the Gross Purchases KPI are the ex-VAT, pre-discount
  // base. Both are legitimate figures, neither was labelled, and they differ by exactly
  // (VAT − discount) — so the column visibly did not add up to the total printed beneath it.
  // Footer now carries both, each named. Grouped the same way the table groups.
  const filteredPayable = Object.values(byDay).reduce((sum, dayGroups) =>
    sum + Object.values(dayGroups).reduce((s, lines) =>
      s + calcBillTotals(lines, lines[0]?.discount_amount).grandTotal, 0), 0)

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const isLocked = !isAdmin && selectedPeriod?.status === 'closed'

  // Floor tier, matching every other IMS page's guard (S417 convention). This page had none, so
  // the route was reachable by any account at an ims_enabled client regardless of ims_role.
  if (!hasImsAccess('staff')) return <Navigate to="/dashboard" replace />
  if (!loading && periods.length === 0) return <NoPeriodState what="purchase entry" />

  return (
    <>
    <div className={printBill ? 'no-print' : ''}>

      {/* Rate update modal */}
      {rateUpdateItems.length > 0 && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--theme-card)', border: '1px solid rgba(201,168,76,0.3)', borderRadius: 'var(--radius-md)', padding: '24px 28px', maxWidth: 520, width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 4 }}>📦 Rate changes detected</div>
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
                <label key={item.itemId} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--theme-bg)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox"
                    checked={rateUpdateSelected.has(item.itemId)}
                    onChange={e => {
                      const next = new Set(rateUpdateSelected)
                      e.target.checked ? next.add(item.itemId) : next.delete(item.itemId)
                      setRateUpdateSelected(next)
                    }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.itemName}</div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>
                      Item Master will hold NPR {fmtRate(toPerBase(item))} per {item.baseUom}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 13 }}>
                    <span style={{ color: 'var(--theme-red-text)', fontWeight: 600 }}>NPR {fmtRate(item.oldRate)}</span>
                    <span style={{ color: 'var(--theme-text2)' }}> → </span>
                    <span style={{ color: 'var(--theme-green-text)', fontWeight: 600 }}>NPR {fmtRate(item.newRate)}</span>
                    <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 1 }}>per {item.unit}</div>
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
              This permanently deletes <strong style={{ color: 'var(--theme-red-text)' }}>all {count} {noun} entr{count !== 1 ? 'ies' : 'y'}</strong> for <strong>{periodLabel}</strong>. This cannot be undone.
            </p>
            <p style={{ fontSize: 12, color: 'var(--theme-text3)', marginBottom: 6 }}>
              Type <strong style={{ color: 'var(--theme-text1)' }}>{periodLabel}</strong> to confirm.
            </p>
            <input
              autoFocus
              className="form-input"
              aria-label={`Type ${periodLabel} to confirm deleting all entries`}
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
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red-text)' }}>
          🔒 <strong>This period is closed.</strong> Data is read-only. Contact your admin to re-open if needed.
        </div>
      )}

      {/* Print-only header */}
      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 10mm; }
        }
      `}</style>
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Purchases — {periodLabel}</h2>
      </div>

      {/* Header */}
      <div className="page-header no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Purchases</h1>
          <p className="page-subtitle">Daily ingredient purchases & returns — {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}</option>
            ))}
          </select>
          <button className="btn btn-ghost" onClick={() => printWithTitle(`Purchases - ${periodLabel}`)}>Print</button>
        </div>
      </div>

      {/* Stats */}
      <div className="stat-grid no-print" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Total Entries</div>
          <div className="stat-value">{purchases.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Goods value at qty × rate, before bill discounts and excluding VAT. Matches what Stock Count and COGS consume; the payable figure including VAT is in the table footer." width={270}>Gross Purchases (ex-VAT)</Tip></div>
          <div className="stat-value gold" style={{ fontSize: 16 }}>NPR {grossTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Returns</div>
          <div className="stat-value" style={{ fontSize: 16, color: returnTotal > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>
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
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '1px solid var(--theme-border)', marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 4 }} role="tablist" aria-label="Purchases views">
          {[
            { id: 'purchases', label: `Purchases (${purchases.length})` },
            { id: 'returns',   label: `Returns (${returns.length})` },
            { id: 'register',  label: 'Daily Register' },
          ].map(tab => (
            <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id}
              className={`panel-tab${activeTab === tab.id ? ' panel-tab--active' : ''}`}
              onClick={() => {
                // Switching tabs unmounts ReturnsTab, which resets its own form state naturally.
                setActiveTab(tab.id); setShowForm(false)
              }}>{tab.label}</button>
          ))}
        </div>
        {!isLocked && activeTab !== 'register' && (
          <button
            className="btn btn-ghost"
            style={{ fontSize: 12, padding: '5px 12px', marginBottom: 4, color: 'var(--theme-red-text)', borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.07)' }}
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
          <div className="no-print" style={{ marginBottom: 16 }}>
            {/* Day pill strip — wraps to additional rows instead of scrolling off-screen */}
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
              <button
                className={`tab-btn${filterDay === 'all' ? ' tab-btn--active' : ''}`}
                onClick={() => setFilterDay('all')}
                style={{ padding: '2px 7px', fontSize: 11 }}
              >
                All Days
              </button>
              {uniqueDays.map(d => (
                <button
                  key={d}
                  className={`tab-btn${filterDay === String(d) ? ' tab-btn--active' : ''}`}
                  onClick={() => setFilterDay(String(d))}
                  style={{ whiteSpace: 'nowrap', padding: '2px 7px', fontSize: 11 }}
                >
                  D{d}
                  {billCountPerDay[d] > 0 && (
                    <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.65 }}>
                      · {billCountPerDay[d]} {billCountPerDay[d] === 1 ? 'bill' : 'bills'}
                    </span>
                  )}
                </button>
              ))}
            </div>
            {/* Item filter + count */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <SearchableSelect
                value={filterItem}
                onChange={setFilterItem}
                options={itemFilterOptions}
                style={{ minWidth: 220 }}
              />
              <SearchableSelect
                value={filterVendor}
                onChange={setFilterVendor}
                options={vendorFilterOptions}
                style={{ minWidth: 220 }}
              />
              {filterVendor !== 'all' && (
                <span style={{ fontSize: 13, color: 'var(--theme-accent-ink)', fontWeight: 600 }}>
                  Vendor Total: NPR {vendorTotal.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              )}
              {(filterDay !== 'all' || filterItem !== 'all' || filterVendor !== 'all') && (
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '6px 12px' }} onClick={() => { setFilterDay('all'); setFilterItem('all'); setFilterVendor('all') }}>Clear Filters</button>
              )}
              <span style={{ fontSize: 13, color: 'var(--theme-text2)', marginLeft: 'auto' }}>{filtered.length} entr{filtered.length !== 1 ? 'ies' : 'y'}</span>
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
              <div className="table-wrap table-wrap--fab-clear">
                <table className="data-table purchases-table purchases-print-plain">
                  <thead>
                    <tr>
                      <th><Tip text="Day of the Nepali month the goods were received." width={220}>Day</Tip></th>
                      <th>Item</th><th>Vendor</th>
                      <th style={{ textAlign: 'right' }}><Tip text="Quantity in your purchase unit, with the base-unit figure in brackets where the two differ — e.g. 2 Crate (24 Bottle). Stock and costing always use the base unit." width={280}>Qty</Tip></th>
                      <th>UOM</th>
                      <th style={{ textAlign: 'right' }}><Tip text="Cost per base unit, not per purchase unit. A NPR 1,200 crate of 24 bottles stores as NPR 50 per bottle — which is what Recipe Costing and Stock value use." width={280}>Rate</Tip></th>
                      {/* "(incl. VAT)" on its own line, not inline. `data-table th` is nowrap, so as one
                          string this was a 150px column — the single widest thing in the header — to label
                          figures that need 75px. A block child breaks the line regardless of nowrap. */}
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="What the bill came to in total — after any discount and including 13% VAT on the VAT-marked lines. This is the amount payable to the vendor." width={260}>Bill Total</Tip>
                        <span style={{ display: 'block', fontWeight: 400, opacity: 0.75 }}>incl. VAT</span>
                      </th>
                      <th>Expiry</th><th></th>
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

                        const dayCell = (
                          <td style={{ fontWeight: 700, color: 'var(--theme-accent-ink)', fontSize: 14, borderRight: '1px solid var(--theme-border)', verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                            {gIdx === 0 ? (
                              <>
                                {formatBsDay(day, selectedPeriod?.bs_month)}
                                {selectedPeriod && (
                                  <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginTop: 2 }}>
                                    {formatAd(bsToAd(selectedPeriod.bs_year, selectedPeriod.bs_month, parseInt(day)))}
                                  </div>
                                )}
                              </>
                            ) : null}
                          </td>
                        )
                        const actionsCell = (
                          <td style={{ textAlign: 'right', verticalAlign: 'middle' }}>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end' }}>
                              {/* Credit is a normal commercial arrangement, not a fault — it was badge-red beside a green
                                  Cash, which reads as a warning on every credit bill a restaurant enters.
                                  badge-yellow is the categorical tag; overdue-ness is Outstanding Payables' job. */}
                              <span className={`badge ${first.payment_method === 'Cash' ? 'badge-green' : first.payment_method === 'Credit' ? 'badge-yellow' : 'badge-purple'}`}>
                                {first.payment_method || 'Cash'}
                              </span>
                              {!isLocked && <>
                                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '7px 11px' }} onClick={() => openEditGroup(gid)}>Edit</button>
                                <button className="btn btn-danger" style={{ fontSize: 11, padding: '7px 11px' }} onClick={() => deleteGroup(gid)}>Del</button>
                              </>}
                            </div>
                          </td>
                        )

                        // A single-item bill has nothing left to say on a second row — the bill-level
                        // fields (vendor/total/payment/actions) and the one line item's fields (item/
                        // qty/rate) collapse into one row instead of leaving every other cell blank
                        // on two separate rows.
                        if (groupEntries.length === 1) {
                          const entry = groupEntries[0]
                          const cf = getCf(entry.items)
                          const displayQty  = cf > 1 ? entry.qty / cf : entry.qty
                          const displayUnit = cf > 1 ? entry.items.purchase_unit : entry.items?.uom
                          const displayRate = cf > 1 ? entry.rate * cf : entry.rate
                          return [
                            <tr key={`gh-${gid}`} style={{ background: 'rgba(201,168,76,0.04)', borderTop: gIdx > 0 ? '2px solid var(--theme-card)' : undefined }}>
                              {dayCell}
                              <td className="purchases-item-cell" style={{ fontWeight: 500, color: 'var(--theme-text1)', fontSize: 13 }}>
                                <span style={{ whiteSpace: 'nowrap' }}>{entry.items?.name}</span>
                                {entry.items?.categories?.name && (
                                  <span className="badge badge-yellow" style={{ marginLeft: 8 }}>{entry.items.categories.name}</span>
                                )}
                              </td>
                              <td style={{ verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                                <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{first.vendors?.name || <span style={{ color: 'var(--theme-text2)' }}>No Vendor</span>}</span>
                                {first.invoice_ref && <span style={{ display: 'block', color: 'var(--theme-text2)', fontSize: 11, marginTop: 2 }}>#{first.invoice_ref}</span>}
                              </td>
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                {Number(displayQty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                                {cf > 1 && <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{Number(entry.qty).toLocaleString()} {entry.items?.uom}</div>}
                              </td>
                              <td style={{ color: 'var(--theme-text2)' }}>{displayUnit}</td>
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                {Number(displayRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                {cf > 1 && <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>NPR {Number(entry.rate).toFixed(4)}/{entry.items?.uom}</div>}
                              </td>
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--theme-accent-ink)', fontSize: 13, verticalAlign: 'middle' }}>
                                {groupGrand.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                {vatAmount > 0 && <div style={{ fontSize: 11, color: 'var(--theme-amber-text)', fontWeight: 400 }}>+VAT: {vatAmount.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
                                {discountAmt > 0 && <div style={{ fontSize: 11, color: 'var(--theme-red-text)', fontWeight: 400 }}>−Disc: {discountAmt.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
                              </td>
                              <td style={{ fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>
                                {entry.expiry_date ? <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11 }}>{entry.expiry_date}</span> : '—'}
                              </td>
                              {actionsCell}
                            </tr>
                          ]
                        }

                        return [
                          // Group header row
                          <tr key={`gh-${gid}`} style={{ background: 'rgba(201,168,76,0.04)', borderTop: gIdx > 0 ? '2px solid var(--theme-card)' : undefined }}>
                            {dayCell}
                            <td></td>
                            {/* Invoice ref and line count on a second line under the vendor name, not trailing
                                it. Inline, in a nowrap cell, this was the bill row's own 223px column for a
                                name that needs ~120px — and the two are supporting detail, not a peer of the
                                name they describe. */}
                            <td style={{ verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                              <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{first.vendors?.name || <span style={{ color: 'var(--theme-text2)' }}>No Vendor</span>}</span>
                              <span style={{ display: 'block', fontSize: 11, marginTop: 2, color: 'var(--theme-text3)' }}>
                                {first.invoice_ref && <span style={{ color: 'var(--theme-text2)' }}>#{first.invoice_ref} · </span>}
                                {groupEntries.length} items
                              </span>
                            </td>
                            <td colSpan={3}></td>
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 700, color: 'var(--theme-accent-ink)', fontSize: 13, verticalAlign: 'middle' }}>
                              {groupGrand.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              {vatAmount > 0 && <div style={{ fontSize: 11, color: 'var(--theme-amber-text)', fontWeight: 400 }}>+VAT: {vatAmount.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
                              {discountAmt > 0 && <div style={{ fontSize: 11, color: 'var(--theme-red-text)', fontWeight: 400 }}>−Disc: {discountAmt.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>}
                            </td>
                            <td></td>
                            {actionsCell}
                          </tr>,
                          // Item sub-rows
                          ...groupEntries.map(entry => (
                            <tr key={entry.id} style={{ background: 'rgba(0,0,0,0.12)', borderBottom: '1px solid var(--theme-card)' }}>
                              <td></td>
                              <td className="purchases-item-cell" style={{ fontWeight: 500, color: 'var(--theme-text2)', paddingLeft: 20, fontSize: 13 }}>
                                <span style={{ whiteSpace: 'nowrap' }}>{entry.items?.name}</span>
                                {entry.items?.categories?.name && (
                                  <span className="badge badge-yellow" style={{ marginLeft: 8 }}>{entry.items.categories.name}</span>
                                )}
                              </td>
                              <td></td>
                              {(() => {
                                const cf = getCf(entry.items)
                                const displayQty  = cf > 1 ? entry.qty / cf : entry.qty
                                const displayUnit = cf > 1 ? entry.items.purchase_unit : entry.items?.uom
                                const displayRate = cf > 1 ? entry.rate * cf : entry.rate
                                return (
                                  <>
                                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                      {Number(displayQty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                                      {cf > 1 && <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{Number(entry.qty).toLocaleString()} {entry.items?.uom}</div>}
                                    </td>
                                    <td style={{ color: 'var(--theme-text2)' }}>{displayUnit}</td>
                                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                      {Number(displayRate).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                                      {cf > 1 && <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>NPR {Number(entry.rate).toFixed(4)}/{entry.items?.uom}</div>}
                                    </td>
                                  </>
                                )
                              })()}
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--theme-accent-ink)' }}>
                                {(entry.qty * entry.rate).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td style={{ fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>
                                {entry.expiry_date ? <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11 }}>{entry.expiry_date}</span> : '—'}
                              </td>
                              <td></td>
                            </tr>
                          ))
                        ]
                      })
                    })}
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td colSpan={3} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>
                        <Tip text="Sum of qty × rate for the lines shown — before any bill discount and excluding VAT. This is the goods value, which is what Stock Count and COGS use." width={270}>Total goods value (ex-VAT)</Tip>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)', fontSize: 14, paddingTop: 12 }}>
                        {filteredQty !== null ? filteredQty.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—'}
                      </td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12, paddingTop: 12 }}>{filteredQtyUnit}</td>
                      <td></td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', fontSize: 14, paddingTop: 12 }}>
                        NPR {filteredValue.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                    <tr>
                      <td colSpan={6} style={{ fontWeight: 700, color: 'var(--theme-text2)' }}>
                        <Tip text="The same bills after their discounts and with VAT added — what actually leaves the bank. This is the figure the Bill Total column adds up to." width={270}>Total payable (incl. VAT)</Tip>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)', fontSize: 14 }}>
                        NPR {filteredPayable.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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

        async function exportRegisterExcel() {
          const XLSX = await import('xlsx')
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
              <div className="table-wrap table-wrap--fab-clear">
                <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ ...thStyle, textAlign: 'center', width: 36 }}>S.No</th>
                      <th style={{ ...thStyle, textAlign: 'left', minWidth: 160 }}>Item Name</th>
                      <th style={{ ...thStyle, width: 48 }}>UOM</th>
                      {days.map(d => (
                        <th key={d} style={{ ...thStyle, width: 52, color: d % 2 === 0 ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>{d}</th>
                      ))}
                      <th style={{ ...thStyle, width: 68, color: 'var(--theme-accent-ink)', borderLeft: '1px solid var(--theme-border)', position: 'sticky', right: 0, zIndex: 3 }}><Tip text="Row total across every day of the month, at goods value (ex-VAT, before bill discounts)." width={260}>Total</Tip></th>
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
                          <td colSpan={3 + numDays + 1} style={{ padding: '6px 10px', fontWeight: 700, fontSize: 11, color: 'var(--theme-accent-ink)', letterSpacing: '0.08em', textTransform: 'uppercase', borderBottom: '1px solid var(--theme-border)' }}>
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
                              <td style={{ ...tdStyle, color: 'var(--theme-accent-ink)', fontWeight: 700, borderLeft: '1px solid var(--theme-border)', position: 'sticky', right: 0, background: rowBg }}>
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
