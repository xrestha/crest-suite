import { npr } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import { getBsFiscalYear } from '../../../utils/bsCalendar'
import { allocateBillDiscounts } from './supplierAttribution'
import { buildVendorSummary, netFactors } from './purchaseTaxSplit'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { Navigate } from 'react-router-dom'

const fmtNpr = npr
const THRESHOLD = 100000

export default function PurchaseOneLakhAboveReport() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const fyReq = useLatestRequest()

  const [periods, setPeriods] = useState([])
  const [fyOptions, setFyOptions] = useState([])
  const [selectedFy, setSelectedFy] = useState('')
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .then(({ data, error }) => {
        if (error) { setLoadError(error.message); return }
        const list = data || []
        setPeriods(list)
        const fys = [...new Set(list.map(p => getBsFiscalYear(p.bs_year, p.bs_month)))]
          .sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
        setFyOptions(fys)
        if (fys.length > 0) setSelectedFy(fys[0])
      })
  }, [effectiveClientId, scopedFrom])

  const load = useCallback(async () => {
    if (!effectiveClientId || !selectedFy || periods.length === 0) return
    const key = fyReq.begin(selectedFy)   // claim the page before any await (S601)
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
      fetchAllRows(() => scopedFrom('vendor_returns', '*, vendors(name, pan_vat_no), purchase_entries(vat_inclusive)').in('period_id', periodIds).order('id')),
    ])
    // A statutory disclosure must not render a failed read as "no vendors" (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setVendors([]); setLoading(false); return }
    const [{ data: entData }, { data: retData }] = results
    const entries = entData || []

    // Annexure 13 discloses a vendor's TOTAL cumulative purchases for the fiscal year, not just
    // the VAT-taxable portion — an earlier vatEntries/vatReturns filter (borrowed from VatReport's
    // own vendor summary, which genuinely only cares about VAT-taxable purchases) silently dropped
    // every non-VAT bill from the vendor total, understating or fully omitting a vendor who should
    // have been disclosed. So EVERY allocated line goes in, not just the VAT ones. Which lines the
    // caller passes is now the only difference between this rollup and VatReport's — per-line
    // allocation makes the discount arithmetic identical either way (purchaseTaxSplit.js).
    const allocated = allocateBillDiscounts(entries)
    if (!fyReq.isCurrent(key)) return   // superseded by a newer FY selection
    setVendors(buildVendorSummary(allocated, retData || [], netFactors(allocated)))
    setLoading(false)
  }, [effectiveClientId, selectedFy, periods, scopedFrom, fyReq])

  useEffect(() => { load() }, [load])

  // A vendor crosses the threshold on EITHER basis (decision, Aashish 2026-09-10). The ex-VAT net
  // is the cost basis this app records; the invoiced total is what the vendor billed and what left
  // the bank, and it is the figure the vendor's own ledger shows. A vendor at 95,000 taxable plus
  // 12,350 VAT invoiced 107,350 and was disclosed by neither column until both were computed.
  const rows = vendors.map(v => {
    const taxBase = v.gross - (v.discount || 0)
    return { ...v, taxBase, over: v.net > THRESHOLD || v.invoiced > THRESHOLD }
  }).sort((a, b) => b.invoiced - a.invoiced)

  const totals = rows.reduce((s, v) => ({
    gross: s.gross + v.gross, discount: s.discount + (v.discount || 0), taxBase: s.taxBase + v.taxBase,
    returned: s.returned + v.returned, net: s.net + v.net, vatAmt: s.vatAmt + v.vatAmt, invoiced: s.invoiced + v.invoiced,
  }), { gross: 0, discount: 0, taxBase: 0, returned: 0, net: 0, vatAmt: 0, invoiced: 0 })

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.json_to_sheet(rows.map(v => ({
      'Vendor': v.name,
      'PAN/VAT No.': v.pan,
      'Bills': v.count,
      'Gross (NPR)': Math.round(v.gross * 100) / 100,
      'Discount (NPR)': Math.round((v.discount || 0) * 100) / 100,
      'Taxable (NPR)': Math.round(v.taxBase * 100) / 100,
      'Returned (NPR)': Math.round(v.returned * 100) / 100,
      'Net ex-VAT (NPR)': Math.round(v.net * 100) / 100,
      'VAT (NPR)': Math.round(v.vatAmt * 100) / 100,
      'Total Invoiced (NPR)': Math.round(v.invoiced * 100) / 100,
      'Annexure 13 (>1L)': v.over ? (v.pan ? 'Yes' : 'Yes — MISSING PAN') : '',
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Purchase One Lakh Above')
    XLSX.writeFile(wb, `purchase-one-lakh-above-${selectedFy.replace('/', '-')}.xlsx`)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">
          Purchase One Lakh Above Report <Tip text="Nepal VAT return Annexure 13 (अनुसूची १३): any single vendor whose cumulative purchases exceed NPR 1,00,000 in a fiscal year must be disclosed by name+PAN. This aggregates purchases by vendor across the selected fiscal year and flags who crosses that threshold." width={320}>ⓘ</Tip>
        </h1>
        <p className="page-subtitle">
          Vendor-wise purchases for the fiscal year — flags vendors above NPR 1,00,000 for Annexure 13 disclosure,
          on the ex-VAT net or the invoiced total, whichever crosses first.
        </p>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="purcha-f1">Fiscal Year (BS)</label>
          <select id="purcha-f1" className="form-select" value={selectedFy} onChange={e => setSelectedFy(e.target.value)}>
            {fyOptions.map(fy => <option key={fy} value={fy}>{fy}</option>)}
          </select>
        </div>
        <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={exportExcel} disabled={rows.length === 0}>Export Excel</button>
      </div>

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
                <th>Vendor</th><th>PAN/VAT No.</th><th style={{ textAlign: 'right' }}>Bills</th>
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
                  <Tip text="Net ex-VAT plus VAT — what the vendor actually invoiced across the year, and the figure their own ledger will show. Either this or Net ex-VAT crossing NPR 1,00,000 flags the vendor." width={300}>Total Invoiced</Tip>
                </th>
                <th>
                  <Tip text="Flagged when EITHER Net ex-VAT or Total Invoiced exceeds NPR 1,00,000 — the conservative filing position, since a vendor just under the threshold ex-VAT is over it once VAT is added. A missing PAN on a flagged row means the vendor's name alone was recorded." width={300}>Flag</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(v => {
                const over = v.over
                return (
                  <tr key={v.name + v.pan}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{v.name}</td>
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
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td colSpan={3}>TOTAL</td>
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
