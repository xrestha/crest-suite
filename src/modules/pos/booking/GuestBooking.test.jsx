/**
 * What a screen-reader guest hears about their booking request (S841). The status card used to be
 * its own live region and mounted already holding "Request sent", which screen readers announce
 * unreliably, and the button the guest pressed went with the form, so focus fell to <body>. One
 * region in the page's shell says each stage in the card's own words; focus goes to the card's
 * heading after sending.
 */

import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// Plain functions, not jest.fn: CRA resets mock implementations before every test.
let mockAnswers = {}
jest.mock('../../../supabaseClient', () => ({
  supabase: {
    rpc: name => {
      const a = mockAnswers[name]
      return typeof a === 'function' ? a() : Promise.resolve(a || { data: null, error: null })
    },
  },
}))
jest.mock('../guestmenu/guestDocument', () => ({ useGuestDocumentIdentity: () => {} }))

// eslint-disable-next-line import/first
import GuestBooking from './GuestBooking'

const PAGE = {
  outlet_name: 'TEST CAFE', menu_name: 'Test Cafe', open_time: '10:00', close_time: '22:00',
  min_lead_minutes: 60, max_party_online: 20, total_seats: 0,
}
const SENT = 'Request sent. Test Cafe will confirm shortly. Keep this page open, or come back to it — it updates by itself.'
let mockStatus = null
let mockVisibility = 'visible'

const announcer = () => screen.getAllByRole('status').find(el => el.getAttribute('aria-atomic') === 'true')
const focused = () => document.activeElement // eslint-disable-line testing-library/no-node-access
// Counts the times the region's words are replaced. A re-keyed sentence is said again; an unchanged
// one is not touched at all.
function watchSaid(region) {
  let n = 0
  const count = records => { n += records.filter(r => r.type === 'childList').length }
  const mo = new MutationObserver(count)
  mo.observe(region, { childList: true, subtree: true })
  return () => { count(mo.takeRecords()); return n }
}
const renderPage = () => render(
  <MemoryRouter initialEntries={['/book/c-1']}>
    <Routes><Route path="/book/:clientId" element={<GuestBooking />} /></Routes>
  </MemoryRouter>,
)
// The request polls every 5 s while the page is visible, and once on becoming visible again.
async function pollNow() {
  await act(async () => {
    mockVisibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    mockVisibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
  })
}
// The Day card: where a refused send and Make another booking put focus (it is not a control).
const dayCard = () => screen.getByRole('radiogroup', { name: 'Day' }).closest('.gb-card') // eslint-disable-line testing-library/no-node-access
// The day and time pickers are radiogroups since S842.
function pickTomorrowAt10() {
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Day' })).getAllByRole('radio')[1])
  fireEvent.click(screen.getByRole('radio', { name: '10:00 AM' }))
}
function fillAndSend() {
  pickTomorrowAt10()
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Asha' } })
  fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9841234567' } })
  fireEvent.click(screen.getByRole('button', { name: /Request this table|Sending/ }))
}
const tomorrow10 = () => {
  const d = new Date(Date.now() + 36 * 3600000)
  return `${d.toISOString().slice(0, 10)}T10:00:00+05:45`
}

beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => mockVisibility })
  Element.prototype.scrollIntoView = () => {}
})

beforeEach(() => {
  sessionStorage.clear()
  mockVisibility = 'visible'
  mockStatus = null
  mockAnswers = {
    get_booking_page: { data: [PAGE], error: null },
    get_booking_availability: { data: [], error: null },
    submit_reservation_request: { data: { ok: true, id: 'res-1' }, error: null },
    get_reservation_request_status: () => Promise.resolve({ data: mockStatus ? [mockStatus] : [], error: null }),
  }
})

it('says the request was sent and moves focus to the status heading, not <body>', async () => {
  renderPage()
  const region = announcer()
  expect(region.textContent).toBe('')
  await screen.findByRole('button', { name: 'Request this table' })
  // Tomorrow, so no slot is inside the lead time whatever the hour.
  pickTomorrowAt10()
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Asha' } })
  fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9841234567' } })
  fireEvent.click(screen.getByRole('button', { name: 'Request this table' }))

  await waitFor(() => expect(announcer().textContent).toBe(SENT))
  expect(announcer()).toBe(region)
  expect(focused()).toBe(screen.getByRole('heading', { level: 2, name: 'Request sent' }))
  // The card is no longer a live region of its own, or the same words would be said twice.
  expect(screen.getAllByRole('status')).toHaveLength(1)
})

it('reads a card restored on a reload on the page, then says each change once', async () => {
  sessionStorage.setItem('guestBooking:c-1', JSON.stringify({ id: 'res-9', name: 'Asha', party: 2, reservedFor: tomorrow10() }))
  renderPage()
  expect(await screen.findByRole('heading', { level: 2, name: 'Request sent' })).toBeTruthy()
  expect(await screen.findByText(/Asha/)).toBeTruthy()
  expect(announcer().textContent).toBe('')
  expect(focused()).toBe(document.body)

  mockStatus = { status: 'confirmed', reserved_for: tomorrow10(), party_size: 2, outlet_name: 'TEST CAFE' }
  await pollNow()
  await waitFor(() => expect(announcer().textContent).toBe('Confirmed. Your table is booked. See you soon!'))
  // The ✓ is shown and not read.
  const heading = screen.getByRole('heading', { level: 2, name: 'Confirmed' })
  expect(heading.textContent).toBe('Confirmed ✓')
  const saidAgain = watchSaid(announcer())
  await pollNow()
  expect(saidAgain()).toBe(0)
})

