import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { varianceBand, varianceFlagPct, VARIANCE_MATERIALITY_NPR } from '../../../shared/imsFormulas'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { selectDepletingSales } from '../sales/salesDepletion'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import { firstError } from '../../../shared/queryError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { Navigate } from 'react-router-dom'

// `badge` rather than a hand-rolled chip: the previous inline version built its border as
// `1px solid ${color}40` by string-concatenating an alpha onto a value that is a var() — an
// invalid declaration CSS discards in silence, so the border never painted on any preset. The
// shared classes carry the tint, radius, padding and type, and cannot drift.
function shrinkageStatus(count, covered) {
  const ratio = covered > 0 ? count / covered : 0
  if (ratio >= 0.67 && count >= 2) return { label: 'Consistent', badge: 'badge-red',    color: 'var(--theme-red-text)' }
  if (count >= 2)                  return { label: 'Occasional', badge: 'badge-amber',  color: 'var(--theme-amber-text)' }
  if (count === 1)                 return { label: 'Once',       badge: 'badge-yellow', color: 'var(--theme-accent-ink)' }
  return                                  { label: 'Clear',      badge: 'badge-green',  color: 'var(--theme-green-text)' }
}

// A period counts as shrinkage only when the variance is OVER the client's tolerance AND material
// (S756). The old test was `variance > 0.001` — a hundredth of a gram over theoretical was a
// shrinkage period — and neither `variance_flag_pct` nor VARIANCE_MATERIALITY_NPR reached this
// page, so an item a hair over recipe every month read "Consistent" in red on the report a client
// uses to decide whether staff are stealing, while the Variance Report called the same months OK.
// Pure over the observations buildReport stored, so a settings change re-bands without a re-read.
function bandItem(raw, settings) {
  let shrinkCount = 0
  let totalShrinkQty = 0
  raw.observations.forEach(({ variance, theor, rate }) => {
    const pct = theor > 0 ? (variance / theor) * 100 : null
    if (varianceBand(pct, variance * rate, settings, { measured: true }).key === 'over') {
      shrinkCount++
      totalShrinkQty += variance
    }
  })
  const coveredPeriods = raw.observations.length
  const totalShrinkValue = totalShrinkQty * raw.rate
  return {
    ...raw,
    shrinkCount,
    coveredPeriods,
    totalShrinkQty,
    totalShrinkValue,
    avgShrinkQty: shrinkCount > 0 ? totalShrinkQty / shrinkCount : 0,
    status: shrinkageStatus(shrinkCount, coveredPeriods),
  }
}

