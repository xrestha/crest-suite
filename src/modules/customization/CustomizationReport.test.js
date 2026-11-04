/**
 * The Customization Report (S863): the range controls stay mounted while the report loads and
 * after a failed read, a backwards range is refused before any read, and the per-plate margin is
 * shown to the paisa with the loss decided on the figure as shown.
 *
 * S867: a count of one plate says "plate", the trend names its days in BS, the phone layout (two
 * tiles across, the custom dates and Export behind one toggle, Popular without a Group column),
 * and a plain state when no client is chosen.
 */
/* Node access is deliberate: a BsCalendarPicker trigger is named by the date it shows, so the two
   pickers are found by their field ids, and node identity is what proves they never remounted. */
/* eslint-disable testing-library/no-node-access */
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Each table's answer: a value, or a function returning one (a promise to hold a read open).
let mockAnswers = {}
const mockReads = {}
function mockBuilder(table) {
  const b = {}
  for (const op of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'limit', 'not', 'or', 'range', 'single', 'maybeSingle', 'is']) {
    b[op] = () => b
  }
  b.then = (ok, fail) => {
    mockReads[table] = (mockReads[table] || 0) + 1
    const a = mockAnswers[table]
    const answer = typeof a === 'function' ? a() : (a || { data: [], error: null })
    return Promise.resolve(answer).then(ok, fail)
  }
  return b
}
const mockScopedDb = { scopedFrom: table => mockBuilder(table) }
jest.mock('../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScopedDb }))
// The bill ids each chunked read was asked for, in order. The bill read hands no page over unless a
// test sets `mockParallel` (S876): the page then starts every line from the final bill list.
const mockChunkIds = []
let mockParallel = null
jest.mock('../../shared/fetchAllRows', () => ({
  fetchAllRows: makeQuery => makeQuery(),
  fetchAllRowsChunked: (ids, makeQuery) => {
    mockChunkIds.push(ids)
    return ids.length ? makeQuery(ids) : Promise.resolve({ data: [], error: null })
  },
  fetchAllRowsParallel: (makeQuery, opts) => (mockParallel ? mockParallel(makeQuery, opts) : makeQuery({ count: 'exact' })),
}))
jest.mock('../../supabaseClient', () => ({ supabase: { from: table => mockBuilder(table), rpc: () => mockBuilder('rpc') } }))
const mockAuth = { clientId: 'c1', isAdmin: true, isOwner: false, profile: {}, clientModules: { ims: false } }
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../shared/hooks/useBizInfo', () => ({
  useBizInfo: () => ({ name: 'Test Cafe', vat: '', address: '', vatReg: true, error: null, ready: true }),
}))
const mockRates = {}
// S869: the book the page asks for beside the bills, and what the costing was handed.
const mockBook = { items: new Map(), recipes: new Map() }
const mockBookCalls = []
const mockCostingCalls = []
jest.mock('../pos/orders/posRecipeBook', () => ({
  posDeltaCosting: (...args) => {
    mockCostingCalls.push(args)
    return Promise.resolve({ explosion: { itemYield: {}, subPerUnit: {} }, rateOf: id => mockRates[id] || 0 })
  },
  loadPosRecipeBook: (...args) => { mockBookCalls.push(args); return Promise.resolve(mockBook) },
  deltaIdsOf: lists => {
    const itemIds = new Set()
    const subRecipeIds = new Set()
    for (const list of lists || []) for (const d of list || []) (d.item_id ? itemIds.add(d.item_id) : d.sub_recipe_id && subRecipeIds.add(d.sub_recipe_id))
    return { itemIds: [...itemIds], subRecipeIds: [...subRecipeIds] }
  },
}))
// The range the page opens on, fixed for the test (and backwards where a test says so).
let mockRange = null
jest.mock('../pos/reports/reportRange', () => {
  const actual = jest.requireActual('../pos/reports/reportRange')
  return { ...actual, bsMonthRangeIso: (...args) => mockRange || actual.bsMonthRangeIso(...args) }
})

