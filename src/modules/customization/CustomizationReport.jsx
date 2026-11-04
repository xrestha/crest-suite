import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../shared/hooks/useLatestRequest'
import { useBizInfo } from '../../shared/hooks/useBizInfo'
import { fetchAllRows, fetchAllRowsChunked, fetchAllRowsParallel } from '../../shared/fetchAllRows'
import { firstError } from '../../shared/queryError'
import { npr, nprExact, nprInt } from '../../shared/nepalMoney'
import { plural } from '../../shared/plural'
import { sheetWithLetterhead } from '../../shared/excelLetterhead'
import ReportPage from '../../components/ReportPage'
import PeriodScope from '../../components/PeriodScope'
import Tabs, { TabPanel } from '../../components/Tabs'
import FieldError from '../../components/FieldError'
import ActionError, { asActionError } from '../../components/ActionError'
import Tip from '../../components/Tip'
import BsCalendarPicker from '../../components/BsCalendarPicker'
import RangePresets from '../pos/reports/RangePresets'
import { rangeReadMs } from '../pos/reports/reportTimeout'
import { withTimeout } from '../../utils/withTimeout'
import { adToBsSafe, BS_MONTHS, daysInBsMonth, formatAdAsBs, formatBsDay } from '../../utils/bsCalendar'
import { nepalDayStartTs, nepalDayEndTs, bsMonthRangeIso } from '../pos/reports/reportRange'
import { deltaItems } from '../../utils/orderLineIngredients'
import { posDeltaCosting, loadPosRecipeBook, deltaIdsOf } from '../pos/orders/posRecipeBook'
import { loadOptionCatalog } from './customizationData'
import { buildCustomizationReport, withOptionCosts, allDeltaSets, mostAddedOf, sliceByOrders, weeklyDishShares, TREND_MIN_PLATES, TREND_DROP_POINTS, buildComboReport } from './customizationReportCalc'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer } from 'recharts'
import ChartCard from '../../components/ChartCard'
import { compareFigures } from '../../shared/compareFigures'
import { chartMotion } from '../../shared/chartMotion'
import { TOOLTIP_CHROME } from '../../shared/tooltipChrome'
import { CHART_COLORS } from '../../shared/chartColors'

// Crest Customization Report (S758 stage 8). Four questions an owner asks of their choices:
// which are picked, how often guests customize at all, what the "No …" requests are, and — with
// IMS — whether a paid choice earns more than it costs.
//
// Who (owner decision, narrowed S835 D42): the Owner, a POS manager, plus admin, tested on the RAW
// role column for the reason OptionGroups.jsx gives. Not an IMS manager: see the guard below.
//
// Basis, stated on the page, the print-free export and the footnote alike: paid bills closed in the
// range; choice prices ex-VAT and before bill discounts; credit notes are not netted off.
//
// S759 critique fixes: the range opens on the BS month rather than one day; the KPI strip splits
// add-on income from size discounts and names the most ADDED choice (a size is answered, not
// added); the Margin tab stops painting a free-by-design choice as a loss; every table sorts.
//
// S839, combos (docs/pos-combos.md): a Combos tab — per combo, how many sold, what they brought in
// (ex-VAT; a bill discount never touches a combo) and each part's dish mix (buildComboReport).
//
// S863 audit fixes: the range controls live in the header's action group, which ReportPage never
// hides, so a pick no longer unmounts them (focus fell to <body>) and a failed read keeps them on
// screen beside a Try again. A backwards range is refused before any read. Per-plate figures are
// to the paisa and Margin is Charged minus Cost as shown. The workbook gains Summary and Weekly
// sheets and keeps a Choice margin sheet when costing failed.
//
// S867 critique fixes: the owner's word list on screen and in the workbook (a guest taps a choice,
// a set of them is a choice group, a combo slot is a part); a count of plates agrees with its noun;
// the trend names its week-ending days in BS; on a phone the KPI strip goes two across, the custom
// dates and Export fold behind one toggle, and every table fits; with no client chosen the page
// says so instead of "Building report…" for ever.

const TABS = [
  { key: 'popular',  label: 'Popular choices' },
  { key: 'dishes',   label: 'How often customized' },
  { key: 'removals', label: '"No …" requests' },
  { key: 'margin',   label: 'Choice margin' },
  { key: 'combos',   label: 'Combos' },
]
const REMOVALS_TAB_LABEL = TABS.find(t => t.key === 'removals').label

const DEFAULT_SORT = {
  popular:  { key: 'picks',  dir: 'desc' },
  dishes:   { key: 'plates', dir: 'desc' },
  removals: { key: 'picks',  dir: 'desc' },
  margin:   { key: 'picks',  dir: 'desc' },
  combos:   { key: 'sold',   dir: 'desc' },
}

// The bill lines the report reads, with each combo dish's combo (S839). There is no fallback to the
// lines alone since S876 (PERF-13): the combo columns are live (the till reads them unguarded), and
// the lines are now read in batches as the bills land, where a per-batch fallback would mix rows
// with and without combo fields and drop some combos silently. A missing column fails the report.
const LINE_COLS = 'id, order_id, recipe_id, name, qty, comped, selection_key, unit_price, combo_line_id, combo_id, combo_name, combo_group_id, combo_group_name, combo_sort'
const CHOICE_COLS = 'id, order_item_id, option_id, group_name, group_kind, option_name, is_removal, price_delta, list_price_delta, included, ingredient_deltas'

const pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
// AD ISO date arithmetic in UTC, so no runtime timezone can shift a day (S800).
const isoMs = iso => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) }
const shiftIso = (iso, days) => new Date(isoMs(iso) + days * 86400000).toISOString().slice(0, 10)
const MUTED = '#6b7280' // chart-tick, for Recharts SVG props only
// A second cue beside the colour for the five trend lines (S863): solid, dashed, dotted, dash-dot,
// sparse dots. The legend swatch draws the same pattern, so a line can be named without its hue.
const LINE_DASHES = ['', '6 3', '2 3', '8 3 2 3', '1 4']
const NOWRAP = { whiteSpace: 'nowrap' }
const FIG = { textAlign: 'right', whiteSpace: 'nowrap' }
// A heading that may break between its words when its table is squeezed (S867). Every `th` is
// nowrap, so on a 390px phone the two-word labels set the column widths and the Popular table
// stood 403px wide in 348px of room. A wide screen still shows them on one line.
const WRAP_TH = { whiteSpace: 'normal' }

// Excel number formats. The workbook carries numbers, never formatted strings, so a reader can sum
// and re-check them (S863).
const MONEY_Z = '#,##0.00'
const MONEY_CHANGE_Z = '+#,##0.00;-#,##0.00;0.00'
const COUNT_Z = '#,##0'
const COUNT_CHANGE_Z = '+#,##0;-#,##0;0'
const PCT_Z = '0.0%'
const PCT_CHANGE_Z = '+0.0%;-0.0%;0.0%'
const POINTS_Z = '+0.0" points";-0.0" points";0.0" points"'

const NO_CLIENT_TEXT = 'No client selected. Pick a client in the top-left switcher to see its Customization Report.'
const COST_ERROR_TEXT = 'The stock lines or item rates could not be read, so choice costs are not shown. The other tabs are not affected.'
const COST_ERROR_SHEET_NOTE = 'The stock lines or item rates could not be read, so no cost or margin is in this sheet. The charged figures are complete.'
const BASIS_TIP = {
  free: 'Free choice: its cost is part of the dish food cost, not a loss on an upsell.',
  sizeBelow: 'A size priced below the dish: its cost is part of the dish food cost, not a loss on an upsell.',
}
const BASIS_NOTE = {
  free: 'Free choice: its cost is part of the dish food cost',
  sizeBelow: 'Size priced below the dish: its cost is part of the dish food cost',
}

// ── Pure helpers, exported for the tests ─────────────────────────────────────────────────────────

/** A figure to the paisa, as the per-plate columns and the workbook carry it. */
export const round2 = n => Math.round((Number(n) || 0) * 100) / 100

/** "1 plate", "12 plates", "1,240 plates": every count of plates the page prints (S867). */
export const platesText = n => plural(nprInt(n), 'plate')

