import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import { readPriorBillLines } from './readPriorBillLines'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import { printWithTitle } from '../../../utils/printTitle'
import { BS_MONTHS, formatBsDay } from '../../../utils/bsCalendar'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { VAT_RATE, splitPurchaseVat, buildVendorSummary, billWiseVat, summariseUnlinkedReturns, returnLinesOutsidePeriod } from './purchaseTaxSplit'

function fmtNPR(n) {
  return `NPR ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function VatReport() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  const periodReq = useLatestRequest()
  const [periods, setPeriods]         = useState([])
  const [selectedPeriod, setSelected] = useState(null)
  const [entries, setEntries]         = useState([])
  const [returns, setReturns]         = useState([])
  const [priorBillLines, setPriorBillLines] = useState([])   // earlier-month bills a return points at (S756, D10)
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
    setLoadError(null)
    const results = await Promise.all([
      fetchAllRows(() => supabase
        .from('purchase_entries')
        .select('*, items(name, uom, categories(name)), vendors(name, pan_vat_no)')
        .eq('period_id', periodId)
        .order('bs_day')
        .order('created_at')
        .order('id')),
      // Paged for the same reason the purchases read is: PostgREST truncates at 1000 rows with no
      // error, and a return that silently vanishes overstates the input VAT this page is filed on.
      fetchAllRows(() => scopedFrom('vendor_returns', '*, items(name, uom, categories(name)), vendors(name, pan_vat_no), purchase_entries(vat_inclusive)')
        .eq('period_id', periodId)
        .order('bs_day')
        .order('id')),
    ])
    // A failed read must never reach the arithmetic below: everything flows through `|| []`, so an
    // RLS rejection or a stalled token would render a complete, confident VAT return of NPR 0 —
    // and this is a figure an accountant files on. See shared/queryError.js.
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setEntries([]); setReturns([]); setLoading(false); return }
    const [{ data: entData }, { data: retData }] = results

    // A return sits in the month the goods went back, and may be against a bill from an EARLIER
    // month (S756, owner decision D10). Its VAT half is already right — the embed above reads the
    // linked line's own vat_inclusive whatever month it is in — but its VALUE needs that bill's
    // discount, and the bill is not among this month's entries. Read those bills whole (every line,
    // so the discount apportions as it did on the bill) and hand them to splitPurchaseVat. Without
    // this, such a return falls back to the list rate and reverses VAT that was never claimed.
    const outsideIds = returnLinesOutsidePeriod(entData, retData)
    let priorLines = []
    if (outsideIds.length > 0) {
      const prior = await readPriorBillLines(outsideIds)
      if (!periodReq.isCurrent(periodId)) return
      if (prior.error) { setLoadError(prior.error); setEntries([]); setReturns([]); setPriorBillLines([]); setLoading(false); return }
      priorLines = prior.data
    }

    // Every entry and every return of the period, both halves. The VAT/non-VAT split happens in
    // splitPurchaseVat() rather than in the query, because a bill's discount cannot be apportioned
    // from one half of itself.
    setEntries(entData || [])
    setReturns(retData || [])
    setPriorBillLines(priorLines)
    setLoading(false)
  }

  // One split for the whole period. Non-VAT Report runs the same function over the same rows, so
  // the two halves of the filing cannot disagree about the same bill's discount — which they did,
  // by the full discount of every mixed bill. See purchaseTaxSplit.js.
  //
  // Discount is applied before VAT throughout (per Nepal IRD: VAT is on the net taxable amount).
  const split = splitPurchaseVat(entries, returns, { priorBillLines })
  const {
    vatLines, nonVatLines, vatReturns,
    vatGross: vatBaseList, vatDiscount: totalVatDiscount,
    vatBase: vatBaseGross, vatAmt: vatAmtGross, vatTotal: vatTotalGross,
    vatReturnBase: retBaseTotal, vatReturnAmt: retVatTotal, vatReturnTotal: retTotal,
    netVatBase, netVatAmt, netVatTotal,
    nonVatNet, totalNet, totalNetExVat,
  } = split

  const vendorRows  = buildVendorSummary(vatLines, vatReturns, split.factors)
  const periodLabel = (p) => p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : ''

  // S756. A return whose purchase line was deleted or re-saved is unlinked, and nothing can say
  // whether VAT was charged on it — so it is deducted from neither this report nor Non-VAT, and it is
  // NAMED here, on screen and in the workbook, rather than vanishing as it used to (which overstated
  // the input VAT claimed). See isUnlinkedReturn in purchaseTaxSplit.js.
  const unlinked = summariseUnlinkedReturns(split.unlinkedReturns)
  const unlinkedNote = unlinked.count > 0
    ? `NOT INCLUDED: ${unlinked.count} return${unlinked.count !== 1 ? 's' : ''} (NPR ${unlinked.value.toFixed(2)} at list rate) `
      + 'could not be linked to a purchase line — the bill was deleted or re-saved after the return — so it is not '
      + 'known whether VAT was charged on them. They are deducted from neither the VAT nor the Non-VAT report; '
      + `settle them with your CA. ${unlinked.examples.join('; ')}${unlinked.more ? `; and ${unlinked.more} more` : ''}`
    : null
  // Every bill of the period, one row each — the bill-wise sheet, and the supplier-bill check below.
  const bills = billWiseVat(split.allocated)
  // S756 (owner decision D13): bills whose supplier's printed VAT or total, where someone typed it,
  // differs from Crest's own figure for the bill by more than NPR 1. Named on screen and in the
  // workbook, because the figure filed is Crest's and a keying error found after filing is costly.
  const invoiceMismatches = bills.filter(b => b.invoiceCheck.mismatch)
  const invoiceChecked = bills.filter(b => b.invoiceCheck.checked).length
  const mismatchNote = invoiceMismatches.length > 0
    ? `CHECK: ${invoiceMismatches.length} bill${invoiceMismatches.length !== 1 ? 's differ' : ' differs'} from the VAT or total printed on the supplier's bill by more than NPR 1 `
      + '(see "Matches Supplier Bill?" on the Bill-wise sheet). The figures in this report are the lines as entered — '
      + "correct the bill in Purchases, or confirm the supplier's bill is what is wrong, before filing."
    : null
  // S756 (owner decision D10): returns sitting in this month against a bill from an earlier month.
  // They are counted here, in the month the goods went back; which month the VAT belongs in is the
  // accountant's call, so the report says so rather than deciding it.
  const entryIds = new Set(entries.map(e => e.id))
  const lateReturnCount = [...split.vatReturns, ...split.nonVatReturns]
    .filter(r => r.purchase_entry_id && !entryIds.has(r.purchase_entry_id)).length
  const lateReturnNote = lateReturnCount > 0
    ? `${lateReturnCount} return${lateReturnCount !== 1 ? 's' : ''} in this month ${lateReturnCount !== 1 ? 'are' : 'is'} against a bill from an earlier month. `
      + 'They are counted in this month — the month the goods went back — at the discounted rate their bill carried. '
      + 'Confirm with your accountant which month the VAT on a return like this should be claimed in.'
    : null
  const caveats = [unlinkedNote, mismatchNote, lateReturnNote].filter(Boolean)
  // A month with returns and no new VAT purchases still has a filing figure (a negative claim), so
  // it must be printable and exportable (S756).
  const hasFigures = vatLines.length > 0 || vatReturns.length > 0

  // A VAT return handed to a CA is a document, not a grid. sheetWithLetterhead puts the company
  // name, PAN/VAT number and address on every sheet, and — the part that matters most here — the
  // PERIOD AND ITS STATUS: figures pulled from a period that is still open can change after the
  // export, and a bare json_to_sheet gave the filer no way to know which they were holding.
  const scopeLineFor = (p) =>
    `Period : ${periodLabel(p)}${p?.status === 'open'
      ? ' (PROVISIONAL — period still open, figures can change)'
      : ' (period closed)'}`

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const scopeLine = scopeLineFor(selectedPeriod)

    // VAT Purchases sheet. Each line carries its own share of the bill discount, so the sheet's
    // Taxable column sums to the Taxable Base the CA Summary and the on-screen totals both show.
    const entryRows = vatLines.map(e => ({
      'Day':               e.bs_day,
      'Item':              e.items?.name || '',
      'Category':          e.items?.categories?.name || '',
      'Vendor':            e.vendors?.name || '',
      'PAN/VAT No.':       e.vendors?.pan_vat_no || '',
      'Qty':               Number(e.qty),
      'UOM':               e.items?.uom || '',
      'Gross (ex-VAT)':    Number(e.lineGross.toFixed(2)),
      'Discount Share':    Number((e.lineGross - e.lineNet).toFixed(2)),
      'Taxable (ex-VAT)':  Number(e.lineNet.toFixed(2)),
      'VAT (13%)':         Number((e.lineNet * VAT_RATE).toFixed(2)),
      'Total (incl. VAT)': Number((e.lineNet * (1 + VAT_RATE)).toFixed(2)),
      'Invoice Ref':       e.invoice_ref || '',
    }))
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'VAT Report — Input VAT on Purchases', biz, scopeLine, rows: entryRows, notes: caveats,
    }), 'VAT Purchases')

    // Bill-wise sheet (S756, owner decision D28): one row per invoice, the shape the purchase book is
    // kept in. Built from the same allocated lines as everything else, so its Taxable, Exempt and VAT
    // columns total to the Taxable Base on the sheet above and the Non-VAT figure before returns.
    const r2 = n => Number(n.toFixed(2))
    const billRows = bills.map(b => ({
      'Day':                    b.bs_day,
      'Supplier':               b.vendor,
      'PAN/VAT No.':            b.pan,
      'Invoice No.':            b.invoice,
      'Taxable (ex-VAT, net of discount)': r2(b.taxable),
      'Exempt / Non-VAT':       r2(b.exempt),
      'VAT (13%)':              r2(b.vat),
      'Total':                  r2(b.total),
      // S756 (D13). Blank when nobody typed the supplier's figures — never 0, which would read as a
      // real printed VAT of nothing.
      'Supplier Bill VAT':      b.invoiceVat === null ? '' : r2(b.invoiceVat),
      'Supplier Bill Total':    b.invoiceTotal === null ? '' : r2(b.invoiceTotal),
      'Matches Supplier Bill?': !b.invoiceCheck.checked ? ''
        : !b.invoiceCheck.mismatch ? 'Yes'
        : ['NO',
          b.invoiceCheck.vatMismatch ? `VAT differs by ${r2(b.invoiceCheck.vatDiff)}` : '',
          b.invoiceCheck.totalMismatch ? `total differs by ${r2(b.invoiceCheck.totalDiff)}` : '',
        ].filter(Boolean).join(' — '),
    }))
    if (bills.length > 0) {
      const tot = k => bills.reduce((s, b) => s + b[k], 0)
      billRows.push({
        'Day': 'TOTAL', 'Supplier': `${bills.length} bill${bills.length !== 1 ? 's' : ''}`, 'PAN/VAT No.': '', 'Invoice No.': '',
        'Taxable (ex-VAT, net of discount)': r2(tot('taxable')),
        'Exempt / Non-VAT':       r2(tot('exempt')),
        'VAT (13%)':              r2(tot('vat')),
        'Total':                  r2(tot('total')),
        'Supplier Bill VAT':      '',
        'Supplier Bill Total':    '',
        'Matches Supplier Bill?': invoiceChecked > 0 ? `${invoiceMismatches.length} of ${invoiceChecked} checked differ` : '',
      })
    }
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'VAT Report — Purchases Bill-wise', biz, scopeLine, rows: billRows,
      notes: [
        "One row per purchase invoice. A bill's discount is split between its VAT and non-VAT lines in proportion to line value.",
        'Returns are credit notes, not invoices, and are not on this sheet — see VAT Returns and CA Summary for the net figures.',
        "Supplier Bill VAT / Total are the figures typed off the supplier's paper bill, where someone entered them. 'Matches Supplier Bill?' compares them with this row's VAT and Total, allowing NPR 1 for rounding; blank means they were not typed.",
        ...caveats,
      ],
    }), 'Bill-wise')

    // VAT Returns sheet
    if (vatReturns.length > 0) {
      const retRows = vatReturns.map(r => ({
        'Day':                        r.bs_day,
        'Item':                       r.items?.name || '',
        'Category':                   r.items?.categories?.name || '',
        'Vendor':                     r.vendors?.name || '',
        'PAN/VAT No.':                r.vendors?.pan_vat_no || '',
        'Returned Qty':               Number(r.qty),
        'UOM':                        r.items?.uom || '',
        'Base Returned (ex-VAT)':     Number(r.base.toFixed(2)),
        'VAT Reversed (13%)':         Number((r.base * VAT_RATE).toFixed(2)),
        'Total Returned (incl. VAT)': Number((r.base * (1 + VAT_RATE)).toFixed(2)),
        'Notes':                      r.notes || '',
      }))
      XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
        title: 'VAT Report — Returns (input VAT reversed)', biz, scopeLine, rows: retRows,
        notes: ['Returned goods are valued at the discounted rate their original bill carried.', ...caveats],
      }), 'VAT Returns')
    }

    // CA Summary sheet
    const caRows = vendorRows.map(v => {
      const discBase = v.discount || 0
      const taxBase  = v.gross - discBase
      const netBase  = taxBase - v.returned
      return {
        'Vendor':                    v.name,
        'PAN/VAT No.':               v.pan,
        '# Bills':                   v.count,
        'Gross Base (ex-VAT)':       Number(v.gross.toFixed(2)),
        'Trade Discount':            discBase > 0 ? Number((-discBase).toFixed(2)) : 0,
        'Taxable Base (ex-VAT)':     Number(taxBase.toFixed(2)),
        'Returned Base (ex-VAT)':    Number(v.returned.toFixed(2)),
        'Net Taxable (ex-VAT)':      Number(netBase.toFixed(2)),
        'Net Input VAT (13%)':       Number((netBase * VAT_RATE).toFixed(2)),
        'Net Total (incl. VAT)':     Number((netBase * (1 + VAT_RATE)).toFixed(2)),
      }
    })
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'VAT Report — Vendor-wise Summary', biz, scopeLine, rows: caRows,
      notes: ['For reference only — verify bills with your CA before filing.', ...caveats],
    }), 'CA Summary')

    XLSX.writeFile(wb, `VAT-Report-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />
  // With no period at all, every figure below is a confident NPR 0 and the empty state blames the
  // VAT toggle for it. The period selector would also be an empty <select> (S551 / NoPeriodState).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="the VAT report" />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">VAT Report</h1>
          <p className="page-subtitle">Input VAT summary on purchases</p>
          <div className="page-scope-row">
            {/* provisionalWhenOpen (S756): an open month's input VAT can still change as bills and
                returns are entered, and this is the figure that gets filed. */}
            <PeriodScope label={periodLabel(selectedPeriod)} status={selectedPeriod?.status} provisionalWhenOpen />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => setSelected(periods.find(p => p.id === e.target.value))}>
            {periods.map(p => <option key={p.id} value={p.id}>{periodLabel(p)}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {/* Gated on `loading` too (S756): the period label, print title, scope line and filename
                move the moment a month is picked, and the rows on screen are the PREVIOUS month's
                until the read lands — so an ungated export shipped last month's figures under this
                month's name. And on biz.error for Excel, or the letterhead's company name is blank. */}
            <button className="btn btn-ghost" onClick={() => printWithTitle(`VAT Report - ${periodLabel(selectedPeriod)}`)} disabled={loading || !!loadError || !hasFigures}>Print</button>
            <button className="btn btn-ghost" onClick={exportExcel} disabled={loading || !!loadError || !!biz.error || !hasFigures}>Export Excel</button>
          </div>
        </div>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {biz.error && !loadError && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Excel is switched off rather than exporting a VAT
          report with a blank company name. The figures below are unaffected. Reload the page to try again.
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

      {/* S756 (D13). Gated like the cards: a count from rows that have not arrived is not a count. */}
      {!loadError && !loading && invoiceMismatches.length > 0 && (
        <div role="alert" className="card" style={{
          marginBottom: 16, padding: '12px 16px',
          borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
          background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
        }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--theme-amber-text)' }}>
            △ {invoiceMismatches.length} bill{invoiceMismatches.length !== 1 ? 's don’t' : ' doesn’t'} match the supplier’s printed VAT or total
            <span style={{ fontWeight: 400, color: 'var(--theme-text2)' }}> — {invoiceChecked} of {bills.length} bill{bills.length !== 1 ? 's' : ''} had those figures typed in</span>
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            The figures below are worked out from the lines as entered, and differ from the paper bill by more than NPR 1 on:{' '}
            {invoiceMismatches.slice(0, 8).map(b => [formatBsDay(b.bs_day, selectedPeriod?.bs_month), b.vendor || 'No vendor', b.invoice ? `#${b.invoice}` : null].filter(Boolean).join(' · ')).join('; ')}
            {invoiceMismatches.length > 8 ? `; and ${invoiceMismatches.length - 8} more` : ''}.
            {' '}Usually a rate typed in the wrong unit, a missed line or VAT ticked on the wrong item — open the bill in Purchases and check it before filing.
            The Excel export's Bill-wise sheet flags each one.
          </p>
        </div>
      )}

      {!loadError && !loading && lateReturnCount > 0 && (
        <p role="note" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--theme-text1)' }}>{lateReturnCount} return{lateReturnCount !== 1 ? 's' : ''} this month {lateReturnCount !== 1 ? 'are' : 'is'} against a bill from an earlier month.</strong>{' '}
          {lateReturnCount !== 1 ? 'They are' : 'It is'} counted here, in the month the goods went back, at the discounted rate the bill carried.
          Confirm with your accountant which month the VAT on a return like this should be claimed in.
        </p>
      )}

      {/* Summary cards — gated on !loading too: a stat computed from rows that have not arrived
          yet is NPR 0 wearing the confidence of a real figure (S594 rule). */}
      {!loadError && !loading && (
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label"><Tip text="Total net purchases this period: non-VAT plus VAT-inclusive, both after bill discounts and after goods returned. Includes VAT on the VAT-inclusive half." width={260}>Total Net Purchases</Tip></div>
          <div className="stat-value gold" style={{ fontSize: 16 }}>NPR {Math.round(totalNet).toLocaleString('en-IN')}</div>
          <div className="stat-sub">{entries.length} purchase lines</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Non-VAT purchases after their share of any bill discount and after goods returned — the same figure the Non-VAT Report shows." width={270}>Non-VAT Purchases</Tip></div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-text1)' }}>NPR {Math.round(nonVatNet).toLocaleString('en-IN')}</div>
          <div className="stat-sub">{nonVatLines.length} entries</div>
        </div>
        <div className="stat-card">
          {/* S756: these figures are AFTER each line's share of the bill discount, so neither the
              tooltip nor the sub-line may call them "Gross" — the Gross column is the pre-discount one. */}
          <div className="stat-label"><Tip text="VAT-inclusive purchases after their share of any bill discount, minus VAT-inclusive goods returned — including the VAT." width={260}>Net VAT Purchases</Tip></div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-amber-text)' }}>NPR {Math.round(netVatTotal).toLocaleString('en-IN')}</div>
          <div className="stat-sub">
            {vatLines.length} lines
            {vatReturns.length > 0 && <span style={{ color: 'var(--theme-red-text)' }}> − {vatReturns.length} returns</span>}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Net input VAT claimable = (taxable VAT purchases after discount − VAT returns) × 13%. Use this for your IRD VAT return." width={270}>Net Input VAT (13%)</Tip></div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-green-text)' }}>NPR {Math.round(netVatAmt).toLocaleString('en-IN')}</div>
          <div className="stat-sub">
            {vatReturns.length > 0
              ? <span>Purchases {fmtNPR(vatAmtGross)} − returns {fmtNPR(retVatTotal)}</span>
              : 'Claimable input tax'}
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Net cost basis excluding VAT — actual expense recorded for accounting." width={230}>Net (ex-VAT)</Tip></div>
          <div className="stat-value" style={{ fontSize: 16, color: 'var(--theme-text1)' }}>NPR {Math.round(totalNetExVat).toLocaleString('en-IN')}</div>
          <div className="stat-sub">Actual cost basis</div>
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
        <>
          {/* Purchases */}
          <div className="card" style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--theme-text1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>VAT-Inclusive Purchases</span>
              {!loading && <span style={{ fontSize: 12, color: 'var(--theme-text2)', fontWeight: 400 }}>{vatLines.length} of {entries.length} entries</span>}
            </h3>
            {loading ? (
              <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
            ) : vatLines.length === 0 ? (
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
                      <th style={{ textAlign: 'right' }}><Tip text="The rate you entered × qty, ex-VAT, before this line's share of the bill discount." width={240}>Gross (ex-VAT)</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}><Tip text="This line's share of its bill's discount, in proportion to line value. On a bill with non-VAT lines the rest of the discount sits in the Non-VAT Report." width={260}>Discount</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Gross − discount share. VAT is levied on this amount per Nepal IRD." width={220}>Taxable</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-amber-text)' }}><Tip text="Input VAT = Taxable × 13%. Claimable as input tax credit from IRD." width={220}>VAT (13%)</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Taxable + VAT — what this line actually cost including VAT.">Total (incl. VAT)</Tip></th>
                      <th>Invoice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vatLines.map(e => {
                      // S756: the line's own post-discount value, as the workbook's VAT Purchases sheet
                      // prints it. This was qty × rate — the pre-discount figure — under a VAT column
                      // whose tooltip called it claimable, so the rows summed to more VAT than the
                      // Net Input VAT card and the exported sheet both claimed.
                      const disc  = e.lineGross - e.lineNet
                      const vat   = e.lineNet * VAT_RATE
                      const total = e.lineNet + vat
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
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtNPR(e.lineGross)}</td>
                          <td style={{ textAlign: 'right', color: disc > 0.005 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{disc > 0.005 ? `−${fmtNPR(disc)}` : '—'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(e.lineNet)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-amber-text)', fontWeight: 600 }}>{fmtNPR(vat)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{fmtNPR(total)}</td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{e.invoice_ref || '—'}</td>
                        </tr>
                      )
                    })}
                    {/* One TOTALS row whose every cell is the sum of the column above it (S756) —
                        the rows now carry their own discount share, so the separate Trade Discount
                        and TAXABLE TOTALS rows had nothing left to reconcile. */}
                    <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700, background: 'color-mix(in srgb, var(--theme-accent) 5%, transparent)' }}>
                      <td colSpan={6} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>TOTALS</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtNPR(vatBaseList)}</td>
                      <td style={{ textAlign: 'right', color: totalVatDiscount > 0.005 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{totalVatDiscount > 0.005 ? `−${fmtNPR(totalVatDiscount)}` : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(vatBaseGross)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-amber-text)' }}>{fmtNPR(vatAmtGross)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmtNPR(vatTotalGross)}</td>
                      <td></td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* VAT Returns */}
          {vatReturns.length > 0 && (
            <div className="card" style={{ marginBottom: 16, border: '1px solid color-mix(in srgb, var(--theme-red) 20%, transparent)' }}>
              <h3 style={{ margin: '0 0 16px', fontSize: 14, color: 'var(--theme-red-text)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
                      <th style={{ textAlign: 'right' }}><Tip text="Value credited back, at the discounted rate the original bill carried — not the list rate." width={250}>Base Returned</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>VAT Reversed</th>
                      <th style={{ textAlign: 'right' }}>Total Returned</th>
                      <th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vatReturns.map(r => {
                      // r.base, not qty x rate: a return is credited at the discounted rate its
                      // original bill carried, so these rows sum to the TOTAL RETURNS row below
                      // and a fully-returned discounted bill nets to zero rather than negative.
                      const base  = r.base
                      const vat   = base * VAT_RATE
                      const total = base + vat
                      return (
                        <tr key={r.id}>
                          <td style={{ color: 'var(--theme-accent-ink)', fontWeight: 700, whiteSpace: 'nowrap' }}>{formatBsDay(r.bs_day, selectedPeriod?.bs_month)}</td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.items?.name}</td>
                          <td>
                            {r.items?.categories?.name
                              ? <span className="badge badge-yellow">{r.items.categories.name}</span>
                              : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                          </td>
                          <td style={{ color: 'var(--theme-text2)' }}>{r.vendors?.name || '—'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>−{Number(r.qty).toLocaleString(undefined, { maximumFractionDigits: 3 })}</td>
                          <td style={{ color: 'var(--theme-text2)' }}>{r.items?.uom}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>−{fmtNPR(base)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontWeight: 600 }}>−{fmtNPR(vat)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontWeight: 600 }}>−{fmtNPR(total)}</td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{r.notes || '—'}</td>
                        </tr>
                      )
                    })}
                    <tr style={{ borderTop: '2px solid color-mix(in srgb, var(--theme-red) 30%, transparent)', fontWeight: 700 }}>
                      <td colSpan={6} style={{ color: 'var(--theme-red-text)', fontSize: 12 }}>TOTAL RETURNS</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>−{fmtNPR(retBaseTotal)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>−{fmtNPR(retVatTotal)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>−{fmtNPR(retTotal)}</td>
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
                  <div style={{ fontWeight: 700, color: 'var(--theme-green-text)', fontSize: 14 }}>{fmtNPR(netVatAmt)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 2 }}>Net (incl. VAT)</div>
                  <div style={{ fontWeight: 700, color: 'var(--theme-accent-ink)', fontSize: 14 }}>{fmtNPR(netVatTotal)}</div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── CA SUMMARY TAB ── */}
      {!loadError && tab === 'ca' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 14, color: 'var(--theme-text1)' }}>Vendor-wise VAT Summary</h3>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                Grouped by supplier — share with your CA for input VAT reconciliation
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
              <p className="empty-state-text">No VAT-inclusive purchases this period.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vendor</th>
                    <th><Tip text="PAN or VAT registration number of the supplier — add it in Vendors if missing.">PAN / VAT No.</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Number of bills from this vendor this period carrying at least one VAT-inclusive line — bills, not lines."># Bills</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Gross purchases at list price before trade discount, ex-VAT.">Gross Base</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}><Tip text="Trade/promo discount from the vendor, prorated to VAT items. Reduces the taxable base." width={260}>Discount</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Taxable base = Gross − Discount. VAT is levied on this amount per Nepal IRD." width={240}>Taxable Base</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}><Tip text="Base amount of VAT-inclusive goods returned to this vendor." width={230}>Returned</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Net taxable = Taxable Base − Returns, ex-VAT.">Net Taxable</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-amber-text)' }}><Tip text="Net claimable input VAT = Net Taxable × 13%. Use for IRD VAT return." width={230}>Net Input VAT</Tip></th>
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
                        <td style={{ color: v.pan ? 'var(--theme-text3)' : 'var(--theme-red-text)', fontSize: 12 }}>
                          {v.pan || <span style={{ fontStyle: 'italic' }}>Missing — add in Vendors</span>}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{v.count}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtNPR(v.gross)}</td>
                        <td style={{ textAlign: 'right', color: disc > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>
                          {disc > 0 ? `−${fmtNPR(disc)}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtNPR(taxBase)}</td>
                        <td style={{ textAlign: 'right', color: v.returned > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>
                          {v.returned > 0 ? `−${fmtNPR(v.returned)}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)', fontWeight: 600 }}>{fmtNPR(netBase)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-amber-text)', fontWeight: 600 }}>{fmtNPR(netVat)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{fmtNPR(netTotal)}</td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                    <td colSpan={3} style={{ color: 'var(--theme-text2)', fontSize: 12 }}>PERIOD NET</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtNPR(vatBaseList)}</td>
                    <td style={{ textAlign: 'right', color: totalVatDiscount > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>
                      {totalVatDiscount > 0 ? `−${fmtNPR(totalVatDiscount)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{fmtNPR(vatBaseGross)}</td>
                    <td style={{ textAlign: 'right', color: retBaseTotal > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>
                      {retBaseTotal > 0 ? `−${fmtNPR(retBaseTotal)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmtNPR(netVatBase)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-amber-text)' }}>{fmtNPR(netVatAmt)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmtNPR(netVatTotal)}</td>
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
