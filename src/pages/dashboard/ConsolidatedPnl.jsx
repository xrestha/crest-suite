// Consolidated P&L — the formal statement no page was: Revenue → COGS → Gross Profit → operating
// costs → Net Profit, for one BS period, with every figure sourced from the module that owns it.
// "Consolidated" is meant in both senses. Phase 1 consolidates the MODULES — IMS cost, HR labour,
// overheads, POS/manual revenue — into one statement; phase 2 consolidates OUTLETS: an owner whose
// client belongs to a group gets one column per Suite Pro outlet plus a consolidated total, via
// get_group_pnl() (raw aggregates only — the page derives COGS, so the formula stays in one place).
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
//              In the group view the rule applies PER OUTLET before consolidating, since one
//              outlet can run payroll while a sibling enters labour manually.
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

// One definition of the statement's lines, shared by the single-outlet table, the group matrix
// and the Excel export — two hand-written copies of labels and tips is how they would drift.
const LINES = [
  { key: 'revenue', label: 'Revenue',
    tip: 'All sales for the period at the price actually charged (manual Sales Entry and POS together, counted once), net of discounts. Complimentary items are excluded — they were never paid for.' },
  { key: 'cogs', label: 'Cost of Goods Sold', cost: true,
    tip: `${COGS_FORMULA}. Valued at each item's per-unit rate. Sub-recipes are excluded (their raw ingredients are already counted) — same convention as Monthly Summary, so the two pages tie.` },
  { key: 'grossProfit', label: 'Gross Profit', strong: true },
  { key: 'wastageVal', label: 'Wastage', cost: true,
    tip: 'Recorded wastage valued at cost. Broken out of COGS so spoiled stock is visible instead of hiding inside the food-cost line.' },
  { key: 'staffMealsVal', label: 'Staff Meals', cost: true,
    tip: 'Food consumed by staff, valued at cost — spent stock that earned no revenue, shown as its own line.' },
  { key: 'labour', label: 'Labour', cost: true,
    tip: 'Finalized HR payroll for this period (gross pay + employer SSF) when a run exists; otherwise the manually-entered Labour bucket from Overheads. Never both — that would double-count.' },
  { key: 'overheads', label: 'Overheads', cost: true,
    tip: "The Overheads page's 'overhead' bucket — rent, utilities, and other fixed costs. Labour and Tax & Fees buckets are their own lines." },
  { key: 'taxFees', label: 'Tax & Fees', cost: true,
    tip: "The Overheads page's 'tax & fees' bucket." },
  { key: 'netProfit', label: 'Net Profit', strong: true },
]

// Raw component aggregates → the statement. The one place the lines are derived, whether the raw
// figures came from the browser queries (single outlet) or get_group_pnl (per outlet in a group).
function buildStatement(raw) {
  const cogs = computeUsed({
    opening: raw.openingVal, purchases: raw.purchasesVal, returns: raw.returnsVal,
    wastage: raw.wastageVal, staffMeals: raw.staffMealsVal, closing: raw.closingVal,
  })
  const labour = raw.labourPayroll != null ? raw.labourPayroll : raw.labourBucket
  const grossProfit = raw.revenue - cogs
  const netProfit = grossProfit - raw.wastageVal - raw.staffMealsVal - labour - raw.overheads - raw.taxFees
  return {
    revenue: raw.revenue, cogs, grossProfit,
    wastageVal: raw.wastageVal, staffMealsVal: raw.staffMealsVal,
    labour, overheads: raw.overheads, taxFees: raw.taxFees, netProfit,
    labourSource: raw.labourPayroll != null ? 'payroll' : raw.labourBucket > 0 ? 'overheads' : 'none',
    ignoredLabourBucket: raw.labourPayroll != null && raw.labourBucket > 0 ? raw.labourBucket : 0,
    hasClosing: raw.hasClosing,
  }
}

const lineColor = (line, amount) =>
  line.strong && amount < 0 ? 'var(--theme-red-text)'
  : line.strong && amount > 0 ? 'var(--theme-green-text)'
  : line.cost ? 'var(--theme-text2)' : 'var(--theme-text1)'

const fmtLine = (line, amount) => (line.cost && amount !== 0 ? `(${npr(amount)})` : npr(amount))

