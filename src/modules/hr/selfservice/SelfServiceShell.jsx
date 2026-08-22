import { useEffect, useState } from 'react'
import { Home, CalendarDays, FileText, Wallet, MoreHorizontal, Bell, LogOut, X, Download } from 'lucide-react'
import Modal from '../../../components/Modal'
import { PUSH, PUSH_COPY, read as readPushState } from './pushEnvironment'
import { subscribeToPush, unsubscribeFromPush, isPushSubscribed } from '../../../utils/webPush'
import { employeeErrorText } from './employeeError'
import { useInstallPrompt } from './useStaffApp'

// The Crest Staff app chrome: a 56px header and a fixed bottom tab bar.
//
// It replaces roughly 200px of stacked chrome — the employee's name as a page title, an uppercase
// "EMPLOYEE SELF-SERVICE" eyebrow, a Sign Out button and a permanent notifications button — on a
// screen where a chat app's in-app browser has already taken ~150px for its own. Navigation moved
// to the bottom because that is where a thumb reaches.
//
// This component renders NO content of its own. `tab`/`onTab` are controlled and `children` is
// whatever the container decided to show, so there is exactly one place (SelfServiceHome) that
// knows how to fetch and switch.
export const TABS = [
  { key: 'home', label: 'Home', Icon: Home },
  { key: 'roster', label: 'Roster', Icon: CalendarDays },
  // Leave and TADA are one destination because they are the same act from the employee's side —
  // "I am asking for something" — and four tabs stay legible at 390px where five crowd.
  { key: 'requests', label: 'Requests', Icon: FileText },
  { key: 'pay', label: 'Pay', Icon: Wallet },
]

function initialsOf(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '·'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

export default function SelfServiceShell({ profile, tab, onTab, badges = {}, onSignOut, children }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const activeLabel = TABS.find(t => t.key === tab)?.label || 'Self-service'

  return (
    <div className="ss-page self-service">
      <header className="ss-topbar">
        <span
          aria-hidden="true"
          style={{
            flexShrink: 0, width: 34, height: 34, borderRadius: 'var(--radius-full)',
            background: 'var(--theme-focus-ring)', color: 'var(--theme-accent-ink)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700,
          }}
        >
          {initialsOf(profile?.full_name)}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {profile?.full_name || 'Crest Staff'}
          </div>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => setMenuOpen(true)}
          aria-label="Account and settings"
          style={{ width: 44, minWidth: 44, padding: 0, justifyContent: 'center' }}
        >
          <MoreHorizontal size={18} aria-hidden="true" />
        </button>
      </header>

      <main className="ss-content">
        {/* One heading, owned by the shell and named after the active tab, so switching tabs
            announces the change and no screen can ship without a heading. */}
        <h1 className="visually-hidden">{activeLabel}</h1>
        {children}
      </main>

      <nav className="ss-tabbar" aria-label="Sections">
        {TABS.map(({ key, label, Icon }) => {
          const active = tab === key
          const count = badges[key] || 0
          return (
            <button
              key={key}
              type="button"
              className={`ss-tab${active ? ' ss-tab--active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => onTab(key)}
            >
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                {/* Weight, not just colour — the active tab has to be readable as active without
                    relying on hue alone. */}
                <Icon size={20} aria-hidden="true" strokeWidth={active ? 2.4 : 1.8} />
                {count > 0 && (
                  <span className="ss-tab-dot" aria-label={`${count} needing your attention`}>{count}</span>
                )}
              </span>
              {label}
            </button>
          )
        })}
      </nav>

      {menuOpen && (
        <Modal variant="sheet" title="Account" onClose={() => setMenuOpen(false)}>
          <AccountSheet profile={profile} onClose={() => setMenuOpen(false)} onSignOut={onSignOut} />
        </Modal>
      )}
    </div>
  )
}

// Sign Out lives here rather than in the header: it is not the second most important thing an
// employee does, and it was sitting at the top right of every screen where a thumb lands.
function AccountSheet({ profile, onClose, onSignOut }) {
  const [state, setState] = useState(PUSH.UNSUPPORTED)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const { installable, promptInstall } = useInstallPrompt()

  // Recomputed every time the sheet opens, and again after every action: both the permission and
  // whether the app is installed can change between visits, and a state read once at mount would
  // keep telling the employee yesterday's answer.
  const refresh = async () => {
    const subscribed = await isPushSubscribed().catch(() => false)
    setState(readPushState({ subscribed }))
  }
  useEffect(() => { refresh() }, [])

  async function toggle(on) {
    setBusy(true); setErr('')
    try {
      if (on) await subscribeToPush(profile.id, profile.client_id)
      else await unsubscribeFromPush()
    } catch (e) {
      setErr(e?.code === 'ios_add_to_home_screen' ? e.message : employeeErrorText(e))
    }
    // Refresh even after a failure, so a refused OS prompt becomes an honest "blocked" state
    // rather than an error the employee is left to interpret.
    await refresh()
    setBusy(false)
  }

  const copy = PUSH_COPY[state]

  return (
    <>
      <div className="ss-sheet-head">
        <div>
          <h2>{profile?.full_name}</h2>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--theme-text3)' }}>Crest Staff</p>
        </div>
        <button className="btn btn-ghost" onClick={onClose} aria-label="Close"
          style={{ width: 44, minWidth: 44, padding: 0, justifyContent: 'center' }}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <Bell
            size={17}
            aria-hidden="true"
            style={{ flexShrink: 0, marginTop: 2, color: state === PUSH.ENABLED ? 'var(--theme-green-text)' : 'var(--theme-text3)' }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>{copy.title}</div>
            <p style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text2)' }}>{copy.body}</p>
          </div>
        </div>

        {/* A button appears ONLY in the two states where pressing it can do something. Offering a
            control that cannot work is what made the old permanent "Enable Notifications" button
            dishonest — it reported success on a device that had never subscribed. */}
        {state === PUSH.READY && (
          <button className="btn btn-primary btn-block" style={{ marginTop: 12 }} disabled={busy} onClick={() => toggle(true)}>
            {busy ? 'Turning on…' : 'Turn on notifications'}
          </button>
        )}
        {state === PUSH.ENABLED && (
          <button className="btn btn-ghost btn-block" style={{ marginTop: 12 }} disabled={busy} onClick={() => toggle(false)}>
            {busy ? 'Turning off…' : 'Turn off on this device'}
          </button>
        )}
        {err && (
          <p role="alert" style={{ margin: '10px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--theme-red-text)' }}>{err}</p>
        )}
      </div>

      {/* Android/Chrome only — iOS has no programmatic install, which is why PUSH_COPY's
          NEEDS_INSTALL text spells out the Share → Add to Home Screen route instead. */}
      {installable && (
        <button className="btn btn-ghost btn-block" style={{ marginBottom: 12, gap: 8 }} onClick={promptInstall}>
          <Download size={16} aria-hidden="true" /> Add Crest Staff to your home screen
        </button>
      )}

      <p style={{ margin: '0 0 14px', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text3)' }}>
        Light or dark follows your phone&rsquo;s own setting.
      </p>

      <button className="btn btn-danger btn-block" style={{ gap: 8 }} onClick={onSignOut}>
        <LogOut size={16} aria-hidden="true" /> Sign out
      </button>
    </>
  )
}
