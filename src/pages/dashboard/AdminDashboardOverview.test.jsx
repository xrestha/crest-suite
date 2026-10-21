import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import AdminDashboardOverview from './AdminDashboardOverview'

// What each table read answers, set per test. A builder that resolves to it whatever is chained.
let mockResults = {}
jest.mock('../../supabaseClient', () => {
  const builder = table => {
    const b = {}
    for (const m of ['select', 'order', 'not', 'gte', 'range', 'eq']) b[m] = () => b
    b.then = (ok, bad) => Promise.resolve(mockResults[table]).then(ok, bad)
    return b
  }
  return { supabase: { from: table => builder(table) } }
})
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ switchAdminClient: () => Promise.resolve(false) }) }))
jest.mock('../../context/SettingsContext', () => ({ useSettings: () => ({ planPrices: null }) }))

const future = new Date(Date.now() + 200 * 86400000).toISOString()
const CLIENT = {
  id: 'c1', name: 'Cafe One', plan: 'growth', suite_plan: null, is_active: true, ims_enabled: true,
  hr_enabled: false, pos_enabled: false, customization_enabled: false, ims_ends_at: future,
  subscription_ends_at: future, billing_cycle: 'monthly', is_trial: false, is_internal: false,
}
const ok = data => ({ data, error: null })
const failed = { data: null, error: { message: 'TypeError: Failed to fetch' } }

function tileOf(label) {
  return screen.getAllByText(label).map(el => el.closest('.stat-card')).find(Boolean)
}

async function renderPage() {
  render(<MemoryRouter><AdminDashboardOverview /></MemoryRouter>)
  await screen.findAllByText(/Active Properties/)
}

test('every tile shows its figure when all three reads answer', async () => {
  mockResults = {
    clients: ok([CLIENT]),
    monthly_periods: ok([]),
    profiles: ok([]),
  }
  await renderPage()
  expect(within(tileOf('No Open Period')).getByText('1')).toBeInTheDocument()
  expect(screen.getByText(/1 active · 0 inactive · 1 total properties/)).toBeInTheDocument()
})

test('a failed months read is not every client without an open month', async () => {
  mockResults = {
    clients: ok([CLIENT]),
    monthly_periods: failed,
    profiles: ok([]),
  }
  await renderPage()
  const tile = tileOf('No Open Period')
  expect(within(tile).getByText('—')).toBeInTheDocument()
  expect(within(tile).getByText(/Could not load/)).toBeInTheDocument()
  expect(within(tile).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  expect(screen.getByText(/The months could not be loaded/)).toBeInTheDocument()
  // No red "No period" on the row, and the client is not sorted under Needs attention for it.
  expect(screen.queryByText(/No period/)).not.toBeInTheDocument()
  expect(screen.queryByText(/Needs attention/)).not.toBeInTheDocument()
  // The tiles that do not depend on the months still show their figures.
  expect(within(tileOf('Active Properties')).getByText('1')).toBeInTheDocument()
})

test('a failed client read shows no count, no revenue and no table', async () => {
  mockResults = {
    clients: failed,
    monthly_periods: ok([]),
    profiles: ok([]),
  }
  await renderPage()
  expect(within(tileOf('Est. Monthly Revenue')).getByText('—')).toBeInTheDocument()
  expect(screen.queryByText(/NPR 0/)).not.toBeInTheDocument()
  expect(screen.getByText('Property counts not loaded')).toBeInTheDocument()
  expect(screen.getByText(/The property list could not be loaded/)).toBeInTheDocument()
  expect(screen.queryByText('All Properties')).not.toBeInTheDocument()
})

test('a failed sign-in read leaves Active Today unknown, not zero', async () => {
  mockResults = {
    clients: ok([CLIENT]),
    monthly_periods: ok([]),
    profiles: failed,
  }
  await renderPage()
  const tile = tileOf('Active Today')
  expect(within(tile).getByText('—')).toBeInTheDocument()
  expect(within(tile).queryByText('No logins in last 24 h')).not.toBeInTheDocument()
})
