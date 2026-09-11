/**
 * Settings → Plan Pricing, tested where the two reported defects actually lived.
 *
 * S701: the tab edited the page-level `form` and committed through save(), which targets whichever
 * client the admin is VIEWING — so with a client selected the price saved into a row nothing reads.
 * The save reported success and the number on the public pricing page never moved. The assertion
 * that matters is therefore not "does it save" but WHICH writer it calls: savePlatformPlanPrices,
 * never saveSettings.
 *
 * S702: monthly and annual used to be two tabs, so the annual figure was somewhere you had to go
 * and look — for a number that is not a second price but a printout of this one. Both are on
 * screen together now, with the ARR beside them, and only Monthly is editable, which is what stops
 * them drifting apart.
 *
 * One of very few component tests here (see Signup.trialConsent.test.jsx for the pattern and why
 * it only recently became possible).
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DEFAULT_PLAN_PRICES, annualOf } from '../data/pricingPlans'

const mockSaveSettings = jest.fn()
const mockSavePlatformPlanPrices = jest.fn()

// The live platform row: HR and POS carry real overrides, IMS has never been touched (so it must
// fall back to the shipped tiers), and the flat `starter`/`growth`/`pro` keys are the JSONB
// column's original DEFAULT, dead since IMS tiers moved under `ims`.
const mockPlanPrices = { hr: 2400, pos: 2100, starter: 5000, growth: 8000, pro: 12000 }

// Stable identities, all of them. Settings reseeds local state from `settings` and from
// `recipeCategories` in effects keyed on those objects, so a fresh literal per call is an
// infinite render loop — and the suite HANGS rather than failing, which is a slow thing to
// diagnose. In the app both are React state and therefore stable; only a mock can get this wrong.
const mockRecipeCategories = []
const mockSettings = { app_name: 'Crest Suite' }
const mockNoop = jest.fn()

jest.mock('../supabaseClient', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
}))

jest.mock('../context/AuthContext', () => ({
  // An admin VIEWING a client — the exact session in which the old save wrote to the wrong row.
  useAuth: () => ({ clientId: 'client-1', isAdmin: true, hasFeature: () => true, hasImsAccess: () => true }),
}))

jest.mock('../context/SettingsContext', () => ({
  useSettings: () => ({
    settings: mockSettings,
    saveSettings: (...a) => mockSaveSettings(...a),
    loadSettings: mockNoop,
    recipeCategories: mockRecipeCategories,
    platformSupport: null,
    savePlatformSupport: mockNoop,
    planPrices: mockPlanPrices,
    savePlatformPlanPrices: (...a) => mockSavePlatformPlanPrices(...a),
  }),
}))

jest.mock('../context/ThemeContext', () => ({
  useTheme: () => ({ themeKey: 'dark', colors: {}, switchPreset: mockNoop, updateColor: mockNoop }),
  PRESETS: {},
}))

jest.mock('../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({ scopedFrom: mockNoop, scopedUpdate: mockNoop }),
}))

const Settings = require('./Settings').default

function renderPlanPricing() {
  const view = render(<MemoryRouter><Settings /></MemoryRouter>)
  fireEvent.click(screen.getByRole('tab', { name: 'Plan Pricing' }))
  return view
}

const priceInput = name => screen.getByLabelText(name)
// savePrices() is async, so its setState resolves after the click returns. Waiting on the write
// itself settles the update inside React's own act scope and stops the assertions racing it.
const clickSave = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Save Plan Prices/i }))
  await waitFor(() => expect(mockSavePlatformPlanPrices).toHaveBeenCalled())
}

beforeEach(() => {
  mockSaveSettings.mockReset()
  mockSavePlatformPlanPrices.mockReset()
  mockSavePlatformPlanPrices.mockResolvedValue(undefined)
})

describe('what the tab shows', () => {
  it('shows what is STORED, and leaves an unset price blank with the shipped figure behind it', () => {
    renderPlanPricing()
    // Set on the row.
    expect(priceInput(/Crest HR/i)).toHaveValue(2400)
    expect(priceInput(/Crest POS/i)).toHaveValue(2100)
    // Never set: blank, with the shipped figure as the placeholder and named in the hint under the
    // box — NOT seeded into the box, which made every field look like a saved decision and, with
    // the old `'' → 0`, left no way back to the default: clearing a box published the plan as free.
    // And not the dead flat starter/growth/pro keys sitting beside `ims` on the row either.
    expect(priceInput(/starter/i)).toHaveValue(null)
    expect(priceInput(/starter/i)).toHaveAttribute('placeholder', String(DEFAULT_PLAN_PRICES.ims.starter))
    expect(priceInput(/Crest Suite Pro/i)).toHaveValue(null)
    expect(screen.getAllByText(/Blank . the shipped NPR .* is quoted/).length).toBeGreaterThan(0)
  })

  it('restores the default when a stored price is cleared, rather than publishing 0', async () => {
    renderPlanPricing()
    fireEvent.change(priceInput(/Crest HR/i), { target: { value: '' } })
    expect(priceInput(/Crest HR/i)).toHaveValue(null)
    await clickSave()
    // The key is GONE, so every reader falls back per field to the shipped figure. Writing 0 here
    // would have been a real price, which resolvePricing and clientMrr both keep on purpose.
    expect(mockSavePlatformPlanPrices.mock.calls[0][0]).not.toHaveProperty('hr')
  })

  it('asks before publishing an explicit 0, and writes nothing if cancelled', async () => {
    renderPlanPricing()
    fireEvent.change(priceInput(/Crest HR/i), { target: { value: '0' } })
    fireEvent.click(screen.getByRole('button', { name: /Save Plan Prices/i }))
    await screen.findByText(/Publish HR at NPR 0/i)
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    await waitFor(() => expect(screen.queryByText(/Publish HR at NPR 0/i)).toBeNull())
    expect(mockSavePlatformPlanPrices).not.toHaveBeenCalled()
  })

  // Each figure below is unique across the six fields, so a plain text query is unambiguous.
  it('shows the annual rate beside the monthly one, not behind a toggle', () => {
    renderPlanPricing()
    expect(screen.getByText(`Annual · NPR ${annualOf(2400).toLocaleString('en-IN')} / Month`)).toBeInTheDocument()
    expect(screen.getByText('Annual · NPR 2,625 / Month')).toBeInTheDocument()
  })

  // The yearly figure is what an operator is actually deciding with, and it used to be a
  // multiplication they had to do in their head.
  it('states the ARR beside the annual rate', () => {
    renderPlanPricing()
    expect(screen.getByText('ARR · NPR 21,600 / Year')).toBeInTheDocument()
  })

  it('re-derives both lines as the monthly price is typed', () => {
    renderPlanPricing()
    fireEvent.change(priceInput(/Crest POS/i), { target: { value: '4000' } })
    expect(screen.getByText('Annual · NPR 3,000 / Month')).toBeInTheDocument()
    expect(screen.getByText('ARR · NPR 36,000 / Year')).toBeInTheDocument()
  })

  // Annual is derived, so there is nothing to type into — a second editable field is exactly how
  // the two figures would come to disagree.
  it('offers no annual input to edit', () => {
    renderPlanPricing()
    expect(screen.getAllByRole('spinbutton')).toHaveLength(6)
  })
})

describe('where it saves', () => {
  it('writes the platform row, never the viewed client s settings', async () => {
    renderPlanPricing()
    fireEvent.change(priceInput(/Crest HR/i), { target: { value: '2500' } })
    await clickSave()

    expect(mockSavePlatformPlanPrices).toHaveBeenCalledTimes(1)
    expect(mockSaveSettings).not.toHaveBeenCalled()
    expect(mockSavePlatformPlanPrices.mock.calls[0][0]).toMatchObject({ hr: 2500, pos: 2100 })
  })

  it('saves the canonical shape and drops the dead legacy keys', async () => {
    renderPlanPricing()
    await clickSave()

    const written = mockSavePlatformPlanPrices.mock.calls[0][0]
    // The two prices the row actually holds, under `ims`/`hr`/`pos`/`suite` only — never the flat
    // `starter`/`growth`/`pro` keys the JSONB column's original DEFAULT left behind. A price the
    // admin has never set is ABSENT rather than written at its shipped figure, which is what lets a
    // cleared box mean "use the default": resolvePricing and clientMrr both fall back per field.
    expect(Object.keys(written).sort()).toEqual(['hr', 'ims', 'pos'])
    expect(written.ims).toEqual({})
  })

  // The page-level Save commits `form` to the viewed client's row, which is the one place a
  // platform price must never go — so it does not render on this tab at all.
  it('hides the page-level Save button on this tab', () => {
    renderPlanPricing()
    expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument()
  })
})
