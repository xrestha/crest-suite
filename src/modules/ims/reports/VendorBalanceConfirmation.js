import { useCallback, useEffect, useState } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import { getBsFiscalYear, getBsFiscalYearStart, adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { printWithTitle } from '../../../utils/printTitle'
import { getFiscalYearAdRange, computeVendorBalance } from './vendorBalanceHelpers'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import VendorBalanceConfirmationPrint from './VendorBalanceConfirmationPrint'

// Nepal IRD Annexure 13 (अनुसूची १३) balance confirmation — per-vendor, per-fiscal-year printable
// letter. See vendorBalanceHelpers.js for the opening/running-balance computation this wires up.
export default function VendorBalanceConfirmation() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { settings } = useSettings()
  const { scopedFrom } = useScopedDb()
  const [searchParams] = useSearchParams()

  const [vendors, setVendors] = useState([])
  const [periods, setPeriods] = useState([])
  const [fyOptions, setFyOptions] = useState([])
  const [selectedVendorId, setSelectedVendorId] = useState('')
  const [selectedFy, setSelectedFy] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [loading, setLoading] = useState(true)
  const [computing, setComputing] = useState(false)
  const [result, setResult] = useState(null)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [effectiveClientId, authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    setLoadError(null)
    const results = await Promise.all([
      scopedFrom('vendors').eq('is_active', true).order('name'),
      scopedFrom('monthly_periods').order('bs_year').order('bs_month'),
      supabase.from('clients').select('name').eq('id', effectiveClientId).single(),
    ])
    // A failed read must not render as "no vendors / no periods" (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setLoading(false); return }
    const [{ data: v }, { data: p }, { data: client }] = results
    setVendors(v || [])
    setPeriods(p || [])
    setBusinessName(client?.name || '')

    const fys = [...new Set((p || []).map(pr => getBsFiscalYear(pr.bs_year, pr.bs_month)))]
      .sort((a, b) => parseInt(b, 10) - parseInt(a, 10))
    setFyOptions(fys)
    if (fys.length > 0) setSelectedFy(fys[0])

    // Arriving from Vendors.js's "Confirm Balance" link (?vendor=<id>) preselects that vendor.
    const vendorParam = searchParams.get('vendor')
    if (vendorParam && (v || []).some(x => x.id === vendorParam)) setSelectedVendorId(vendorParam)

    setLoading(false)
  }

  const load = useCallback(async () => {
    if (!effectiveClientId || !selectedVendorId || !selectedFy || periods.length === 0) { setResult(null); return }
    setComputing(true)
    setLoadError(null)

    const fyPeriods = periods.filter(pr => getBsFiscalYear(pr.bs_year, pr.bs_month) === selectedFy)
    const fyPeriodIds = fyPeriods.map(pr => pr.id)
    const fyStartYear = getBsFiscalYearStart(fyPeriods[0].bs_year, fyPeriods[0].bs_month)
    const { start: fyStart, end: fyEnd } = getFiscalYearAdRange(fyStartYear)

    // Full history of this vendor's Credit bills — Opening Balance needs everything before this
    // FY, not just the FY window itself.
    // Paged: deliberately unbounded by period (every credit bill for this vendor, ever), which is
    // the whole point of an opening-balance carry-forward — and therefore a prime candidate for
    // PostgREST's silent 1000-row cap. A truncated read would understate the balance on a
    // document sent to the vendor for signature (S529).
    const { data: creditData, error: creditErr } = await fetchAllRows(() => supabase
      .from('purchase_entries')
      .select('id, bs_day, qty, rate, invoice_ref, paid_at, vat_inclusive, discount_amount, purchase_group_id, vendor_id, payment_method, monthly_periods!inner(client_id, bs_year, bs_month)')
      .eq('monthly_periods.client_id', effectiveClientId)
      .eq('vendor_id', selectedVendorId)
      .eq('payment_method', 'Credit')
      .order('id'))
    if (creditErr) { setLoadError(creditErr.message); setResult(null); setComputing(false); return }
    const creditEntries = creditData || []

    // Cash/FonePay bills never carry a balance, so only the selected FY's periods matter for them.
    let cashEntries = []
    if (fyPeriodIds.length > 0) {
      const { data: cashData, error: cashErr } = await fetchAllRows(() => supabase
        .from('purchase_entries')
        .select('id, bs_day, qty, rate, invoice_ref, vat_inclusive, discount_amount, purchase_group_id, vendor_id, payment_method, monthly_periods!inner(client_id, bs_year, bs_month, id)')
        .eq('monthly_periods.client_id', effectiveClientId)
        .eq('vendor_id', selectedVendorId)
        .neq('payment_method', 'Credit')
        .in('monthly_periods.id', fyPeriodIds)
        .order('id'))
      if (cashErr) { setLoadError(cashErr.message); setResult(null); setComputing(false); return }
      cashEntries = cashData || []
    }

    const creditIds = creditEntries.map(e => e.id)
    // Returns can be recorded against a Cash/FonePay bill too (ReturnsTab copies the linked
    // purchase's payment_method), so the returns fetch needs both id sets — not just Credit ids —
    // or a return against an in-FY cash bill would silently fail to net out of that bill's total.
    const allEntryIds = [...creditIds, ...cashEntries.map(e => e.id)]

    let payments = []
    let returns = []
    const [pmtsRes, retsRes] = await Promise.all([
      creditIds.length > 0
        ? scopedFrom('payable_payments').in('purchase_entry_id', creditIds).order('paid_at')
        : Promise.resolve({ data: [] }),
      allEntryIds.length > 0
        ? scopedFrom('vendor_returns', 'purchase_entry_id, qty, rate, bs_day, monthly_periods(bs_year, bs_month)').in('purchase_entry_id', allEntryIds)
        : Promise.resolve({ data: [] }),
    ])
    const pmtRetFailed = firstError([pmtsRes, retsRes])
    if (pmtRetFailed) { setLoadError(pmtRetFailed); setResult(null); setComputing(false); return }
    payments = pmtsRes.data || []
    returns = retsRes.data || []

    const computed = computeVendorBalance({ creditEntries, cashEntries, payments, returns, fyStart, fyEnd })
    setResult({ ...computed, fyStart, fyEnd })
    setComputing(false)
  }, [effectiveClientId, selectedVendorId, selectedFy, periods, scopedFrom])

  useEffect(() => { load() }, [load])

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  const vendor = vendors.find(v => v.id === selectedVendorId)
  const isEmpty = !result || (result.schedule.length <= 1 && Math.abs(result.openingBalance) < 0.01)

  const fmt = n => (Math.round(n * 100) / 100).toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtBs = date => { const { year, month, day } = adToBs(date); return `${day} ${BS_MONTHS[month - 1]} ${year}` }

  // Plain text, WhatsApp's own markdown (*bold*) — no HTML, matches ReorderReport.js's convention.
  // Mirrors the letter's own "Opening + Purchases − Payments − Returns = Balance" sentence rather
  // than the full line-by-line schedule, since that's the one number a vendor actually needs on
  // a phone screen; the printed/PDF letter remains the authoritative document for signing.
  function buildWhatsAppText() {
    const isAdvance = result.closingBalance < -0.01
    const balanceLabel = isAdvance ? 'Advance / Credit Balance' : 'Balance Payable'
    return [
      `*Vendor Balance Confirmation*`,
      `${businessName} → ${vendor?.name}`,
      `FY ${selectedFy} (as of ${fmtBs(result.fyEnd)} BS)`,
      '',
      `Opening Balance: NPR ${fmt(result.openingBalance)}`,
      `Purchases (FY): NPR ${fmt(result.totals.totalPurchasesFy)}`,
      `Payments (FY): NPR ${fmt(result.totals.totalPaymentsFy)}`,
      `Returns (FY): NPR ${fmt(result.totals.totalReturnsFy)}`,
      '',
      `*${balanceLabel}: NPR ${fmt(Math.abs(result.closingBalance))}*`,
    ].join('\n')
  }

  // No phone number in the wa.me URL — general "share to whoever" action (WhatsApp opens its own
  // contact/group picker), same convention as ReorderReport.js's shareReorderListWhatsApp.
  function shareWhatsApp() {
    window.open(`https://wa.me/?text=${encodeURIComponent(buildWhatsAppText())}`, '_blank', 'noopener,noreferrer')
  }

  return (
    <div>
      <div className="page-header page-header--split no-print">
        <div>
          <h1 className="page-title">Vendor Balance Confirmation</h1>
          <p className="page-subtitle">Printable yearly balance letter for IRD Annexure 13 reconciliation with a vendor</p>
        </div>
        {vendor && result && !isEmpty && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <Tip text="Opens WhatsApp with the Opening/Purchases/Payments/Returns summary and closing balance pre-filled as a text message — pick a contact or group to send it to. The printed letter remains the document to actually sign." width={280}>
              <button className="btn btn-ghost" onClick={shareWhatsApp}>📱 Share via WhatsApp</button>
            </Tip>
            <button className="btn btn-primary" onClick={() => printWithTitle(`Balance Confirmation - ${vendor.name} - FY ${selectedFy}`)}>
              Print
            </button>
          </div>
        )}
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      <div className="card no-print" style={{ marginBottom: 20 }}>
        <div className="form-grid form-grid-3">
          <div className="form-field">
            <label htmlFor="vendor-f1">Vendor</label>
            <select id="vendor-f1" className="form-select" value={selectedVendorId} onChange={e => setSelectedVendorId(e.target.value)}>
              <option value="">— Select vendor —</option>
              {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="vendor-f2"><Tip text="Nepal fiscal year (Shrawan–Ashadh) the confirmation covers — matches how IRD Annexure 13 is reported, not a calendar year." width={280}>Fiscal Year</Tip></label>
            <select id="vendor-f2" className="form-select" value={selectedFy} onChange={e => setSelectedFy(e.target.value)} disabled={fyOptions.length === 0}>
              {fyOptions.map(fy => <option key={fy} value={fy}>FY {fy}</option>)}
            </select>
          </div>
        </div>
      </div>

      {loadError ? null : loading ? (
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
      ) : !selectedVendorId ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">⊙</div>
            <p className="empty-state-text">Select a vendor to generate a balance confirmation.</p>
          </div>
        </div>
      ) : periods.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">⊙</div>
            <p className="empty-state-text">No purchase periods set up yet.</p>
          </div>
        </div>
      ) : computing ? (
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Computing…</p>
      ) : isEmpty ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">⊙</div>
            <p className="empty-state-text">No purchase activity recorded with {vendor?.name} as of FY {selectedFy}.</p>
          </div>
        </div>
      ) : (
        <VendorBalanceConfirmationPrint
          bizInfo={{
            name: businessName,
            address: settings?.property_address || '',
            phone: settings?.property_phone || '',
            panLabel: settings?.is_vat_registered ? 'VAT No' : 'PAN No',
            pan: settings?.vat_number || '',
          }}
          vendor={vendor}
          fyLabel={selectedFy}
          fyStart={result.fyStart}
          fyEnd={result.fyEnd}
          openingBalance={result.openingBalance}
          schedule={result.schedule}
          totals={result.totals}
          closingBalance={result.closingBalance}
        />
      )}
    </div>
  )
}