// eslint-disable-next-line import/first
import CustomizationReport, { perPlateFigures, signed2, rangeProblem, scopeLineOf, bsRangeLabel, bsFileDate, marginBasis, platesText, weekTick } from './CustomizationReport'
// eslint-disable-next-line import/first
import { bsToAd, formatAd } from '../../utils/bsCalendar'

const renderPage = () => render(<MemoryRouter><CustomizationReport /></MemoryRouter>)
// The picker triggers carry the field ids; by id, since a BS calendar trigger names its date.
const fromPicker = () => document.getElementById('cust-report-from')
const toPicker = () => document.getElementById('cust-report-to')

beforeEach(() => {
  mockAnswers = {}
  Object.keys(mockReads).forEach(k => delete mockReads[k])
  Object.keys(mockRates).forEach(k => delete mockRates[k])
  mockBookCalls.length = 0
  mockCostingCalls.length = 0
  mockChunkIds.length = 0
  mockParallel = null
  mockRange = { from: '2025-09-01', to: '2025-09-10' }
  mockAuth.clientModules = { ims: false }
  mockAuth.clientId = 'c1'
})

// One bill of one plate: Momo with an Extra cheese and a "No onion".
function answerOnePlate() {
  mockAnswers.pos_orders = { data: [{ id: 'o1', closed_at: '2025-09-05T06:00:00Z' }], error: null }
  mockAnswers.pos_order_items = { data: [{ id: 'l1', order_id: 'o1', recipe_id: 'r1', name: 'Momo', qty: 1, comped: false, selection_key: 'op1+op2' }], error: null }
  const snap = (id, group, name, price, removal) => ({
    id: `s-${id}`, order_item_id: 'l1', option_id: id, group_name: group, group_kind: 'addon', option_name: name,
    is_removal: removal, price_delta: price, list_price_delta: price, included: false, ingredient_deltas: null,
  })
  mockAnswers.pos_order_item_options = { data: [snap('op1', 'Extras', 'Cheese', 50, false), snap('op2', 'Remove', 'No onion', 0, true)], error: null }
}

