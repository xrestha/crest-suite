/**
 * The Crest Staff PIN pad signs in once per PIN typed (S890). Its keyboard listener ran the
 * handleSignIn of the render that subscribed it, and it was re-subscribed only when the employee or
 * the PIN changed, so a second Enter while the first sign-in was still in flight saw signingIn false
 * and sent the PIN again: two attempts towards the lockout for one PIN.
 */

import React from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// Plain functions, not jest.fn: CRA resets mock implementations before every test.
const mockRpcCalls = []
const mockInvokeCalls = []
// hr-selfservice-login's own call: a function, so a test can hold the answer back.
let mockSignInCall = () => Promise.resolve({ data: null, error: null })
jest.mock('../../../supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => {
      mockRpcCalls.push([name, args])
      return Promise.resolve({ data: [{ id: 'e-1', full_name: 'Maya' }], error: null })
    },
    functions: { invoke: (name, opts) => { mockInvokeCalls.push([name, opts]); return mockSignInCall() } },
    auth: { setSession: () => Promise.resolve({ data: {}, error: null }) },
  },
}))
jest.mock('../../../context/ThemeContext', () => ({ useTheme: () => ({ colors: { bg: '#111111' } }) }))

// eslint-disable-next-line import/first
import SelfServiceLogin from './SelfServiceLogin'

const CLIENT = '11111111-2222-3333-4444-555555555555'
const renderPad = () => render(
  <MemoryRouter initialEntries={[`/staff/${CLIENT}`]}>
    <Routes>
      <Route path="/staff/:clientId" element={<SelfServiceLogin />} />
      <Route path="/hr/self-service" element={<p>HOME</p>} />
    </Routes>
  </MemoryRouter>
)

beforeEach(() => {
  mockRpcCalls.length = 0
  mockInvokeCalls.length = 0
  mockSignInCall = () => Promise.resolve({ data: null, error: null })
  localStorage.clear()
})

describe('signing in from the keyboard', () => {
  it('a second Enter while the sign-in is in flight sends nothing more, and Enter works again after', async () => {
    let answer
    mockSignInCall = () => new Promise(resolve => { answer = resolve })
    renderPad()
    fireEvent.click(await screen.findByRole('button', { name: /Maya/ }))
    for (const key of ['1', '2', '3', '4']) fireEvent.keyDown(window, { key })
    fireEvent.keyDown(window, { key: 'Enter' })
    await screen.findByRole('button', { name: 'Signing in…' })
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(mockInvokeCalls).toEqual([['hr-selfservice-login', { body: { staff_id: 'e-1', pin: '1234' } }]])

    // The answer carries no session: the connection, so the PIN is kept, and Enter must send again.
    mockSignInCall = () => Promise.resolve({ data: null, error: null })
    await act(async () => { answer({ data: null, error: null }) })
    await screen.findByRole('button', { name: /Login/ })
    expect(screen.getByText('4 digits entered')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(mockInvokeCalls).toHaveLength(2)
    await screen.findByRole('button', { name: /Login/ })
    // The staff list was read once: re-subscribing the listener reads nothing again.
    expect(mockRpcCalls.filter(([name]) => name === 'get_hr_self_service_staff')).toHaveLength(1)
  })
})
