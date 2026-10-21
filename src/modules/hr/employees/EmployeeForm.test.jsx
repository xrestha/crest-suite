import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import EmployeeForm from './EmployeeForm'

// S852: Activate on an inactive employee asks through the page's bounded confirm, with the
// consequence in the body, instead of a window.confirm, and writes only once it is confirmed.
//
// jest.mock factories may only reach variables named mock*; plain functions, not jest.fn.
const mockState = { writes: [] }
function mockRead() {
  const b = {}
  for (const op of ['select', 'eq', 'order', 'limit', 'not', 'in', 'is']) b[op] = () => b
  b.then = (ok, bad) => Promise.resolve({ data: [], error: null }).then(ok, bad)
  return b
}
function mockUpdate(table, patch) {
  mockState.writes.push({ table, patch })
  const b = {}
  for (const op of ['eq', 'select']) b[op] = () => b
  b.then = (ok, bad) => Promise.resolve({ data: [{ id: 'e1' }], error: null }).then(ok, bad)
  return b
}
// One object for every render: the form's read effects depend on `scopedFrom`.
const mockDb = { scopedFrom: () => mockRead(), scopedInsert: () => mockRead(), scopedUpdate: mockUpdate, scopedDelete: () => mockRead() }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockDb }))
jest.mock('../../../supabaseClient', () => ({ supabase: { rpc: () => Promise.resolve({ data: [], error: null }) } }))
jest.mock('../ownRecord', () => ({ useIsOwnEmployee: () => () => false }))

const SITA = { id: 'e1', full_name: 'Sita Rai', status: 'inactive', join_date: '2025-01-01', end_date: '2026-01-15' }

beforeEach(() => {
  mockState.writes = []
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => jest.restoreAllMocks())

test('Activate asks first, names the consequence, and writes only once confirmed', async () => {
  const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => true)
  const saved = []
  render(<EmployeeForm clientId="c1" employee={SITA} onSave={n => saved.push(n)} onClose={() => {}} />)
  // The settled-leaver check reads first; Activate waits for it.
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  fireEvent.click(screen.getByRole('button', { name: 'Activate' }))
  const dialog = await screen.findByRole('dialog', { name: 'Reactivate Sita Rai?' })
  expect(dialog).toHaveTextContent('They go back on every payroll picker: Payroll, the Roster, Attendance and Final Settlement.')
  expect(dialog).toHaveTextContent('Their End Date has passed.')
  expect(confirmSpy).not.toHaveBeenCalled()
  expect(mockState.writes).toEqual([])
  fireEvent.click(within(dialog).getByRole('button', { name: 'Reactivate' }))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(mockState.writes).toEqual([{ table: 'hr_employees', patch: { status: 'active' } }])
})
