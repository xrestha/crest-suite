function fmt(days) {
  if (days >= 30) {
    const m = Math.floor(days / 30)
    return `${m} month${m !== 1 ? 's' : ''} left`
  }
  return `${days}d left`
}

// `color` is the full-opacity SIGNAL TEXT and must be a theme token, never a literal: it is
// rendered as text on the card/sidebar surface, and the two presets move that surface from
// #0f1117 to #ffffff. Hardcoding the Dark preset's own #34d399 here put the subscription badge
// at 1.58:1 on Latte — every light preset failed AA on the one line that says how long a client
// has left. The `bg`/`border` alpha tints stay literal rgba: that is the codebase's documented
// convention (DESIGN.md's tint pattern is "alpha fill + full-opacity signal text"), and a faint
// tint reads correctly as red/amber/green on every preset because only the text carries meaning.
function statusFromDays(days) {
  if (days < 0)   return { label: 'Expired',  days, color: 'var(--theme-red-text)',   bg: 'color-mix(in srgb, var(--theme-red) 12%, var(--theme-card))', border: 'color-mix(in srgb, var(--theme-red) 30%, transparent)'  }
  if (days <= 7)  return { label: fmt(days),   days, color: 'var(--theme-red-text)',   bg: 'color-mix(in srgb, var(--theme-red) 10%, var(--theme-card))', border: 'color-mix(in srgb, var(--theme-red) 25%, transparent)' }
  if (days <= 30) return { label: fmt(days),   days, color: 'var(--theme-amber-text)', bg: 'color-mix(in srgb, var(--theme-amber) 10%, var(--theme-card))',  border: 'color-mix(in srgb, var(--theme-amber) 25%, transparent)'  }
  // Green tint at 0.06, not 0.10: green-text sits closest to the AA line of the three variants,
  // and at 0.10 the healthy chip measured 4.42:1 on the Light preset — the one state that renders
  // for months on end (S612). The fainter wash keeps the hue while the text carries the meaning.
  return            { label: fmt(days),   days, color: 'var(--theme-green-text)', bg: 'color-mix(in srgb, var(--theme-green) 6%, var(--theme-card))',  border: 'color-mix(in srgb, var(--theme-green) 20%, transparent)'   }
}

// Per-date status helper — pass any date string directly
export function getDateStatus(endsAt) {
  if (!endsAt) return { label: null, days: null, color: 'var(--theme-text3)', bg: 'transparent', border: 'transparent' }
  const days = Math.ceil((new Date(endsAt) - Date.now()) / 86400000)
  return statusFromDays(days)
}

// The drawer's chip for Customization's own date (S862 ADD-1): it closes the add-on itself, so the
// chip names the state the till is in rather than only the days. No date is a state too: open and
// not billed, the one an operator must notice.
export function getCustomizationDateStatus(endsAt) {
  const cs = customizationState({ pos_enabled: true, customization_enabled: true, customization_ends_at: endsAt || null })
  if (cs.noDate) return { label: 'No end date · not billed', days: null, color: 'var(--theme-text2)', bg: 'color-mix(in srgb, var(--theme-text2) 10%, var(--theme-card))', border: 'color-mix(in srgb, var(--theme-text2) 30%, transparent)' }
  const red = { color: 'var(--theme-red-text)', bg: 'color-mix(in srgb, var(--theme-red) 12%, var(--theme-card))', border: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }
  if (cs.lapsed) return { label: 'Lapsed · choices off', days: cs.daysLeft, ...red }
  if (cs.inGrace) return { label: `Grace · ${GRACE_DAYS + cs.daysLeft}d left`, days: cs.daysLeft, ...red }
  return statusFromDays(cs.daysLeft)
}

// Days of continued access after the last module end date passes. A lapsed invoice here is
// usually a collection delay (cheque/cash pickup), not a decision to leave — cutting a live
// restaurant off at midnight on the due date would strand a service in progress, so expiry
// warns for a week first and only then locks.
export const GRACE_DAYS = 7

