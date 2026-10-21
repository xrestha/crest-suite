/**
 * The stock-count PIN screen on a device that is not set up (S855). It was one 13px paragraph,
 * centred, telling a counter to "ask your manager"; it is the POS till's DeviceGate now: what to do
 * in order, who can do it, Crest support for a stuck floor, and the email door kept.
 */

import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

// What each RPC answers, set per test. Plain functions, not jest.fn: CRA resets mock
// implementations before every test (the PosLogin.test.jsx shape).
let mockRpcAnswers = {}
const mockRpcCalls = []
jest.mock('../../../supabaseClient', () => ({
  supabase: {
    rpc: (name, args) => {
      mockRpcCalls.push([name, args])
      return Promise.resolve(mockRpcAnswers[name] || { data: [], error: null })
    },
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    auth: { setSession: () => Promise.resolve({ data: {}, error: null }) },
  },
}))
jest.mock('../../../context/ThemeContext', () => ({ useTheme: () => ({ colors: { bg: '#111111' } }) }))

// eslint-disable-next-line import/first
import ImsCountLogin from './ImsCountLogin'

const renderCount = () => render(
  <MemoryRouter initialEntries={['/ims/count']}>
    <Routes>
      <Route path="/ims/count" element={<ImsCountLogin />} />
      <Route path="/login" element={<p>Email sign-in page</p>} />
    </Routes>
  </MemoryRouter>
)

const setUpDevice = () => {
  localStorage.setItem('ims_count_client_id', 'client-1')
  localStorage.setItem('ims_count_client_name', 'Cafe One')
  localStorage.setItem('ims_count_device_secret', 'secret-1')
}

beforeEach(() => {
  mockRpcAnswers = {}
  mockRpcCalls.length = 0
  localStorage.clear()
  window.history.replaceState(null, '', '/ims/count')
})

describe('a device that is not set up', () => {
  it('says how to set it up as numbered steps, who can do it, and who to ask', async () => {
    renderCount()
    await screen.findByRole('heading', { level: 1, name: 'This device is not set up yet' })
    expect(screen.getByText('Counters sign in with a PIN only on a device the Owner or an IMS manager has set up.')).toBeTruthy()
    const steps = within(screen.getByRole('list')).getAllByRole('listitem').map(li => li.textContent)
    expect(steps).toEqual([
      'On your own phone or computer, sign in with the Owner account or an IMS manager login.',
      'Open Stock Count → Settings and press Show setup QR.',
      'Scan the code with this device camera within 15 minutes. Your counters then show here.',
    ])
    expect(screen.getByText('Ask the Owner or an IMS manager to do this. A counting PIN cannot set up a device.')).toBeTruthy()
    expect(screen.getByText(/Stuck\? Crest support:/)).toBeTruthy()
    // Nothing went wrong on this device, so nothing is announced and no roster is asked for.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(mockRpcCalls).toEqual([])
  })

  it('bolds the place to go and the button to press, as the till screen does', async () => {
    renderCount()
    await screen.findByRole('heading', { level: 1, name: 'This device is not set up yet' })
    const bold = within(screen.getByRole('list')).getAllByText((_, el) => el.tagName === 'STRONG').map(el => el.textContent)
    expect(bold).toEqual(['Stock Count → Settings', 'Show setup QR'])
  })

  it('keeps the email door, which opens the main sign-in page', async () => {
    renderCount()
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with an email instead' }))
    expect(await screen.findByText('Email sign-in page')).toBeTruthy()
  })
})

describe('what went wrong on this device', () => {
  it('a device signed out by a manager says so, forgets its key and shows the steps', async () => {
    setUpDevice()
    mockRpcAnswers.get_ims_count_staff = { data: null, error: { message: 'ims_device_not_active' } }
    renderCount()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('This tablet was signed out by your manager.')
    expect(within(alert).getByRole('heading', { level: 1, name: 'This device is not set up yet' })).toBeTruthy()
    expect(within(alert).getAllByRole('listitem')).toHaveLength(3)
    expect(localStorage.getItem('ims_count_device_secret')).toBeNull()
  })

  it('an expired setup code says so, and the email door is still there', async () => {
    window.history.replaceState(null, '', '/ims/count#e=abc123')
    mockRpcAnswers.redeem_ims_enrol_token = { data: null, error: { message: 'not valid' } }
    renderCount()
    expect(await screen.findByRole('alert')).toHaveTextContent('That setup code has expired or is not valid any more.')
    expect(mockRpcCalls[0]).toEqual(['redeem_ims_enrol_token', { p_token: 'abc123' }])
    // The token never stays in the address bar of a shared tablet.
    expect(window.location.hash).toBe('')
    expect(screen.getByRole('button', { name: 'Sign in with an email instead' })).toBeTruthy()
  })
})

it('a device that is set up shows its counters, not the set-up screen', async () => {
  setUpDevice()
  mockRpcAnswers.get_ims_count_staff = { data: [{ id: 'p-1', full_name: 'Maya' }], error: null }
  renderCount()
  expect(await screen.findByRole('button', { name: /Maya/ })).toBeTruthy()
  expect(screen.queryByText('This device is not set up yet')).toBeNull()
})
