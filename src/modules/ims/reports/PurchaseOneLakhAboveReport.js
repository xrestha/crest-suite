import { useState, useEffect, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { getBsFiscalYear } from '../../../utils/bsCalendar'
import { buildVendorSummary } from './VatReport'
import { Navigate } from 'react-router-dom'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
const THRESHOLD = 100000

export default function PurchaseOneLakhAboveReport() {
  const { clientId, profile, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()

  const [periods, setPeriods] = useState([])
  const [fyOptions, setFyOptions] = useState([])
  const [selectedFy, setSelectedFy] = useState('')
  const [vendors, setVendors] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!effectiveClientId) return
    scopedFrom('monthly_periods')
      .then(({ data }) => {
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
    setLoading(true)
    const periodIds = periods
      .filter(p => getBsFiscalYear(p.bs_year, p.bs_month) === selectedFy)
      .map(p => p.id)

    if (periodIds.length === 0) { setVendors([]); setLoading(false); return }

    const [{ data: entData }, { data: retData }] = await Promise.all([
      supabase.from('purchase_entries')
        .select('*, vendors(name, pan_vat_no)').in('period_id', periodIds),
      scopedFrom('vendor_returns', '*, vendors(name, pan_vat_no), purchase_entries(vat_inclusive)').in('period_id', periodIds),
    ])
    const entries = entData || []

    const billGroups = {}
    entries.forEach(e => {
      const gid = e.purchase_group_id || e.id
      if (!billGroups[gid]) billGroups[gid] = { all: [], disc: parseFloat(e.discount_amount) || 0 }
      billGroups[gid].all.push(e)
    })

    // Annexure 13 discloses a vendor's TOTAL cumulative purchases for the fiscal year, not just
    // the VAT-taxable portion — the previous vatEntries/vatReturns filter (borrowed from
    // VatReport's own vendor summary, which genuinely only cares about VAT-taxable purchases)
    // silently dropped every non-VAT bill from the vendor total, understating or fully omitting
    // a vendor who should have been disclosed. Pass every entry, with the bill-level discount
    // prorated across the whole bill (discountScope:'all') rather than just its VAT-taxable lines.
    setVendors(buildVendorSummary(entries, retData || [], billGroups, { discountScope: 'all' }))
    setLoading(false)
  }, [effectiveClientId, selectedFy, periods, scopedFrom])

  useEffect(() => { load() }, [load])

  const rows = vendors.map(v => {
    const taxBase = v.gross - (v.discount || 0)
    const net = taxBase - v.returned
    return { ...v, taxBase, net }
  }).sort((a, b) => b.net - a.net)

  const totals = rows.reduce((s, v) => ({ gross: s.gross + v.gross, discount: s.discount + (v.discount || 0), taxBase: s.taxBase + v.taxBase, returned: s.returned + v.returned, net: s.net + v.net }), { gross: 0, discount: 0, taxBase: 0, returned: 0, net: 0 })

  function exportExcel() {
    const ws = XLSX.utils.json_to_sheet(rows.map(v => ({
      'Vendor': v.name,
      'PAN/VAT No.': v.pan,
      'Bills': v.count,
      'Gross (NPR)': Math.round(v.gross * 100) / 100,
      'Discount (NPR)': Math.round((v.discount || 0) * 100) / 100,
      'Taxable (NPR)': Math.round(v.taxBase * 100) / 100,
      'Returned (NPR)': Math.round(v.returned * 100) / 100,
      'Net (NPR)': Math.round(v.net * 100) / 100,
      'Annexure 13 (>1L)': v.net > THRESHOLD ? (v.pan ? 'Yes' : 'Yes — MISSING PAN') : '',
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Purchase One Lakh Above')
    XLSX.writeFile(wb, `purchase-one-lakh-above-${selectedFy.replace('/', '-')}.xlsx`)
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>
          Purchase One Lakh Above Report <Tip text="Nepal VAT return Annexure 13 (अनुसूची १३): any single vendor whose cumulative purchases exceed NPR 1,00,000 in a fiscal year must be disclosed by name+PAN. This aggregates purchases by vendor across the selected fiscal year and flags who crosses that threshold." width={320}>ⓘ</Tip>
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
          Vendor-wise purchases for the fiscal year — flags vendors above NPR 1,00,000 for Annexure 13 disclosure.
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Fiscal Year (BS)</label>
          <select className="form-select" value={selectedFy} onChange={e => setSelectedFy(e.target.value)}>
            {fyOptions.map(fy => <option key={fy} value={fy}>{fy}</option>)}
          </select>
        </div>
        <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={exportExcel} disabled={rows.length === 0}>⬇ Excel</button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">₨</div>
            <p className="empty-state-text">No VAT purchases in FY {selectedFy}.</p>
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
                  <Tip text="Taxable amount minus returns — the figure checked against the NPR 1,00,000 Annexure 13 threshold." width={280}>Net</Tip>
                </th>
                <th>
                  <Tip text="Rows above NPR 1,00,000 must be disclosed in Annexure 13 of the VAT return. A missing PAN on a flagged row means the vendor's name alone was recorded." width={280}>Flag</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(v => {
                const over = v.net > THRESHOLD
                return (
                  <tr key={v.name + v.pan}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{v.name}</td>
                    <td>{v.pan || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{v.count}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.gross)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.discount || 0)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.taxBase)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(v.returned)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{fmtNpr(v.net)}</td>
                    <td>
                      {over && !v.pan && <span className="badge-red" style={{ fontSize: 11 }}>⚠ Missing PAN</span>}
                      {over && v.pan && <span className="badge-amber" style={{ fontSize: 11 }}>Annexure 13</span>}
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
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