// The single source of truth behind the app-wide lock — see ProtectedRoute.
//
// Deliberately fails OPEN: a client carrying no end date on any module has never been given
// one (most of the existing book predates per-module dates), and must keep working. Only a
// date that exists AND has passed, or an explicit admin deactivation, locks anything.
export function getAccessState(client) {
  const open = { locked: false, reason: null, daysLeft: null, graceLeft: null }
  if (!client) return open

  // An explicit admin deactivation outranks every date in both directions — it locks a client
  // whose dates are still valid, and it is the switch that actually means something now.
  if (client.is_active === false) return { ...open, locked: true, reason: 'deactivated' }

  // A signup nobody has approved yet (S697). Trials are approved by a person before they open,
  // and the 7-day clock starts at approval — so this is checked BEFORE the expiry branch below,
  // or a signup that sat unapproved past its provisional expiry would show "trial ended" to
  // someone who never got in. Only a row that is a trial AND carries no approval stamp is held;
  // every non-trial client has NULL here and is unaffected (fails open, like the rest).
  if (client.is_trial && !client.trial_approved_at) return { ...open, locked: true, reason: 'pending' }

  // Self-service trial. The retention window that follows expiry (trial_purge_at) is about how
  // long the DATA is kept, not about continued access, so the lock lands on the expiry date.
  if (client.is_trial && client.trial_expires_at && new Date(client.trial_expires_at) < new Date()) {
    return { ...open, locked: true, reason: 'trial' }
  }

  // The main modules' dates and the legacy date only (S849 ACCESS-2, SU5 (a)). An add-on — Crest
  // Suite Pro or Customization — paid further ahead used to hold the whole outlet open after IMS, HR
  // and POS had all run out. The add-ons' own dates close only the add-on itself (suiteState,
  // customizationState) and its money (clientMrr), never the outlet. client_access_open() weighs
  // the same four.
  const ends = [
    client.ims_ends_at,
    client.hr_ends_at,
    client.pos_ends_at,
    client.subscription_ends_at,
  ].filter(Boolean).map(d => new Date(d).getTime())

  if (ends.length === 0) return open

  const daysLeft = Math.ceil((Math.max(...ends) - Date.now()) / 86400000)
  if (daysLeft >= 0) return { ...open, daysLeft }
  if (-daysLeft <= GRACE_DAYS) {
    return { ...open, reason: 'grace', daysLeft, graceLeft: GRACE_DAYS + daysLeft }
  }
  return { ...open, locked: true, reason: 'expired', daysLeft }
}

// Is the Crest Suite Pro add-on LIVE for this client — subscribed AND paid through? Read by
// AuthContext, so SuiteGate and the nav's PRO chip both honour the date. Until S736 nothing did:
// `suite_ends_at` drove the ★ SUITE pill and the MRR figure, so a lapsed Suite read "Not billing"
// on Admin → Clients while every Suite page stayed open, and the drawer's own tooltip claimed the
// date gated them. It is `suiteState(client).live` (below), so the gate, the money and the operator
// screens answer from one predicate (S849). public.client_suite_live() is its SQL twin, used by the
// group roll-ups; clientSuiteLive.test.js holds the two together.
export function suiteLive(client) {
  return suiteState(client).live
}

