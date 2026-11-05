import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import Vendors, { nextVendorCodeAfter } from './Vendors'
import { payWithinError, payWithinValue, suggestedPayWithin, suggestionLabel } from './vendorFormRules'

// Every supabase call resolves through one table-aware stub: a chainable builder that records its
// calls and answers when awaited (the Items.loadSpeed.test.jsx pattern). jest.mock is hoisted above
// the imports by babel-jest, so the mocks are in place before Vendors.js loads.
const mockCalls = []
let mockRespond = () => ({ data: null, error: null })
function mockBuilder(table, first) {
  const calls = [['select', [first]]]
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') {
        return (ok, bad) => {
          mockCalls.push({ table, calls })
          return Promise.resolve(mockRespond(table, calls)).then(ok, bad)
        }
      }
      return (...args) => { calls.push([prop, args]); return proxy }
    },
  })
  return proxy
}

jest.mock('../../../supabaseClient', () => ({
  supabase: {
    from: table => mockBuilder(table),
    rpc: (name, params) => mockBuilder(`rpc:${name}`, params),
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  },
}))
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({
    clientId: 'c1',
    scopedFrom: (table, cols) => mockBuilder(table, cols),
    scopedInsert: (table, rows) => mockBuilder(table, rows),
    scopedUpsert: (table, rows) => mockBuilder(table, rows),
    scopedUpdate: (table, values) => mockBuilder(table, values),
    scopedDelete: table => mockBuilder(table),
  }),
}))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ clientId: 'c1', isAdmin: false, isOwner: true, hasImsAccess: () => true }),
}))
jest.mock('../../../context/SettingsContext', () => ({
  useSettings: () => ({ settings: { vendor_code_prefix: 'VND' } }),
}))

describe('nextVendorCodeAfter (S756: the prefix is escaped before it reaches RegExp)', () => {
  test('takes the max over matching codes, archived vendors included by the caller', () => {
    expect(nextVendorCodeAfter('vnd', ['VND-001', 'VND-009', null, 'VND-004'])).toBe('VND-010')
  })

  test('regex metacharacters in the prefix match literally', () => {
    expect(nextVendorCodeAfter('V.N', ['V.N-002', 'VXN-900'])).toBe('V.N-003')
    expect(nextVendorCodeAfter('A+', ['A+-001', 'AA-077'])).toBe('A+-002')
  })

  test('an invalid-pattern prefix does not throw', () => {
    expect(() => nextVendorCodeAfter('[', ['[-003'])).not.toThrow()
    expect(nextVendorCodeAfter('[', ['[-003'])).toBe('[-004')
  })
})

describe('the Pay within box (S885, owner decision 3)', () => {
  test('blank saves NULL (the 60-day default); whole days 0 to 365 save as numbers', () => {
    expect(payWithinError('')).toBeNull()
    expect(payWithinValue('  ')).toBeNull()
    expect(payWithinError('0')).toBeNull()
    expect(payWithinValue('0')).toBe(0)
    expect(payWithinError(' 365 ')).toBeNull()
    expect(payWithinValue(' 365 ')).toBe(365)
  })

  test('anything else is refused under the box, never saved as the default', () => {
    for (const bad of ['366', '30.5', '-1', 'abc', '30 days']) {
      expect(payWithinError(bad)).toMatch(/whole days from 0 to 365/)
    }
  })

  test('a terms note that says a number is offered only while the box is blank', () => {
    expect(suggestedPayWithin({ pay_within_days: '', payment_terms: 'Net 30' })).toBe(30)
    expect(suggestedPayWithin({ pay_within_days: '', payment_terms: 'COD' })).toBe(0)
    expect(suggestedPayWithin({ pay_within_days: '15', payment_terms: 'Net 30' })).toBeNull()
    expect(suggestedPayWithin({ pay_within_days: '', payment_terms: '50% advance' })).toBeNull()
    expect(suggestionLabel(30)).toBe('Use 30 days')
    expect(suggestionLabel(1)).toBe('Use 1 day')
    expect(suggestionLabel(0)).toBe('Use: due on delivery')
  })
})

describe('Vendors page: Pay within on the form and the list', () => {
  const vendorsOnFile = [
    { id: 'v1', name: 'Big Mart', vendor_code: 'VND-001', is_active: true, archived_at: null, pay_within_days: 15, payment_terms: 'Cheque on the 5th' },
    { id: 'v2', name: 'Kalimati Veg', vendor_code: 'VND-002', is_active: true, archived_at: null, pay_within_days: null, payment_terms: null },
  ]
  const isInsert = c => c.table === 'vendors' && typeof c.calls[0][1][0] === 'object' && c.calls[0][1][0] !== null

  beforeEach(() => {
    mockCalls.length = 0
    mockRespond = (table, calls) => {
      const first = calls[0][1][0]
      if (table === 'vendors' && typeof first === 'object' && first !== null) return { data: [{ id: 'v9', ...first }], error: null }
      if (table === 'vendors') return { data: vendorsOnFile, error: null }
      return { data: [], error: null }
    }
  })

  const renderPage = () => render(<MemoryRouter><Vendors /></MemoryRouter>)

  test('the list shows each supplier days, marks the default and keeps the note underneath', async () => {
    renderPage()
    await screen.findByText('Big Mart')
    expect(screen.getByText('Pay within 15 days')).toBeInTheDocument()
    expect(screen.getByText('Cheque on the 5th')).toBeInTheDocument()
    expect(screen.getByText('Pay within 60 days (default)')).toBeInTheDocument()
  })

  test('a note that says Net 30 is offered as 30 days, and the save sends the number', async () => {
    renderPage()
    await screen.findByText('Big Mart')
    fireEvent.click(screen.getByRole('button', { name: '+ Add Vendor' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/Vendor Name/), { target: { value: 'New Farm' } })
    fireEvent.change(within(dialog).getByLabelText(/Terms note/), { target: { value: 'Net 30' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use 30 days' }))
    expect(within(dialog).getByLabelText(/Pay within/)).toHaveValue('30')
    expect(within(dialog).queryByRole('button', { name: 'Use 30 days' })).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Vendor' }))
    await waitFor(() => expect(mockCalls.some(isInsert)).toBe(true))
    expect(mockCalls.find(isInsert).calls[0][1][0]).toMatchObject({
      name: 'New Farm', payment_terms: 'Net 30', pay_within_days: 30, vendor_code: 'VND-003',
    })
  })

  test('a blank box saves NULL, and a bad one is refused under the box with nothing sent', async () => {
    renderPage()
    await screen.findByText('Big Mart')
    fireEvent.click(screen.getByRole('button', { name: '+ Add Vendor' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText(/Vendor Name/), { target: { value: 'New Farm' } })
    fireEvent.change(within(dialog).getByLabelText(/Pay within/), { target: { value: '30.5' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Vendor' }))
    expect(await within(dialog).findByText(/whole days from 0 to 365/)).toBeInTheDocument()
    expect(mockCalls.some(isInsert)).toBe(false)

    fireEvent.change(within(dialog).getByLabelText(/Pay within/), { target: { value: '' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Vendor' }))
    await waitFor(() => expect(mockCalls.some(isInsert)).toBe(true))
    expect(mockCalls.find(isInsert).calls[0][1][0]).toMatchObject({ name: 'New Farm', pay_within_days: null, payment_terms: null })
  })
})
