/**
 * The trial signup clickwrap, tested at the level that matters: the two documents must be reachable
 * from the form, and the form must refuse to submit without an affirmative tick.
 *
 * Spec A.5.1 requires this test by name ("Verify with a test that renders the signup form and
 * asserts both anchors exist with the correct href"), and it is worth more than it looks. The
 * defect it guards against is not a crash — it is a link that quietly becomes plain text again, or
 * a checkbox that stops being required, either of which leaves the product claiming a contract
 * exists while collecting no evidence that one does. That is exactly the state this whole change
 * was written to get out of, and nothing else would notice a regression back into it.
 *
 * Note this is one of very few component tests in this codebase, and it only became possible once
 * react-router 7 could resolve under Jest 27 — see the moduleNameMapper block in package.json and
 * the TextEncoder shim in src/setupTests.js.
 */

import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

const mockInvoke = jest.fn()
const mockSignIn = jest.fn()

jest.mock('../supabaseClient', () => ({
  supabase: {
    functions: { invoke: (...a) => mockInvoke(...a) },
    auth: { resetPasswordForEmail: jest.fn() },
  },
}))

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    signIn: (...a) => mockSignIn(...a),
    session: null,
    ready: true,
    profile: null,
  }),
}))

jest.mock('../context/SettingsContext', () => ({
  useSettings: () => ({ settings: { app_name: 'Crest Suite' } }),
}))

const Login = require('./Login').default
const { LEGAL_META } = require('../legal/generated/legalMeta')

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login?trial=1']}>
      <Login />
    </MemoryRouter>
  )
}

function fillRequiredFields() {
  fireEvent.change(screen.getByLabelText(/business name/i), { target: { value: 'Sunrise Cafe' } })
  fireEvent.change(screen.getByLabelText(/business email/i), {
    target: { value: 'owner@sunrise.com' },
  })
  fireEvent.change(screen.getByLabelText(/create a password/i), {
    target: { value: 'Kh4trm-9quiet-Ledge' },
  })
  fireEvent.change(screen.getByLabelText(/phone/i), { target: { value: '9801234567' } })
}

beforeEach(() => {
  mockInvoke.mockReset()
  mockSignIn.mockReset()
  mockInvoke.mockResolvedValue({ data: { ok: true }, error: null })
  mockSignIn.mockResolvedValue({ error: null })
})

/**
 * Scoped to the consent label rather than the page, because the page now carries the same two
 * links twice: once in the checkbox that binds the customer, and once in the footer. That is
 * intentional -- A.5.1 requires every visible mention to be a live link -- but the two have
 * different jobs, and only the checkbox's pair must open in a new tab. An unscoped query finding
 * both is the ambiguity this scoping resolves; it is not a reason to drop the assertion.
 */
function consentLabel() {
  return screen.getByRole('checkbox', { name: /i have read and agree/i }).closest('label')
}

describe('trial signup consent links', () => {
  it('links Terms of Service to /legal/terms in a new tab', () => {
    renderLogin()
    const link = within(consentLabel()).getByRole('link', { name: /terms of service/i })
    expect(link).toHaveAttribute('href', '/legal/terms')
    // A new tab, so the half-filled form behind it survives the trip.
    expect(link).toHaveAttribute('target', '_blank')
    // Without rel=noopener the opened tab gets a handle on window.opener.
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('links Privacy Policy to /legal/privacy in a new tab', () => {
    renderLogin()
    const link = within(consentLabel()).getByRole('link', { name: /privacy policy/i })
    expect(link).toHaveAttribute('href', '/legal/privacy')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  it('links both documents from the page footer as well', () => {
    renderLogin()
    // Every mention on the page has to be a working link, not just the one in the checkbox --
    // a visitor who is not signing up still has to be able to read the terms.
    const hrefs = screen.getAllByRole('link')
      .map(a => a.getAttribute('href'))
    expect(hrefs.filter(h => h === '/legal/terms').length).toBeGreaterThanOrEqual(2)
    expect(hrefs.filter(h => h === '/legal/privacy').length).toBeGreaterThanOrEqual(2)
  })
})

describe('the consent checkbox gates the signup', () => {
  it('is present and unchecked by default', () => {
    renderLogin()
    const box = screen.getByRole('checkbox', { name: /i have read and agree/i })
    expect(box).not.toBeChecked()
  })

  it('refuses to submit while unchecked, and says why', async () => {
    renderLogin()
    fillRequiredFields()
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }))

    await screen.findByText(/please accept the terms of service and privacy policy/i)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('moves focus to the checkbox when it is the offending field', async () => {
    renderLogin()
    fillRequiredFields()
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }))

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('checkbox', { name: /i have read and agree/i })
      )
    )
  })

  it('submits once checked', async () => {
    renderLogin()
    fillRequiredFields()
    fireEvent.click(screen.getByRole('checkbox', { name: /i have read and agree/i }))
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }))

    await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1))
  })
})

describe('what the signup sends to the server', () => {
  async function submitAndCaptureBody() {
    renderLogin()
    fillRequiredFields()
    fireEvent.click(screen.getByRole('checkbox', { name: /i have read and agree/i }))
    fireEvent.click(screen.getByRole('button', { name: /start free trial/i }))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalled())
    return mockInvoke.mock.calls[0][1].body
  }

  it('carries the current version and hash of both documents', async () => {
    const body = await submitAndCaptureBody()
    expect(body.action).toBe('register_trial')
    expect(body.accepted_legal).toEqual({
      terms: { version: '1.0', sha256: LEGAL_META.terms.sha256 },
      privacy: { version: '1.0', sha256: LEGAL_META.privacy.sha256 },
    })
  })

  // The address and identity on an acceptance row have to come off the request, server-side. If
  // the browser ever started supplying them, the ledger would be recording what the signer chose
  // to claim about themselves rather than what was observed — which is the difference between
  // evidence and a self-assertion.
  it('sends no IP, user agent or identity of its own', async () => {
    const body = await submitAndCaptureBody()
    const keys = JSON.stringify(body)
    for (const forbidden of ['ip_address', 'user_agent', 'userAgent', 'client_id', 'user_id']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})
