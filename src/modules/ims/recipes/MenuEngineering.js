import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useTheme } from '../../../context/ThemeContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import PeriodScope from '../../../components/PeriodScope'
import { useSettings } from '../../../context/SettingsContext'
import { fcBand, recipeCostOf } from '../../../shared/imsFormulas'
import ChartCard from '../../../components/ChartCard'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import {
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip as RTooltip, ReferenceLine, ResponsiveContainer,
  Cell, BarChart, Bar,
} from 'recharts'
import { chartMotion } from '../../../shared/chartMotion'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { fetchAllRows, runChunkedByIds } from '../../../shared/fetchAllRows'
import ActionError, { asActionError } from '../../../components/ActionError'
import {
  FC_CUTOFF, QUADRANT_KEYS, classify, median, menuFcPct, unratedReason,
} from '../../../shared/menuEngineering'

const QUADRANTS = {
  Star:      { color: 'var(--theme-green-text)', bg: 'color-mix(in srgb, var(--theme-green) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-green) 30%, transparent)', icon: '★', desc: 'High profit · High popularity' },
  Plowhorse: { color: 'var(--theme-purple-text)', bg: 'color-mix(in srgb, var(--theme-purple) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-purple) 30%, transparent)', icon: '🐴', desc: 'High profit · Low popularity' },
  Puzzle:    { color: 'var(--theme-amber-text)', bg: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)',  border: 'color-mix(in srgb, var(--theme-amber) 30%, transparent)',  icon: '?', desc: 'Low profit · High popularity' },
  Dog:       { color: 'var(--theme-red-text)', bg: 'color-mix(in srgb, var(--theme-red) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-red) 30%, transparent)', icon: '✕', desc: 'Low profit · Low popularity' },
}

// Not a quadrant — the dishes the page cannot rate at all, because it has no selling price or no
// costed ingredients for them (S715). Deliberately NEUTRAL rather than amber: "we don't know this
// dish's food cost" is a gap in the data, not a verdict on the dish, and amber is already spoken
// for by fcBand's Watch band on the very same rows. The advice column carries the next step.
const UNRATED = {
  key: 'Unrated', label: 'Not rated', icon: '–',
  color: 'var(--theme-text2)',
  bg: 'color-mix(in srgb, var(--theme-text2) 10%, transparent)',
  border: 'color-mix(in srgb, var(--theme-text2) 30%, transparent)',
  desc: 'No price or no costed ingredients',
}

// Hex colors for Recharts SVG (CSS vars don't resolve inside SVG presentation attributes)
const Q_HEX = { Star: '#34d399', Plowhorse: '#a78bfa', Puzzle: '#f59e0b', Dog: '#f87171' }

function ScatterDot({ cx, cy, payload }) {
  const color = Q_HEX[payload.quadrant] || '#888'
  return <circle cx={cx} cy={cy} r={5} fill={color} fillOpacity={0.85} stroke={color} strokeWidth={1} />
}