describe('the range controls', () => {
  test('stay mounted while the report loads and after a failed read, and Try again reads again', async () => {
    let release
    mockAnswers.pos_orders = () => new Promise(res => { release = res })
    renderPage()
    expect(screen.getByText('Building report…')).toBeTruthy()
    const from = fromPicker()
    const to = toPicker()
    expect(from).toBeTruthy()
    expect(to).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Date range' })).toBeTruthy()

    // The bill read is issued a microtask after mount; fail it once it is open.
    await waitFor(() => expect(typeof release).toBe('function'))
    release({ data: null, error: { message: 'connection reset', code: '08006' } })
    expect(await screen.findByText('Could not load this report')).toBeTruthy()
    // The same nodes: never unmounted, so focus on them is never dropped to the page.
    expect(fromPicker()).toBe(from)
    expect(toPicker()).toBe(to)

    const before = mockReads.pos_orders
    mockAnswers.pos_orders = { data: [], error: null }
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText(/No dish with choices and no combo was sold in this range\. Attach choice groups to dishes on Choice Groups → Dishes/)).toBeTruthy()
    expect(mockReads.pos_orders).toBe(before + 1)
    expect(fromPicker()).toBe(from)
  })

  test('a backwards range is refused under To: no read, no loading line, no empty state', async () => {
    mockRange = { from: '2025-09-10', to: '2025-09-01' }
    renderPage()
    const msg = await screen.findByText('The To date is before the From date. Pick a To date on or after the From date.')
    expect(msg.id).toBe('cust-report-to-err')
    expect(toPicker().getAttribute('aria-describedby')).toBe('cust-report-to-err')
    expect(mockReads.pos_orders).toBeUndefined()
    expect(screen.queryByText('Building report…')).toBeNull()
    expect(screen.queryByText(/No dish with choices/)).toBeNull()
    expect(screen.queryByText('Could not load this report')).toBeNull()
  })

  test('on a phone the custom dates and Export fold behind one toggle, and nothing unmounts', async () => {
    renderPage()
    const toggle = screen.getByRole('button', { name: 'Dates and export' })
    const fold = document.getElementById(toggle.getAttribute('aria-controls'))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(fold.className).toBe('phone-fold')
    expect(fold.contains(fromPicker())).toBe(true)
    expect(fold.contains(toPicker())).toBe(true)
    expect(within(fold).getByRole('button', { name: 'Export Excel' })).toBeTruthy()
    // The presets are what the page is for, so they stay outside the fold.
    expect(fold.contains(screen.getByRole('group', { name: 'Date range' }))).toBe(false)
    const from = fromPicker()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toBe('Hide dates and export')
    expect(fold.className).toBe('phone-fold phone-fold--open')
    expect(fromPicker()).toBe(from)
    expect(await screen.findByText(/No dish with choices and no combo was sold/)).toBeTruthy()
  })

  test('Export says why it cannot run, instead of sitting disabled', async () => {
    mockRange = { from: '2025-09-10', to: '2025-09-01' }
    renderPage()
    const button = screen.getByRole('button', { name: 'Export Excel' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(await screen.findByText('The To date is before the From date, so there is nothing to export.')).toBeTruthy()
  })
})

describe('per-plate margin', () => {
  test('each figure to the paisa, and Margin is Charged minus Cost as shown', () => {
    const f = perPlateFigures({ chargedPerPick: 47.504, costPerPick: 30.494 })
    expect(f).toEqual({ charged: 47.5, cost: 30.49, margin: 17.01, loss: false })
    expect(signed2(f.charged)).toBe('+NPR 47.50')
    expect(signed2(f.margin)).toBe('+NPR 17.01')
    // The property, over awkward values: the three shown figures always reconcile.
    for (const [c, k] of [[47.505, 30.495], [10.005, 9.994], [0.125, 0.135], [99.999, 0.001], [3.333, 6.667]]) {
      const g = perPlateFigures({ chargedPerPick: c, costPerPick: k })
      expect(Math.round((g.charged - g.cost) * 100)).toBe(Math.round(g.margin * 100))
    }
  })

  test('the loss is the shown figure: −0.30 is a loss, −0.003 (shown NPR 0.00) is not', () => {
    const small = perPlateFigures({ chargedPerPick: 30, costPerPick: 30.3 })
    expect(small.loss).toBe(true)
    expect(signed2(small.margin)).toBe('−NPR 0.30')
    const noise = perPlateFigures({ chargedPerPick: 30, costPerPick: 30.003 })
    expect(noise.loss).toBe(false)
    expect(signed2(noise.margin)).toBe('NPR 0.00')
    expect(perPlateFigures({ chargedPerPick: 30, costPerPick: null })).toEqual({ charged: 30, cost: null, margin: null, loss: false })
  })

  test('a free or below-the-dish size is not a verdict; a cheaper non-size choice still is', () => {
    expect(marginBasis({ freeByDesign: true })).toBe('free')
    expect(marginBasis({ listPriceDelta: null, chargedPerPick: 0 })).toBe('free')
    expect(marginBasis({ group_kind: 'size', listPriceDelta: -100, chargedPerPick: -100 })).toBe('sizeBelow')
    expect(marginBasis({ group_kind: 'choice', listPriceDelta: -30, chargedPerPick: -30 })).toBeNull()
  })

  test('the Choice margin tab shows the three columns to the paisa, red with ▼ only on a shown loss', async () => {
    mockAuth.clientModules = { ims: true }
    mockRates.i1 = 30.494
    mockRates.i2 = 30.3
    mockRates.i3 = 30.003
    mockAnswers.pos_orders = { data: [{ id: 'o1', closed_at: '2025-09-05T06:00:00Z' }], error: null }
    mockAnswers.pos_order_items = { data: [{ id: 'l1', order_id: 'o1', recipe_id: 'r1', name: 'Momo', qty: 1, comped: false, selection_key: 'op1+op2+op3' }], error: null }
    const pick = (id, name, price, item) => ({
      id: `s-${id}`, order_item_id: 'l1', option_id: id, group_name: 'Extras', group_kind: 'addon', option_name: name,
      is_removal: false, price_delta: price, list_price_delta: price, included: false, ingredient_deltas: [{ item_id: item, qty: 1 }],
    })
    mockAnswers.pos_order_item_options = { data: [pick('op1', 'Cheese', 47.504, 'i1'), pick('op2', 'Egg', 30, 'i2'), pick('op3', 'Tofu', 30, 'i3')], error: null }
    renderPage()
    fireEvent.click(await screen.findByRole('tab', { name: 'Choice margin' }))
    const table = screen.getByRole('table')
    const rowOf = name => within(table).getByText(name).closest('tr')
    const cells = name => within(rowOf(name)).getAllByRole('cell').map(c => c.textContent)
    expect(cells('Cheese').slice(1, 4)).toEqual(['+NPR 47.50', 'NPR 30.49', '+NPR 17.01'])
    const eggMargin = within(rowOf('Egg')).getAllByRole('cell')[3]
    // jsdom drops a `var()` colour, so the verdict is read off its shape: ▼ on a shown loss only.
    expect(eggMargin.textContent).toBe('−NPR 0.30 ▼')
    const tofuMargin = within(rowOf('Tofu')).getAllByRole('cell')[3]
    expect(tofuMargin.textContent).toBe('NPR 0.00')
  })
})

describe('with no client chosen (the Crest admin view)', () => {
  test('says to pick a client instead of loading for ever, reads nothing, and offers no range or export', async () => {
    mockAuth.clientId = null
    renderPage()
    expect(await screen.findByText('No client selected. Pick a client in the top-left switcher to see its Customization Report.')).toBeTruthy()
    expect(screen.queryByText('Building report…')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export Excel' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Date range' })).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(mockReads.pos_orders).toBeUndefined()
  })
})

