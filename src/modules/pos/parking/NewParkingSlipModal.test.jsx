/**
 * The Bill Number picker's read of today's bills has a time limit (S842). A read that never answered
 * left "Loading…" in the picker for as long as the dialog stayed open; after 20 seconds it now says
 * the bills could not be loaded, the same as a refused read. Since the 2026-10-15 audit leftovers a
 * failed read offers Try again, which reads once more, instead of "close and reopen to retry".
 */

import React from 'react'
import { render, screen, act, fireEvent } from '@testing-library/react'

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

const FAILED = "Could not load today's bills"
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

test('a failed read offers Try again, which reads the bills once more', async () => {
  let calls = 0
  mockBillsAnswer = () => {
    calls += 1
    return calls === 1
      ? Promise.resolve({ data: null, error: { message: 'Failed to fetch' } })
      : Promise.resolve({ data: [{ id: 'o1', order_no: 7, invoice_no: 'INV-7', table_name: 'T1', paid_amount: 1250 }], error: null })
  }
  renderModal()
  expect(await screen.findByText(FAILED)).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toMatch(/could not be loaded/)
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  expect(await screen.findByText('— None —')).toBeTruthy()
  expect(calls).toBe(2)
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})

test('no Try again while the read is still out or after it answered', async () => {
  mockBillsAnswer = () => Promise.resolve({ data: [], error: null })
  renderModal()
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  expect(await screen.findByText('No bills issued today yet')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})
