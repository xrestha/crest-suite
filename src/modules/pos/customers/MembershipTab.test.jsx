import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import MembershipTab from './MembershipTab'
import { todayNepalBs } from '../reports/reportRange'
import { bsAddDays } from '../../../utils/bsCalendar'

// S843: Customers → Membership. The birthday list's 7 and 30 day windows with a prefilled WhatsApp
// wish; a failed book read is never "no birthdays"; a type customers hold is switched off (saying
// their discount stops) rather than deleted.
//
// jest.mock factories may only reach variables named mock*; plain functions, not jest.fn.
const mockState = { writes: [], answer: null }
function mockWrite(kind, table, payload) {
  mockState.writes.push({ kind, table, payload })
  const b = {}
  for (const op of ['eq', 'select', 'abortSignal']) b[op] = () => b
  b.then = (ok, bad) => Promise.resolve(mockState.answer).then(ok, bad)
  return b
}
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    clientId: 'c1',
    scopedInsert: (t, row) => Promise.resolve({ data: [{ id: 'new', ...row }], error: null }),
    scopedUpdate: (t, patch) => mockWrite('update', t, patch),
    scopedDelete: t => mockWrite('delete', t),
  }),
}))
jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: () => Promise.resolve({ data: [], error: null }) } }))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: false, profile: { clients: { name: 'Bloom Cafe' } } }),
}))

const AGREED = '2026-10-01T04:00:00+00:00'
const today = todayNepalBs()
const later = bsAddDays(today.year, today.month, today.day, 10)
const ROWS = [
  { id: 'a', name: 'Asha Rai', phone: '9800000001', consent_at: AGREED, birth_month: today.month, birth_day: today.day, birth_calendar: 'BS', membership_type_id: 't1', card_no: 'GOLD-7' },
  { id: 'b', name: 'Bina', phone: '9800000002', consent_at: AGREED, anniv_month: later.month, anniv_day: later.day, anniv_calendar: 'BS' },
  { id: 'c', name: 'Chandra', phone: '9800000003', consent_at: null, birth_month: today.month, birth_day: today.day, birth_calendar: 'BS' },
]
const GOLD = { id: 't1', name: 'Gold', discount_pct: 10, valid_months: 12, is_active: true }

function renderTab({ book = {}, types = [GOLD], canManage = true } = {}) {
  const reloads = []
  render(
    <MembershipTab
      book={{ rows: ROWS, loading: false, error: null, stale: null, ...book }}
      typesState={{ types, byId: Object.fromEntries(types.map(t => [t.id, t])), loading: false, error: null, stale: null, reload: () => reloads.push(1) }}
      canManage={canManage}
      onCustomerSaved={() => {}}
    />,
  )
  return { reloads }
}

beforeEach(() => {
  mockState.writes = []
  mockState.answer = { data: [{ id: 't1' }], error: null }
  jest.spyOn(console, 'error').mockImplementation(() => {})
})

test('the next 7 days, then 30, with a prefilled WhatsApp wish; a customer who has not agreed is never listed', () => {
  renderTab()
  const asha = screen.getByRole('link', { name: 'Send Asha Rai a birthday wish on WhatsApp' })
  expect(asha.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/9779800000001\?text=Happy%20birthday%2C%20Asha!%20Warm%20wishes%20from%20all%20of%20us%20at%20Bloom%20Cafe/)
  expect(screen.queryByRole('link', { name: /Send Bina/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /Send Chandra/ })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Next 30 days' }))
  expect(screen.getByRole('link', { name: 'Send Bina an anniversary wish on WhatsApp' })).toBeInTheDocument()
  expect(screen.getByText('in 10 days')).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /Send Chandra/ })).not.toBeInTheDocument()
})

test('a failed customer book read is a failed read, never "no birthdays"', () => {
  renderTab({ book: { rows: null, error: { message: 'TypeError: Failed to fetch' } } })
  expect(screen.getByText('Could not load this report')).toBeInTheDocument()
  expect(screen.queryByText(/No birthdays or anniversaries/)).not.toBeInTheDocument()
})

// A card type's buttons are on its table row and its phone card (S852); CSS shows one or the other.
// The table comes first; the delete tests press the phone card's copy, so both are proven wired.
const typeTableButton = name => screen.getAllByRole('button', { name })[0]
const typeCard = () => within(screen.getByRole('list', { name: 'Card types' }))

test('switching off a type customers hold says their card discount stops, then switches it off', async () => {
  const { reloads } = renderTab()
  fireEvent.click(typeTableButton('Switch off Gold'))
  const dialog = await screen.findByRole('dialog', { name: 'Switch off Gold?' })
  expect(dialog).toHaveTextContent('The 1 customer who holds one keeps their card, but while it is switched off the till gives them no card discount.')
  expect(mockState.writes).toEqual([])
  fireEvent.click(within(dialog).getByRole('button', { name: 'Switch it off' }))
  await waitFor(() => expect(reloads).toHaveLength(1))
  expect(mockState.writes).toEqual([{ kind: 'update', table: 'pos_membership_types', payload: { is_active: false } }])
  expect(screen.getByText('✓ Gold is switched off.')).toBeInTheDocument()
})