/** "+NPR 47.50", "−NPR 0.30", or "NPR 0.00": a per-plate figure to the paisa, signed. */
export function signed2(n) {
  const r = round2(n)
  return r === 0 ? nprExact(0) : `${r > 0 ? '+' : '−'}${nprExact(Math.abs(r))}`
}

/**
 * One choice's three per-plate figures as the page shows them (S863). Each is taken to the paisa,
 * and Margin is the shown Charged minus the shown Cost, so the three columns reconcile on screen and
 * in the workbook: rounding each to the rupee separately printed "+NPR 48 − NPR 30 = +NPR 17".
 * `loss` is read off the SHOWN margin, so a −0.003 margin (shown NPR 0.00) is not painted red,
 * and a −0.30 one is red with ▼ and its figure, never a red "NPR 0".
 */
export function perPlateFigures(o) {
  const charged = round2(o?.chargedPerPick)
  const cost = o?.costPerPick == null ? null : round2(o.costPerPick)
  const margin = cost == null ? null : round2(charged - cost)
  return { charged, cost, margin, loss: margin != null && margin < 0 }
}

/**
 * Why a choice's margin is not a verdict, or null when it is one. S809 3o (REPORTS-12): free only
 * when every plate was BILLED at a list price of 0. S862 REPORTS-STOCK-6: only a SIZE below the dish
 * is part of the dish cost by design; any other choice priced below the dish keeps its verdict.
 */
export function marginBasis(o) {
  const free = o.freeByDesign || (o.listPriceDelta == null && o.chargedPerPick === 0)
  const sizeBelow = o.group_kind === 'size' && o.listPriceDelta != null && o.listPriceDelta < 0
  return free ? 'free' : sizeBelow ? 'sizeBelow' : null
}

/** The refusal for a range that runs backwards, or null. ISO dates compare as strings. */
export function rangeProblem(fromIso, toIso) {
  if (!fromIso || !toIso || fromIso <= toIso) return null
  return 'The To date is before the From date. Pick a To date on or after the From date.'
}

// An AD `YYYY-MM-DD` as its BS date, read at local midnight (a bare ISO string is UTC midnight,
// which adToBs would read as the previous day west of UTC).
function bsOfIso(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return adToBsSafe(new Date(y, m - 1, d))
}

/**
 * A week-ending tick on the trend: "17th Kartik", a day named inside the range the chip already
 * states (S867). The axis read "10/07/2083" under a footer naming "17 Kartik 2083". The tooltip
 * carries the full date; out of the verified table, the AD date marked as such.
 */
export function weekTick(iso) {
  const bs = bsOfIso(iso)
  return bs ? formatBsDay(bs.day, bs.month) : formatAdAsBs(iso)
}

/** The chip's BS label: "Bhadra 2082" for a whole month, else "5 Bhadra – 20 Ashwin 2082". */
export function bsRangeLabel(fromIso, toIso) {
  const a = bsOfIso(fromIso)
  const b = bsOfIso(toIso)
  if (!a || !b) return `${formatAdAsBs(fromIso)} – ${formatAdAsBs(toIso)}`
  const month = bs => BS_MONTHS[bs.month - 1]
  if (a.year === b.year && a.month === b.month && a.day === b.day) return `${a.day} ${month(a)} ${a.year}`
  if (a.year === b.year && a.month === b.month && a.day === 1 && b.day === daysInBsMonth(b.year, b.month)) {
    return `${month(a)} ${a.year}`
  }
  const left = a.year === b.year ? `${a.day} ${month(a)}` : `${a.day} ${month(a)} ${a.year}`
  return `${left} – ${b.day} ${month(b)} ${b.year}`
}

/** A BS date for a filename, "2082-05-01"; out of the verified table, the AD date marked as such. */
export function bsFileDate(iso) {
  const bs = bsOfIso(iso)
  const p = n => String(n).padStart(2, '0')
  return bs ? `${bs.year}-${p(bs.month)}-${p(bs.day)}` : `${iso}-AD`
}

/** The one line that states what the page, the print and every sheet cover: BS first, AD in brackets. */
export function scopeLineOf(fromIso, toIso) {
  return `Paid bills closed ${formatAdAsBs(fromIso)} to ${formatAdAsBs(toIso)} (AD ${fromIso} to ${toIso}) · choice prices ex-VAT, before bill discounts · combos ex-VAT, never discounted · credit notes not netted`
}

/**
 * Number formats on a letterheaded sheet. The headings row is the first whose first cell is the
 * first column name (the letterhead lines above it are prose in column A); `formatOf(row, key, i)`
 * names a format per cell, and only a numeric cell takes one.
 */
function formatCells(XLSX, ws, rows, formatOf) {
  if (!rows.length || !ws['!ref']) return
  const keys = Object.keys(rows[0])
  const range = XLSX.utils.decode_range(ws['!ref'])
  let head = -1
  for (let r = range.s.r; r <= range.e.r; r++) {
    const c = ws[XLSX.utils.encode_cell({ r, c: 0 })]
    if (c && c.v === keys[0]) { head = r; break }
  }
  if (head < 0) return
  rows.forEach((row, i) => keys.forEach((k, c) => {
    const z = formatOf(row, k, i)
    const cell = ws[XLSX.utils.encode_cell({ r: head + 1 + i, c })]
    if (z && cell && cell.t === 'n') cell.z = z
  }))
}

// Distinct column names for the weekly sheet: two dishes sharing a name would otherwise share a column.
function distinctNames(names) {
  const seen = new Map()
  return names.map(n => {
    const k = (seen.get(n) || 0) + 1
    seen.set(n, k)
    return k === 1 ? n : `${n} (${k})`
  })
}

// "vs the period before" under a tile (S800): the shared verdict, its arrow the direction and its
// colour whether that direction is good. Nothing to compare against says so rather than a 100% rise.
// A SHARE moves in percentage points (S863), the unit the weekly trend speaks in; money in percent.
function VsBefore({ now, then, label, format, opts, points = false }) {
  const cmp = compareFigures(now, then, opts)
  if (!cmp) return <div className="stat-sub">Nothing in {label} to compare</div>
  const color = cmp.good == null ? 'var(--theme-text3)' : cmp.good ? 'var(--theme-green-text)' : 'var(--theme-red-text)'
  const gap = points
    ? `${(Math.abs(now - then) * 100).toFixed(1)} points`
    : `${cmp.gapPct < 1 ? cmp.gapPct.toFixed(1) : Math.round(cmp.gapPct)}%`
  return (
    <div className="stat-sub">
      <span style={{ color, fontWeight: 600 }}>{cmp.glyph} {gap}</span>
      {' '}vs {label} ({format(then)})
    </div>
  )
}
const signed = n => {
  const r = Math.round(Number(n) || 0)
  return r === 0 ? 'NPR 0' : `${r > 0 ? '+' : '−'}${npr(Math.abs(r))}`
}
/** A figure that is only ever ≤ 0, read as a reduction: "−NPR 200", or "NPR 0". */
const negative = n => {
  const r = Math.round(Number(n) || 0)
  return r === 0 ? 'NPR 0' : `−${npr(Math.abs(r))}`
}

/** Sort rows on one accessor; strings by locale, numbers with nulls last in both directions. */
function sortRows(rows, sort, accessors, tiebreak) {
  const get = accessors[sort.key]
  if (!get) return rows
  const dir = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = get(a), bv = get(b)
    const an = av == null, bn = bv == null
    if (an && bn) return tiebreak(a, b)
    if (an) return 1
    if (bn) return -1
    const c = typeof av === 'string' ? av.localeCompare(bv) : av - bv
    return (c * dir) || tiebreak(a, b)
  })
}

const byName = key => (a, b) => String(a[key]).localeCompare(String(b[key]))

/**
 * A sortable column heading — the S690 markup: the button INSIDE the Tip so the column is one tab
 * stop and the tip is announced on the control, `aria-sort` on the th. A numeric column opens
 * descending on its first click (the reason to sort by a figure is to find the top of it), a name
 * column ascending.
 */
