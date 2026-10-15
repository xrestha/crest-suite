import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react'
import LoyaltyTab from './LoyaltyTab'

// S833 (S809.4 3k): with no scheme the members still show with their points, and "+ Add scheme" with no
// name says what is missing instead of sitting greyed out. The tab's reads are faked: a builder that
// answers both an awaited query (the schemes) and fetchAllRows' paged `.range()` (customers, balances).
// jest.mock factories may only reach variables named mock*; they are read at call time, not hoisting time.
// Plain functions, not jest.fn: CRA resets every mock's implementation before each test.
const mockData = { schemes: [], members: [], balances: [] }
// S834: a read answers with the rows above unless a test sets mockAnswer[kind] to a function returning
// the answer's promise instead: a failure, a read that never answers, or one the test settles itself.
const mockAnswer = {}
function mockBuilder(kind) {
  const answer = () => (mockAnswer[kind] ? mockAnswer[kind]() : Promise.resolve({ data: mockData[kind] || [], error: null }))
  const b = { order: () => b, range: answer, then: (ok, bad) => answer().then(ok, bad) }
  return b
}
const mockScoped = {
  clientId: 'c1',
  scopedFrom: table => mockBuilder(table === 'pos_loyalty_schemes' ? 'schemes' : 'members'),
  scopedInsert: jest.fn(),
  scopedUpdate: jest.fn(),
  scopedDelete: jest.fn(),
}
jest.mock('../../../supabaseClient', () => ({
  supabase: { rpc: () => mockBuilder('balances'), from: () => mockBuilder('none'), auth: {} },
}))
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScoped }))

const sita = { id: 'm1', name: 'Sita', phone: '9800000001', loyalty_scheme_id: null, loyalty_enrolled_at: null }
const ram = { id: 'm2', name: 'Ram', phone: '9800000002', loyalty_scheme_id: null, loyalty_enrolled_at: null }

beforeEach(() => {
  mockData.schemes = []
  mockData.members = [sita, ram]
  mockData.balances = [{ customer_id: 'm1', balance: 120, held: 0 }]
  mockScoped.scopedInsert.mockReset()
  for (const k of Object.keys(mockAnswer)) delete mockAnswer[k]
  jest.spyOn(console, 'error').mockImplementation(() => {}) // the failed reads below log on purpose
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

// S834 (found S833): the tab's reads are bounded, a failed reload keeps what is on screen, and of two
// overlapping reloads only the newer one lands.
const scheme = (id, name) => ({ id, name, points_per_100: 1, min_spend_to_earn: 0, is_active: true })
const refused = () => Promise.resolve({ data: null, error: { code: '42501', message: 'permission denied for table pos_customers' } })

async function addScheme(name) {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: '+ Add scheme' }))
}

describe('LoyaltyTab reads', () => {
  test('a failed first read is the error card, with no member or points on screen', async () => {
    mockAnswer.balances = refused
    render(<LoyaltyTab pointValue={1} canManage onPointValueSaved={jest.fn()} />)
    expect(await screen.findByText('Could not load this report')).toBeInTheDocument()
    expect(screen.queryByText('Sita')).not.toBeInTheDocument()
    expect(screen.queryByText('120')).not.toBeInTheDocument()
  })

  test('a read that never answers becomes the error card, not "Loading loyalty…" for ever', async () => {
    jest.useFakeTimers()
    try {
      mockAnswer.members = () => new Promise(() => {})
      render(<LoyaltyTab pointValue={1} canManage onPointValueSaved={jest.fn()} />)
      expect(screen.getByText('Loading loyalty…')).toBeInTheDocument()
      await act(async () => { jest.advanceTimersByTime(19000) })
      expect(screen.getByText('Loading loyalty…')).toBeInTheDocument()
      await act(async () => { jest.advanceTimersByTime(1500) })
      expect(await screen.findByText('Could not load this report')).toBeInTheDocument()
      expect(screen.queryByText('Loading loyalty…')).not.toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
  })

  test('a reload that fails after an add keeps the list on screen and says it is as last read', async () => {
    mockScoped.scopedInsert.mockResolvedValue({ error: null })
    render(<LoyaltyTab pointValue={1} canManage onPointValueSaved={jest.fn()} />)
    await screen.findByText('Sita')
    mockAnswer.members = refused
    await addScheme('Regulars')
    expect(await screen.findByText(/Loyalty could not be read again/)).toBeInTheDocument()
    expect(screen.getByText('Sita')).toBeInTheDocument()
    expect(screen.getByText('120')).toBeInTheDocument()
    expect(screen.queryByText('Could not load this report')).not.toBeInTheDocument()

    // The next good read clears the line.
    delete mockAnswer.members
    mockData.schemes = [scheme('s1', 'Regulars')]
    await addScheme('Family')
    expect(await screen.findByRole('cell', { name: 'Regulars' })).toBeInTheDocument()
    expect(screen.queryByText(/Loyalty could not be read again/)).not.toBeInTheDocument()
  })

  test('of two overlapping reloads, the newer one wins whatever order they answer in', async () => {
    mockScoped.scopedInsert.mockResolvedValue({ error: null })
    render(<LoyaltyTab pointValue={1} canManage onPointValueSaved={jest.fn()} />)
    await screen.findByText('Sita')
    const pending = []
    mockAnswer.schemes = () => new Promise(resolve => pending.push(resolve))
    await addScheme('Older')
    await waitFor(() => expect(pending).toHaveLength(1))
    await addScheme('Newer')
    await waitFor(() => expect(pending).toHaveLength(2))

    await act(async () => { pending[1]({ data: [scheme('s2', 'Newer')], error: null }) })
    expect(await screen.findByRole('cell', { name: 'Newer' })).toBeInTheDocument()
    await act(async () => { pending[0]({ data: [scheme('s1', 'Older')], error: null }) })
    expect(screen.queryByRole('cell', { name: 'Older' })).not.toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Newer' })).toBeInTheDocument()
  })
})

// S842: the scheme counts come from one pass over the members, and the list follows a deferred copy of
// the search box. Same figures as before; this pins them.
describe('LoyaltyTab counts and search (S842)', () => {
  test("each scheme's Members count, the enrolled line, and a narrowed list's N of M", async () => {
    mockData.schemes = [scheme('s1', 'Regulars'), scheme('s2', 'Family')]
    mockData.members = [{ ...sita, loyalty_scheme_id: 's1' }, { ...ram, loyalty_scheme_id: 's1' },
      { id: 'm3', name: 'Gita', phone: '9800000003', loyalty_scheme_id: 's2', loyalty_enrolled_at: null },
      { id: 'm4', name: 'Hari', phone: '9800000004', loyalty_scheme_id: null, loyalty_enrolled_at: null }]
    render(<LoyaltyTab pointValue={1} canManage onPointValueSaved={jest.fn()} />)
    // The schemes table comes first; its sixth column is Members.
    await screen.findAllByRole('cell', { name: 'Regulars' })
    const membersOf = name => {
      const row = screen.getAllByRole('row').find(r => within(r).queryAllByRole('cell')[0]?.textContent === name)
      return within(row).getAllByRole('cell')[5]
    }
    expect(membersOf('Regulars')).toHaveTextContent(/^2$/)
    expect(membersOf('Family')).toHaveTextContent(/^1$/)
    expect(screen.getByText(/^3 of 4 customers enrolled\./)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Find a customer'), { target: { value: 'gita' } })
    expect(await screen.findByText('Showing 1 of 4.')).toBeInTheDocument()
    expect(screen.queryByText('Sita')).not.toBeInTheDocument()
    expect(screen.getByText('Gita')).toBeInTheDocument()
  })
})