// Everything every screen needs to know about one client's Crest Suite Pro, from one predicate
// (S849 ACCESS-3/-4, SU12). The gate (via suiteLive), the MRR figure, the billing export's hand copy,
// Admin → Clients' ★ SUITE pill, Features ⊞, the drawer and the Admin Dashboard all read it, so they
// can no longer disagree about whether Suite is on.
//   subscribed — suite_plan is 'pro' ('starter'/'growth' were retired in S548 and count as off)
//   imsOn      — Crest IMS is switched on: Suite is an IMS add-on, so with IMS off it is neither
//                live nor billed (the IMS floor, ACCESS-3)
//   endsAt     — the Suite date, else the IMS date, else the legacy date (rows from before
//                suite_ends_at existed); null with no date at all
//   daysLeft   — whole days to endsAt, negative once past; null with no date
//   noDate     — subscribed with no date at all: it stays open, is not billed, and the operator
//                screens mark it "no end date" (SU12)
//   live       — the pages open: subscribed, IMS on, and no date or not more than GRACE_DAYS past
//   inGrace    — live, but the date has passed (the 7 days after it)
//   lapsed     — subscribed but not live (past the grace week, or IMS off)
//   billed     — counted as income: subscribed, IMS on, not Crest's demo outlet, and clientMrr's
//                Suite date (suite_ends_at, else the IMS date while the IMS window is open) still
//                ahead. A Suite with no date of its own after IMS has lapsed is live (it fails open)
//                but not billed.
export function suiteState(client) {
  const subscribed = client?.suite_plan === 'pro'
  const imsOn = client?.ims_enabled !== false
  const endsAt = client?.suite_ends_at || client?.ims_ends_at || client?.subscription_ends_at || null
  const daysLeft = endsAt ? Math.ceil((new Date(endsAt).getTime() - Date.now()) / 86400000) : null
  const noDate = subscribed && !endsAt
  const live = subscribed && imsOn && (daysLeft === null || daysLeft >= -GRACE_DAYS)
  const inGrace = live && daysLeft !== null && daysLeft <= 0
  const lapsed = subscribed && !live
  // clientMrr.js's rule, restated here so the count and the money agree (clientMrr.test.js checks
  // both against the same rows): the IMS fallback counts only while the IMS window itself is open.
  const days = d => Math.ceil((new Date(d).getTime() - Date.now()) / 86400000)
  const imsEnd = client?.ims_ends_at || client?.subscription_ends_at || null
  const imsWindowOpen = imsOn && !!imsEnd && days(imsEnd) > 0
  const billEnd = client?.suite_ends_at || (imsWindowOpen ? imsEnd : null)
  const billed = subscribed && imsOn && !client?.is_internal && !!billEnd && days(billEnd) > 0
  return { subscribed, imsOn, endsAt, daysLeft, noDate, live, inGrace, lapsed, billed }
}

// Everything every screen needs to know about one client's Crest Customization, from one predicate
// (S862 ADD-1, owner CU1 (a)): Suite's rule applied to the add-on ON POS. Until S862 the end date
// gated nothing: a lapsed Customization kept choices and combos on the till and the QR menu while
// clientMrr and the billing export stopped counting it. AuthContext reads `.live` for the module
// switch; public.customization_live() is its SQL twin, and clientCustomizationLive.test.js holds the
// two together.
//   subscribed — POS on and the Customization flag on (the database refuses the flag without POS)
//   endsAt     — customization_ends_at, or null; it has no fallback date of its own
//   daysLeft   — whole days to endsAt, negative once past; null with no date
//   noDate     — subscribed with no date: it stays open, is not billed, and the operator screens
//                mark it "no end date"
//   live       — the till, the QR menu and the pages offer it: subscribed, and no date or not more
//                than GRACE_DAYS past
//   inGrace    — live, but the date has passed (the 7 days after it)
//   lapsed     — subscribed but past the grace week
//   billed     — clientMrr's rule: POS's own window open, Customization's date still ahead, and not
//                Crest's demo outlet
export function customizationState(client) {
  const subscribed = !!client?.pos_enabled && !!client?.customization_enabled
  const endsAt = client?.customization_ends_at || null
  const days = d => Math.ceil((new Date(d).getTime() - Date.now()) / 86400000)
  const daysLeft = endsAt ? days(endsAt) : null
  const noDate = subscribed && !endsAt
  const live = subscribed && (daysLeft === null || daysLeft >= -GRACE_DAYS)
  const inGrace = live && daysLeft !== null && daysLeft <= 0
  const lapsed = subscribed && !live
  const posWindowOpen = !!client?.pos_ends_at && days(client.pos_ends_at) > 0
  const billed = subscribed && !client?.is_internal && posWindowOpen && daysLeft !== null && daysLeft > 0
  return { subscribed, endsAt, daysLeft, noDate, live, inGrace, lapsed, billed }
}

