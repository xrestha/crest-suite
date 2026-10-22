import fs from 'fs'
import path from 'path'
import { startBuyingListReads, loadBuyingList } from './demandForecastLoad'
import { loadRecipeBook, explodeRecipeIngredients } from '../../../utils/recipeCost'
import { loadDeltaExplosion } from '../../../utils/orderLineIngredients'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { totalQtyByRecipe, usualSupplierByItem } from '../../../utils/demandForecastMath'
import { adToBs } from '../../../utils/bsCalendar'
import { buildStockRows } from './stockReportCalc'

// Demand Forecast's buying list in round trips (S859). It was 13 serial levels on Fast 3G: the
// recipe walk one sub-recipe level per round trip, the items after it, the month list read again,
// the month's stock filtered by those items, a second level-by-level walk, then the suppliers. The
// stub below holds every request until the test answers a whole round at once, so `levels` is the
// number of serial round trips the loader needed, and `log` says which table each one read.

// ── Fixture: Pasta uses House Sauce, which uses Herb Base (two sub-recipe levels) ──────────────
const OPEN_DAY = adToBs(new Date(2026, 8, 20))   // a day inside the run's 12-week window
const PREV = OPEN_DAY.month === 1 ? { year: OPEN_DAY.year - 1, month: 12 } : { year: OPEN_DAY.year, month: OPEN_DAY.month - 1 }
const PERIODS = [   // the shared list's order: newest first
  { id: 'p-open', client_id: 'c1', bs_year: OPEN_DAY.year, bs_month: OPEN_DAY.month, status: 'open' },
  { id: 'p-prev', client_id: 'c1', bs_year: PREV.year, bs_month: PREV.month, status: 'closed' },
]
const RUN_AT = '2026-10-01T06:00:00Z'
const LIST = [{ bs: { year: OPEN_DAY.year, month: OPEN_DAY.month, day: OPEN_DAY.day }, forecastQtyByRecipe: { 'rc-pasta': 10, 'rc-unsold': 0 } }]

const item = (id, name, rate, yieldPct) => ({ id, name, uom: 'g', per_uom_rate: rate, yield_pct: yieldPct, is_active: true, purchase_unit: null, conversion_factor: null, categories: { name: 'Kitchen' } })

