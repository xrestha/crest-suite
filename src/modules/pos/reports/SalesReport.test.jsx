/**
 * The Sales Report's Bill Register (S842): a page of rows at a time over the whole range's TOTAL,
 * three sticky anchors, and a payment filter cleared by a named button.
 */
/* Node access is deliberate here: a role query walks every node of a 200-row register and its 200
   phone cards, which put these tests past Jest's timeout, and a card's parts are classes, not roles. */
/* eslint-disable testing-library/no-node-access, testing-library/no-container */
import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { nepalBs, nepalTime } from '../../../shared/nepalTime'
import { BS_MONTHS } from '../../../utils/bsCalendar'

let mockAnswers = {}
// An answer keyed `table:column` (a column the query filtered with .eq) wins over the table's own,
// so one read of a table can be told apart from another (the Egg marks, S846).
function mockBuilder(table) {
  const b = {}
  const eqs = []
  for (const op of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'limit', 'not', 'or', 'range', 'single', 'maybeSingle']) {
    b[op] = () => b
  }
  b.eq = col => { eqs.push(col); return b }
  b.then = (ok, fail) => Promise.resolve(
    eqs.map(c => mockAnswers[`${table}:${c}`]).find(Boolean) || mockAnswers[table] || { data: [], error: null },
  ).then(ok, fail)
  return b
}
const mockScopedDb = { scopedFrom: table => mockBuilder(table) }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScopedDb }))
jest.mock('../../../shared/fetchAllRows', () => ({
  fetchAllRows: makeQuery => makeQuery(),
  fetchAllRowsChunked: (ids, makeQuery) => (ids.length ? makeQuery(ids) : Promise.resolve({ data: [], error: null })),
}))
jest.mock('../../../supabaseClient', () => ({ supabase: { from: table => mockBuilder(table), rpc: () => mockBuilder('rpc') } }))
const mockAuth = { clientId: 'c1', hasPosAccess: () => true, isAdmin: false, imsEnabled: false, clientModules: {}, customizationEnabled: false }
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../../utils/viewPosBill', () => ({ viewPosBill: jest.fn() }))

// eslint-disable-next-line import/first
import SalesReport, { TAB_GROUPS } from './SalesReport'
// eslint-disable-next-line import/first
import { viewPosBill } from '../../../utils/viewPosBill'

const BILLS = 450
const at = i => new Date(Date.now() - i * 1000).toISOString()
const orders = Array.from({ length: BILLS }, (_, i) => ({
  id: `o${i}`, order_no: i + 1, invoice_no: i + 1, buyer_name: null, buyer_pan: null, buyer_phone: null,
  discount_amount: 0, opened_at: at(i), closed_at: at(i), credit_note_id: null,
  payment_method: i % 2 ? 'Cash' : 'Card', delivery_partner: null, commission_amount: null,
  credit_settled_at: null, credit_settled_method: null, paid_amount: 100, bill_remarks: null,
  closed_by: 'u1', table_name: 'T1', vat_registered: false,
}))
const lines = orders.map(o => ({
  order_id: o.id, recipe_id: 'r1', name: 'Tea', category: 'Beverage', qty: 1, unit_price: 100, vat_rate: 0,
  comped: false, comp_no: null, comp_reason: null, selection_key: null,
}))

beforeEach(() => {
  mockAnswers = {
    pos_orders: { data: orders, error: null },
    pos_order_items: { data: lines, error: null },
    settings: { data: { is_vat_registered: false, pos_bot_categories: null, invoice_prefix: 'CAC' }, error: null },
    clients: { data: { name: 'Test Cafe' }, error: null },
  }
})

