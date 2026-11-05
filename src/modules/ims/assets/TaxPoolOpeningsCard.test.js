import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TaxPoolOpeningsCard from './TaxPoolOpeningsCard'

// S887: Save opening values awaited its upsert with no time limit, so a hung write left Save busy
// for good. It is bounded now, and an answer that never came back reads as not known yet (the write
// may still land), never as not saved. A refusal from the server keeps its own wording.

jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: jest.fn(), from: jest.fn(), auth: {} } }))
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ clientId: 'c1' }) }))

// Every read answers empty: no typed openings, no posted years, no corrections, so every pool is
// editable.
function mockQuery() {
  const q = {}
  for (const m of ['eq', 'lte', 'gte', 'order', 'in', 'select', 'neq', 'limit']) q[m] = () => q
  q.then = (ok, bad) => Promise.resolve({ data: [], error: null }).then(ok, bad)
  return q
}
const mockUpsert = jest.fn()
jest.mock('../../../shared/hooks/useScopedDb', () => ({
  useScopedDb: () => ({ scopedFrom: () => mockQuery(), scopedUpsert: (...a) => mockUpsert(...a), scopedDelete: () => mockQuery() }),
}))

const timedOut = () => Object.assign(new Error('Saving the opening values timed out after 20s'), { name: 'TimeoutError' })

beforeEach(() => { mockUpsert.mockReset() })

async function typeAndSave() {
  const onChanged = jest.fn()
  render(<TaxPoolOpeningsCard fyLabel="82/83" priorLabel="81/82" canEdit onChanged={onChanged} onCorrected={() => {}} refreshKey={0} />)
  const box = await screen.findByLabelText('Pool A opening written-down value (NPR)')
  fireEvent.change(box, { target: { value: '50000' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save opening values' }))
  return onChanged
}

test('a save whose answer never came back reads as not known yet, and Save is free again', async () => {
  mockUpsert.mockResolvedValue({ data: null, error: timedOut() })
  const onChanged = await typeAndSave()

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(/whether the opening values saved is not known yet/)
  expect(alert).not.toHaveTextContent(/not saved|nothing was changed/)
  expect(mockUpsert).toHaveBeenCalledWith('assets_tax_pool_openings',
    [expect.objectContaining({ pool: 'A', fiscal_year: '82/83', opening_wdv: 50000 })], { onConflict: 'client_id,pool' })
  expect(onChanged).toHaveBeenCalled()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save opening values' })).not.toBeDisabled())
})

test('a refusal from the server keeps its own wording', async () => {
  mockUpsert.mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied for table assets_tax_pool_openings' } })
  await typeAndSave()

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(/may not all have saved/)
  expect(alert).not.toHaveTextContent(/not known yet/)
})