function fixture({ salesRows = null, choiceDelta = { item_id: 'it-tomato', qty: 30 } } = {}) {
  return {
    items: [item('it-basil', 'Basil', 2, 50), item('it-cheese', 'Cheese', 1.5, 80), item('it-napkin', 'Napkin', 3, 100), item('it-tomato', 'Tomato', 0.5, 100)],
    recipes: [
      { id: 'rc-herb', name: 'Herb Base', category: 'Sub-Recipe', yield_qty: 100, yield_uom: 'g', cost_price: null },
      { id: 'rc-pasta', name: 'Pasta', category: 'Food', yield_qty: 1, yield_uom: 'portion', cost_price: null },
      { id: 'rc-sauce', name: 'House Sauce', category: 'Sub-Recipe', yield_qty: 2000, yield_uom: 'ml', cost_price: null },
      { id: 'rc-unsold', name: 'Soup', category: 'Food', yield_qty: 1, yield_uom: 'portion', cost_price: null },
    ],
    recipe_ingredients: [
      { id: 'ri-01', recipe_id: 'rc-pasta', qty_per_portion: 50, item_id: null, sub_recipe_id: 'rc-sauce' },
      { id: 'ri-02', recipe_id: 'rc-pasta', qty_per_portion: 10, item_id: 'it-basil', sub_recipe_id: null },
      { id: 'ri-03', recipe_id: 'rc-sauce', qty_per_portion: 1000, item_id: 'it-tomato', sub_recipe_id: null },
      { id: 'ri-04', recipe_id: 'rc-sauce', qty_per_portion: 5, item_id: null, sub_recipe_id: 'rc-herb' },
      { id: 'ri-05', recipe_id: 'rc-herb', qty_per_portion: 20, item_id: 'it-basil', sub_recipe_id: null },
    ],
    opening_stock: [
      { id: 'os-01', period_id: 'p-open', item_id: 'it-tomato', qty: 1000 },
      { id: 'os-02', period_id: 'p-open', item_id: 'it-basil', qty: 100 },
      { id: 'os-03', period_id: 'p-open', item_id: 'it-napkin', qty: 50 },
    ],
    closing_stock: [{ id: 'cs-01', period_id: 'p-open', item_id: 'it-basil', physical_qty: 40 }],
    purchase_entries: [
      { id: 'pe-01', period_id: 'p-open', item_id: 'it-tomato', qty: 500, vendor_id: 'v-1', bs_day: 2, created_at: '2026-09-15T00:00:00Z' },
      { id: 'pe-02', period_id: 'p-open', item_id: 'it-napkin', qty: 100, vendor_id: 'v-2', bs_day: 3, created_at: '2026-09-16T00:00:00Z' },
      { id: 'pe-03', period_id: 'p-prev', item_id: 'it-basil', qty: 200, vendor_id: 'v-2', bs_day: 10, created_at: '2026-08-20T00:00:00Z' },
      { id: 'pe-04', period_id: 'p-prev', item_id: 'it-tomato', qty: 50, vendor_id: 'v-2', bs_day: 20, created_at: '2026-08-30T00:00:00Z' },
    ],
    vendor_returns: [{ id: 'vr-01', period_id: 'p-open', item_id: 'it-tomato', qty: 20 }],
    wastages: [
      { id: 'wa-01', period_id: 'p-open', item_id: 'it-tomato', qty: 10 },
      { id: 'wa-02', period_id: 'p-open', item_id: 'it-tomato', qty: 5 },
      { id: 'wa-03', period_id: 'p-open', item_id: 'it-napkin', qty: 1 },
    ],
    staff_meals: [],
    sales_entries: salesRows || [
      // A day the till did not sell on, so the POS-supersedes-manual rule keeps both rows.
      { id: 'se-01', period_id: 'p-open', recipe_id: 'rc-pasta', qty_sold: 4, bs_day: OPEN_DAY.day === 3 ? 4 : 3, source: 'manual', ingredient_deltas: null },
      { id: 'se-02', period_id: 'p-open', recipe_id: 'rc-pasta', qty_sold: 2, bs_day: OPEN_DAY.day, source: 'pos', ingredient_deltas: [choiceDelta] },
    ],
    par_levels: [
      { id: 'pl-01', item_id: 'it-tomato', par_qty: 300 },
      { id: 'pl-02', item_id: 'it-napkin', par_qty: 10 },
    ],
    ims_stock_transfer_lines: [{ id: 'tl-01', period_id: 'p-open', item_id: 'it-tomato', qty: 5, direction: 'in' }],
    vendors: [{ id: 'v-1', name: 'Fresh Farm', is_active: true }, { id: 'v-2', name: 'Paper Co', is_active: true }],
  }
}

// ── The stub: PostgREST's answers, one round at a time ────────────────────────────────────────
// Chainable builders for every shape the loaders build (.eq/.in/.not/.order, paged by .range, with
// `count` when page 1 asks for it). Rows come back in id order, which every read here asks for.
// `auto` answers at once, for the reference figures below, which do not count round trips.
function makeDb(tables, { auto = false, fail = [] } = {}) {
  const pending = []
  const log = []
  let level = 1
  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const itemById = id => tables.items.find(i => i.id === id)
  const withItem = r => (r.item_id ? { ...r, items: { name: itemById(r.item_id)?.name, per_uom_rate: itemById(r.item_id)?.per_uom_rate, yield_pct: itemById(r.item_id)?.yield_pct } } : { ...r, items: null })
  const rowsOf = q => {
    if (q.book) {
      return tables.recipes.map(r => ({ ...r, recipe_ingredients: tables.recipe_ingredients.filter(i => i.recipe_id === r.id).sort(byId).map(withItem) }))
    }
    if (q.table === 'recipe_ingredients') return tables.recipe_ingredients.map(withItem)
    return tables[q.table] || []
  }
  const answer = (q, from, to) => {
    if (fail.includes(q.table)) return { data: null, error: { message: `${q.table} could not be read` } }
    const rows = rowsOf(q).filter(r => q.filters.every(f => f(r))).sort(byId)
    return {
      data: from == null ? rows : rows.slice(from, to + 1),
      error: null,
      count: q.opts?.count === 'exact' ? rows.length : null,
    }
  }
  const send = (q, from, to) => {
    log.push({ table: q.table, book: !!q.book, level, filtered: q.inCols })
    if (auto) return Promise.resolve(answer(q, from, to))
    return new Promise(resolve => pending.push(() => resolve(answer(q, from, to))))
  }
  const builder = q => {
    const add = (f, inCol) => builder({ ...q, filters: [...q.filters, f], inCols: inCol ? [...q.inCols, inCol] : q.inCols })
    const b = {
      eq: (c, v) => add(r => r[c] === v),
      in: (c, vs) => { const s = new Set(vs); return add(r => s.has(r[c]), c) },
      not: (c, op, v) => add(r => (op === 'is' && v === null ? r[c] != null : true)),
      order: () => b,
      limit: () => b,
      range: (from, to) => send(q, from, to),
      then: (res, rej) => send(q).then(res, rej),
    }
    return b
  }
  const start = (table, cols = '*', opts) => builder({ table, opts, book: table === 'recipes' && cols.includes('recipe_ingredients'), filters: [], inCols: [] })
  return {
    log,
    scopedFrom: (table, cols, opts) => start(table, cols, opts),
    supabase: { from: table => ({ select: (cols, opts) => start(table, cols, opts) }) },
    get levels() { return log.reduce((m, l) => Math.max(m, l.level), 0) },
    // Answers every waiting request at once, lets the code react, and repeats until nothing waits.
    async settle() {
      for (;;) {
        await new Promise(r => setTimeout(r, 0))
        if (pending.length === 0) return
        const round = pending.splice(0)
        level += 1
        round.forEach(answerIt => answerIt())
      }
    },
  }
}

