/**
 * A till PIN session that ends by itself keeps the unsent cart the way a lock does (S833, S809.4;
 * owner decision S776). AuthContext hears the ending (supabase's SIGNED_OUT without a sign-out of
 * ours) and runs the same before-lock event the lock runs, once, under the ending login's id.
 */

import React from 'react'
import { render, screen, act } from '@testing-library/react'
import { POS_BEFORE_LOCK_EVENT } from '../modules/pos/posLockedCart'

let mockAuthListener = null
let mockProfile = null

const mockBuilder = result => {
  const b = {
    select: () => b, eq: () => b, in: () => b, order: () => b, update: () => b,
    single: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (ok, err) => Promise.resolve(result).then(ok, err),
  }
  return b
}

jest.mock('../supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: cb => {
        mockAuthListener = cb
        return { data: { subscription: { unsubscribe: () => {} } } }
      },
    },
    from: table => mockBuilder(table === 'profiles' ? { data: mockProfile, error: null } : { data: null, error: null }),
    rpc: () => Promise.resolve({ data: null, error: null }),
  },
}))
jest.mock('../utils/sessionKeepAlive', () => ({ startSessionKeepAlive: () => () => {} }))
// Our own sign-out: supabase raises SIGNED_OUT inside the call, as auth-js does.
jest.mock('../shared/deviceSignOut', () => ({
  signOutThisDevice: async () => {
    await mockAuthListener('SIGNED_OUT', null)
    return true
  },
}))

// eslint-disable-next-line import/first
import { AuthProvider, useAuth } from './AuthContext'

let auth = null
function Probe() {
  auth = useAuth()
  return <p>{auth.profile?.id || 'no profile'}</p>
}

const pin = { id: 'u-ram', role: 'client', client_id: null, pos_role: 'staff', pos_email: 'ram@pos' }

async function signedInAs(profile) {
  mockProfile = profile
  const view = render(<AuthProvider><Probe /></AuthProvider>)
  await act(async () => { await mockAuthListener('SIGNED_IN', { user: { id: profile.id } }) })
  expect(await screen.findByText(profile.id)).toBeTruthy()
  return view
}

const endedByItself = () => act(async () => { await mockAuthListener('SIGNED_OUT', null) })

let events = []
const onLock = e => events.push({ reason: e.detail.reason, profileId: e.detail.profileId })

beforeEach(() => {
  localStorage.clear()
  events = []
  window.addEventListener(POS_BEFORE_LOCK_EVENT, onLock)
})
afterEach(() => window.removeEventListener(POS_BEFORE_LOCK_EVENT, onLock))

it('keeps the cart once, under the ending login, when a till PIN session ends by itself', async () => {
  localStorage.setItem('pos_device_client_id', 'c-1')
  const view = await signedInAs(pin)
  await endedByItself()
  expect(events).toEqual([{ reason: 'ended', profileId: 'u-ram' }])
  // A second sign-out event for the same ending runs nothing more.
  await endedByItself()
  expect(events).toHaveLength(1)
  view.unmount()
})

it('does not run it again on our own sign-out, which the lock already ran it for', async () => {
  localStorage.setItem('pos_device_client_id', 'c-1')
  const view = await signedInAs(pin)
  await act(async () => { await auth.signOut({ to: '/pos/login', scope: 'local' }) })
  expect(events).toEqual([])
  view.unmount()
})

it('never for an Owner session, nor on a browser that is not an activated till', async () => {
  localStorage.setItem('pos_device_client_id', 'c-1')
  let view = await signedInAs({ id: 'u-owner', role: 'client', client_id: null })
  await endedByItself()
  view.unmount()

  localStorage.clear()
  view = await signedInAs(pin)
  await endedByItself()
  view.unmount()
  expect(events).toEqual([])
})
