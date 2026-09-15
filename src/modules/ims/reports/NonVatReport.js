import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import { printWithTitle } from '../../../utils/printTitle'
import { BS_MONTHS, formatBsDay } from '../../../utils/bsCalendar'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { splitPurchaseVat, buildVendorSummary, summariseUnlinkedReturns } from './purchaseTaxSplit'

function fmtNPR(n) {
  return `NPR ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function NonVatReport() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  const periodReq = useLatestRequest()
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [allEntries, setAllEntries]   = useState([])
  const [returns, setReturns]         = useState([])
  const [loading, setLoading]         = useState(false)
  const [loadError, setLoadError]     = useState(null)
  const [tab, setTab]                 = useState('entries')

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      .then(({ data, error }) => {
        // A statutory report must never mistake a failed read for "no periods yet" — the figures
        // on this page are what gets filed with the IRD (S612, the silent-NPR-0 class).
        if (error) { setLoadError(error.message); return }
        setPeriods(data || [])
        if (data && data.length > 0) setSelected(data[0])
      })
  }, [effectiveClientId, scopedFrom])

  useEffect(() => {
    if (selectedPeriod) fetchData(selectedPeriod.id)
  }, [selectedPeriod]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchData(periodId) {
    periodReq.begin(periodId)   // claim the page before any await (S601)
    setLoading(true)
    // EVERY line of the period, not just `.eq('vat_inclusive', false)` — that filter is what broke
    // this page. `discount_amount` is a BILL-level figure, and a bill is routinely mixed, so a
    // query that can only see the non-VAT half of a bill cannot know what fraction of the discount
    // belongs to it and charged the whole thing here while VAT Report charged its share too. The
    // split now happens in splitPurchaseVat() over the whole bill (purchaseTaxSplit.js).
    //
    // Returns are joined back to purchase_entries so only NON-VAT returns are counted here —
    // vendor_returns has no vat_inclusive column of its own, and this report is the non-VAT half
    // of the filing. Mirrors VatReport, which selects purchase_entries(vat_inclusive) the same way.
    setLoadError(null)
    const results = await Promise.all([
      fetchAllRows(() => supabase
        .from('purchase_entries')
        .select('*, items(name, uom, categories(name)), vendors(name, pan_vat_no)')
        .eq('period_id', periodId)
        .order('bs_day')
        .order('created_at')
        .order('id')),
      // Paged like the purchases read: a silently truncated return list understates what was sent
      // back and overstates a figure that gets filed.
      fetchAllRows(() => scopedFrom('vendor_returns', '*, items(name, uom), vendors(name, pan_vat_no), purchase_entries(vat_inclusive)')
        .eq('period_id', periodId)
        .order('id')),
    ])
    // A failed read must never reach the arithmetic below: everything flows through `|| []`, so an
    // RLS rejection or a stalled token would render a complete, confident filing figure of NPR 0.
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setAllEntries([]); setReturns([]); setLoading(false); return }
    const [{ data }, { data: rets }] = results
    setAllEntries(data || [])
    setReturns(rets || [])
    setLoading(false)
  }

  // The same split VAT Report runs, over the same rows — so this page's discount and that page's
  // discount are two shares of one number rather than two independent claims on it.
  const split = splitPurchaseVat(allEntries, returns)
  const {
    nonVatLines: entries, nonVatReturns,
    nonVatGross: grossTotal, nonVatDiscount: totalDiscount,
    nonVatReturnBase: returnTotal, nonVatNet: total,
  } = split

  const uniqueVendors = new Set(entries.map(e => e.vendors?.name).filter(Boolean)).size
  const avgPerEntry   = entries.length ? total / entries.length : 0

  const vendorRows = buildVendorSummary(entries, nonVatReturns, split.factors)

  const periodLabel = (p) => p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : ''

  // S756 — the same unlinked returns VAT Report names, named here too: this is the other half of the
  // same filing, and a reader of only this page must not assume they were counted on it.
  const unlinked = summariseUnlinkedReturns(split.unlinkedReturns)
  const caveats = unlinked.count > 0
    ? [`NOT INCLUDED: ${unlinked.count} return${unlinked.count !== 1 ? 's' : ''} (NPR ${unlinked.value.toFixed(2)} at list rate) `
      + 'could not be linked to a purchase line — the bill was deleted or re-saved after the return — so it is not '
      + 'known whether VAT was charged on them. They are deducted from neither the VAT nor the Non-VAT report; '
      + `settle them with your CA. ${unlinked.examples.join('; ')}${unlinked.more ? `; and ${unlinked.more} more` : ''}`]
    : []
  // A month with non-VAT returns and no new non-VAT purchases still has a figure (S756).
  const hasFigures = entries.length > 0 || nonVatReturns.length > 0

  // The other half of the filing gets the same letterhead and the same period-status warning as
  // the VAT half — see VatReport's scopeLineFor.
  const scopeLineFor = (p) =>
    `Period : ${periodLabel(p)}${p?.status === 'open'
      ? ' (PROVISIONAL — period still open, figures can change)'
      : ' (period closed)'}`

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const scopeLine = scopeLineFor(selectedPeriod)

    // Entries sheet. Each line carries its share of its bill's discount, so the Net column sums to
    // the period total on screen rather than sitting a discount above it.
    const entryRows = entries.map(e => ({
      'Day':            e.bs_day,
      'Item':           e.items?.name || '',
      'Category':       e.items?.categories?.name || '',
      'Vendor':         e.vendors?.name || '',
      'PAN/VAT No.':    e.vendors?.pan_vat_no || '',
      'Qty':            Number(e.qty),
      'UOM':            e.items?.uom || '',
      'Rate':           Number(e.rate),
      'Gross (NPR)':    Number(e.lineGross.toFixed(2)),
      'Discount Share': Number((e.lineGross - e.lineNet).toFixed(2)),
      'Net (NPR)':      Number(e.lineNet.toFixed(2)),
      'Invoice Ref':    e.invoice_ref || '',
      'Notes':          e.notes || '',
    }))
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Non-VAT Report — Purchases without VAT', biz, scopeLine, rows: entryRows,
      notes: ['No input VAT credit is claimable on these purchases.', ...caveats],
    }), 'Non-VAT Entries')

    // CA Summary sheet
    const caRows = vendorRows.map(v => ({
      'Vendor':        v.name,
      'PAN/VAT No.':   v.pan,
      '# Bills':       v.count,
      'Gross (NPR)':   Number(v.gross.toFixed(2)),
      'Discount (NPR)':Number(v.discount.toFixed(2)),
      'Returns (NPR)': Number((v.returned || 0).toFixed(2)),
      'Net (NPR)':     Number((v.gross - v.discount - v.returned).toFixed(2)),
      'VAT Credit':    'NIL',
    }))
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Non-VAT Report — Vendor-wise Summary', biz, scopeLine, rows: caRows,
      notes: ['For reference only — verify bills with your CA before filing.', ...caveats],
    }), 'CA Summary')

    XLSX.writeFile(wb, `Non-VAT-Report-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />
  // With no period at all, every figure below is a confident NPR 0 and the empty state blames the
  // VAT toggle for it. The period selector would also be an empty <select> (S551 / NoPeriodState).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="the Non-VAT report" />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Non-VAT Report</h1>
          <p className="page-subtitle">Purchases without VAT this period</p>
          <div className="page-scope-row">
            {/* provisionalWhenOpen (S756): an open month's figures still move, and this is filed. */}
            <PeriodScope label={periodLabel(selectedPeriod)} status={selectedPeriod?.status} provisionalWhenOpen />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => <option key={p.id} value={p.id}>{periodLabel(p)}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Gated on `loading` (S756): the label, scope line and filename move on the click, the
                rows only when the read lands — an ungated export named last month's rows after this
                month. Excel also waits on biz.error, or the letterhead's company name is blank. */}
            <button className="btn btn-ghost" onClick={() => printWithTitle(`Non-VAT Report - ${periodLabel(selectedPeriod)}`)} disabled={loading || !!loadError || !hasFigures}>Print</button>
            <button className="btn btn-ghost" onClick={exportExcel} disabled={loading || !!loadError || !!biz.error || !hasFigures}>Export Excel</button>
          </div>
        </div>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {biz.error && !loadError && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Excel is switched off rather than exporting a report
          with a blank company name. The figures below are unaffected. Reload the page to try again.
        </p>
      )}

      {!loadError && !loading && unlinked.count > 0 && (
        <div role="alert" className="card" style={{
          marginBottom: 16, padding: '12px 16px',
          borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
          background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
        }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--theme-amber-text)' }}>
            ⚠ {unlinked.count} return{unlinked.count !== 1 ? 's are' : ' is'} not counted in this report — {fmtNPR(unlinked.value)} at list rate
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            The bill {unlinked.count !== 1 ? 'these were' : 'this was'} returned against was deleted or re-saved afterwards, so
            there is no longer any record of whether VAT was charged on {unlinked.count !== 1 ? 'them' : 'it'}. Rather than
            guess, {unlinked.count !== 1 ? 'they are' : 'it is'} left out of both the VAT and the Non-VAT report. Settle
            {unlinked.count !== 1 ? ' them' : ' it'} with your CA before filing: {unlinked.examples.join('; ')}
            {unlinked.more ? `; and ${unlinked.more} more` : ''}.
          </p>
        </div>
      )}

      {/* Summary cards — gated on !loading too: a stat computed from rows that have not arrived
          yet is NPR 0 wearing the confidence of a real figure (S594 rule). */}
      {!loadError && !loading && (
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Net value of all non-VAT purchases this period, after this half's share of any bill discount and after goods returned to the vendor. A mixed bill's discount is split between here and the VAT Report in proportion to line value, so the two never claim it twice." width={280}>Total Non-VAT Purchases</Tip>
          </div>
          <div className="stat-value gold" style={{ fontSize: 16 }}>NPR {Math.round(total).toLocaleString('en-IN')}</div>
          <div className="stat-sub">{entries.length} entr{entries.length !== 1 ? 'ies' : 'y'}{totalDiscount > 0 ? ` · −NPR ${Math.round(totalDiscount).toLocaleString('en-IN')} disc.` : ''}{returnTotal > 0 ? ` · −NPR ${Math.round(returnTotal).toLocaleString('en-IN')} returns` : ''}</div>
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
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-text1)' }}>NPR {Math.round(avgPerEntry).toLocaleString('en-IN')}</div>
          <div className="stat-sub">per line item</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="These purchases carry no input VAT credit — the full amount is a direct cost with no tax recovery.">Input VAT Credit</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 22, color: 'var(--theme-red-text)' }}>NIL</div>
          <div className="stat-sub">no tax credit claimable</div>
        </div>
      </div>
      )}

      {/* Tabs */}
      {!loadError && (
      <div className="tab-bar" style={{ marginBottom: 20 }}>
        <button className={`tab-btn${tab === 'entries' ? ' tab-btn--active' : ''}`} onClick={() => setTab('entries')}>Entries</button>
        <button className={`tab-btn${tab === 'ca' ? ' tab-btn--active' : ''}`} onClick={() => setTab('ca')}>CA Summary</button>
      </div>
      )}

      {/* ── ENTRIES TAB ── */}
      {!loadError && tab === 'entries' && (
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
              {/* The deductions rows live in this table's footer, so a returns-only month would
                  otherwise show no trace of the figure its own headline card is reporting (S756). */}
              {returnTotal > 0 && (
                <p className="empty-state-text" style={{ color: 'var(--theme-red-text)' }}>
                  {nonVatReturns.length} return{nonVatReturns.length !== 1 ? 's' : ''} of non-VAT goods bought earlier
                  come to −{fmtNPR(returnTotal)} — see the CA Summary tab for the vendor-wise figures.
                </p>
              )}
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
                        <td style={{ color: 'var(--theme-accent-ink)', fontWeight: 700, whiteSpace: 'nowrap' }}>{formatBsDay(e.bs_day, selectedPeriod?.bs_month)}</td>
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
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{fmtNPR(rowTotal)}</td>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{e.invoice_ref || '—'}</td>
                      </tr>
                    )
                  })}
                  {/* The rows above are gross, so a single TOTAL of gross − discount − returns
                      sat below a column that summed to something else, with nothing to explain
                      the gap. Show the two deductions as their own lines, the way the VAT half
                      already did, so the column ties to its own footer. */}
                  <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                    <td colSpan={7} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
                      {totalDiscount > 0 || returnTotal > 0 ? 'GROSS TOTAL' : 'TOTAL'}
                    </td>
                    <td style={{ textAlign: 'right', color: totalDiscount > 0 || returnTotal > 0 ? 'var(--theme-text1)' : 'var(--theme-accent-ink)' }}>{fmtNPR(grossTotal)}</td>
                    <td></td>
                  </tr>
                  {totalDiscount > 0 && (
                    <tr>
                      <td colSpan={7} style={{ color: 'var(--theme-red-text)', fontSize: 12 }}>Bill Discounts (non-VAT share)</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>−{fmtNPR(totalDiscount)}</td>
                      <td></td>
                    </tr>
                  )}
                  {returnTotal > 0 && (
                    <tr>
                      <td colSpan={7} style={{ color: 'var(--theme-red-text)', fontSize: 12 }}>Returned to Vendor</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>−{fmtNPR(returnTotal)}</td>
                      <td></td>
                    </tr>
                  )}
                  {(totalDiscount > 0 || returnTotal > 0) && (
                    <tr style={{ fontWeight: 700, background: 'color-mix(in srgb, var(--theme-accent) 5%, transparent)' }}>
                      <td colSpan={7} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>NET TOTAL</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmtNPR(total)}</td>
                      <td></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── CA SUMMARY TAB ── */}
      {!loadError && tab === 'ca' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14, color: 'var(--theme-text1)' }}>Vendor-wise Non-VAT Summary</h3>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                Grouped by supplier — share with your CA for expense reconciliation
              </p>
            </div>
            <span style={{ fontSize: 11, color: 'var(--theme-text2)', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-xs)', padding: '3px 8px' }}>
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
                    <th style={{ textAlign: 'right' }}><Tip text="Number of bills from this vendor this period carrying at least one non-VAT line — bills, not lines."># Bills</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Gross purchase amount before any bill-level discount.">Gross (NPR)</Tip></th>
                    {totalDiscount > 0 && <th style={{ textAlign: 'right' }}><Tip text="This vendor's bill discounts, only the share falling on non-VAT lines. On a mixed bill the rest sits in the VAT Report." width={260}>Discount</Tip></th>}
                    {returnTotal > 0 && <th style={{ textAlign: 'right' }}><Tip text="Value of non-VAT goods sent back to this vendor this period. Deducted from the net, since returned goods were never really purchased." width={260}>Returns</Tip></th>}
                    <th style={{ textAlign: 'right' }}><Tip text="Net amount after discount and returns — no VAT was charged by this supplier.">Net (NPR)</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="No input VAT credit is claimable on non-VAT purchases." width={220}>VAT Credit</Tip></th>
                  </tr>
                </thead>
                <tbody>
                  {vendorRows.map((v, i) => (
                    <tr key={i}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{v.name}</td>
                      <td style={{ color: v.pan ? 'var(--theme-text3)' : 'var(--theme-red-text)', fontSize: 12 }}>
                        {v.pan || <span style={{ fontStyle: 'italic' }}>Missing — add in Vendors</span>}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{v.count}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmtNPR(v.gross)}</td>
                      {totalDiscount > 0 && <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontSize: 12 }}>{v.discount > 0 ? `− ${fmtNPR(v.discount)}` : '—'}</td>}
                      {returnTotal > 0 && <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontSize: 12 }}>{v.returned > 0 ? `− ${fmtNPR(v.returned)}` : '—'}</td>}
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{fmtNPR(v.gross - v.discount - v.returned)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontWeight: 500 }}>NIL</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                    <td colSpan={3} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>PERIOD TOTAL</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmtNPR(grossTotal)}</td>
                    {totalDiscount > 0 && <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>− {fmtNPR(totalDiscount)}</td>}
                    {returnTotal > 0 && <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>− {fmtNPR(returnTotal)}</td>}
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmtNPR(total)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>NIL</td>
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