function ScatterTooltipContent({ active, payload }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  const q = QUADRANTS[d.quadrant]
  if (!q) return null
  return (
    <div style={{
      background: 'var(--theme-card)', border: `1px solid ${q.border}`,
      borderRadius: 'var(--radius-sm)', padding: '10px 14px', fontSize: 12, minWidth: 160
    }}>
      <div style={{ fontWeight: 700, color: q.color, marginBottom: 6 }}>{q.icon} {d.name}</div>
      <div style={{ color: 'var(--theme-text2)' }}>FC%: <span style={{ fontWeight: 600, color: d.fcPct > FC_CUTOFF ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>{d.fcPct != null ? d.fcPct.toFixed(1) + '%' : '—'}</span></div>
      <div style={{ color: 'var(--theme-text2)' }}>Qty Sold: <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{d.qtySold}</span></div>
      <div style={{ color: 'var(--theme-text2)' }}>Revenue: <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>NPR {d.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
    </div>
  )
}

function BarTooltipContent({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 12 }}>
      <div style={{ fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 4 }}>{label}</div>
      <div style={{ color: 'var(--theme-text2)' }}>Revenue: <span style={{ fontWeight: 600, color: 'var(--theme-accent-ink)' }}>NPR {(payload[0]?.value || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></div>
    </div>
  )
}

export default function MenuEngineering() {
  const { profile, clientId: authClientId, loading: authLoading, hasImsAccess } = useAuth()
  // Colours come from the client's configured thresholds; the Star/Puzzle/Dog CLASSIFICATION
  // deliberately stays on FC_CUTOFF, and both now live in `shared/menuEngineering.js` so the
  // frozen Monthly Owner Report reads the same function rather than a copy of it (S715).
  const { settings } = useSettings()
  const clientId = authClientId || profile?.client_id
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const periodReq = useLatestRequest()
  // A SECOND guard, not a shared one. Both effects fire on an admin client switch, in declaration
  // order — so on one `useLatestRequest` the period LOAD's claim (still carrying the previous
  // client's period id) would supersede the period LIST's, and the new outlet's dropdown would
  // never be set. Each loader holds its own, per the rule Roster's two loaders established.
  const periodsReq = useLatestRequest()
  const { colors } = useTheme()

  const [periods, setPeriods]     = useState([])
  const [periodId, setPeriodId]   = useState('')
  const [items, setItems]         = useState([])   // enriched recipe rows
  const [loading, setLoading]     = useState(false)
  const [loadError, setLoadError] = useState(null)
  // This page's `loading` starts false (it only covers loadData), so the no-period state needs
  // its own "have we fetched periods yet" flag or it flashes on every first paint.
  const [periodsLoaded, setPeriodsLoaded] = useState(false)
  const [filterQ, setFilterQ]     = useState('All')
  const [search, setSearch]       = useState('')
  const [viewMode, setViewMode]   = useState('table') // 'table' | 'matrix'
  // The me_class write-back's own failure channel. It is a background write the reader did not
  // ask for, so it must never block the report — but it is also the one thing on this page with
  // an effect somewhere else (POS's suggestion ranking), so it does not get to fail in silence
  // either. Non-blocking, under the content, naming the consequence.
  const [classWriteError, setClassWriteError] = useState(null)

  useEffect(() => { if (!authLoading && clientId) loadPeriods() }, [clientId, authLoading]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (periodId && clientId) loadData() }, [periodId, clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadPeriods() {
    // `loadPeriods` auto-selects a period, so it claims the page too (S601's own contract:
    // anything that sets the period must call begin()). An admin switching clients re-runs this,
    // and without the claim the slower client's list could land last and leave the dropdown
    // naming one outlet's month over another outlet's figures.
    const key = periodsReq.begin(`periods:${clientId}`)
    const { data, error } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
    if (!periodsReq.isCurrent(key)) return
    // A failed read must not impersonate "no periods yet" (S612 silent-zero rule).
    if (error) { setLoadError(error); setPeriodsLoaded(true); return }
    const withLabel = (data || []).map(p => ({
      ...p,
      label: `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}`
    }))
    setPeriods(withLabel)
    setPeriodsLoaded(true)
    const active = withLabel.find(p => p.status === 'open') || withLabel[0]
    if (active) setPeriodId(active.id)
  }

  // The period whose classification POS is entitled to act on: the open one, or the most recent
  // if the client is between months. Everything else on the dropdown is history, and history
  // must not overwrite what the till suggests tonight — the reason the frozen owner report
  // refuses to port this write at all.
  const livePeriodId = useMemo(
    () => (periods.find(p => p.status === 'open') || periods[0])?.id || null,
    [periods]
  )

  async function loadData() {
    const key = periodReq.begin(periodId)   // claim the page before any await (S601)
    setLoading(true)
    setLoadError(null)

    // Recipes (menu items only — exclude sub-recipes) and this period's sales are independent
    // reads — the sales read used to sit third in a serial chain behind the cost computation,
    // which it needs nothing from. Comps (source='pos_comp') excluded from sales, since the
    // BCG-style revenue/margin quadrant below is about what actually sold at menu price, not what
    // was given away.
    const [{ data: recipes, error: recErr }, { data: sales, error: salesErr }] = await Promise.all([
      scopedFrom('recipes', 'id, name, category, selling_price, cost_price')
        // Both filters are NULL-safe (S714). `.neq` on a NULLABLE column also drops every NULL
        // row, server-side and silently — and BOTH of these columns are nullable, so an
        // uncategorised dish, or one whose is_active was never set, dropped out of the matrix
        // entirely rather than being classed. The SQL side has always used IS DISTINCT FROM.
        .not('is_active', 'is', false)
        .or('category.is.null,category.neq.Sub-Recipe'),
      // Paged (S715). This was a bare `.select()` on `sales_entries` — one row per recipe per day
      // per source, so a single month of POS service is thousands of rows and PostgREST returned
      // the first 1000 with no error and nothing in the data to say so. The damage is not a short
      // revenue column: a truncated qty map moves the MEDIAN, which is the popularity cutoff, so
      // every dish on the page can change quadrant. BestSellers and the frozen owner report have
      // both paged this same read for a while; this page was the one left bare.
      //
      // `source` is SELECTED and comps are filtered in JS rather than with
      // `.neq('source','pos_comp')` (S699): the column is nullable with no NOT NULL, every row
      // written before it had a default reads NULL, and `NULL <> 'pos_comp'` is NULL — so the
      // server-side form silently dropped every legacy manual sale. Comps are excluded because
      // the quadrant is about what sold at menu price; `pos_credit` rows carry a negative qty and
      // correctly reverse a sale. `salesReads.test.js` pins both halves.
      fetchAllRows(() => supabase
        .from('sales_entries')
        .select('recipe_id, qty_sold, discount, unit_price, source')
        .eq('period_id', periodId)
        .order('id')),
    ])
    // S612 silent-zero rule: a failed read must not render the "no menu items found" empty state.
    if (!periodReq.isCurrent(key)) return   // superseded by a newer period selection
    if (recErr) { setLoadError(recErr); setItems([]); setLoading(false); return }
    // A failed sales read would classify every dish as a zero-sale Dog (S612).
    if (salesErr) { setLoadError(salesErr); setItems([]); setLoading(false); return }

    // computeRecipeCosts recurses through sub-recipe ingredients and applies yield_pct — a
    // hand-rolled ingMap reading only direct item_id ingredients (as this used to) silently
    // costs any sub-recipe-based ingredient at zero, which could misclassify a genuinely
    // unprofitable dish as a "Star" in the quadrant below.
    //
    // It THROWS on a failed read (S695/S711) and this call site never caught it, so a dead
    // `items` read rejected loadData's promise before `setLoading(false)` and left the page on
    // "Loading…" for as long as it stayed open — no error card, nothing to retry.
    let ingMap = {}
    try {
      if ((recipes || []).length > 0) ingMap = await computeRecipeCosts(supabase, recipes.map(r => r.id))
    } catch (err) {
      if (!periodReq.isCurrent(key)) return
      setLoadError(err); setItems([]); setLoading(false); return
    }
    if (!periodReq.isCurrent(key)) return

    if (!recipes) { setLoading(false); return }

    // Per-recipe rollups, in ONE pass — `sales` is the biggest array on the page and a `.filter()`
    // per recipe inside the `.map()` below would walk it once per dish.
    //
    // Revenue is priced exactly the way `Sales.js`'s `recipeRevenue()` prices it, which is the
    // house convention: the row's own `unit_price` snapshot wins and the recipe's current
    // `selling_price` is only a fallback for rows written before that snapshot existed. This page
    // multiplied EVERY row by today's price, so a past month's revenue silently restated itself
    // the moment anyone edited a menu price — the same defect BestSellers records having fixed.
    const qtyMap = {}, pricedRev = {}, unpricedQty = {}, discMap = {}
    ;(sales || []).forEach(s => {
      if (s.source === 'pos_comp') return
      const qty = parseFloat(s.qty_sold) || 0
      qtyMap[s.recipe_id]  = (qtyMap[s.recipe_id] || 0) + qty
      discMap[s.recipe_id] = (discMap[s.recipe_id] || 0) + (parseFloat(s.discount) || 0)
      if (s.unit_price != null) {
        pricedRev[s.recipe_id] = (pricedRev[s.recipe_id] || 0) + qty * (parseFloat(s.unit_price) || 0)
      } else {
        unpricedQty[s.recipe_id] = (unpricedQty[s.recipe_id] || 0) + qty
      }
    })

    // Enrich recipes
    const enriched = recipes.map(r => {
      // `recipeCostOf`, not `ingMap[r.id] || 0` — a dish costed by hand through Menu Pricing's
      // + Add Item has no ingredients and was rated Unrated here while Menu Pricing showed its
      // cost and its FC%. The same dish must not be costed on one screen and uncosted on another
      // (S724). Applied to `computeMenuEngineeringSection.js` in the same change: that section is
      // FROZEN at period close, so the two diverging would put a quadrant into a snapshot nothing
      // recomputes, with nothing in the artifact to say which definition produced it.
      const ingredientCost = recipeCostOf(ingMap, r) || 0
      const sellingPrice   = parseFloat(r.selling_price) || 0
      // null, never 0, when either half is missing — see shared/menuEngineering.js.
      const fcPct          = menuFcPct(ingredientCost, sellingPrice)
      const unrated        = unratedReason(ingredientCost, sellingPrice)
      const qtySold        = qtyMap[r.id] || 0
      const revenue        = (pricedRev[r.id] || 0)
        + (unpricedQty[r.id] || 0) * sellingPrice
        - (discMap[r.id] || 0)
      return { ...r, ingredientCost, sellingPrice, fcPct, unrated, qtySold, revenue }
    })

    // Median qty sold across every recipe on the menu — unsold and unrated ones included, exactly
    // as before. Narrowing it would re-classify dishes that have not changed.
    const med = median(enriched.map(r => r.qtySold))

    // Classify. `quadrant` is null for anything we could not rate.
    const final = enriched.map(r => ({
      ...r,
      quadrant: classify(r.fcPct, r.qtySold, med),
      medianQty: med,
    }))

    setItems(final)
    setLoading(false)
    writeMeClass(final, periodId)
  }

  // Writes the quadrant back to `recipes.me_class`, which POS's suggestion engine reads live.
  //
  // Two things were wrong with the one-liner this replaces, and it had been that way since the
  // day it was written (commit e8e3d18):
  //
  //   1. **It never ran at all.** `scopedUpdate(...).eq('id', r.id)` builds a PostgREST builder,
  //      and postgrest-js only issues the request inside `then()` — an un-awaited builder sends
  //      nothing. So `me_class` has always been NULL for every client, and the Pro-tier
  //      Menu-Engineering ranking in the POS suggestion engine has never had data to rank on.
  //   2. **It wrote from whatever period was on screen.** Opening last Shrawan out of curiosity
  //      would have re-labelled tonight's till suggestions with a year-old month's classification.
  //      That is precisely why computeMenuEngineeringSection.js refuses to port this write.
  //
  // One request per distinct class instead of one per recipe (a 300-dish menu was 300), chunked
  // because the id list rides in the URL, and unrated dishes are written back as NULL so a dish
  // that loses its price stops carrying a stale verdict into the till.
  async function writeMeClass(rows, forPeriodId) {
    setClassWriteError(null)
    if (!forPeriodId || forPeriodId !== livePeriodId) return
    const byClass = new Map()
    rows.forEach(r => {
      const cls = r.quadrant ? r.quadrant.toLowerCase() : null
      if (!byClass.has(cls)) byClass.set(cls, [])
      byClass.get(cls).push(r.id)
    })
    for (const [cls, ids] of byClass) {
      const { error } = await runChunkedByIds(ids, chunk =>
        scopedUpdate('recipes', { me_class: cls }).in('id', chunk))
      if (error) {
        // Converted at the CALL SITE, and worded as the consequence rather than the constraint:
        // the report above is correct, what failed is the copy the till reads.
        setClassWriteError({
          text: 'These quadrants are on screen, but the copy the POS order screen reads could not be updated — its "Chef\'s pick" suggestions will keep ranking on the previous classification until this page loads cleanly again.',
          detail: asActionError(error).detail,
        })
        return
      }
    }
  }

  const filtered = useMemo(() => {
    const needle = search.toLowerCase()
    return items.filter(r => {
      const matchQ = filterQ === 'All'
        ? true
        : filterQ === UNRATED.key ? r.quadrant == null : r.quadrant === filterQ
      const matchS = r.name.toLowerCase().includes(needle)
      return matchQ && matchS
    })
  }, [items, filterQ, search])

  // Quadrant summary counts, plus the fifth bucket for what could not be rated at all.
  const summary = useMemo(() => {
    const s = { Star: 0, Plowhorse: 0, Puzzle: 0, Dog: 0, [UNRATED.key]: 0 }
    items.forEach(r => { s[r.quadrant == null ? UNRATED.key : r.quadrant]++ })
    return s
  }, [items])
  const unratedCount = summary[UNRATED.key]

  const medianQty = items[0]?.medianQty ?? 0

  const totalRevenue = filtered.reduce((a, r) => a + r.revenue, 0)
  const totalQty     = filtered.reduce((a, r) => a + r.qtySold, 0)

  // For matrix view — group by quadrant, with the unrated dishes in their own list rather than
  // silently absent from all four panels.
  const byQuadrant = useMemo(() => {
    const map = { Star: [], Plowhorse: [], Puzzle: [], Dog: [], [UNRATED.key]: [] }
    filtered.forEach(r => map[r.quadrant == null ? UNRATED.key : r.quadrant].push(r))
    return map
  }, [filtered])

  // Charts — always use all items (full picture regardless of filter). Unrated dishes have no
  // profitability to plot, so they are left out and the footer says how many.
  const scatterData = useMemo(() =>
    items
      .filter(r => r.fcPct != null)
      .map(r => ({
        x: r.qtySold,
        y: parseFloat((100 - r.fcPct).toFixed(1)), // higher = more profitable
        name: r.name, fcPct: r.fcPct, qtySold: r.qtySold,
        revenue: r.revenue, quadrant: r.quadrant, sellingPrice: r.sellingPrice,
      }))
  , [items])

  // A dish costing more than it sells for is real (Recipes.js warns about it at save time) and
  // plots below zero. The axis floor follows the data so a loss-maker is visible instead of
  // sitting outside a hardcoded [0,100] domain — the one dot on the chart most worth seeing.
  const profitFloor = useMemo(() => {
    const lowest = scatterData.reduce((m, d) => Math.min(m, d.y), 0)
    return lowest < 0 ? Math.floor(lowest / 10) * 10 : 0
  }, [scatterData])

  const topItems = useMemo(() =>
    [...items]
      .filter(r => r.revenue > 0)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10)
      .map(r => ({ name: r.name.length > 22 ? r.name.slice(0, 20) + '…' : r.name, revenue: Math.round(r.revenue), quadrant: r.quadrant }))
  , [items])
  const allItemsRevenue = useMemo(() => items.reduce((s, r) => s + r.revenue, 0), [items])
  const topItemsRevenue = useMemo(() => topItems.reduce((s, r) => s + r.revenue, 0), [topItems])

  const categoryPivot = useMemo(() => {
    const map = {}
    items.forEach(r => {
      const cat = r.category || 'Uncategorized'
      if (!map[cat]) map[cat] = { Star: 0, Plowhorse: 0, Puzzle: 0, Dog: 0, [UNRATED.key]: 0, total: 0 }
      map[cat][r.quadrant == null ? UNRATED.key : r.quadrant]++
      map[cat].total++
    })
    return Object.entries(map).sort((a, b) => b[1].total - a[1].total)
  }, [items])

  // The pivot's columns: the four quadrants, plus Not rated only when there is something in it —
  // an always-on column of dashes is a claim that this client has a problem it may not have.
  const pivotCols = useMemo(
    () => (unratedCount > 0 ? [...QUADRANT_KEYS, UNRATED.key] : QUADRANT_KEYS),
    [unratedCount]
  )
  const colStyle = key => (key === UNRATED.key ? UNRATED : QUADRANTS[key])
  const colHex   = key => (key === UNRATED.key ? null : Q_HEX[key])

  const selectedPeriod = periods.find(p => p.id === periodId)

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read must not wear NoPeriodState (S612 silent-zero rule).
  if (periodsLoaded && !loadError && periods.length === 0) return <NoPeriodState what="menu engineering" />

  return (
    <div>
      {/* Header */}
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Menu Engineering</h1>
          <p className="page-subtitle">
            Every dish placed by profitability against popularity, to guide what to promote,
            reprice or cut
          </p>
          <div className="page-scope-row">
            <PeriodScope label={selectedPeriod?.label} status={selectedPeriod?.status} provisionalWhenOpen />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Period" className="form-select" value={periodId} onChange={e => setPeriodId(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          {/* View toggle */}
          <div className="tab-bar">
            <button className={`tab-btn${viewMode === 'table'  ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('table')}>☰ Table</button>
            <button className={`tab-btn${viewMode === 'matrix' ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('matrix')}>⊞ Matrix</button>
            <button className={`tab-btn${viewMode === 'charts' ? ' tab-btn--active' : ''}`} onClick={() => setViewMode('charts')}>◉ Charts</button>
          </div>
        </div>
      </div>

      {/* Quadrant summary cards and the filter bar are BOTH inside the loaded-and-succeeded guard
          (S616). They used to sit above the ternary, so a failed read rendered four confident
          zeros — "Star 0 · Plowhorse 0 · Puzzle 0 · Dog 0", the most reassuring possible reading
          of a menu — plus "0 items · Revenue: NPR 0" directly above the error card, and the same
          four zeros on every ordinary load before the data arrived. */}
      {!loading && !loadError && items.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 20 }}>
            {[...Object.entries(QUADRANTS), ...(unratedCount > 0 ? [[UNRATED.key, UNRATED]] : [])].map(([name, q]) => (
              <button
                key={name}
                type="button"
                aria-pressed={filterQ === name}
                onClick={() => setFilterQ(filterQ === name ? 'All' : name)}
                style={{
                  background: filterQ === name ? q.bg : 'var(--theme-card)',
                  border: `1px solid ${filterQ === name ? q.border : 'var(--theme-border)'}`,
                  borderRadius: 'var(--radius-sm)', padding: '14px 16px', cursor: 'pointer',
                  transition: 'background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard)',
                  font: 'inherit', textAlign: 'left', width: '100%',
                  // A <button> centres its content, so in an auto-fit grid that stretches every
                  // card to the tallest one these labels would sink away from the top while a
                  // plain div beside them stayed put (S691).
                  display: 'flex', flexDirection: 'column', justifyContent: 'flex-start',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 18, color: q.color }}>{q.icon}</span>
                  <span style={{
                    fontSize: 22, fontWeight: 700, color: q.color
                  }}>{summary[name]}</span>
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>{q.label || name}</div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>{q.desc}</div>
              </button>
            ))}
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <input aria-label="Search menu items"
              className="form-input form-input--auto"
              placeholder="Search menu items…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: 220 }}
            />
            <select aria-label="Filter by quadrant" className="form-select" value={filterQ} onChange={e => setFilterQ(e.target.value)}>
              <option value="All">All Quadrants</option>
              {QUADRANT_KEYS.map(q => <option key={q} value={q}>{q}</option>)}
              {unratedCount > 0 && <option value={UNRATED.key}>{UNRATED.label}</option>}
            </select>
            <span style={{ fontSize: 12, color: 'var(--theme-text2)', marginLeft: 'auto' }}>
              {filtered.length} item{filtered.length !== 1 ? 's' : ''} · Revenue: NPR {totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })} · Qty: {totalQty.toLocaleString('en-IN')}
            </span>
          </div>
        </>
      )}

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p></div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : items.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-state-icon">◎</div>
            <p className="empty-state-text">No menu items found. Add recipes with selling prices and record sales to see the matrix.</p>
          </div>
        </div>
      ) : viewMode === 'charts' ? (
        /* CHARTS VIEW */
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

          {/* Scatter chart — FC% Profitability vs Qty Sold */}
          <ChartCard
            title={<>Popularity vs Profitability <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text2)', marginLeft: 10, textTransform: 'none', letterSpacing: 0 }}>Each dot = one menu item</span></>}
            titleStyle={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}
            cardStyle={{ padding: '20px 20px 12px' }}
            smallHeight={320}
            legend={
              <div style={{ display: 'flex', gap: 16 }}>
                {Object.entries(Q_HEX).map(([name, hex]) => (
                  <span key={name} style={{ fontSize: 11, color: 'var(--theme-text2)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 0, background: hex, display: 'inline-block' }} />
                    {name}
                  </span>
                ))}
              </div>
            }
            footer={
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 4 }}>
                  {[
                    { q: 'Star',      pos: 'right + top (high qty, low FC%)',     hint: 'Keep, feature prominently' },
                    { q: 'Plowhorse', pos: 'left + top (low qty, low FC%)',       hint: 'Good margin — promote harder' },
                    { q: 'Puzzle',    pos: 'right + bottom (high qty, high FC%)', hint: 'Popular — review recipe cost' },
                    { q: 'Dog',       pos: 'left + bottom (low qty, high FC%)',   hint: 'Consider redesign or removal' },
                  ].map(({ q, pos, hint }) => (
                    <div key={q} style={{ background: 'var(--theme-table-hover)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: Q_HEX[q], display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 0, background: Q_HEX[q], display: 'inline-block', flexShrink: 0 }} />
                          {QUADRANTS[q].icon} {q}
                        </span>
                        <span>{summary[q]} item{summary[q] !== 1 ? 's' : ''}</span>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--theme-text3)', marginTop: 2 }}>{pos}</div>
                      <div style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 2 }}>{hint}</div>
                    </div>
                  ))}
                </div>
                {/* A dot that is not on the chart has to be accounted for on the chart, or the
                    reader counts what they can see and believes it is the whole menu. */}
                {unratedCount > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 8 }}>
                    {unratedCount} dish{unratedCount !== 1 ? 'es' : ''} not plotted — {UNRATED.desc.toLowerCase()}, so there is no food cost to place them against.
                  </div>
                )}
              </>
            }
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <ScatterChart margin={{ top: 10, right: 20, bottom: 30, left: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={colors.border} />
                  <XAxis type="number" dataKey="x" name="Qty Sold" label={{ value: 'Qty Sold →', position: 'insideBottom', offset: -16, fill: colors.text3, fontSize: 11 }} tick={{ fill: colors.text3, fontSize: 11 }} />
                  {/* Floor follows the data rather than sitting at a hardcoded 0: a dish costing
                      more than it sells for has negative profitability, and pinning the domain
                      pushed exactly that dot off the chart. */}
                  <YAxis type="number" dataKey="y" name="Profitability" domain={[profitFloor, 100]} label={{ value: 'Profitability % →', angle: -90, position: 'insideLeft', offset: 10, fill: colors.text3, fontSize: 11 }} tick={{ fill: colors.text3, fontSize: 11 }} tickFormatter={v => `${v}%`} />
                  <ReferenceLine x={medianQty} stroke={colors.borderLt} strokeDasharray="5 4" label={{ value: `median ${medianQty.toFixed(0)}`, position: 'top', fill: colors.text3, fontSize: 10 }} />
                  <ReferenceLine y={100 - FC_CUTOFF} stroke={colors.borderLt} strokeDasharray="5 4" label={{ value: `FC ${FC_CUTOFF}%`, position: 'right', fill: colors.text3, fontSize: 10 }} />
                  <ReferenceLine x={0} stroke="none" label={{ value: '★ STARS', position: 'insideTopRight', fill: '#34d399', fontSize: 9, offset: 8 }} />
                  <RTooltip content={<ScatterTooltipContent />} cursor={{ strokeDasharray: '3 3' }} />
                  <Scatter data={scatterData} shape={<ScatterDot />} {...chartMotion()} />
                </ScatterChart>
              </ResponsiveContainer>
            )}
          />

          {/* Bottom row: Top Revenue Items + Category Pivot */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

            {/* Top 10 by Revenue */}
            <ChartCard
              title="Top Items by Revenue"
              titleStyle={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}
              cardStyle={{ padding: '16px 16px 8px' }}
              smallHeight={Math.max(topItems.length * 32 + 20, 80)}
              footer={topItems.length > 0 && (
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 8 }}>
                  Top {topItems.length} = <strong style={{ color: 'var(--theme-text1)' }}>NPR {topItemsRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                  {allItemsRevenue > 0 && <> · <span style={{ color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{((topItemsRevenue / allItemsRevenue) * 100).toFixed(0)}%</span> of total menu revenue</>}
                </div>
              )}
              renderChart={h => topItems.length === 0 ? (
                <p style={{ fontSize: 12, color: 'var(--theme-text3)' }}>No sales recorded this period.</p>
              ) : (
                <ResponsiveContainer width="100%" height={h}>
                  <BarChart data={topItems} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={140} tick={{ fill: colors.text3, fontSize: 11 }} />
                    <RTooltip content={<BarTooltipContent />} cursor={{ fill: colors.tableHover }} />
                    <Bar dataKey="revenue" radius={[0, 4, 4, 0]} {...chartMotion()}>
                      {topItems.map((entry, i) => (
                        <Cell key={i} fill={Q_HEX[entry.quadrant] || '#c9a84c'} fillOpacity={0.8} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            />

            {/* Category Pivot */}
            <div className="card" style={{ padding: '16px' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 12 }}>
                Category Breakdown
                <Tip text="How each menu category distributes across the four quadrants. A category heavy in Dogs or Puzzles may need a pricing or cost review. A Not rated column appears when some dishes have no selling price or no costed ingredients." width={240}>
                  <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-text3)', cursor: 'default' }}>?</span>
                </Tip>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', color: 'var(--theme-text3)', fontWeight: 600, padding: '4px 8px 8px 0', borderBottom: '1px solid var(--theme-border)' }}>Category</th>
                      {pivotCols.map(name => (
                        <th key={name} style={{ textAlign: 'center', color: colHex(name) || colStyle(name).color, fontWeight: 700, padding: '4px 6px 8px', borderBottom: '1px solid var(--theme-border)', fontSize: 11 }}>
                          {colStyle(name).icon}<br />{colStyle(name).label || name}
                        </th>
                      ))}
                      <th style={{ textAlign: 'right', color: 'var(--theme-text3)', fontWeight: 600, padding: '4px 0 8px 6px', borderBottom: '1px solid var(--theme-border)' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {categoryPivot.map(([cat, counts]) => (
                      <tr key={cat} style={{ borderBottom: '1px solid var(--theme-border-lt)' }}>
                        <td style={{ padding: '7px 8px 7px 0', color: 'var(--theme-text1)', fontWeight: 500 }}>{cat}</td>
                        {pivotCols.map(q => (
                          <td key={q} style={{ textAlign: 'center', padding: '7px 6px', color: counts[q] > 0 ? (colHex(q) || colStyle(q).color) : 'var(--theme-text3)', fontWeight: counts[q] > 0 ? 700 : 400 }}>
                            {counts[q] > 0 ? counts[q] : '—'}
                          </td>
                        ))}
                        <td style={{ textAlign: 'right', padding: '7px 0 7px 6px', color: 'var(--theme-text2)' }}>{counts.total}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td style={{ padding: '8px 8px 4px 0', color: 'var(--theme-text3)', fontWeight: 600, fontSize: 11 }}>TOTAL</td>
                      {pivotCols.map(q => (
                        <td key={q} style={{ textAlign: 'center', padding: '8px 6px 4px', fontWeight: 700, color: colHex(q) || colStyle(q).color }}>{summary[q]}</td>
                      ))}
                      <td style={{ textAlign: 'right', padding: '8px 0 4px 6px', color: 'var(--theme-text2)', fontWeight: 600 }}>{items.length}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

          </div>
        </div>
      ) : viewMode === 'table' ? (
        /* TABLE VIEW */
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Menu Item</th>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}>Selling Price</th>
                  <th style={{ textAlign: 'right' }}>Ingredient Cost</th>
                  <th style={{ textAlign: 'right' }}>FC%</th>
                  <th style={{ textAlign: 'right' }}>Qty Sold</th>
                  <th style={{ textAlign: 'right' }}>Revenue (NPR)</th>
                  <th>Quadrant</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const q = r.quadrant ? QUADRANTS[r.quadrant] : UNRATED
                  // fcBand(null) already returns the "—" band with no mark, so an unrated dish
                  // gets a neutral dash rather than the green 0.0% ✓ it used to wear.
                  const fc = fcBand(r.fcPct, settings)
                  return (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.name}</td>
                      <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{r.category || '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.sellingPrice > 0 ? r.sellingPrice.toLocaleString('en-IN') : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{r.ingredientCost > 0 ? r.ingredientCost.toFixed(2) : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span title={fc.key === 'none' ? undefined : fc.label} style={{ color: fc.color, fontWeight: 600 }}>
                          {r.fcPct != null ? `${r.fcPct.toFixed(1)}% ${fc.mark}` : '—'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right' }}>{r.qtySold > 0 ? r.qtySold.toLocaleString('en-IN') : <span style={{ color: 'var(--theme-text3)' }}>0</span>}</td>
                      <td style={{ textAlign: 'right' }}>{r.revenue > 0 ? r.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
                      <td>
                        <span style={{
                          fontSize: 12, fontWeight: 700,
                          background: q.bg, color: q.color,
                          border: `1px solid ${q.border}`,
                          borderRadius: 'var(--radius-xs)', padding: '3px 8px',
                          whiteSpace: 'nowrap'
                        }}>
                          {q.icon} {r.quadrant || UNRATED.label}
                        </span>
                      </td>
                      <td style={{ fontSize: 11, color: 'var(--theme-text2)', maxWidth: 160 }}>
                        {r.quadrant === 'Star'      && 'Keep on menu. Feature prominently.'}
                        {r.quadrant === 'Plowhorse' && 'Good margin. Promote to boost volume.'}
                        {r.quadrant === 'Puzzle'    && 'Review recipe cost. Can price be raised?'}
                        {r.quadrant === 'Dog'       && 'Consider removing or redesigning.'}
                        {/* The reason IS the next step — which half is missing tells the reader
                            exactly where to go and fix it. */}
                        {r.quadrant == null && r.unrated}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* MATRIX VIEW — 2x2 quadrant grid, with the unrated dishes in a full-width panel below.
           They belong to no quadrant, and leaving them out of all four made them vanish from the
           view entirely — the four panel counts would not add up to the menu and nothing said why. */
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          {[...Object.entries(QUADRANTS), ...(byQuadrant[UNRATED.key].length > 0 ? [[UNRATED.key, UNRATED]] : [])].map(([name, q]) => (
            <div key={name} style={{
              background: 'var(--theme-card)',
              border: `1px solid ${q.border}`,
              borderRadius: 'var(--radius-md)', overflow: 'hidden',
              ...(name === UNRATED.key ? { gridColumn: '1 / -1' } : null),
            }}>
              {/* Quadrant header */}
              <div style={{
                background: q.bg, padding: '12px 16px',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                borderBottom: `1px solid ${q.border}`
              }}>
                <div>
                  <span style={{ fontSize: 14, fontWeight: 700, color: q.color }}>{q.icon} {q.label || name}</span>
                  <span style={{ fontSize: 11, color: 'var(--theme-text2)', marginLeft: 10 }}>{q.desc}</span>
                </div>
                <span style={{ fontSize: 18, fontWeight: 700, color: q.color }}>{byQuadrant[name].length}</span>
              </div>
              {/* Items */}
              <div style={{ padding: '8px 0', minHeight: 60 }}>
                {byQuadrant[name].length === 0 ? (
                  <p style={{ color: 'var(--theme-text3)', fontSize: 12, textAlign: 'center', padding: '16px 0' }}>No items</p>
                ) : byQuadrant[name].map(r => {
                  const fc = fcBand(r.fcPct, settings)
                  return (
                    <div key={r.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 16px', borderBottom: '1px solid var(--theme-border)'
                    }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{r.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{r.unrated || r.category || '—'}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div title={fc.key === 'none' ? undefined : fc.label} style={{ fontSize: 12, fontWeight: 700, color: fc.color }}>
                          {r.fcPct != null ? `${r.fcPct.toFixed(1)}% ${fc.mark}` : '—'} FC
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{r.qtySold} sold</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* The me_class write-back's own failure. Non-blocking and BELOW the report, because the
          figures above it are correct either way — what has failed is the copy POS reads. Named
          as a consequence, not as a constraint. */}
      {classWriteError && (
        <div style={{ marginTop: 16 }}>
          <ActionError error={classWriteError} />
        </div>
      )}

      {/* Legend */}
      {!loading && !loadError && items.length > 0 && (
        <div className="card" style={{ marginTop: 16, display: 'flex', gap: 24, flexWrap: 'wrap', padding: '12px 20px' }}>
          <span style={{ fontSize: 11, color: 'var(--theme-text2)', alignSelf: 'center' }}>Thresholds:</span>
          <Tip text={`Dishes with food cost ≤ ${FC_CUTOFF}% of selling price are 'high profit'. Above ${FC_CUTOFF}% = low profit. A dish with no selling price or no costed ingredients has no food cost to judge, so it is listed as Not rated rather than being placed in a quadrant.`}>
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>FC% cutoff <span style={{ color: 'var(--theme-accent-ink)' }}>{FC_CUTOFF}%</span></span>
          </Tip>
          <Tip text={`Median portions sold this period, across every dish on the menu. Dishes at or above ${medianQty.toFixed(0)} are 'high popularity'; below that, and anything that sold nothing at all, is low popularity.`}>
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Volume cutoff <span style={{ color: 'var(--theme-accent-ink)' }}>median = {medianQty.toFixed(1)} portions</span></span>
          </Tip>
          <Tip text="The Bikram Sambat period being analysed. Change the period in the dropdown above to compare months.">
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Period <span style={{ color: 'var(--theme-accent-ink)' }}>{selectedPeriod?.label || ''}</span></span>
          </Tip>
        </div>
      )}
    </div>
  )
}