describe('counts and the phone layout', () => {
  test('a count of plates agrees with its noun', () => {
    expect(platesText(1)).toBe('1 plate')
    expect(platesText(0)).toBe('0 plates')
    expect(platesText(2)).toBe('2 plates')
    expect(platesText(1240)).toBe('1,240 plates')
  })

  test('one plate reads "1 plate" on every tile, two across on a phone', async () => {
    answerOnePlate()
    renderPage()
    await screen.findByRole('table')
    // With a choice picked, Most added (Cheese) and Most removed (No onion): one plate each.
    expect(screen.getAllByText('1 plate')).toHaveLength(3)
    expect(screen.queryByText(/\b1 plates\b/)).toBeNull()
    expect(document.querySelector('.stat-grid').className).toBe('stat-grid stat-grid--pair')
  })

  test('Popular fits a phone: the group rides under the name, its column hides, long headings may wrap', async () => {
    answerOnePlate()
    renderPage()
    const table = await screen.findByRole('table')
    expect(within(table).getByRole('columnheader', { name: /Group/ }).className).toBe('phone-hide')
    const [sub, cell] = within(table).getAllByText('Extras')
    expect(sub.closest('.phone-only')).toBeTruthy()
    expect(cell.className).toBe('phone-hide')
    expect(within(table).getByRole('columnheader', { name: /Times picked/ }).style.whiteSpace).toBe('normal')
    expect(within(table).getByRole('columnheader', { name: 'Picked on' }).style.whiteSpace).toBe('normal')
  })
})

