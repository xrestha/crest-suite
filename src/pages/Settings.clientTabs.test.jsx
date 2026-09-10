/**
 * Settings — the client-side tabs (S730), tested where the defects lived.
 *
 * The headline: the page-level Save wrote the WHOLE settings row as it stood when the page loaded.
 * `settings` is one row per client that nine other pages write their own columns onto, so an owner
 * saving a threshold put back whatever a manager had changed on the till meanwhile — and both saves
 * reported success. The assertion that matters is therefore the SHAPE of the write: only the
 * fields this page owns, and only the ones that changed.
 *
 * Same mock discipline as Settings.planPricing.test.jsx: every object the component keys an effect
 * on must have a stable identity, or the suite hangs rather than failing.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const mockSaveSettings = jest.fn()
const mockNoop = jest.fn()

// The live row: the columns THIS page edits, plus columns OTHER pages own, which must never ride
// along in a write from here.
const ROW = {
  id: 'row-1', client_id: 'client-1',
  fc_warning_pct: 35, fc_critical_pct: 45, expiry_warning_days: 7, variance_flag_pct: 10,
  item_code_prefix: 'ITM', vendor_code_prefix: 'VND', sub_recipe_code_prefix: 'SRC',
  recipe_categories: ['Food', 'Beverage'],
  pos_discount_reasons: ['Staff', 'Spillage'],
  ims_custom_roles: [{ name: 'Store Keeper', level: 'staff' }],
}
let mockRow = { ...ROW }
// saveSettings applies the patch to the "row" and hands the component a NEW settings object on its
// next render — the reseed path the real context takes after every save.
mockSaveSettings.mockImplementation(async patch => { mockRow = { ...mockRow, ...patch } })

jest.mock('../supabaseClient', () => ({
  supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
}))

jest.mock('../context/AuthContext', () => ({
  // A real client login — the Owner — not an admin viewing.
  useAuth: () => ({ clientId: 'client-1', isAdmin: false, hasFeature: () => true, hasImsAccess: () => true }),
}))

jest.mock('../context/SettingsContext', () => ({
  useSettings: () => ({
    settings: mockRow,
    saveSettings: (...a) => mockSaveSettings(...a),
    loadSettings: mockNoop,
    recipeCategories: mockRow.recipe_categories,
    platformSupport: null,
    savePlatformSupport: mockNoop,
    planPrices: null,
    savePlatformPlanPrices: mockNoop,
  }),
}))

jest.mock('../context/ThemeContext', () => ({
  useTheme: () => ({ themeKey: 'dark', colors: {}, switchPreset: mockNoop, updateColor: mockNoop }),
  PRESETS: {},
  SYSTEM_KEY: 'system',
}))

// Category usage: one Food recipe, so removing "Food" must confirm and "Beverage" must not.
jest.mock('../shared/fetchAllRows', () => ({
  fetchAllRows: async () => ({ data: [{ id: 'r1', category: 'Food' }], error: null }),
}))

// A recording builder for the renumber path: `.eq()`/`.order()` chain and resolve to one item.
const mockScopedFromCalls = []
const mockScopedUpdateCalls = []
jest.mock('../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    scopedFrom: (table, cols) => {
      const call = { table, cols, eq: [], order: [] }
      mockScopedFromCalls.push(call)
      const b = {
        eq: (...a) => { call.eq.push(a); return b },
        order: (...a) => { call.order.push(a); return b },
        range: () => Promise.resolve({ data: [], error: null }),
        then: (res, rej) => Promise.resolve({ data: [{ id: 'i1', name: 'ATTA' }], error: null }).then(res, rej),
      }
      return b
    },
    scopedUpdate: (table, patch) => ({
      eq: (...a) => { mockScopedUpdateCalls.push({ table, patch, eq: a }); return Promise.resolve({ error: null }) },
    }),
  }),
}))

const Settings = require('./Settings').default

function renderSettings() {
  return render(<MemoryRouter><Settings /></MemoryRouter>)
}
const tab = name => fireEvent.click(screen.getByRole('tab', { name }))
const warnInput = () => screen.getByLabelText(/Warning level/i)
const saveChanges = () => fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }))

beforeEach(() => {
  mockRow = { ...ROW }
  mockSaveSettings.mockClear()
  mockScopedFromCalls.length = 0
  mockScopedUpdateCalls.length = 0
})

describe('what Save Changes writes', () => {
  it('sends only the page field that changed, typed for the column — never the whole row', async () => {
    renderSettings()
    fireEvent.change(warnInput(), { target: { value: '40' } })
    saveChanges()
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalledTimes(1))
    // Exactly one key: not fc_critical_pct (unchanged), not pos_discount_reasons or
    // ims_custom_roles (other pages' columns), not id/client_id.
    expect(mockSaveSettings.mock.calls[0][0]).toEqual({ fc_warning_pct: 40 })
  })

  it('stores a cleared threshold as NULL, not the empty string Postgres refuses', async () => {
    renderSettings()
    fireEvent.change(warnInput(), { target: { value: '' } })
    saveChanges()
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalledTimes(1))
    expect(mockSaveSettings.mock.calls[0][0]).toEqual({ fc_warning_pct: null })
  })

  it('writes nothing when nothing changed', async () => {
    renderSettings()
    saveChanges()
    await screen.findByRole('button', { name: /Saved/ })
    expect(mockSaveSettings).not.toHaveBeenCalled()
  })
})

describe('what it refuses', () => {
  // Every reader is `parseFloat(x) || default`, so a stored 0 IS the default while the box says 0.
  it('refuses 0 and writes nothing', async () => {
    renderSettings()
    fireEvent.change(warnInput(), { target: { value: '0' } })
    saveChanges()
    expect(await screen.findByText(/above 0/)).toBeInTheDocument()
    expect(warnInput()).toHaveAttribute('aria-invalid', 'true')
    expect(mockSaveSettings).not.toHaveBeenCalled()
  })

  it('refuses a critical level at or below the warning level, naming the warning level', async () => {
    renderSettings()
    fireEvent.change(warnInput(), { target: { value: '50' } })   // critical is still 45
    saveChanges()
    expect(await screen.findByText(/Critical must be above the warning level \(50%\)/)).toBeInTheDocument()
    expect(mockSaveSettings).not.toHaveBeenCalled()
  })
})

describe('the tabs that save on their own', () => {
  it('renders no page-level Save on Recipe Categories, Product Codes or Theme', async () => {
    renderSettings()
    tab('Recipe Categories')
    await screen.findByText('1 recipe')   // the usage read has landed; nothing updates after this
    for (const name of ['Recipe Categories', 'Product Codes', 'Theme']) {
      tab(name)
      expect(screen.queryByRole('button', { name: /Save Changes/i })).not.toBeInTheDocument()
    }
    tab('Thresholds')
    expect(screen.getByRole('button', { name: /Save Changes/i })).toBeInTheDocument()
  })

  it('Save Categories writes one column, and an edit pending on Thresholds survives the reseed', async () => {
    renderSettings()
    fireEvent.change(warnInput(), { target: { value: '40' } })   // typed, not saved

    tab('Recipe Categories')
    fireEvent.change(screen.getByLabelText('New category name'), { target: { value: 'Dessert' } })
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }))
    fireEvent.click(screen.getByRole('button', { name: /Save Categories/i }))
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalledTimes(1))
    expect(mockSaveSettings.mock.calls[0][0]).toEqual({ recipe_categories: ['Food', 'Beverage', 'Dessert'] })
    await screen.findByText('Categories saved.')

    // The context re-read the row and the form was reseeded from it — the typed 40 must still be there.
    tab('Thresholds')
    expect(warnInput()).toHaveValue(40)
  })

  it('a category recipes still use confirms with the count before leaving the list', async () => {
    renderSettings()
    tab('Recipe Categories')
    expect(await screen.findByText('1 recipe')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove the "Food" category' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/filed under "Food"/)).toBeInTheDocument()
    // Unused: no dialog, straight out.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove the "Beverage" category' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove the "Beverage" category' })).not.toBeInTheDocument()
  })
})

describe('Regenerate All Item Codes', () => {
  it('renumbers real items only, and saves the prefix alone', async () => {
    renderSettings()
    tab('Item Codes')
    fireEvent.change(screen.getByLabelText(/Code Prefix/i), { target: { value: 'ING' } })
    fireEvent.click(screen.getByRole('button', { name: /Regenerate All Item Codes/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Renumber All/i }))
    await screen.findByText(/Renumbered 1 item as ING-001 through ING-001/)

    // The prefix, and only the prefix — not the whole form.
    expect(mockSaveSettings).toHaveBeenCalledTimes(1)
    expect(mockSaveSettings.mock.calls[0][0]).toEqual({ item_code_prefix: 'ING' })
    // Sub-recipe mirror rows carry the sub-recipe's own SRC code and must be left alone.
    const read = mockScopedFromCalls.find(c => c.table === 'items')
    expect(read.eq).toContainEqual(['is_sub_recipe', false])
    expect(mockScopedUpdateCalls).toEqual([{ table: 'items', patch: { item_code: 'ING-001' }, eq: ['id', 'i1'] }])
  })
})
