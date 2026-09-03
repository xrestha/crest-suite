import { render, screen } from '@testing-library/react'
import AppErrorBoundary from './AppErrorBoundary'
import { SUPPORT_EMAIL } from '../shared/supportContact'

// SupportContactLine → useSupportContact → SettingsContext → supabaseClient.js, which calls
// createClient(...) at MODULE load time and throws when REACT_APP_SUPABASE_URL isn't set in this
// environment — same shape Login.trialConsent.test.jsx already works around. No provider is
// mounted here, so nothing ever calls a method on this mock; it only has to exist.
jest.mock('../supabaseClient', () => ({ supabase: {} }))

function Boom() {
  throw new Error('boom')
}

// AppErrorBoundary's componentDidCatch logs via console.error on every render of a caught error —
// React itself also logs the original throw to the console. Silence both so a passing test doesn't
// print a scary stack trace.
beforeEach(() => { jest.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { console.error.mockRestore() })

test('renders the fallback instead of unmounting, and offers a way to email support', () => {
  render(
    <AppErrorBoundary resetKey="/a">
      <Boom />
    </AppErrorBoundary>
  )
  expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
  // The "buttons" variant labels the link "Email us", not the raw address — assert the href
  // carries the real support email rather than the visible button copy.
  expect(screen.getByRole('link', { name: /email us/i })).toHaveAttribute('href', `mailto:${SUPPORT_EMAIL}`)
})

test('a normal child renders through untouched when there is no error', () => {
  render(
    <AppErrorBoundary resetKey="/a">
      <div>all fine</div>
    </AppErrorBoundary>
  )
  expect(screen.getByText('all fine')).toBeInTheDocument()
})

test('clears the error when resetKey changes (navigating away)', () => {
  const { rerender } = render(
    <AppErrorBoundary resetKey="/a">
      <Boom />
    </AppErrorBoundary>
  )
  expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()

  rerender(
    <AppErrorBoundary resetKey="/b">
      <div>fine now</div>
    </AppErrorBoundary>
  )
  expect(screen.getByText('fine now')).toBeInTheDocument()
})

test('does NOT put the raw error message on the sleeve for a credential-shaped throw', () => {
  function BoomWithToken() {
    throw new Error('failed for token=abcdefghijklmnopqrstuvwxyz1234567890')
  }
  render(
    <AppErrorBoundary resetKey="/a">
      <BoomWithToken />
    </AppErrorBoundary>
  )
  expect(screen.queryByText(/abcdefghijklmnopqrstuvwxyz1234567890/)).not.toBeInTheDocument()
  expect(screen.getByText(/\[redacted\]/)).toBeInTheDocument()
})
