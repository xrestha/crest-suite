/**
 * /pricing (S852): where "Ask about" and "Email us" write to, and the FAQ dialog's behaviour.
 *
 * Both CTAs mailed a placeholder address the code itself said to change "when ready", used
 * nowhere else in the product, so every upgrade enquiry from a signed-in Owner went to an inbox
 * nobody reads. They now take the support contact every other screen resolves.
 */
import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { resolvePricing } from '../data/pricingPlans'
import { COMPANY } from '../legal'

let mockSession = null
let mockSettings = { app_name: 'Crest Suite' }
let mockPlatformSupport = null

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ session: mockSession }),
}))

jest.mock('../context/SettingsContext', () => ({
  useSettings: () => ({
    settings: mockSettings,
    pricing: require('../data/pricingPlans').resolvePricing(null),
    loading: false,
    platformSupport: mockPlatformSupport,
  }),
}))

const Pricing = require('./Pricing').default

function renderPricing() {
  return render(
    <MemoryRouter initialEntries={['/pricing']}>
      <Pricing />
    </MemoryRouter>
  )
}

beforeEach(() => {
  mockSession = null
  mockSettings = { app_name: 'Crest Suite' }
  mockPlatformSupport = null
  document.title = 'Crest Suite'
})

describe('Pricing contact address', () => {
  it('sends "Email us" to the support address, never the old placeholder', () => {
    renderPricing()
    const link = screen.getByRole('link', { name: /email us/i })
    expect(link.getAttribute('href')).toBe(`mailto:${COMPANY.supportEmail}`)
    expect(document.body.innerHTML).not.toMatch(/cresthospitality/)
  })

  it('sends Ask about, for a signed-in Owner, to the admin-edited platform address', () => {
    mockSession = { user: { id: 'u1' } }
    mockPlatformSupport = { email: 'help@example.com' }
    renderPricing()
    const ask = screen.getByRole('link', { name: /ask about growth/i })
    expect(ask.getAttribute('href')).toMatch(/^mailto:help@example\.com\?subject=/)
    expect(decodeURIComponent(ask.getAttribute('href'))).toContain('Crest Suite: Growth')
  })

  it('offers the trial form, as a link, to a visitor who is signed out', () => {
    renderPricing()
    const ctas = screen.getAllByRole('link', { name: /start free trial/i })
    expect(ctas.length).toBeGreaterThan(0)
    ctas.forEach(a => expect(a.getAttribute('href')).toBe('/signup'))
  })
})

describe('Pricing page chrome', () => {
  it('names the page in the tab', () => {
    renderPricing()
    expect(document.title).toBe('Pricing · Crest Suite')
  })

  it('opens the FAQ in a real dialog that moves focus in and closes on Escape', () => {
    renderPricing()
    const opener = screen.getByRole('button', { name: /faq/i })
    opener.focus()
    fireEvent.click(opener)
    const dialog = screen.getByRole('dialog', { name: /common questions/i })
    // Its first control, the 44px close button, takes focus on open.
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })
})

// resolvePricing is imported so a change to its shape fails here loudly rather than rendering an
// empty page; the mock above builds its table the same way.
test('the mock pricing table has every section the page reads', () => {
  const p = resolvePricing(null)
  expect(p.imsTiers.length).toBeGreaterThan(0)
  for (const k of ['hr', 'pos', 'customization', 'suite']) expect(p[k]).toBeTruthy()
})

// S862 ADD-6: the Customization card names combos, beside the dish choices it always named.
test('the Customization card sells combos and build-your-own dishes', () => {
  renderPricing()
  expect(screen.getByText(/build-your-own bowls — and sell combos at one price/)).toBeInTheDocument()
  expect(screen.getByText('Combos and set meals at one price, on the till and the QR menu')).toBeInTheDocument()
  expect(screen.getByText('Build-your-own dishes, walked step by step, costed as a range with IMS')).toBeInTheDocument()
})
