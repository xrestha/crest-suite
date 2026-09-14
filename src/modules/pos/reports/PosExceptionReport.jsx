import { npr } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { firstError } from '../../../shared/queryError'
import ReportLoadError from '../../../components/ReportLoadError'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { formatAd, BS_MONTHS } from '../../../utils/bsCalendar'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { viewPosBill } from '../../../utils/viewPosBill'
import { CLOSE_TYPE_BADGE } from '../posSignals'
import { nepalTime, nepalTime24, nepalBs, nepalCivilDate } from '../../../shared/nepalTime'
import { nepalDayStartTs, nepalDayEndTs, todayNepalAdIso, bsSlash } from './reportRange'

const fmtNpr = npr

const TYPE_META = {
  discount: { label: 'Discount', badge: CLOSE_TYPE_BADGE.discount },
  void:     { label: 'Void',     badge: CLOSE_TYPE_BADGE.void     },
  writeoff: { label: 'Comp',     badge: CLOSE_TYPE_BADGE.writeoff },
}

function invoiceLabel(order, vatReg, prefix) {
  if (order.invoice_no == null) return `#${order.order_no ?? ''}`
  if (order.close_type === 'writeoff') return `NC-${String(order.invoice_no).padStart(2, '0')}`
  return `${vatReg ? 'TI' : 'PB'}${order.invoice_no}-${prefix}${prefix ? '-' : ''}${order.invoice_fy || ''}`
}