describe('the scope is BS first', () => {
  const ad = (y, m, d) => formatAd(bsToAd(y, m, d))
  test('the chip, the scope line and the filename name BS dates', () => {
    const from = ad(2082, 5, 1)
    const to = ad(2082, 5, 31)
    expect(bsRangeLabel(from, to)).toBe('Bhadra 2082')
    expect(bsRangeLabel(ad(2082, 5, 5), ad(2082, 6, 20))).toBe('5 Bhadra – 20 Ashwin 2082')
    expect(scopeLineOf(from, to)).toMatch(new RegExp(`^Paid bills closed 1 Bhadra 2082 to 31 Bhadra 2082 \\(AD ${from} to ${to}\\)`))
    expect(bsFileDate(from)).toBe('2082-05-01')
  })

  test('the trend names a week-ending day in BS, not as a slash date', () => {
    expect(weekTick(ad(2083, 7, 17))).toBe('17th Kartik')
    expect(weekTick(ad(2082, 5, 1))).toBe('1st Bhadra')
    expect(weekTick('1900-01-01')).toBe('1900-01-01 (AD)')
  })

  test('rangeProblem refuses only a backwards range', () => {
    expect(rangeProblem('2025-09-01', '2025-09-01')).toBeNull()
    expect(rangeProblem('2025-09-01', '2025-09-10')).toBeNull()
    expect(rangeProblem('2025-09-10', '2025-09-01')).toMatch(/before the From date/)
  })
})

test('every tab points at a panel that exists, and print names the view', async () => {
  mockAnswers.pos_orders = { data: [{ id: 'o1', closed_at: '2025-09-05T06:00:00Z' }], error: null }
  mockAnswers.pos_order_items = { data: [{ id: 'l1', order_id: 'o1', recipe_id: 'r1', name: 'Momo', qty: 2, comped: false, selection_key: 'op1' }], error: null }
  mockAnswers.pos_order_item_options = { data: [{
    id: 's1', order_item_id: 'l1', option_id: 'op1', group_name: 'Extras', group_kind: 'addon', option_name: 'Cheese',
    is_removal: false, price_delta: 50, list_price_delta: 50, included: false, ingredient_deltas: null,
  }], error: null }
  renderPage()
  const tabs = await screen.findAllByRole('tab')
  expect(tabs.map(t => t.textContent)).toEqual(['Popular choices', 'How often customized', '"No …" requests', 'Combos'])
  for (const t of tabs) {
    const panel = document.getElementById(t.getAttribute('aria-controls'))
    expect(panel).toBeTruthy()
    expect(panel.getAttribute('role')).toBe('tabpanel')
  }
  expect(screen.getByRole('tablist').className).toMatch(/no-print/)
  expect(screen.getByText(/^Showing Popular choices · Paid bills closed/).className).toMatch(/print-only/)
  fireEvent.click(screen.getByRole('tab', { name: 'Combos' }))
  expect(await screen.findByText(/^Showing Combos · /)).toBeTruthy()
})

