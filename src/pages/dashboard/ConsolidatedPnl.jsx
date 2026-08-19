// Consolidated P&L — the formal statement no page was: Revenue → COGS → Gross Profit → operating
// costs → Net Profit, for one BS period, with every figure sourced from the module that owns it.
// "Consolidated" is meant in both senses. Phase 1 (this file) consolidates the MODULES — IMS cost,
// HR labour, overheads, POS/manual revenue — into one statement; phase 2 adds outlets (a grouped
// client gets one column per outlet plus a consolidated total, via a get_group_pnl RPC).
//
// It deliberately computes NOTHING of its own. Every line reuses the figure's canonical source:
//   Revenue  — MonthlySummary's rule: price-at-sale (unit_price) falling back to the recipe's
//              current price, minus per-row discounts, excluding 'pos_comp' rows.
//   COGS     — computeUsed() valued at items.per_uom_rate (is_active, is_sub_recipe=false —
//              MonthlySummary's convention; Stock Count includes prep, this page does not, and
//              the on-page note names the difference like S575's disclosures do).
//   Labour   — finalized HR payroll (gross + employer SSF, get_group_summary's definition) when a
//              finalized run exists; otherwise the overheads 'labor' bucket. NEVER both — the two
//              labour sources are never meant to be summed (see .claude/rules/dashboards.md), and
//              when both exist the ignored one is named on screen rather than silently dropped.
//   Overheads / Tax & Fees — the 'overhead' and 'tax_fees' buckets, each its own line.
//
// Defaults to the most recent CLOSED period: COGS subtracts closing stock, so an open period
// (closing = 0 for every item) paints a structurally wrong figure — the same rule Variance and
// Shrinkage follow. An open period can still be selected; it renders flagged as provisional.
import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { supabase } from '../../supabaseClient'
import { fetchAllRows } from '../../shared/fetchAllRows'
import SuiteGate from '../../components/SuiteGate'
import Tip from '../../components/Tip'
import NoPeriodState from '../../components/NoPeriodState'
import { printWithTitle } from '../../utils/printTitle'
import { computeUsed, COGS_FORMULA } from '../../shared/imsFormulas'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const npr = n => `NPR ${Math.round(n || 0).toLocaleString('en-NP')}`
const pctOf = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—')