// S854: the views sit under four headings, so a view is opened by its heading first. By id, not by
// role, for the reason above: a heading opens its first view, which may be the 200-row register.
const headingTab = key => document.getElementById(`pos-sales-report-section-tab-${key}`)
const viewTab = key => document.getElementById(`pos-sales-report-tab-${key}`)
function openView(heading, view) {
  const g = TAB_GROUPS.find(x => x.label === heading)
  const t = g.tabs.find(x => x.label === view)
  expect(headingTab(g.key).textContent).toBe(heading)
  fireEvent.click(headingTab(g.key))
  expect(viewTab(t.key).textContent).toBe(view)
  fireEvent.click(viewTab(t.key))
}
async function openRegister() {
  render(<SalesReport />)
  openView('Bills & payments', 'Bill Register')
  return screen.findByText(/of 450 rows shown/)
}
// The register is the last table on the page; its row groups are thead, tbody, tfoot.
const groups = () => within(screen.getAllByRole('table').at(-1)).getAllByRole('rowgroup')
const bodyRows = () => within(groups()[1]).getAllByRole('row')

test('the register renders 200 of 450 bills, and its TOTAL still counts all 450', async () => {
  await openRegister()
  expect(bodyRows()).toHaveLength(200)
  expect(screen.getByRole('status').textContent).toMatch(/^200 of 450 rows shown\. The TOTAL row and Excel cover all of them\./)
  const total = groups()[2]
  expect(within(total).getByText('TOTAL')).toBeTruthy()
  expect(within(total).getAllByText('NPR 45,000').length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'Show 200 more' }))
  expect(bodyRows()).toHaveLength(400)
})

test('the header, Voucher# and Net are sticky, corners highest', async () => {
  await openRegister()
  // jsdom drops a `var()` background from the shorthand, so the opaque ground is not read here.
  const pin = el => ({ position: el.style.position, top: el.style.top, left: el.style.left, right: el.style.right, zIndex: el.style.zIndex })
  expect(pin(screen.getByRole('columnheader', { name: 'Voucher#' }))).toEqual({ position: 'sticky', top: '0px', left: '0px', right: '', zIndex: '3' })
  expect(pin(screen.getByRole('columnheader', { name: 'Net' }))).toEqual({ position: 'sticky', top: '0px', left: '', right: '0px', zIndex: '3' })
  expect(pin(screen.getByRole('columnheader', { name: 'Gross' }))).toEqual({ position: 'sticky', top: '0px', left: '', right: '', zIndex: '2' })
  const cells = within(bodyRows()[0]).getAllByRole('cell')
  expect(pin(cells[1])).toEqual({ position: 'sticky', top: '', left: '0px', right: '', zIndex: '1' })
  expect(pin(cells[11])).toEqual({ position: 'sticky', top: '', left: '', right: '0px', zIndex: '1' })
})

test('a payment filter shows and is cleared by a named button, which starts the register at one page again', async () => {
  render(<SalesReport />)
  openView('Bills & payments', 'Payment Summary')
  fireEvent.click(await screen.findByRole('button', { name: 'Cash' }))
  expect(await screen.findByText('Filtered: paid by Cash')).toBeTruthy()
  expect(bodyRows()).toHaveLength(200) // 225 Cash bills
  fireEvent.click(screen.getByRole('button', { name: 'Show all 225' }))
  expect(bodyRows()).toHaveLength(225)

  const clear = screen.getByRole('button', { name: 'Clear payment filter' })
  expect(clear.className).toBe('btn btn-ghost btn-sm btn-icon')
  expect(clear.title).toBe('Clear payment filter')
  fireEvent.click(clear)
  expect(screen.queryByText('Filtered: paid by Cash')).toBeNull()
  expect(bodyRows()).toHaveLength(200)
  expect(screen.getByRole('status').textContent).toMatch(/^200 of 450 rows shown/)
})

