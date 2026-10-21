/**
 * The signed-out pages (S852): the failure sentences that replaced raw GoTrue text on the
 * forgot-password request and the password update, the per-page tab titles, the header links,
 * and the sign-up autocomplete tokens.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Plain functions, not jest.fn(): CRA's resetMocks clears a jest.fn's implementation before
// every test, and ResetPassword reads onAuthStateChange's return value on mount.
jest.mock('../supabaseClient', () => ({
  supabase: {
    functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
    auth: {
      resetPasswordForEmail: () => Promise.resolve({ error: null }),
      updateUser: () => Promise.resolve({ error: null }),
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}))

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ signIn: () => Promise.resolve({ error: null }), session: null, ready: true, profile: null }),
}))

jest.mock('../context/SettingsContext', () => ({
  useSettings: () => ({ settings: { app_name: 'Sunrise Cafe' }, platformSupport: null }),
}))

const Login = require('./Login').default
const { resetRequestError } = require('./Login')
const Signup = require('./Signup').default
const ResetPassword = require('./ResetPassword').default
const { passwordUpdateError } = require('./ResetPassword')

const inRouter = (el, path = '/') => render(<MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>)

beforeEach(() => { document.title = 'Crest Suite' })

describe('resetRequestError (forgot password)', () => {
  it('says wait on a rate limit, and keeps the raw text as detail', () => {
    const e = resetRequestError({ status: 429, message: 'email rate limit exceeded' })
    expect(e.text).toMatch(/wait a minute/i)
    expect(e.detail).toContain('email rate limit exceeded')
  })

  it('treats GoTrue "for security purposes" throttling as a rate limit', () => {
    const e = resetRequestError({ status: 400, message: 'For security purposes, you can only request this after 47 seconds.' })
    expect(e.text).toMatch(/wait a minute/i)
  })

  it('never claims the link was or was not sent when the server was not reached', () => {
    const e = resetRequestError({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' })
    expect(e.text).toMatch(/may not have been sent/i)
    expect(e.text).not.toMatch(/TypeError|Failed to fetch/)
  })

  it('falls back to the shared error table, never the raw message as the headline', () => {
    const e = resetRequestError({ status: 400, message: 'unexpected_failure' })
    expect(e.text).not.toBe('unexpected_failure')
    expect(e.detail).toContain('unexpected_failure')
  })
})

describe('passwordUpdateError (reset password)', () => {
  it('names a reused password', () => {
    expect(passwordUpdateError({ status: 422, code: 'same_password', message: 'New password should be different from the old password.' }).text)
      .toMatch(/different from the old one/i)
  })

  it('names a breached password apart from a weak one', () => {
    expect(passwordUpdateError({ code: 'weak_password', reasons: ['pwned'], message: 'Password is known to be weak' }).text).toMatch(/data breach/i)
    expect(passwordUpdateError({ code: 'weak_password', reasons: ['length'], message: 'Password should be at least 8 characters.' }).text).toMatch(/not strong enough/i)
  })

  it('sends an expired link back to the sign-in page', () => {
    expect(passwordUpdateError({ name: 'AuthSessionMissingError', message: 'Auth session missing!' }).text).toMatch(/expired or was already used/i)
  })

  it('does not claim the password did not change when the server was not reached', () => {
    expect(passwordUpdateError({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }).text).toMatch(/not known whether/i)
  })
})

describe('tab titles', () => {
  it('names each signed-out page, with the brand the header shows', () => {
    const view = inRouter(<Login />, '/login')
    expect(document.title).toBe('Sign in · Sunrise Cafe')
    view.unmount()
    expect(document.title).toBe('Crest Suite')

    const utils = inRouter(<Signup />, '/signup')
    expect(document.title).toBe('Start your free trial · Sunrise Cafe')
    utils.unmount()

    inRouter(<ResetPassword />, '/reset-password')
    expect(document.title).toBe('Reset password · Sunrise Cafe')
  })
})

describe('header navigation is made of links', () => {
  it('on /login', () => {
    inRouter(<Login />, '/login')
    expect(screen.getByRole('link', { name: 'Pricing' }).getAttribute('href')).toBe('/pricing')
    expect(screen.getAllByRole('link', { name: /start .*free trial/i }).every(a => a.getAttribute('href') === '/signup')).toBe(true)
    expect(screen.getByRole('link', { name: /staff login/i }).getAttribute('href')).toBe('/pos/login')
  })

  it('on /signup', () => {
    inRouter(<Signup />, '/signup')
    expect(screen.getByRole('link', { name: 'Pricing' }).getAttribute('href')).toBe('/pricing')
    expect(screen.getByRole('link', { name: /sign in/i }).getAttribute('href')).toBe('/login')
  })
})

describe('the sign-in pitch', () => {
  it('carries the three owner-approved lines', () => {
    inRouter(<Login />, '/login')
    for (const line of [
      'Free plates look small one at a time. Crest adds them up.',
      'The right suggestion sells more. Crest shows staff what sells together.',
      'Ingredient costs rise faster than menu prices. Crest shows the gap.',
    ]) expect(screen.getByText(line)).toBeTruthy()
  })
})

describe('sign-up autocomplete tokens', () => {
  it('names business, person, phone and address for autofill', () => {
    inRouter(<Signup />, '/signup')
    expect(screen.getByLabelText(/business name/i).getAttribute('autocomplete')).toBe('organization')
    expect(screen.getByLabelText(/your name/i).getAttribute('autocomplete')).toBe('name')
    expect(screen.getByLabelText(/^phone/i).getAttribute('autocomplete')).toBe('tel')
    expect(screen.getByLabelText(/outlet address/i).getAttribute('autocomplete')).toBe('street-address')
  })
})