// S869 (poor connections): the page asks for the attachments once, through the catalog it already
// reads, and, with IMS, the recipe book for today's choices beside the bills, so the Margin tab's
// costing needs no wait of its own after the bill lines.
describe('the reads', () => {
  test('the attachments are read once, through the catalog', async () => {
    answerOnePlate()
    renderPage()
    expect(await screen.findByRole('tab', { name: 'Popular choices' })).toBeTruthy()
    await waitFor(() => expect(mockReads.pos_order_items).toBe(1))
    expect(mockReads.pos_recipe_option_groups).toBe(1)
  })

  test('with IMS, the choices\' recipe book is asked for before the bill lines answer, and the costing gets it', async () => {
    mockAuth.clientModules = { ims: true }
    answerOnePlate()
    mockAnswers.pos_option_ingredients = { data: [{ id: 'x1', item_id: 'i1', sub_recipe_id: null }], error: null }
    const lines = mockAnswers.pos_order_items
    let releaseLines
    mockAnswers.pos_order_items = () => new Promise(res => { releaseLines = res })
    mockAnswers.pos_order_item_options = {
      data: [{ id: 's1', order_item_id: 'l1', option_id: 'op1', group_name: 'Extras', group_kind: 'addon', option_name: 'Cheese',
        is_removal: false, price_delta: 50, list_price_delta: 50, included: false, ingredient_deltas: [{ item_id: 'i1', qty: 1 }] }],
      error: null,
    }
    renderPage()
    await waitFor(() => expect(typeof releaseLines).toBe('function'))
    await waitFor(() => expect(mockBookCalls.length).toBe(1))
    expect(mockBookCalls[0][2]).toEqual({ recipeIds: [], itemIds: ['i1'] })
    expect(mockCostingCalls.length).toBe(0)
    releaseLines(lines)
    await waitFor(() => expect(mockCostingCalls.length).toBe(1))
    expect(mockCostingCalls[0][3]).toEqual({ book: mockBook })
  })

  test('without IMS, no recipe book is asked for', async () => {
    answerOnePlate()
    renderPage()
    expect(await screen.findByRole('tab', { name: 'Popular choices' })).toBeTruthy()
    await waitFor(() => expect(mockReads.pos_order_items).toBe(1))
    expect(mockBookCalls.length).toBe(0)
    expect(mockReads.pos_option_ingredients).toBeUndefined()
  })

  // S876 (PERF-13): each page of bills starts its lines and choices as it lands, and no bill is read
  // twice, which would count its plates twice.
  test('each page of bills starts its own lines before the last page lands, and every bill is read once', async () => {
    const bill = (id, day) => ({ id, closed_at: `2025-09-0${day}T06:00:00Z` })
    const line = (id, order) => ({ id, order_id: order, recipe_id: 'r1', name: 'Momo', qty: 1, comped: false, selection_key: 'op1' })
    const pick = (id, lineId) => ({
      id, order_item_id: lineId, option_id: 'op1', group_name: 'Extras', group_kind: 'addon', option_name: 'Cheese',
      is_removal: false, price_delta: 50, list_price_delta: 50, included: false, ingredient_deltas: null,
    })
    // Each read answers for the bills it was asked for, in the order asked: o1, then o2, then o3.
    const lineAnswers = [[line('l1', 'o1')], [line('l2', 'o2')], [line('l3', 'o3')]]
    const pickAnswers = [[pick('s1', 'l1')], [pick('s2', 'l2')], [pick('s3', 'l3')]]
    mockAnswers.pos_order_items = () => ({ data: lineAnswers.shift() || [], error: null })
    mockAnswers.pos_order_item_options = () => ({ data: pickAnswers.shift() || [], error: null })
    let releaseLastPage
    mockParallel = async (makeQuery, { onPage }) => {
      onPage([bill('o1', 5)])
      await new Promise(res => { releaseLastPage = res })
      // The last page repeats a bill a page already started (rows moved): it is not read again.
      onPage([bill('o1', 5), bill('o2', 6)])
      return { data: [bill('o1', 5), bill('o2', 6), bill('o3', 7)], error: null }
    }
    renderPage()
    await waitFor(() => expect(mockReads.pos_order_items).toBe(1))
    expect(mockReads.pos_order_item_options).toBe(1)
    expect(mockChunkIds).toEqual([['o1'], ['o1']])
    expect(screen.getByText('Building report…')).toBeTruthy()
    releaseLastPage()
    expect(await screen.findByRole('tab', { name: 'Popular choices' })).toBeTruthy()
    // The second page started o2; the final list's o3, which no page handed over, came after it.
    expect(mockChunkIds).toEqual([['o1'], ['o1'], ['o2'], ['o2'], ['o3'], ['o3']])
    expect(mockReads.pos_order_items).toBe(3)
    const table = screen.getByRole('table')
    const cheese = within(table).getByText('Cheese').closest('tr')
    // Three bills, three plates of Cheese: each counted once.
    expect(within(cheese).getAllByRole('cell').map(c => c.textContent)).toContain('3')
  })

  test('a failed batch of lines fails the report, never a report short of its plates', async () => {
    answerOnePlate()
    mockAnswers.pos_order_item_options = { data: null, error: { message: 'connection reset', code: '08006' } }
    renderPage()
    expect(await screen.findByText('Could not load this report')).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'Popular choices' })).toBeNull()
  })
})
