/**
 * What a screen-reader guest hears about their own order (S841). The chime said that something
 * happened and never what, even for a refusal, and focus fell to <body> once the order sheet closed.
 * One region in the page's shell, mounted before any tracker exists, says each step in the card's
 * own words; focus goes to the tracker's heading after a send.
 */

import { Profiler } from 'react'
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
  // A menu with two sections scrolls its chip bar to the section in view.
  Element.prototype.scrollTo = () => {}
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

// ── S842 ─────────────────────────────────────────────────────────────────────────────────────────
const BOWL = {
  recipe_id: 'r-bowl', name: 'Acai Bowl', selling_price: 300, vat_rate: 0, category: 'Bowls',
  table_name: 'Table 3', menu_name: 'Test Cafe', guest_ordering_enabled: true, is_vat_registered: false,
}
const LASSI = { ...ROWS[0], recipe_id: 'r-lassi', name: 'Mango Lassi', category: 'Drinks' }
// A build-your-own bowl: a required size, then optional toppings, then Review (three steps).
const BOWL_OPTIONS = {
  groups: [
    { id: 'g-size', name: 'Size', kind: 'size', min_select: 1, max_select: 1, included_count: 0, sort: 0, is_active: true },
    { id: 'g-top', name: 'Toppings', kind: 'addon', min_select: 0, max_select: null, included_count: 0, sort: 1, is_active: true },
  ],
  options: [
    { id: 'o-small', group_id: 'g-size', name: 'Small', price_delta: 0, is_default: false, sort: 0, is_active: true },
    { id: 'o-large', group_id: 'g-size', name: 'Large', price_delta: 100, is_default: false, sort: 1, is_active: true },
    { id: 'o-nuts', group_id: 'g-top', name: 'Nuts', price_delta: 30, is_default: false, sort: 0, is_active: true },
  ],
  attachments: [
    { id: 'a1', recipe_id: 'r-bowl', group_id: 'g-size', sort: 0 },
    { id: 'a2', recipe_id: 'r-bowl', group_id: 'g-top', sort: 1 },
  ],
  build_your_own: ['r-bowl'],
}
const phoneBack = () => act(() => { window.dispatchEvent(new PopStateEvent('popstate', { state: null })) })

describe("the phone's Back in a dish being built (S842)", () => {
  beforeEach(() => {
    mockAnswers.get_guest_menu = { data: [...ROWS, BOWL], error: null }
    mockAnswers.get_guest_menu_options = { data: BOWL_OPTIONS, error: null }
  })

  it('goes back one step, asks before the picks are lost, and leaves only on Leave', async () => {
    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Choose options and add Acai Bowl to your order' }))
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /Small/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }))
    expect(screen.getByText('Step 2 of 3')).toBeInTheDocument()

    phoneBack()
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Small/ })).toHaveAttribute('aria-checked', 'true')

    phoneBack()
    expect(screen.getByRole('dialog', { name: 'Acai Bowl' })).toBeInTheDocument()
    expect(screen.getByText('Leave without adding? Your choices will be lost.')).toBeInTheDocument()
    await waitFor(() => expect(focused()).toBe(screen.getByRole('button', { name: 'Keep choosing' })))

    fireEvent.click(screen.getByRole('button', { name: 'Keep choosing' }))
    expect(screen.queryByText(/Leave without adding/)).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Acai Bowl' })).toBeInTheDocument()

    phoneBack()
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(screen.queryByRole('dialog', { name: 'Acai Bowl' })).toBeNull()
  })

  it('with nothing picked, Back closes the sheet as before', async () => {
    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Choose options and add Acai Bowl to your order' }))
    expect(screen.getByRole('dialog', { name: 'Acai Bowl' })).toBeInTheDocument()
    phoneBack()
    expect(screen.queryByRole('dialog', { name: 'Acai Bowl' })).toBeNull()
  })

  it('names the count in "Add another", as the button shows it', async () => {
    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Choose options and add Acai Bowl to your order' }))
    fireEvent.click(screen.getByRole('radio', { name: /Small/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Next/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Skip/ }))
    fireEvent.click(screen.getByRole('button', { name: /^Add to order/ }))
    const again = await screen.findByRole('button', { name: 'Add another Acai Bowl, 1 in your order' })
    expect(again).toHaveTextContent('Add another (1)')
  })
})

