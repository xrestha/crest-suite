import { useCallback, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { usePeriodList } from '../../../shared/hooks/usePeriodList'
import { useRecipeBook } from '../../../shared/hooks/useRecipeBook'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { npr2 } from '../../../shared/nepalMoney'
import { withTimeout } from '../../../utils/withTimeout'
import { printWithTitle } from '../../../utils/printTitle'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import ReportPage from '../../../components/ReportPage'
import PeriodScope from '../../../components/PeriodScope'
import LetterheadButton from '../../../components/LetterheadButton'
import Tip from '../../../components/Tip'
import { vatModeOf } from '../recipes/menuPriceVat'
import { BYO_TIP } from '../recipes/buildYourOwnRating'
import {
  buildDishCostHistory, monthsAscending, windowMonths, monthLabel, todayRatesOf, dishesOf,
  sortDishRows, dishCostSummary, dishCostSheetRows, changeDirection, DISH_STATUS, SORTS,
} from './dishCostHistory'
import { useClientInit } from '../../../shared/hooks/useClientInit'

// Dish Cost History (S885, Pro, IMS manager and the Owner). Every dish's cost per portion in each BS
// month, at that month's purchase prices on the recipe as it is today. The arithmetic and the rules
// (average paid, carried months, the estimated mark, the dash rows) are dishCostHistory.js; this file
// reads, filters and draws. Price Tracker is the sibling: the same purchase read, the same rate basis.

const SPANS = [
  { value: 3, label: 'Last 3 months' },
  { value: 6, label: 'Last 6 months' },
  { value: 12, label: 'Last 12 months' },
  { value: 0, label: 'All months' },
]

const SORT_OPTIONS = [
  { value: SORTS.rise, label: 'Biggest rise (NPR)' },
  { value: SORTS.risePct, label: 'Biggest rise (%)' },
  { value: SORTS.now, label: 'Cost now' },
  { value: SORTS.name, label: 'Dish name' },
]
const SORT_LABEL = Object.fromEntries(SORT_OPTIONS.map(o => [o.value, o.label]))
const defaultDir = key => (key === SORTS.name ? 'asc' : 'desc')

// Who-reads-what: the whole read is the client history, so a slow link gets a bounded wait and the
// error card rather than a page that never finishes.
const LOAD_MS = 45000

const ESTIMATE_TIP = 'Estimated: at least one ingredient had not been bought yet in this month, so its current Item Master price stands in for the price paid.'

function signed(n) {
  if (n == null) return '—'
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${npr2(Math.abs(n))}`
}

function signedPct(n) {
  if (n == null) return ''
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`
}

// The arrow is the fact; the colour is only whether that direction is good for a cost, and only
// outside the dead zone (the S644 rule), so a rise is red and a fall is green and a wobble is grey.
const DIRECTION = {
  up: { glyph: '▲', color: 'var(--theme-red-text)', word: 'rose' },
  down: { glyph: '▼', color: 'var(--theme-green-text)', word: 'fell' },
  steady: { glyph: '≈', color: 'var(--theme-text3)', word: 'about the same' },
}

function EstimatedMark() {
  return (
    <>
      <span aria-hidden="true" style={{ marginLeft: 2 }}>*</span>
      <span className="sr-only">, estimated</span>
    </>
  )
}

export default function DishCostHistory() {
  const { loading: authLoading, hasImsAccess, customizationEnabled } = useAuth()
  const { clientId, scopedFrom } = useScopedDb()
  // S792 (D32): on a PAN-bill outlet the 13% on a VAT line is part of the cost, so the basis says so.
  const isPan = vatModeOf(useSettings(), clientId) === 'pan'
  const periodList = usePeriodList()
  const recipeBook = useRecipeBook()
  const req = useLatestRequest()
  const biz = useBizInfo()

  const [data, setData] = useState(null)        // { periods, purchases, dishes, breakdown, todayRates }
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [span, setSpan] = useState(6)
  const [toId, setToId] = useState('')
  const [category, setCategory] = useState('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState(SORTS.rise)
  const [sortDir, setSortDir] = useState('desc')

  const load = useCallback(async () => {
    if (!clientId) return
    // Keyed by the client: the page reads the whole history once and derives every window from it,
    // so the axis it can race on is a client switch, not a month pick.
    const id = req.begin(clientId)
    setLoading(true)
    setLoadError(null)
    try {
      const { fresh } = periodList()
      const results = await withTimeout(Promise.all([
        fresh,
        // Every purchase line the client has, as Price Tracker reads it: paged, with the two VAT
        // columns `vatCostFactor` needs (a select without them values a PAN-bill line at ex-VAT).
        // No item filter: a hidden item keeps its history, since recipes still use it.
        fetchAllRows(() => supabase.from('purchase_entries')
          .select('id, item_id, period_id, rate, qty, vat_inclusive, vat_is_cost, monthly_periods!inner(client_id)')
          .eq('monthly_periods.client_id', clientId)
          .order('id')),
        // The dishes, with the two columns the dash rows need (manual cost, build-your-own mark).
        // Filtered in JS (`dishesOf`), NULL-safe on both nullable columns.
        fetchAllRows(() => scopedFrom('recipes', 'id, name, category, cost_price, is_active, is_build_your_own')
          .order('name').order('id')),
        // The recipe book, one read, walked in memory (S793). It rejects on a failed read.
        recipeBook(),
      ]), LOAD_MS, 'Dish Cost History')
      if (!req.isCurrent(id)) return
      const [periodsRes, purchasesRes, dishesRes, book] = results
      const failed = firstError([periodsRes, purchasesRes, dishesRes])
      if (failed) { setLoadError(failed); setLoading(false); return }
      const dishes = dishesOf(dishesRes.data)
      // The shared walk, fed the book: yields, sub-recipe scaling and nesting exactly as every other
      // cost figure. It throws on a broken read, which lands in the catch below.
      const breakdown = await explodeRecipeIngredients(supabase, dishes.map(d => d.id), { book })
      if (!req.isCurrent(id)) return
      setData({
        periods: periodsRes.data || [],
        purchases: purchasesRes.data || [],
        dishes,
        breakdown,
        todayRates: todayRatesOf(book),
      })
      setLoading(false)
    } catch (err) {
      if (!req.isCurrent(id)) return
      setLoadError(err)
      setLoading(false)
    }
  }, [clientId, scopedFrom, periodList, recipeBook, req])

  useClientInit(clientId, authLoading, load) // S890: once per outlet, after the sign-in loads; Try again calls load itself

  const ascending = useMemo(() => monthsAscending(data?.periods), [data])
  const months = useMemo(() => windowMonths(ascending, toId, span), [ascending, toId, span])
  const endMonth = months[months.length - 1] || null

  // Not keyed on the search box or the sort, so typing never re-prices the menu.
  const report = useMemo(() => (data
    ? buildDishCostHistory({ ...data, months, customizationEnabled })
    : { months: [], rows: [] }), [data, months, customizationEnabled])

  const categories = useMemo(() =>
    [...new Set(report.rows.map(r => r.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
  [report])

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    const rows = report.rows.filter(r =>
      (category === 'all' || r.category === category) && (!q || r.name.toLowerCase().includes(q)))
    return sortDishRows(rows, sortKey, sortDir)
  }, [report, category, search, sortKey, sortDir])

  // The headline is the whole report's, not the filtered list's (StockAgeing's rule); the filter bar
  // carries the "N of M".
  const summary = useMemo(() => dishCostSummary(report.rows), [report])

  const windowLabel = months.length === 0 ? ''
    : months.length === 1 ? monthLabel(months[0])
    : `${monthLabel(months[0])} to ${monthLabel(endMonth)}`
  const basis = (isPan
    ? 'Prices are per base unit as on the bill, before any bill discount; on this outlet (PAN bill, not VAT-registered) a VAT line counts the 13% as cost, as Item Master does.'
    : 'Prices are ex-VAT, per base unit, as on the bill, before any bill discount.')
    + ' Free items are left out of the average.'
  const scopeLine = [
    `Months : ${windowLabel || '—'} (${months.length} month${months.length === 1 ? '' : 's'})`,
    category !== 'all' ? `Category : ${category}` : null,
    search.trim() ? `Search : "${search.trim()}"` : null,
    `Sorted by : ${SORT_LABEL[sortKey]}`,
  ].filter(Boolean).join('  ·  ')

  function chooseSort(key) {
    if (key === sortKey) { setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); return }
    setSortKey(key)
    setSortDir(defaultDir(key))
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const ws = sheetWithLetterhead(XLSX, {
      title: 'Dish Cost History: cost per portion by month',
      biz,
      scopeLine,
      rows: dishCostSheetRows(shown, months),
      notes: [
        'Figures are NPR per portion. Each month prices the recipe as it is now at the average price paid for each ingredient that month, weighted by quantity.',
        basis,
        'A month with no purchase of an ingredient carries the price of the last month it was bought in.',
        'Estimated months lists the months where an ingredient had not been bought yet, so its current Item Master price stood in.',
        'Now is the cost at the current Item Master prices, as on Recipe Costing. Change runs from the first month shown to the last.',
        'A dish with no figures says why in Note: priced by hand, built by the guest, or not costed yet. Hidden dishes are not listed.',
      ],
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Dish Cost History')
    const slug = windowLabel.replace(/\s+/g, '_') || 'all'
    XLSX.writeFile(wb, `DishCostHistory_${slug}.xlsx`)
  }

  // A sortable heading: the button inside Tip, aria-sort on the th (MenuPricing's shape).
  function sortHead(label, key, tip, style) {
    const active = sortKey === key
    const arrow = active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'
    return (
      <th style={style} aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <Tip text={`${tip} Click the heading to sort by this column.`} width={260}>
          <button type="button" className={`th-sort${active ? ' th-sort--active' : ''}`} onClick={() => chooseSort(key)}
            aria-label={`Sort by ${label}${active ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}`}>
            {label}<span className="th-sort-arrow" aria-hidden="true">{arrow}</span>
          </button>
        </Tip>
      </th>
    )
  }

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  const figuresReady = !loading && !loadError && !!data
  const stickyRight = { position: 'sticky', right: 0, background: 'var(--theme-card)', borderLeft: '1px solid var(--theme-border)' }

  const actions = (
    <>
      <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={!figuresReady || shown.length === 0}
        onClick={() => printWithTitle(`Dish Cost History - ${windowLabel}`)}>🖨 Print</button>
      <LetterheadButton ready={biz.ready} error={biz.error} style={{ fontSize: 12 }} onClick={exportExcel}
        disabled={!figuresReady || shown.length === 0}>↓ Export Excel</LetterheadButton>
    </>
  )

  const biggest = summary.biggestRise
  const stats = (
    <div className="stat-grid stat-grid--pair">
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={280} text={`Dishes whose cost per portion is higher in ${monthLabel(endMonth)} than in ${monthLabel(months[0])}, at the prices you paid. A change under half a percent is not counted.`}>Dishes Costing More</Tip>
        </div>
        <div className="stat-value">{months.length < 2 ? '—' : summary.rising}</div>
        <div className="stat-sub">{months.length < 2 ? 'choose two or more months' : `of ${summary.compared} compared · ${summary.falling} cheaper`}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">Biggest Rise</div>
        <div className="stat-value" style={{ fontSize: 18, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={biggest ? biggest.name : undefined}>
          {biggest ? biggest.name : '—'}
        </div>
        <div className="stat-sub">{biggest ? `${signed(biggest.change)} per portion (${signedPct(biggest.changePct)})` : 'no dish rose'}</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={280} text="Dishes with at least one month marked * in this window: an ingredient had not been bought yet, so its current Item Master price stands in for the price paid.">With Estimates</Tip>
        </div>
        <div className="stat-value">{summary.withEstimates}</div>
        <div className="stat-sub">of {summary.costed} dishes followed</div>
      </div>
      <div className="stat-card">
        <div className="stat-label">
          <Tip width={280} text="Dishes this report cannot follow: priced by hand with no ingredients, built by the guest while Customization is on, or with no cost yet. They are listed last with the reason.">Not Followed</Tip>
        </div>
        <div className="stat-value">{summary.notFollowed}</div>
        <div className="stat-sub">by hand, by build or not costed</div>
      </div>
    </div>
  )

  const note = (
    <div className="note-banner" style={{ marginBottom: 16 }}>
      <strong>How to read this:</strong> each month column is what one portion would have cost then: the recipe
      as it is now, priced at the average paid for each ingredient that month, weighted by quantity. A month with
      no purchase of an ingredient carries the last month it was bought in. <strong>*</strong> marks a month
      where an ingredient had not been bought yet, so its current Item Master price stands in. {basis}
    </div>
  )

  const filters = (
    <>
      <div className="no-print" style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select aria-label="How many months" className="form-select" value={span} onChange={e => setSpan(Number(e.target.value))}>
          {SPANS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select aria-label="Ending month" className="form-select" value={endMonth?.id || ''} onChange={e => setToId(e.target.value)}>
          {[...ascending].reverse().map(p => (
            <option key={p.id} value={p.id}>To {monthLabel(p)}{p.status === 'open' ? ' (open)' : ''}</option>
          ))}
        </select>
        <select aria-label="Filter by category" className="form-select" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="search" className="form-input form-input--auto" placeholder="Search dishes" aria-label="Search dishes"
          value={search} onChange={e => setSearch(e.target.value)} />
        <select aria-label="Sort by" className="form-select" value={sortKey} onChange={e => { setSortKey(e.target.value); setSortDir(defaultDir(e.target.value)) }}>
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>Sort: {o.label}</option>)}
        </select>
        <span style={{ fontSize: 13, color: 'var(--theme-text2)', marginLeft: 'auto' }}>
          {shown.length} of {report.rows.length} dish{report.rows.length === 1 ? '' : 'es'}
        </span>
      </div>
      {/* The filter bar is no-print, so the scope and the basis print here. */}
      <p className="print-only" style={{ fontSize: 12, marginBottom: 12 }}>{scopeLine}<br />{basis} * = estimated.</p>
    </>
  )

  const footnote = (
    <p className="page-footnote">
      Costs use the recipe as it is now and the average price paid in each month; a month with no purchase carries
      the last price paid. A recipe change is not part of this history, so it shows what price moves did to each dish.
    </p>
  )

  return (
    <ReportPage
      title="Dish Cost History"
      subtitle="What each dish cost per portion, month by month, as purchase prices moved"
      scope={windowLabel ? <PeriodScope label={windowLabel} /> : null}
      actions={actions}
      noPeriod={figuresReady && ascending.length === 0}
      noPeriodWhat="dish cost history"
      loading={loading}
      error={loadError}
      onRetry={() => load()}
      empty={figuresReady && report.rows.length === 0}
      emptyIcon="🍽"
      emptyText="No dishes yet. Add a recipe in Recipe Costing and its cost history appears here."
      banners={biz.error && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet name could not be loaded, so Excel is switched off rather than exporting a sheet with a blank
          company name. The report below is unaffected. Reload the page to try again.
        </p>
      )}
      stats={stats}
      note={note}
      filters={filters}
      footnote={footnote}
    >
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table className="data-table data-table--sticky-first">
            <thead>
              <tr>
                {sortHead('Dish', SORTS.name, 'All figures are NPR per portion.', { minWidth: 180, zIndex: 3 })}
                {months.map((p, k) => (
                  <th key={p.id} style={{ textAlign: 'right' }}>
                    {k === 0
                      ? <Tip width={280} text={`What one portion would have cost in ${monthLabel(p)}: the recipe as it is now, at the average price paid for each ingredient that month. * marks an estimate.`}>{monthLabel(p)}</Tip>
                      : monthLabel(p)}
                  </th>
                ))}
                {sortHead('Now', SORTS.now, 'What one portion costs today at the current Item Master price of each ingredient, the figure Recipe Costing shows.', { textAlign: 'right' })}
                {sortHead('Change', SORTS.rise, 'From the first month shown to the last: the difference per portion, and as a percentage of the first month.', { textAlign: 'right', ...stickyRight, zIndex: 2 })}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={months.length + 3} style={{ textAlign: 'center', padding: 24, color: 'var(--theme-text2)' }}>
                    No dish matches this search or category.
                  </td>
                </tr>
              ) : shown.map(r => {
                const costed = r.status === DISH_STATUS.costed
                const dir = DIRECTION[changeDirection(r)] || null
                return (
                  <tr key={r.id}>
                    <td style={{ minWidth: 180 }}>
                      <span style={{ color: 'var(--theme-text1)', fontWeight: 600 }}>{r.name}</span>
                      {r.category && <span className="cell-sub">{r.category}</span>}
                      {!costed && (
                        <span className="cell-sub">
                          {r.status === DISH_STATUS.byo ? <Tip width={300} text={BYO_TIP}>{r.reason}</Tip> : r.reason}
                        </span>
                      )}
                    </td>
                    {r.cells.map(c => (
                      <td key={c.periodId} style={{ textAlign: 'right', whiteSpace: 'nowrap', color: c.cost == null ? 'var(--theme-text3)' : 'var(--theme-text1)' }}
                        title={c.estimated && c.cost != null ? ESTIMATE_TIP : undefined}>
                        {c.cost == null ? '—' : <>{npr2(c.cost)}{c.estimated && <EstimatedMark />}</>}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap', color: r.now == null ? 'var(--theme-text3)' : 'var(--theme-text1)' }}>
                      {r.now == null ? '—' : npr2(r.now)}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap', ...stickyRight, zIndex: 1 }}>
                      {r.change == null || !dir ? <span style={{ color: 'var(--theme-text3)' }}>—</span> : (
                        <>
                          <span style={{ color: dir.color }}>
                            <span aria-hidden="true">{dir.glyph}</span><span className="sr-only">{dir.word}, </span> {signed(r.change)}
                          </span>
                          {r.changeEstimated && <EstimatedMark />}
                          {r.changePct != null && <span className="cell-sub">{signedPct(r.changePct)}</span>}
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </ReportPage>
  )
}