// transferFlows' readPeriodTransfers for one period (that file imports the Supabase client).
const readTransfers = (sf, periodId, { select }) => fetchAllRows(() => sf('ims_stock_transfer_lines', select).eq('period_id', periodId).order('id'))

// The page's first load: the month list, the book, the buying list's reads and the forecast all
// start together; the buying list is worked out once the forecast lands.
async function loadPage(db, { customization = false, periodsError = null } = {}) {
  const periodsP = db.scopedFrom('monthly_periods').range(0, 999)
    .then(() => (periodsError ? { data: null, error: periodsError } : { data: PERIODS.map(p => ({ ...p })), error: null }))
  const bookP = loadRecipeBook(db.scopedFrom).then(book => ({ data: book, error: null }), error => ({ data: null, error }))
  const reads = startBuyingListReads({ supabase: db.supabase, scopedFrom: db.scopedFrom, periodsP, bookP, readTransfers })
  const forecastP = db.scopedFrom('demand_forecast_daily').range(0, 999)
  const totals = totalQtyByRecipe(LIST)
  const recipeIds = Object.keys(totals).filter(id => totals[id] > 0)
  const done = forecastP.then(() => loadBuyingList({ supabase: db.supabase, reads, totals, recipeIds, runAt: RUN_AT, customization }))
  done.catch(() => {})   // awaited by the caller; never an unhandled rejection while the rounds run
  await db.settle()
  return done
}