describe('focus after a control goes away (S842)', () => {
  it("the refused card's Close moves focus to the top of the menu", async () => {
    renderMenu()
    await placeOrder()
    mockProgress = { status: 'dismissed', kot_status: null, remaining_minutes: null, order_closed: false }
    await pollNow()
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await waitFor(() => expect(focused()).toBe(screen.getByRole('heading', { level: 1, name: 'Test Cafe' })))
  })

  it('"Put it back in my order" leaves focus on the cart bar once the order sheet closes', async () => {
    renderMenu()
    await placeOrder()
    mockProgress = { status: 'dismissed', kot_status: null, remaining_minutes: null, order_closed: false }
    await pollNow()
    fireEvent.click(await screen.findByRole('button', { name: 'Put it back in my order' }))
    const sheet = await screen.findByRole('dialog', { name: 'Your order' })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(focused()).toBe(screen.getByRole('button', { name: /Review order/ })))
  })

  it('removing a line in "Your order" moves focus to the next line, then to Back to the menu', async () => {
    mockAnswers.get_guest_menu = { data: [...ROWS, LASSI], error: null }
    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Add Veg Momo to your order' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add Mango Lassi to your order' }))
    fireEvent.click(screen.getByRole('button', { name: /Review order/ }))
    const sheet = await screen.findByRole('dialog', { name: 'Your order' })

    fireEvent.click(within(sheet).getByRole('button', { name: 'Decrease quantity of Veg Momo' }))
    await waitFor(() => expect(focused()).toBe(within(sheet).getByRole('button', { name: 'Decrease quantity of Mango Lassi' })))

    fireEvent.click(within(sheet).getByRole('button', { name: 'Decrease quantity of Mango Lassi' }))
    await waitFor(() => expect(focused()).toBe(within(sheet).getByRole('button', { name: 'Back to the menu' })))

    // The cart bar went with the last dish, so closing lands on the top of the menu.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Back to the menu' }))
    await waitFor(() => expect(focused()).toBe(screen.getByRole('heading', { level: 1, name: 'Test Cafe' })))
  })
})

describe('dish photos load the thumbnail when there is one (S842)', () => {
  const PHOTO = 'https://abcd.supabase.co/storage/v1/object/public/dish-photos/c1/r-momo-100.jpg?v=100'
  // S844: the photo has an empty alt, so it is found by its role as decoration, not by the dish name.
  const photo = () => screen.getByRole('presentation')
  it('loads the marked thumb, and the full photo if the thumb will not load', async () => {
    mockAnswers.get_guest_menu = { data: [{ ...ROWS[0], image_url: `${PHOTO}&thumb=1` }], error: null }
    renderMenu()
    await screen.findByText('Veg Momo')
    expect(photo().getAttribute('src')).toBe('https://abcd.supabase.co/storage/v1/object/public/dish-photos/c1/r-momo-100.thumb.jpg?v=100&thumb=1')
    fireEvent.error(photo())
    expect(photo().getAttribute('src')).toBe(`${PHOTO}&thumb=1`)
  })
  it('a photo without the mark loads in full, with no request for a thumb', async () => {
    mockAnswers.get_guest_menu = { data: [{ ...ROWS[0], image_url: PHOTO }], error: null }
    renderMenu()
    await screen.findByText('Veg Momo')
    expect(photo().getAttribute('src')).toBe(PHOTO)
  })
  it('does not read the dish name twice: the photo beside it has an empty alt (S844)', async () => {
    mockAnswers.get_guest_menu = { data: [{ ...ROWS[0], image_url: PHOTO }], error: null }
    renderMenu()
    await screen.findByText('Veg Momo')
    expect(photo().getAttribute('alt')).toBe('')
    expect(screen.queryByRole('img', { name: 'Veg Momo' })).toBeNull()
  })
})

