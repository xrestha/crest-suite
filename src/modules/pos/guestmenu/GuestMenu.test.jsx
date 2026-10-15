/**
 * What a screen-reader guest hears about their own order (S841). The chime said that something
 * happened and never what, even for a refusal, and focus fell to <body> once the order sheet closed.
 * One region in the page's shell, mounted before any tracker exists, says each step in the card's
 * own words; focus goes to the tracker's heading after a send.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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
jest.mock('../posChime', () => ({ playChime: () => {} }))
jest.mock('./guestDocument', () => ({ useGuestDocumentIdentity: () => {} }))
jest.mock('../../../context/SettingsContext', () => ({ DEFAULT_RECIPE_CATS: [] }))

// eslint-disable-next-line import/first
import GuestMenu from './GuestMenu'

const ROWS = [{
  recipe_id: 'r-momo', name: 'Veg Momo', selling_price: 200, vat_rate: 0, category: 'Momo',
  table_name: 'Table 3', menu_name: 'Test Cafe', guest_ordering_enabled: true, is_vat_registered: false,
}]
const SENT = 'Order sent. Waiting for staff to accept it.'
let mockProgress = null
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
const renderMenu = () => render(
  <MemoryRouter initialEntries={['/menu/t-1']}>
    <Routes><Route path="/menu/:tableId" element={<GuestMenu />} /></Routes>
  </MemoryRouter>,
)
// The tracker polls every 5 s while the page is visible, and once on becoming visible again.
async function pollNow() {
  await act(async () => {
    mockVisibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    mockVisibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
  })
}
async function placeOrder() {
  fireEvent.click(await screen.findByRole('button', { name: 'Add Veg Momo to your order' }))
  fireEvent.click(screen.getByRole('button', { name: /Review order/ }))
  fireEvent.click(screen.getByRole('button', { name: /Place order/ }))
  await waitFor(() => expect(announcer().textContent).toBe(SENT))
}

beforeAll(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => mockVisibility })
  Element.prototype.scrollIntoView = () => {}
})

beforeEach(() => {
  sessionStorage.clear()
  mockVisibility = 'visible'
  mockProgress = { status: 'pending', kot_status: null, remaining_minutes: null, order_closed: false }
  mockAnswers = {
    get_guest_menu: { data: ROWS, error: null },
    get_guest_menu_options: { data: { groups: [], options: [], attachments: [] }, error: null },
    get_guest_table_status: { data: [], error: null },
    get_guest_order_progress: () => Promise.resolve({ data: mockProgress ? [mockProgress] : [], error: null }),
    submit_guest_order: { data: 'req-1', error: null },
  }
})

it('mounts the announcer empty before the menu loads, and keeps the same region once it has', async () => {
  let loadMenu
  mockAnswers.get_guest_menu = () => new Promise(resolve => { loadMenu = resolve })
  renderMenu()
  const region = announcer()
  expect(region).toBeTruthy()
  expect(region.getAttribute('aria-live')).toBe('polite')
  expect(region.textContent).toBe('')
  await act(async () => { loadMenu({ data: ROWS, error: null }) })
  expect(await screen.findByRole('heading', { level: 1, name: 'Test Cafe' })).toBeTruthy()
  expect(announcer()).toBe(region)
})

it('says the order was sent and moves focus to the tracker, not <body>', async () => {
  renderMenu()
  await placeOrder()
  const heading = screen.getByRole('heading', { level: 2, name: SENT })
  await waitFor(() => expect(focused()).toBe(heading))
  // The heading is no longer a live region of its own, or the same words would be said twice.
  expect(heading.getAttribute('aria-live')).toBeNull()
})

it('says each stage once, and nothing for a poll that changes nothing or only the minutes', async () => {
  renderMenu()
  await placeOrder()

  mockProgress = { status: 'accepted', kot_status: null, remaining_minutes: null, order_closed: false }
  await pollNow()
  await waitFor(() => expect(announcer().textContent).toBe('Accepted. It goes to the kitchen next.'))
  const saidAgain = watchSaid(announcer())
  await pollNow()
  expect(saidAgain()).toBe(0)

  mockProgress = { status: 'accepted', kot_status: 'in_progress', remaining_minutes: 12, order_closed: false }
  await pollNow()
  await waitFor(() => expect(announcer().textContent).toBe('Being prepared. About 12 min.'))
  const minutesSaid = watchSaid(announcer())
  mockProgress = { ...mockProgress, remaining_minutes: 11 }
  await pollNow()
  await screen.findByText(/About 11 min/)
  expect(minutesSaid()).toBe(0)
  expect(announcer().textContent).toBe('Being prepared. About 12 min.')
})

it('says a refusal in the card’s words and keeps focus on the card’s heading', async () => {
  renderMenu()
  await placeOrder()
  await waitFor(() => expect(focused()).toBe(screen.getByRole('heading', { level: 2, name: SENT })))

  mockProgress = { status: 'dismissed', kot_status: null, remaining_minutes: null, order_closed: false }
  await pollNow()
  await waitFor(() => expect(announcer().textContent).toBe(
    'Staff couldn’t take this order. Please ask a member of staff. You can send it again from your order.',
  ))
  expect(focused()).toBe(screen.getByRole('heading', { level: 2, name: 'Staff couldn’t take this order' }))
})

it('says the bill closed', async () => {
  renderMenu()
  await placeOrder()
  mockProgress = { status: 'accepted', kot_status: 'ready', remaining_minutes: null, order_closed: true }
  await pollNow()
  await waitFor(() => expect(announcer().textContent).toBe('Your bill is closed. Thank you! We hope you enjoyed your meal.'))
})

it('reads a tracker restored on a reload on the page, without announcing it', async () => {
  sessionStorage.setItem('guestOrderReq:t-1', JSON.stringify({
    requestId: 'req-9', items: [{ name: 'Veg Momo', qty: 1 }], lines: [{ recipe_id: 'r-momo', qty: 1, option_ids: [] }],
    covers: 2, sentAt: new Date().toISOString(),
  }))
  mockProgress = { status: 'accepted', kot_status: 'ready', remaining_minutes: null, order_closed: false }
  // The menu lands after the first reading, so the tracker mounts already holding its stage.
  let loadMenu
  mockAnswers.get_guest_menu = () => new Promise(resolve => { loadMenu = resolve })
  renderMenu()
  // Lets the first reading land on its own, before the menu does.
  await act(async () => {}) // eslint-disable-line testing-library/no-unnecessary-act
  await act(async () => { loadMenu({ data: ROWS, error: null }) })
  expect(await screen.findByRole('heading', { level: 2, name: 'Ready to serve.' })).toBeTruthy()
  expect(announcer().textContent).toBe('')
})

it('starts a second order from its own readings, never the first order’s stage', async () => {
  renderMenu()
  await placeOrder()
  mockProgress = { status: 'accepted', kot_status: 'ready', remaining_minutes: null, order_closed: false }
  await pollNow()
  expect(await screen.findByRole('heading', { level: 2, name: 'Ready to serve.' })).toBeTruthy()

  // A second round from the same phone, which the server has not answered yet.
  mockAnswers.submit_guest_order = { data: 'req-2', error: null }
  mockProgress = { status: 'pending', kot_status: null, remaining_minutes: null, order_closed: false }
  await placeOrder()
  await pollNow()
  expect(screen.getByRole('heading', { level: 2, name: SENT })).toBeTruthy()
  expect(screen.queryByRole('heading', { level: 2, name: 'Ready to serve.' })).toBeNull()
})
