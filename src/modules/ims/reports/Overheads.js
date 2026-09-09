import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { BS_MONTHS, daysInBsMonth } from '../../../utils/bsCalendar'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { disabledStyle } from '../../../shared/inlineFieldState'

// labor's blue has no dedicated theme token — accent/green/red/amber/purple are already spoken
// for by food/overhead/profit-loss/target-warning/tax elsewhere on this page, so it stays a fixed
// hex (same reasoning as a chart legend needing more distinct hues than the semantic token set).
const BUCKET_CONFIG = {
  overhead: {
    label: 'Fixed Overheads',
    color: 'var(--theme-accent)',
    textColor: 'var(--theme-accent-ink)',
    target: 25,
    presets: ['Rent', 'Utilities', 'Tech & Software', 'Marketing', 'Insurance', 'Miscellaneous'],
    placeholders: {
      'Rent':           'e.g. Shop lease — Jhamsikhel 3rd floor',
      'Utilities':      'e.g. Electricity, water, gas combined',
      'Tech & Software':'e.g. POS system, music license, Wi-Fi',
      'Marketing':      'e.g. Instagram ads, flyers, promotions',
      'Insurance':      'e.g. Business property & liability insurance',
      'Miscellaneous':  'e.g. Repairs, cleaning supplies, misc',
    }
  },
  labor: {
    label: 'Labor Costs',
    color: 'var(--theme-text1)',
    textColor: 'var(--theme-text1)',
    target: 30,
    presets: ['Manager / Head Chef', 'Kitchen Staff', 'Service Staff', 'Part-time / Hourly', 'Benefits & Bonuses'],
    placeholders: {
      'Manager / Head Chef': 'e.g. Fixed monthly salary',
      'Kitchen Staff':       'e.g. 3 cooks × NPR 18,000',
      'Service Staff':       'e.g. 2 servers × NPR 15,000',
      'Part-time / Hourly':  'e.g. Estimated hourly wages this month',
      'Benefits & Bonuses':  'e.g. Festival bonuses, provident fund',
    }
  },
  tax_fees: {
    label: 'Tax & Fees',
    color: 'var(--theme-purple)',
    textColor: 'var(--theme-purple-text)',
    target: 5,
    presets: ['VAT Compliance', 'Card Processing', 'Bank Charges', 'License & Permits', 'Accountant Fees'],
    placeholders: {
      'VAT Compliance':   'e.g. Monthly VAT filing costs',
      'Card Processing':  'e.g. FonePay / eSewa processing fee estimate',
      'Bank Charges':     'e.g. Monthly bank maintenance fees',
      'License & Permits':'e.g. Food safety permit renewal',
      'Accountant Fees':  'e.g. Monthly bookkeeping or CA fees',
    }
  }
}

const emptyRow = (category = '') => ({ id: null, category, description: '', amount: '', _dirty: true })

function seedBucket(key) {
  return BUCKET_CONFIG[key].presets.map(cat => emptyRow(cat))
}