// The key under "Vegetarian dishes only" (S846): a line of mark + word, the marks themselves unnamed.
const dietKey = () => screen.getByText(/Marks on this menu/).closest('p') // eslint-disable-line testing-library/no-node-access

describe('the filter sheet counts what it will show (S844)', () => {
  const VEG = { recipe_id: 'r-veg', name: 'Veg Momo', is_veg: true }
  const MEAT = { recipe_id: 'r-meat', name: 'Chicken Momo', is_veg: false }
  const COMBO = {
    id: 'c1', name: 'Momo Combo', guest_price: 350, sort: 0,
    groups: [{ id: 'g1', name: 'Pick a momo', sort: 0, items: [{ ...MEAT, extra_price: 0, sort: 0 }] }],
  }
  beforeEach(() => {
    mockAnswers.get_guest_menu = {
      data: [{ ...ROWS[0], ...VEG }, { ...ROWS[0], ...MEAT }, { ...ROWS[0], recipe_id: 'r-lassi', name: 'Lassi', is_veg: true }],
      error: null,
    }
    mockAnswers.get_guest_menu_options = { data: { groups: [], options: [], attachments: [], combos: [COMBO] }, error: null }
  })
  it('names the combos beside the dishes, and follows the filters', async () => {
    renderMenu()
    // Each dish row carries its mark (DietMark, shared with the choice sheets since S844).
    expect(await screen.findAllByRole('img', { name: 'Vegetarian' })).toHaveLength(2)
    expect(screen.getAllByRole('img', { name: 'Non-vegetarian' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    expect(screen.getByRole('button', { name: 'Show 3 dishes and 1 combo' })).toBeTruthy()
    // S846: the key beside the filter lists only the marks this menu uses (no egg dish here).
    expect(dietKey().textContent).toBe('Marks on this menu: VegNon-veg')
    // Vegetarian only hides the chicken momo and the combo whose one pick is chicken.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Vegetarian dishes only' }))
    expect(screen.getByRole('button', { name: 'Show 2 dishes' })).toBeTruthy()
  })
  it('says nothing matches rather than offering to show none', async () => {
    mockAnswers.get_guest_menu = { data: [{ ...ROWS[0], ...MEAT }], error: null }
    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Filters' }))
    expect(screen.getByRole('button', { name: 'Show 1 dish and 1 combo' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Vegetarian dishes only' }))
    expect(screen.getByRole('button', { name: 'No dish matches · Close' })).toBeTruthy()
  })
})

describe('egg is its own mark, and is not vegetarian (S846)', () => {
  const VEG = { recipe_id: 'r-veg', name: 'Veg Momo', is_veg: true }
  const MEAT = { recipe_id: 'r-meat', name: 'Chicken Momo', is_veg: false, is_egg: false }
  const EGG = { recipe_id: 'r-egg', name: 'Egg Fried Rice', is_veg: false, is_egg: true }

  it('marks the egg dish, keys all three marks, and hides egg under Vegetarian only', async () => {
    mockAnswers.get_guest_menu = { data: [VEG, MEAT, EGG].map(d => ({ ...ROWS[0], ...d })), error: null }
    renderMenu()
    expect(await screen.findAllByRole('img', { name: 'Contains egg' })).toHaveLength(1)
    expect(screen.getAllByRole('img', { name: 'Vegetarian' })).toHaveLength(1)
    expect(screen.getAllByRole('img', { name: 'Non-vegetarian' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }))
    expect(dietKey().textContent).toBe('Marks on this menu: VegEggNon-veg')
    // The key's marks sit beside their words, so they add no second name.
    expect(within(dietKey()).queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Vegetarian dishes only' }))
    expect(screen.getByRole('button', { name: 'Show 1 dish' })).toBeTruthy()
  })

  it('a choice marked egg puts egg in the key even when no dish is', async () => {
    mockAnswers.get_guest_menu = { data: [{ ...BOWL, is_veg: true }], error: null }
    mockAnswers.get_guest_menu_options = {
      data: { ...BOWL_OPTIONS, options: BOWL_OPTIONS.options.map(o => (o.id === 'o-nuts' ? { ...o, diet: 'egg' } : o)) },
      error: null,
    }
    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Filters' }))
    expect(dietKey().textContent).toBe('Marks on this menu: VegEgg')
  })

  it('the dish sheet names the diet in full under the dish name', async () => {
    mockAnswers.get_guest_menu = { data: [{ ...BOWL, is_veg: false, is_egg: true }], error: null }
    mockAnswers.get_guest_menu_options = { data: BOWL_OPTIONS, error: null }
    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Choose options and add Acai Bowl to your order' }))
    const sheet = screen.getByRole('dialog', { name: 'Acai Bowl' })
    expect(within(sheet).getByText('Contains egg')).toBeInTheDocument()
  })
})

it('a poll that changes nothing does not redraw the page (S842)', async () => {
  let commits = 0
  render(
    <Profiler id="menu" onRender={() => { commits += 1 }}>
      <MemoryRouter initialEntries={['/menu/t-1']}>
        <Routes><Route path="/menu/:tableId" element={<GuestMenu />} /></Routes>
      </MemoryRouter>
    </Profiler>,
  )
  await placeOrder()
  mockProgress = { status: 'accepted', kot_status: 'in_progress', remaining_minutes: 12, order_closed: false }
  await pollNow()
  await waitFor(() => expect(announcer().textContent).toBe('Being prepared. About 12 min.'))
  await pollNow()
  const settled = commits
  await pollNow()
  await pollNow()
  expect(commits).toBe(settled)
})

// S862 TILL-GUEST-4: a cart restored on a reload is checked against the choices just read, so a
// choice hidden in the meantime comes off its dish (and is named) instead of riding along unseen
// until Place Order is refused and the whole dish is taken off.
describe('a cart checked against the choices just read', () => {
  const LATTE = { ...ROWS[0], recipe_id: 'r-latte', name: 'Cafe Latte', selling_price: 240, category: 'Coffee' }
  const LATTE_OPTIONS = {
    groups: [
      { id: 'g-cup', name: 'Cup size', kind: 'size', min_select: 1, max_select: 1, included_count: 0, sort: 0, is_active: true },
      { id: 'g-milk', name: 'Milk', kind: 'addon', min_select: 0, max_select: 1, included_count: 0, sort: 1, is_active: true },
    ],
    // Oat Milk has been hidden, so the guest read leaves it out.
    options: [
      { id: 'o-reg', group_id: 'g-cup', name: 'Regular', price_delta: 0, is_default: true, sort: 0, is_active: true },
      { id: 'o-large', group_id: 'g-cup', name: 'Large', price_delta: 40, is_default: false, sort: 1, is_active: true },
      { id: 'o-almond', group_id: 'g-milk', name: 'Almond Milk', price_delta: 80, is_default: false, sort: 1, is_active: true },
    ],
    attachments: [
      { id: 'a1', recipe_id: 'r-latte', group_id: 'g-cup', sort: 0 },
      { id: 'a2', recipe_id: 'r-latte', group_id: 'g-milk', sort: 1 },
    ],
  }
  const storedCart = cart => sessionStorage.setItem('guestCart:t-1', JSON.stringify({ cart, covers: 2, guestNote: '' }))
  const savedCart = () => JSON.parse(sessionStorage.getItem('guestCart:t-1')).cart

  it('takes a hidden choice off a reloaded order, names the dish, and Change choices starts from what is left', async () => {
    storedCart({ 'r-latte#o-large+o-oat': { recipe_id: 'r-latte', qty: 1, option_ids: ['o-large', 'o-oat'] } })
    mockAnswers.get_guest_menu = { data: [...ROWS, LATTE], error: null }
    mockAnswers.get_guest_menu_options = { data: LATTE_OPTIONS, error: null }
    renderMenu()
    expect(await screen.findByText('A choice on Cafe Latte is no longer offered, so it was taken off. The price in your order is the new one.')).toBeInTheDocument()
    await waitFor(() => expect(savedCart()).toEqual({ 'r-latte#o-large': { recipe_id: 'r-latte', qty: 1, option_ids: ['o-large'] } }))

    fireEvent.click(screen.getByRole('button', { name: /Review order/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Change choices for Cafe Latte' }))
    const sheet = screen.getByRole('dialog', { name: 'Cafe Latte' })
    // 240 + 40, no VAT on this outlet.
    expect(within(sheet).getByRole('button', { name: /Update · NPR 280/ })).toBeInTheDocument()
  })

  it('leaves a cart whose choices still fit untouched and says nothing', async () => {
    storedCart({ 'r-latte#o-almond+o-large': { recipe_id: 'r-latte', qty: 2, option_ids: ['o-large', 'o-almond'] } })
    mockAnswers.get_guest_menu = { data: [...ROWS, LATTE], error: null }
    mockAnswers.get_guest_menu_options = { data: LATTE_OPTIONS, error: null }
    renderMenu()
    expect(await screen.findByRole('button', { name: /Review order/ })).toBeInTheDocument()
    expect(screen.queryByText(/no longer offered/)).toBeNull()
    expect(Object.keys(savedCart())).toEqual(['r-latte#o-almond+o-large'])
  })

  it('puts a turned-away order back without a choice hidden since it was sent', async () => {
    sessionStorage.setItem('guestOrderReq:t-1', JSON.stringify({
      requestId: 'req-7', items: [{ name: 'Cafe Latte (Large, Oat Milk)', qty: 1 }],
      lines: [{ recipe_id: 'r-latte', qty: 1, option_ids: ['o-large', 'o-oat'] }], covers: 2, sentAt: new Date().toISOString(),
    }))
    mockProgress = { status: 'dismissed', kot_status: null, remaining_minutes: null, order_closed: false }
    mockAnswers.get_guest_menu = { data: [...ROWS, LATTE], error: null }
    mockAnswers.get_guest_menu_options = { data: LATTE_OPTIONS, error: null }
    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Put it back in my order' }))
    await waitFor(() => expect(savedCart()).toEqual({ 'r-latte#o-large': { recipe_id: 'r-latte', qty: 1, option_ids: ['o-large'] } }))
    expect(screen.getByText('A choice on Cafe Latte is no longer offered, so it was taken off. The price in your order is the new one.')).toBeInTheDocument()
  })

  it('after a refusal, takes off only the dish the fresh menu dropped and says so', async () => {
    storedCart({
      'r-momo': { recipe_id: 'r-momo', qty: 1, option_ids: [] },
      'r-latte#o-large': { recipe_id: 'r-latte', qty: 1, option_ids: ['o-large'] },
    })
    let reads = 0
    mockAnswers.get_guest_menu = () => Promise.resolve({ data: (reads += 1) === 1 ? [...ROWS, LATTE] : [LATTE], error: null })
    mockAnswers.get_guest_menu_options = { data: LATTE_OPTIONS, error: null }
    mockAnswers.submit_guest_order = { data: null, error: { code: 'P0001', hint: 'unavailable_items', details: '["Veg Momo"]', message: 'unavailable' } }
    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: /Review order/ }))
    fireEvent.click(screen.getByRole('button', { name: /Place order/ }))
    // Read inside the order sheet, and retried: the sheet re-renders as the re-read lands.
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Your order' }))
      .getByText(/Veg Momo is no longer available, so your order was not sent. It has been taken off your order/)).toBeInTheDocument())
    await waitFor(() => expect(Object.keys(savedCart())).toEqual(['r-latte#o-large']))
    expect(screen.getByText('Veg Momo is no longer on the menu, so it was taken off your order.')).toBeInTheDocument()
  })
})
