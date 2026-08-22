import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import SelfServiceShell, { TABS } from './SelfServiceShell'
import { isPushSubscribed } from '../../../utils/webPush'

// webPush pulls in the Supabase client, which has no business being constructed in a shell test.
jest.mock('../../../utils/webPush', () => ({
  subscribeToPush: jest.fn(),
  unsubscribeFromPush: jest.fn(),
  isPushSubscribed: jest.fn(),
}))

// CRA's jest config sets resetMocks, which clears implementations (not just calls) between tests,
// so the resolved value has to be re-declared per test rather than once in the factory.
beforeEach(() => { isPushSubscribed.mockResolvedValue(false) })

const profile = { id: 'p1', full_name: 'Ananda Bhusal', client_id: 'c1' }

function renderShell(props = {}) {
  return render(
    <SelfServiceShell profile={profile} tab="home" onTab={() => {}} onSignOut={() => {}} {...props}>
      <p>screen content</p>
    </SelfServiceShell>,
  )
}

describe('SelfServiceShell', () => {
  it('gives the app real landmarks', () => {
    renderShell()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.getByRole('main')).toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument()
  })

  it('renders the four destinations in order', () => {
    renderShell()
    const tabs = screen.getByRole('navigation', { name: 'Sections' }).querySelectorAll('button')
    expect([...tabs].map(b => b.textContent)).toEqual(TABS.map(t => t.label))
  })

  it('marks exactly one destination as current, and it is the one passed in', () => {
    renderShell({ tab: 'roster' })
    const current = document.querySelectorAll('[aria-current="page"]')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveTextContent('Roster')
  })

  it('names the screen with one heading, taken from the active tab', () => {
    // The tab array drives the bar, the heading and (in the container) the content switch, so the
    // default can never again disagree with what renders — the exact bug the old tab-bar had.
    const { rerender } = renderShell({ tab: 'pay' })
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Pay')
    rerender(
      <SelfServiceShell profile={profile} tab="requests" onTab={() => {}} onSignOut={() => {}}>
        <p>screen content</p>
      </SelfServiceShell>,
    )
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Requests')
  })

  it('reports the tab key to the container', () => {
    const onTab = jest.fn()
    renderShell({ onTab })
    fireEvent.click(screen.getByText('Roster'))
    expect(onTab).toHaveBeenCalledWith('roster')
  })

  it('renders whatever the container gave it', () => {
    renderShell()
    expect(screen.getByText('screen content')).toBeInTheDocument()
  })

  it('puts a labelled count on a tab that needs attention, and nothing at zero', () => {
    const { rerender } = renderShell({ badges: { roster: 2 } })
    expect(screen.getByLabelText('2 needing your attention')).toHaveTextContent('2')
    rerender(
      <SelfServiceShell profile={profile} tab="home" onTab={() => {}} onSignOut={() => {}} badges={{ roster: 0 }}>
        <p>screen content</p>
      </SelfServiceShell>,
    )
    expect(screen.queryByLabelText(/needing your attention/)).not.toBeInTheDocument()
  })

  it('keeps Sign out inside the account sheet, not on every screen', () => {
    renderShell()
    expect(screen.queryByText('Sign out')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Account and settings'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Sign out')).toBeInTheDocument()
  })

  it('offers no notification button where tapping one could not work', async () => {
    // jsdom has no PushManager, which is the UNSUPPORTED case: an explanation, no control.
    renderShell()
    fireEvent.click(screen.getByLabelText('Account and settings'))
    expect(await screen.findByText(/not available/i)).toBeInTheDocument()
    expect(screen.queryByText(/turn on notifications/i)).not.toBeInTheDocument()
  })
})