// S843: a platform pays a delivery bill off in parts, each part a receipt that may keep a commission.
// The bill stays unsettled until they reach its total, so Outstanding counts what is still owed.
test('a part-paid delivery bill counts only what it still owes in Outstanding, and says so on its row', async () => {
  const partnerBill = (id, n, paid) => ({
    ...orders[0], id, order_no: n, invoice_no: n, payment_method: 'Credit', delivery_partner: 'Foodmandu', paid_amount: paid,
  })
  mockAnswers.pos_orders = { data: [partnerBill('p1', 901, 1130), partnerBill('p2', 902, 500)], error: null }
  mockAnswers.pos_order_items = { data: [
    { ...lines[0], order_id: 'p1', unit_price: 1130 },
    { ...lines[0], order_id: 'p2', unit_price: 500 },
  ], error: null }
  mockAnswers.pos_credit_receipt_lines = { data: [
    { order_id: 'p1', amount: 600, commission: 30, pos_credit_receipts: { method: 'Cash', cancelled_at: null } },
    // A payment cancelled as a mistake puts its amount back on the bill.
    { order_id: 'p1', amount: 100, commission: 0, pos_credit_receipts: { method: 'eSewa', cancelled_at: '2026-10-15T05:00:00Z' } },
  ], error: null }
  const { container } = render(<SalesReport />)
  openView('Bills & payments', 'Delivery Partners')
  await screen.findByText('Part paid · NPR 500 owed')
  const outstanding = [...container.querySelectorAll('.stat-card')].find(c => c.textContent.startsWith('Outstanding'))
  // 1,130 − 600 received − 30 commission = 500 still owed on p1, and all of p2's 500.
  expect(outstanding.querySelector('.stat-value').textContent).toBe('NPR 1,000')
})

// 2026-10-15 audit: the Bill Register's phone cards. Below 600px the cards show and the table hides
// (a CSS switch, so jsdom renders both); they must page, filter and drill exactly as the table does.
// By selector, not by role: a role query walks every node of a 200-row table and 200 cards.
const cards = () => [...document.querySelectorAll('ul.phone-cards[aria-label="Bill Register"] > li.phone-card')]

test('the phone cards take the same 200-row window as the table, and page with it', async () => {
  await openRegister()
  expect(cards()).toHaveLength(200)
  expect(cards()).toHaveLength(bodyRows().length)
  fireEvent.click(screen.getByRole('button', { name: 'Show 200 more' }))
  expect(cards()).toHaveLength(400)
  expect(screen.getByText(/TOTAL of all 450 rows:/).textContent).toBe('TOTAL of all 450 rows: NPR 45,000 net')
})

test('a card shows the voucher, its net as the figure, the date and time, who and how it was paid', async () => {
  await openRegister()
  const first = cards()[0]
  expect(first.querySelector('.phone-card__title').textContent).toBe('#1 · Invoice 1')
  expect(first.querySelector('.phone-card__figure').textContent).toBe('NPR 100')
  const meta = [...first.querySelectorAll('.phone-card__meta')].map(m => m.textContent)
  expect(meta[1]).toBe('CASH SALES · Dine-In: T1 · Card')
  // The BS date the bill was paid, then its opened → paid clock times, as the table's Date/Time cell.
  const bs = nepalBs(orders[0].closed_at)
  const time = nepalTime(orders[0].closed_at)
  expect(meta[0]).toBe(`${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year} · ${time} → ${time}`)
  expect(within(bodyRows()[0]).getAllByRole('cell')[0].textContent).toBe(`${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}${time} → ${time}`)
})

test('a card\'s View bill opens the same bill the row does, and its figures open one tap away', async () => {
  await openRegister()
  viewPosBill.mockClear()
  fireEvent.click(within(cards()[0]).getByRole('button', { name: 'View bill #1' }))
  expect(viewPosBill).toHaveBeenCalledWith('c1', { id: 'o0' })

  const details = cards()[0].querySelector('details')
  expect(details.querySelector('ul')).toBeNull()
  details.open = true
  fireEvent(details, new Event('toggle'))
  expect([...details.querySelectorAll('li')].map(li => li.textContent))
    .toEqual(['GrossNPR 100', 'DiscountNPR 0', 'Non-TaxableNPR 100', 'TaxableNPR 0', 'VATNPR 0', 'Entered by—'])
})

test('the payment filter narrows the cards as it narrows the table', async () => {
  render(<SalesReport />)
  openView('Bills & payments', 'Payment Summary')
  fireEvent.click(await screen.findByRole('button', { name: 'Cash' }))
  await screen.findByText('Filtered: paid by Cash')
  expect(cards()).toHaveLength(200)
  fireEvent.click(screen.getByRole('button', { name: 'Show all 225' }))
  expect(cards()).toHaveLength(225)
  for (const c of cards()) expect(c.textContent).toMatch(/ · Cash/)
})

