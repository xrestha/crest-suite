import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'
import { printWithTitle } from '../../../utils/printTitle'
import { Navigate } from 'react-router-dom'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

function fmtNPR(n) {
  return `NPR ${Number(n).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function buildVendorSummary(entries) {
  const map = {}
  const billDiscounts = {}
  entries.forEach(e => {
    const gid = e.purchase_group_id || e.id
    if (!billDiscounts[gid]) billDiscounts[gid] = { disc: parseFloat(e.discount_amount) || 0, vendorKey: e.vendor_id || '__unknown__' }
    const key  = e.vendor_id || '__unknown__'
    const name = e.vendors?.name || 'Unknown Vendor'
    const pan  = e.vendors?.pan_vat_no || ''
    if (!map[key]) map[key] = { name, pan, count: 0, gross: 0, discount: 0 }
    map[key].count += 1
    map[key].gross += e.qty * e.rate
  })
  Object.values(billDiscounts).forEach(({ disc, vendorKey }) => {
    if (map[vendorKey]) map[vendorKey].discount += disc
  })
  return Object.values(map).sort((a, b) => (b.gross - b.discount) - (a.gross - a.discount))
}

export default function NonVatReport() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [entries, setEntries]         = useState([])
  const [loading, setLoading]         = useState(false)
  const [tab, setTab]                 = useState('entries')

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data }) => {
        setPeriods(data || [])
        if (data && data.length > 0) setSelected(data[0])
      })
  }, [effectiveClientId, scopedFrom])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchData(periodId) {
    setLoading(true)
    const { data } = await supabase
      .from('purchase_entries')
      .select('*, items(name, uom, categories(name)), vendors(name, pan_vat_no)')
      .eq('period_id', periodId)
      .eq('vat_inclusive', false)
      .order('bs_day')
      .order('created_at')
    setEntries(data || [])
    setLoading(false)
  }

  const grossTotal    = entries.reduce((s, e) => s + e.qty * e.rate, 0)
  const billDiscounts = {}
  entries.forEach(e => {
    const gid = e.purchase_group_id || e.id
    if (!billDiscounts[gid]) billDiscounts[gid] = parseFloat(e.discount_amount) || 0
  })
  const totalDiscount = Object.values(billDiscounts).reduce((s, d) => s + d, 0)
  const total         = grossTotal - totalDiscount
  const uniqueVendors = new Set(entries.map(e => e.vendors?.name).filter(Boolean)).size
  const avgPerEntry   = entries.length ? total / entries.length : 0

  const vendorRows = buildVendorSummary(entries)

  const periodLabel = (p) => p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : ''

  function exportExcel() {
    const wb = XLSX.utils.book_new()

    // Entries sheet
    const entryRows = entries.map(e => ({
      'Day':         e.bs_day,
      'Item':        e.items?.name || '',
      'Category':    e.items?.categories?.name || '',
      'Vendor':      e.vendors?.name || '',
      'PAN/VAT No.': e.vendors?.pan_vat_no || '',
      'Qty':         Number(e.qty),
      'UOM':         e.items?.uom || '',
      'Rate':        Number(e.rate),
      'Total (NPR)': Number((e.qty * e.rate).toFixed(2)),
      'Invoice Ref': e.invoice_ref || '',
      'Notes':       e.notes || '',
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entryRows), 'Non-VAT Entries')

    // CA Summary sheet
    const caRows = vendorRows.map(v => ({
      'Vendor':        v.name,
      'PAN/VAT No.':   v.pan,
      '# Bills':       v.count,
      'Gross (NPR)':   Number(v.gross.toFixed(2)),
      'Discount (NPR)':Number(v.discount.toFixed(2)),
      'Net (NPR)':     Number((v.gross - v.discount).toFixed(2)),
      'VAT Credit':    'NIL',
    }))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(caRows), 'CA Summary')

    XLSX.writeFile(wb, `Non-VAT-Report-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Non-VAT Report</h1>
          <p className="page-subtitle">Purchases without VAT this period — {periodLabel(selectedPeriod)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => <option key={p.id} value={p.id}>{periodLabel(p)}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={() => printWithTitle(`Non-VAT Report - ${periodLabel(selectedPeriod)}`)}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={!entries.length}>Export Excel</button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Net value of all non-VAT purchases this period (after any bill-level discounts).">Total Non-VAT Purchases</Tip>
          </div>
          <div className="stat-value gold" style={{ fontSize: 16 }}>NPR {Math.round(total).toLocaleString('en-NP')}</div>
          <div className="stat-sub">{entries.length} entr{entries.length !== 1 ? 'ies' : 'y'}{totalDiscount > 0 ? ` · −NPR ${Math.round(totalDiscount).toLocaleString('en-NP')} disc.` : ''}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Number of distinct vendors supplying non-VAT goods this period.">Vendors</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 22 }}>{uniqueVendors}</div>
          <div className="stat-sub">unique suppliers</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Average value per non-VAT purchase entry this period.">Avg per Entry</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-text1)' }}>NPR {Math.round(avgPerEntry).toLocaleString('en-NP')}</div>
          <div className="stat-sub">per line item</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="These purchases carry no input VAT credit — the full amount is a direct cost with no tax recovery.">Input VAT Credit</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 22, color: 'var(--theme-red)' }}>NIL</div>
          <div className="stat-sub">no tax credit claimable</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tab-bar" style={{ marginBottom: 20 }}>
        <button className={`tab-btn${tab === 'entries' ? ' tab-btn--active' : ''}`} onClick={() => setTab('entries')}>Entries</button>
        <button className={`tab-btn${tab === 'ca' ? ' tab-btn--active' : ''}`} onClick={() => setTab('ca')}>CA Summary</button>
      </div>

      {/* ── ENTRIES TAB ── */}
      {tab === 'entries' && (
        <div className="card">
          <h3 style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--theme-text1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Non-VAT Purchase Entries</span>
            {!loading && <span style={{ fontSize: 12, color: 'var(--theme-text2)', fontWeight: 400 }}>{entries.length} entries</span>}
          </h3>
          {loading ? (
            <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
          ) : entries.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">₨</div>
              <p className="empty-state-text">No non-VAT purchases this period. Bills with the VAT toggle off will appear here.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Item</th>
                    <th>Category</th>
                    <th>Vendor</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th>UOM</th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Rate per UOM as entered on the purchase.">Rate</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Total = Qty × Rate. No VAT included — this is the full cost.">Total (NPR)</Tip>
                    </th>
                    <th>Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(e => {
                    const rowTotal = e.qty * e.rate
                    return (
                      <tr key={e.id}>
                        <td style={{ color: 'var(--theme-accent)', fontWeight: 700 }}>{e.bs_day}</td>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{e.items?.name}</td>
                        <td>
                          {e.items?.categories?.name
                            ? <span className="badge badge-yellow">{e.items.categories.name}</span>
                            : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                        </td>
                        <td style={{ color: 'var(--theme-text2)' }}>{e.vendors?.name || '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{Number(e.qty).toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
                        <td style={{ color: 'var(--theme-text2)' }}>{e.items?.uom}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmtNPR(e.rate)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>{fmtNPR(rowTotal)}</td>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{e.invoice_ref || '—'}</td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                    <td colSpan={7} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>TOTAL</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>{fmtNPR(total)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── CA SUMMARY TAB ── */}
      {tab === 'ca' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14, color: 'var(--theme-text1)' }}>Vendor-wise Non-VAT Summary</h3>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                Grouped by supplier — share with your CA for expense reconciliation
              </p>
            </div>
            <span style={{ fontSize: 11, color: 'var(--theme-text2)', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--theme-border)', borderRadius: 4, padding: '3px 8px' }}>
              For reference only — verify bills with your CA before filing
            </span>
          </div>

          {loading ? (
            <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
          ) : vendorRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">₨</div>
              <p className="empty-state-text">No non-VAT purchases this period.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th><Tip text="PAN or VAT registration number of the supplier — add it in Vendors if missing.">PAN / VAT No.</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Number of non-VAT purchase entries from this vendor this period."># Bills</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Gross purchase amount before any bill-level discount.">Gross (NPR)</Tip></th>
                    {totalDiscount > 0 && <th style={{ textAlign: 'right' }}><Tip text="Bill-level discount given by this vendor.">Discount</Tip></th>}
                    <th style={{ textAlign: 'right' }}><Tip text="Net amount after discount — no VAT was charged by this supplier.">Net (NPR)</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="No input VAT credit is claimable on non-VAT purchases." width={220}>VAT Credit</Tip></th>
                  </tr>
                </thead>
                <tbody>
                  {vendorRows.map((v, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{v.name}</td>
                      <td style={{ color: v.pan ? 'var(--theme-text3)' : 'var(--theme-red)', fontSize: 12 }}>
                        {v.pan || <span style={{ fontStyle: 'italic' }}>Missing — add in Vendors</span>}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{v.count}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmtNPR(v.gross)}</td>
                      {totalDiscount > 0 && <td style={{ textAlign: 'right', color: 'var(--theme-red)', fontSize: 12 }}>{v.discount > 0 ? `− ${fmtNPR(v.discount)}` : '—'}</td>}
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>{fmtNPR(v.gross - v.discount)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red)', fontWeight: 500 }}>NIL</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                    <td colSpan={3} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>PERIOD TOTAL</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmtNPR(grossTotal)}</td>
                    {totalDiscount > 0 && <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>− {fmtNPR(totalDiscount)}</td>}
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>{fmtNPR(total)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>NIL</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