// ── The old reads, as DemandForecast.js made them before S859: the reference for the figures ──
async function oldFigures(tables, items) {
  const db = makeDb(tables, { auto: true })
  const period = PERIODS[0]
  const itemIds = items.map(i => i.id)
  const byItems = (table, cols, scoped) => fetchAllRowsChunked(itemIds, ids =>
    (scoped ? db.scopedFrom(table, cols) : db.supabase.from(table).select(cols)).eq('period_id', period.id).in('item_id', ids).order('id'))
  const results = await Promise.all([
    byItems('opening_stock', 'item_id, qty'),
    byItems('closing_stock', 'item_id, physical_qty'),
    byItems('purchase_entries', 'item_id, qty'),
    byItems('vendor_returns', 'item_id, qty', true),
    byItems('wastages', 'item_id, qty'),
    byItems('staff_meals', 'item_id, qty'),
    fetchAllRows(() => db.supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day, source, ingredient_deltas').eq('period_id', period.id).order('id')),
    fetchAllRowsChunked(itemIds, ids => db.scopedFrom('par_levels', 'id, item_id, par_qty').in('item_id', ids).order('id')),
    readTransfers(db.scopedFrom, period.id, { select: 'id, item_id, qty, direction' }),
  ])
  const [{ data: opening }, { data: closing }, { data: purchases }, { data: returns }, { data: wastages }, { data: staffMeals }, { data: sales }, { data: pars }, { data: transfers }] = results
  const soldIds = [...new Set(sales.map(s => s.recipe_id).filter(Boolean))]
  const [breakdown, explosion] = await Promise.all([
    explodeRecipeIngredients(db.supabase, soldIds),
    loadDeltaExplosion(db.supabase, sales.map(s => s.ingredient_deltas)),
  ])
  const rows = buildStockRows({ items, opening, closing, purchases, returns, wastages, staffMeals, sales, breakdown, explosion, transfers })
  const lines = await fetchAllRowsChunked(itemIds, ids => db.supabase.from('purchase_entries')
    .select('id, item_id, vendor_id, period_id, bs_day, created_at').in('period_id', PERIODS.map(p => p.id)).in('item_id', ids).not('vendor_id', 'is', null).order('id'))
  return {
    exploded: await explodeRecipeIngredients(db.supabase, ['rc-pasta']),
    onHandById: Object.fromEntries(rows.map(r => [r.item.id, r.onHand])),
    countedIds: new Set(rows.filter(r => r.stockSource === 'closing').map(r => r.item.id)),
    parById: Object.fromEntries(pars.map(p => [p.item_id, Number(p.par_qty) || 0])),
    byItem: usualSupplierByItem(lines.data, { 'p-open': PERIODS[0].bs_year * 100 + PERIODS[0].bs_month, 'p-prev': PERIODS[1].bs_year * 100 + PERIODS[1].bs_month }),
  }
}

describe('Demand Forecast buying list: round trips (S859)', () => {
  test('two serial levels with the forecast, the walks over the recipe book in memory', async () => {
    const db = makeDb(fixture())
    const out = await loadPage(db, { customization: true })
    expect(db.levels).toBe(2)
    // Level 1: the month list, the forecast, the book, every item, every par. Level 2: the month's
    // stock, the suppliers and the guests' choices, all once the month list has landed.
    const at = level => db.log.filter(l => l.level === level).map(l => (l.book ? 'recipe book' : l.table)).sort()
    expect(at(1)).toEqual(['demand_forecast_daily', 'items', 'monthly_periods', 'par_levels', 'recipe book'])
    expect(at(2)).toEqual(['closing_stock', 'ims_stock_transfer_lines', 'opening_stock', 'purchase_entries', 'purchase_entries',
      'sales_entries', 'sales_entries', 'staff_meals', 'vendor_returns', 'vendors', 'wastages'])
    // Never the level-by-level walk, never the month list again, never an item-id filter that waits on the walk.
    expect(db.log.filter(l => l.table === 'recipe_ingredients')).toHaveLength(0)
    expect(db.log.filter(l => l.table === 'recipes')).toHaveLength(1)
    expect(db.log.filter(l => l.table === 'monthly_periods')).toHaveLength(1)
    expect(db.log.filter(l => (l.filtered || []).includes('item_id'))).toHaveLength(0)
    expect(out.stockError).toBeNull()
    expect(out.supplierError).toBeNull()
    expect(out.choiceError).toBeNull()
  })

  test('a month past one page costs one more level, not one per page', async () => {
    const sales = Array.from({ length: 2500 }, (_, i) => ({
      id: `se-${String(i).padStart(5, '0')}`, period_id: 'p-open', recipe_id: 'rc-pasta', qty_sold: 1, bs_day: 1 + (i % 25), source: 'manual', ingredient_deltas: null,
    }))
    const db = makeDb(fixture({ salesRows: sales }))
    const out = await loadPage(db)
    expect(db.levels).toBe(3)
    // Every row counted: 2500 plates × 25 g of tomato off the shelf (1000 + 500 − 20 + 5 − 15 − 62,500, floored at 0).
    expect(out.stock.onHandById['it-tomato']).toBe(0)
    expect(db.log.filter(l => l.table === 'sales_entries').length).toBe(3)
  })
})

describe('Demand Forecast buying list: the same figures as the old reads (S859)', () => {
  test('walk, in store, par and suppliers match the item-filtered reads and the level-by-level walk', async () => {
    const tables = fixture()
    const db = makeDb(tables)
    const out = await loadPage(db, { customization: true })
    const old = await oldFigures(tables, out.items)
    expect(out.exploded).toEqual(old.exploded)
    expect(out.stock.onHandById).toEqual(old.onHandById)
    expect(out.stock.countedIds).toEqual(old.countedIds)
    expect(out.stock.parById).toEqual(old.parById)
    expect(out.suppliers.byItem).toEqual(old.byItem)
    // And by hand. Pasta: 50 ml of sauce (0.025 batch) → 25 g tomato and, through Herb Base, 0.025 g
    // of basil at 50% yield → 0.05 g, plus 10 g of basil at 50% → 20 g.
    const [tomato, basil] = out.exploded['rc-pasta']
    expect(tomato).toEqual({ item_id: 'it-tomato', qty: 25 })
    expect(basil.item_id).toBe('it-basil')
    expect(basil.qty).toBeCloseTo(20.05, 10)
    // Tomato: 1000 + 500 − 20 + 5 (transfer in) − 6 plates × 25 − 2 plates × 30 (choices) − 15 wasted.
    expect(out.stock.onHandById).toEqual({ 'it-basil': 40, 'it-tomato': 1260 })
    expect(out.stock.parById).toEqual({ 'it-tomato': 300 })
    expect(out.suppliers.byItem).toEqual({ 'it-tomato': 'v-1', 'it-basil': 'v-2' })
    expect(out.choicePerPlate).toEqual({ 'rc-pasta': [{ item_id: 'it-tomato', qty: 30 }] })
    // Only the forecast's items, never the other rows the whole-month reads brought back.
    expect(out.items.map(i => i.id).sort()).toEqual(['it-basil', 'it-tomato'])
  })

  test('a choice on an item no recipe uses reads its yield rather than taking 100% from the book', async () => {
    const tables = fixture({ choiceDelta: { item_id: 'it-cheese', qty: 8 } })
    const db = makeDb(tables)
    const out = await loadPage(db, { customization: true })
    // 8 g at 80% yield is 10 g of cheese a plate; 100% would have been 8.
    expect(out.choicePerPlate).toEqual({ 'rc-pasta': [{ item_id: 'it-cheese', qty: 10 }] })
    expect(out.items.map(i => i.id).sort()).toEqual(['it-basil', 'it-cheese', 'it-tomato'])
    const old = await oldFigures(tables, out.items)
    expect(out.stock.onHandById).toEqual(old.onHandById)
    expect(db.log.some(l => l.table === 'items' && (l.filtered || []).includes('id'))).toBe(true)
  })
})

describe('Demand Forecast buying list: failed reads (S859)', () => {
  test('a failed recipe book fails the list loudly, never an empty walk', async () => {
    const db = makeDb(fixture(), { fail: ['recipes'] })
    await expect(loadPage(db)).rejects.toThrow(/recipes could not be read/)
  })

  test('a failed month list blanks In store and the suppliers, and leaves forecast use standing', async () => {
    const db = makeDb(fixture())
    const out = await loadPage(db, { periodsError: { message: 'months could not be read' } })
    expect(out.stockError).toEqual({ message: 'months could not be read' })
    expect(out.supplierError).toEqual({ message: 'months could not be read' })
    expect(out.stock.onHandById).toBeNull()
    expect(out.exploded['rc-pasta']).toHaveLength(2)
    expect(out.items).toHaveLength(2)
  })

  test('a failed stock read is In store unknown, not an empty shelf', async () => {
    const db = makeDb(fixture(), { fail: ['closing_stock'] })
    const out = await loadPage(db)
    expect(out.stockError).toMatch(/closing_stock could not be read/)
    expect(out.stock.onHandById).toBeNull()
    expect(out.supplierError).toBeNull()
  })
})

// The page's half, read from its source (the periodListReads.test.js pattern): DemandForecast.js
// starts every read above BESIDE the forecast, takes its months from the shared list, and walks
// nothing itself. None of it has a symptom but a slower page.
describe('DemandForecast.js starts the buying list beside the forecast (S859)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'DemandForecast.js'), 'utf8')
  const loadStored = src.slice(src.indexOf('const loadStored = useCallback'), src.indexOf('useEffect(() => { loadStored() }'))

  test('reads no month list of its own, and the shared one once a load', () => {
    expect(src).not.toMatch(/['"]monthly_periods['"]/)
    expect(src).toMatch(/const periodList = usePeriodList\(\)/)
    expect(loadStored.match(/periodList\(\)/g)).toHaveLength(1)
  })

  test('the book and the buying list reads start before the forecast is awaited', () => {
    const firstAwait = loadStored.indexOf('await ')
    expect(loadStored.indexOf('loadRecipeBook(scopedFrom)')).toBeGreaterThan(-1)
    expect(loadStored.indexOf('loadRecipeBook(scopedFrom)')).toBeLessThan(firstAwait)
    expect(loadStored.indexOf('startBuyingListReads(')).toBeLessThan(firstAwait)
  })

  test('the dish names come from the book, and no walk or recipe read runs on the page', () => {
    expect(src).not.toMatch(/scopedFrom\(['"]recipes['"]/)
    expect(src).not.toMatch(/explodeRecipe(Ingredients|Tree)\(/)
    expect(src).not.toMatch(/loadDeltaExplosion\(/)
  })
})