test('the hourly chart is an h2 under the page h1', async () => {
  render(<SalesReport />)
  openView('Over time', 'Hourly')
  expect(await screen.findByRole('heading', { level: 2, name: 'Net Sales by Hour' })).toBeTruthy()
})

test('the 1L+ TOTAL row fills Taxable and Non-Taxable, as every row does', async () => {
  const party = (id, name, pan) => ({ ...orders[0], id, buyer_name: name, buyer_pan: pan, vat_registered: true })
  mockAnswers.pos_orders = { data: [party('p1', 'Ram Thapa', '111'), party('p2', null, null)], error: null }
  mockAnswers.pos_order_items = { data: [
    { ...lines[0], order_id: 'p1', unit_price: 1000, vat_rate: 0.13 },
    { ...lines[0], order_id: 'p2', unit_price: 500, vat_rate: 0 },
  ], error: null }
  render(<SalesReport />)
  openView('Customers & tax', '1L+ Report')
  await screen.findByText('Ram Thapa')
  const foot = within(screen.getAllByRole('table').at(-1).querySelector('tfoot')).getAllByRole('cell').map(c => c.textContent)
  // TOTAL, Gross, Taxable, Non-Taxable, VAT, Net, Flag
  expect(foot).toEqual(['TOTAL', 'NPR 1,500', 'NPR 1,000', 'NPR 500', 'NPR 130', 'NPR 1,630', ''])
})

// S846: recipes.is_egg adds an Egg row to the Product Type tab's veg axis, read in a fixed order.
describe('Product Type: the veg axis', () => {
  const vegLine = (orderId, recipeId, name, price) => ({
    order_id: orderId, recipe_id: recipeId, name, category: 'Main', qty: 1, unit_price: price, vat_rate: 0,
    comped: false, comp_no: null, comp_reason: null, selection_key: null,
  })
  const RECIPES = [
    { id: 'rV', is_veg: true, is_egg: false, recipe_code: 'V1' },
    { id: 'rE', is_veg: false, is_egg: true, recipe_code: 'E1' },
    { id: 'rN', is_veg: false, is_egg: false, recipe_code: 'N1' },
  ]
  beforeEach(() => {
    // Takings run opposite to the reading order, so a sort by takings would show it.
    mockAnswers.pos_orders = { data: orders.slice(0, 4), error: null }
    mockAnswers.pos_order_items = { data: [
      vegLine('o0', 'rV', 'Dal', 100), vegLine('o1', 'rE', 'Egg curry', 200),
      vegLine('o2', 'rN', 'Chicken', 300), vegLine('o3', 'rX', 'Mystery', 400),
    ], error: null }
    mockAnswers.recipes = { data: RECIPES, error: null }
  })
  const axisRows = () => within(within(screen.getAllByRole('table').at(-1)).getAllByRole('rowgroup')[1])
    .getAllByRole('row').map(r => within(r).getAllByRole('cell')[0].textContent)

  test('reads Veg, Egg, Non-Veg, Not set, in that order', async () => {
    render(<SalesReport />)
    openView('Menu', 'Product Type')
    fireEvent.click(await screen.findByRole('button', { name: 'Veg / Egg / Non-Veg' }))
    expect(axisRows()).toEqual(['Veg', 'Egg', 'Non-Veg', 'Not set'])
  })

  test('a database without is_egg still gives the report, with egg dishes as Non-Veg', async () => {
    mockAnswers['recipes:is_egg'] = { data: null, error: { code: '42703', message: 'column recipes.is_egg does not exist' } }
    render(<SalesReport />)
    openView('Menu', 'Product Type')
    fireEvent.click(await screen.findByRole('button', { name: 'Veg / Non-Veg' }))
    expect(axisRows()).toEqual(['Veg', 'Non-Veg', 'Not set'])
    expect(screen.queryByText(/could not load/i)).toBeNull()
  })
})