export default function ConsolidatedPnl() {
  const { clientId, profile, loading: authLoading, clientModules, outlets } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  // Grouped owners get the matrix; everyone else (single outlet, and admin — my_group_id() reads
  // the caller's own profile row, which an admin JWT doesn't have) gets the single statement.
  const grouped = (outlets || []).length > 1

  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [pnl, setPnl] = useState(null)             // single-outlet statement
  const [groupCols, setGroupCols] = useState(null) // [{ name, status, hasPeriod, stmt }] for included outlets
  const [excludedNames, setExcludedNames] = useState([])
  const [groupError, setGroupError] = useState(null)
  const [loading, setLoading] = useState(true)

  // authLoading is a real dependency: a hard load lands here while auth is still resolving, and
  // with [clientId] alone the guard fails once and nothing ever re-fires — the page sits on
  // Loading… forever (caught live, first smoke test of this page).
  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId, authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const { data: p } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    setPeriods(p || [])
    // Closed-period default — COGS subtracts a closing count that an open period does not have.
    const target = (p || []).find(x => x.status === 'closed') || (p || [])[0]
    if (target) { setSelectedPeriod(target); await loadPeriod(target) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadPeriod(p)
    setLoading(false)
  }

  async function loadPeriod(period) {
    if (grouped) return loadGroup(period)
    return loadSingle(period.id)
  }

  /* ── Grouped: one RPC, raw aggregates per outlet, derived here ─────────────────────────── */
  async function loadGroup(period) {
    setGroupError(null)
    const { data, error } = await supabase.rpc('get_group_pnl', {
      p_bs_year: period.bs_year, p_bs_month: period.bs_month,
    })
    // A failed RPC must not masquerade as the no-Suite-Pro empty state — 'nothing to show' and
    // 'could not load' are different facts, and only one of them should send someone to billing.
    if (error) { console.error('get_group_pnl failed:', error); setGroupCols([]); setGroupError(error.message || 'Could not load the group statement.'); return }
    const rows = data || []
    setExcludedNames(rows.filter(r => !r.is_included).map(r => r.client_name))
    setGroupCols(rows.filter(r => r.is_included).map(r => ({
      name: r.client_name,
      status: r.period_status,
      hasPeriod: r.has_period,
      stmt: buildStatement({
        revenue: parseFloat(r.revenue) || 0,
        openingVal: parseFloat(r.opening_val) || 0,
        purchasesVal: parseFloat(r.purchases_val) || 0,
        returnsVal: parseFloat(r.returns_val) || 0,
        wastageVal: parseFloat(r.wastage_val) || 0,
        staffMealsVal: parseFloat(r.staff_meals_val) || 0,
        closingVal: parseFloat(r.closing_val) || 0,
        labourPayroll: r.labour_payroll != null ? parseFloat(r.labour_payroll) : null,
        labourBucket: parseFloat(r.labour_bucket) || 0,
        overheads: parseFloat(r.overheads_val) || 0,
        taxFees: parseFloat(r.tax_fees_val) || 0,
        hasClosing: !!r.has_closing,
      }),
    })))
  }

  /* ── Single outlet: the same conventions, fetched from the browser ─────────────────────── */
  async function loadSingle(periodId) {
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

    // Overheads by bucket. 'overhead' and 'tax_fees' are always their own lines; 'labor' is only
    // the labour figure when no finalized payroll exists (the two sources are never summed).
    const buckets = { overhead: 0, labor: 0, tax_fees: 0 }
    ;(overheadRows || []).forEach(r => {
      const b = buckets[r.bucket || 'overhead'] !== undefined ? (r.bucket || 'overhead') : 'overhead'
      buckets[b] += parseFloat(r.amount) || 0
    })

    // Labour — finalized payroll (gross + employer SSF, the same definition get_group_summary
    // uses) when a finalized run exists for this period.
    let labourPayroll = null
    const runIds = (runs || []).map(r => r.id)
    if (runIds.length > 0) {
      const { data: slips } = await supabase.from('hr_payslips')
        .select('gross, ssf_employer').in('run_id', runIds)
      labourPayroll = (slips || []).reduce((s, ps) => s + (parseFloat(ps.gross) || 0) + (parseFloat(ps.ssf_employer) || 0), 0)
    }

    setPnl(buildStatement({
      revenue, openingVal, purchasesVal, returnsVal, wastageVal, staffMealsVal, closingVal,
      labourPayroll, labourBucket: buckets.labor, overheads: buckets.overhead, taxFees: buckets.tax_fees,
      hasClosing: (closing || []).length > 0,
    }))
  }

  /* ── Derived render state ──────────────────────────────────────────────────────────────── */
  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : ''
  const hrOn = !!clientModules?.hr
  const cols = grouped ? (groupCols || []) : []
  // Consolidated = per-line sums over the outlet statements. The labour rule already applied per
  // outlet, and every other line is linear, so summing lines equals deriving from summed inputs.
  const consolidated = cols.length > 0 ? LINES.reduce((acc, l) => {
    acc[l.key] = cols.reduce((s, c) => s + (c.stmt[l.key] || 0), 0)
    return acc
  }, {}) : null
  const anyOpen = grouped
    ? cols.some(c => c.status === 'open')
    : selectedPeriod?.status === 'open'
  const missingClosing = grouped
    ? cols.filter(c => c.hasPeriod && c.status === 'closed' && !c.stmt.hasClosing).map(c => c.name)
    : (pnl && !pnl.hasClosing && selectedPeriod?.status === 'closed' ? ['this period'] : [])
  const ignoredBuckets = grouped
    ? cols.filter(c => c.stmt.ignoredLabourBucket > 0).map(c => ({ name: c.name, amount: c.stmt.ignoredLabourBucket }))
    : (pnl?.ignoredLabourBucket > 0 ? [{ name: null, amount: pnl.ignoredLabourBucket }] : [])

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    let rows
    if (grouped && cols.length > 0) {
      rows = LINES.map(l => {
        const row = { 'Line': l.label }
        cols.forEach(c => { row[c.name] = Math.round((l.cost ? -1 : 1) * (c.stmt[l.key] || 0)) })
        row['Consolidated'] = Math.round((l.cost ? -1 : 1) * (consolidated[l.key] || 0))
        row['% of Revenue'] = l.key === 'revenue' ? '100.0%' : pctOf(consolidated[l.key], consolidated.revenue)
        return row
      })
    } else if (pnl) {
      rows = LINES.map(l => ({
        'Line': l.label,
        'Amount (NPR)': Math.round((l.cost ? -1 : 1) * (pnl[l.key] || 0)),
        '% of Revenue': l.key === 'revenue' ? '100.0%' : pctOf(pnl[l.key], pnl.revenue),
      }))
    } else return
    const ws = XLSX.utils.json_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, ws, 'P&L')
    XLSX.writeFile(wb, `pnl-${periodLabel.replace(' ', '-')}.xlsx`)
  }

  if (authLoading) return null

  const warnStyle = {
    background: 'color-mix(in srgb, var(--theme-amber) 13%, transparent)',
    border: '1px solid var(--theme-amber)', borderRadius: 'var(--radius-md)',
    padding: '10px 14px', marginBottom: 16, fontSize: 13, color: 'var(--theme-amber-text)',
  }

  return (
    <SuiteGate featureKey="consolidated_pnl" featureLabel="Consolidated P&L" requireModules={['ims']}>
      {!loading && periods.length === 0 ? <NoPeriodState what="the P&L statement" /> : (
        <div>
          <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <h1 className="page-title">Profit &amp; Loss</h1>
              <p className="page-subtitle">
                {grouped ? `Every outlet side by side, one statement — ${periodLabel}` : `One statement across every module — ${periodLabel}`}
              </p>
            </div>
            <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }}
                onClick={() => printWithTitle(`Profit & Loss - ${periodLabel}`)}>🖨 Print</button>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel} disabled={!pnl && cols.length === 0}>Export Excel</button>
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

          {anyOpen && (
            <div style={warnStyle}>
              <strong>Provisional — {grouped ? 'at least one outlet’s month is still open.' : 'this period is still open.'}</strong>{' '}
              Closing stock has not been counted yet, so COGS treats closing stock as zero and
              overstates the true figure. The statement is reliable once the period is closed.
            </div>
          )}

          {loading ? (
            <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
          ) : grouped ? (
            groupError ? (
              <p role="alert" style={{ color: 'var(--theme-red-text)', fontSize: 13 }}>
                Could not load the group statement: {groupError}
              </p>
            ) : cols.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)' }}>
                No outlet in your group has Crest Suite Pro for {periodLabel}.
              </p>
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Line</th>
                        {cols.map(c => (
                          <th key={c.name} style={{ textAlign: 'right' }}>
                            {c.name}
                            {!c.hasPeriod ? <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--theme-text3)' }}>no period</span>
                              : c.status === 'open' ? <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--theme-amber-text)' }}>open</span> : null}
                          </th>
                        ))}
                        <th style={{ textAlign: 'right' }}>Consolidated</th>
                        <th style={{ textAlign: 'right' }}>
                          <Tip text="Each consolidated line as a share of consolidated revenue." width={260}>% of Rev.</Tip>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {LINES.map(l => (
                        <tr key={l.key} style={l.strong ? { fontWeight: 700, borderTop: '2px solid var(--theme-border)' } : undefined}>
                          <td style={{ fontWeight: l.strong ? 700 : 500, color: 'var(--theme-text1)' }}>
                            {l.tip ? <Tip text={l.tip} width={300}>{l.label}</Tip> : l.label}
                          </td>
                          {cols.map(c => (
                            <td key={c.name} style={{
                              textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                              color: c.hasPeriod ? lineColor(l, c.stmt[l.key]) : 'var(--theme-text3)',
                            }}>
                              {c.hasPeriod ? fmtLine(l, c.stmt[l.key]) : '—'}
                            </td>
                          ))}
                          <td style={{
                            textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                            color: lineColor({ ...l, strong: true }, consolidated[l.key]),
                          }}>
                            {fmtLine(l, consolidated[l.key])}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                            {l.key === 'revenue' ? '100.0%' : pctOf(consolidated[l.key], consolidated.revenue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {excludedNames.length > 0 && (
                  <p style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 12 }}>
                    Not included (no Crest Suite Pro on that outlet): {excludedNames.join(', ')}. Suite Pro
                    is per outlet — the consolidated figures cover only the outlets shown.
                  </p>
                )}
              </>
            )
          ) : !pnl ? null : (
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
                  {LINES.map(l => (
                    <tr key={l.key} style={l.strong ? { fontWeight: 700, borderTop: '2px solid var(--theme-border)' } : undefined}>
                      <td style={{ color: 'var(--theme-text1)', fontWeight: l.strong ? 700 : 500 }}>
                        {l.tip ? <Tip text={l.tip} width={300}>{l.label}</Tip> : l.label}
                        {l.key === 'labour' && (
                          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--theme-text3)' }}>
                            {pnl.labourSource === 'payroll' ? 'from finalized payroll'
                              : pnl.labourSource === 'overheads' ? 'from Overheads entry'
                              : hrOn ? 'no finalized payroll run' : ''}
                          </span>
                        )}
                      </td>
                      <td style={{
                        textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                        fontWeight: l.strong ? 700 : 500, color: lineColor(l, pnl[l.key]),
                      }}>
                        {fmtLine(l, pnl[l.key])}
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                        {l.key === 'revenue' ? '100.0%' : pctOf(pnl[l.key], pnl.revenue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && (
            <>
              {ignoredBuckets.map(b => (
                <p key={b.name || 'single'} style={{ fontSize: 12, color: 'var(--theme-amber-text)', marginTop: 12, maxWidth: 900 }}>
                  {npr(b.amount)} of manually-entered Labour in Overheads{b.name ? ` at ${b.name}` : ''} was{' '}
                  <strong>not</strong> added to this statement — finalized payroll is the labour figure when
                  both exist, and summing the two would count the same people twice. Remove the manual entry
                  if it duplicates payroll.
                </p>
              ))}
              {missingClosing.length > 0 && !anyOpen && (
                <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', marginTop: 12, maxWidth: 900 }}>
                  {grouped
                    ? `Closed without a closing stock count: ${missingClosing.join(', ')} — COGS there treats closing stock as zero and is overstated by whatever was actually on hand.`
                    : 'This period was closed without a closing stock count — COGS treats closing stock as zero and is overstated by whatever was actually on hand.'}
                </p>
              )}
              {(pnl || cols.length > 0) && (
                <p style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 12, maxWidth: 900 }}>
                  Figures come from each module&apos;s own canonical source: revenue and COGS tie to Monthly
                  Summary, labour to the finalized Payroll run, overheads to the Overheads page. Stock Count&apos;s
                  Summary includes sub-recipes in its COGS; this statement, like Monthly Summary, counts their
                  raw ingredients instead — the two differ by exactly the prep amount.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </SuiteGate>
  )
}
