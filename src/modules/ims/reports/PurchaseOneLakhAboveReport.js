import { npr } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import PeriodScope from '../../../components/PeriodScope'
import NoPeriodState from '../../../components/NoPeriodState'
import { BS_MONTHS, getBsFiscalYear } from '../../../utils/bsCalendar'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { allocateBillDiscounts } from './supplierAttribution'
import {
  buildVendorSummary, netFactors, annexure13Rows, summariseUnlinkedReturns, ONE_LAKH,
} from './purchaseTaxSplit'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { Navigate } from 'react-router-dom'

const fmtNpr = npr
const THRESHOLD = ONE_LAKH

const periodName = p => `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}`

export default function PurchaseOneLakhAboveReport() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  const fyReq = useLatestRequest()

  const [periods, setPeriods] = useState([])
  // S756: "have the periods been read yet" is its own fact. Without it a client with no periods
  // left `loading` at its initial true for ever — load() returned before ever clearing it.
  const [periodsLoaded, setPeriodsLoaded] = useState(false)
  const [fyOptions, setFyOptions] = useState([])
  const [selectedFy, setSelectedFy] = useState('')
  const [vendors, setVendors] = useState([])
  const [unlinked, setUnlinked] = useState({ count: 0, value: 0, examples: [], more: 0 })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    if (!effectiveClientId) return
    setPeriodsLoaded(false)
    scopedFrom('monthly_periods')
      .then(({ data, error }) => {
        if (error) { setLoadError(error.message); setLoading(false); return }
        const list = data || []
        setPeriods(list)
        const fys = [...new Set(list.map(p => getBsFiscalYear(p.bs_year, p.bs_month)))]
          .sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
        setFyOptions(fys)
        setSelectedFy(fys.length > 0 ? fys[0] : '')
        setPeriodsLoaded(true)
        if (list.length === 0) setLoading(false)
      })
  }, [effectiveClientId, scopedFrom])

  // The periods of the selected fiscal year, in calendar order — they are the report's scope, so
  // they are named on screen and in the workbook rather than implied by an FY label (S756).
  const fyPeriods = periods
    .filter(p => getBsFiscalYear(p.bs_year, p.bs_month) === selectedFy)
    .sort((a, b) => (a.bs_year - b.bs_year) || (a.bs_month - b.bs_month))
  const openPeriods = fyPeriods.filter(p => p.status === 'open')

  const load = useCallback(async () => {
    if (!effectiveClientId || !selectedFy || periods.length === 0) return
    // Keyed on client AND fiscal year: an admin switching client keeps the same FY label, and the
    // previous client's read must not land on the new one's page (the S721 rule).
    const key = fyReq.begin(`${effectiveClientId}:${selectedFy}`)   // claim the page before any await (S601)
    setLoading(true)
    const periodIds = periods
      .filter(p => getBsFiscalYear(p.bs_year, p.bs_month) === selectedFy)
      .map(p => p.id)

    setLoadError(null)
    if (periodIds.length === 0) { setVendors([]); setLoading(false); return }

    const results = await Promise.all([
      // Paged: this spans a whole BS fiscal year (12 periods), so it is one of the largest
      // purchase reads in the app — and it decides which vendors cross the IRD Annexure 13
      // one-lakh disclosure threshold, so a truncated read could omit a vendor that legally
      // must be disclosed (S529).
      fetchAllRows(() => supabase.from('purchase_entries')
        .select('*, vendors(name, pan_vat_no)').in('period_id', periodIds).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', '*, items(name), vendors(name, pan_vat_no), purchase_entries(vat_inclusive)').in('period_id', periodIds).order('id')),
    ])
    // S756: the staleness check comes BEFORE any setter. It sat below setLoadError, so a superseded
    // FY's failure could still paint its error card over the year the reader had moved on to.
    if (!fyReq.isCurrent(key)) return   // superseded by a newer FY / client selection
    // A statutory disclosure must not render a failed read as "no vendors" (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setVendors([]); setLoading(false); return }
    const [{ data: entData }, { data: retData }] = results
    const entries = entData || []
    const returns = retData || []

    // Annexure 13 discloses a vendor's TOTAL cumulative purchases for the fiscal year, not just
    // the VAT-taxable portion — an earlier vatEntries/vatReturns filter (borrowed from VatReport's
    // own vendor summary, which genuinely only cares about VAT-taxable purchases) silently dropped
    // every non-VAT bill from the vendor total, understating or fully omitting a vendor who should
    // have been disclosed. So EVERY allocated line goes in, not just the VAT ones. Which lines the
    // caller passes is now the only difference between this rollup and VatReport's — per-line
    // allocation makes the discount arithmetic identical either way (purchaseTaxSplit.js).
    const allocated = allocateBillDiscounts(entries)
    setVendors(buildVendorSummary(allocated, returns, netFactors(allocated)))
    // Unlinked returns (their bill was deleted or re-saved) still come off their supplier here —
    // a return is a return whichever half it was — but at list rate and with no VAT reversed, since
    // nothing records either. Named, so the reader knows those two figures are approximate (S756).
    const periodById = new Map(periods.map(p => [p.id, p]))
    setUnlinked(summariseUnlinkedReturns(returns, {
      dayLabel: r => {
        const p = periodById.get(r.period_id)
        return p ? `${r.bs_day ? `${r.bs_day} ` : ''}${periodName(p)}` : null
      },
    }))
    setLoading(false)
  }, [effectiveClientId, selectedFy, periods, scopedFrom, fyReq])

  useEffect(() => { load() }, [load])

  // One row per SUPPLIER, keyed on a normalised PAN (S756, owner decision D12). Two vendor cards for
  // one PAN each under one lakh used to be two undisclosed rows. A vendor crosses the threshold on
  // EITHER basis (decision, Aashish 2026-09-10) — measured on that aggregate. See annexure13Rows.
  const rows = annexure13Rows(vendors, THRESHOLD)
  const panlessCards = rows.filter(r => r.panMissing && r.vendorIds[0] !== '__unknown__').length
  const mergedSuppliers = rows.filter(r => r.cards > 1).length

  const totals = rows.reduce((s, v) => ({
    gross: s.gross + v.gross, discount: s.discount + (v.discount || 0), taxBase: s.taxBase + v.taxBase,
    returned: s.returned + v.returned, net: s.net + v.net, vatAmt: s.vatAmt + v.vatAmt, invoiced: s.invoiced + v.invoiced,
  }), { gross: 0, discount: 0, taxBase: 0, returned: 0, net: 0, vatAmt: 0, invoiced: 0 })

  const periodsText = fyPeriods.length === 0 ? 'none'
    : fyPeriods.length === 1 ? periodName(fyPeriods[0])
    : `${periodName(fyPeriods[0])} to ${periodName(fyPeriods[fyPeriods.length - 1])}`
  const openText = openPeriods.length === 0
    ? 'all closed'
    : `PROVISIONAL — ${openPeriods.length} still open (${openPeriods.map(periodName).join(', ')}), figures can change`
  // The one scope sentence, used on screen and as the workbook's scope line (S756, report-pages.md:
  // a report that states a scope states it everywhere it goes).
  const scopeLine = `Fiscal Year : ${selectedFy} — ${fyPeriods.length} of 12 months recorded (${periodsText}); ${openText}`

  const unlinkedNote = unlinked.count > 0
    ? `${unlinked.count} return${unlinked.count !== 1 ? 's' : ''} (NPR ${unlinked.value.toFixed(2)} at list rate) could not be `
      + 'linked to a purchase line — the bill was deleted or re-saved — so they are deducted from their supplier at '
      + `list rate with no VAT reversed: ${unlinked.examples.join('; ')}${unlinked.more ? `; and ${unlinked.more} more` : ''}.`
    : null

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const r2 = n => Math.round(n * 100) / 100
    const sheetRows = rows.map(v => ({
      'Supplier': v.name,
      'PAN/VAT No.': v.pan,
      'Vendor cards': v.cards,
      'Bills': v.count,
      'Gross (NPR)': r2(v.gross),
      'Discount (NPR)': r2(v.discount || 0),
      'Taxable (NPR)': r2(v.taxBase),
      'Returned (NPR)': r2(v.returned),
      'Net ex-VAT (NPR)': r2(v.net),
      'VAT (NPR)': r2(v.vatAmt),
      'Total Invoiced (NPR)': r2(v.invoiced),
      'Annexure 13 (>1L)': v.over ? (v.pan ? 'Yes' : 'Yes — MISSING PAN') : '',
      'Note': v.panMissing ? 'No PAN — cannot be matched to other cards for the same supplier' : '',
    }))
    if (rows.length > 0) {
      sheetRows.push({
        'Supplier': 'TOTAL', 'PAN/VAT No.': '', 'Vendor cards': '', 'Bills': '',
        'Gross (NPR)': r2(totals.gross), 'Discount (NPR)': r2(totals.discount), 'Taxable (NPR)': r2(totals.taxBase),
        'Returned (NPR)': r2(totals.returned), 'Net ex-VAT (NPR)': r2(totals.net), 'VAT (NPR)': r2(totals.vatAmt),
        'Total Invoiced (NPR)': r2(totals.invoiced), 'Annexure 13 (>1L)': '', 'Note': '',
      })
    }
    const notes = [
      'One row per supplier PAN: vendor cards sharing a PAN are added together, and the one-lakh test runs on that total — on the ex-VAT net or the invoiced total, whichever crosses.',
      ...(panlessCards > 0 ? [`${panlessCards} supplier card${panlessCards !== 1 ? 's have' : ' has'} no PAN and cannot be matched to other cards for the same supplier. Add the PAN in Vendors and re-export.`] : []),
      ...(unlinkedNote ? [unlinkedNote] : []),
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, {
      title: 'Purchase One Lakh Above — Annexure 13', biz, scopeLine, rows: sheetRows, notes,
    }), 'Purchase One Lakh Above')
    XLSX.writeFile(wb, `purchase-one-lakh-above-${selectedFy.replace('/', '-')}.xlsx`)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />
  if (periodsLoaded && !loadError && periods.length === 0) return <NoPeriodState what="the one-lakh purchase report" />

  const amberBanner = {
    marginBottom: 16, padding: '12px 16px',
    borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)',
    background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
  }

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">
          Purchase One Lakh Above Report <Tip text="Nepal VAT return Annexure 13 (अनुसूची १३): any single vendor whose cumulative purchases exceed NPR 1,00,000 in a fiscal year must be disclosed by name+PAN. This aggregates purchases by supplier PAN across the selected fiscal year and flags who crosses that threshold." width={320}>ⓘ</Tip>
        </h1>
        <p className="page-subtitle">
          Supplier-wise purchases for the fiscal year — flags suppliers above NPR 1,00,000 for Annexure 13 disclosure,
          on the ex-VAT net or the invoiced total, whichever crosses first.
        </p>
        {selectedFy && (
          <div className="page-scope-row">
            <PeriodScope
              label={`FY ${selectedFy}`}
              status={fyPeriods.length === 0 ? undefined : openPeriods.length > 0 ? 'open' : 'closed'}
              provisionalWhenOpen
              title={openPeriods.length > 0
                ? `${openPeriods.length} month${openPeriods.length !== 1 ? 's' : ''} of this fiscal year still open (${openPeriods.map(periodName).join(', ')}) — figures are provisional until closed.`
                : undefined}
            />
            <span style={{ fontSize: 12, color: 'var(--theme-text2)', marginLeft: 8 }}>
              {fyPeriods.length} of 12 months recorded ({periodsText})
            </span>
          </div>
        )}
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {biz.error && !loadError && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Excel is switched off rather than exporting a disclosure
          with a blank company name. The figures below are unaffected. Reload the page to try again.
        </p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="purcha-f1">Fiscal Year (BS)</label>
          <select id="purcha-f1" className="form-select" value={selectedFy} onChange={e => setSelectedFy(e.target.value)}>
            {fyOptions.map(fy => <option key={fy} value={fy}>{fy}</option>)}
          </select>
        </div>
        {/* Gated on `loading` (S756): the FY label and filename move on the click and the rows only
            when the read lands, so an ungated export named one year's disclosure after another. */}
        <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={exportExcel}
          disabled={loading || !!loadError || !!biz.error || rows.length === 0}>Export Excel</button>
      </div>

      {!loadError && !loading && openPeriods.length > 0 && (
        <div role="alert" className="card" style={amberBanner}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--theme-amber-text)' }}>
            △ Provisional — {openPeriods.length} month{openPeriods.length !== 1 ? 's' : ''} of FY {selectedFy} still open
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            {openPeriods.map(periodName).join(', ')} can still take new bills and returns, so a supplier under the
            threshold today may cross it. File from this list once those months are closed.
          </p>
        </div>
      )}

      {!loadError && !loading && (panlessCards > 0 || unlinked.count > 0) && (
        <div role="alert" className="card" style={amberBanner}>
          {panlessCards > 0 && (
            <>
              <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--theme-amber-text)' }}>
                ⚠ {panlessCards} supplier card{panlessCards !== 1 ? 's have' : ' has'} no PAN, so {panlessCards !== 1 ? 'they' : 'it'} cannot be matched
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
                Cards are added together by PAN. A card without one stays on its own row, so if the same supplier has
                a second card, the two are tested against NPR 1,00,000 separately and could both fall short. Add the
                PAN in Vendors.
              </p>
            </>
          )}
          {unlinked.count > 0 && (
            <p style={{ margin: panlessCards > 0 ? '10px 0 0' : 0, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>⚠ {unlinked.count} return{unlinked.count !== 1 ? 's' : ''} ({fmtNpr(unlinked.value)})</strong>{' '}
              could not be linked to a purchase line — the bill was deleted or re-saved after the return — so
              {unlinked.count !== 1 ? ' they are' : ' it is'} deducted from the supplier at list rate with no VAT reversed:{' '}
              {unlinked.examples.join('; ')}{unlinked.more ? `; and ${unlinked.more} more` : ''}.
            </p>
          )}
        </div>
      )}

      {loadError ? null : loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">₨</div>
            {/* Every purchase counts here, VAT and non-VAT alike — the copy said "No VAT
                purchases", which is the exact narrowing S363 had to take out of the arithmetic. */}
            <p className="empty-state-text">No purchases recorded in FY {selectedFy}.</p>
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>
                  <Tip text="Every vendor card carrying this PAN, added together — the disclosure is per supplier, not per card." width={260}>Supplier</Tip>
                </th>
                <th>PAN/VAT No.</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Number of bills across every card for this supplier — bills, not lines." width={220}>Bills</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Total billed amount before any discount, VAT, or returns." width={220}>Gross</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Trade/promo discount deducted from the gross bill amount." width={220}>Discount</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Gross minus discount — the base amount VAT is actually levied on." width={240}>Taxable</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Value of vendor returns for this fiscal year, netted out of the total." width={240}>Returned</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Taxable amount minus returns — the ex-VAT cost basis this app records against the purchase." width={280}>Net ex-VAT</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="13% VAT on the VAT-inclusive lines' post-discount value, less the VAT on any of those lines returned. Non-VAT purchases carry none." width={280}>VAT</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Net ex-VAT plus VAT — what the supplier actually invoiced across the year, and the figure their own ledger will show. Either this or Net ex-VAT crossing NPR 1,00,000 flags the supplier." width={300}>Total Invoiced</Tip>
                </th>
                <th>
                  <Tip text="Flagged when EITHER Net ex-VAT or Total Invoiced exceeds NPR 1,00,000, measured across every card sharing the PAN — the conservative filing position. A card with no PAN cannot be matched to the same supplier's other cards, so it is tested alone." width={300}>Flag</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(v => {
                const over = v.over
                return (
                  <tr key={v.key}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {v.name}
                      {v.cards > 1 && <div style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text2)' }}>{v.cards} vendor cards, same PAN</div>}
                    </td>
                    <td>{v.pan || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{v.count}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.gross)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.discount || 0)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.taxBase)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.returned)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.net)}</td>
                    <td style={{ textAlign: 'right' }}>{v.vatAmt > 0.005 ? fmtNpr(v.vatAmt) : '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(v.invoiced)}</td>
                    <td>
                      {over && !v.pan && <span className="badge badge-red">⚠ Missing PAN</span>}
                      {over && v.pan && <span className="badge badge-amber">Annexure 13</span>}
                      {!over && v.panMissing && <span className="badge badge-gray">No PAN — unmatched</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={3}>TOTAL{mergedSuppliers > 0 ? ` (${mergedSuppliers} supplier${mergedSuppliers !== 1 ? 's' : ''} combined across cards)` : ''}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(totals.gross)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(totals.discount)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(totals.taxBase)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(totals.returned)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(totals.net)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(totals.vatAmt)}</td>
                <td style={{ textAlign: 'right' }}>{fmtNpr(totals.invoiced)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