export default function ConsolidatedPnl() {
  const { clientId, profile, loading: authLoading, clientModules } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()

  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [pnl, setPnl] = useState(null)
  const [loading, setLoading] = useState(true)

  // authLoading is a real dependency: a hard load lands here while auth is still resolving,
  // and with [clientId] alone the guard fails once and nothing ever re-fires — the page sits on
  // Loading… forever (caught live, first smoke test of this page).
  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId, authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const { data: p } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    setPeriods(p || [])
    // Closed-period default — COGS subtracts a closing count that an open period does not have.
    const target = (p || []).find(x => x.status === 'closed') || (p || [])[0]
    if (target) { setSelectedPeriod(target); await loadPeriod(target.id) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadPeriod(periodId)
    setLoading(false)
  }

  async function loadPeriod(periodId) {
    const [
      { data: items }, { data: opening }, { data: closing },
      { data: purchases }, { data: returns }, { data: wastages }, { data: staffMealsData },
      { data: salesData }, { data: recipes }, { data: overheadRows }, { data: runs },
    ] = await Promise.all([
      // MonthlySummary's exact conventions, so this statement's COGS ties to that page:
      // active items only (S436), sub-recipes excluded (prep is counted at the raw-item level).
      scopedFrom('items', 'id, per_uom_rate').eq('is_active', true).eq('is_sub_recipe', false),
      supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodId),
      supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', periodId),
      fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty, rate').eq('period_id', periodId).order('id')),
      scopedFrom('vendor_returns', 'item_id, qty, rate').eq('period_id', periodId),
      fetchAllRows(() => supabase.from('wastages').select('item_id, qty').eq('period_id', periodId).order('id')),
      supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId),
      fetchAllRows(() => supabase.from('sales_entries')
        .select('recipe_id, qty_sold, unit_price, discount').eq('period_id', periodId)
        .neq('source', 'pos_comp').order('id')),
      scopedFrom('recipes', 'id, selling_price'),
      supabase.from('overheads').select('bucket, amount').eq('period_id', periodId),
      scopedFrom('hr_payroll_runs', 'id, status').eq('period_id', periodId).eq('status', 'finalized'),
    ])

    // Revenue — price-at-sale with current-price fallback, net of per-row discounts, comps
    // already excluded by the query. Byte-for-byte MonthlySummary's rule.
    const currentPriceMap = {}
    ;(recipes || []).forEach(r => { currentPriceMap[r.id] = parseFloat(r.selling_price) || 0 })
    const revenue = (salesData || []).reduce((s, row) => {
      const price = row.unit_price != null ? parseFloat(row.unit_price) : (currentPriceMap[row.recipe_id] || 0)
      return s + parseFloat(row.qty_sold || 0) * price - (parseFloat(row.discount) || 0)
    }, 0)

    // Per-item quantity maps, valued at per_uom_rate and summed — the same shape MonthlySummary
    // builds per category, collapsed to one statement line each.
    const qtyMap = rows => {
      const m = {}
      ;(rows || []).forEach(r => { m[r.item_id] = (m[r.item_id] || 0) + (parseFloat(r.qty ?? r.physical_qty) || 0) })
      return m
    }
    const openMap = qtyMap(opening), closeMap = qtyMap(closing)
    const wasteMap = qtyMap(wastages), staffMap = qtyMap(staffMealsData)
    const purchVal = {}, retVal = {}
    ;(purchases || []).forEach(p => { purchVal[p.item_id] = (purchVal[p.item_id] || 0) + parseFloat(p.qty) * parseFloat(p.rate) })
    ;(returns || []).forEach(r => { retVal[r.item_id] = (retVal[r.item_id] || 0) + parseFloat(r.qty) * parseFloat(r.rate) })

    let openingVal = 0, purchasesVal = 0, returnsVal = 0, wastageVal = 0, staffMealsVal = 0, closingVal = 0
    ;(items || []).forEach(i => {
      const rate = parseFloat(i.per_uom_rate) || 0
      openingVal    += (openMap[i.id] || 0) * rate
      purchasesVal  += purchVal[i.id] || 0
      returnsVal    += retVal[i.id] || 0
      wastageVal    += (wasteMap[i.id] || 0) * rate
      staffMealsVal += (staffMap[i.id] || 0) * rate
      closingVal    += (closeMap[i.id] || 0) * rate
    })
    const cogs = computeUsed({
      opening: openingVal, purchases: purchasesVal, returns: returnsVal,
      wastage: wastageVal, staffMeals: staffMealsVal, closing: closingVal,
    })

    // Overheads by bucket. 'overhead' and 'tax_fees' are always their own lines; 'labor' is only
    // the labour figure when no finalized payroll exists (the two sources are never summed).
    const buckets = { overhead: 0, labor: 0, tax_fees: 0 }
    ;(overheadRows || []).forEach(r => {
      const b = buckets[r.bucket || 'overhead'] !== undefined ? (r.bucket || 'overhead') : 'overhead'
      buckets[b] += parseFloat(r.amount) || 0
    })

    // Labour — finalized payroll (gross + employer SSF, the same definition get_group_summary
    // uses) when a finalized run exists for this period.
    let payrollLabour = null
    const runIds = (runs || []).map(r => r.id)
    if (runIds.length > 0) {
      const { data: slips } = await supabase.from('hr_payslips')
        .select('gross, ssf_employer').in('run_id', runIds)
      payrollLabour = (slips || []).reduce((s, ps) => s + (parseFloat(ps.gross) || 0) + (parseFloat(ps.ssf_employer) || 0), 0)
    }
    const labour = payrollLabour != null ? payrollLabour : buckets.labor
    const labourSource = payrollLabour != null ? 'payroll' : buckets.labor > 0 ? 'overheads' : 'none'
    // When both exist, the ignored figure is named on screen rather than silently dropped.
    const ignoredLabourBucket = payrollLabour != null && buckets.labor > 0 ? buckets.labor : 0

    const grossProfit = revenue - cogs
    const netProfit = grossProfit - wastageVal - staffMealsVal - labour - buckets.overhead - buckets.tax_fees

    setPnl({
      revenue, cogs, grossProfit,
      wastageVal, staffMealsVal,
      labour, labourSource, ignoredLabourBucket,
      overheads: buckets.overhead, taxFees: buckets.tax_fees,
      netProfit,
      openingVal, purchasesVal, returnsVal, closingVal,
      hasClosing: (closing || []).length > 0,
    })
  }

  async function exportExcel() {
    if (!pnl) return
    const XLSX = await import('xlsx')
    const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : ''
    const line = (label, amount, pct) => ({ 'Line': label, 'Amount (NPR)': Math.round(amount), '% of Revenue': pct })
    const rows = [
      line('Revenue', pnl.revenue, '100.0%'),
      line('Cost of Goods Sold', -pnl.cogs, pctOf(pnl.cogs, pnl.revenue)),
      line('GROSS PROFIT', pnl.grossProfit, pctOf(pnl.grossProfit, pnl.revenue)),
      line('Wastage', -pnl.wastageVal, pctOf(pnl.wastageVal, pnl.revenue)),
      line('Staff Meals', -pnl.staffMealsVal, pctOf(pnl.staffMealsVal, pnl.revenue)),
      line(pnl.labourSource === 'payroll' ? 'Labour (finalized payroll)' : 'Labour (overheads entry)', -pnl.labour, pctOf(pnl.labour, pnl.revenue)),
      line('Overheads', -pnl.overheads, pctOf(pnl.overheads, pnl.revenue)),
      line('Tax & Fees', -pnl.taxFees, pctOf(pnl.taxFees, pnl.revenue)),
      line('NET PROFIT', pnl.netProfit, pctOf(pnl.netProfit, pnl.revenue)),
    ]
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'P&L')
    XLSX.writeFile(wb, `pnl-${periodLabel.replace(' ', '-')}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : ''
  const isOpen = selectedPeriod?.status === 'open'
  const hrOn = !!clientModules?.hr

  // A statement row. Negative-margin figures print in red-text; structure rows are bolded with a
  // top rule, matching how an accountant expects a P&L to read.
  const Row = ({ label, tip, amount, pct, negative, strong, muted, note }) => (
    <tr style={strong ? { fontWeight: 700, borderTop: '2px solid var(--theme-border)' } : undefined}>
      <td style={{ color: muted ? 'var(--theme-text3)' : 'var(--theme-text1)', fontWeight: strong ? 700 : 500 }}>
        {tip ? <Tip text={tip} width={300}>{label}</Tip> : label}
        {note && <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--theme-text3)' }}>{note}</span>}
      </td>
      <td style={{
        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
        fontWeight: strong ? 700 : 500,
        color: strong && amount < 0 ? 'var(--theme-red-text)' : strong && amount > 0 ? 'var(--theme-green-text)' : negative ? 'var(--theme-text2)' : 'var(--theme-text1)',
      }}>
        {negative && amount !== 0 ? `(${npr(amount)})` : npr(amount)}
      </td>
      <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>{pct}</td>
    </tr>
  )

  if (authLoading) return null

  return (
    <SuiteGate featureKey="consolidated_pnl" featureLabel="Consolidated P&L" requireModules={['ims']}>
      {!loading && periods.length === 0 ? <NoPeriodState what="the P&L statement" /> : (
        <div>
          <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h1 className="page-title">Profit &amp; Loss</h1>
              <p className="page-subtitle">One statement across every module — {periodLabel}</p>
            </div>
            <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }}
                onClick={() => printWithTitle(`Profit & Loss - ${periodLabel}`)}>🖨 Print</button>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel} disabled={!pnl}>Export Excel</button>
              <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''}
                onChange={e => handlePeriodChange(e.target.value)}>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>
                    {BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {isOpen && (
            <div style={{
              background: 'color-mix(in srgb, var(--theme-amber) 13%, transparent)',
              border: '1px solid var(--theme-amber)', borderRadius: 'var(--radius-md)',
              padding: '10px 14px', marginBottom: 16, fontSize: 13, color: 'var(--theme-amber-text)',
            }}>
              <strong>Provisional — this period is still open.</strong> Closing stock has not been
              counted yet, so COGS here treats closing stock as zero and overstates the true figure.
              The statement is reliable once the period is closed.
            </div>
          )}

          {loading ? (
            <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
          ) : !pnl ? null : (
            <>
              <div className="table-wrap" style={{ maxWidth: 760 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Line</th>
                      <th style={{ textAlign: 'right' }}>Amount</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Each line as a share of revenue — the standard common-size P&L reading." width={260}>% of Rev.</Tip>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <Row label="Revenue" amount={pnl.revenue} pct="100.0%"
                      tip="All sales for the period at the price actually charged (manual Sales Entry and POS together, counted once), net of discounts. Complimentary items are excluded — they were never paid for." />
                    <Row label="Cost of Goods Sold" negative amount={pnl.cogs} pct={pctOf(pnl.cogs, pnl.revenue)}
                      tip={`${COGS_FORMULA}. Valued at each item's per-unit rate. Sub-recipes are excluded (their raw ingredients are already counted) — same convention as Monthly Summary, so the two pages tie.`} />
                    <Row label="Gross Profit" strong amount={pnl.grossProfit} pct={pctOf(pnl.grossProfit, pnl.revenue)} />
                    <Row label="Wastage" negative amount={pnl.wastageVal} pct={pctOf(pnl.wastageVal, pnl.revenue)}
                      tip="Recorded wastage valued at cost. Broken out of COGS so spoiled stock is visible instead of hiding inside the food-cost line." />
                    <Row label="Staff Meals" negative amount={pnl.staffMealsVal} pct={pctOf(pnl.staffMealsVal, pnl.revenue)}
                      tip="Food consumed by staff, valued at cost — spent stock that earned no revenue, shown as its own line." />
                    <Row
                      label="Labour"
                      note={pnl.labourSource === 'payroll' ? 'from finalized payroll' : pnl.labourSource === 'overheads' ? 'from Overheads entry' : hrOn ? 'no finalized payroll run' : ''}
                      negative amount={pnl.labour} pct={pctOf(pnl.labour, pnl.revenue)}
                      tip="Finalized HR payroll for this period (gross pay + employer SSF) when a run exists; otherwise the manually-entered Labour bucket from Overheads. Never both — that would double-count." />
                    <Row label="Overheads" negative amount={pnl.overheads} pct={pctOf(pnl.overheads, pnl.revenue)}
                      tip="The Overheads page's 'overhead' bucket — rent, utilities, and other fixed costs. Labour and Tax & Fees buckets are their own lines." />
                    <Row label="Tax &amp; Fees" negative amount={pnl.taxFees} pct={pctOf(pnl.taxFees, pnl.revenue)}
                      tip="The Overheads page's 'tax & fees' bucket." />
                    <Row label="Net Profit" strong amount={pnl.netProfit} pct={pctOf(pnl.netProfit, pnl.revenue)} />
                  </tbody>
                </table>
              </div>

              {pnl.ignoredLabourBucket > 0 && (
                <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', marginTop: 12, maxWidth: 760 }}>
                  {npr(pnl.ignoredLabourBucket)} of manually-entered Labour in Overheads was <strong>not</strong> added
                  to this statement — finalized payroll is the labour figure when both exist, and summing the two
                  would count the same people twice. Remove the manual entry if it duplicates payroll.
                </p>
              )}
              {!pnl.hasClosing && !isOpen && (
                <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', marginTop: 12, maxWidth: 760 }}>
                  This period was closed without a closing stock count — COGS treats closing stock as zero
                  and is overstated by whatever was actually on hand.
                </p>
              )}
              <p style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 12, maxWidth: 760 }}>
                Figures come from each module&apos;s own canonical source: revenue and COGS tie to Monthly
                Summary, labour to the finalized Payroll run, overheads to the Overheads page. Stock Count&apos;s
                Summary includes sub-recipes in its COGS; this statement, like Monthly Summary, counts their
                raw ingredients instead — the two differ by exactly the prep amount.
              </p>
            </>
          )}
        </div>
      )}
    </SuiteGate>
  )
}
