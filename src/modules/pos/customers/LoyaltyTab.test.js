import { render, screen, fireEvent } from '@testing-library/react'
import LoyaltyTab from './LoyaltyTab'

// S833 (S809.4 3k): with no scheme the members still show with their points, and "+ Add scheme" with no
// name says what is missing instead of sitting greyed out. The tab's reads are faked: a builder that
// answers both an awaited query (the schemes) and fetchAllRows' paged `.range()` (customers, balances).
// jest.mock factories may only reach variables named mock*; they are read at call time, not hoisting time.
// Plain functions, not jest.fn: CRA resets every mock's implementation before each test.
const mockData = { schemes: [], members: [], balances: [] }
function mockBuilder(rows) {
  const answer = () => Promise.resolve({ data: rows, error: null })
  const b = { order: () => b, range: answer, then: (ok, bad) => answer().then(ok, bad) }
  return b
}
const mockScoped = {
  clientId: 'c1',
  scopedFrom: table => mockBuilder(table === 'pos_loyalty_schemes' ? mockData.schemes : mockData.members),
  scopedInsert: jest.fn(),
  scopedUpdate: jest.fn(),
  scopedDelete: jest.fn(),
}
jest.mock('../../../supabaseClient', () => ({
  supabase: { rpc: () => mockBuilder(mockData.balances), from: () => mockBuilder([]), auth: {} },
}))
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScoped }))

const sita = { id: 'm1', name: 'Sita', phone: '9800000001', loyalty_scheme_id: null, loyalty_enrolled_at: null }
const ram = { id: 'm2', name: 'Ram', phone: '9800000002', loyalty_scheme_id: null, loyalty_enrolled_at: null }

beforeEach(() => {
  mockData.schemes = []
  mockData.members = [sita, ram]
  mockData.balances = [{ customer_id: 'm1', balance: 120, held: 0 }]
  mockScoped.scopedInsert.mockReset()
})

describe('LoyaltyTab with no scheme', () => {
  test('members and their points are listed, with History and the ⋯ menu, under a note', async () => {
    render(<LoyaltyTab pointValue={1} canManage onPointValueSaved={jest.fn()} />)
    expect(await screen.findByText('Sita')).toBeInTheDocument()
    expect(screen.getByText('Ram')).toBeInTheDocument()
    expect(screen.getByText('120')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Points history for Sita' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More for Sita' })).toBeInTheDocument()
    const note = screen.getByRole('note')
    expect(note).toHaveTextContent('No scheme exists, so nobody earns new points.')
    expect(note).toHaveTextContent('can still be spent at the till, adjusted or moved.')
    // Nothing to pick, so each row says where it stands rather than offering a one-option list.
    expect(screen.queryByRole('combobox', { name: /Loyalty scheme for/ })).not.toBeInTheDocument()
    expect(screen.getAllByText('Not enrolled')).toHaveLength(2)
  })

  test('a supervisor sees the members read-only, and the note says who adds a scheme', async () => {
    render(<LoyaltyTab pointValue={1} onPointValueSaved={jest.fn()} />)
    expect(await screen.findByText('Sita')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More for Sita' })).not.toBeInTheDocument()
    const note = screen.getAllByRole('note').find(n => n.textContent.includes('No scheme exists'))
    expect(note).toHaveTextContent('A POS manager or the Owner adds schemes.')
    expect(note).toHaveTextContent('can still be spent at the till.')
    expect(note).not.toHaveTextContent('adjusted')
  })

  test('with nobody holding points the note does not talk about kept points', async () => {
    mockData.balances = []
    render(<LoyaltyTab pointValue={1} canManage onPointValueSaved={jest.fn()} />)
    await screen.findByText('Sita')
    expect(screen.getByRole('note')).not.toHaveTextContent('already hold')
  })
})

describe('+ Add scheme with no name', () => {
  test('stays pressable, says what is missing, moves to the name box and adds nothing', async () => {
    render(<LoyaltyTab pointValue={1} canManage onPointValueSaved={jest.fn()} />)
    const add = await screen.findByRole('button', { name: '+ Add scheme' })
    expect(add).not.toBeDisabled()
    expect(add).toHaveAttribute('aria-disabled', 'true')

    fireEvent.click(add)
    const name = screen.getByLabelText('Name')
    expect(screen.getByText('Type a scheme name first.')).toBeInTheDocument()
    expect(name).toHaveFocus()
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(mockScoped.scopedInsert).not.toHaveBeenCalled()

    // Typing a name clears the message and the button is an ordinary one again.
    fireEvent.change(name, { target: { value: 'Regulars' } })
    expect(screen.queryByText('Type a scheme name first.')).not.toBeInTheDocument()
    expect(name).not.toHaveAttribute('aria-invalid')
    expect(add).not.toHaveAttribute('aria-disabled')
  })
})