test('deleting a type customers hold offers to switch it off instead, and deletes nothing', async () => {
  renderTab()
  fireEvent.click(typeCard().getByRole('button', { name: 'More for Gold' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Gold cannot be deleted' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Switch it off instead' }))
  await waitFor(() => expect(mockState.writes).toHaveLength(1))
  expect(mockState.writes[0]).toMatchObject({ kind: 'update', payload: { is_active: false } })
})

test('a refused delete names why and offers the switch', async () => {
  mockState.answer = { data: null, error: { code: '23503', hint: 'membership_type_in_use', message: 'membership_type_in_use: customers still hold this membership type' } }
  renderTab({ book: { rows: ROWS.filter(r => r.id !== 'a') } }) // nobody holds it as far as this page knows
  fireEvent.click(typeCard().getByRole('button', { name: 'More for Gold' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
  fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete the Gold card type?' })).getByRole('button', { name: 'Delete card type' }))
  expect(await screen.findByText(/cannot be deleted and nothing was changed/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Switch Gold off instead' })).toBeInTheDocument()
})

test('a supervisor sees the types and the members, and changes neither the types nor the cards', () => {
  renderTab({ canManage: false })
  expect(screen.queryByRole('button', { name: '+ Add card type' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Switch off Gold' })).not.toBeInTheDocument()
  // The table's Edit and the phone card's (S852); CSS shows one or the other.
  expect(screen.getAllByRole('button', { name: 'Edit Asha Rai' })).toHaveLength(2)
})

test('the members list has a phone card per member, from the same rows as the table', () => {
  renderTab()
  const cards = screen.getByRole('list', { name: 'Members' })
  expect(within(cards).getAllByRole('listitem')).toHaveLength(1) // card holders only, as the table
  expect(cards).toHaveTextContent('Asha Rai')
  expect(cards).toHaveTextContent('card GOLD-7')
  expect(within(cards).getByRole('button', { name: 'Edit Asha Rai' })).toBeInTheDocument()
})

test('the card types have a phone card per type, with the same buttons as the table', () => {
  const SILVER = { id: 't2', name: 'Silver', discount_pct: 5, valid_months: null, is_active: false }
  renderTab({ types: [GOLD, SILVER] })
  const cards = screen.getByRole('list', { name: 'Card types' })
  const [gold, silver] = within(cards).getAllByRole('listitem')
  expect(gold).toHaveTextContent('GoldOn')
  expect(gold).toHaveTextContent('10% off · lasts 12 months · 1 holder')
  expect(silver).toHaveTextContent('SilverSwitched off')
  expect(silver).toHaveTextContent('5% off · never expires · 0 holders')
  expect(within(gold).getByRole('button', { name: 'Switch off Gold' })).toBeInTheDocument()
  expect(within(silver).getByRole('button', { name: 'Switch on Silver' })).toBeInTheDocument()
  expect(within(silver).getByRole('button', { name: 'More for Silver' })).toBeInTheDocument()
})

test('a supervisor gets the phone cards without their buttons', () => {
  renderTab({ canManage: false })
  const cards = screen.getByRole('list', { name: 'Card types' })
  expect(within(cards).getAllByRole('listitem')).toHaveLength(1)
  expect(within(cards).queryByRole('button')).not.toBeInTheDocument()
})

test('a deleted card type hands focus to what happened once its row has gone', async () => {
  const props = {
    book: { rows: ROWS.filter(r => r.id !== 'a'), loading: false, error: null, stale: null },
    typesState: { types: [GOLD], byId: { t1: GOLD }, loading: false, error: null, stale: null, reload: () => {} },
    canManage: true,
    onCustomerSaved: () => {},
  }
  const { rerender } = render(<MembershipTab {...props} />)
  const more = typeTableButton('More for Gold')
  more.focus()
  fireEvent.click(more)
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete…' }))
  const dialog = await screen.findByRole('dialog', { name: 'Delete the Gold card type?' })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete card type' }))
  expect(await screen.findByText('✓ Gold deleted.')).toBeInTheDocument()
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  // The list is read again without Gold, and the ⋯ focus went back to leaves with its row.
  rerender(<MembershipTab {...props} typesState={{ ...props.typesState, types: [], byId: {} }} />)
  await waitFor(() => expect(document.activeElement).toHaveTextContent('Gold deleted.')) // eslint-disable-line testing-library/no-node-access
})
