/**
 * S862 COMBOS-7: Combo Builder's suggested price, and the price "Create as combo" fills in, follow
 * the outlet's VAT mode. A PAN-bill outlet's guest pays the price itself (D31), so grossing it up
 * 13% put a price on the combo that no PAN bill ever adds.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

let mockVatRegistered = true
const mockRecipes = [
  { id: 'momo', name: 'Momo', category: 'Momo', selling_price: 280, vat_rate: 0.13, cost_price: null },
  { id: 'coke', name: 'Coke', category: 'Beverage', selling_price: 100, vat_rate: 0.13, cost_price: null },
]
// A query builder: every method hands back the builder, and awaiting it answers `result`.
function mockChain(result) {
  const builder = new Proxy({}, {
    get: (_, key) => (key === 'then' ? (ok, fail) => Promise.resolve(result).then(ok, fail) : () => builder),
  })
  return builder
}

jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ clientId: 'c1', posEnabled: true, hasImsAccess: () => true, customizationEnabled: true }),
}))
jest.mock('../../../context/SettingsContext', () => ({
  useSettings: () => ({
    settings: { is_vat_registered: mockVatRegistered }, loading: false, settingsLoadError: null, settingsClientId: 'c1',
  }),
}))
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({ scopedFrom: () => mockChain({ data: mockRecipes, error: null }) }),
}))
jest.mock('../../../supabaseClient', () => ({
  supabase: {
    from: () => mockChain({ data: { id: 's1', combo_discount_pct: 10 }, error: null }),
    rpc: () => Promise.resolve({ data: [{ paired_recipe_id: 'coke', co_count: 5, anchor_bills: 10 }], error: null }),
  },
}))
jest.mock('../../../utils/recipeCost', () => ({ computeRecipeCosts: () => Promise.resolve({}) }))

// eslint-disable-next-line import/first
import ComboBuilder from './ComboBuilder'

const renderPage = () => render(<MemoryRouter><ComboBuilder /></MemoryRouter>)

// Momo 280 + Coke 100 at 10% off is 342.
it('grosses the suggestion up for VAT on a VAT-registered outlet', async () => {
  mockVatRegistered = true
  renderPage()
  const link = await screen.findByRole('link', { name: /Create as combo/ })
  // 342 × 1.13 = 386.46, up to the next 5.
  expect(link.getAttribute('href')).toMatch(/price=390$/)
  expect(screen.getByText('Suggested Combo Price')).toBeInTheDocument()
})

it('adds no VAT on a PAN-bill outlet, and the column says so', async () => {
  mockVatRegistered = false
  renderPage()
  const link = await screen.findByRole('link', { name: /Create as combo/ })
  expect(link.getAttribute('href')).toMatch(/price=345$/)
  expect(screen.getByText('Suggested Combo Price (no VAT)')).toBeInTheDocument()
})
