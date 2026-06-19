import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import * as XLSX from 'xlsx'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const VAT_RATE = 0.13

function fmtNPR(n) {
  return `NPR ${Number(n).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function buildVendorSummary(entries) {
  const map = {}
  entries.forEach(e => {
    const key  = e.vendor_id || '__unknown__'
    const name = e.vendors?.name || 'Unknown Vendor'
    const pan  = e.vendors?.pan_vat_no || ''
    if (!map[key]) map[key] = { name, pan, count: 0, total: 0 }
    map[key].count += 1
    map[key].total += e.qty * e.rate
  })
  return Object.values(map).sort((a, b) => b.total - a.total)
}

export default function VatReport() {
  const { clientId } = useAuth()
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [entries, setEntries]         = useState([])
  const [loading, setLoading]         = useState(false)
  const [tab, setTab]                 = useState('entries')

  useEffect(() => {
    if (!clientId) return
    supabase.from('monthly_periods')
      .select('*').eq('client_id', clientId)
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data }) => {
        setPeriods(data || [])
        if (data && data.length > 0) setSelected(data[0])
      })
  }, [clientId])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchData(periodId) {
    setLoading(true)
    const { data } = await supabase
      .from('purchase_entries')
      .select('*, items(name, uom, categories(name)), vendors(name, pan_vat_no)')
      .eq('period_id', periodId)
      .order('bs_day')
      .order('created_at')
    setEntries(data || [])
    setLoading(false)
  }

  const vatEntries   = entries.filter(e => e.vat_inclusive)
  const allEntries   = entries

  const totalPurchases = allEntries.reduce((s, e) => s + e.qty * e.rate, 0)
  const vatableTotal   = vatEntries.reduce((s, e) => s + e.qty * e.rate, 0)
  const vatBaseTotal   = vatableTotal / (1 + VAT_RATE)
  const vatAmountTotal = vatableTotal - vatBaseTotal
  const nonVatTotal    = totalPurchases - vatableTotal

  const vendorRows = buildVendorSummary(vatEntries)

  const periodLabel = (p) => p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : ''

  function exportExcel() {
    const wb = XLSX.utils.book_new()

    // Entries sheet
    const entryRows = vatEntries.map(e => {
      const total = e.qty * e.rate
      const base  = total / (1 + VAT_RATE)
      return {
        'Day':            e.bs_day,
        'Item':           e.items?.name || '',
        'Category':       e.items?.categories?.name || '',
        'Vendor':         e.vendors?.name || '',
        'PAN/VAT No.':    e.vendors?.pan_vat_no || '',
        'Qty':            Number(e.qty),
        'UOM':            e.items?.uom || '',
        'Total (incl. VAT)': Number(total.toFixed(2)),
        'Base (ex-VAT)':     Number(base.toFixed(2)),
        'VAT (13%)':         Number((total - base).toFixed(2)),
        'Invoice Ref':    e.invoice_ref || '',
      }
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entryRows), 'VAT Entries')

    // CA Summary sheet
    const caRows = vendorRows.map(v => ({
      'Vendor':          v.name,
      'PAN/VAT No.':     v.pan,
      '# Bills':         v.count,
      'Total (incl. VAT)': Number(v.total.toFixed(2)),
      'Base (ex-VAT)':     Number((v.total / (1 + VAT_RATE)).toFixed(2)),
      'Input VAT (13%)':   Number((v.total - v.total / (1 + VAT_RATE)).toFixed(2)),
    }))
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
          <button className="btn btn-ghost" onClick={() => window.print()}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={!vatEntries.length}>Export Excel</button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Total Purchases</div>
          <div className="stat-value gold" style={{ fontSize: 16 }}>NPR {Math.round(totalPurchases).toLocaleString('en-NP')}</div>
          <div className="stat-sub">{allEntries.length} entries</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Non-VAT Purchases</div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-text1)' }}>NPR {Math.round(nonVatTotal).toLocaleString('en-NP')}</div>
          <div className="stat-sub">{allEntries.length - vatEntries.length} entries</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">VAT-Inclusive Purchases</div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-amber)' }}>NPR {Math.round(vatableTotal).toLocaleString('en-NP')}</div>
          <div className="stat-sub">{vatEntries.length} entries</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Input VAT (13%)</div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-green)' }}>NPR {Math.round(vatAmountTotal).toLocaleString('en-NP')}</div>
          <div className="stat-sub">Claimable input tax</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Net (ex-VAT)</div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-text1)' }}>NPR {Math.round(nonVatTotal + vatBaseTotal).toLocaleString('en-NP')}</div>
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
        <div className="card">
          <h3 style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--theme-text1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>VAT-Inclusive Entries</span>
            {!loading && <span style={{ fontSize: 12, color: 'var(--theme-text2)', fontWeight: 400 }}>{vatEntries.length} of {allEntries.length} entries</span>}
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
                    <th style={{ textAlign: 'right' }}><Tip text="Total amount as entered — including the 13% VAT amount.">Total (incl. VAT)</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Net cost before VAT = Total ÷ 1.13. This is your actual expense for accounting.">Base (ex-VAT)</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-amber)' }}><Tip text="Input VAT = Total − Base. Claimable as input tax credit from IRD." width={220}>VAT (13%)</Tip></th>
                    <th>Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {vatEntries.map(e => {
                    const total = e.qty * e.rate
                    const base  = total / (1 + VAT_RATE)
                    const vat   = total - base
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
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>{fmtNPR(total)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(base)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-amber)', fontWeight: 600 }}>{fmtNPR(vat)}</td>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{e.invoice_ref || '—'}</td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                    <td colSpan={6} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>TOTALS</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>{fmtNPR(vatableTotal)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(vatBaseTotal)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-amber)' }}>{fmtNPR(vatAmountTotal)}</td>
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
                    <th style={{ textAlign: 'right' }}><Tip text="Number of VAT-inclusive purchase entries from this vendor this period."># Bills</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Total purchase amount including 13% VAT as entered.">Total (incl. VAT)</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Net cost before VAT = Total ÷ 1.13.">Base (ex-VAT)</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-amber)' }}><Tip text="Input VAT claimable = Total − Base. Use this figure for your IRD VAT return." width={220}>Input VAT (13%)</Tip></th>
                  </tr>
                </thead>
                <tbody>
                  {vendorRows.map((v, i) => {
                    const base = v.total / (1 + VAT_RATE)
                    const vat  = v.total - base
                    return (
                      <tr key={i}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{v.name}</td>
                        <td style={{ color: v.pan ? 'var(--theme-text3)' : 'var(--theme-red)', fontSize: 12 }}>
                          {v.pan || <span style={{ fontStyle: 'italic' }}>Missing — add in Vendors</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{v.count}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>{fmtNPR(v.total)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(base)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-amber)', fontWeight: 600 }}>{fmtNPR(vat)}</td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                    <td colSpan={3} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>PERIOD TOTAL</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>{fmtNPR(vatableTotal)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(vatBaseTotal)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-amber)' }}>{fmtNPR(vatAmountTotal)}</td>
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
