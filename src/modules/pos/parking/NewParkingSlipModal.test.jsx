/**
 * The Bill Number picker's read of today's bills has a time limit (S842). A read that never answered
 * left "Loading…" in the picker for as long as the dialog stayed open; after 20 seconds it now says
 * the bills could not be loaded, the same as a refused read.
 */

import React from 'react'
import { render, screen, act } from '@testing-library/react'

// The bills read's answer: a promise the test controls (one that never settles, by default).
let mockBillsAnswer = () => new Promise(() => {})
function mockBuilder() {
  const b = {}
  for (const op of ['eq', 'not', 'gte', 'order']) b[op] = () => b
  b.then = (ok, fail) => mockBillsAnswer().then(ok, fail)
  return b
}
const mockScopedDb = { scopedFrom: () => mockBuilder(), scopedInsert: () => mockBuilder() }
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => mockScopedDb }))
jest.mock('../../../supabaseClient', () => ({ supabase: {} }))
jest.mock('../../../context/AuthContext', () => ({
  useAuth: () => ({ clientId: 'c1', profile: { id: 'u1', full_name: 'Sita' }, hasPosAccess: () => true }),
}))

// eslint-disable-next-line import/first
import NewParkingSlipModal from './NewParkingSlipModal'

const FAILED = "Could not load today's bills — close and reopen to retry"
const renderModal = () => render(<NewParkingSlipModal outletName="Casa Acai" propertyAddress="Thamel" onClose={() => {}} onIssued={() => {}} />)

beforeEach(() => { mockBillsAnswer = () => new Promise(() => {}) })
afterEach(() => jest.useRealTimers())

test('a bills read with no answer gives up after 20 seconds and says so', async () => {
  jest.useFakeTimers()
  renderModal()
  expect(screen.getByText('Loading…')).toBeTruthy()
  await act(async () => { jest.advanceTimersByTime(19000) })
  expect(screen.getByText('Loading…')).toBeTruthy()
  await act(async () => { jest.advanceTimersByTime(1000) })
  expect(screen.getByText(FAILED)).toBeTruthy()
  expect(screen.queryByText('Loading…')).toBeNull()
})

test('a refused read says the same', async () => {
  mockBillsAnswer = () => Promise.resolve({ data: null, error: { message: 'permission denied', code: '42501' } })
  renderModal()
  expect(await screen.findByText(FAILED)).toBeTruthy()
})

test('no bills yet is not a failure', async () => {
  mockBillsAnswer = () => Promise.resolve({ data: [], error: null })
  renderModal()
  expect(await screen.findByText('No bills issued today yet')).toBeTruthy()
})
