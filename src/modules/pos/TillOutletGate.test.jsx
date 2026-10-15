/**
 * A till stopped in another outlet says why "Back to …" failed in words its reader can act on (S842).
 * A dropped connection reached a waiter as "TypeError: Failed to fetch", the raw text as the headline.
 * It goes through the error table now, with the raw text kept as the fine print, worded for a PIN
 * login (who can only escalate) or for the Owner (who fixes it). set_active_outlet's own refusals are
 * sentences and are kept as written.
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'

let mockSwitchAnswer = {}
let mockAuth = {}
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../supabaseClient', () => ({ supabase: {} }))

// eslint-disable-next-line import/first
import TillOutletGate from './TillOutletGate'

const authFor = profile => ({
  clientId: 'c-2', isAdmin: false, profile,
  outlets: [{ id: 'c-1', name: 'Thamel' }, { id: 'c-2', name: 'Lazimpat' }],
  outletHeld: null, returnToOutlet: () => Promise.resolve(mockSwitchAnswer), switchAdminClient: () => {},
  adminViewClientName: '', checkOutlet: () => {}, clientModules: { pos: true }, clientModulesKnown: true,
})

const pressBack = async () => {
  render(<TillOutletGate><p>TILL</p></TillOutletGate>)
  expect(screen.queryByText('TILL')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Back to Thamel' }))
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('pos_device_client_id', 'c-1') // this tablet is Thamel's till
  mockSwitchAnswer = {}
})

test('a dropped connection reads as one to a PIN login, with the raw text only as fine print', async () => {
  mockAuth = authFor({ id: 'p1', pos_email: 'ram@pos.local' })
  mockSwitchAnswer = { error: { message: 'TypeError: Failed to fetch', code: '', details: '', hint: '' } }
  await pressBack()
  const headline = await screen.findByText("You're offline, or the connection dropped. Check your signal and try again.")
  expect(headline.className).toBe('action-error-text')
  expect(screen.getByText('TypeError: Failed to fetch').className).toBe('action-error-detail')
})

test('the Owner on the till gets the operator wording', async () => {
  mockAuth = authFor({ id: 'o1', clients: { name: 'Lazimpat' } })
  mockSwitchAnswer = { error: { message: 'TypeError: Failed to fetch', code: '', details: '', hint: '' } }
  await pressBack()
  expect(await screen.findByText("Couldn't reach the server — you're offline, or the connection dropped. Check your internet and try again.")).toBeTruthy()
})

test('a thrown failure with no code is not shown raw either', async () => {
  mockAuth = authFor({ id: 'p1', pos_email: 'ram@pos.local' })
  mockAuth.returnToOutlet = () => Promise.reject(new Error('Cannot read properties of undefined (reading \'id\')'))
  await pressBack()
  const detail = await screen.findByText("Cannot read properties of undefined (reading 'id')")
  expect(detail.className).toBe('action-error-detail')
})

test('set_active_outlet\'s own refusal keeps its sentence', async () => {
  mockAuth = authFor({ id: 'p1', pos_email: 'ram@pos.local' })
  mockSwitchAnswer = { error: { code: 'P0001', message: 'This login cannot work in Thamel any more.' } }
  await pressBack()
  expect((await screen.findByText('This login cannot work in Thamel any more.')).className).toBe('action-error-text')
})