// S854 (owner decision): eleven views under four headings. Pick a heading, then one of its views.
describe('Four headings, then their views', () => {
  const tablist = name => document.querySelector(`[role="tablist"][aria-label="${name}"]`)
  const tabNames = name => within(tablist(name)).getAllByRole('tab').map(t => t.textContent)
  const selectedIn = name => within(tablist(name)).getByRole('tab', { selected: true }).textContent

  test('every view sits under exactly one heading, and all eleven are there', () => {
    const keys = TAB_GROUPS.flatMap(g => g.tabs.map(t => t.key))
    expect(new Set(keys).size).toBe(keys.length)
    expect([...keys].sort()).toEqual([
      'category', 'compxref', 'customer', 'daily', 'delivery', 'hourly', 'item', 'onelakh', 'payment', 'producttype', 'voucher',
    ])
    expect(new Set(TAB_GROUPS.map(g => g.key)).size).toBe(TAB_GROUPS.length)
    for (const g of TAB_GROUPS) expect(g.tabs.length).toBeGreaterThan(0)
  })

  test('the heading row shows the four headings, opening on Over time and Daily', async () => {
    render(<SalesReport />)
    expect(tabNames('Sales Report sections')).toEqual(['Over time', 'Bills & payments', 'Menu', 'Customers & tax'])
    expect(selectedIn('Sales Report sections')).toBe('Over time')
    expect(tabNames('Sales Report views: Over time')).toEqual(['Daily', 'Hourly'])
    expect(selectedIn('Sales Report views: Over time')).toBe('Daily')
    // One views row at a time: only the open heading's views are on the page.
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(2)
    // Let the range load land inside the test, so its updates are not reported as stray.
    expect((await screen.findAllByText('NPR 45,000')).length).toBeGreaterThan(0)
  })

  test('choosing a heading shows its views and opens the first; going back opens the one last used', async () => {
    render(<SalesReport />)
    fireEvent.click(headingTab('menu'))
    expect(selectedIn('Sales Report sections')).toBe('Menu')
    expect(tabNames('Sales Report views: Menu')).toEqual(['Category Wise', 'Product Type', 'Item Wise'])
    expect(selectedIn('Sales Report views: Menu')).toBe('Category Wise')
    expect(tablist('Sales Report views: Over time')).toBeNull()

    fireEvent.click(viewTab('item'))
    fireEvent.click(headingTab('customers'))
    expect(tabNames('Sales Report views: Customers & tax')).toEqual(['Customer Wise', '1L+ Report'])
    expect(selectedIn('Sales Report views: Customers & tax')).toBe('Customer Wise')

    fireEvent.click(headingTab('menu'))
    expect(selectedIn('Sales Report views: Menu')).toBe('Item Wise')
    expect((await screen.findAllByText('Tea')).length).toBeGreaterThan(0)
  })

  test('the Payment Summary drill lands on Bill Register under Bills & payments, and is remembered there', async () => {
    render(<SalesReport />)
    openView('Bills & payments', 'Payment Summary')
    fireEvent.click(await screen.findByRole('button', { name: 'Cash' }))
    await screen.findByText('Filtered: paid by Cash')
    expect(selectedIn('Sales Report sections')).toBe('Bills & payments')
    expect(selectedIn('Sales Report views: Bills & payments')).toBe('Bill Register')

    // Pressing the heading already open changes nothing, so the drilled filter stays.
    fireEvent.click(headingTab('bills'))
    expect(screen.getByText('Filtered: paid by Cash')).toBeTruthy()

    // Away and back: the heading reopens Bill Register, the view the drill left it on, unfiltered.
    fireEvent.click(headingTab('time'))
    expect(selectedIn('Sales Report sections')).toBe('Over time')
    fireEvent.click(headingTab('bills'))
    expect(selectedIn('Sales Report views: Bills & payments')).toBe('Bill Register')
    expect(screen.queryByText('Filtered: paid by Cash')).toBeNull()
    expect(screen.getByRole('status').textContent).toMatch(/^200 of 450 rows shown/)
  })
})
