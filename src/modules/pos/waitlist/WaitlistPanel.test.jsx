/**
 * The waitlist panel on the floor (S854), driven by a stand-in for useWaitlist's result: rows
 * oldest first, the amber overdue row (marked in words and a data attribute, never colour alone),
 * Seat handing the entry to the floor, the Add form refusing a blank name and sending a draft with
 * its own id, the told mark from WhatsApp, Cancel asking first, and a failed first read never
 * reading as "nobody is waiting".
 */
import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import WaitlistPanel from './WaitlistPanel'

// The hook file imports the scoped db (and through it the auth context); the panel only uses its clock.
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => ({ clientId: 'c1' }) }))
let mockUuid = 0
jest.mock('../../../utils/uuid', () => ({ randomUUID: () => `draft-${++mockUuid}` }))

const ago = min => new Date(Date.now() - min * 60000).toISOString()

const OVERDUE = { id: 'w1', customer_name: 'Gurung', phone: '9841234567', party_size: 4, quoted_minutes: 30, status: 'waiting', created_at: ago(35) }
const TOLD = { id: 'w2', customer_name: 'Tamang', phone: null, party_size: 2, quoted_minutes: 20, status: 'notified', notified_at: ago(1), created_at: ago(5) }

function makeWaitlist(over = {}) {
  return {
    entries: [TOLD, OVERDUE],
    liveCount: 2,
    loading: false,
    loaded: true,
    error: null,
    refresh: jest.fn(),
    add: jest.fn(async draft => ({ error: null, row: { id: 'new', customer_name: draft.name, status: 'waiting' } })),
    notify: jest.fn(async () => ({ error: null, count: 1, row: null })),
    markLeft: jest.fn(async () => ({ error: null, count: 1, row: null })),
    cancel: jest.fn(async () => ({ error: null, count: 1, row: null })),
    markSeated: jest.fn(),
    ...over,
  }
}

function renderPanel(props = {}) {
  const waitlist = props.waitlist || makeWaitlist()
  const onSeat = props.onSeat || jest.fn()
  render(<WaitlistPanel waitlist={waitlist} onClose={jest.fn()} onSeat={onSeat} outletName="Bloom Cafe" />)
  return { waitlist, onSeat }
}

beforeEach(() => { mockUuid = 0 })

test('lists the parties oldest first, and marks the one past its quote', () => {
  renderPanel()
  const rows = screen.getAllByRole('listitem')
  expect(rows).toHaveLength(2)
  expect(rows[0]).toHaveTextContent('Gurung ×4')
  expect(rows[0]).toHaveTextContent('Waited 35 of 30 min, 5 over')
  expect(rows[0]).toHaveAttribute('data-overdue', 'true')
  expect(rows[0]).toHaveTextContent('9841234567')
  expect(rows[1]).toHaveTextContent('Tamang ×2')
  expect(rows[1]).toHaveTextContent('Waited 5 of 20 min')
  expect(rows[1]).not.toHaveTextContent('over')
  expect(rows[1]).not.toHaveAttribute('data-overdue')
  expect(rows[1]).toHaveTextContent(/Told at/)
  expect(screen.getByRole('heading', { name: 'Waiting now (2)' })).toBeInTheDocument()
})

test('a party with no phone offers no WhatsApp or Call, and still has Seat', () => {
  renderPanel()
  const told = screen.getAllByRole('listitem')[1]
  expect(within(told).queryByRole('button', { name: /WhatsApp/ })).toBeNull()
  expect(within(told).queryByRole('link', { name: /Call/ })).toBeNull()
  expect(within(told).getByRole('button', { name: 'Seat Tamang' })).toBeInTheDocument()
})

test('Seat hands the entry to the floor', () => {
  const { onSeat } = renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'Seat Gurung' }))
  expect(onSeat).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1', party_size: 4, customer_name: 'Gurung' }))
})

test('Add refuses a blank name and sends nothing', () => {
  const { waitlist } = renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'Add to waitlist' }))
  expect(screen.getByText('Enter the name the party will answer to.')).toBeInTheDocument()
  expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true')
  expect(waitlist.add).not.toHaveBeenCalled()
})

test('Add sends the party with the picked wait and its own draft id, then clears the form', async () => {
  const { waitlist } = renderPanel()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Rai  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'One person more' }))
  fireEvent.click(screen.getByRole('radio', { name: '45 min' }))
  expect(screen.getByRole('radio', { name: '45 min' })).toHaveAttribute('aria-checked', 'true')
  fireEvent.click(screen.getByRole('button', { name: 'Add to waitlist' }))
  await waitFor(() => expect(waitlist.add).toHaveBeenCalledTimes(1))
  expect(waitlist.add).toHaveBeenCalledWith(
    { name: '  Rai  ', phone: '', partySize: 3, quotedMinutes: 45 },
    { id: 'draft-1' }
  )
  expect(await screen.findByText('Rai ×3 added, quoted 45 min.')).toBeInTheDocument()
  expect(screen.getByLabelText('Name')).toHaveValue('')
})

test('a refused Add keeps what was typed and says the party is not on the list yet', async () => {
  const waitlist = makeWaitlist({ add: jest.fn(async () => ({ error: { code: '42501', message: 'pos_waitlist_rank' } })) })
  renderPanel({ waitlist })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rai' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add to waitlist' }))
  expect(await screen.findByText(/Rai is not on the list yet/)).toBeInTheDocument()
  expect(screen.getByLabelText('Name')).toHaveValue('Rai')
})

test('WhatsApp opens the table-ready message and marks the party as told', async () => {
  const open = jest.spyOn(window, 'open').mockImplementation(() => null)
  const { waitlist } = renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'WhatsApp Gurung' }))
  expect(open).toHaveBeenCalledTimes(1)
  const url = open.mock.calls[0][0]
  expect(url).toContain('https://wa.me/9779841234567')
  expect(decodeURIComponent(url)).toContain('Hello Gurung, your table at Bloom Cafe is ready.')
  await waitFor(() => expect(waitlist.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1' })))
  open.mockRestore()
})

test('Cancel asks first, and only the confirm cancels the entry', async () => {
  const { waitlist } = renderPanel()
  fireEvent.click(screen.getByRole('button', { name: 'More for Gurung' }))
  fireEvent.click(screen.getByRole('menuitem', { name: /Cancel entry/ }))
  expect(waitlist.cancel).not.toHaveBeenCalled()
  const dialog = await screen.findByRole('dialog', { name: /Cancel Gurung/ })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel entry' }))
  await waitFor(() => expect(waitlist.cancel).toHaveBeenCalledWith(expect.objectContaining({ id: 'w1' })))
  expect(await screen.findByText('Gurung ×4 taken off the list.')).toBeInTheDocument()
})

test('a failed first read is never shown as an empty list', () => {
  renderPanel({ waitlist: makeWaitlist({ entries: [], loaded: false, error: { message: 'TypeError: Failed to fetch' } }) })
  expect(screen.getByText(/Could not load the waitlist/)).toBeInTheDocument()
  expect(screen.queryByText(/Nobody is waiting/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
})

test('an empty list says what the list is for', () => {
  renderPanel({ waitlist: makeWaitlist({ entries: [] }) })
  expect(screen.getByText(/Nobody is waiting/)).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Waiting now (0)' })).toBeInTheDocument()
})
