import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// S847 (/impeccable optimize: POS slow on a poor connection). The dashboard's figures used to wait for
// a second round trip: today's bill lines and Split legs were chunked .in() reads started after the
// bills landed. They ride in today's bill and credit-note reads now, so nothing reads either table on
// its own — and Top 5 and the payment mix still come out of the embedded rows.

const mockCalls = []
let mockRespond = () => ({ data: [], error: null })
function mockBuilder(table, cols) {
  const calls = [['select', [cols]]]
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (ok, bad) => {
          mockCalls.push({ table, cols: String(cols || ''), calls })
          return Promise.resolve(mockRespond(table, String(cols || ''), calls)).then(ok, bad)
        }
      }
      return (...args) => { calls.push([prop, args]); return proxy }
    },
  })
  return proxy
}

jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({ scopedFrom: (table, cols) => mockBuilder(table, cols) }),
}))
// The outlet's VAT registration (settings, raw supabase.from) rides in the floor reads.
jest.mock('../../../supabaseClient', () => ({
  supabase: { from: table => ({ select: cols => mockBuilder(table, cols) }) },
}))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({
    hasPosAccess: () => true, profile: { id: 'p1', clients: { name: 'Test Outlet' } }, isAdmin: false,
    adminViewClientName: null, clientId: 'c1',
  }),
}))
// The month table and the occasions card make their own reads; this test is about the page's.
jest.mock('../../dashboard/SalesPivot', () => () => null)
jest.mock('./OccasionsCard', () => ({ __esModule: true, default: () => null, useUpcomingOccasions: () => ({ loading: false, rows: [] }) }))
jest.mock('../../../components/ChartCard', () => () => null)

// eslint-disable-next-line import/first
import PosDashboard from './PosDashboard'

const LEG = (id, method, amount) => ({ id, payment_method: method, amount })
const TODAY_BILLS = [
  { id: 'o1', covers: 2, paid_amount: 500, discount_amount: 0, payment_method: 'Cash', table_id: 't1', part_of_order_id: null,
    delivery_partner: null, credit_note_id: null, close_type: 'paid', closed_at: new Date().toISOString(),
    pos_order_items: [{ id: 'i2', recipe_id: 'r1', name: 'Steam Momo', qty: 2, comped: false }], pos_order_payments: [] },
  { id: 'o2', covers: 1, paid_amount: 300, discount_amount: 0, payment_method: 'Split', table_id: 't2', part_of_order_id: null,
    delivery_partner: null, credit_note_id: null, close_type: 'paid', closed_at: new Date().toISOString(),
    pos_order_items: [{ id: 'i1', recipe_id: 'r1', name: 'Steam Momo', qty: 1, comped: false }, { id: 'i3', recipe_id: 'r2', name: 'Chowmein', qty: 1, comped: false }],
    pos_order_payments: [LEG('l2', 'Card', 100), LEG('l1', 'Cash', 200)] },
]

beforeEach(() => {
  mockCalls.length = 0
  mockRespond = (table, cols, calls) => {
    const did = m => calls.some(([name]) => name === m)
    if (table === 'pos_orders' && cols.includes('close_type') && cols.includes('pos_order_items(')) return { data: TODAY_BILLS, error: null }
    if (did('maybeSingle')) return { data: null, error: null }
    return { data: [], error: null }
  }
})

test("today's lines and Split legs come with the bills, in one round trip", async () => {
  render(<MemoryRouter><PosDashboard /></MemoryRouter>)
  // Top 5 is built from the embedded lines: 3 Steam Momo across the two bills.
  await screen.findByText('Steam Momo', {}, { timeout: 4000 })
  await waitFor(() => expect(mockCalls.some(c => c.table === 'pos_orders' && c.cols.includes('pos_order_items('))).toBe(true))
  expect(mockCalls.filter(c => c.table === 'pos_order_items' || c.table === 'pos_order_payments')).toEqual([])
  const today = mockCalls.find(c => c.table === 'pos_orders' && c.cols.includes('close_type') && c.cols.includes('pos_order_items('))
  expect(today.cols).toContain('pos_order_payments!pos_order_payments_order_id_fkey(')
  const notes = mockCalls.filter(c => c.table === 'pos_credit_notes')
  expect(notes.some(c => c.cols.includes('pos_order_payments!pos_order_payments_order_id_fkey('))).toBe(true)
  // Last week's bills carry neither: nothing on the page reads their lines or legs.
  const lastWeek = mockCalls.filter(c => c.table === 'pos_orders' && c.cols.includes('close_type') && !c.cols.includes('pos_order_items('))
  expect(lastWeek.length).toBeGreaterThan(0)
  // The open bills carry each line's VAT and comp mark, and the VAT setting comes in the same wave.
  const open = mockCalls.find(c => c.table === 'pos_orders' && !c.cols.includes('close_type'))
  expect(open.cols).toContain('pos_order_items(qty, unit_price, vat_rate, comped)')
  expect(mockCalls.some(c => c.table === 'settings' && c.cols === 'is_vat_registered')).toBe(true)
})