// "+N days" on a subscription ADDS to the time the client already has. The base is the later of
// today and the current end date, so a client paid through the 15th who renews on the 10th ends
// on the 15th + N, not the 10th + N. ClientDrawer's Billing tab computed every quick-extend
// button from today (S736), which SHORTENED a subscription whenever it was pressed before the
// current end date — "+1 Year" on a client with three months left threw those three months away.
// The trial panel's +7 Days had always done this correctly; this is that logic, shared.
export function extendedFrom(currentEndsAt, days, now = new Date()) {
  const current = currentEndsAt ? new Date(currentEndsAt) : null
  const base = current && !Number.isNaN(current.getTime()) && current > now ? current : now
  const d = new Date(base.getTime())
  d.setDate(d.getDate() + days)
  return d
}

// Client-level badge — the farthest end date across IMS, HR, POS and the legacy date (the same four
// getAccessState locks on; an add-on's date never holds the outlet open, S849 ACCESS-2), falling
// back to the trial.
export function getSubStatus(client) {
  const now = Date.now()
  const candidates = [
    client?.ims_ends_at,
    client?.hr_ends_at,
    client?.pos_ends_at,
    client?.subscription_ends_at,
  ].filter(Boolean).map(d => new Date(d).getTime())

  if (candidates.length > 0) {
    const latest = Math.max(...candidates)
    const days   = Math.ceil((latest - now) / 86400000)
    return statusFromDays(days)
  }
  // Trials read the canonical pair register_trial writes (is_trial + trial_expires_at) —
  // trial_ends_at was a second, legacy trial column that only the admin "+ New Client" form
  // wrote and only this fallback read, so an admin-created client and a self-service trial were
  // invisible to each other's screens (S574; migration 20260818190000 folded it in).
  if (client?.is_trial && !client?.trial_approved_at) {
    // Awaiting approval — the operator's own to-do, so it takes the amber "pending" tone the
    // admin surfaces already use for open work rather than the accent tone of a running trial.
    return { label: 'Awaiting approval', days: null, color: 'var(--theme-amber-text)', bg: 'color-mix(in srgb, var(--theme-amber) 10%, var(--theme-card))', border: 'color-mix(in srgb, var(--theme-amber) 30%, transparent)' }
  }
  if (client?.is_trial && client?.trial_expires_at) {
    const days = Math.ceil((new Date(client.trial_expires_at) - now) / 86400000)
    if (days < 0) return { label: 'Trial expired', days, color: 'var(--theme-red-text)', bg: 'color-mix(in srgb, var(--theme-red) 10%, var(--theme-card))', border: 'color-mix(in srgb, var(--theme-red) 25%, transparent)' }
    const m = Math.floor(days / 30)
    const trialLabel = days >= 30 ? `Trial · ${m}mo` : `Trial · ${days}d`
    return { label: trialLabel, days, color: 'var(--theme-accent-ink)', bg: 'color-mix(in srgb, var(--theme-accent) 10%, var(--theme-card))', border: 'color-mix(in srgb, var(--theme-accent) 25%, transparent)' }
  }
  // Explicit, not a silent "—": a client with no dates at all fails OPEN in getAccessState
  // (unlimited access) and is skipped by the auto-deactivation sweep, so this is the one state
  // an operator must notice and price — a converted trial lands here until dates are set (S574).
  return { label: 'No end date', days: null, color: 'var(--theme-text2)', bg: 'color-mix(in srgb, var(--theme-text2) 12%, var(--theme-card))', border: 'color-mix(in srgb, var(--theme-text2) 30%, transparent)' }
}
