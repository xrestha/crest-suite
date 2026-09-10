import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { npr, NPR_LOCALE } from '../../../shared/nepalMoney'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import NoPeriodState from '../../../components/NoPeriodState'
import { printWithTitle } from '../../../utils/printTitle'
import { Navigate } from 'react-router-dom'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'

export default function WastageReport() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  const periodReq = useLatestRequest()
  const [periods, setPeriods]           = useState([])
  const [selectedPeriod, setSelected]   = useState(null)
  const [rows, setRows]                 = useState([])
  const [reasons, setReasons]           = useState([])
  const [catFilter, setCatFilter]       = useState('All')
  // Starts TRUE. It used to start false, so the first paint — before any read had been issued —
  // rendered the KPI strip as NPR 0 / 0 items above "No wastage entries for this period" (S594).
  const [loading, setLoading]           = useState(true)
  const [loadError, setLoadError]       = useState(null)

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data, error }) => {
        // A failed read is not "no periods yet" — surface it instead of rendering empty (S612 silent-zero rule).
        if (error) { setLoadError(error.message); setLoading(false); return }
        setPeriods(data || [])
        if (data?.length) setSelected(data[0])
        else setLoading(false)   // nothing will call fetchData, so nothing else clears it
      })
  }, [effectiveClientId, scopedFrom])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line

  async function fetchData(periodId) {
    periodReq.begin(periodId)   // claim the page before any await (S601)
    setLoading(true)
    setLoadError(null)
    // PAGED (S719). `wastages` is one row per item per DAY once Daily Wastage is used, which the
    // rules file names as the realistic 1000-crosser — and every OTHER page that reads this table
    // pages it. The report that exists to total the client's wastage was the one place that did
    // not, so past the cap its headline came back short, in confident type, with no error for the
    // check below to catch. `id` is the unique tiebreaker the paging needs to be stable.
    const { data, error } = await fetchAllRows(() => supabase
      .from('wastages')
      .select('item_id, qty, bs_day, reason, items(name, uom, per_uom_rate, categories(name))')
      .eq('period_id', periodId)
      .order('id'))
    // A failed read must never flow through the `|| []` below into a confident NPR-0 report (S612 silent-zero rule).
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    if (error) { setLoadError(error); setRows([]); setReasons([]); setLoading(false); return }

    // Aggregate by item — an item can now have many rows (monthly catch-all + dated daily entries).
    const byItem = {}
    const byReason = {}
    ;(data || []).forEach(r => {
      const qty = parseFloat(r.qty || 0)
      if (qty <= 0) return
      const rate  = parseFloat(r.items?.per_uom_rate || 0)
      const value = qty * rate
      if (!byItem[r.item_id]) {
        byItem[r.item_id] = {
          item_id: r.item_id, name: r.items?.name || '—',
          category: r.items?.categories?.name || 'Uncategorised',
          uom: r.items?.uom || '', rate, qty: 0, value: 0,
        }
      }
      byItem[r.item_id].qty   += qty
      byItem[r.item_id].value += value
      // Reason breakdown — undated catch-all rows have no reason.
      const reason = r.bs_day == null ? 'Monthly (untagged)' : (r.reason || 'Other')
      if (!byReason[reason]) byReason[reason] = { reason, qty: 0, value: 0 }
      byReason[reason].qty   += qty
      byReason[reason].value += value
    })

    setRows(Object.values(byItem).sort((a, b) => b.value - a.value))
    setReasons(Object.values(byReason).sort((a, b) => b.value - a.value))
    setCatFilter('All')
    setLoading(false)
  }

  const totalValue  = rows.reduce((s, r) => s + r.value, 0)
  const categories  = ['All', ...Array.from(new Set(rows.map(r => r.category))).sort()]
  const filtered    = catFilter === 'All' ? rows : rows.filter(r => r.category === catFilter)

  const catTotals = {}
  rows.forEach(r => { catTotals[r.category] = (catTotals[r.category] || 0) + r.value })
  const topCat = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0]

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : ''

  // Money goes through nepalMoney.js (S683), never a local toLocaleString.
  function fmt(n) {
    return n ? npr(n) : '—'
  }

  // A QUANTITY, not money — so it keeps its decimals. S719 rendered these through nprInt(), which
  // is `Math.round`, so 0.75 kg of wastage printed as "1" on the report whose entire job is saying
  // how much was thrown away. nepalMoney.js is for MONEY; the "render money through the shared
  // helper" rule does not extend to quantities. NPR_LOCALE keeps the Nepali digit grouping.
  function fmtQty(n) {
    return n ? Number(n).toLocaleString(NPR_LOCALE, { maximumFractionDigits: 3 }) : '—'
  }

  const scopeLine = `Wastage Report · ${periodLabel}${catFilter === 'All' ? '' : ` · ${catFilter}`}`

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb   = XLSX.utils.book_new()
    const data = rows.map(r => ({
      'Item':         r.name,
      'Category':     r.category,
      'UOM':          r.uom,
      'Qty Wasted':   r.qty || '',
      'Value (NPR)':  r.value ? r.value.toFixed(0) : '',
      '% of Total':   totalValue ? ((r.value / totalValue) * 100).toFixed(1) + '%' : '0%',
    }))
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Wastage Report', biz, scopeLine, rows: data,
      notes: ['Value = quantity wasted × the item\'s current per-unit rate, not the rate paid at the time.'],
    }), 'Wastage')
    if (reasons.length) {
      const rData = reasons.map(r => ({
        'Reason':      r.reason,
        'Qty':         r.qty || '',
        'Value (NPR)': r.value ? r.value.toFixed(0) : '',
        '% of Total':  totalValue ? ((r.value / totalValue) * 100).toFixed(1) + '%' : '0%',
      }))
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rData), 'By Reason')
    }
    XLSX.writeFile(wb, `Wastage-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read must not wear NoPeriodState (S612 silent-zero rule).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="the wastage report" />

  return (
    <div className="page-container">

      {/* Print-only header */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Wastage Report</h2>
        <div style={{ fontSize: 12 }}>{scopeLine}</div>
      </div>

      {/* Screen header */}
      <div className="page-header page-header--split no-print">
        <div>
          <h1 className="page-title">Wastage Report</h1>
          <p className="page-subtitle">Items logged as waste — quantity and NPR cost</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => (
              <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</option>
            ))}
          </select>
          <button className="btn btn-ghost" disabled={loading || !!loadError} onClick={() => printWithTitle(`Wastage Report — ${scopeLine}`)}>Print</button>
          <button className="btn btn-ghost" onClick={exportExcel} disabled={loading || !!loadError || !rows.length}>Export Excel</button>
        </div>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {!loadError && <>
      {/* Stat cards — gated on !loading: a figure summed from rows that have not arrived is NPR 0 in confident type (S594) */}
      {!loading && (
      <div className="stat-grid no-print">
        <div className="stat-card">
          <div className="stat-label">Total Wastage Value</div>
          <div className="stat-value" style={{ color: 'var(--theme-red-text)' }}>{fmt(totalValue)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Items with Wastage</div>
          <div className="stat-value">{rows.length}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top Wastage Category</div>
          <div className="stat-value" style={{ fontSize: 16 }}>{topCat ? topCat[0] : '—'}</div>
          {topCat && <div className="stat-label" style={{ marginTop: 4 }}>{fmt(topCat[1])}</div>}
        </div>
      </div>
      )}

      {/* By Reason breakdown */}
      {reasons.length > 0 && (
        <div className="card no-print" style={{ marginBottom: 20, padding: 0 }}>
          <div style={{ padding: '12px 16px', fontSize: 12, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            <Tip text="Wastage grouped by reason. Daily Wastage entries carry a reason; the monthly catch-all from the Wastage tab shows as “Monthly (untagged)”." width={280}>By Reason</Tip>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Reason</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Value (NPR)</th>
                  <th style={{ textAlign: 'right' }}>% of Total</th>
                </tr>
              </thead>
              <tbody>
                {reasons.map(r => (
                  <tr key={r.reason}>
                    <td><span className="badge badge-yellow">{r.reason}</span></td>
                    <td style={{ textAlign: 'right' }}>{fmtQty(r.qty)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{fmt(r.value)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{totalValue ? ((r.value / totalValue) * 100).toFixed(1) + '%' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Category filter tabs */}
      {categories.length > 2 && (
        <div className="tab-bar no-print" style={{ marginBottom: 16 }}>
          {categories.map(c => (
            <button key={c} className={`tab-btn${catFilter === c ? ' tab-btn--active' : ''}`} onClick={() => setCatFilter(c)}>{c}</button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty-state">No wastage entries for this period.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>UOM</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Total quantity logged as waste in the Wastage tab of Stock Count." width={220}>Qty Wasted</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Qty Wasted × per-unit rate. Represents the NPR cost of goods lost." width={240}>Value (NPR)</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="This item's wastage value as a % of total wastage value for the period." width={240}>% of Total</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.item_id}>
                  <td><strong>{r.name}</strong></td>
                  <td>{r.category}</td>
                  <td>{r.uom}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(r.qty)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{fmt(r.value)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                    {totalValue ? ((r.value / totalValue) * 100).toFixed(1) + '%' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={3}>Total ({filtered.length} items)</td>
                <td />
                <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{fmt(filtered.reduce((s, r) => s + r.value, 0))}</td>
                {/* Computed, never asserted. A hardcoded 100% is right only for as long as the
                    two sums stay identical, and it is exactly the shape that survives the change
                    that breaks it (S594's Supplier Contribution finding). */}
                <td style={{ textAlign: 'right' }}>
                  {totalValue ? ((filtered.reduce((s, r) => s + r.value, 0) / totalValue * 100).toFixed(1) + '%') : '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      </>}
    </div>
  )
}
