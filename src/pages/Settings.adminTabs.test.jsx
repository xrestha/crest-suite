/**
 * Settings — the ADMIN tabs. S730 re-analysed the seven client-side tabs; this is the complement,
 * and it is tested where the defects lived.
 *
 * The headline: the Support tab's "Save Consultant" button had written nothing since S730. That
 * card edits `contact_phone`/`contact_email`/`contact_website` into the page's `form` and commits
 * through `save()`, which walks PAGE_FIELDS — and the three columns were not in it. The patch was
 * always empty, the write was skipped by `if (Object.keys(patch).length)`, and the button still
 * reported "✓ Saved". Those fields are read on Help → Support, PremiumGate's upsell card and
 * SubscriptionLock's lock screen, so the per-client consultant override simply stopped existing.
 *
 * Second: `save()` validated thresholds on EVERY save, against the STORED row, and sent a failure
 * to `setActiveTab('Thresholds')` — a tab absent from ADMIN_TABS. An admin editing branding for a
 * client whose pre-S730 row holds a 0 or an inverted pair was refused over fields they have no tab
 * for, and landed on a panel with no tab selected above it.
 *
 * Same mock discipline as the sibling suites: every object an effect keys on has a stable identity,
 * or the suite hangs rather than failing.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const mockSaveSettings = jest.fn()
const mockNoop = jest.fn()

// A client row whose thresholds are INVALID by S730's rules (a critical level below its warning
// level, and a 0 that every reader silently treats as its default) — the state a row saved before
// S730 can really be in, and the one an admin has no tab to correct.
const ROW = {
  id: 'row-1', client_id: 'client-1',
  app_name: 'Casa Acai Cafe', app_tagline: 'Fresh bowls',
  invoice_prefix: 'CAC', is_vat_registered: true,
  fc_warning_pct: 35, fc_critical_pct: 30, variance_flag_pct: 0, expiry_warning_days: 7,
  contact_phone: '', contact_email: '', contact_website: '',
  pos_discount_reasons: ['Staff', 'Spillage'],
  ims_custom_roles: [{ name: 'Store Keeper', level: 'staff' }],
}
let mockRow = { ...ROW }
let mockClientId = 'client-1'
// Stable identities. `recipeCategories` is the one an effect keys on directly
// (`useEffect(() => setCats([...recipeCategories]), [recipeCategories])`), so a fresh [] per render
// re-runs it forever and the suite hangs instead of failing.
const NO_CATS = []
const NO_COLORS = {}
mockSaveSettings.mockImplementation(async patch => { mockRow = { ...mockRow, ...patch } })

jest.mock('../supabaseClient', () => ({
  supabase: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: () => ({ data: { publicUrl: 'u' } }),
        remove: async () => ({ error: null }),
      }),
    },
  },
}))

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    clientId: mockClientId, isAdmin: true, adminViewClientName: 'Casa Acai Cafe',
    hasFeature: () => true, hasImsAccess: () => true,
  }),
}))

jest.mock('../context/SettingsContext', () => ({
  useSettings: () => ({
    settings: mockRow,
    saveSettings: (...a) => mockSaveSettings(...a),
    loadSettings: mockNoop,
    recipeCategories: NO_CATS,
    platformSupport: null,
    savePlatformSupport: mockNoop,
    planPrices: null,
    savePlatformPlanPrices: mockNoop,
  }),
}))

jest.mock('../context/ThemeContext', () => ({
  useTheme: () => ({ themeKey: 'dark', colors: NO_COLORS, switchPreset: mockNoop, updateColor: mockNoop }),
  PRESETS: {},
  SYSTEM_KEY: 'system',
}))

jest.mock('../shared/fetchAllRows', () => ({ fetchAllRows: async () => ({ data: [], error: null }) }))
jest.mock('../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    scopedFrom: () => ({ eq: () => ({ order: () => ({ order: async () => ({ data: [], error: null }) }) }) }),
    scopedUpdate: () => ({ eq: async () => ({ error: null }) }),
  }),
}))

const Settings = require('./Settings').default
const { PAGE_FIELDS, CONSULTANT_FIELDS } = require('./Settings')

const renderSettings = () => render(<MemoryRouter><Settings /></MemoryRouter>)
const tab = name => fireEvent.click(screen.getByRole('tab', { name }))
const click = name => fireEvent.click(screen.getByRole('button', { name }))

beforeEach(() => {
  mockRow = { ...ROW }
  mockClientId = 'client-1'
  mockSaveSettings.mockClear()
})

describe('the consultant card', () => {
  it('has its three columns in the field list the page save walks', () => {
    for (const k of CONSULTANT_FIELDS) expect(PAGE_FIELDS).toContain(k)
  })

  it('writes the consultant fields it edits, and only those', async () => {
    renderSettings()
    tab('Support')
    fireEvent.change(screen.getByLabelText(/Consultant phone/i), { target: { value: '9801234567' } })
    fireEvent.change(screen.getByLabelText(/Consultant email/i), { target: { value: ' adv@firm.np ' } })
    click(/Save Consultant/i)
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalledTimes(1))
    // Trimmed, and nothing else: not the branding on the tab beside it, and not another page's column.
    expect(mockSaveSettings.mock.calls[0][0]).toEqual({ contact_phone: '9801234567', contact_email: 'adv@firm.np' })
  })

  it('does not commit an unsaved edit from another tab', async () => {
    renderSettings()
    tab('Branding')
    fireEvent.change(screen.getByLabelText(/Property Name/i), { target: { value: 'Renamed' } })
    tab('Support')
    fireEvent.change(screen.getByLabelText(/Consultant website/i), { target: { value: 'firm.np' } })
    click(/Save Consultant/i)
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalledTimes(1))
    expect(mockSaveSettings.mock.calls[0][0]).toEqual({ contact_website: 'firm.np' })
  })
})

describe('a stored threshold the admin has no tab for', () => {
  it('does not block a branding save, and selects no missing tab', async () => {
    renderSettings()
    tab('Branding')
    fireEvent.change(screen.getByLabelText(/Property Name/i), { target: { value: 'Casa Acai Kitchen' } })
    click(/Save Changes/i)
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalledTimes(1))
    expect(mockSaveSettings.mock.calls[0][0]).toEqual({ app_name: 'Casa Acai Kitchen' })
    expect(screen.queryByText(/a threshold needs correcting/i)).toBeNull()
    // Exactly one tab stays selected, and it is one the admin actually has.
    const selected = screen.getAllByRole('tab', { selected: true })
    expect(selected).toHaveLength(1)
    expect(selected[0]).toHaveTextContent('Branding')
  })
})

describe('the two Property fields that rewrite issued documents', () => {
  it('asks before changing the invoice prefix, and writes only on confirm', async () => {
    renderSettings()
    tab('Property')
    fireEvent.change(screen.getByLabelText(/Invoice Prefix/i), { target: { value: 'CASA' } })
    click(/Save Changes/i)
    // The number is assembled when a bill is PRINTED, so this reaches every bill already issued.
    await screen.findByText(/Change the invoice code\?/i)
    expect(mockSaveSettings).not.toHaveBeenCalled()
    click(/Save anyway/i)
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalledWith({ invoice_prefix: 'CASA' }))
  })

  it('asks before switching the bill type, and writes nothing if cancelled', async () => {
    renderSettings()
    tab('Property')
    fireEvent.click(screen.getByLabelText(/VAT Registered/i))
    click(/Save Changes/i)
    await screen.findByText(/Change the bill type\?/i)
    click(/Cancel/i)
    await waitFor(() => expect(screen.queryByText(/Change the bill type\?/i)).toBeNull())
    expect(mockSaveSettings).not.toHaveBeenCalled()
  })

  it('saves an address with no question at all', async () => {
    renderSettings()
    tab('Property')
    fireEvent.change(screen.getByLabelText(/^Address/i), { target: { value: 'Jhamsikhel' } })
    click(/Save Changes/i)
    await waitFor(() => expect(mockSaveSettings).toHaveBeenCalledWith({ property_address: 'Jhamsikhel' }))
  })
})

describe('with no client selected', () => {
  it('offers no Property fields and no Save, because nothing reads them off the platform row', () => {
    mockClientId = null
    renderSettings()
    tab('Property')
    expect(screen.queryByLabelText(/Invoice Prefix/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /Save Changes/i })).toBeNull()
    expect(screen.getByText(/Choose a client from the top bar/i)).toBeTruthy()
  })

  it('calls the platform row what it is on Branding', () => {
    mockClientId = null
    renderSettings()
    tab('Branding')
    expect(screen.getByLabelText(/App Name/i)).toBeTruthy()
    expect(screen.queryByLabelText(/Property Name/i)).toBeNull()
  })

  it('and names the client when one IS selected', () => {
    renderSettings()
    tab('Branding')
    expect(screen.getByLabelText(/Property Name/i)).toBeTruthy()
    expect(screen.queryByLabelText(/^App Name/i)).toBeNull()
  })
})