export default function PosExceptionReport() {
  const { clientId, hasPosAccess } = useAuth()
  const { scopedFrom } = useScopedDb()

  const biz = useBizInfo()
  // Nepal's today, not the viewer's (S754) — see reportRange.js.
  const [fromIso, setFromIso] = useState(todayNepalAdIso)
  const [toIso,   setToIso]   = useState(todayNepalAdIso)

  const [rows,    setRows]    = useState([])   // enriched exception rows
  const [loading, setLoading] = useState(true)
  // S612 silent-zero rule: a failed read must render as a failure, never as a quiet report —
  // this page's empty state actively celebrates one.
  const [loadError, setLoadError] = useState(null)
  const [typeFilter,  setTypeFilter]  = useState('all')  // 'all' | 'discount' | 'void' | 'writeoff'
  const [staffFilter, setStaffFilter] = useState('all')
  const [staffNames,  setStaffNames]  = useState({})     // { profileId: full_name }
  const [billingSettings, setBillingSettings] = useState({ is_vat_registered: true, invoice_prefix: '' })

  // S754 overlapping-load guard: each picker change starts a load, and the slower of two used to win
  // the exception rows while the pickers — and so the export's scope line and filename — named the
  // other range. Keyed on client + range, so a reload of the same range still lands.
  const loadReq = useLatestRequest()

  const load = useCallback(async () => {
    const reqKey = loadReq.begin(`${clientId}:${fromIso}:${toIso}`)
    setLoading(true)
    setLoadError(null)

    // Nepal's day boundaries, not the runtime's (S754) — see reportRange.js.
    const fromTs = nepalDayStartTs(fromIso)
    const toTs   = nepalDayEndTs(toIso)

    const results = await Promise.all([
      // Paged: this is the fraud/exception audit trail, so a truncated read hides exactly the
      // rows someone would be looking for — and reports a smaller total as if it were complete.
      fetchAllRows(() => scopedFrom('pos_orders', 'id, order_no, invoice_no, invoice_fy, close_type, close_reason, discount_amount, discount_reason, paid_amount, table_name, closed_at, closed_by')
        .gte('closed_at', fromTs).lte('closed_at', toTs)
        .or('close_type.in.(void,writeoff),discount_amount.gt.0')
        .order('closed_at', { ascending: false }).order('id')),
      // Raw `profiles` reads are RLS-limited to the caller's own row (id = auth.uid() OR admin)
      // — resolving OTHER staff members' names needs get_client_profile_names(), a SECURITY
      // DEFINER RPC. A raw query here silently showed "—" for every staff member except
      // whoever was logged in.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
      supabase.from('settings').select('is_vat_registered, invoice_prefix').eq('client_id', clientId).maybeSingle(),
      // Item-level comps (see PosOrders.jsx) — these live inside otherwise-'paid' orders, which
      // the query above never fetches (it's paid-with-a-discount or void/writeoff only), so they
      // need their own fetch or they'd be invisible in this report entirely.
      // Paged: comps are individually rare, but this filters a whole date range rather than one
      // bill, and a long range on a busy outlet can still cross the silent 1000-row cap — at
      // which point the exception report would under-report exactly the exceptions it exists to
      // surface, with no error to say so (S529).
      fetchAllRows(() => scopedFrom('pos_order_items', 'order_id, recipe_id, qty, unit_price, comped_by, comped_at, comp_reason, comp_no')
        .eq('comped', true).gte('comped_at', fromTs).lte('comped_at', toTs).order('id')),
    ])
    if (!loadReq.isCurrent(reqKey)) return
    // S612 silent-zero rule: a failed read would render "no exceptions — a quiet report is a
    // healthy one" over an audit trail that never loaded.
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); setLoading(false); return }
    const [{ data: orders }, { data: profs }, { data: settings }, { data: itemComps }] = results

    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    setBillingSettings({
      is_vat_registered: settings?.is_vat_registered ?? true,
      invoice_prefix: settings?.invoice_prefix || '',
    })

    // Voids are valued at forgone menu price EXCLUDING VAT; Comps at food cost (matches the
    // Complimentary Slip) with their potential sales value also ex-VAT; Discounts at the discount
    // amount itself, which is already pre-VAT (computeOrderAmounts takes it off the base before VAT).
    // One basis for all three (owner decision, S754): VAT on a sale that never happened was never
    // revenue, so counting it made a void look ~13% larger than a discount of the same food.
    const needItems = (orders || []).filter(o => o.close_type === 'void' || o.close_type === 'writeoff')
    let itemsByOrder = {}
    let costMap = {}
    if (needItems.length > 0) {
      // Chunked (S754): every void and comp in the range, spelled out as uuids in one URL.
      const { data: items, error: itemsError } = await fetchAllRowsChunked(needItems.map(o => o.id),
        ids => scopedFrom('pos_order_items', 'order_id, qty, unit_price, recipe_id').in('order_id', ids).order('id'))
      if (!loadReq.isCurrent(reqKey)) return
      // S612: without the lines, every void/comp values at a believable NPR 0.
      if (itemsError) { setLoadError(itemsError.message || String(itemsError)); setRows([]); setLoading(false); return }
      itemsByOrder = (items || []).reduce((acc, i) => {
        ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
        return acc
      }, {})
      const compRecipeIds = [...new Set((items || [])
        .filter(i => needItems.find(o => o.id === i.order_id)?.close_type === 'writeoff')
        .map(i => i.recipe_id).filter(Boolean))]
      // computeRecipeCosts THROWS on a failed read (S695). Unwrapped, the rejection escaped load()
      // and `loading` never went false — the page sat on "Loading…" for good (S754).
      if (compRecipeIds.length > 0) {
        try {
          costMap = await computeRecipeCosts(supabase, compRecipeIds)
        } catch (err) {
          if (!loadReq.isCurrent(reqKey)) return
          setLoadError(err); setRows([]); setLoading(false); return
        }
        if (!loadReq.isCurrent(reqKey)) return
      }
    }

    const baseRows = (orders || []).map(o => {
      const type = o.close_type === 'void' ? 'void' : o.close_type === 'writeoff' ? 'writeoff' : 'discount'
      let amount = 0
      let potentialValue = 0
      if (type === 'discount') amount = o.discount_amount || 0
      if (type === 'void')     amount = (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * i.unit_price, 0)
      if (type === 'writeoff') {
        amount = (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * (costMap[i.recipe_id] || 0), 0)
        // What this would have sold for at menu price, ex-VAT, had it been a normal sale — same
        // formula as Void's forgone value, just for the Comp bucket instead.
        potentialValue = (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * i.unit_price, 0)
      }
      return {
        ...o, type, amount, potentialValue,
        reason: type === 'discount' ? (o.discount_reason || '—') : (o.close_reason || '—'),
      }
    })

    // Group item-level comps by (order_id, comp_no) — every item comped in one Charge action
    // shares one slip/one number (see get_next_pos_comp_slip_no), so it's one exception row here
    // too, not one per line, matching how a whole-order Comp is already one row per order.
    let itemCompRows = []
    if ((itemComps || []).length > 0) {
      const orderIds = [...new Set(itemComps.map(i => i.order_id))]
      // Chunked and paged (S754): one parent per comped bill in the range, as a `.in()` URL.
      const { data: parentOrders, error: parentsError } = await fetchAllRowsChunked(orderIds,
        ids => scopedFrom('pos_orders', 'id, order_no, table_name, invoice_no, invoice_fy').in('id', ids).order('id'))
      if (!loadReq.isCurrent(reqKey)) return
      // S612: a dropped error here would strip every item-comp of its parent bill reference.
      if (parentsError) { setLoadError(parentsError.message); setRows([]); setLoading(false); return }
      const parentById = Object.fromEntries((parentOrders || []).map(o => [o.id, o]))
      const recipeIds = [...new Set(itemComps.map(i => i.recipe_id).filter(Boolean))]
      // Same throw as above, same wrap (S754).
      let itemCostMap = {}
      if (recipeIds.length > 0) {
        try {
          itemCostMap = await computeRecipeCosts(supabase, recipeIds)
        } catch (err) {
          if (!loadReq.isCurrent(reqKey)) return
          setLoadError(err); setRows([]); setLoading(false); return
        }
        if (!loadReq.isCurrent(reqKey)) return
      }

      const groups = {}
      for (const i of itemComps) {
        const key = `${i.order_id}:${i.comp_no}`
        const g = groups[key] = groups[key] || {
          id: `itemcomp-${key}`, type: 'writeoff', close_type: 'writeoff',
          invoice_no: i.comp_no, order_no: parentById[i.order_id]?.order_no,
          table_name: parentById[i.order_id]?.table_name,
          closed_at: i.comped_at, closed_by: i.comped_by, reason: i.comp_reason || '—',
          amount: 0, potentialValue: 0,
          // Drill-down needs the REAL parent order id — this row's own `id` is synthetic
          // (grouped across possibly-several pos_order_items rows, no single DB row of its own).
          isItemComp: true, parentOrderId: i.order_id, compNo: i.comp_no,
          // The Tax Invoice/PAN Bill this item-comp was carved out of — "vice versa" tagging
          // (bill ↔ comp cross-reference) needs this on both sides, not just the comp side.
          parentInvoiceNo: parentById[i.order_id]?.invoice_no,
          parentInvoiceFy: parentById[i.order_id]?.invoice_fy,
        }
        g.amount += i.qty * (itemCostMap[i.recipe_id] || 0)
        g.potentialValue += i.qty * i.unit_price
      }
      itemCompRows = Object.values(groups)
    }

    setRows([...baseRows, ...itemCompRows].sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at)))
    setLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom, loadReq])

  useEffect(() => { if (clientId) load() }, [clientId, load])

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  const vatReg = billingSettings.is_vat_registered
  const prefix = billingSettings.invoice_prefix

  const filtered = rows.filter(r =>
    (typeFilter === 'all' || r.type === typeFilter) &&
    (staffFilter === 'all' || r.closed_by === staffFilter)
  )

  const totals = { discount: { n: 0, amt: 0 }, void: { n: 0, amt: 0 }, writeoff: { n: 0, amt: 0, potential: 0 } }
  for (const r of rows) {
    totals[r.type].n++; totals[r.type].amt += r.amount
    if (r.type === 'writeoff') totals.writeoff.potential += r.potentialValue || 0
  }

  // Per-staff rollup — the "spot the outlier" view. The ranking figure must be ONE unit:
  // r.amount mixes discount NPR, void menu value (ex-VAT) and comp FOOD COST, so summing it
  // ranked staff by a number that wasn't a quantity of anything. Revenue impact normalises the
  // comp term to its potential sales value (already computed per row), so all three terms are
  // "revenue given away" and the total is coherent — all three EXCLUDING VAT (S754), since VAT is
  // collected for the IRD and was never the outlet's revenue. Food cost stays in the Comps column.
  const byStaff = {}
  for (const r of rows) {
    const key = r.closed_by || 'unknown'
    byStaff[key] = byStaff[key] || { discount: { n: 0, amt: 0 }, void: { n: 0, amt: 0 }, writeoff: { n: 0, amt: 0 }, revenue: 0 }
    byStaff[key][r.type].n++
    byStaff[key][r.type].amt += r.amount
    byStaff[key].revenue += r.type === 'writeoff' ? (r.potentialValue || 0) : r.amount
  }
  const staffRows = Object.entries(byStaff).sort((a, b) => b[1].revenue - a[1].revenue)

  const staffOptions = [...new Set(rows.map(r => r.closed_by).filter(Boolean))]

  const TYPE_FILTER_LABEL = { all: 'All', discount: 'Discounts', void: 'Voids', writeoff: 'Comps' }
  const filtersActive = typeFilter !== 'all' || staffFilter !== 'all'

  async function exportExcel() {
    const XLSX = await import('xlsx')
    // The sheet exports the FILTERED rows, so it has to say which filters (S594/S754) — a bare
    // json_to_sheet of "Voids by one cashier" was indistinguishable from the whole range's audit.
    const staffScope = staffFilter === 'all' ? 'All staff' : (staffNames[staffFilter] || staffFilter)
    const scopeLine = `@Date Range : ${fromIso} (B.S. ${bsSlash(fromIso)})  To : ${toIso} (B.S. ${bsSlash(toIso)})  @Type : ${TYPE_FILTER_LABEL[typeFilter]}  @Staff : ${staffScope}  @Times : Nepal time (UTC+05:45), 24-hour`
    const ws = sheetWithLetterhead(XLSX, { title: 'Sales Exceptions', biz, scopeLine, rows: filtered.map(r => {
      const bs = nepalBs(r.closed_at)
      const civil = nepalCivilDate(r.closed_at)
      return {
        // YYYY-MM-DD of the Nepal day (S754). toLocaleDateString() printed in the VIEWER's locale
        // and timezone — 9/14/2026 on one laptop, 14.9.2026 on another, and a day early abroad.
        'Date (AD)':  civil ? formatAd(civil) : '',
        'Miti (BS)':  bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : '',
        // The screen has shown this time since the report was written; the sheet never did, so an
        // exported exception could not be tied back to the shift it happened on. 24-hour because a
        // sheet column gets sorted, and "06:50 PM" sorts before "11:30 AM" as text.
        'Time':       nepalTime24(r.closed_at),
        'Bill No':    invoiceLabel(r, vatReg, prefix),
        'On Bill':    r.isItemComp && r.parentInvoiceNo != null
          ? invoiceLabel({ invoice_no: r.parentInvoiceNo, invoice_fy: r.parentInvoiceFy, close_type: 'paid', order_no: r.order_no }, vatReg, prefix)
          : '',
        'Table':      r.table_name || 'Takeaway',
        'Type':       TYPE_META[r.type].label,
        'Reason':     r.reason,
        // Discount and Void amounts are ex-VAT; a Comp's Amount is its food cost (S754).
        'Amount, ex-VAT / food cost (NPR)': Math.round(r.amount * 100) / 100,
        'Potential Value, ex-VAT (NPR)': r.type === 'writeoff' ? Math.round(r.potentialValue * 100) / 100 : '',
        'Closed By':  staffNames[r.closed_by] || '—',
      }
    }) })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Exceptions')
    XLSX.writeFile(wb, `sales-exceptions-${fromIso}-to-${toIso}.xlsx`)
  }

  return (
    <div>

      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Sales Exceptions</h1>
          <p className="page-subtitle">
            Every discount, void, and complimentary in one place — revenue that leaked, by reason and by staff member. Click any row below to view the actual bill.
          </p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Off while loading or failed as well as when empty (S728/S754): the filename and scope
              line come from the pickers, which move before the rows do. */}
          {/* …and off while the letterhead's client-name read has failed, or the sheet ships with a
              blank CompanyName (S754 — useBizInfo now returns that read's error). */}
          <button className="btn btn-ghost" onClick={exportExcel} disabled={filtered.length === 0 || loading || !!loadError || !!biz.error}>
            ⬇ Excel
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-exception-report-from-bs">From (BS)</label>
          <BsCalendarPicker id="pos-exception-report-from-bs" value={fromIso} onChange={setFromIso} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-exception-report-to-bs">To (BS)</label>
          <BsCalendarPicker id="pos-exception-report-to-bs" value={toIso} onChange={setToIso} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-exception-report-staff">Staff</label>
          <select id="pos-exception-report-staff" className="form-select" value={staffFilter} onChange={e => setStaffFilter(e.target.value)}>
            <option value="all">All staff</option>
            {staffOptions.map(id => <option key={id} value={id}>{staffNames[id] || id}</option>)}
          </select>
        </div>
        <div className="tab-bar" style={{ marginBottom: 0 }}>
          <button className={`tab-btn${typeFilter === 'all' ? ' tab-btn--active' : ''}`} onClick={() => setTypeFilter('all')}>All</button>
          <button className={`tab-btn${typeFilter === 'discount' ? ' tab-btn--active' : ''}`} onClick={() => setTypeFilter('discount')}>Discounts</button>
          <button className={`tab-btn${typeFilter === 'void' ? ' tab-btn--active' : ''}`} onClick={() => setTypeFilter('void')}>Voids</button>
          <button className={`tab-btn${typeFilter === 'writeoff' ? ' tab-btn--active' : ''}`} onClick={() => setTypeFilter('writeoff')}>Comps</button>
        </div>
      </div>

      {biz.error && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Excel is switched off rather than exporting a sheet
          with a blank company name. The figures below are unaffected. Reload the page to try again.
        </p>
      )}
      {/* S612: a failed read renders as a failure — never as zero stat cards or a quiet report. */}
      {loadError ? (
        <ReportLoadError error={loadError} />
      ) : loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          {/* Stat cards — the shared stat-grid/stat-card grammar; signal colours stay on the
              *-text variants since these values are TEXT, not fills (S613). */}
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Total NPR knocked off bills via the Discount field on the Pay tab. A discount comes off the price before VAT, so this excludes VAT." width={250}>Discounts</Tip>
              </div>
              <div className="stat-value">{fmtNpr(totals.discount.amt)}</div>
              <div className="stat-sub">{totals.discount.n} bill{totals.discount.n !== 1 ? 's' : ''}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Menu value of voided orders, excluding VAT — orders treated as if they never happened. High void rates usually mean training gaps or entry mistakes" width={260}>Voided Value</Tip>
              </div>
              <div className="stat-value" style={{ color: 'var(--theme-red-text)' }}>{fmtNpr(totals.void.amt)}</div>
              <div className="stat-sub">{totals.void.n} order{totals.void.n !== 1 ? 's' : ''}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="Food cost of complimentary orders and individually-comped items — valued at ingredient cost (not menu price), matching the Complimentary Slip" width={250}>Comp Food Cost</Tip>
              </div>
              <div className="stat-value" style={{ color: 'var(--theme-accent-ink)' }}>{fmtNpr(totals.writeoff.amt)}</div>
              <div className="stat-sub">{totals.writeoff.n} comp{totals.writeoff.n !== 1 ? 's' : ''}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="What every comped order/item would have sold for at menu price, excluding VAT, had it not been comped — the revenue given away, not just its ingredient cost" width={280}>Comp Potential Sales Value</Tip>
              </div>
              <div className="stat-value" style={{ color: 'var(--theme-accent-ink)' }}>{fmtNpr(totals.writeoff.potential)}</div>
              <div className="stat-sub">{totals.writeoff.n} comp{totals.writeoff.n !== 1 ? 's' : ''}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                <Tip text="A quiet report is a healthy one — lots of exceptions usually signal training gaps or permission creep" width={240}>Total Exceptions</Tip>
              </div>
              <div className="stat-value">{rows.length}</div>
              {/* Revenue-equivalent sum (comps at potential sales value), all ex-VAT — never add comp
                  food COST to discount/void revenue figures; that total is not a quantity of anything. */}
              <div className="stat-sub">{fmtNpr(totals.discount.amt + totals.void.amt + totals.writeoff.potential)} revenue impact, ex-VAT</div>
            </div>
          </div>

          {/* Per-staff rollup */}
          {staffRows.length > 0 && (
            <>
              <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                By Staff Member <Tip text="Who is closing the exceptions — one cashier discounting far more than everyone else is worth a conversation. Attribution records whoever was signed in on the till when the bill closed, so on a shared till treat this as a starting point, not proof." width={280}>ⓘ</Tip>
              </p>
              <div className="table-wrap" style={{ marginBottom: 24 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Staff</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Count · NPR knocked off bills" width={200}>Discounts</Tip>
                      </th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Count · menu value forgone, excluding VAT" width={220}>Voids</Tip>
                      </th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Count · food cost of what was served (the Revenue Impact column values these at menu price instead)" width={260}>Comps</Tip>
                      </th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Discounts + voided menu value + what comps would have sold for — all at sales value and all EXCLUDING VAT, so this total is one coherent number rather than a mix of cost and revenue, or of VAT-inclusive and VAT-exclusive figures" width={300}>Revenue Impact</Tip>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffRows.map(([id, s]) => (
                      <tr key={id}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{staffNames[id] || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{s.discount.n > 0 ? `${s.discount.n} · ${fmtNpr(s.discount.amt)}` : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{s.void.n > 0 ? `${s.void.n} · ${fmtNpr(s.void.amt)}` : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{s.writeoff.n > 0 ? `${s.writeoff.n} · ${fmtNpr(s.writeoff.amt)}` : '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(s.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Detail table */}
          {filtered.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
              {/* Two different facts (S754): the celebratory line claims the range is clean, which
                  is false when the rows exist and a Type/Staff filter is hiding every one of them. */}
              {rows.length > 0 && filtersActive
                ? 'Nothing matches these filters. Set Type to All and Staff to All staff to see every exception in this range.'
                : 'No exceptions in this range — a quiet report is a healthy one. 🎉'}
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Bill No</th>
                    <th>Table</th>
                    <th>Type</th>
                    <th>Reason</th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Discounts: the amount knocked off (before VAT). Voids: menu value forgone, excluding VAT. Comps: food cost of what was served" width={260}>Amount</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Comps only — what this would have sold for at menu price, excluding VAT, had it not been comped" width={260}>Potential Value</Tip>
                    </th>
                    <th>Closed By</th>
                    <th className="no-print"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    // Nepal's day beside Nepal's clock (S754) — adToBsSafe(new Date(ts)) read the
                    // runtime's day, so 00:15 Kathmandu showed under the previous BS day abroad.
                    const bs = nepalBs(r.closed_at)
                    return (
                      <tr key={r.id} onClick={() => viewPosBill(clientId, r)} style={{ cursor: 'pointer' }}>
                        <td>
                          {bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]}` : '—'}
                          <span style={{ color: 'var(--theme-text3)', fontSize: 11, marginLeft: 6 }}>
                            {r.closed_at ? nepalTime(r.closed_at) : ''}
                          </span>
                        </td>
                        {/* The row keeps its onClick as the mouse convenience; this button is
                            the keyboard/SR path. Never role="button" on the tr. */}
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                          <button className="btn-linklike" onClick={e => { e.stopPropagation(); viewPosBill(clientId, r) }}>
                            {invoiceLabel(r, vatReg, prefix)}
                          </button>
                          {r.isItemComp && r.parentInvoiceNo != null && (
                            <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--theme-text3)' }}>
                              on {invoiceLabel({ invoice_no: r.parentInvoiceNo, invoice_fy: r.parentInvoiceFy, close_type: 'paid', order_no: r.order_no }, vatReg, prefix)}
                            </div>
                          )}
                        </td>
                        <td>{r.table_name || 'Takeaway'}</td>
                        <td><span className={`badge ${TYPE_META[r.type].badge}`}>{TYPE_META[r.type].label}</span></td>
                        <td>{r.reason}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(r.amount)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{r.type === 'writeoff' ? fmtNpr(r.potentialValue) : '—'}</td>
                        <td>{staffNames[r.closed_by] || '—'}</td>
                        {/* Keyboard path to the same drill-down as the row click — a tr onClick
                            alone is mouse-only, and role="button" on a tr is never the fix (S613). */}
                        <td className="no-print">
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '2px 10px' }}
                            onClick={e => { e.stopPropagation(); viewPosBill(clientId, r) }}>
                            View bill
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