it('says a declined request in the card’s words', async () => {
  sessionStorage.setItem('guestBooking:c-1', JSON.stringify({ id: 'res-9', name: 'Asha', party: 2, reservedFor: tomorrow10() }))
  renderPage()
  await screen.findByRole('heading', { level: 2, name: 'Request sent' })
  mockStatus = { status: 'cancelled', reserved_for: tomorrow10(), party_size: 2, outlet_name: 'TEST CAFE', cancel_reason: 'Fully booked' }
  await pollNow()
  await waitFor(() => expect(announcer().textContent).toBe('Not available. Fully booked. Please call or message Test Cafe for another time.'))
})

// ── S842 ─────────────────────────────────────────────────────────────────────────────────────────
describe('the first read (S842)', () => {
  afterEach(() => { jest.useRealTimers() })

  it('says it is loading, and a stalled read becomes the failed-load card', async () => {
    jest.useFakeTimers()
    mockAnswers.get_booking_page = () => new Promise(() => {})
    renderPage()
    expect(screen.getByText('Loading…')).toHaveAttribute('role', 'status')
    await act(async () => { jest.advanceTimersByTime(20000) })
    expect(screen.getByRole('heading', { level: 1, name: 'We couldn’t load the booking page' })).toBeTruthy()
  })

  it('a failed read offers Try again, which reads again', async () => {
    mockAnswers.get_booking_page = { data: null, error: { message: 'Failed to fetch' } }
    renderPage()
    const retry = await screen.findByRole('button', { name: 'Try again' })
    expect(screen.getByText('Check your internet connection, then try again.')).toBeTruthy()
    mockAnswers.get_booking_page = { data: [PAGE], error: null }
    fireEvent.click(retry)
    expect(await screen.findByRole('button', { name: 'Request this table' })).toBeTruthy()
  })
})

describe('the form (S842)', () => {
  it('the day and the time are each one Tab stop, with arrow keys between them', async () => {
    renderPage()
    await screen.findByRole('button', { name: 'Request this table' })
    const days = within(screen.getByRole('radiogroup', { name: 'Day' })).getAllByRole('radio')
    expect(days).toHaveLength(14)
    expect(days.filter(d => d.tabIndex === 0)).toHaveLength(1)
    days[0].focus()
    fireEvent.keyDown(days[0], { key: 'ArrowRight' })
    expect(focused()).toBe(days[1])

    pickTomorrowAt10()
    const picked = screen.getByRole('radio', { name: '10:00 AM' })
    expect(picked).toHaveAttribute('aria-checked', 'true')
    const times = within(screen.getByRole('radiogroup', { name: 'Time' })).getAllByRole('radio')
    expect(times.filter(t => t.tabIndex === 0)).toEqual([picked])
    expect(within(screen.getByRole('radiogroup', { name: 'Day' })).getAllByRole('radio').filter(d => d.tabIndex === 0))
      .toEqual([within(screen.getByRole('radiogroup', { name: 'Day' })).getAllByRole('radio')[1]])
  })

  it('keeps the button pressable while sending, and a second press sends nothing', async () => {
    let sends = 0
    let answer
    mockAnswers.submit_reservation_request = () => { sends += 1; return new Promise(resolve => { answer = resolve }) }
    renderPage()
    await screen.findByRole('button', { name: 'Request this table' })
    fillAndSend()
    const button = await screen.findByRole('button', { name: 'Sending…' })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    button.focus()
    fireEvent.click(button)
    expect(sends).toBe(1)
    await act(async () => { answer({ data: { ok: true, id: 'res-1' }, error: null }) })
    expect(await screen.findByRole('heading', { level: 2, name: 'Request sent' })).toBeTruthy()
  })

  it('a refused send still says what is missing and moves to it', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Request this table' }))
    expect(screen.getByText('Pick a day and a time above, then send the request.')).toBeTruthy()
    expect(focused()).toBe(dayCard())
  })

  it('"Make another booking" moves focus to the form, not <body>', async () => {
    renderPage()
    await screen.findByRole('button', { name: 'Request this table' })
    fillAndSend()
    await screen.findByRole('heading', { level: 2, name: 'Request sent' })
    fireEvent.click(screen.getByRole('button', { name: 'Make another booking' }))
    await waitFor(() => expect(focused()).toBe(dayCard()))
  })
})


// ── S852 ─────────────────────────────────────────────────────────────────────────────────────────
describe('booking switched off (S852)', () => {
  it('says so in a heading and tells the guest to contact the restaurant, with no Crest line', async () => {
    mockAnswers.get_booking_page = { data: [], error: null } // no row: booking off, POS off or locked
    renderPage()
    expect(await screen.findByRole('heading', { level: 1, name: 'Online booking is off' })).toBeTruthy()
    expect(screen.getByText('Please contact the restaurant to book a table.')).toBeTruthy()
    expect(screen.queryByText(/Powered by/)).toBeNull()
  })

  it('a send refused as closed names the outlet to contact', async () => {
    mockAnswers.submit_reservation_request = { data: { ok: false, code: 'closed' }, error: null }
    renderPage()
    await screen.findByRole('button', { name: 'Request this table' })
    expect(screen.queryByText(/Powered by/)).toBeNull()
    fillAndSend()
    expect(await screen.findByText('Online booking is off for Test Cafe right now. Please contact Test Cafe to book a table.')).toBeTruthy()
  })
})