export default function ShrinkageReport() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const { settings } = useSettings()
  const windowReq = useLatestRequest()

  const [periods, setPeriods]         = useState([])
  const [periodCount, setPeriodCount] = useState(6)
  const [categories, setCategories]   = useState([])
  const [filterCat, setFilterCat]     = useState('all')
  const [filterStatus, setFilterStatus] = useState('flagged')
  // Per-item OBSERVATIONS, not verdicts — the verdict depends on settings and is derived below.
  const [rawRows, setRawRows]         = useState([])
  const [uncountedInfo, setUncountedInfo] = useState({ items: 0, itemPeriods: 0 })
  const [ready, setReady]             = useState(false)   // a build has completed for the current window
  const [loading, setLoading]         = useState(true)
  const [loadError, setLoadError]     = useState(null)
  const [periodsUsed, setPeriodsUsed] = useState(0)
  // No closed period exists at all (S747). The build effect only runs when there are periods, so
  // this page sat on "Analysing N closed periods…" for ever on a client whose months were all open.
  const [noClosed, setNoClosed] = useState(false)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line
  useEffect(() => { if (periods.length) buildReport() }, [periodCount, periods]) // eslint-disable-line

  async function init() {
    setLoadError(null)
    const initResults = await Promise.all([
      scopedFrom('monthly_periods')
        .eq('status', 'closed')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('categories').order('sort_order'),
    ])
    // A failed read is not "no closed periods yet" — surface it instead of rendering empty (S612 silent-zero rule).
    const initFailed = firstError(initResults)
    if (initFailed) { setLoadError(initFailed); setLoading(false); return }
    const [{ data: p }, { data: c }] = initResults
    setCategories(c || [])
    setPeriods(p || [])
    const none = !(p || []).length
    setNoClosed(none)
    if (none) { setRawRows([]); setReady(false); setPeriodsUsed(0); setLoading(false) }
  }

  async function buildReport() {
    const key = windowReq.begin(periodCount)   // claim the page before any await (S601)
    setLoading(true)
    setLoadError(null)
    const selected = periods.slice(0, periodCount)
    if (!selected.length) { setRawRows([]); setReady(false); setLoading(false); return }
    const periodIds = selected.map(p => p.id)
    setPeriodsUsed(selected.length)

    const results = await Promise.all([
      // Every per-item-per-period read below is paged (S719). Each is one row per item per period,
      // so a client past 1000 items — or a multi-period window — truncates silently, and
      // truncation returns NO error for the firstError() check to catch. The direction is what
      // matters here: a missing CLOSING row makes actual usage read as "everything on the shelf
      // plus everything bought", which is a false Over variance on the report a client uses to
      // chase shrinkage. The `items` read is paged for the same reason S717 gave on Stock Report —
      // it is the read that produces the ids every other one is joined against.
      fetchAllRows(() => scopedFrom('items', '*, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('id')),
      fetchAllRows(() => supabase.from('opening_stock').select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('closing_stock').select('period_id, item_id, physical_qty').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('purchase_entries').select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', 'period_id, item_id, qty').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('wastages').select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('staff_meals').select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      // source + bs_day feed the per-period POS-supersedes-manual dedup below; paged because a
      // multi-period sales_entries read crosses the silent 1000-row cap readily.
      fetchAllRows(() => supabase.from('sales_entries').select('period_id, recipe_id, qty_sold, bs_day, source').in('period_id', periodIds).order('id')),
      scopedFrom('recipes', 'id'),
    ])
    // A failed read must never flow through the `|| []`s below into a confident NPR-0 report (S612 silent-zero rule).
    if (!windowReq.isCurrent(key)) return   // superseded by a newer window selection
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRawRows([]); setReady(false); setLoading(false); return }
    const [
      { data: items },
      { data: opening },
      { data: closing },
      { data: purchases },
      { data: returns },
      { data: wastages },
      { data: staffMeals },
      { data: sales },
      { data: clientRecipes },
    ] = results

    // explodeRecipeIngredients recurses through sub-recipe ingredients and applies yield_pct —
    // this page used to read recipe_ingredients flat with `.not('item_id','is',null)`, which
    // dropped every sub-recipe ingredient outright and never divided by yield_pct at all. Both
    // errors push theoretical usage DOWN, and shrinkage is (actual − theoretical), so the page
    // systematically over-reported shrinkage — on the one report a client uses to decide whether
    // staff are stealing. Every other consumer (Variance, StockReport, ReorderReport, Requisitions,
    // FifoReport, both dashboards) was moved to this util; Shrinkage was the last one left behind.
    const shrinkRecipeIds = (clientRecipes || []).map(r => r.id)
    // The recipe walk throws on a failed read (S695) — before, it walked an empty tree, theoretical
    // usage came out as zero, and every item read as fully shrunk.
    let ingredientBreakdown = {}
    try {
      ingredientBreakdown = shrinkRecipeIds.length > 0
        ? await explodeRecipeIngredients(supabase, shrinkRecipeIds)
        : {}
    } catch (err) {
      // The isCurrent guard belongs on the failure path too: without it a superseded load's
      // error replaces the report the reader is actually looking at with a red banner (S719).
      if (!windowReq.isCurrent(key)) return
      setLoadError(err); setRawRows([]); setReady(false); setLoading(false); return
    }

    // Build per-period-per-item lookups
    function makeMap(rows, valKey) {
      const m = {}
      ;(rows || []).forEach(r => {
        if (!m[r.period_id]) m[r.period_id] = {}
        m[r.period_id][r.item_id] = (m[r.period_id][r.item_id] || 0) + parseFloat(r[valKey] || 0)
      })
      return m
    }

    const openMap  = makeMap(opening, 'qty')
    const wasteMap = makeMap(wastages, 'qty')
    // Previously omitted — logged staff-meal consumption was misclassified as unexplained
    // "shrinkage", contradicting this report's own definition (shrinkage is unexplained;
    // staff meals are logged too, just like wastage, which was already excluded).
    const staffMap = makeMap(staffMeals, 'qty')

    const closeMap = {}
    ;(closing || []).forEach(r => {
      if (!closeMap[r.period_id]) closeMap[r.period_id] = {}
      closeMap[r.period_id][r.item_id] = parseFloat(r.physical_qty || 0)
    })

    const purchMap = {}
    ;(purchases || []).forEach(r => {
      if (!purchMap[r.period_id]) purchMap[r.period_id] = {}
      purchMap[r.period_id][r.item_id] = (purchMap[r.period_id][r.item_id] || 0) + parseFloat(r.qty)
    })
    ;(returns || []).forEach(r => {
      if (!purchMap[r.period_id]) purchMap[r.period_id] = {}
      purchMap[r.period_id][r.item_id] = (purchMap[r.period_id][r.item_id] || 0) - parseFloat(r.qty)
    })

    // Theoretical usage: sold × qty_per_portion, per period per item. Sales are deduplicated with
    // the shared POS-supersedes-manual rule PER PERIOD — the rule is scoped by bs_day within a
    // period, so mixing periods would let one period's POS sale supersede another's bulk row.
    // Without the dedup a client running POS *and* manual bulk entry double-counts a dish,
    // inflating theoretical usage and UNDER-reporting shrinkage — backwards on the report used to
    // judge whether staff are stealing. Kept consistent with Variance.js / TheoreticalVariance.js.
    const salesByPeriod = {}
    ;(sales || []).forEach(s => {
      if (!salesByPeriod[s.period_id]) salesByPeriod[s.period_id] = []
      salesByPeriod[s.period_id].push(s)
    })
    const soldMap = {}
    Object.entries(salesByPeriod).forEach(([pid, rows]) => {
      soldMap[pid] = {}
      selectDepletingSales(rows).forEach(s => {
        soldMap[pid][s.recipe_id] = (soldMap[pid][s.recipe_id] || 0) + parseFloat(s.qty_sold)
      })
    })
    // breakdown[recipeId] is already yield_pct-adjusted, per-one-portion raw-ingredient qty
    const theorMap = {}
    periodIds.forEach(pid => {
      theorMap[pid] = {}
      const soldThisPeriod = soldMap[pid] || {}
      Object.entries(ingredientBreakdown).forEach(([recipeId, rows]) => {
        const sold = soldThisPeriod[recipeId] || 0
        if (sold <= 0) return
        rows.forEach(({ item_id, qty }) => {
          theorMap[pid][item_id] = (theorMap[pid][item_id] || 0) + sold * qty
        })
      })
    })

    // Observations per item. A period is observed only when the item has recipe coverage AND a
    // closing count in that period (S756). `closeMap[pid]?.[item.id] || 0` read "not counted" as
    // "counted zero" — the S719 rule the Variance pages already follow — so an uncounted item in a
    // closed month read as the whole shelf consumed, which is a large Over variance, and a few such
    // months made it "Consistent" red shrinkage. Presence is `in`, never `> 0`: a count of 0 is a
    // real count (S695). Skipped periods are counted and named on screen instead.
    let uncountedItems = 0
    let uncountedItemPeriods = 0
    const rows = (items || []).map(item => {
      const observations = []
      let skipped = 0

      periodIds.forEach(pid => {
        const theor = theorMap[pid]?.[item.id] || 0
        if (theor <= 0) return
        if (!closeMap[pid] || !(item.id in closeMap[pid])) { skipped++; return }
        const open   = openMap[pid]?.[item.id]  || 0
        const close  = closeMap[pid][item.id]
        const purch  = purchMap[pid]?.[item.id] || 0
        const waste  = wasteMap[pid]?.[item.id] || 0
        const staffMealQty = staffMap[pid]?.[item.id] || 0
        const actual = open + purch - close - waste - staffMealQty
        observations.push({ variance: actual - theor, theor, rate: parseFloat(item.per_uom_rate || 0) })
      })

      if (skipped > 0) { uncountedItems++; uncountedItemPeriods += skipped }
      if (observations.length === 0) return null

      return {
        item,
        observations,
        uncountedPeriods: skipped,
        rate: parseFloat(item.per_uom_rate || 0),
        category: item.categories?.name || 'Uncategorised',
      }
    }).filter(Boolean)

    if (!windowReq.isCurrent(key)) return   // a second await (recipe explosion) sits above this
    setUncountedInfo({ items: uncountedItems, itemPeriods: uncountedItemPeriods })
    setRawRows(rows)
    setReady(true)
    setLoading(false)
  }

  // Verdicts are derived from the stored observations against the CURRENT settings, so a tolerance
  // that loads after the report (or is changed in another tab) re-bands without a re-read.
  const report = useMemo(() => rawRows.map(r => bandItem(r, settings)), [rawRows, settings])
  const summary = ready ? {
    consistent:   report.filter(r => r.status.label === 'Consistent').length,
    anyFlagged:   report.filter(r => r.shrinkCount > 0).length,
    totalLossVal: report.reduce((s, r) => s + r.totalShrinkValue, 0),
    totalTracked: report.length,
  } : null
  const flagPct = varianceFlagPct(settings)

  const filtered = report
    .filter(r => {
      const matchCat = filterCat === 'all' || r.category === filterCat
      const matchSt  = filterStatus === 'all'
        || (filterStatus === 'flagged'    && r.shrinkCount > 0)
        || (filterStatus === 'consistent' && r.status.label === 'Consistent')
      return matchCat && matchSt
    })
    .sort((a, b) => b.totalShrinkValue - a.totalShrinkValue)

  function fmt(v) { return `NPR ${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Shrinkage Report</h1>
          <p className="page-subtitle">Consistent unexplained stock loss across periods — {periodsUsed} closed periods analysed</p>
        </div>
        <select aria-label="Number of periods to analyse" className="form-select" value={periodCount} onChange={e => setPeriodCount(Number(e.target.value))}>
          <option value={3}>Last 3 periods</option>
          <option value={6}>Last 6 periods</option>
          <option value={12}>Last 12 periods</option>
        </select>
      </div>

      {loadError && <ReportLoadError error={loadError} />}

      {!loadError && <>
      <div style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 15%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--theme-accent-ink)' }}>What this shows:</strong> Items where actual usage consistently exceeded theoretical (recipe-based) usage across multiple closed periods.
        Unlike wastage — which is <em style={{ color: 'var(--theme-text1)' }}>logged</em> — shrinkage is <em style={{ color: 'var(--theme-red-text)' }}>unexplained</em>. Possible causes: unlogged theft, over-portioning, unlogged spillage, or data entry errors. Anything you log on the Daily Wastage tab — theft included — is explained, and so leaves this figure.
        Only items linked to recipes (with sales data) are analysed. A period counts as shrinkage when the item was
        over-used by more than your ±{flagPct}% tolerance <em>and</em> by more than NPR {VARIANCE_MATERIALITY_NPR.toLocaleString('en-IN')} — the
        same test the Variance Report uses.
      </div>

      {/* Named, not silently skipped (S756): an item with no closing count in a period cannot be
          judged for that period — without a count its whole shelf reads as consumed. The sibling
          Variance pages have said this since S719; this page had turned it into red shrinkage. */}
      {!loading && ready && uncountedInfo.items > 0 && (
        <div role="note" style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>△ {uncountedInfo.items} item{uncountedInfo.items === 1 ? ' was' : 's were'} not counted in {uncountedInfo.itemPeriods} of the item-months analysed.</strong>{' '}
          Without a closing count, everything on the shelf reads as used, so those months are left out of each item&apos;s
          shrinkage count, its periods tracked and its loss value rather than being treated as a count of zero.
        </div>
      )}

      {/* KPI strip waits for the load — a stale run's figures under a new period-count label is the S594 trap */}
      {!loading && summary && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-label">Periods Analysed</div>
            <div className="stat-value">{periodsUsed}</div>
            <div className="stat-sub">closed periods</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text={`Items over-used beyond your ±${flagPct}% tolerance (and by more than NPR ${VARIANCE_MATERIALITY_NPR}) in 67%+ of the counted periods — your highest-risk items.`} width={260}>Consistent Shrinkage</Tip>
            </div>
            <div className="stat-value" style={{ color: summary.consistent > 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>{summary.consistent}</div>
            <div className="stat-sub">items</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text={`Items with at least one counted period of over-use beyond your ±${flagPct}% tolerance and NPR ${VARIANCE_MATERIALITY_NPR}.`} width={240}>Any Shrinkage</Tip>
            </div>
            <div className="stat-value" style={{ color: summary.anyFlagged > 0 ? 'var(--theme-amber-text)' : 'var(--theme-green-text)' }}>{summary.anyFlagged}</div>
            <div className="stat-sub">of {summary.totalTracked} recipe-covered items</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Total NPR value of unexplained loss across the shrinkage periods (over-used qty × item rate). Periods where the item was not counted are left out." width={260}>Total Loss Value</Tip>
            </div>
            <div className="stat-value" style={{ fontSize: 16, color: summary.totalLossVal > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>
              {summary.totalLossVal > 0 ? fmt(summary.totalLossVal) : '—'}
            </div>
            <div className="stat-sub">across all analysed periods</div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select aria-label="Filter by category" className="form-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
            <option value="all">All Categories</option>
            {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <select aria-label="Filter by status" className="form-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="flagged">Flagged items only</option>
            <option value="consistent">Consistent only</option>
            <option value="all">All tracked items</option>
          </select>
        </div>
        <span style={{ fontSize: 13, color: 'var(--theme-text2)', marginLeft: 'auto' }}>{filtered.length} items</span>
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Analysing {periodCount} closed periods…</p>
        ) : noClosed ? (
          <div className="empty-state">
            <p className="empty-state-text">
              No period has been closed yet. Shrinkage compares what was counted at month end against what the
              recipes say was used, so it needs at least one closed month — close a period in Periods once its
              stock count is done.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">✓</div>
            <p className="empty-state-text">
              {filterStatus !== 'all'
                ? 'No items match this filter — try "All tracked items" to see the full list.'
                : 'No recipe-covered items found in closed periods. Close a period and add sales entries to enable shrinkage analysis.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>UOM</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text={`Number of counted closed periods where this item was over-used beyond your ±${flagPct}% tolerance and by more than NPR ${VARIANCE_MATERIALITY_NPR}.`} width={260}>Shrinkage Count</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Number of periods where this item had recipe coverage (sales + recipe data) AND a closing count. Months it was not counted are shown separately and not judged." width={260}>Periods Tracked</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Average unexplained over-usage per period it occurred, in base UOM." width={220}>Avg Qty / Period</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Total unexplained loss value across all periods (qty × item rate per UOM)." width={240}>Total Loss (NPR)</Tip>
                  </th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => (
                  <tr key={row.item.id} style={{ background: row.status.label === 'Consistent' ? 'color-mix(in srgb, var(--theme-red) 3%, transparent)' : 'transparent' }}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{row.item.name}</td>
                    <td><span className="badge badge-yellow">{row.category}</span></td>
                    <td style={{ color: 'var(--theme-text2)' }}>{row.item.uom}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: row.shrinkCount > 0 ? row.status.color : 'var(--theme-text2)' }}>
                      {row.shrinkCount > 0 ? row.shrinkCount : '—'}
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                      {row.coveredPeriods}
                      {row.uncountedPeriods > 0 && (
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-amber-text)' }}>△ {row.uncountedPeriods} not counted</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', color: row.shrinkCount > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>
                      {row.avgShrinkQty > 0 ? Number(row.avgShrinkQty.toFixed(3)).toLocaleString('en-IN') : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: row.totalShrinkValue > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>
                      {row.totalShrinkValue > 0 ? fmt(row.totalShrinkValue) : '—'}
                    </td>
                    <td>
                      <span className={`badge ${row.status.badge}`}>{row.status.label}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      </>}
    </div>
  )
}
