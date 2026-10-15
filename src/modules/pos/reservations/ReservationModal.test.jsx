/**
 * The booking form (S842): the phone lookup's answer arrives after the field is left, so it sits in one
 * status region that is announced when it lands; and a form that differs from how it opened tells the
 * dialog so, which keeps a stray backdrop tap from throwing the typing away.
 */

import { render, screen, fireEvent } from '@testing-library/react'
import ReservationModal from './ReservationModal'
import { DEFAULT_RESERVATION_SETTINGS } from './reservationSettings'

// Each read answers by table and select. jest.mock factories may only reach variables named mock*.
const mockAnswers = {
  'pos_customers:id, name': { data: [{ id: 'c1', name: 'Gurung' }], error: null },
  'pos_orders:id': { data: null, count: 3, error: null },
  'pos_orders:paid_amount': { data: [{ paid_amount: 1200 }], error: null },
  'pos_reservations:id': { data: null, count: 1, error: null },
}
function mockBuilder(key) {
  const b = {}
  for (const op of ['eq', 'in', 'is', 'limit', 'order', 'gte', 'lt']) b[op] = () => b
  b.then = (ok, bad) => Promise.resolve(mockAnswers[key] || { data: [], error: null }).then(ok, bad)
  return b
}
const mockDb = {
  clientId: 'c1',
  scopedFrom: (table, select) => mockBuilder(`${table}:${select}`),
  scopedInsert: () => mockBuilder('insert'),
  scopedUpdate: () => mockBuilder('update'),
  scopedDelete: () => mockBuilder('delete'),
}
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockDb }))
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'me' } }) }))

const backdrop = () => screen.getByRole('dialog').parentElement // eslint-disable-line testing-library/no-node-access

function open(onClose = jest.fn()) {
  render(<ReservationModal row={null} tables={[]} settings={DEFAULT_RESERVATION_SETTINGS} dayIso="2026-10-15" onClose={onClose} onSaved={jest.fn()} />)
  return onClose
}

test('the phone lookup lands in a status region: visits, what is owed and the no-shows', async () => {
  open()
  const phone = screen.getByLabelText(/^Phone/)
  fireEvent.change(phone, { target: { value: '9841234567' } })
  fireEvent.blur(phone)
  const status = await screen.findByRole('status')
  expect(await screen.findByText('3 visits')).toBeInTheDocument()
  expect(status).toHaveTextContent('Owes NPR 1,200')
  expect(status).toHaveTextContent('1 no-show')
  // The known name is filled in for a blank name box, as before.
  expect(screen.getByLabelText('Guest name')).toHaveValue('Gurung')
})

test('an untouched form closes on a backdrop click', () => {
  const onClose = open()
  fireEvent.click(backdrop())
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('typed input or a changed field keeps the dialog open through a backdrop click; Escape still closes', () => {
  const onClose = open()
  fireEvent.change(screen.getByLabelText('Guest name'), { target: { value: 'Sharma' } })
  fireEvent.click(backdrop())
  expect(onClose).not.toHaveBeenCalled()
  // Back to how it opened: the backdrop closes again.
  fireEvent.change(screen.getByLabelText('Guest name'), { target: { value: '' } })
  fireEvent.click(backdrop())
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('a changed select counts as unsaved input too', () => {
  const onClose = open()
  fireEvent.change(screen.getByLabelText('Occasion'), { target: { value: 'Birthday' } })
  fireEvent.click(backdrop())
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})