export default function Overheads() {
  const { profile, clientId, isAdmin, hasImsAccess, clientModules } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedDelete } = useScopedDb()
  const hrOn = !!clientModules?.hr

  const [periods, setPeriods]       = useState([])
  const [periodId, setPeriodId]     = useState('')
  const [rows, setRows]             = useState({ overhead: [], labor: [], tax_fees: [] })
  const [activeBucket, setActiveBucket] = useState('overhead')
  const [periodData, setPeriodData] = useState(null)
  const [loading, setLoading]       = useState(true)
  const [loadError, setLoadError]   = useState(null)
  const [saving, setSaving]         = useState(false)
  const [saved, setSaved]           = useState(false)
  const [saveError, setSaveError]   = useState(null)

  useEffect(() => { if (effectiveClientId) loadPeriods() }, [effectiveClientId]) // eslint-disable-line react-hooks/exhaustive-deps
  // `hrOn` is a dependency, not just an input: for an ADMIN viewing a client it comes from
  // `viewModules`, which resolves on its own schedule — so the first load can run with hrOn=false
  // and silently fall back to the Labor bucket on a client who does run payroll. Re-run when it
  // settles. It is memoized in AuthContext, so this cannot loop.
  useEffect(() => { if (periodId) loadAll() }, [periodId, hrOn]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadPeriods() {
    const { data, error } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
    // A failed read must not impersonate "no periods yet" (S612 silent-zero rule).
    if (error) { setLoadError(error.message); setLoading(false); return }
    const withLabel = (data || []).map(p => ({ ...p, label: `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` }))
    setPeriods(withLabel)
    const open = withLabel.find(p => p.status === 'open') || withLabel[0]
    if (open) setPeriodId(open.id)
  }

  async function loadAll() {
    setLoading(true)
    setLoadError(null)
    await Promise.all([loadOverheads(), loadPeriodData()])
    setLoading(false)
  }

  async function loadOverheads() {
    const { data, error } = await scopedFrom('overheads')
      .eq('period_id', periodId)
      .order('created_at')
    // A failed read must NOT fall into the carry-forward branch below: it would seed an editable
    // draft over a period that may have real saved rows, and Save would replace them (S612 —
    // on a data-entry page the silent-zero class is a data-loss class).
    if (error) { setLoadError(error.message); return }

    if (data && data.length > 0) {
      const grouped = { overhead: [], labor: [], tax_fees: [] }
      data.forEach(r => {
        const b = r.bucket || 'overhead'
        if (grouped[b]) grouped[b].push({ ...r, _dirty: false })
        else grouped.overhead.push({ ...r, _dirty: false })
      })
      Object.keys(BUCKET_CONFIG).forEach(b => {
        if (grouped[b].length === 0) grouped[b] = seedBucket(b)
      })
      setRows(grouped)
      return
    }

    // This period has never been saved — most fixed costs (rent, salaries, licenses) don't
    // actually change month to month, so starting from a blank sheet every period forces the
    // user to re-type the same numbers. Carry forward the nearest prior period's own saved rows
    // as an editable draft instead (_dirty: true, so nothing is written to the DB — and Save
    // stays disabled on a closed period — until the user actually hits Save).
    const currentIdx = periods.findIndex(p => p.id === periodId)
    const priorPeriods = currentIdx >= 0 ? periods.slice(currentIdx + 1) : []
    const prior = await findMostRecentOverheads(priorPeriods)
    if (prior.error) { setLoadError(prior.error); return }
    const priorRows = prior.rows

    const grouped = { overhead: [], labor: [], tax_fees: [] }
    if (priorRows) {
      priorRows.forEach(r => {
        const b = r.bucket || 'overhead'
        const row = { id: null, category: r.category, description: r.description, amount: r.amount, _dirty: true }
        if (grouped[b]) grouped[b].push(row)
        else grouped.overhead.push(row)
      })
    }
    Object.keys(BUCKET_CONFIG).forEach(b => {
      if (grouped[b].length === 0) grouped[b] = seedBucket(b)
    })
    setRows(grouped)
  }

  // Returns the chronologically nearest prior period's saved overhead rows, or null if none of
  // them ever had any. One .in() read over all candidates, then the walk happens in memory — the
  // old shape queried one period at a time, so a client with a gap in their overhead history paid
  // one round trip per empty month on the page's primary workflow (first visit to a new month).
  // A single read also removes the failed-mid-walk ambiguity: a failed read must not read as
  // "those periods had nothing" — the caller would carry forward from an older period than the
  // truth, as an editable draft (S612).
  async function findMostRecentOverheads(candidatePeriods) {
    if (candidatePeriods.length === 0) return { rows: null, error: null }
    // Paged: rows-per-period × period count can cross the silent 1000-row cap on a long-lived
    // client, and a truncated read here could drop the nearest period's rows entirely (S529).
    // The id tiebreaker keeps created_at's paging stable.
    const { data, error } = await fetchAllRows(() => scopedFrom('overheads')
      .in('period_id', candidatePeriods.map(p => p.id))
      .order('created_at').order('id'))
    if (error) return { rows: null, error: error.message }
    const byPeriod = new Map()
    ;(data || []).forEach(r => {
      const list = byPeriod.get(r.period_id)
      if (list) list.push(r)
      else byPeriod.set(r.period_id, [r])
    })
    // candidatePeriods arrives nearest-first; the first with rows wins, same as the old walk.
    for (const p of candidatePeriods) {
      const rows = byPeriod.get(p.id)
      if (rows && rows.length > 0) return { rows, error: null }
    }
    return { rows: null, error: null }
  }

  async function loadPeriodData() {
    const results = await Promise.all([
      fetchAllRows(() => supabase.from('purchase_entries').select('qty, rate').eq('period_id', periodId).order('id')),
      scopedFrom('vendor_returns', 'qty, rate').eq('period_id', periodId),
      // Revenue excludes comps (source='pos_comp') — a comped dish was never paid for — but the
      // filter is applied in JS below, NOT as `.neq('source','pos_comp')`. `sales_entries.source`
      // is nullable (DEFAULT 'manual', no NOT NULL), and in SQL `NULL <> 'pos_comp'` is NULL, so
      // the server-side form silently dropped every legacy manual row from REVENUE. On a
      // dashboard that under-reports one figure; on THIS page revenue is the denominator of every
      // percentage, and the numerator (food cost, from purchases) stayed whole — so Food Cost %
      // and every "% of revenue" read HIGH, break-even read HIGH, and Net Profit read LOW, which
      // is the sign of the "✓ Profitable / ✗ Operating at a loss" verdict directly below it.
      // Pinned by salesReads.test.js, which is why `source` must stay in the column list.
      fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price, discount, source').eq('period_id', periodId).order('id')),
      scopedFrom('recipes', 'id, selling_price'),
      // Labour is payroll XOR the Overheads 'labor' bucket, never the sum (.claude/rules/
      // dashboards.md). Only asked for when HR is on; `{ data: [] }` keeps the tuple shape.
      hrOn ? scopedFrom('hr_payroll_runs', 'id, status').eq('period_id', periodId).eq('status', 'finalized') : { data: [] },
    ])
    // The reference figures (revenue, food cost) must not print as NPR 0 off a failed read (S612).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setPeriodData(null); return }
    const [
      { data: purchases },
      { data: returns },
      { data: salesData },
      { data: recipes },
      { data: runs }
    ] = results

    // Finalized payroll for this period — gross + employer SSF, the same definition
    // get_group_summary and ConsolidatedPnl use, so the three never disagree about what labour
    // costs. A finalized run whose payslips cannot be read must REFUSE rather than fall through
    // to the Overheads bucket: that would quietly substitute a different labour source for the
    // one the page says it used.
    let labourPayroll = null
    const runIds = (runs || []).map(r => r.id)
    if (runIds.length > 0) {
      const { data: slips, error: slipErr } = await scopedFrom('hr_payslips', 'gross, ssf_employer').in('run_id', runIds)
      if (slipErr) { setLoadError(slipErr.message); setPeriodData(null); return }
      labourPayroll = (slips || []).reduce((s, ps) => s + (parseFloat(ps.gross) || 0) + (parseFloat(ps.ssf_employer) || 0), 0)
    }

    const gross  = (purchases || []).reduce((s, p) => s + parseFloat(p.qty || 0) * parseFloat(p.rate || 0), 0)
    const ret    = (returns  || []).reduce((s, r) => s + parseFloat(r.qty || 0) * parseFloat(r.rate || 0), 0)
    const foodCost = gross - ret

    const recipeMap = {}
    ;(recipes || []).forEach(r => { recipeMap[r.id] = parseFloat(r.selling_price) || 0 })
    // unit_price captured on the row (price actually charged) used per-row when present, else
    // falls back to the recipe's current price — previously always used the current price, so
    // this period's revenue silently reflected today's menu price, not what was charged then.
    const soldMap = {}, revenueBySold = {}
    ;(salesData || []).forEach(s => {
      if (s.source === 'pos_comp') return   // never billed; see the read above
      const qty = parseFloat(s.qty_sold || 0)
      const price = s.unit_price != null ? parseFloat(s.unit_price) : (recipeMap[s.recipe_id] || 0)
      soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + qty
      revenueBySold[s.recipe_id] = (revenueBySold[s.recipe_id] || 0) + qty * price - (parseFloat(s.discount) || 0)
    })
    const revenue = Object.values(revenueBySold).reduce((s, v) => s + v, 0)
    // DISHES, not covers. This is Σ qty_sold — one unit per portion sold, so a table of four
    // sharing three plates is three, not four. `covers` is a real and DIFFERENT figure in this
    // product (`pos_orders.covers`, the Covers Report, the Demand Forecast) meaning guests on a
    // bill, and Help says plainly that covers come from POS bills and manual Sales Entries carry
    // none. This page reads sales_entries, so covers are not available to it for an IMS-only
    // client — the figure is honest, the old label was not. Comps are excluded from both revenue
    // and the count so avg dish price divides like with like.
    const dishes  = Object.values(soldMap).reduce((s, qty) => s + qty, 0)

    setPeriodData({ revenue, foodCost, dishes, labourPayroll })
  }

  function updateRow(bucket, idx, field, value) {
    setRows(prev => ({
      ...prev,
      [bucket]: prev[bucket].map((row, i) => i === idx ? { ...row, [field]: value, _dirty: true } : row)
    }))
  }

  function addRow(bucket) {
    setRows(prev => ({ ...prev, [bucket]: [...prev[bucket], emptyRow()] }))
  }

  function removeRow(bucket, idx) {
    setRows(prev => ({ ...prev, [bucket]: prev[bucket].filter((_, i) => i !== idx) }))
  }

  // Replace-the-period save: delete this period's rows, then insert what is on screen. Neither
  // half used to be checked, and supabase-js RESOLVES with `{ error }` rather than throwing — so
  // a bare `await` discarded the only evidence either call failed and the button said "✓ Saved"
  // regardless. Both failure directions were live:
  //
  //   delete fails, insert lands  → the period holds BOTH versions, and every consumer that sums
  //                                 it double-counts (ClientDashboard's overheadTotal, Owner
  //                                 Dashboard, the Monthly Owner Report, Recipes' True Cost
  //                                 allocation, get_group_pnl).
  //   delete lands, insert fails  → the period is EMPTY. `loadOverheads()` then found nothing,
  //                                 fell into the carry-forward branch and seeded the previous
  //                                 month's figures as a draft — so the owner was shown plausible
  //                                 numbers under a success tick, over data that no longer
  //                                 existed. That reload is now skipped on failure: the rows in
  //                                 state are the only surviving copy of what they typed.
  //
  // The read path above has carried a comment about exactly this class since S612 ("on a
  // data-entry page the silent-zero class is a data-loss class"); the write path had no guard.
  async function save() {
    if (!effectiveClientId) { setSaveError('Nothing was saved — no client is selected. Pick one in the switcher at the top left, then save again.'); return }
    setSaving(true)
    setSaveError(null)

    // Ordered so the half that can refuse comes FIRST: nothing has been destroyed yet, so this
    // failure is a clean no-op and the message can say so.
    const { error: delErr } = await scopedDelete('overheads').eq('period_id', periodId)
    if (delErr) {
      const { text, detail } = asActionError(delErr)
      setSaveError({ text: `Nothing was saved and nothing was changed — this period's saved figures are still as they were. ${text}`, detail })
      setSaving(false)
      return
    }

    const inserts = []
    Object.entries(rows).forEach(([bucket, bucketRows]) => {
      bucketRows
        .filter(r => r.category?.trim() && parseFloat(r.amount) > 0)
        .forEach(r => inserts.push({
          period_id:   periodId,
          bucket,
          category:    r.category.trim(),
          description: r.description?.trim() || '',
          amount:      parseFloat(r.amount) || 0,
        }))
    })

    if (inserts.length > 0) {
      const { error: insErr } = await scopedInsert('overheads', inserts)
      if (insErr) {
        const { text, detail } = asActionError(insErr)
        // The delete already committed. Never claim the write did not land — a dead fetch cannot
        // prove that — and name the state the record is now in plus the way out (S619).
        setSaveError({
          text: `This period's fixed costs were cleared but the new figures did not save, so ${period?.label || 'this period'} currently has none stored. Everything you entered is still on screen and has NOT been lost — press Save again. Do not reload the page first. ${text}`,
          detail,
        })
        setSaving(false)
        return   // deliberately no reload: it would replace the only surviving copy with a carry-forward draft
      }
    }

    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    await loadOverheads()
  }

  const totals = useMemo(() => ({
    overhead: rows.overhead.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
    labor:    rows.labor.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
    tax_fees: rows.tax_fees.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
  }), [rows])

  const revenue  = periodData?.revenue  || 0
  const foodCost = periodData?.foodCost || 0
  const dishes   = periodData?.dishes   || 0

  // Labour is payroll XOR the Overheads 'labor' bucket, NEVER the sum — the two are different
  // measurements of the same cost and adding them double-counts (S526, .claude/rules/
  // dashboards.md). A finalized HR payroll run supersedes whatever was typed on the Labor tab.
  // Before this, the page could see neither: an HR client who runs payroll properly and leaves
  // the Labor tab blank had a Net Profit overstated by their entire wage bill, painted green,
  // under the words "✓ Profitable this period".
  const labourPayroll  = periodData?.labourPayroll ?? null
  const labourEffective = labourPayroll != null ? labourPayroll : totals.labor
  const labourSource   = labourPayroll != null ? 'payroll' : totals.labor > 0 ? 'overheads' : 'none'
  // Named on screen with its amount rather than silently dropped, so the two figures can be
  // reconciled by whoever notices they differ.
  const ignoredLabourBucket = labourPayroll != null && totals.labor > 0 ? totals.labor : 0

  const totalFixed = totals.overhead + labourEffective + totals.tax_fees
  const netProfit = revenue > 0 ? revenue - foodCost - totalFixed : null

  // A bucket with nothing in it has not been measured at 0 — it has not been entered. The
  // distinction has to be carried from here to the cell, because the first `? :` that defaults it
  // to 0 destroys it and no care at the call site gets it back (S713). `trafficLight(0, 30)`
  // returns GREEN: 0 − 30 ≤ 2, so an untouched Labor tab rendered "0.0%" as comfortably inside a
  // 30% target — the most flattering possible rendering of "we do not know what this costs". And
  // `seedBucket()` writes blank preset rows into every new period, so the page manufactured its
  // own examples.
  const entered = {
    food:  foodCost > 0,
    labor: labourSource !== 'none',
    oh:    totals.overhead > 0,
    tax:   totals.tax_fees > 0,
  }
  // BS months run 28-32 days, never 30 — a hardcoded /30 over/understates daily burn by up to
  // ~7% depending on the period.
  const selectedPeriodObj = periods.find(p => p.id === periodId)
  const daysInSelectedMonth = selectedPeriodObj ? daysInBsMonth(selectedPeriodObj.bs_year, selectedPeriodObj.bs_month) : 30

  const hasSales = revenue > 0

  // `null` in means `null` out: an absent figure has no ratio, and banding it would band a zero.
  function pct(amount, base) {
    if (amount == null) return null
    return base > 0 ? (amount / base) * 100 : null
  }

  function fmtPct(amount, base) {
    const p = pct(amount, base)
    return p != null ? `${p.toFixed(1)}%` : null
  }

  // Fill variant of trafficLight below — same bands, base tokens, for bars and dots.
  function trafficLightFill(actual, target) {
    if (actual == null) return 'var(--theme-text2)'
    const diff = actual - target
    if (diff <= 2)  return 'var(--theme-green)'
    if (diff <= 8)  return 'var(--theme-amber)'
    return 'var(--theme-red)'
  }

  function trafficLight(actual, target) {
    if (actual == null) return 'var(--theme-text2)'
    const diff = actual - target
    if (diff <= 2)  return 'var(--theme-green-text)'
    if (diff <= 8)  return 'var(--theme-amber-text)'
    return 'var(--theme-red-text)'
  }

  function fmt(val) {
    return `NPR ${Number(val || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
  }

  // P&L rows. An un-entered cost line carries `amount: null` — not 0 — so it renders as "—" in
  // the muted tone instead of a green 0.0% beating its target. Net Profit is the one row that is
  // genuinely computed rather than entered, so it keeps its value; the note beneath the strip
  // says which lines are missing from it.
  const pnlRows = hasSales ? [
    { key: 'food',   label: 'Food Cost',  amount: entered.food  ? foodCost         : null, target: 30, color: 'var(--theme-accent)', textColor: 'var(--theme-accent-ink)' },
    { key: 'labor',  label: 'Labor',      amount: entered.labor ? labourEffective  : null, target: 30, color: 'var(--theme-text1)', textColor: 'var(--theme-text1)',
      note: labourSource === 'payroll' ? 'from finalized payroll' : labourSource === 'overheads' ? 'from Overheads entry' : hrOn ? 'no finalized payroll run, and nothing on the Labor tab' : 'nothing on the Labor tab' },
    { key: 'oh',     label: 'Overhead',   amount: entered.oh    ? totals.overhead  : null, target: 25, color: 'var(--theme-green)', textColor: 'var(--theme-green-text)' },
    { key: 'tax',    label: 'Tax & Fees', amount: entered.tax   ? totals.tax_fees  : null, target: 5,  color: 'var(--theme-purple)', textColor: 'var(--theme-purple-text)' },
    { key: 'profit', label: 'Net Profit', amount: netProfit,       target: 10,
      color:     netProfit != null && netProfit >= 0 ? 'var(--theme-green)'      : 'var(--theme-red)',
      textColor: netProfit != null && netProfit >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' },
  ] : null

  // Every cost line the statement is missing, for the caveat under Net Profit. A statement that
  // silently omits a cost overstates profit by exactly that much.
  const missingLines = [
    !entered.food  && 'Food Cost',
    !entered.labor && 'Labor',
    !entered.oh    && 'Overhead',
    !entered.tax   && 'Tax & Fees',
  ].filter(Boolean)

  // Cross-bucket ranked pivot — all line items with amount > 0, sorted by spend
  const allLineItems = useMemo(() => {
    const lines = Object.entries(rows).flatMap(([bucket, bucketRows]) =>
      // When finalized payroll supersedes the Labor bucket, the typed labour rows are NOT part of
      // this statement — listing them would make the table's own TOTAL disagree with the
      // "100%" it prints underneath, which is the two-tables-must-tie-out rule.
      bucket === 'labor' && labourPayroll != null ? [] :
      bucketRows
        .filter(r => parseFloat(r.amount) > 0)
        .map(r => ({
          bucket,
          category:    r.category || '—',
          description: r.description || '',
          amount:      parseFloat(r.amount),
        }))
    )
    if (labourPayroll != null && labourPayroll > 0) {
      lines.push({
        bucket: 'labor',
        category: 'Payroll',
        description: 'Finalized HR payroll run — gross pay + employer SSF',
        amount: labourPayroll,
      })
    }
    return lines
      .map(l => ({
        ...l,
        pctOfTotal: totalFixed > 0 ? (l.amount / totalFixed) * 100 : 0,
        pctOfRev:   revenue    > 0 ? (l.amount / revenue)    * 100 : null,
      }))
      .sort((a, b) => b.amount - a.amount)
  }, [rows, totalFixed, revenue, labourPayroll])

  // Break-even
  const avgDishPrice = dishes > 0 ? revenue / dishes : 0
  const fcPct     = revenue > 0 ? foodCost / revenue : 0.30
  const contribMargin   = 1 - fcPct
  const breakEvenRev    = contribMargin > 0 && totalFixed > 0 ? totalFixed / contribMargin : null
  const breakEvenDishes = avgDishPrice > 0 && breakEvenRev ? Math.ceil(breakEvenRev / avgDishPrice) : null
  const isAboveBreakEven = breakEvenRev != null && revenue >= breakEvenRev

  const period  = periods.find(p => p.id === periodId)
  const isLocked = !isAdmin && period?.status === 'closed'
  const cfg = BUCKET_CONFIG[activeBucket]
  const activeRows  = rows[activeBucket]
  const bucketTotal = totals[activeBucket]

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read must not wear NoPeriodState (S612 silent-zero rule).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="fixed cost tracking" />

  return (
    <div>
      {/* Header */}
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Overheads & Cost Breakdown</h1>
          <p className="page-subtitle">Fixed costs · Labor · Tax &amp; Fees · True P&amp;L</p>
          <div className="page-scope-row">
            <PeriodScope label={period?.label} status={period?.status} provisionalWhenOpen />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select aria-label="Period"
            value={periodId}
            onChange={e => setPeriodId(e.target.value)}
            style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
          >
            {periods.map(p => <option key={p.id} value={p.id}>{p.label}{p.status === 'open' ? ' (open)' : ''}</option>)}
          </select>
          <button className="btn btn-primary" onClick={save} disabled={saving || isLocked || !!loadError}>
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>

      {/* A failed read blocks the whole form: on a data-entry page, saving over rows the page
          could not read is a data-loss shape, not just a wrong figure (S612). */}
      {loadError ? <ReportLoadError error={loadError} /> : <>

      {/* A failed save is announced where the Save button is, not swallowed. role="alert" comes
          from ActionError: someone who pressed Save and heard nothing has been told it worked. */}
      <ActionError error={saveError} className="action-error--top" />

      {isLocked && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red-text)' }}>
          🔒 <strong>This period is closed.</strong> Data is read-only. Contact your admin to re-open if needed.
        </div>
      )}

      {/* The ignored labour source is NAMED with its amount rather than silently dropped, so an
          owner who notices the two figures differ can reconcile them instead of guessing which
          one the statement used. */}
      {ignoredLabourBucket > 0 && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--theme-accent-ink)' }}>Labour comes from your finalized payroll run this period ({fmt(labourEffective)}).</strong>{' '}
          The {fmt(ignoredLabourBucket)} on the Labor tab is <strong>not</strong> added to the P&amp;L below — payroll and the Labor bucket are two measurements of the same cost, and summing them would double-count it. The tab stays editable for months with no payroll run.
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 14, marginBottom: 24 }}>
        {[
          {
            // An empty bucket reads "Not entered yet", never "NPR 0 · 0.0% of revenue" — the
            // latter is a measurement, and nobody measured it (S713).
            label: 'Fixed Overheads', value: entered.oh ? fmt(totals.overhead) : '—',
            sub: !entered.oh ? 'Not entered yet'
               : fmtPct(totals.overhead, revenue) ? `${fmtPct(totals.overhead, revenue)} of revenue` : 'No sales data',
            color: 'var(--theme-accent-ink)',
            tip: 'Rent, utilities, tech, marketing — costs that exist regardless of how many customers you serve.'
          },
          {
            label: 'Labor Costs', value: entered.labor ? fmt(labourEffective) : '—',
            sub: !entered.labor ? (hrOn ? 'No finalized payroll run, nothing entered' : 'Not entered yet')
               : fmtPct(labourEffective, revenue) ? `${fmtPct(labourEffective, revenue)} of revenue${labourSource === 'payroll' ? ' · payroll' : ''}` : 'No sales data',
            color: 'var(--theme-text1)',
            tip: labourSource === 'payroll'
              ? 'Your finalized HR payroll run for this period — gross pay plus employer SSF. It supersedes whatever is typed on the Labor tab; the two are never added together. Industry target: ~30% of revenue.'
              : 'Salaries, wages, and benefits, as entered on the Labor tab. Industry target: ~30% of revenue.'
          },
          {
            label: 'Tax & Fees', value: entered.tax ? fmt(totals.tax_fees) : '—',
            sub: !entered.tax ? 'Not entered yet'
               : fmtPct(totals.tax_fees, revenue) ? `${fmtPct(totals.tax_fees, revenue)} of revenue` : 'No sales data',
            color: 'var(--theme-purple-text)',
            tip: 'VAT compliance, card processing fees, bank charges, licenses. Often forgotten but real.'
          },
          {
            label: 'Total Fixed Costs', value: fmt(totalFixed),
            sub: fmtPct(totalFixed, revenue) ? `${fmtPct(totalFixed, revenue)} of revenue` : 'Overhead + Labor + Tax',
            color: 'var(--theme-text1)',
            tip: 'Overhead + Labor + Tax & Fees. Every month you must earn more than this just to survive. A bucket you have not entered is missing from it, not zero.'
          },
          {
            label: 'Daily Fixed Cost', value: fmt(totalFixed / daysInSelectedMonth),
            sub: `÷ ${daysInSelectedMonth} days this month`,
            color: 'var(--theme-text2)',
            tip: 'How much your fixed costs burn each day, even if the cafe is closed.'
          },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div className="stat-label">
              <Tip text={s.tip} width={220}>{s.label}</Tip>
            </div>
            <div className="stat-value" style={{ fontSize: 16, color: s.textColor || s.color }}>{s.value}</div>
            <div className="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Entry card — tabs + table */}
      <div className="card" style={{ marginBottom: 20 }}>
        {/* Bucket tabs */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', borderBottom: '1px solid var(--theme-border)', marginBottom: 20 }}
             role="tablist" aria-label="Fixed cost buckets">
          {Object.entries(BUCKET_CONFIG).map(([key, c]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={activeBucket === key}
              onClick={() => setActiveBucket(key)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '10px 20px', fontSize: 13, fontWeight: 500,
                color: activeBucket === key ? (c.textColor || c.color) : 'var(--theme-text2)',
                borderBottom: activeBucket === key ? `2px solid ${c.color}` : '2px solid transparent',
                marginBottom: -1, transition: 'color 0.12s', whiteSpace: 'nowrap'
              }}
            >
              {c.label}
              {totals[key] > 0 && (
                <span style={{ marginLeft: 8, fontSize: 11, background: 'color-mix(in srgb, var(--theme-text1) 8%, transparent)', borderRadius: 'var(--radius-md)', padding: '2px 7px', color: c.textColor || c.color }}>
                  {fmt(totals[key])}
                </span>
              )}
            </button>
          ))}
          {!isLocked && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, marginLeft: 'auto' }}
              onClick={() => addRow(activeBucket)}
            >
              + Add Row
            </button>
          )}
        </div>

        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
        ) : (
          <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 200 }}>Category</th>
                <th>Description</th>
                <th style={{ textAlign: 'right', width: 160 }}>Amount (NPR)</th>
                <th style={{ textAlign: 'right', width: 80 }}><Tip text="This item's share of the total overhead for its bucket (Food Cost, Labour, or Other)." width={260}>% of Bucket</Tip></th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {activeRows.map((row, idx) => (
                <tr key={idx}>
                  <td>
                    <select aria-label="Overhead category"
                      value={cfg.presets.includes(row.category) ? row.category : '__custom__'}
                      onChange={e => {
                        if (e.target.value === '__custom__') updateRow(activeBucket, idx, 'category', '')
                        else updateRow(activeBucket, idx, 'category', e.target.value)
                      }}
                      disabled={isLocked}
                      style={disabledStyle({ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%' }, isLocked)}
                    >
                      {cfg.presets.map(c => <option key={c} value={c}>{c}</option>)}
                      <option value="__custom__">Custom…</option>
                    </select>
                    {!cfg.presets.includes(row.category) && (
                      <input aria-label="Category"
                        value={row.category}
                        onChange={e => updateRow(activeBucket, idx, 'category', e.target.value)}
                        placeholder="Category name"
                        disabled={isLocked}
                        style={disabledStyle({ marginTop: 4, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '5px 8px', fontSize: 12, color: 'var(--theme-text1)', outline: 'none', width: '100%' }, isLocked)}
                      />
                    )}
                  </td>
                  <td>
                    <input aria-label="Description"
                      value={row.description || ''}
                      onChange={e => updateRow(activeBucket, idx, 'description', e.target.value)}
                      disabled={isLocked}
                      placeholder={cfg.placeholders[row.category] || 'Description…'}
                      style={disabledStyle({ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%' }, isLocked)}
                    />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <input aria-label="Amount"
                      type="number"
                      value={row.amount}
                      onChange={e => updateRow(activeBucket, idx, 'amount', e.target.value)}
                      disabled={isLocked}
                      placeholder="0"
                      style={disabledStyle({ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '6px 8px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 130, textAlign: 'right' }, isLocked)}
                    />
                  </td>
                  <td style={{ textAlign: 'right', fontSize: 13, color: bucketTotal > 0 && parseFloat(row.amount) > 0 ? (cfg.textColor || cfg.color) : 'var(--theme-text3)', fontWeight: 600 }}>
                    {bucketTotal > 0 && parseFloat(row.amount) > 0
                      ? `${((parseFloat(row.amount) / bucketTotal) * 100).toFixed(1)}%`
                      : '—'}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {!isLocked && (
                      <button onClick={() => removeRow(activeBucket, idx)}
                        style={{ background: 'none', border: 'none', color: 'var(--theme-red-text)', cursor: 'pointer', fontSize: 16, padding: '4px 8px' }}>×</button>
                    )}
                  </td>
                </tr>
              ))}
              <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                <td colSpan={2} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12, fontSize: 13 }}>TOTAL</td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: cfg.textColor || cfg.color, fontSize: 16, paddingTop: 12 }}>{fmt(bucketTotal)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text2)', fontSize: 13, paddingTop: 12 }}>100%</td>
                <td></td>
              </tr>
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* P&L Summary */}
      {pnlRows ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
            <div>
              <h3 style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>P&L Summary</h3>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text3)' }}>
                Revenue: {fmt(revenue)} &nbsp;·&nbsp; {Math.round(dishes).toLocaleString('en-IN')} dishes sold &nbsp;·&nbsp; {period?.label || '—'}
              </p>
            </div>
            <Tip text="Food cost uses net purchases ÷ revenue (purchase-based). For COGS-based food cost, see Monthly Summary." width={240}>
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', cursor: 'help' }}>Purchase-based FC%</span>
            </Tip>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {pnlRows.map(row => {
              const actualPct  = pct(row.amount, revenue)
              const isProfit   = row.key === 'profit'
              // An un-entered line has no percentage and therefore no band. Passing `null` through
              // to trafficLight() gets the muted tone rather than the green that `0 − target ≤ 2`
              // used to produce, and the bar stays empty instead of drawing a full-width success.
              const isMissing  = row.amount == null
              const numPct     = actualPct == null ? null : actualPct
              const barColor   = isMissing ? 'var(--theme-border)'
                : isProfit
                  ? (row.amount >= 0 ? 'var(--theme-green)' : 'var(--theme-red)')
                  : trafficLightFill(numPct, row.target)
              const barText    = isMissing ? 'var(--theme-text3)'
                : isProfit
                  ? (row.amount >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)')
                  : trafficLight(numPct, row.target)
              const barWidth   = numPct == null ? 0 : Math.min(Math.abs(numPct), 100)

              return (
                <div key={row.key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 0, background: isMissing ? 'var(--theme-border)' : row.color, display: 'inline-block', flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', minWidth: 90 }}>{row.label}</span>
                      <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>target {row.target}%</span>
                      {row.note && <span style={{ fontSize: 11, color: 'var(--theme-text3)', fontStyle: 'italic' }}>· {row.note}</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                      <span style={{ fontSize: 13, color: isMissing ? 'var(--theme-text3)' : 'var(--theme-text2)' }}>
                        {isMissing ? 'not entered' : fmt(row.amount)}
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 700, color: barText, minWidth: 54, textAlign: 'right' }}>
                        {actualPct != null
                          ? `${isProfit && row.amount >= 0 ? '+' : ''}${actualPct.toFixed(1)}%`
                          : '—'}
                      </span>
                    </div>
                  </div>
                  <div style={{ height: 7, background: 'var(--theme-border)', borderRadius: 'var(--radius-xs)', overflow: 'hidden' }}>
                    <div style={{ width: '100%', height: '100%', background: barColor, borderRadius: 'var(--radius-xs)', transform: `scaleX(${barWidth / 100})`, transformOrigin: 'left', transition: 'transform 0.4s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>

          {/* A statement that silently omits a cost overstates profit by exactly that much, and
              the Net Profit callout directly below prints a green ✓ on it. Say which lines are
              missing before the verdict, not after. */}
          {missingLines.length > 0 && (
            <p style={{ marginTop: 16, marginBottom: 0, fontSize: 12, color: 'var(--theme-amber-text)', lineHeight: 1.6 }}>
              △ Net Profit below does <strong>not</strong> include {missingLines.join(', ')} — {missingLines.length === 1 ? 'that line has' : 'those lines have'} nothing recorded for this period, so profit is overstated by whatever {missingLines.length === 1 ? 'it costs' : 'they cost'}.
            </p>
          )}

          {/* Net profit callout */}
          {netProfit != null && (
            <div style={{
              marginTop: 20, padding: '12px 16px', borderRadius: 'var(--radius-sm)',
              background: netProfit >= 0 ? 'color-mix(in srgb, var(--theme-green) 8%, transparent)' : 'color-mix(in srgb, var(--theme-red) 8%, transparent)',
              border: `1px solid ${netProfit >= 0 ? 'color-mix(in srgb, var(--theme-green) 25%, transparent)' : 'color-mix(in srgb, var(--theme-red) 25%, transparent)'}`,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
                {netProfit >= 0 ? '✓ Profitable this period' : '✗ Operating at a loss this period'}
              </span>
              <span style={{ fontSize: 18, fontWeight: 800, color: netProfit >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                {netProfit >= 0 ? '+' : ''}{fmt(netProfit)}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 16, background: 'color-mix(in srgb, var(--theme-accent) 4%, transparent)', borderColor: 'color-mix(in srgb, var(--theme-accent) 15%, transparent)' }}>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
            💡 Add sales entries for this period to unlock the <strong style={{ color: 'var(--theme-accent-ink)' }}>P&L Summary</strong>, <strong style={{ color: 'var(--theme-accent-ink)' }}>Break-Even</strong>, and <strong style={{ color: 'var(--theme-accent-ink)' }}>Overhead per Cover</strong> panels.
          </p>
        </div>
      )}

      {/* Charts — cost stack + bucket breakdown + pivot */}
      {totalFixed > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 20px', fontSize: 13, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Cost Visualisation</h3>

          {/* Revenue cost stack — only when sales data available */}
          {hasSales && (() => {
            const fc  = { key: 'food',     label: 'Food Cost', color: 'var(--theme-accent)', textColor: 'var(--theme-accent-ink)', amount: foodCost,        pct: pct(foodCost,        revenue) || 0 }
            const lb  = { key: 'labor',    label: 'Labor',     color: 'var(--theme-text1)', textColor: 'var(--theme-text1)', amount: labourEffective, pct: pct(labourEffective, revenue) || 0 }
            const oh  = { key: 'overhead', label: 'Overhead',  color: 'var(--theme-green)', textColor: 'var(--theme-green-text)', amount: totals.overhead, pct: pct(totals.overhead, revenue) || 0 }
            const tx  = { key: 'tax',      label: 'Tax & Fees',color: 'var(--theme-purple)', textColor: 'var(--theme-purple-text)', amount: totals.tax_fees, pct: pct(totals.tax_fees, revenue) || 0 }
            const prPct = netProfit != null ? pct(netProfit, revenue) : null
            const pr  = { key: 'profit',   label: prPct != null && prPct < 0 ? 'Loss' : 'Net Profit',
                          color:     prPct != null && prPct < 0 ? 'var(--theme-red)'      : 'var(--theme-green)',
                          textColor: prPct != null && prPct < 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)',
                          amount: netProfit, pct: prPct || 0 }
            const segments = [fc, lb, oh, tx, pr].filter(s => s.amount != null && s.pct > 0.2)
            return (
              <div style={{ marginBottom: 24 }}>
                {/* The scope this chart is drawn on has to be stated HERE too, not only in the
                    P&L Summary header — a report that states a scope must state it everywhere the
                    report goes, and this bar carries the same purchase-based Food Cost. */}
                <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 10 }}>
                  Where each rupee of revenue goes &nbsp;·&nbsp; <span style={{ color: 'var(--theme-accent-ink)', fontWeight: 600 }}>Revenue {fmt(revenue)}</span>
                  <span style={{ color: 'var(--theme-text3)' }}> &nbsp;·&nbsp; Food Cost is purchase-based (net purchases), not COGS
                  {missingLines.length > 0 ? ` · no ${missingLines.join(', ')} recorded, so the profit slice absorbs ${missingLines.length === 1 ? 'it' : 'them'}` : ''}</span>
                </div>
                {/* Stacked bar */}
                <div style={{ display: 'flex', height: 36, borderRadius: 'var(--radius-sm)', overflow: 'hidden', gap: 2, marginBottom: 10 }}>
                  {segments.map(s => (
                    <div key={s.key} title={`${s.label}: ${fmt(s.amount)} (${s.pct.toFixed(1)}%)`} style={{
                      width: `${Math.min(s.pct, 100)}%`, minWidth: s.pct > 4 ? 2 : 0,
                      background: s.color, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', overflow: 'hidden', cursor: 'default',
                    }}>
                      {/* No label inside the segment: it sat on a signal-colour fill in
                          --theme-bg and measured 2.60:1 on Rosé Dawn, and the legend directly
                          below already carries the same percentage to one more decimal. */}
                    </div>
                  ))}
                </div>
                {/* Legend */}
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {segments.map(s => (
                    <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 'var(--radius-xs)', background: s.color, display: 'inline-block', flexShrink: 0 }} />
                      <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{s.label}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: s.textColor || s.color }}>{s.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Per-bucket category breakdown */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 24 }}>
            {Object.entries(BUCKET_CONFIG).map(([key, cfg]) => {
              const bucketRows = rows[key].filter(r => parseFloat(r.amount) > 0)
              const total = totals[key]
              return (
                <div key={key} style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 'var(--radius-sm)', padding: '14px', border: '1px solid var(--theme-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: cfg.textColor || cfg.color }}>{cfg.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{fmt(total)}</span>
                  </div>
                  {/* These are the TYPED rows. When payroll supersedes them they are still worth
                      showing — they are what is stored — but the card must not imply they are in
                      the statement above. */}
                  {key === 'labor' && labourPayroll != null && (
                    <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 10px', lineHeight: 1.5 }}>
                      Superseded by finalized payroll ({fmt(labourPayroll)}) in the P&amp;L above.
                    </p>
                  )}
                  {total === 0 ? (
                    <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0 }}>No entries yet.</p>
                  ) : bucketRows.length === 0 ? (
                    <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0 }}>Nothing entered.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                      {bucketRows.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount)).map((row, i) => {
                        const rowPct = total > 0 ? (parseFloat(row.amount) / total) * 100 : 0
                        return (
                          <div key={i}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                              <span style={{ fontSize: 11, color: 'var(--theme-text1)', fontWeight: 500 }}>{row.category}</span>
                              <span style={{ fontSize: 11, color: cfg.textColor || cfg.color, fontWeight: 700 }}>{rowPct.toFixed(0)}%</span>
                            </div>
                            <div style={{ height: 5, background: 'var(--theme-border)', borderRadius: 'var(--radius-xs)', overflow: 'hidden' }}>
                              <div style={{ width: `${rowPct}%`, height: '100%', background: cfg.color, opacity: 0.75, borderRadius: 'var(--radius-xs)' }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* All line items pivot — cross-bucket ranked by spend */}
          {allLineItems.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
                All Cost Lines — Ranked by Spend
              </div>
              <div className="table-wrap">
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Bucket</th>
                      <th>Category</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'right' }}>Amount (NPR)</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="This line item's share of your total fixed costs (overheads + labor + tax combined)." width={220}>% of Total Cost</Tip>
                      </th>
                      {revenue > 0 && (
                        <th style={{ textAlign: 'right' }}>
                          <Tip text="This line item as a percentage of period revenue. Helps see which costs eat into margin most." width={220}>% of Revenue</Tip>
                        </th>
                      )}
                      <th style={{ minWidth: 100 }}>
                        <Tip text="Visual share of total fixed costs." width={160}>Share</Tip>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {allLineItems.map((item, i) => {
                      const cfg = BUCKET_CONFIG[item.bucket]
                      return (
                        <tr key={i}>
                          <td>
                            <span style={{ fontSize: 11, fontWeight: 700, color: cfg?.textColor || cfg?.color, background: 'rgba(255,255,255,0.05)', borderRadius: 'var(--radius-xs)', padding: '2px 7px', whiteSpace: 'nowrap' }}>
                              {cfg?.label || item.bucket}
                            </span>
                          </td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{item.category}</td>
                          <td style={{ color: 'var(--theme-text2)', maxWidth: 220 }}>{item.description || '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{item.amount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{item.pctOfTotal.toFixed(1)}%</td>
                          {revenue > 0 && (
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                              {item.pctOfRev != null ? `${item.pctOfRev.toFixed(1)}%` : '—'}
                            </td>
                          )}
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ flex: 1, height: 6, background: 'var(--theme-border)', borderRadius: 'var(--radius-xs)', overflow: 'hidden', minWidth: 60 }}>
                                <div style={{ width: `${item.pctOfTotal}%`, height: '100%', background: cfg?.color || 'var(--theme-accent)', borderRadius: 'var(--radius-xs)' }} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td colSpan={3} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 10, fontSize: 12 }}>TOTAL FIXED COSTS</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)', paddingTop: 10 }}>{totalFixed.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 10 }}>100%</td>
                      {revenue > 0 && (
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 10 }}>
                          {fmtPct(totalFixed, revenue)}
                        </td>
                      )}
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Break-even + Overhead per cover */}
      {hasSales && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

          {/* Break-even */}
          <div className="card" style={{
            background: isAboveBreakEven ? 'color-mix(in srgb, var(--theme-green) 4%, transparent)' : 'color-mix(in srgb, var(--theme-red) 4%, transparent)',
            borderColor: isAboveBreakEven ? 'color-mix(in srgb, var(--theme-green) 20%, transparent)' : 'color-mix(in srgb, var(--theme-red) 20%, transparent)'
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 16 }}>
              <Tip text="The minimum revenue / dishes needed to cover all fixed costs. Below this = loss. Above = profit begins. Dishes, not covers: this is portions sold, and one guest usually orders several." width={250}>Break-Even Analysis</Tip>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Need (Revenue)</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>{breakEvenRev ? fmt(breakEvenRev) : '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Need (Dishes)</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>{breakEvenDishes ? breakEvenDishes.toLocaleString('en-IN') : '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Actual Revenue</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: isAboveBreakEven ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>{fmt(revenue)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Actual Dishes</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: isAboveBreakEven ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>{Math.round(dishes).toLocaleString('en-IN')}</div>
              </div>
            </div>
            <div style={{ padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: 13, fontWeight: 700,
              background: isAboveBreakEven ? 'color-mix(in srgb, var(--theme-green) 10%, transparent)' : 'color-mix(in srgb, var(--theme-red) 10%, transparent)',
              color: isAboveBreakEven ? 'var(--theme-green-text)' : 'var(--theme-red-text)'
            }}>
              {isAboveBreakEven && breakEvenRev
                ? `✓ Above break-even by ${fmt(revenue - breakEvenRev)}`
                : breakEvenRev
                  ? `✗ Below break-even by ${fmt(breakEvenRev - revenue)}`
                  : contribMargin <= 0
                    ? `✗ Purchase cost (${(fcPct * 100).toFixed(1)}% FC) exceeds revenue — break-even is undefined`
                    : totalFixed === 0
                      ? 'Enter overhead costs above and save to calculate'
                      : 'Unable to calculate'}
            </div>
            <p style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 10, marginBottom: 0, lineHeight: 1.6 }}>
              Formula: Total Fixed Costs ÷ (1 − FC%) &nbsp;·&nbsp;
              Avg dish price: {avgDishPrice > 0 ? fmt(avgDishPrice) : '—'} &nbsp;·&nbsp;
              FC%: {revenue > 0 ? `${(fcPct * 100).toFixed(1)}%` : '—'} (purchase-based)
              {missingLines.length > 0 && <> &nbsp;·&nbsp; excludes {missingLines.join(', ')}, so the real break-even is higher</>}
            </p>
          </div>

          {/* Fixed cost per dish */}
          <div className="card">
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 16 }}>
              <Tip text="How much of each dish sold goes to fixed costs before any food cost or profit. Every dish must earn at least this much just to keep the lights on. Per DISH, not per guest — one guest usually orders several, so the cost of seating a table is a multiple of this." width={260}>Cost per Dish</Tip>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Fixed OH / Dish</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-accent-ink)' }}>
                  {dishes > 0 && totals.overhead > 0 ? fmt(totals.overhead / dishes) : '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Labor / Dish</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>
                  {dishes > 0 && labourEffective > 0 ? fmt(labourEffective / dishes) : '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Tax & Fees / Dish</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--theme-purple-text)' }}>
                  {dishes > 0 && totals.tax_fees > 0 ? fmt(totals.tax_fees / dishes) : '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Total Fixed / Dish</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>
                  {dishes > 0 && totalFixed > 0 ? fmt(totalFixed / dishes) : '—'}
                </div>
              </div>
            </div>
            <p style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 14, marginBottom: 0, lineHeight: 1.6 }}>
              Every dish sold must earn at least <strong style={{ color: 'var(--theme-text1)' }}>{dishes > 0 && totalFixed > 0 ? fmt(totalFixed / dishes) : '—'}</strong> just to cover fixed costs. Food cost and profit are on top of this.
            </p>
          </div>
        </div>
      )}

      {/* Footer note */}
      <div className="card" style={{ background: 'color-mix(in srgb, var(--theme-accent) 4%, transparent)', borderColor: 'color-mix(in srgb, var(--theme-accent) 15%, transparent)' }}>
        <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.7 }}>
          💡 <strong style={{ color: 'var(--theme-accent-ink)' }}>How overhead is allocated to recipes:</strong> Only <strong style={{ color: 'var(--theme-text1)' }}>Fixed Overheads</strong> (not labor or tax) are distributed across menu items proportionally by each item's share of period revenue. This gives you the true overhead-per-portion in Recipe Costing. Labor and Tax & Fees are period-level costs tracked separately.
        </p>
        <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '10px 0 0', lineHeight: 1.7 }}>
          📐 <strong style={{ color: 'var(--theme-accent-ink)' }}>What the figures on this page mean:</strong>{' '}
          <strong style={{ color: 'var(--theme-text1)' }}>Food Cost</strong> is purchase-based — net purchases (purchases less vendor returns) for the period, not COGS. It ignores opening and closing stock, so a month where you built stock reads worse than it was and a month where you ran it down reads better; Monthly Summary has the COGS-based figure.{' '}
          <strong style={{ color: 'var(--theme-text1)' }}>Dishes</strong> is portions sold, not guests — Crest counts guests as <em>covers</em>, from POS bills only, which this page does not read.{' '}
          <strong style={{ color: 'var(--theme-text1)' }}>Labor</strong> is your finalized payroll run when one exists for the period, otherwise whatever is on the Labor tab — never both added together.
        </p>
      </div>
      </>}
    </div>
  )
}
