import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../../../components/Tip'
import { printWithTitle } from '../../../utils/printTitle'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const VAT_RATE = 0.13

function fmtNPR(n) {
  return `NPR ${Number(n).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function buildVendorSummary(vatEntries, returns, billGroups) {
  const map = {}
  vatEntries.forEach(e => {
    const key  = e.vendor_id || '__unknown__'
    const name = e.vendors?.name || 'Unknown Vendor'
    const pan  = e.vendors?.pan_vat_no || ''
    if (!map[key]) map[key] = { name, pan, count: 0, gross: 0, discount: 0, returned: 0 }
    map[key].count += 1
    map[key].gross += e.qty * e.rate
  })
  // Prorate bill-level discount to each VAT entry's vendor
  Object.values(billGroups).forEach(bill => {
    if (!bill.disc) return
    const billTotal = bill.all.reduce((s, e) => s + e.qty * e.rate, 0)
    const vatItems  = bill.all.filter(e => e.vat_inclusive)
    const vatBase   = vatItems.reduce((s, e) => s + e.qty * e.rate, 0)
    const vatDisc   = billTotal > 0 ? bill.disc * (vatBase / billTotal) : 0
    vatItems.forEach(e => {
      const key = e.vendor_id || '__unknown__'
      if (!map[key]) return
      map[key].discount += vatBase > 0 ? vatDisc * ((e.qty * e.rate) / vatBase) : 0
    })
  })
  returns.forEach(r => {
    const key  = r.vendor_id || '__unknown__'
    const name = r.vendors?.name || 'Unknown Vendor'
    const pan  = r.vendors?.pan_vat_no || ''
    if (!map[key]) map[key] = { name, pan, count: 0, gross: 0, discount: 0, returned: 0 }
    map[key].returned += r.qty * r.rate
  })
  return Object.values(map).sort((a, b) => (b.gross - b.returned) - (a.gross - a.returned))
}

export default function VatReport() {
  const { clientId, profile } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [entries, setEntries]         = useState([])
  const [vatReturns, setVatReturns]   = useState([])
  const [loading, setLoading]         = useState(false)
  const [tab, setTab]                 = useState('entries')

  useEffect(() => {
    if (!effectiveClientId) return
    supabase.from('monthly_periods')
      .select('*').eq('client_id', effectiveClientId)
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data }) => {
        setPeriods(data || [])
        if (data && data.length > 0) setSelected(data[0])
      })
  }, [effectiveClientId])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchData(periodId) {
    setLoading(true)
    const [{ data: entData }, { data: retData }] = await Promise.all([
      supabase
        .from('purchase_entries')
        .select('*, items(name, uom, categories(name)), vendors(name, pan_vat_no)')
        .eq('period_id', periodId)
        .order('bs_day')
        .order('created_at'),
      supabase
        .from('vendor_returns')
        .select('*, items(name, uom, categories(name)), vendors(name, pan_vat_no), purchase_entries(vat_inclusive)')
        .eq('period_id', periodId)
        .order('bs_day'),
    ])
    setEntries(entData || [])
    setVatReturns((retData || []).filter(r => r.purchase_entries?.vat_inclusive))
    setLoading(false)
  }

  const vatEntries    = entries.filter(e => e.vat_inclusive)
  const nonVatEntries = entries.filter(e => !e.vat_inclusive)

  // Bill groups — needed to prorate bill-level discount to VAT entries
  const billGroups = {}
  entries.forEach(e => {
    const gid = e.purchase_group_id || e.id
    if (!billGroups[gid]) billGroups[gid] = { all: [], disc: parseFloat(e.discount_amount) || 0 }
    billGroups[gid].all.push(e)
  })
  const totalVatDiscount = Object.values(billGroups).reduce((sum, bill) => {
    if (!bill.disc) return sum
    const billTotal = bill.all.reduce((s, e) => s + e.qty * e.rate, 0)
    const vatBase   = bill.all.filter(e => e.vat_inclusive).reduce((s, e) => s + e.qty * e.rate, 0)
    return sum + (billTotal > 0 ? bill.disc * (vatBase / billTotal) : 0)
  }, 0)

  // Purchases — discount applied before VAT (per Nepal IRD: VAT is on net taxable amount)
  const nonVatTotal    = nonVatEntries.reduce((s, e) => s + e.qty * e.rate, 0)
  const vatBaseList    = vatEntries.reduce((s, e) => s + e.qty * e.rate, 0)   // list price, pre-discount
  const vatBaseGross   = vatBaseList - totalVatDiscount                        // taxable base after discount
  const vatAmtGross    = vatBaseGross * VAT_RATE
  const vatTotalGross  = vatBaseGross * (1 + VAT_RATE)

  // Returns (VAT-inclusive only)
  const retBaseTotal   = vatReturns.reduce((s, r) => s + r.qty * r.rate, 0)
  const retVatTotal    = retBaseTotal * VAT_RATE
  const retTotal       = retBaseTotal * (1 + VAT_RATE)

  // Net
  const netVatBase     = vatBaseGross - retBaseTotal
  const netVatAmt      = netVatBase * VAT_RATE
  const netVatTotal    = netVatBase * (1 + VAT_RATE)
  const totalNet       = nonVatTotal + netVatTotal

  const vendorRows  = buildVendorSummary(vatEntries, vatReturns, billGroups)
  const periodLabel = (p) => p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : ''

  function exportExcel() {
    const wb = XLSX.utils.book_new()

    // VAT Purchases sheet
    const entryRows = vatEntries.map(e => {
      const base  = e.qty * e.rate
      const vat   = base * VAT_RATE
      return {
        'Day':               e.bs_day,
        'Item':              e.items?.name || '',
        'Category':          e.items?.categories?.name || '',
        'Vendor':            e.vendors?.name || '',
        'PAN/VAT No.':       e.vendors?.pan_vat_no || '',
        'Qty':               Number(e.qty),
        'UOM':               e.items?.uom || '',
        'Base (ex-VAT)':     Number(base.toFixed(2)),
        'VAT (13%)':         Number(vat.toFixed(2)),
        'Total (incl. VAT)': Number((base + vat).toFixed(2)),
        'Invoice Ref':       e.invoice_ref || '',
      }
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entryRows), 'VAT Purchases')

    // VAT Returns sheet
    if (vatReturns.length > 0) {
      const retRows = vatReturns.map(r => {
        const base = r.qty * r.rate
        const vat  = base * VAT_RATE
        return {
          'Day':                  r.bs_day,
          'Item':                 r.items?.name || '',
          'Category':             r.items?.categories?.name || '',
          'Vendor':               r.vendors?.name || '',
          'PAN/VAT No.':          r.vendors?.pan_vat_no || '',
          'Returned Qty':         Number(r.qty),
          'UOM':                  r.items?.uom || '',
          'Base Returned (ex-VAT)':  Number(base.toFixed(2)),
          'VAT Reversed (13%)':      Number(vat.toFixed(2)),
          'Total Returned (incl. VAT)': Number((base + vat).toFixed(2)),
          'Notes':                r.notes || '',
        }
      })
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(retRows), 'VAT Returns')
    }

    // CA Summary sheet
    const caRows = vendorRows.map(v => {
      const grossBase  = v.gross
      const discBase   = v.discount || 0
      const taxBase    = grossBase - discBase
      const retBase    = v.returned
      const netBase    = taxBase - retBase
      return {
        'Vendor':                    v.name,
        'PAN/VAT No.':               v.pan,
        '# Bills':                   v.count,
        'Gross Base (ex-VAT)':       Number(grossBase.toFixed(2)),
        'Trade Discount':            discBase > 0 ? Number((-discBase).toFixed(2)) : 0,
        'Taxable Base (ex-VAT)':     Number(taxBase.toFixed(2)),
        'Returned Base (ex-VAT)':    Number(retBase.toFixed(2)),
        'Net Taxable (ex-VAT)':      Number(netBase.toFixed(2)),
        'Net Input VAT (13%)':       Number((netBase * VAT_RATE).toFixed(2)),
        'Net Total (incl. VAT)':     Number((netBase * (1 + VAT_RATE)).toFixed(2)),
      }
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(caRows), 'CA Summary')

    XLSX.writeFile(wb, `VAT-Report-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">VAT Report</h1>
          <p className="page-subtitle">Input VAT summary on purchases — {periodLabel(selectedPeriod)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => <option key={p.id} value={p.id}>{periodLabel(p)}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={() => printWithTitle(`VAT Report - ${periodLabel(selectedPeriod)}`)}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={!vatEntries.length}>Export Excel</button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Total net purchases this period (non-VAT + VAT-inclusive net of returns)." width={240}>Total Net Purchases</Tip></div>
          <div className="stat-value gold" style={{ fontSize: 16 }}>NPR {Math.round(totalNet).toLocaleString('en-NP')}</div>
          <div className="stat-sub">{entries.length} purchase entries</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Non-VAT Purchases</div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-text1)' }}>NPR {Math.round(nonVatTotal).toLocaleString('en-NP')}</div>
          <div className="stat-sub">{nonVatEntries.length} entries</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Gross VAT-inclusive purchases minus VAT-inclusive returns (incl. VAT)." width={260}>Net VAT Purchases</Tip></div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-amber)' }}>NPR {Math.round(netVatTotal).toLocaleString('en-NP')}</div>
          <div className="stat-sub">
            {vatEntries.length} purchases
            {vatReturns.length > 0 && <span style={{ color: 'var(--theme-red)' }}> − {vatReturns.length} returns</span>}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Net input VAT claimable = (Gross VAT purchases − VAT returns) × 13%. Use this for your IRD VAT return." width={270}>Net Input VAT (13%)</Tip></div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-green)' }}>NPR {Math.round(netVatAmt).toLocaleString('en-NP')}</div>
          <div className="stat-sub">
            {vatReturns.length > 0
              ? <span>Gross {fmtNPR(vatAmtGross)} − {fmtNPR(retVatTotal)}</span>
              : 'Claimable input tax'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Net cost basis excluding VAT — actual expense recorded for accounting." width={230}>Net (ex-VAT)</Tip></div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-text1)' }}>NPR {Math.round(nonVatTotal + netVatBase).toLocaleString('en-NP')}</div>
          <div className="stat-sub">Actual cost basis</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="tab-bar" style={{ marginBottom: 20 }}>
        <button className={`tab-btn${tab === 'entries' ? ' tab-btn--active' : ''}`} onClick={() => setTab('entries')}>Entries</button>
        <button className={`tab-btn${tab === 'ca' ? ' tab-btn--active' : ''}`} onClick={() => setTab('ca')}>CA Summary</button>
      </div>

      {/* ── ENTRIES TAB ── */}
      {tab === 'entries' && (
        <>
          {/* Purchases */}
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--theme-text1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>VAT-Inclusive Purchases</span>
              {!loading && <span style={{ fontSize: 12, color: 'var(--theme-text2)', fontWeight: 400 }}>{vatEntries.length} of {entries.length} entries</span>}
            </h3>
            {loading ? (
              <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
            ) : vatEntries.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">₨</div>
                <p className="empty-state-text">No VAT-inclusive purchases this period. Tick "VAT Incl. (13%)" when adding purchases.</p>
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
                      <th style={{ textAlign: 'right' }}><Tip text="Net cost before VAT — the rate you entered × qty.">Base (ex-VAT)</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-amber)' }}><Tip text="Input VAT = Base × 13%. Claimable as input tax credit from IRD." width={220}>VAT (13%)</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Actual amount paid = Base + VAT (Base × 1.13).">Total (incl. VAT)</Tip></th>
                      <th>Invoice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vatEntries.map(e => {
                      const base  = e.qty * e.rate
                      const vat   = base * VAT_RATE
                      const total = base + vat
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
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(base)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-amber)', fontWeight: 600 }}>{fmtNPR(vat)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>{fmtNPR(total)}</td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{e.invoice_ref || '—'}</td>
                        </tr>
                      )
                    })}
                    <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                      <td colSpan={6} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>GROSS TOTALS</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(vatBaseList)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-amber)' }}>{fmtNPR(vatBaseList * VAT_RATE)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>{fmtNPR(vatBaseList * (1 + VAT_RATE))}</td>
                      <td></td>
                    </tr>
                    {totalVatDiscount > 0 && <>
                      <tr>
                        <td colSpan={6} style={{ color: 'var(--theme-red)', fontSize: 12 }}>Trade Discount</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>−{fmtNPR(totalVatDiscount)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>−{fmtNPR(totalVatDiscount * VAT_RATE)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>−{fmtNPR(totalVatDiscount * (1 + VAT_RATE))}</td>
                        <td></td>
                      </tr>
                      <tr style={{ fontWeight: 700, background: 'rgba(201,168,76,0.05)' }}>
                        <td colSpan={6} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>TAXABLE TOTALS</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(vatBaseGross)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-amber)' }}>{fmtNPR(vatAmtGross)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>{fmtNPR(vatTotalGross)}</td>
                        <td></td>
                      </tr>
                    </>}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* VAT Returns */}
          {vatReturns.length > 0 && (
            <div className="card" style={{ marginBottom: 16, border: '1px solid rgba(248,113,113,0.2)' }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--theme-red)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>VAT-Inclusive Returns <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text2)', marginLeft: 8 }}>Input VAT reversed on returned goods</span></span>
                <span style={{ fontSize: 12, color: 'var(--theme-text2)', fontWeight: 400 }}>{vatReturns.length} return{vatReturns.length !== 1 ? 's' : ''}</span>
              </h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Item</th>
                      <th>Category</th>
                      <th>Vendor</th>
                      <th style={{ textAlign: 'right' }}>Returned Qty</th>
                      <th>UOM</th>
                      <th style={{ textAlign: 'right' }}>Base Returned</th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-red)' }}>VAT Reversed</th>
                      <th style={{ textAlign: 'right' }}>Total Returned</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vatReturns.map(r => {
                      const base  = r.qty * r.rate
                      const vat   = base * VAT_RATE
                      const total = base + vat
                      return (
                        <tr key={r.id}>
                          <td style={{ color: 'var(--theme-accent)', fontWeight: 700 }}>{r.bs_day}</td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.items?.name}</td>
                          <td>
                            {r.items?.categories?.name
                              ? <span className="badge badge-yellow">{r.items.categories.name}</span>
                              : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                          </td>
                          <td style={{ color: 'var(--theme-text2)' }}>{r.vendors?.name || '—'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>−{Number(r.qty).toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
                          <td style={{ color: 'var(--theme-text2)' }}>{r.items?.uom}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>−{fmtNPR(base)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red)', fontWeight: 600 }}>−{fmtNPR(vat)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red)', fontWeight: 600 }}>−{fmtNPR(total)}</td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{r.notes || '—'}</td>
                        </tr>
                      )
                    })}
                    <tr style={{ borderTop: '2px solid rgba(248,113,113,0.3)', fontWeight: 700 }}>
                      <td colSpan={6} style={{ color: 'var(--theme-red)', fontSize: 12 }}>TOTAL RETURNS</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>−{fmtNPR(retBaseTotal)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>−{fmtNPR(retVatTotal)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red)' }}>−{fmtNPR(retTotal)}</td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Net row */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 40, marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--theme-border)' }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 2 }}>Net Base (ex-VAT)</div>
                  <div style={{ fontWeight: 700, color: 'var(--theme-text1)' }}>{fmtNPR(netVatBase)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 2 }}>Net Input VAT (13%)</div>
                  <div style={{ fontWeight: 700, color: 'var(--theme-green)', fontSize: 15 }}>{fmtNPR(netVatAmt)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 2 }}>Net (incl. VAT)</div>
                  <div style={{ fontWeight: 700, color: 'var(--theme-accent)', fontSize: 15 }}>{fmtNPR(netVatTotal)}</div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── CA SUMMARY TAB ── */}
      {tab === 'ca' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14, color: 'var(--theme-text1)' }}>Vendor-wise VAT Summary</h3>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                Grouped by supplier — share with your CA for input VAT reconciliation
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
              <p className="empty-state-text">No VAT-inclusive purchases this period.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th><Tip text="PAN or VAT registration number of the supplier — add it in Vendors if missing.">PAN / VAT No.</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Number of VAT-inclusive purchase entries from this vendor."># Bills</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Gross purchases at list price before trade discount, ex-VAT.">Gross Base</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red)' }}><Tip text="Trade/promo discount from the vendor, prorated to VAT items. Reduces the taxable base." width={260}>Discount</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Taxable base = Gross − Discount. VAT is levied on this amount per Nepal IRD." width={240}>Taxable Base</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red)' }}><Tip text="Base amount of VAT-inclusive goods returned to this vendor." width={230}>Returned</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Net taxable = Taxable Base − Returns, ex-VAT.">Net Taxable</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-amber)' }}><Tip text="Net claimable input VAT = Net Taxable × 13%. Use for IRD VAT return." width={230}>Net Input VAT</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Net amount paid to this vendor including VAT, after discount and returns.">Net Total</Tip></th>
                  </tr>
                </thead>
                <tbody>
                  {vendorRows.map((v, i) => {
                    const disc     = v.discount || 0
                    const taxBase  = v.gross - disc
                    const netBase  = taxBase - v.returned
                    const netVat   = netBase * VAT_RATE
                    const netTotal = netBase * (1 + VAT_RATE)
                    return (
                      <tr key={i}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{v.name}</td>
                        <td style={{ color: v.pan ? 'var(--theme-text3)' : 'var(--theme-red)', fontSize: 12 }}>
                          {v.pan || <span style={{ fontStyle: 'italic' }}>Missing — add in Vendors</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{v.count}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtNPR(v.gross)}</td>
                        <td style={{ textAlign: 'right', color: disc > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
                          {disc > 0 ? `−${fmtNPR(disc)}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtNPR(taxBase)}</td>
                        <td style={{ textAlign: 'right', color: v.returned > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
                          {v.returned > 0 ? `−${fmtNPR(v.returned)}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 600 }}>{fmtNPR(netBase)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-amber)', fontWeight: 600 }}>{fmtNPR(netVat)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>{fmtNPR(netTotal)}</td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                    <td colSpan={3} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>PERIOD NET</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtNPR(vatBaseList)}</td>
                    <td style={{ textAlign: 'right', color: totalVatDiscount > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
                      {totalVatDiscount > 0 ? `−${fmtNPR(totalVatDiscount)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtNPR(vatBaseGross)}</td>
                    <td style={{ textAlign: 'right', color: retBaseTotal > 0 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
                      {retBaseTotal > 0 ? `−${fmtNPR(retBaseTotal)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(netVatBase)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-amber)' }}>{fmtNPR(netVatAmt)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>{fmtNPR(netVatTotal)}</td>
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
