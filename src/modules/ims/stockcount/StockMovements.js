import { useEffect, useState } from 'react'
import { useSearchParams, Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { viewPosBill } from '../../../utils/viewPosBill'
import { BS_MONTHS, daysInBsMonth, formatBsDay } from '../../../utils/bsCalendar'
import { loadSubRecipeUsage, usageForSource, subRecipeHasIngredient, EMPTY_USAGE } from './subRecipeUsage'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import ReportLoadError from '../../../components/ReportLoadError'
import { printWithTitle } from '../../../utils/printTitle'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'

export default function StockMovements() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [searchParams] = useSearchParams()

  const periodReq = useLatestRequest()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [rows, setRows] = useState([])
  const [staffNames, setStaffNames] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [search, setSearch] = useState('')
  const [filterSource, setFilterSource] = useState('all')
  const [dayFrom, setDayFrom] = useState('')
  const [dayTo, setDayTo] = useState('')
  const [noBomRecipes, setNoBomRecipes] = useState([])
  const [tab, setTab] = useState('items')
  const [usage, setUsage] = useState(EMPTY_USAGE)
  const [ingSearch, setIngSearch] = useState('')
  // Sort is per-tab: the two tables share no columns, so one shared key would be meaningless on
  // whichever tab wasn't selected when it was set.
  const [itemSort, setItemSort] = useState('day')
  const [subSort, setSubSort] = useState('value')
  const [sortDir, setSortDir] = useState('desc')

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    setLoadError(null)
    const { data: p, error: pErr } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    // A failed read is not "no periods yet" — surface it instead of rendering empty (S612 silent-zero rule).
    if (pErr) { setLoadError(pErr.message); setLoading(false); return }
    setPeriods(p || [])

    // Arriving from Reorder Report's "Book Stock" link (?period=&item=) lands on that same
    // period instead of always defaulting to open — the item name pre-fills the search box
    // rather than adding a second, hidden filter mode alongside the visible one.
    const periodParam = searchParams.get('period')
    const itemParam = searchParams.get('item')
    const target = (p || []).find(x => x.id === periodParam) || (p || []).find(x => x.status === 'open')
    if (target) { setSelectedPeriod(target); await loadReport(target.id, itemParam) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setDayFrom('')
    setDayTo('')
    setLoading(true)
    await loadReport(periodId)
    setLoading(false)
  }

  async function loadReport(periodId, presetItemId) {
    setLoadError(null)
    // Sub-recipe usage is derived from sales_entries, not from the ledger below — see
    // subRecipeUsage.js. Loaded alongside rather than lazily on tab switch: it shares the period
    // and feeds the reconciliation note, which has to be right the moment the page paints.
    loadSubRecipeUsage(supabase, scopedFrom, periodId)
      .then(u => { if (periodReq.isCurrent(periodId)) setUsage(u) })
      .catch(err => {
        console.error('sub-recipe usage failed:', err)
        if (!periodReq.isCurrent(periodId)) return   // a stale load's failure must not clobber the current view
        // The helper now throws on a failed read — degrading to EMPTY_USAGE rendered a believable
        // "quiet period" over an error (S612 silent-zero rule).
        setUsage(EMPTY_USAGE)
        setLoadError(err?.message || String(err))
      })

    const results = await Promise.all([
      // Paged, not a bare select: a busy period exceeds PostgREST's 1000-row cap, which returns
      // silently truncated data and understated every stat card below (S528 — found live at
      // exactly "1000 movements"). `id` is the unique tiebreaker that makes the paging stable,
      // since created_at alone is not unique across rows written by the same bill.
      fetchAllRows(() => scopedFrom('stock_movements',
        'id, item_id, bs_day, qty, source, ref_id, created_at, ' +
        'items(name, uom, item_code, per_uom_rate, categories(name)), ' +
        'pos_orders(order_no, close_type, closed_by)'
      ).eq('period_id', periodId).order('created_at', { ascending: false }).order('id')),
      supabase.rpc('get_client_profile_names', { p_client_id: effectiveClientId }),
      // sales_entries is period_id-scoped, not client_id-scoped — stays on raw supabase.from() (see scopedDb notes).
      // No source filter: manual Sales Entry saves deplete stock too (S492), same as POS, so a
      // recipe with no BOM is a gap regardless of which one sold it.
      fetchAllRows(() => supabase.from('sales_entries').select('recipe_id').eq('period_id', periodId).order('id')),
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read must never flow through the `|| []`s below into a confident NPR-0 ledger (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); return }
    const [{ data: movements }, { data: profs }, { data: soldEntries }] = results
    setStaffNames(Object.fromEntries((profs || []).map(s => [s.id, s.full_name])))

    // Cross-reference recipes actually sold this period against ones with zero recipe_ingredients
    // rows — explodeRecipeIngredients() (PosOrders.jsx/depleteManualSales()) produces nothing to
    // deplete for those, so they were sold but never wrote a stock_movements row and would
    // otherwise vanish silently.
    const soldRecipeIds = [...new Set((soldEntries || []).map(s => s.recipe_id).filter(Boolean))]
    if (soldRecipeIds.length > 0) {
      const bomResults = await Promise.all([
        supabase.from('recipe_ingredients').select('recipe_id').in('recipe_id', soldRecipeIds),
        scopedFrom('recipes', 'id, name').in('id', soldRecipeIds),
      ])
      if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
      // S612: a failed read here would silently hide the no-BOM warning banner.
      const bomFailed = firstError(bomResults)
      if (bomFailed) { setLoadError(bomFailed); setRows([]); setNoBomRecipes([]); return }
      const [{ data: ingRows }, { data: recipeRows }] = bomResults
      const withIngredients = new Set((ingRows || []).map(r => r.recipe_id))
      setNoBomRecipes((recipeRows || []).filter(r => !withIngredients.has(r.id)).map(r => r.name).sort())
    } else {
      setNoBomRecipes([])
    }

    const built = (movements || []).map(m => {
      const item = m.items || {}
      const order = m.pos_orders || null
      const qtyAbs = Math.abs(parseFloat(m.qty) || 0)
      const value = qtyAbs * (parseFloat(item.per_uom_rate) || 0)
      return {
        id: m.id, item_id: m.item_id, ref_id: m.ref_id, item, order, qtyAbs, value,
        source: m.source, bsDay: m.bs_day,
        category: item.categories?.name || 'Uncategorised',
      }
    })
    setRows(built)

    if (presetItemId) {
      const match = built.find(r => r.item_id === presetItemId)
      if (match) setSearch(match.item.name)
    }
  }

  // Text sorts read naturally A→Z on "asc"; numeric ones read biggest-first on "desc". One
  // comparator handles both so the direction toggle means the same thing on every column.
  const dirMul = sortDir === 'asc' ? 1 : -1
  const cmp = (a, b) => (typeof a === 'string' ? a.localeCompare(b) : (a || 0) - (b || 0)) * dirMul

  const ITEM_SORTS = {
    day:      { label: 'Day',          get: r => r.bsDay },
    item:     { label: 'Item',         get: r => r.item.name || '' },
    category: { label: 'Category',     get: r => r.category || '' },
    qty:      { label: 'Qty Depleted', get: r => r.qtyAbs },
    source:   { label: 'Source',       get: r => r.source || '' },
    value:    { label: 'Value',        get: r => r.value },
  }
  const SUB_SORTS = {
    name:      { label: 'Sub-Recipe',    get: r => r.name || '' },
    qty:       { label: 'Qty Used',      get: r => r.qty },
    batches:   { label: 'Batches Used',  get: r => r.batches },
    batchCost: { label: 'Cost / Batch',  get: r => r.batchCost },
    value:     { label: 'Value',         get: r => r.value },
  }

  const filtered = rows.filter(r => {
    const matchSource = filterSource === 'all' || r.source === filterSource
    const matchSearch = (r.item.name || '').toLowerCase().includes(search.toLowerCase())
    const matchDay = (dayFrom === '' || (r.bsDay || 0) >= Number(dayFrom)) && (dayTo === '' || (r.bsDay || 0) <= Number(dayTo))
    return matchSource && matchSearch && matchDay
  }).sort((a, b) => cmp(ITEM_SORTS[itemSort].get(a), ITEM_SORTS[itemSort].get(b)))

  const totalValue = filtered.reduce((s, r) => s + r.value, 0)
  const compValue = filtered.filter(r => r.source === 'pos_comp').reduce((s, r) => s + r.value, 0)
  const itemsAffected = new Set(filtered.map(r => r.item?.name)).size

  // Sub-recipe usage shares the search + source filters (both map cleanly onto the sales rows it
  // derives from) but deliberately not the Day range — the derivation includes Bulk rows, which
  // carry bs_day 0 and belong to no single day, so a day filter here would quietly drop them.
  const ingQ = ingSearch.trim().toLowerCase()
  const subRows = usage.rows
    .map(r => usageForSource(r, filterSource))
    .filter(r => r.qty > 0
      && (r.name || '').toLowerCase().includes(search.toLowerCase())
      && subRecipeHasIngredient(r, ingQ))
    .sort((a, b) => cmp(SUB_SORTS[subSort].get(a), SUB_SORTS[subSort].get(b)))
  const subValueTotal = subRows.reduce((s, r) => s + r.value, 0)
  const subBatchTotal = subRows.reduce((s, r) => s + r.batches, 0)
  const subQtyIsComparable = new Set(subRows.map(r => r.yieldUom)).size === 1

  // Reconciliation. The sub-recipe figures come from sales_entries; the ledger is what was
  // actually written. They legitimately diverge — manual-sales depletion only started 2026-07-30
  // with no backfill, credit notes never restore stock, and a recipe with no ingredients depletes
  // nothing — so when the derivation's own raw-item value doesn't match the ledger's, say why
  // rather than leaving two numbers on one page disagreeing in silence.
  // Compared against the UNFILTERED ledger total, since the derivation ignores the day filter.
  const ledgerTotalValue = rows.reduce((s, r) => s + r.value, 0)
  const reconGap = usage.derivedItemValue - ledgerTotalValue
  // `!loading` matters: the usage derivation resolves independently of the ledger fetch, so
  // without it there's a window where usage has landed but `rows` is still empty and the gap
  // reads as the entire period's value.
  const showRecon = !loading && usage.rows.length > 0 &&
    Math.abs(reconGap) > Math.max(1, usage.derivedItemValue * 0.005)

  // Titles the print job after the tab actually on screen — printWithTitle sets document.title so
  // the browser's "Save as PDF" suggests a useful filename instead of the app's static one.
  function printCurrentTab() {
    printWithTitle(`${tab === 'subs' ? 'Sub-Recipe Usage' : 'Stock Movements'} - ${periodLabel}`)
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const data = filtered.map(r => ({
      'Day': r.bsDay || '',
      'Item': r.item.name || '',
      'Category': r.category,
      'UOM': r.item.uom || '',
      'Qty Depleted': parseFloat(r.qtyAbs.toFixed(3)),
      'Source': r.source === 'pos_comp' ? 'POS Comp' : r.source === 'manual' ? 'Manual Entry' : 'POS Sale',
      'Order #': r.order?.order_no || '',
      'Staff': (r.order && staffNames[r.order.closed_by]) || '',
      'Value (NPR)': parseFloat(r.value.toFixed(0)),
    }))
    const ws = XLSX.utils.json_to_sheet(data)
    ws['!cols'] = [6,22,18,8,12,10,10,18,12].map(w => ({ wch: w }))
    const wb = XLSX.utils.book_new()
    const period = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : 'Report'
    XLSX.utils.book_append_sheet(wb, ws, 'Stock Movements')

    // Second sheet, not extra columns on the first — the raw-item ledger and the sub-recipe
    // rollup are different grains (one row per depletion vs one row per sub-recipe) and the
    // existing sheet's shape is left byte-identical so nobody's saved template breaks.
    if (subRows.length > 0) {
      const subData = subRows.map(r => ({
        'Sub-Recipe': r.name,
        'Yield per Batch': r.yieldQty ? `${r.yieldQty} ${r.yieldUom}` : '',
        'Qty Used': parseFloat(r.qty.toFixed(3)),
        'UOM': r.yieldUom,
        'Batches Used': parseFloat(r.batches.toFixed(3)),
        'Cost per Batch (NPR)': parseFloat(r.batchCost.toFixed(2)),
        'Value (NPR)': parseFloat(r.value.toFixed(0)),
        'Ingredients': (r.ingredients || []).join(', '),
      }))
      const subWs = XLSX.utils.json_to_sheet(subData)
      subWs['!cols'] = [24,16,12,8,13,20,12,60].map(w => ({ wch: w }))
      XLSX.utils.book_append_sheet(wb, subWs, 'Sub-Recipe Usage')
    }

    XLSX.writeFile(wb, `Stock_Movements_${period.replace(' ', '_')}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const maxDay = selectedPeriod ? daysInBsMonth(selectedPeriod.bs_year, selectedPeriod.bs_month) : 32

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read leaves periods empty, and NoPeriodState would wear the
  // failure as "no periods yet" (S612 silent-zero rule).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="the stock movement log" />

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Stock Movements</h1>
          <p className="page-subtitle">
            {tab === 'subs'
              ? `Prep-level view — which sub-recipes this period's sales consumed, and how many batches — ${periodLabel}`
              : `Ledger of every stock depletion from POS sales/comps and manual Sales Entry — ${periodLabel}`}
          </p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Tip text="Prints exactly what's on screen — the active tab, with the current search, source and sort filters applied, including the totals row." width={280}>
            <button className="btn btn-ghost" onClick={printCurrentTab} style={{ fontSize: 12 }}>🖨 Print</button>
          </Tip>
          <button className="btn btn-ghost" onClick={exportExcel} style={{ fontSize: 12 }}>Export Excel</button>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}</option>)}
          </select>
        </div>
      </div>

      {/* A failed read renders as a failure — never as a quiet ledger of zeros (S612). */}
      {loadError ? <ReportLoadError error={loadError} /> : <>

      {tab === 'subs' ? (
        <div className="stat-grid" style={{ marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-label">Sub-Recipes Used</div>
            <div className="stat-value">{subRows.length}</div>
            <div className="stat-sub">distinct prep items consumed</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Total batches across every sub-recipe below — a rough measure of how much prep work this period's sales required." width={260}>Batches Used</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, color: 'var(--theme-purple-text)' }}>{subBatchTotal.toLocaleString('en-NP', { maximumFractionDigits: 1 })}</div>
            <div className="stat-sub">summed across all sub-recipes</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Batches used × cost per batch. This is a slice of the raw-item value on the Raw Items tab, not an addition to it — the same ingredients, grouped by the prep item they went through." width={280}>Value</Tip></div>
            <div className="stat-value gold" style={{ fontSize: 18 }}>NPR {subValueTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
            <div className="stat-sub">at ingredient cost</div>
          </div>
        </div>
      ) : (
      <div className="stat-grid" style={{ marginBottom: 24 }}>
        <div className="stat-card">
          <div className="stat-label">Movements</div>
          <div className="stat-value">{filtered.length}</div>
          <div className="stat-sub">depletion entries this period</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Sum of qty depleted × per-unit rate across every movement below — the food-cost value POS activity consumed this period." width={260}>Value Depleted</Tip></div>
          <div className="stat-value gold" style={{ fontSize: 18 }}>NPR {totalValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
          <div className="stat-sub">POS sale + comp, at cost</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Same calc, restricted to POS Comp rows — the food-cost value of dishes given away complimentary, with zero revenue collected." width={260}>Comp Value</Tip></div>
          <div className="stat-value" style={{ fontSize: 18, color: 'var(--theme-purple-text)' }}>NPR {compValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</div>
          <div className="stat-sub">value given away</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Items Affected</div>
          <div className="stat-value">{itemsAffected}</div>
          <div className="stat-sub">distinct items depleted</div>
        </div>
      </div>
      )}

      <div className="tab-bar no-print" style={{ marginBottom: 16 }}>
        <button className={`tab-btn ${tab === 'items' ? 'tab-btn--active' : ''}`} onClick={() => setTab('items')}>
          Raw Items
        </button>
        <button className={`tab-btn ${tab === 'subs' ? 'tab-btn--active' : ''}`} onClick={() => setTab('subs')}>
          Sub-Recipes {usage.rows.length > 0 && `(${usage.rows.length})`}
        </button>
      </div>

      {noBomRecipes.length > 0 && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-amber-text)' }}>
          <span>⚠</span>
          <span>
            {noBomRecipes.length} item{noBomRecipes.length !== 1 ? 's' : ''} sold this period {noBomRecipes.length !== 1 ? 'have' : 'has'} no ingredients linked, so no stock was depleted for {noBomRecipes.length !== 1 ? 'them' : 'it'}: <strong>{noBomRecipes.join(', ')}</strong>. Add ingredients under Recipes to fix this going forward.
          </span>
        </div>
      )}

      <div className="no-print" style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 200 }}
          placeholder={tab === 'subs' ? 'Search sub-recipes…' : 'Search items…'} value={search} onChange={e => setSearch(e.target.value)} />
        <select aria-label="Filter by source" className="form-select" value={filterSource} onChange={e => setFilterSource(e.target.value)}>
          <option value="all">All Sources</option>
          <option value="pos_sale">POS Sale</option>
          <option value="pos_comp">POS Comp</option>
          <option value="manual">Manual Entry</option>
        </select>
        {/* Day range is Raw Items only — the sub-recipe rollup includes Bulk sales rows, which
            carry bs_day 0 and belong to no single day, so filtering it by day would silently
            drop them rather than narrow the view. */}
        {tab === 'items' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Tip text="Filters by Day within the selected period above — not a calendar date." width={220}>
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Day</span>
          </Tip>
          <select aria-label="Day from" className="form-select" style={{ width: 90 }} value={dayFrom} onChange={e => setDayFrom(e.target.value)}>
            <option value="">From</option>
            {Array.from({ length: maxDay }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <span style={{ color: 'var(--theme-text3)' }}>–</span>
          <select aria-label="Day to" className="form-select" style={{ width: 90 }} value={dayTo} onChange={e => setDayTo(e.target.value)}>
            <option value="">To</option>
            {Array.from({ length: maxDay }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          {(dayFrom !== '' || dayTo !== '') && (
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => { setDayFrom(''); setDayTo('') }}>✕ Clear</button>
          )}
        </div>
        )}

        {/* Sort. The two tabs have no columns in common, so each keeps its own key; the direction
            toggle is shared, since "biggest first" means the same thing on either table. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Sort</span>
          <select aria-label="Sort by"
            className="form-select"
            value={tab === 'subs' ? subSort : itemSort}
            onChange={e => (tab === 'subs' ? setSubSort : setItemSort)(e.target.value)}
          >
            {Object.entries(tab === 'subs' ? SUB_SORTS : ITEM_SORTS).map(([k, s]) => (
              <option key={k} value={k}>{s.label}</option>
            ))}
          </select>
          <Tip text="Ascending sorts text A→Z and numbers smallest-first; descending does the reverse." width={250}>
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, padding: '6px 10px' }}
              onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))}
              aria-label={`Sort ${sortDir === 'asc' ? 'ascending' : 'descending'} — click to reverse`}
            >
              {sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
            </button>
          </Tip>
        </div>

        {/* Ingredient search — Sub-Recipes only. Same idea as Recipes.js's "Find ingredient in
            recipes", and it sees through nesting for the same reason: `ingredients` is the fully
            exploded raw-item list, so searching "coffee" finds a sauce that only contains it via
            another sub-recipe. */}
        {tab === 'subs' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Tip text="Find every sub-recipe that uses an ingredient — e.g. type 'milk' to list all prep items containing it. Also matches ingredients hidden inside nested sub-recipes." width={300}>
            <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>ⓘ</span>
          </Tip>
          <div style={{ position: 'relative' }}>
            <input
              style={{ background: 'var(--theme-card)', border: `1px solid ${ingQ ? 'rgba(201,168,76,0.5)' : 'var(--theme-border)'}`, borderRadius: 'var(--radius-sm)', padding: '8px 12px 8px 30px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 240 }}
              placeholder="Find ingredient in sub-recipes…" value={ingSearch} onChange={e => setIngSearch(e.target.value)} />
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 13, color: 'var(--theme-text2)', pointerEvents: 'none' }}>🔍</span>
            {ingSearch && (
              <button onClick={() => setIngSearch('')} title="Clear"
                style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
            )}
          </div>
        </div>
        )}
        <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
          {tab === 'subs'
            ? `${subRows.length} sub-recipe${subRows.length !== 1 ? 's' : ''}`
            : `${filtered.length} entr${filtered.length !== 1 ? 'ies' : 'y'}`}
        </span>
      </div>

      {tab === 'subs' ? (
      <div className="card">
        <div style={{ marginBottom: 14 }}>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text2)' }}>
            <Tip text="A sub-recipe is never depleted as itself — recipe_ingredients stores it as a reference, so the ledger on the Raw Items tab only ever holds the raw ingredients at the bottom of the tree. This tab re-walks the same recipes against this period's sales to show the prep layer in between." width={320}>
              Derived from this period's sales entries
            </Tip>
            {' '}— not a second set of ledger rows. The same ingredients appear on the Raw Items tab; this groups them by the prep item they passed through.
          </p>
        </div>

        {/* Explains the gap against Recipe Costing's own sub-recipe count, which is the master
            list rather than a per-period figure — and the unused names are worth seeing in their
            own right (prep items nothing sold this period touched). */}
        {usage.unusedSubRecipes.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 14, lineHeight: 1.7 }}>
            <strong style={{ color: 'var(--theme-text1)' }}>{usage.unusedSubRecipes.length}</strong> of your{' '}
            <strong style={{ color: 'var(--theme-text1)' }}>{usage.totalSubRecipes}</strong> sub-recipes weren't used this period
            {' '}<Tip text="Recipe Costing counts every sub-recipe on file. This tab counts only the ones this period's sales actually consumed, so the difference is prep items nothing sold touched — worth a look if the kitchen still preps any of them to stock." width={320}>
              <span style={{ color: 'var(--theme-text3)', cursor: 'help' }}>ⓘ</span>
            </Tip>:
            {' '}<span style={{ color: 'var(--theme-text3)' }}>{usage.unusedSubRecipes.join(', ')}</span>
          </div>
        )}

        {usage.miscategorised.length > 0 && (
          <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 14, fontSize: 12, color: 'var(--theme-amber-text)' }}>
            {usage.miscategorised.length} recipe{usage.miscategorised.length !== 1 ? 's are' : ' is'} used as an ingredient by another recipe but {usage.miscategorised.length !== 1 ? 'are' : 'is'} not categorised as a Sub-Recipe: <strong>{usage.miscategorised.join(', ')}</strong>. {usage.miscategorised.length !== 1 ? 'They' : 'It'} still count{usage.miscategorised.length !== 1 ? '' : 's'} here, but not in Recipe Costing's sub-recipe total — set the category on the recipe to make the two agree.
          </div>
        )}

        {showRecon && (
          <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 14, fontSize: 12, color: 'var(--theme-amber-text)' }}>
            These figures imply NPR {usage.derivedItemValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })} of raw ingredients, but the ledger recorded NPR {ledgerTotalValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
            {' '}({reconGap > 0 ? '+' : '−'}NPR {Math.abs(reconGap).toLocaleString('en-NP', { maximumFractionDigits: 0 })} difference).
            {' '}Usual causes: a recipe edited after a sale — the ledger froze each depletion at the ingredients in force when it was sold, while this view re-walks the recipe as it stands today, so the two part ways permanently for anything sold before the edit; manual Sales Entry only started depleting stock on 2026-07-30 and earlier saves were never backfilled; POS credit notes reverse revenue but never restore stock; and recipes with no ingredients linked deplete nothing (see the banner above when that applies).
          </div>
        )}

        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Building report…</p>
        ) : subRows.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">⚙</div>
            <p className="empty-state-text">No sub-recipe usage this period. This appears once a dish that uses a sub-recipe is sold — either through POS or a saved manual Sales Entry.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sub-Recipe</th>
                  <th><Tip text="How much one batch of this sub-recipe produces, from its Recipe Costing record." width={240}>Yield per Batch</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Output units consumed — e.g. 25,000 g of a sauce, regardless of how many batches that took. Summed across every dish sold that uses it, including through other sub-recipes." width={300}>Qty Used</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Qty Used ÷ Yield per Batch. How many full batches of prep this period's sales actually consumed." width={260}>Batches Used</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Total ingredient cost of one batch, from Recipe Costing — nested sub-recipes included." width={250}>Cost / Batch</Tip></th>
                  <th style={{ textAlign: 'right' }}>Value (NPR)</th>
                </tr>
              </thead>
              <tbody>
                {subRows.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>⚙ {r.name}</td>
                    <td style={{ color: 'var(--theme-text2)' }}>{r.yieldQty ? `${r.yieldQty} ${r.yieldUom}` : '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {r.qty.toLocaleString('en-NP', { maximumFractionDigits: 3 })} <span style={{ color: 'var(--theme-text3)', fontWeight: 400 }}>{r.yieldUom}</span>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-purple-text)' }}>{r.batches.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.batchCost.toLocaleString('en-NP', { maximumFractionDigits: 2 })}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.value.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12, fontSize: 13 }}>
                    TOTAL <span style={{ fontWeight: 400, color: 'var(--theme-text3)' }}>({subRows.length} shown)</span>
                  </td>
                  {/* Qty Used only totals when every row shares one UOM — summing grams and
                      millilitres into a single number would be a nonsense figure, so it shows a
                      dash instead (same rule as Purchases' Qty total across mixed units). */}
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)', paddingTop: 12, fontSize: 13 }}>
                    {subQtyIsComparable && subRows.length > 0
                      ? `${subRows.reduce((s, r) => s + r.qty, 0).toLocaleString('en-NP', { maximumFractionDigits: 2 })} ${subRows[0].yieldUom}`
                      : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-purple-text)', paddingTop: 12, fontSize: 13 }}>
                    {subBatchTotal.toLocaleString('en-NP', { maximumFractionDigits: 2 })}
                  </td>
                  <td style={{ paddingTop: 12 }} />
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 12, fontSize: 14 }}>
                    {subValueTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
      ) : (
      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Building report…</p>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">✓</div>
            <p className="empty-state-text">No stock movements yet for this period. Entries appear here automatically the moment a POS bill is charged or marked Complimentary, or a manual Sales Entry day is saved.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Day</th><th>Item</th><th>Category</th><th>UOM</th>
                  <th style={{ textAlign: 'right' }}>Qty Depleted</th>
                  <th><Tip text="POS Sale = billed and paid for. POS Comp = given away complimentary — zero revenue, but the food cost was still consumed. Manual Entry = depleted from a manual Sales Entry save (Bulk/Daily), not a POS bill." width={280}>Source</Tip></th>
                  <th><Tip text="Click to open the exact original bill or complimentary slip this depletion came from." width={240}>Order #</Tip></th>
                  <th>Staff</th>
                  <th style={{ textAlign: 'right' }}>Value (NPR)</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id}>
                    <td style={{ color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{formatBsDay(r.bsDay, selectedPeriod?.bs_month) || '—'}</td>
                    <td>
                      <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.item.name}</div>
                      {r.item.item_code && <div style={{ fontSize: 11, color: 'var(--theme-text3)', fontFamily: 'monospace' }}>{r.item.item_code}</div>}
                    </td>
                    <td><span className="badge badge-yellow">{r.category}</span></td>
                    <td style={{ color: 'var(--theme-text2)' }}>{r.item.uom}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>{r.qtyAbs.toFixed(3)}</td>
                    <td>
                      <span className={`badge ${r.source === 'pos_comp' ? 'badge-amber' : r.source === 'manual' ? 'badge-gray' : 'badge-green'}`}>
                        {r.source === 'pos_comp' ? 'POS Comp' : r.source === 'manual' ? 'Manual Entry' : 'POS Sale'}
                      </span>
                    </td>
                    <td>
                      {r.order?.order_no ? (
                        <span
                          onClick={() => viewPosBill(effectiveClientId, { id: r.ref_id, close_type: r.order.close_type })}
                          role="button" tabIndex={0} className="interactive-card"
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); viewPosBill(effectiveClientId, { id: r.ref_id, close_type: r.order.close_type }) } }}
                          style={{ cursor: 'pointer', color: 'var(--theme-accent-ink)', borderBottom: '1px dashed var(--theme-accent)', paddingBottom: 1 }}
                        >
                          #{r.order.order_no}
                        </span>
                      ) : '—'}
                    </td>
                    <td style={{ color: 'var(--theme-text2)' }}>{(r.order && staffNames[r.order.closed_by]) || '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{r.value.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {/* Cells line up 1:1 with the 9 header columns (Day/Item/Category/UOM/Qty/
                    Source/Order/Staff/Value) — the same alignment bug S525 fixed on Purchases,
                    avoided here by not collapsing the middle columns into one colSpan. */}
                <tr>
                  <td colSpan={4} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12, fontSize: 13 }}>
                    TOTAL <span style={{ fontWeight: 400, color: 'var(--theme-text3)' }}>({filtered.length} shown)</span>
                  </td>
                  {/* No Qty total: these rows span different items in different UOMs (grams, ml,
                      pcs), so one summed quantity would mean nothing. Value is the comparable one. */}
                  <td style={{ textAlign: 'right', color: 'var(--theme-text3)', paddingTop: 12 }}>—</td>
                  <td colSpan={3} style={{ paddingTop: 12 }} />
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 12, fontSize: 14 }}>
                    {totalValue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
      )}
      </>}
    </div>
  )
}