function SortTh({ label, tip, sortKey, sort, onSort, numeric = false, wrap = false, className }) {
  const active = sort.key === sortKey
  const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'
  // `wrap` (S867): the label may take two lines on a phone. The button keeps the column's alignment
  // for those lines; a button centres its text by default.
  const button = (
    <button type="button" className={`th-sort${active ? ' th-sort--active' : ''}`}
      style={wrap ? { textAlign: 'inherit' } : undefined}
      onClick={() => onSort(sortKey, numeric)}
      aria-label={`Sort by ${label}${active ? (sort.dir === 'asc' ? ', ascending' : ', descending') : ''}`}>
      {label}<span className="th-sort-arrow" aria-hidden="true">{arrow}</span>
    </button>
  )
  return (
    <th className={className} style={{ textAlign: numeric ? 'right' : 'left', ...(wrap ? WRAP_TH : null) }}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {tip ? <Tip text={tip}>{button}</Tip> : button}
    </th>
  )
}

/** "Momo, Chowmein, Thukpa +4 more" — the rest in a Tip, the whole list in the workbook. */
function DishList({ dishes }) {
  const shown = dishes.slice(0, 3)
  const rest = dishes.slice(3)
  return (
    <>
      {shown.join(', ')}
      {rest.length > 0 && (
        <>
          {' '}
          <Tip text={rest.join(', ')}>
            <span style={{ color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>+{rest.length} more</span>
          </Tip>
        </>
      )}
    </>
  )
}

/** The legend swatch for one trend line: its colour AND its dash pattern. SVG, so hex is allowed. */
function LineSwatch({ i }) {
  return (
    <svg width="18" height="6" aria-hidden="true" focusable="false" style={{ verticalAlign: 'middle' }}>
      <line x1="0" y1="3" x2="18" y2="3" stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth="2"
        strokeDasharray={LINE_DASHES[i % LINE_DASHES.length] || undefined} />
    </svg>
  )
}

/** The weekly shares as a table: the chart's text alternative, shown in its expanded view (S863). */
function WeeklyTable({ weekly }) {
  return (
    <div className="table-wrap" style={{ marginTop: 16 }}>
      <table className="data-table">
        <thead><tr>
          <th scope="col" style={WRAP_TH}>Week ending</th>
          {/* A dish name wraps (S867): five of them on one nowrap line ran the table past the dialog. */}
          {weekly.dishes.map(d => <th key={d.recipe_id} scope="col" style={{ textAlign: 'right', ...WRAP_TH }}>{d.name}</th>)}
        </tr></thead>
        <tbody>
          {weekly.rows.map((r, k) => (
            <tr key={weekly.weekEnds[k]}>
              <td><span style={NOWRAP}>{formatAdAsBs(weekly.weekEnds[k])}</span></td>
              {weekly.dishes.map(d => (
                <td key={d.recipe_id} style={{ textAlign: 'right' }}>
                  {r[d.recipe_id] == null
                    ? <span style={{ color: 'var(--theme-text3)' }}>too few plates</span>
                    : <span style={NOWRAP}>{r[d.recipe_id]}%</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function CustomizationReport() {
  const { isAdmin, isOwner, profile, clientId, clientModules } = useAuth()
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  // The CLIENT's module, not the viewer's: an admin looking at a POS-only outlet must not be shown
  // a Margin tab that outlet cannot have.
  const imsOn = !!clientModules?.ims

  const [tab, setTab] = useState('popular')
  const [range, setRange] = useState(() => bsMonthRangeIso(0))
  const { from: fromIso, to: toIso } = range
  const setFromIso = v => setRange(r => ({ ...r, from: v }))
  const setToIso = v => setRange(r => ({ ...r, to: v }))
  const [sorts, setSorts] = useState(DEFAULT_SORT)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [data, setData] = useState(null)       // { report, costed, prevReport, weekly, combos }
  const [costError, setCostError] = useState(null) // { text, detail } for ActionError
  const [exportAsked, setExportAsked] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)
  // On a phone the custom dates and Export fold behind one toggle (S867, `.phone-fold`).
  const [moreOpen, setMoreOpen] = useState(false)
  const rangeReq = useLatestRequest()
  // S867: the Crest admin view with no client picked. The loader returned before any read and left
  // `loading` true, so the page said "Building report…" for ever.
  const noClient = !clientId

  // S863: a backwards range is refused before any read, so it never reaches the empty state
  // ("attach choice groups") that a range with no bills earns.
  const backwardsMsg = rangeProblem(fromIso, toIso)
  const backwards = !!backwardsMsg
  // The equal-length range just before the chosen one (S800), for "vs the period before".
  const rangeDays = Math.max(1, Math.round((isoMs(toIso) - isoMs(fromIso)) / 86400000) + 1)
  const prevFromIso = shiftIso(fromIso, -rangeDays)
  const load = useCallback(async () => {
    if (!clientId) {
      // Nothing to read, so nothing is loading. Claimed, so a load still in flight for the client
      // just left cannot land its figures under the no-client state.
      rangeReq.begin('no-client')
      setLoading(false); setLoadError(null); setCostError(null); setData(null)
      return
    }
    // Claimed even when refused, so a load still in flight for the last good range cannot land
    // its figures under a backwards one.
    const key = rangeReq.begin(`${clientId}:${fromIso}:${toIso}`)
    if (backwards) {
      setLoading(false); setLoadError(null); setCostError(null); setData(null)
      return
    }
    setLoading(true); setLoadError(null); setCostError(null)
    // S862 REPORTS-STOCK-5: every read is bounded, as on Sales Report (S842). A hung read answers
    // `{ error }` and fails the page through ReportLoadError like a refused one. Since S863 that card
    // carries Try again (`onRetry`), and the range controls stay on screen in the header beside it,
    // so the reader can retry or shorten the range without a reload. The limit covers the chosen
    // range AND the one before it, which the bill read spans.
    const readMs = rangeReadMs(prevFromIso, toIso)
    const LOAD_LABEL = 'Loading the Customization Report'
    // S869: the recipe book for today's choices, asked for beside the bills, so the Margin tab's
    // costing usually needs no wait of its own after the lines. posDeltaCosting uses it only when it
    // holds every item and sub-recipe the range's plates name, and reads the book for exactly those
    // otherwise, so the figures are the same either way. Read apart from the catalog, so a login
    // that cannot read the stock lines loses only the head start, never the report.
    const readChoiceBook = async () => {
      const r = await fetchAllRows(() => scopedFrom('pos_option_ingredients', 'id, item_id, sub_recipe_id').order('id'))
      const { itemIds, subRecipeIds } = deltaIdsOf([r.data || []])
      if (r.error || (itemIds.length === 0 && subRecipeIds.length === 0)) return null
      return loadPosRecipeBook(supabase, clientId, { recipeIds: subRecipeIds, itemIds })
    }
    const earlyBook = imsOn ? readChoiceBook().catch(() => null) : Promise.resolve(null)
    // A read that threw answers `{ error }`, the shape a refused one has, so firstError sees both.
    const settled = read => Promise.resolve(read).catch(error => ({ data: null, error }))
    // S876 (PERF-13): each page of bills starts its own lines and choices as it lands, instead of
    // every line waiting for the last page of bills. Each bill is read once only (`dispatched`):
    // two reads of one bill would count its plates twice. Bills of a page the final list drops
    // (the read started again because bills moved) are harmless, since sliceByOrders keeps only the
    // final list's bills; the final list's bills not yet started are read once it is in.
    const dispatched = new Set()
    const batches = []   // { first: its first bill's id, lines, choices }, one per set of bills started
    const readLinesOf = bills => {
      const ids = []
      for (const b of bills) if (b.id != null && !dispatched.has(b.id)) { dispatched.add(b.id); ids.push(b.id) }
      if (ids.length === 0) return
      batches.push({
        first: ids[0],
        lines: settled(fetchAllRowsChunked(ids, chunk => scopedFrom('pos_order_items', LINE_COLS).in('order_id', chunk).order('id'))),
        choices: settled(fetchAllRowsChunked(ids, chunk => scopedFrom('pos_order_item_options', CHOICE_COLS).in('order_id', chunk).order('id'))),
      })
    }
    const readAll = async () => {
      const [ordersRes, catalog] = await Promise.all([
        // Paged: a month of bills passes 1000 at any real volume, and every share on this page
        // divides by a count taken from it. In parallel after the first page (S869): three months
        // on BLOOM CAFE was three 1000-bill pages, one after another.
        // S800: the chosen range AND the equal range before it, in one read, so the tiles can say
        // how this period compares and the trend costs no second round of reads.
        settled(fetchAllRowsParallel(opts => scopedFrom('pos_orders', 'id, closed_at', opts)
          .eq('close_type', 'paid')
          .gte('closed_at', nepalDayStartTs(prevFromIso)).lte('closed_at', nepalDayEndTs(toIso))
          .order('id'), { onPage: readLinesOf })),
        // Today's catalog: which group a choice belongs to (a size is not an add-on), its list price
        // (a free-by-design choice is not a loss) and which dishes have a group attached (S869: its
        // own attachment read, where the page used to read them a second time). A failed catalog
        // read is a failed report read — without it the tiles and the Margin tab would state things
        // they cannot know. S809 3o (REPORTS-12): each bill's own snapshot decides kind and list
        // price now; the catalog only fills a snapshot row that carries neither.
        settled(loadOptionCatalog(scopedFrom)),
      ])
      // A failed bill or catalog read fails the report now; lines already asked for are left to land unread.
      if (ordersRes.error || catalog.error) return { ordersRes, catalog, lines: [], choices: [] }
      readLinesOf(ordersRes.data || [])   // the final list's bills no page started
      // In bill order, whichever page of bills landed first, so one range always lists its lines the
      // same way (a dish keeps the name of its first line; equal counts keep their order).
      const at = new Map((ordersRes.data || []).map((o, i) => [o.id, i]))
      const pos = b => (at.has(b.first) ? at.get(b.first) : at.size)
      const ordered = [...batches].sort((a, b) => pos(a) - pos(b))
      const lines = await Promise.all(ordered.map(b => b.lines))
      const choices = await Promise.all(ordered.map(b => b.choices))
      return { ordersRes, catalog, lines, choices }
    }
    try {
      // One limit over the whole chain, bills to lines (it was one per wave): a hung read answers
      // TimeoutError and fails the page like a refused one. The bill read spans the range before.
      const { ordersRes, catalog, lines, choices } = await withTimeout(readAll(), readMs, LOAD_LABEL)
      // Every read, the bills and the catalog first: one failed batch of lines fails the report, never
      // a report short of that batch's plates. The error itself is thrown, so its detail line stays.
      const results = [ordersRes, catalog, ...lines, ...choices]
      if (firstError(results)) throw results.find(r => r.error).error
      const kindByGroup = Object.fromEntries(catalog.groups.map(g => [g.id, g.kind]))
      const kindByOptionId = Object.fromEntries(catalog.options.map(o => [o.id, kindByGroup[o.group_id] || 'unknown']))
      const listPriceByOptionId = Object.fromEntries(catalog.options.map(o => [o.id, Number(o.price_delta) || 0]))
      const linesRes = { data: lines.flatMap(r => r.data || []) }
      const snapRes = { data: choices.flatMap(r => r.data || []) }
      const attachedRecipeIds = new Set(catalog.attachments.map(a => a.recipe_id))
      const curStartMs = Date.parse(nepalDayStartTs(fromIso))
      const curOrders = (ordersRes.data || []).filter(o => Date.parse(o.closed_at) >= curStartMs)
      const prevIds = new Set((ordersRes.data || []).filter(o => Date.parse(o.closed_at) < curStartMs).map(o => o.id))
      const cur = sliceByOrders(linesRes.data, snapRes.data, new Set(curOrders.map(o => o.id)))
      const prev = sliceByOrders(linesRes.data, snapRes.data, prevIds)
      const report = buildCustomizationReport({
        lines: cur.lines,
        snapshots: cur.snapshots,
        attachedRecipeIds,
        kindByOptionId,
        listPriceByOptionId,
      })
      const prevReport = buildCustomizationReport({ lines: prev.lines, snapshots: prev.snapshots, attachedRecipeIds, kindByOptionId, listPriceByOptionId })
      const closedAtById = new Map(curOrders.map(o => [o.id, o.closed_at]))
      const combos = buildComboReport({ lines: cur.lines, closedAtOf: id => closedAtById.get(id) })
      // The weekly trend: whole weeks counted back from the range's last day, for a range of two
      // weeks or more. Days before the earliest whole week stay in the tiles, not in the trend.
      const weekCount = Math.floor(rangeDays / 7)
      let weekly = null
      if (weekCount >= 2) {
        const endMs = Date.parse(nepalDayEndTs(toIso))
        const weekOfOrder = new Map()
        for (const o of curOrders) weekOfOrder.set(o.id, weekCount - 1 - Math.floor((endMs - Date.parse(o.closed_at)) / (7 * 86400000)))
        weekly = {
          ...weeklyDishShares({ lines: cur.lines, snapshots: cur.snapshots, weekOfOrder, weekCount, attachedRecipeIds }),
          weekEnds: Array.from({ length: weekCount }, (_, k) => shiftIso(toIso, -7 * (weekCount - 1 - k))),
        }
      }

      // Choice cost needs IMS (stock lines and item rates). A failure here costs the Margin tab
      // only, and says so there — the three sales tabs stand on their own reads.
      // S809 3o (REPORTS-4): every distinct set of stock lines the range's plates carried, not one
      // sample per choice, so each size's portion is costed as that size's.
      // S828 5d: through the till's recipe book (pos_recipe_book), one read. A POS manager on a PIN
      // cannot read `items` (no_pos_pin_staff), so every yield read 100% and every rate 0.
      let costed = null
      const deltaSets = allDeltaSets(report.options)
      if (imsOn && deltaSets.length > 0) {
        try {
          // Bounded in its own try (S862 REPORTS-STOCK-5): a hung costing fails the Margin tab only.
          const costing = async () => posDeltaCosting(supabase, clientId, deltaSets, { book: await earlyBook })
          const { explosion, rateOf } = await withTimeout(costing(), readMs, 'Costing the choices')
          const toItems = d => deltaItems(d, explosion)
          const itemIds = [...new Set(deltaSets.flatMap(d => toItems(d).map(x => x.item_id)))]
          const rateByItem = Object.fromEntries(itemIds.map(id => [id, rateOf(id)]))
          costed = withOptionCosts(report.options, toItems, rateByItem)
        } catch (e) {
          if (!rangeReq.isCurrent(key)) return
          // Converted here, at the call site: the consequence is ours, the detail line is the error's.
          setCostError({ text: COST_ERROR_TEXT, detail: asActionError(e).detail })
        }
      }
      if (!rangeReq.isCurrent(key)) return
      setData({ report, costed, prevReport, weekly, combos })
    } catch (e) {
      if (!rangeReq.isCurrent(key)) return
      setLoadError(e)
      setData(null)
    } finally {
      if (rangeReq.isCurrent(key)) setLoading(false)
    }
  }, [clientId, fromIso, toIso, prevFromIso, rangeDays, backwards, scopedFrom, rangeReq, imsOn])

  useEffect(() => { load() }, [load])

  // No client, no report: a figure left from the client just switched away from is not shown.
  const report = noClient ? null : data?.report
  const scopeLine = scopeLineOf(fromIso, toIso)
  const marginRows = useMemo(() => (data?.costed || []).filter(o => !o.is_removal), [data])
  const top = report ? mostAddedOf(report.options) : null
  const onlySizes = !!report && !top && report.options.some(o => !o.is_removal && o.group_kind === 'size')
  const visibleTabs = TABS.filter(t => t.key !== 'margin' || imsOn)
  const tabLabel = (TABS.find(t => t.key === tab) || TABS[0]).label

  const sort = sorts[tab] || DEFAULT_SORT[tab]
  const toggleSort = (key, numeric) => setSorts(s => {
    const cur = s[tab] || DEFAULT_SORT[tab]
    const dir = cur.key === key ? (cur.dir === 'asc' ? 'desc' : 'asc') : (numeric ? 'desc' : 'asc')
    return { ...s, [tab]: { key, dir } }
  })

  const popularRows = useMemo(() => report ? sortRows(report.options, sorts.popular, {
    option_name: o => o.option_name, group_name: o => o.group_name, picks: o => o.picks,
    charged: o => (o.is_removal ? null : o.charged),
  }, byName('option_name')) : [], [report, sorts.popular])
  const dishRows = useMemo(() => report ? sortRows(report.dishes, sorts.dishes, {
    name: d => d.name, plates: d => d.plates, customizedPlates: d => d.customizedPlates, share: d => d.share,
  }, byName('name')) : [], [report, sorts.dishes])
  const removalRows = useMemo(() => report ? sortRows(report.removalsByDish, sorts.removals, {
    dish: r => r.dish, option_name: r => r.option_name, picks: r => r.picks,
    share: r => (r.dishPlates ? r.picks / r.dishPlates : null),
  }, byName('dish')) : [], [report, sorts.removals])
  // Sorted on the figures as SHOWN (to the paisa), so the order agrees with what the reader sees.
  const marginSorted = useMemo(() => sortRows(marginRows, sorts.margin, {
    option_name: o => o.option_name, chargedPerPick: o => perPlateFigures(o).charged, costPerPick: o => perPlateFigures(o).cost,
    margin: o => perPlateFigures(o).margin, picks: o => o.picks,
  }, byName('option_name')), [marginRows, sorts.margin])
  const comboRows = useMemo(() => sortRows(data?.combos || [], sorts.combos, {
    name: c => c.name, sold: c => c.sold, revenue: c => c.revenue, perCombo: c => c.perCombo,
  }, byName('name')), [data, sorts.combos])

  // A precondition on Export is `aria-disabled` plus a press that says what is missing (S776): the
  // reason used to sit only in a Tip on a disabled button, which a touch screen cannot open. Never
  // a workbook while loading, after a failed read, or with the letterhead name unread (S845).
  const exportBlock = loading ? 'The report is still loading. Export works once it has finished.'
    : loadError ? 'The report could not be read, so there is nothing to export. Choose Try again first.'
    : backwards ? 'The To date is before the From date, so there is nothing to export.'
    : !report ? 'There is nothing to export yet.'
    : biz.error ? 'The outlet name could not be read, so the workbook letterhead would be blank. Reload the page, then export.'
    : !biz.ready ? 'The outlet name is still loading. Try again in a moment.'
    : null
  // The notice answers a press and lasts only while the reason does.
  useEffect(() => { if (!exportBlock) setExportAsked(false) }, [exportBlock])

  // S835, D42: no IMS manager clause. An Inventory login cannot read till bills (no_ims_staff), so a
  // manager let in here got an empty read and a confident "No choices were picked". The nav item
  // (Layout.js, minPosRole: 'manager') offers it to the same set: admin, Owner, a POS manager.
  const canView = isAdmin || isOwner || profile?.pos_role === 'manager'
  if (!canView) return <Navigate to="/dashboard" replace />

  async function exportExcel() {
    if (!report) return
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const add = (name, title, rows, { notes = [], formatOf = null } = {}) => {
      const ws = sheetWithLetterhead(XLSX, { title, biz, scopeLine, rows, notes })
      if (formatOf) formatCells(XLSX, ws, rows, formatOf)
      XLSX.utils.book_append_sheet(wb, ws, name)
    }
    const prev = data.prevReport
    const before = `The ${rangeDays} days before`
    // The KPI tiles, so the workbook reconciles them. Change is in the figure's own unit (the share
    // in percentage points), Change (%) against the period before where that is not 0.
    const relChange = (now, then) => (then != null && then > 0 && now != null ? (now - then) / then : '')
    const summaryKinds = []
    const summaryRow = (kind, figure, now, then, change, rel) => {
      summaryKinds.push(kind)
      return { Figure: figure, 'This range': now ?? '', [before]: then ?? '', Change: change ?? '', 'Change (%)': rel ?? '' }
    }
    const diff = (now, then) => (now != null && then != null ? now - then : '')
    const removed = report.removals[0]
    const summary = [
      summaryRow('count', 'Plates of customizable dishes', report.customizablePlates, prev?.customizablePlates,
        diff(report.customizablePlates, prev?.customizablePlates), relChange(report.customizablePlates, prev?.customizablePlates)),
      summaryRow('share', 'With a choice picked (share of those plates)', report.customizedShare, prev?.customizedShare,
        report.customizedShare != null && prev?.customizedShare != null ? Math.round((report.customizedShare - prev.customizedShare) * 1000) / 10 : '', ''),
      summaryRow('count', 'Plates with a choice picked', report.customizedPlates, prev?.customizedPlates,
        diff(report.customizedPlates, prev?.customizedPlates), relChange(report.customizedPlates, prev?.customizedPlates)),
      summaryRow('money', 'Extras earned (NPR, ex-VAT)', round2(report.extrasEarned), prev ? round2(prev.extrasEarned) : null,
        prev ? round2(report.extrasEarned - prev.extrasEarned) : '', relChange(report.extrasEarned, prev?.extrasEarned)),
      summaryRow('money', 'Size adjustments (NPR, ex-VAT)', round2(report.sizeAdjustments), prev ? round2(prev.sizeAdjustments) : null,
        prev ? round2(report.sizeAdjustments - prev.sizeAdjustments) : '', ''),
      summaryRow('money', 'Cheaper choices, not a size (NPR, ex-VAT)', round2(report.cheaperChoices), prev ? round2(prev.cheaperChoices) : null,
        prev ? round2(report.cheaperChoices - prev.cheaperChoices) : '', ''),
      summaryRow('text', 'Most added choice', top ? `${top.option_name} (${platesText(top.picks)})` : (onlySizes ? 'Only sizes were picked' : 'None'), '', '', ''),
      summaryRow('text', 'Most removed ("No …" request)', removed ? `${removed.option_name} (${platesText(removed.picks)})` : 'None', '', '', ''),
    ]
    add('Summary', 'Customization — Summary', summary, {
      notes: [`${before} is the equal range just before this one, as on the tiles. A share moves in percentage points.`],
      formatOf: (row, k, i) => {
        const kind = summaryKinds[i]
        if (k === 'Change (%)') return PCT_CHANGE_Z
        if (k === 'Change') return kind === 'share' ? POINTS_Z : kind === 'money' ? MONEY_CHANGE_Z : COUNT_CHANGE_Z
        if (k === 'This range' || k === before) return kind === 'share' ? PCT_Z : kind === 'money' ? MONEY_Z : COUNT_Z
        return null
      },
    })
    add('Popular choices', 'Customization — Popular choices', popularRows.map(o => ({
      Choice: o.option_name, Group: o.group_name, 'Times picked (plates)': o.picks,
      // Blank, not 0, where the screen shows "—": a "No …" request is never charged.
      'Extra charged (NPR, ex-VAT)': o.is_removal ? '' : round2(o.charged), 'Picked on': o.dishes.join(', '),
    })), { formatOf: (row, k) => (k.startsWith('Extra charged') ? MONEY_Z : null) })
    add('How often', 'Customization — How often customized', dishRows.map(d => ({
      Dish: d.name, 'Plates sold': d.plates, 'Plates customized': d.customizedPlates, 'Share customized': d.share ?? '',
    })), { formatOf: (row, k) => (k === 'Share customized' ? PCT_Z : null) })
    add('No requests', 'Customization — "No …" requests', removalRows.map(r => ({
      Dish: r.dish, Request: r.option_name, 'Plates': r.picks, 'Share of the dish': r.dishPlates ? r.picks / r.dishPlates : '',
    })), { formatOf: (row, k) => (k === 'Share of the dish' ? PCT_Z : null) })
    if (comboRows.length) {
      add('Combos', 'Customization — Combos', comboRows.map(c => ({
        Combo: c.name, 'Combos sold': c.sold, 'Of which comped': c.comped,
        'Revenue (NPR, ex-VAT)': round2(c.revenue),
        'Average per charged combo (NPR, ex-VAT)': c.perCombo == null ? '' : round2(c.perCombo),
      })), { formatOf: (row, k) => (k.includes('NPR') ? MONEY_Z : null) })
      // A combo's slot is a part (S867), in the sheet as on screen.
      add('Combo parts', 'Customization — What guests picked in each combo', comboRows.flatMap(c => c.picks.flatMap(g => g.dishes.map(d => ({
        Combo: c.name, Part: g.name, Dish: d.name, 'Plates': d.plates, 'Share of the part': d.share ?? '',
      })))), { formatOf: (row, k) => (k === 'Share of the part' ? PCT_Z : null) })
    }
    if (imsOn) {
      const marginZ = (row, k) => (k.includes('NPR') ? MONEY_Z : null)
      if (costError) {
        // Costing failed: the sheet stays, says why, and carries the charged figures it does have.
        const chargedOnly = report.options.filter(o => !o.is_removal).map(o => ({
          Choice: o.option_name, 'Charged per plate (NPR)': round2(o.chargedPerPick),
          'Cost per plate (NPR, at the item rates of today)': '', 'Margin per plate (NPR)': '', 'Times picked': o.picks,
        }))
        add('Choice margin', 'Customization — Choice margin', chargedOnly, { notes: [COST_ERROR_SHEET_NOTE], formatOf: marginZ })
      } else {
        add('Choice margin', 'Customization — Choice margin', marginSorted.map(o => {
          const f = perPlateFigures(o)
          const basis = marginBasis(o)
          return {
            Choice: o.option_name,
            'List price as billed (NPR, average per plate)': o.listPriceDelta == null ? '' : round2(o.listPriceDelta),
            'Charged per plate (NPR)': f.charged,
            'Cost per plate (NPR, at the item rates of today)': f.cost ?? '',
            'Plates the cost is averaged over': f.cost == null ? '' : o.costedPicks,
            'Margin per plate (NPR)': f.margin ?? '',
            Note: f.margin == null ? 'No stock lines on this choice' : basis ? BASIS_NOTE[basis] : f.loss ? 'Loses money on every plate' : '',
            'Times picked': o.picks,
          }
        }), {
          notes: marginSorted.length ? [] : ['No choice with stock lines was picked in this range.'],
          formatOf: marginZ,
        })
      }
    }
    if (data.weekly && data.weekly.dishes.length > 0) {
      const { weekly } = data
      const names = distinctNames(weekly.dishes.map(d => d.name))
      add('Weekly', 'Customization — Share customized, week by week', weekly.rows.map((r, k) => {
        const row = { 'Week ending (BS)': formatAdAsBs(weekly.weekEnds[k]), 'Week ending (AD)': weekly.weekEnds[k] }
        weekly.dishes.forEach((d, i) => { row[names[i]] = r[d.recipe_id] == null ? '' : r[d.recipe_id] / 100 })
        return row
      }), {
        notes: [`The top dishes by plates. A week with fewer than ${TREND_MIN_PLATES} plates of a dish is left blank.`],
        formatOf: (row, k) => (k.startsWith('Week ending') ? null : PCT_Z),
      })
    }
    XLSX.writeFile(wb, `customization-report-BS-${bsFileDate(fromIso)}-to-${bsFileDate(toIso)}.xlsx`)
  }

  async function onExport() {
    if (exporting) return
    if (exportBlock) { setExportAsked(true); return }
    setExportError(null)
    setExporting(true)
    try {
      await exportExcel()
    } catch (e) {
      // The xlsx chunk can fail to load (offline, or a deploy mid-session); say so rather than nothing.
      setExportError({ text: 'The workbook could not be made. Check your connection and press Export Excel again.', detail: asActionError(e).detail })
    } finally {
      setExporting(false)
    }
  }

  const marginCell = o => {
    const f = perPlateFigures(o)
    if (f.margin == null) return <td style={{ textAlign: 'right' }}>—</td>
    const basis = marginBasis(o)
    if (basis) {
      // Not an upsell that lost money: a choice priced at 0 by design (or a size priced below the
      // dish) costs what it costs inside the dish's own food cost. No red, no ▼.
      return (
        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
          <Tip text={BASIS_TIP[basis]}><span style={NOWRAP}>{signed2(f.margin)}</span></Tip>
        </td>
      )
    }
    return (
      <td style={{ ...FIG, color: f.loss ? 'var(--theme-red-text)' : undefined }}>
        {signed2(f.margin)}{f.loss ? ' ▼' : ''}
      </td>
    )
  }

  const lastWeekLabel = data?.weekly ? formatAdAsBs(data.weekly.weekEnds[data.weekly.weekEnds.length - 1]) : ''

  return (
    <ReportPage
      title="Customization Report"
      subtitle="Which choices guests pick, how often they customize, and what the choices earn."
      // No client, no range to state and nothing to export (S867).
      scope={noClient || backwards ? null : <PeriodScope label={bsRangeLabel(fromIso, toIso)} title={`AD ${fromIso} to ${toIso}`} />}
      // The range lives here, in the header's action group, because ReportPage never hides it: in
      // `filters` it unmounted on every pick (focus fell to the page) and vanished after a failed read.
      actions={noClient ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <RangePresets fromIso={fromIso} toIso={toIso} onPick={setRange} />
            {/* S867: on a phone the presets stay in view and the custom dates and Export fold behind
                one toggle (S805's `.phone-fold`): the header stood 290px tall at 390px wide. The fold
                is CSS alone, so the pickers never unmount and a focused one keeps its focus. */}
            <button type="button" className="btn btn-ghost btn-sm phone-only" aria-expanded={moreOpen}
              aria-controls="cust-report-more" onClick={() => setMoreOpen(v => !v)}>
              {moreOpen ? 'Hide dates and export' : 'Dates and export'}
            </button>
            <div id="cust-report-more" className={`phone-fold${moreOpen ? ' phone-fold--open' : ''}`} style={{ display: 'contents' }}>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="cust-report-from">From</label>
                <BsCalendarPicker id="cust-report-from" value={fromIso} onChange={setFromIso} />
              </div>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="cust-report-to">To</label>
                <BsCalendarPicker id="cust-report-to" value={toIso} onChange={setToIso} invalid={backwardsMsg || ''} />
              </div>
              <Tip text="Download every tab as a workbook, with the range and basis on each sheet.">
                <button type="button" className="btn btn-ghost" onClick={onExport}
                  aria-disabled={exportBlock ? 'true' : undefined} aria-busy={exporting ? 'true' : undefined}>
                  Export Excel
                </button>
              </Tip>
            </div>
          </div>
          <FieldError id="cust-report-to" message={backwardsMsg} />
          <div role="status" aria-live="polite">
            {exportAsked && exportBlock && <p className="page-footnote" style={{ marginTop: 0 }}>{exportBlock}</p>}
          </div>
          <ActionError error={exportError} />
        </div>
      )}
      loading={!noClient && loading && !backwards}
      error={noClient || backwards ? null : loadError}
      onRetry={load}
      empty={noClient || (!backwards && !!report && report.customizablePlates === 0 && (data?.combos || []).length === 0)}
      emptyText={noClient ? NO_CLIENT_TEXT : 'No dish with choices and no combo was sold in this range. Attach choice groups to dishes on Choice Groups → Dishes, or set up a combo, then check back after some bills.'}
      filters={report && (
        <>
          {/* Print hides the tab buttons and the header controls, so the sheet names its own view. */}
          <p className="print-only page-footnote" style={{ marginTop: 0 }}>Showing {tabLabel} · {scopeLine}.</p>
          <Tabs idBase="cust" label="Report view" tabs={visibleTabs} active={tab} onChange={setTab} hasPanel className="no-print" />
        </>
      )}
      stats={report && (
        <>
        {/* `--pair` (S867): two tiles across under 480px. The six stacked one per row to 590px and the
            tabs started 1361px down a phone. */}
        <div className="stat-grid stat-grid--pair">
          <div className="stat-card">
            <div className="stat-label"><Tip text="Plates of dishes that have choices, on paid bills in the range. A line of 3 is three plates.">Plates of customizable dishes</Tip></div>
            <div className="stat-value">{nprInt(report.customizablePlates)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Of those plates, how many carried at least one choice — a pre-selected size counts, so a dish whose size is always chosen will read as 100%. The change is in percentage points.">With a choice picked</Tip></div>
            <div className="stat-value">{pct(report.customizedShare)}</div>
            <div className="stat-sub">{platesText(report.customizedPlates)}</div>
            <VsBefore now={report.customizedShare} then={data.prevReport?.customizedShare} label={`the ${rangeDays} days before`}
              format={pct} opts={{ floor: 0.02 }} points />
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="What paid add-ons and larger sizes added to bills: every choice priced above the dish, ex-VAT and before bill discounts. Comped plates add nothing.">Extras earned</Tip></div>
            <div className="stat-value">{npr(Math.round(report.extrasEarned))}</div>
            <VsBefore now={report.extrasEarned} then={data.prevReport?.extrasEarned} label={`the ${rangeDays} days before`}
              format={v => npr(Math.round(v))} opts={{ floor: 100 }} />
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="What sizes priced below the dish took off bills — a Half at −NPR 100 counts here, never against extras. Ex-VAT, before bill discounts.">Size adjustments</Tip></div>
            <div className="stat-value">{negative(report.sizeAdjustments)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text={'The choice guests asked for most. Sizes are left out (a size is answered on every plate of a dish that has one, not added), and so are "No …" requests.'}>Most added</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={top ? top.option_name : undefined}>{top ? top.option_name : '—'}</div>
            {top && <div className="stat-sub">{platesText(top.picks)}</div>}
            {onlySizes && <div className="stat-sub">Only sizes were picked</div>}
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text={`The "No …" request guests made most: a removal on the plate, which the kitchen has to remember. The ${REMOVALS_TAB_LABEL} tab has it dish by dish.`}>Most removed</Tip></div>
            <div className="stat-value" style={{ fontSize: 18, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={report.removals[0] ? report.removals[0].option_name : undefined}>{report.removals[0] ? report.removals[0].option_name : '—'}</div>
            {report.removals[0] && <div className="stat-sub">{platesText(report.removals[0].picks)}</div>}
          </div>
        </div>
        {/* S862 REPORTS-STOCK-6 (owner decision CU6 a): a choice that is not a size, priced below the
            dish, is its own figure, never a size adjustment. Shown only when there is one. */}
        {report.cheaperChoices < 0 && (
          <p className="page-footnote">
            <strong>Cheaper choices {negative(report.cheaperChoices)}</strong>: choices other than a size, priced below the dish, took this off bills (ex-VAT, before bill discounts). It is counted in neither Extras earned nor Size adjustments.
          </p>
        )}
        {data.weekly && data.weekly.dishes.length > 0 && (
          <div className="dash-row" style={{ marginTop: 16 }}>
            <ChartCard
              title="Share customized, week by week — top dishes"
              headingLevel={2}
              legend={<span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>
                {data.weekly.dishes.map((d, i) => <span key={d.recipe_id} style={{ marginRight: 10, whiteSpace: 'nowrap' }}><LineSwatch i={i} /> {d.name}</span>)}
              </span>}
              footer={<div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 8 }}>
                {data.weekly.drops.length > 0
                  ? data.weekly.drops.map(d => (
                    <div key={d.recipe_id}><span style={{ color: 'var(--theme-amber-text)', fontWeight: 600 }}>▼ {d.name}</span> fell from {d.from}% to {d.to}% of plates customized in the week ending {lastWeekLabel}, {Math.round((d.from - d.to) * 10) / 10} points below the week before. Check the choice is still offered and the staff are asking.</div>
                  ))
                  : <>No top dish fell by {TREND_DROP_POINTS} points or more in the week ending {lastWeekLabel}.</>}
                <div style={{ color: 'var(--theme-text3)', marginTop: 4 }}>Weeks end on the date shown. A week with fewer than {TREND_MIN_PLATES} plates of a dish leaves a gap rather than a figure. Expand the chart for the figures as a table.</div>
              </div>}
              renderChart={h => (
                <>
                  <ResponsiveContainer width="100%" height={h}>
                    {/* The week's AD date is the category; the tick names it in BS, the tooltip in full (S867). */}
                    <LineChart data={data.weekly.rows.map((r, k) => ({ ...r, weekEnd: data.weekly.weekEnds[k] }))} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={MUTED} strokeOpacity={0.2} vertical={false} />
                      <XAxis dataKey="weekEnd" tick={{ fill: MUTED, fontSize: 11 }} tickFormatter={weekTick} />
                      <YAxis domain={[0, 100]} tick={{ fill: MUTED, fontSize: 11 }} width={40} tickFormatter={v => `${v}%`} />
                      <RTooltip
                        contentStyle={{ ...TOOLTIP_CHROME, fontSize: 12, color: 'var(--theme-text1)' }}
                        labelStyle={{ color: 'var(--theme-text1)' }} itemStyle={{ color: 'var(--theme-text1)' }}
                        labelFormatter={iso => `Week ending ${formatAdAsBs(iso)}`}
                        formatter={(v, name) => [v == null ? 'too few plates' : `${v}%`, name]}
                      />
                      {data.weekly.dishes.map((d, i) => (
                        <Line key={d.recipe_id} dataKey={d.recipe_id} name={d.name} type="monotone" stroke={CHART_COLORS[i % CHART_COLORS.length]}
                          strokeDasharray={LINE_DASHES[i % LINE_DASHES.length] || undefined}
                          strokeWidth={2} dot={{ r: 3 }} connectNulls={false} {...chartMotion()} />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                  {/* The expanded view carries the figures as a table: the chart's text alternative. */}
                  {h > 200 && <WeeklyTable weekly={data.weekly} />}
                </>
              )}
            />
          </div>
        )}
        </>
      )}
      // On screen the scope reads here; in print the `.print-only` line above the table carries it.
      footnote={report && <p className="page-footnote no-print">{scopeLine}.</p>}
    >
      {report && (
        <TabPanel idBase="cust" active={tab}>
          {tab === 'popular' && (
            // S867: on a phone the Group column hides and the group rides under the choice's name, and
            // the two-word headings may wrap, so the table fits 348px without a sideways scroll.
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <SortTh label="Choice" sortKey="option_name" sort={sort} onSort={toggleSort} />
                  <SortTh label="Group" sortKey="group_name" sort={sort} onSort={toggleSort} className="phone-hide" />
                  <SortTh label="Times picked" tip="Plates this choice was on." sortKey="picks" sort={sort} onSort={toggleSort} numeric wrap />
                  <SortTh label="Charged" tip="Price the choice added × paid plates, ex-VAT, before bill discounts." sortKey="charged" sort={sort} onSort={toggleSort} numeric />
                  <th style={WRAP_TH}>Picked on</th>
                </tr></thead>
                <tbody>
                  {popularRows.map(o => (
                    <tr key={o.key}>
                      <td>
                        {o.option_name}
                        <span className="phone-only"><span className="cell-sub">{o.group_name}</span></span>
                      </td>
                      <td className="phone-hide">{o.group_name}</td>
                      <td style={FIG}>{nprInt(o.picks)}</td>
                      <td style={FIG}>{o.is_removal ? '—' : signed(o.charged)}</td>
                      <td><DishList dishes={o.dishes} /></td>
                    </tr>
                  ))}
                  {popularRows.length === 0 && <tr><td colSpan={5} className="empty-state">No choices were picked in this range.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'dishes' && (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <SortTh label="Dish" sortKey="name" sort={sort} onSort={toggleSort} />
                  <SortTh label="Plates sold" sortKey="plates" sort={sort} onSort={toggleSort} numeric wrap />
                  <SortTh label="Customized" sortKey="customizedPlates" sort={sort} onSort={toggleSort} numeric />
                  <SortTh label="Share" tip="Plates with at least one choice ÷ plates sold. A dish nobody customizes may not need its choice groups; one everybody customizes may want a new default." sortKey="share" sort={sort} onSort={toggleSort} numeric />
                </tr></thead>
                <tbody>
                  {dishRows.map(d => (
                    <tr key={d.recipe_id}>
                      <td>{d.name}</td>
                      <td style={FIG}>{nprInt(d.plates)}</td>
                      <td style={FIG}>{nprInt(d.customizedPlates)}</td>
                      <td style={FIG}>{pct(d.share)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'removals' && (
            removalRows.length === 0
              ? <p className="empty-state">No "No …" choices were picked in this range.</p>
              : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr>
                      <SortTh label="Dish" sortKey="dish" sort={sort} onSort={toggleSort} />
                      <SortTh label="Request" sortKey="option_name" sort={sort} onSort={toggleSort} />
                      <SortTh label="Plates" sortKey="picks" sort={sort} onSort={toggleSort} numeric />
                      <SortTh label="Share of the dish" tip="Plates with this request ÷ all plates of the dish. A request on most plates may mean the recipe should change." sortKey="share" sort={sort} onSort={toggleSort} numeric wrap />
                    </tr></thead>
                    <tbody>
                      {removalRows.map(r => (
                        <tr key={`${r.recipe_id}|${r.option_name}`}>
                          <td>{r.dish}</td>
                          <td>{r.option_name}</td>
                          <td style={FIG}>{nprInt(r.picks)}</td>
                          <td style={FIG}>{pct(r.dishPlates ? r.picks / r.dishPlates : null)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
          )}

          {tab === 'combos' && (
            comboRows.length === 0 ? (
              <p className="empty-state">No combo was sold in this range.</p>
            ) : (
              <div className="table-wrap">
                {/* S867: on a phone Per combo hides (Revenue ÷ the charged combos, both shown) and the
                    dish mix wraps between its dishes, never inside a count and its share. */}
                <table className="data-table">
                  <thead><tr>
                    <SortTh label="Combo" sortKey="name" sort={sort} onSort={toggleSort} />
                    <SortTh label="Sold" tip="Combos on paid bills in the range: each combo once, at its quantity. Comped combos are counted too." sortKey="sold" sort={sort} onSort={toggleSort} numeric />
                    <SortTh label="Revenue" tip="What its dishes were charged, ex-VAT. A bill discount never touches a combo, so this is after discounts too. Comped dishes add nothing." sortKey="revenue" sort={sort} onSort={toggleSort} numeric />
                    <SortTh label="Per combo" tip="Revenue ÷ the combos that were charged. Above the price of the combo itself when guests pick dishes or choices that cost extra." sortKey="perCombo" sort={sort} onSort={toggleSort} numeric className="phone-hide" />
                    <th style={WRAP_TH}><Tip text="Each part of the combo, its dishes by how many plates guests chose, and each dish as a share of that part.">What guests picked</Tip></th>
                  </tr></thead>
                  <tbody>
                    {comboRows.map(c => (
                      <tr key={c.combo_id || c.name}>
                        <td>{c.name}</td>
                        <td style={{ textAlign: 'right' }}>
                          <span style={NOWRAP}>{nprInt(c.sold)}</span>
                          {c.comped > 0 && <span className="cell-sub">{nprInt(c.comped)} comped</span>}
                        </td>
                        <td style={FIG}>{npr(Math.round(c.revenue))}</td>
                        <td style={FIG} className="phone-hide">{c.perCombo == null ? '—' : npr(Math.round(c.perCombo))}</td>
                        <td>
                          {c.picks.map(g => (
                            <div key={g.group_id || g.name}>
                              <span style={{ color: 'var(--theme-text2)' }}>{g.name}:</span>{' '}
                              {g.dishes.map((d, i) => (
                                <span key={d.recipe_id || d.name}>
                                  {i > 0 && ' · '}{d.name} <span style={NOWRAP}>{nprInt(d.plates)} ({pct(d.share)})</span>
                                </span>
                              ))}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}

          {tab === 'margin' && imsOn && (
            costError ? (
              <div>
                <ActionError error={costError} />
                <button type="button" className="btn btn-ghost" style={{ marginTop: 12 }} onClick={load}>Try again</button>
              </div>
            ) : marginSorted.length === 0 ? (
              <p className="empty-state">No choice with stock lines was picked in this range. Add stock lines to a choice in Choice Groups to see its cost here.</p>
            ) : (
              <>
                {/* Below 600px this list shows and the table hides: Margin, the figure the tab
                    exists for, fell past a 360px screen edge in the five-column table. */}
                <ul className="phone-cards phone-cards--no-fab phone-only" aria-label="Choice margin">
                  {marginSorted.map(o => {
                    const f = perPlateFigures(o)
                    const basis = f.margin == null ? null : marginBasis(o)
                    const color = basis ? 'var(--theme-text2)' : f.loss ? 'var(--theme-red-text)' : undefined
                    return (
                      <li key={o.key} className="phone-card">
                        <div className="phone-card__top">
                          <span className="phone-card__title">{o.option_name}</span>
                          <span className="phone-card__figure" style={{ color }}>
                            {f.margin == null ? '—' : `${signed2(f.margin)}${f.loss && !basis ? ' ▼' : ''}`}
                          </span>
                        </div>
                        <div className="phone-card__meta">
                          Margin a plate · charged {signed2(f.charged)} · cost {f.cost == null ? 'no stock lines' : nprExact(f.cost)} · {platesText(o.picks)}
                        </div>
                        {basis && <div className="phone-card__meta">{BASIS_NOTE[basis]}, not a loss on an upsell.</div>}
                      </li>
                    )
                  })}
                </ul>
                <div className="table-wrap phone-hide">
                  <table className="data-table">
                    <thead><tr>
                      <SortTh label="Choice" sortKey="option_name" sort={sort} onSort={toggleSort} />
                      <SortTh label="Charged / plate" tip={'Average price this choice added per plate, ex-VAT, at the price each bill charged, to the paisa. A plate inside its group "first N free", or a comped plate, lowers it below the list price.'} sortKey="chargedPerPick" sort={sort} onSort={toggleSort} numeric />
                      <SortTh label="Cost / plate" tip="The stock lines of each plate for this choice as they were on its bill (the bigger portion of a Large bowl included), valued at the item rates of today and averaged, to the paisa. Plates billed before the choice had stock lines are left out." sortKey="costPerPick" sort={sort} onSort={toggleSort} numeric />
                      <SortTh label="Margin / plate" tip="Charged minus cost, as shown. A choice that was free on every bill is shown in grey: its cost belongs to the dish, not to an upsell." sortKey="margin" sort={sort} onSort={toggleSort} numeric />
                      <SortTh label="Times picked" sortKey="picks" sort={sort} onSort={toggleSort} numeric />
                    </tr></thead>
                    <tbody>
                      {marginSorted.map(o => {
                        const f = perPlateFigures(o)
                        // S809 3o (REPORTS-12): only when some plates WERE free picks or comped, against
                        // the list price as billed. A price change since is not a free pick.
                        const belowList = (o.freePicks > 0 || o.compedPicks > 0)
                          && o.listPriceDelta != null && o.listPriceDelta > 0 && o.chargedPerPick < o.listPriceDelta - 0.005
                        const were = n => (n === 1 ? 'was' : 'were')
                        const whyLess = [
                          o.freePicks > 0 ? `${nprInt(o.freePicks)} ${were(o.freePicks)} inside the group "first N free"` : null,
                          o.compedPicks > 0 ? `${nprInt(o.compedPicks)} ${were(o.compedPicks)} comped` : null,
                        ].filter(Boolean).join(' and ')
                        return (
                          <tr key={o.key}>
                            <td>{o.option_name}</td>
                            <td style={{ textAlign: 'right' }}>
                              <span style={NOWRAP}>{signed2(f.charged)}</span>
                              {belowList && (
                                <span className="cell-sub">
                                  <Tip text={`Billed at a list price of ${signed2(o.listPriceDelta)} a plate on average. Of ${platesText(o.picks)}, ${whyLess}: ${o.freePicks + o.compedPicks === 1 ? 'that plate' : 'those'} paid nothing for it.`}>{o.freePicks > 0 ? 'incl. free choices' : 'incl. comped plates'}</Tip>
                                </span>
                              )}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {f.cost == null ? <Tip text="No stock lines on this choice.">—</Tip> : <span style={NOWRAP}>{nprExact(f.cost)}</span>}
                              {f.cost != null && o.costedPicks < o.picks && (
                                <span className="cell-sub">
                                  <Tip text="The other plates were billed before this choice had stock lines, so they carry none and are left out of the average.">over {nprInt(o.costedPicks)} of {platesText(o.picks)}</Tip>
                                </span>
                              )}
                            </td>
                            {marginCell(o)}
                            <td style={FIG}>{nprInt(o.picks)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )
          )}
        </TabPanel>
      )}
    </ReportPage>
  )
}
