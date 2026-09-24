import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { useBizInfo } from '../shared/hooks/useBizInfo'
import { useSupportContact } from '../shared/hooks/useSupportContact'
import { useSetupGuide } from '../shared/onboarding/useSetupGuide'
import { writeSetupStrip } from '../shared/onboarding/setupStrip'
import { DEFAULT_SKIP, GROUPS } from '../shared/onboarding/setupSteps'
import SupportContactLine from './SupportContactLine'
import ActionError from './ActionError'
import Tip from './Tip'
import './SetupGuide.css'

// The setup guide (S790) — the checklist a new client works through in their first weeks. It
// replaced GettingStartedCard, which covered four IMS steps, only appeared when IMS was on and
// empty, and sent staff to pages they could not open. The rules (who sees what, how a box ticks,
// when the card goes) live in src/shared/onboarding/setupSteps.js and are asserted in its test;
// this file only draws them.
//
// Two surfaces: 'dashboard' (the card, or one line, or nothing — dashboardMode) and 'help'
// (Help → Getting Started, always the full list, with "Show on my dashboard again").

const STATUS_WORD = {
  done: 'Done',
  skipped: 'Skipped',
  started: 'Started, not saved yet',
  unknown: "Couldn't check right now",
  todo: '',
}

const MARK = { done: '✓', skipped: '–', unknown: '?' }

const READ_ONLY_TIP = 'Crest view: only the client can change this.'

