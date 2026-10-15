/**
 * The Sales Report's Bill Register (S842): a page of rows at a time over the whole range's TOTAL,
 * three sticky anchors, and a payment filter cleared by a named button.
 */
import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'

let mockAnswers = {}
function mockBuilder(table) {
  const b = {}
  for (const op of ['select', 'eq', 'neq', 'in', 'gte', 'lte', 'order', 'limit', 'not', 'or', 'range', 'single', 'maybeSingle']) {
    b[op] = () => b
  }
  b.then = (ok, fail) => Promise.resolve(mockAnswers[table] || { data: [], error: null }).then(ok, fail)
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

// eslint-disable-next-line import/first
import SalesReport from './SalesReport'

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

async function openRegister() {
  render(<SalesReport />)
  fireEvent.click(await screen.findByRole('tab', { name: 'Bill Register' }))
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
  fireEvent.click(await screen.findByRole('tab', { name: 'Payment Summary' }))
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
  fireEvent.click(await screen.findByRole('tab', { name: 'Delivery Partners' }))
  await screen.findByText('Part paid · NPR 500 owed')
  const outstanding = [...container.querySelectorAll('.stat-card')].find(c => c.textContent.startsWith('Outstanding'))
  // 1,130 − 600 received − 30 commission = 500 still owed on p1, and all of p2's 500.
  expect(outstanding.querySelector('.stat-value').textContent).toBe('NPR 1,000')
})
