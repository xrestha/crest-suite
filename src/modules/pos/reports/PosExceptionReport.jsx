import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { adToBs, formatAd, BS_MONTHS } from '../../../utils/bsCalendar'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { viewPosBill } from '../../../utils/viewPosBill'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`

const TYPE_META = {
  discount: { label: 'Discount', badge: 'badge-gold'  },
  void:     { label: 'Void',     badge: 'badge-red'   },
  writeoff: { label: 'Comp',     badge: 'badge-amber' },
}

function invoiceLabel(order, vatReg, prefix) {
  if (order.invoice_no == null) return `#${order.order_no ?? ''}`
  if (order.close_type === 'writeoff') return `NC-${String(order.invoice_no).padStart(2, '0')}`
  return `${vatReg ? 'TI' : 'PB'}${order.invoice_no}-${prefix}${prefix ? '-' : ''}${order.invoice_fy || ''}`
}

export default function PosExceptionReport() {
  const { clientId, hasPosAccess } = useAuth()
  const { scopedFrom } = useScopedDb()

  const [fromIso, setFromIso] = useState(formatAd(new Date()))
  const [toIso,   setToIso]   = useState(formatAd(new Date()))

  const [rows,    setRows]    = useState([])   // enriched exception rows
  const [loading, setLoading] = useState(true)
  const [typeFilter,  setTypeFilter]  = useState('all')  // 'all' | 'discount' | 'void' | 'writeoff'
  const [staffFilter, setStaffFilter] = useState('all')
  const [staffNames,  setStaffNames]  = useState({})     // { profileId: full_name }
  const [billingSettings, setBillingSettings] = useState({ is_vat_registered: true, invoice_prefix: '' })

  const load = useCallback(async () => {
    setLoading(true)

    const fromTs = new Date(fromIso + 'T00:00:00').toISOString()
    const toTs   = new Date(toIso + 'T23:59:59.999').toISOString()

    const [{ data: orders }, { data: profs }, { data: settings }, { data: itemComps }] = await Promise.all([
      scopedFrom('pos_orders', 'id, order_no, invoice_no, invoice_fy, close_type, close_reason, discount_amount, discount_reason, paid_amount, table_name, closed_at, closed_by')
        .gte('closed_at', fromTs).lte('closed_at', toTs)
        .or('close_type.in.(void,writeoff),discount_amount.gt.0')
        .order('closed_at', { ascending: false }),
      // Raw `profiles` reads are RLS-limited to the caller's own row (id = auth.uid() OR admin)
      // — resolving OTHER staff members' names needs get_client_profile_names(), a SECURITY
      // DEFINER RPC. A raw query here silently showed "—" for every staff member except
      // whoever was logged in.
      supabase.rpc('get_client_profile_names', { p_client_id: clientId }),
      supabase.from('settings').select('is_vat_registered, invoice_prefix').eq('client_id', clientId).maybeSingle(),
      // Item-level comps (see PosOrders.jsx) — these live inside otherwise-'paid' orders, which
      // the query above never fetches (it's paid-with-a-discount or void/writeoff only), so they
      // need their own fetch or they'd be invisible in this report entirely.
      scopedFrom('pos_order_items', 'order_id, recipe_id, qty, unit_price, vat_rate, comped_by, comped_at, comp_reason, comp_no')
        .eq('comped', true).gte('comped_at', fromTs).lte('comped_at', toTs),
    ])

    setStaffNames(Object.fromEntries((profs || []).map(p => [p.id, p.full_name])))
    setBillingSettings({
      is_vat_registered: settings?.is_vat_registered ?? true,
      invoice_prefix: settings?.invoice_prefix || '',
    })

    // Voids are valued at forgone menu price (incl VAT); Comps at food cost (matches the
    // Complimentary Slip); Discounts at the discount amount itself.
    const needItems = (orders || []).filter(o => o.close_type === 'void' || o.close_type === 'writeoff')
    let itemsByOrder = {}
    let costMap = {}
    if (needItems.length > 0) {
      const { data: items } = await scopedFrom('pos_order_items', 'order_id, qty, unit_price, vat_rate, recipe_id')
        .in('order_id', needItems.map(o => o.id))
      itemsByOrder = (items || []).reduce((acc, i) => {
        ;(acc[i.order_id] = acc[i.order_id] || []).push(i)
        return acc
      }, {})
      const compRecipeIds = [...new Set((items || [])
        .filter(i => needItems.find(o => o.id === i.order_id)?.close_type === 'writeoff')
        .map(i => i.recipe_id).filter(Boolean))]
      if (compRecipeIds.length > 0) costMap = await computeRecipeCosts(supabase, compRecipeIds)
    }

    const baseRows = (orders || []).map(o => {
      const type = o.close_type === 'void' ? 'void' : o.close_type === 'writeoff' ? 'writeoff' : 'discount'
      let amount = 0
      let potentialValue = 0
      if (type === 'discount') amount = o.discount_amount || 0
      if (type === 'void')     amount = (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * i.unit_price * (1 + (i.vat_rate ?? 0)), 0)
      if (type === 'writeoff') {
        amount = (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * (costMap[i.recipe_id] || 0), 0)
        // What this would have sold for at menu price (incl VAT) had it been a normal sale —
        // same formula as Void's forgone-value, just for the Comp bucket instead.
        potentialValue = (itemsByOrder[o.id] || []).reduce((s, i) => s + i.qty * i.unit_price * (1 + (i.vat_rate ?? 0)), 0)
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
      const { data: parentOrders } = await scopedFrom('pos_orders', 'id, order_no, table_name, invoice_no, invoice_fy').in('id', orderIds)
      const parentById = Object.fromEntries((parentOrders || []).map(o => [o.id, o]))
      const recipeIds = [...new Set(itemComps.map(i => i.recipe_id).filter(Boolean))]
      const itemCostMap = recipeIds.length > 0 ? await computeRecipeCosts(supabase, recipeIds) : {}

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
        g.potentialValue += i.qty * i.unit_price * (1 + (i.vat_rate ?? 0))
      }
      itemCompRows = Object.values(groups)
    }

    setRows([...baseRows, ...itemCompRows].sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at)))
    setLoading(false)
  }, [clientId, fromIso, toIso, scopedFrom])

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

  // Per-staff rollup — the "spot the outlier" view
  const byStaff = {}
  for (const r of rows) {
    const key = r.closed_by || 'unknown'
    byStaff[key] = byStaff[key] || { discount: { n: 0, amt: 0 }, void: { n: 0, amt: 0 }, writeoff: { n: 0, amt: 0 }, total: 0 }
    byStaff[key][r.type].n++
    byStaff[key][r.type].amt += r.amount
    byStaff[key].total += r.amount
  }
  const staffRows = Object.entries(byStaff).sort((a, b) => b[1].total - a[1].total)

  const staffOptions = [...new Set(rows.map(r => r.closed_by).filter(Boolean))]

  function exportExcel() {
    const ws = XLSX.utils.json_to_sheet(filtered.map(r => {
      const bs = r.closed_at ? adToBs(new Date(r.closed_at)) : null
      return {
        'Date (AD)':  r.closed_at ? new Date(r.closed_at).toLocaleDateString() : '',
        'Miti (BS)':  bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : '',
        'Bill No':    invoiceLabel(r, vatReg, prefix),
        'On Bill':    r.isItemComp && r.parentInvoiceNo != null
          ? invoiceLabel({ invoice_no: r.parentInvoiceNo, invoice_fy: r.parentInvoiceFy, close_type: 'paid', order_no: r.order_no }, vatReg, prefix)
          : '',
        'Table':      r.table_name || 'Takeaway',
        'Type':       TYPE_META[r.type].label,
        'Reason':     r.reason,
        'Amount (NPR)': Math.round(r.amount * 100) / 100,
        'Potential Value (NPR)': r.type === 'writeoff' ? Math.round(r.potentialValue * 100) / 100 : '',
        'Closed By':  staffNames[r.closed_by] || '—',
      }
    }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Exceptions')
    XLSX.writeFile(wb, `sales-exceptions-${fromIso}-to-${toIso}.xlsx`)
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>

      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>Sales Exceptions</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
          Every discount, void, and complimentary in one place — revenue that leaked, by reason and by staff member. Click any row below to view the actual bill.
        </p>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>From (BS)</label>
          <BsCalendarPicker value={fromIso} onChange={setFromIso} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>To (BS)</label>
          <BsCalendarPicker value={toIso} onChange={setToIso} />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Staff</label>
          <select className="form-select" value={staffFilter} onChange={e => setStaffFilter(e.target.value)}>
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
        <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={exportExcel} disabled={filtered.length === 0}>
          ⬇ Excel
        </button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          {/* Stat cards */}
          <div className="stat-grid" style={{ marginBottom: 24 }}>
            <div className="card" style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="Total NPR knocked off bills via the Discount field on the Pay tab" width={230}>Discounts</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{fmtNpr(totals.discount.amt)}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{totals.discount.n} bill{totals.discount.n !== 1 ? 's' : ''}</div>
            </div>
            <div className="card" style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="Menu value (incl. VAT) of voided orders — orders treated as if they never happened. High void rates usually mean training gaps or entry mistakes" width={260}>Voided Value</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-red)' }}>{fmtNpr(totals.void.amt)}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{totals.void.n} order{totals.void.n !== 1 ? 's' : ''}</div>
            </div>
            <div className="card" style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="Food cost of complimentary orders and individually-comped items — valued at ingredient cost (not menu price), matching the Complimentary Slip" width={250}>Comp Food Cost</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-amber)' }}>{fmtNpr(totals.writeoff.amt)}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{totals.writeoff.n} comp{totals.writeoff.n !== 1 ? 's' : ''}</div>
            </div>
            <div className="card" style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="What every comped order/item would have sold for at menu price (incl. VAT) had it not been comped — the revenue given away, not just its ingredient cost" width={280}>Comp Potential Sales Value</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-amber)' }}>{fmtNpr(totals.writeoff.potential)}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{totals.writeoff.n} comp{totals.writeoff.n !== 1 ? 's' : ''}</div>
            </div>
            <div className="card" style={{ padding: '14px 18px' }}>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                <Tip text="A quiet report is a healthy one — lots of exceptions usually signal training gaps or permission creep" width={240}>Total Exceptions</Tip>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>{rows.length}</div>
              <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{fmtNpr(totals.discount.amt + totals.void.amt + totals.writeoff.amt)} total</div>
            </div>
          </div>

          {/* Per-staff rollup */}
          {staffRows.length > 0 && (
            <>
              <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                By Staff Member <Tip text="Who is closing the exceptions — one cashier discounting far more than everyone else is worth a conversation">ⓘ</Tip>
              </p>
              <div className="table-wrap" style={{ marginBottom: 24 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Staff</th>
                      <th style={{ textAlign: 'right' }}>Discounts</th>
                      <th style={{ textAlign: 'right' }}>Voids</th>
                      <th style={{ textAlign: 'right' }}>Comps</th>
                      <th style={{ textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {staffRows.map(([id, s]) => (
                      <tr key={id}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{staffNames[id] || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{s.discount.n > 0 ? `${s.discount.n} · ${fmtNpr(s.discount.amt)}` : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{s.void.n > 0 ? `${s.void.n} · ${fmtNpr(s.void.amt)}` : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{s.writeoff.n > 0 ? `${s.writeoff.n} · ${fmtNpr(s.writeoff.amt)}` : '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(s.total)}</td>
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
              No exceptions in this range — a quiet report is a healthy one. 🎉
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
                      <Tip text="Discounts: the amount knocked off. Voids: menu value forgone (incl. VAT). Comps: food cost of what was served" width={260}>Amount</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Comps only — what this would have sold for at menu price (incl. VAT) had it not been comped" width={260}>Potential Value</Tip>
                    </th>
                    <th>Closed By</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const bs = r.closed_at ? adToBs(new Date(r.closed_at)) : null
                    return (
                      <tr key={r.id} onClick={() => viewPosBill(clientId, r)} style={{ cursor: 'pointer' }}>
                        <td>
                          {bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]}` : '—'}
                          <span style={{ color: 'var(--theme-text3)', fontSize: 11, marginLeft: 6 }}>
                            {r.closed_at ? new Date(r.closed_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : ''}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                          {invoiceLabel(r, vatReg, prefix)}
                          {r.isItemComp && r.parentInvoiceNo != null && (
                            <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--theme-text3)' }}>
                              on {invoiceLabel({ invoice_no: r.parentInvoiceNo, invoice_fy: r.parentInvoiceFy, close_type: 'paid', order_no: r.order_no }, vatReg, prefix)}
                            </div>
                          )}
                        </td>
                        <td>{r.table_name || 'Takeaway'}</td>
                        <td><span className={TYPE_META[r.type].badge} style={{ fontSize: 11 }}>{TYPE_META[r.type].label}</span></td>
                        <td>{r.reason}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtNpr(r.amount)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{r.type === 'writeoff' ? fmtNpr(r.potentialValue) : '—'}</td>
                        <td>{staffNames[r.closed_by] || '—'}</td>
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