export default function SetupGuideCard({ surface = 'dashboard' }) {
  const g = useSetupGuide({ surface })
  const { adminViewClientName } = useAuth()
  const navigate = useNavigate()
  const titleId = useId()
  const [adminOpen, setAdminOpen] = useState(false)
  // Local overrides: which step body is open ('' = none, null = the default current step), and
  // which module part is open (null = the one the guide chose).
  const [openStep, setOpenStep] = useState(null)
  const [openGroup, setOpenGroup] = useState(null)

  if (!g.viewer) return null
  const { guide, actions, readOnly } = g

  if (surface === 'help') {
    if (g.loading) return <div className="card setup-guide setup-guide--help setup-guide--loading">Loading your setup guide…</div>
    if (!guide || guide.total === 0) return null
  } else if (g.mode === 'none' || !guide) {
    return null
  }

  // ── One line: hidden, finished-with-month-end-waiting, unreadable progress, or admin's view ──
  const slim = surface === 'dashboard' && g.mode === 'slim' && !(readOnly && adminOpen)
  if (slim) {
    const monthEnd = guide.groups.find(x => x.key === 'monthend')
    const finishedWithMonthEnd = g.cardState === 'finished' && monthEnd
    return (
      <section className="card setup-guide setup-guide--slim dash-row" aria-label="Getting started">
        <div className="setup-guide__slim-text">
          <strong>{finishedWithMonthEnd ? 'Your first month-end' : 'Getting started'}</strong>
          {' · '}
          {finishedWithMonthEnd ? `${monthEnd.done} of ${monthEnd.total} done` : `${guide.done} of ${guide.total} done`}
          {!g.progressOk && !readOnly && <span className="setup-guide__slim-note"> · your saved choices couldn't be loaded</span>}
        </div>
        <ProgressBar done={finishedWithMonthEnd ? monthEnd.done : guide.done} total={finishedWithMonthEnd ? monthEnd.total : guide.total} slim />
        <div className="setup-guide__slim-actions">
          {readOnly ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdminOpen(true)}>Show (read-only)</button>
          ) : !g.progressOk ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={actions.reload}>Try again</button>
          ) : (
            <>
              <button type="button" className="btn btn-primary btn-sm" onClick={actions.unhide}>Continue</button>
              <Tip text="Removes it from your dashboard. You can bring it back any time from Help (top right) → Getting Started.">
                <button type="button" className="btn btn-ghost btn-sm" onClick={actions.dismiss}>Don't show</button>
              </Tip>
            </>
          )}
        </div>
        <ActionError error={g.actionError} />
      </section>
    )
  }

  // ── Everything done ──
  if (surface === 'dashboard' && g.mode === 'celebrate') {
    const habits = GROUPS.filter(x => x.habit && guide.groups.some(gr => gr.key === x.key))
    return (
      <section className="card setup-guide dash-row" aria-labelledby={titleId}>
        <h2 id={titleId} className="setup-guide__title">Setup complete — well done</h2>
        <p className="setup-guide__sub">From here on, a few habits keep your figures right:</p>
        <ul className="setup-guide__habits">
          {habits.map(h => <li key={h.key}><strong>{h.title}:</strong> {h.habit}</li>)}
        </ul>
        <p className="setup-guide__sub">
          If your first month hasn't ended yet, its month-end steps will show here in its last few days.
          This guide always stays in <Link className="setup-guide__link" to="/help?section=guide">Help → Getting Started</Link>.
        </p>
        <div className="setup-guide__row-actions">
          <button type="button" className="btn btn-primary" onClick={actions.finish}>Close</button>
        </div>
        <ActionError error={g.actionError} />
      </section>
    )
  }

  // ── The full list ──
  // A part picked on screen stays open until it is finished; then the guide's own choice (the next
  // unfinished part) takes over, the same way it does for the part chosen on another visit.
  const pickedStillOpen = openGroup && guide.moduleGroups.some(x => x.key === openGroup && !x.complete)
  const moduleOpen = pickedStillOpen ? openGroup : guide.expandedKey
  const showReopen = surface === 'help' && !readOnly &&
    (g.eligible === false || ['hidden', 'dismissed', 'finished'].includes(g.cardState))
  // An established client never had the card (new clients only), so for them this is a START, not
  // an "again" — offered here and from the account menu's "Setup guide" (S790).
  const neverStarted = g.cardState == null && g.eligible === false
  const incompleteModules = guide.moduleGroups.filter(x => !x.complete)
  // Crest's read-only view is never asked what to set up first — it is not the one choosing.
  const showChooser = guide.needsChoice && openGroup === null && !readOnly

  const openModule = key => {
    setOpenGroup(key)
    setOpenStep(null)
    if (!readOnly) actions.chooseFocus(key)
  }

  const start = (step, group) => {
    actions.markOpened(step.key)
    if (step.route) {
      writeSetupStrip({ route: step.route, label: step.label, n: step.number, of: group.total, group: group.title, strip: step.strip })
      navigate(step.route)
    }
  }

  const renderStep = (step, group) => {
    const isOpen = openStep === step.key || (openStep === null && step.key === group.currentKey)
    const bodyId = `${titleId}-${step.key.replace(/[^a-z0-9]/gi, '-')}`
    const status = step.status
    const canSkip = step.skip !== false && ['todo', 'started', 'unknown'].includes(status)
    return (
      <li key={step.key} className={`setup-step setup-step--${status}`}>
        <button type="button" className="setup-step__row" aria-expanded={isOpen} aria-controls={bodyId}
          onClick={() => setOpenStep(isOpen ? '' : step.key)}>
          <span className="setup-step__mark" aria-hidden="true">{MARK[status] || step.number}</span>
          <span className="setup-step__label">{step.label}</span>
          {STATUS_WORD[status] && <span className="setup-step__state">{STATUS_WORD[status]}</span>}
        </button>
        {isOpen && (
          <div id={bodyId} className="setup-step__body">
            <p className="setup-step__hint">
              {step.key === 'start.account' && status !== 'done' && step.hintWhenNotDone ? step.hintWhenNotDone : step.hint}
            </p>
            {status === 'unknown' && (
              <p className="setup-step__note">We couldn't check this just now, so it isn't ticked or counted yet. It will update the next time you open the dashboard.</p>
            )}
            {step.where && <p className="setup-step__where">Where to find it later: {step.where}</p>}
            {step.note && <p className="setup-step__note">{step.note}</p>}
            {(step.contact || (step.key === 'start.account' && status !== 'done')) && <ContactBlock />}
            {step.billDetails && <BillDetails />}
            <div className="setup-guide__row-actions">
              {step.route && (
                <button type="button" className={status === 'done' ? 'btn btn-ghost' : 'btn btn-primary'} onClick={() => start(step, group)}>
                  {status === 'done' ? 'Open it again' : 'Start'}
                </button>
              )}
              {step.tick === 'manual' && status !== 'done' && status !== 'skipped' && (
                readOnly
                  ? <Tip text={READ_ONLY_TIP}><button type="button" className="btn btn-primary" aria-disabled="true">{step.doneLabel}</button></Tip>
                  : <button type="button" className="btn btn-primary" onClick={() => actions.markDone(step.key)}>{step.doneLabel}</button>
              )}
              {canSkip && (
                readOnly
                  ? <Tip text={READ_ONLY_TIP}><button type="button" className="btn btn-ghost btn-sm" aria-disabled="true">{typeof step.skip === 'string' ? step.skip : DEFAULT_SKIP}</button></Tip>
                  : <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.skip(step.key)}>{typeof step.skip === 'string' ? step.skip : DEFAULT_SKIP}</button>
              )}
              {status === 'skipped' && !readOnly && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => actions.unskip(step.key)}>Undo skip</button>
              )}
            </div>
          </div>
        )}
      </li>
    )
  }

  const renderGroup = group => {
    const isModule = guide.moduleGroups.some(x => x.key === group.key)
    const expanded = !isModule || (!showChooser && moduleOpen === group.key) || (readOnly && openGroup === group.key)
    const headingId = `${titleId}-${group.key}`
    if (!expanded) {
      return (
        <div key={group.key} className="setup-guide__group setup-guide__group--collapsed">
          <h3 id={headingId} className="setup-guide__group-title">{group.title}</h3>
          <span className="setup-guide__group-count">
            {group.complete ? '✓ All done' : `${group.done} of ${group.total} done`}
          </span>
          {!group.complete && !showChooser && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => openModule(group.key)}>
              {readOnly ? 'Show' : 'Open'}
            </button>
          )}
        </div>
      )
    }
    if (group.key === 'start' && group.complete) {
      return (
        <div key={group.key} className="setup-guide__group setup-guide__group--collapsed">
          <h3 id={headingId} className="setup-guide__group-title">{group.title}</h3>
          <span className="setup-guide__group-count">✓ All done</span>
        </div>
      )
    }
    return (
      <div key={group.key} className="setup-guide__group" role="group" aria-labelledby={headingId}>
        <div className="setup-guide__group-head">
          <h3 id={headingId} className="setup-guide__group-title">{group.title}</h3>
          <span className="setup-guide__group-count">{group.done} of {group.total} done</span>
        </div>
        <ol className="setup-guide__steps">{group.steps.map(s => renderStep(s, group))}</ol>
        {group.hiddenNext > 0 && (
          <p className="setup-guide__later">
            {group.hiddenNext} more {group.hiddenNext === 1 ? 'step opens' : 'steps open'} here once these are done or skipped.
          </p>
        )}
      </div>
    )
  }

  const startGroup = guide.groups.find(x => x.key === 'start')
  const monthEndGroup = guide.groups.find(x => x.key === 'monthend')

  return (
    <section className={`card setup-guide ${surface === 'dashboard' ? 'dash-row' : 'setup-guide--help'}`} aria-labelledby={titleId}>
      <div className="setup-guide__head">
        <div>
          <h2 id={titleId} className="setup-guide__title">Getting started with Crest</h2>
          <p className="setup-guide__sub">
            Each box ticks by itself once the job is really done. Skip anything your business doesn't need.
          </p>
        </div>
        <div className="setup-guide__head-actions">
          <span className="setup-guide__count">{guide.done} of {guide.total} done</span>
          {surface === 'dashboard' && !readOnly && (
            <Tip text="Shrinks this to one line on your dashboard. It always stays in Help → Getting Started.">
              <button type="button" className="btn btn-ghost btn-sm" onClick={actions.hide}>Hide for now</button>
            </Tip>
          )}
          {surface === 'dashboard' && readOnly && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdminOpen(false)}>Hide</button>
          )}
          {showReopen && (
            <button type="button" className={neverStarted ? 'btn btn-primary' : 'btn btn-primary btn-sm'} onClick={actions.reopen}>
              {neverStarted ? 'Start the setup guide' : 'Show on my dashboard again'}
            </button>
          )}
        </div>
      </div>
      {showReopen && neverStarted && (
        <p className="setup-guide__sub">
          A step-by-step checklist for setting up Crest, with the steps you have already done ticked.
          Press Start the setup guide and it shows at the top of your dashboard until you finish or hide it.
        </p>
      )}
      {surface === 'help' && !readOnly && g.cardState === 'reopened' && (
        <p className="setup-guide__sub" role="status">
          It is on your dashboard now. <Link className="setup-guide__link" to="/dashboard">Go to the dashboard</Link>
        </p>
      )}
      <ProgressBar done={guide.done} total={guide.total} />
      {readOnly && (
        <p className="setup-guide__admin-note">
          Crest view: this is {adminViewClientName || 'this client'}’s setup, across all of their logins. Nothing you press here is saved.
        </p>
      )}
      {!g.progressOk && !readOnly && (
        <p className="setup-guide__admin-note">Your saved choices couldn't be loaded, so skips and hidden steps may not show. The ticks below are still checked live.</p>
      )}
      <ActionError error={g.actionError} />

      {startGroup && renderGroup(startGroup)}

      {showChooser && (
        <div className="setup-guide__choose" role="group" aria-labelledby={`${titleId}-choose`}>
          <h3 id={`${titleId}-choose`} className="setup-guide__group-title">What do you want to set up first?</h3>
          <p className="setup-guide__sub">Pick one. The others wait here until you're ready.</p>
          <div className="setup-guide__choices">
            {incompleteModules.map(m => (
              <button key={m.key} type="button" className="setup-guide__choice" onClick={() => openModule(m.key)}>
                <span className="setup-guide__choice-name">{m.pick}</span>
                <span className="setup-guide__choice-hint">{m.pickHint}</span>
                <span className="setup-guide__choice-count">{m.done} of {m.total} done</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {guide.moduleGroups.map(renderGroup)}
      {monthEndGroup && renderGroup(monthEndGroup)}

      <p className="setup-guide__foot">
        Need a hand? <SupportContactLine variant="inline" />
        {surface === 'dashboard' && <>{' · '}<Link className="setup-guide__link" to="/help?section=guide">This guide in Help</Link></>}
      </p>
    </section>
  )
}

function ProgressBar({ done, total, slim = false }) {
  const pct = total > 0 ? Math.min(1, done / total) : 0
  return (
    <div className={`setup-guide__bar${slim ? ' setup-guide__bar--slim' : ''}`} role="progressbar"
      aria-label="Setup progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}
      aria-valuetext={`${done} of ${total} done`}>
      <span className="setup-guide__bar-fill" style={{ transform: `scaleX(${pct})` }} />
    </div>
  )
}

// The human, one tap away — the research-backed help for first-time users. The phone number and the
// hours are printed as text too: on a counter PC without Viber or WhatsApp the buttons do nothing.
function ContactBlock() {
  const c = useSupportContact()
  return (
    <div className="setup-step__contact">
      <SupportContactLine variant="buttons" className="setup-step__contact-buttons" />
      {(c.phone || c.hours) && (
        <p className="setup-step__where">{[c.phone, c.hours].filter(Boolean).join(' · ')}</p>
      )}
    </div>
  )
}

// What the first bill will print, read-only. Only Crest can change these (Settings → Property is
// an admin tab), so the owner checks and either confirms or tells us.
function BillDetails() {
  const { settings } = useSettings()
  const biz = useBizInfo()
  const rows = [
    ['Shop name', biz.name || '—'],
    ['Address', biz.address || 'Not set yet'],
    ['PAN / VAT number', biz.vat || 'Not set yet'],
    ['Bill type', biz.vatReg ? 'Tax Invoice — 13% VAT is added to every bill' : 'PAN bill — no VAT added'],
    ['Bill number code', settings?.invoice_prefix || 'None'],
    ['QR payment', settings?.payment_qr_data ? 'Set up' : 'Not set up yet'],
  ]
  return (
    <div className="setup-step__bill">
      <dl className="setup-step__bill-list">
        {rows.map(([k, v]) => (
          <div key={k} className="setup-step__bill-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="setup-step__where">Something wrong or missing? Tell us and we'll fix it before your first customer:</p>
      <ContactBlock />
    </div>
  )
}
