import { getAccessState, suiteLive, extendedFrom, GRACE_DAYS } from './subscription'

// Three decisions Admin → Clients used to make on its own and now reads from here (S736). Each
// case is one the page got wrong once.

const DAY = 86400000
const daysFromNow = n => new Date(Date.now() + n * DAY).toISOString()

describe('extendedFrom — "+N days" adds to the time the client already has', () => {
  const now = new Date('2026-09-10T06:00:00+05:45')

  it('extends from the current end date when it is still in the future', () => {
    // Paid through the 15th, renewed on the 10th: ends on the 15th + 30, not the 10th + 30.
    const out = extendedFrom('2026-10-15', 30, now)
    expect(out.getTime()).toBe(new Date('2026-10-15').getTime() + 30 * DAY)
  })

  it('extends from today when the current end date has passed', () => {
    const out = extendedFrom('2026-08-01', 7, now)
    expect(out.getTime()).toBe(now.getTime() + 7 * DAY)
  })

  it('extends from today when there is no end date, or an unparseable one', () => {
    expect(extendedFrom('', 7, now).getTime()).toBe(now.getTime() + 7 * DAY)
    expect(extendedFrom(null, 7, now).getTime()).toBe(now.getTime() + 7 * DAY)
    expect(extendedFrom('not a date', 7, now).getTime()).toBe(now.getTime() + 7 * DAY)
  })

  it('never shortens — the result is always after the current end date', () => {
    for (const cur of ['2026-09-11', '2026-12-31', '2027-06-01']) {
      expect(extendedFrom(cur, 7, now).getTime()).toBeGreaterThan(new Date(cur).getTime())
    }
  })
})

describe('suiteLive — the Suite add-on honours its own date', () => {
  it('is off for a client who never subscribed', () => {
    expect(suiteLive({ suite_plan: null, suite_ends_at: daysFromNow(30) })).toBe(false)
    expect(suiteLive(null)).toBe(false)
  })

  it('fails open on a subscribed client with no date anywhere', () => {
    expect(suiteLive({ suite_plan: 'pro' })).toBe(true)
  })

  it('is live while suite_ends_at is in the future, and through the grace period after it', () => {
    expect(suiteLive({ suite_plan: 'pro', suite_ends_at: daysFromNow(30) })).toBe(true)
    expect(suiteLive({ suite_plan: 'pro', suite_ends_at: daysFromNow(-(GRACE_DAYS - 1)) })).toBe(true)
  })

  it('closes once the grace period after suite_ends_at has passed', () => {
    expect(suiteLive({ suite_plan: 'pro', suite_ends_at: daysFromNow(-(GRACE_DAYS + 2)) })).toBe(false)
  })

  it('falls back to the IMS window for rows written before suite_ends_at existed', () => {
    expect(suiteLive({ suite_plan: 'pro', ims_ends_at: daysFromNow(30) })).toBe(true)
    expect(suiteLive({ suite_plan: 'pro', ims_ends_at: daysFromNow(-60) })).toBe(false)
    expect(suiteLive({ suite_plan: 'pro', subscription_ends_at: daysFromNow(-60) })).toBe(false)
  })

  it('prefers suite_ends_at over the IMS window when both exist', () => {
    expect(suiteLive({ suite_plan: 'pro', suite_ends_at: daysFromNow(-60), ims_ends_at: daysFromNow(60) })).toBe(false)
    expect(suiteLive({ suite_plan: 'pro', suite_ends_at: daysFromNow(60), ims_ends_at: daysFromNow(-60) })).toBe(true)
  })
})

describe('the auto-deactivation sweep is getAccessState(c).reason === "expired"', () => {
  const swept = c => c.is_active !== false && getAccessState(c).reason === 'expired'

  it('sweeps a client whose every end date is past the grace period', () => {
    expect(swept({ ims_ends_at: daysFromNow(-(GRACE_DAYS + 3)), hr_ends_at: daysFromNow(-40) })).toBe(true)
  })

  it('leaves a client inside the grace period alone — the lock screen is still counting down', () => {
    expect(swept({ ims_ends_at: daysFromNow(-2) })).toBe(false)
  })

  it('honours a legacy subscription_ends_at that outlives the module dates', () => {
    // The old sweep ignored subscription_ends_at whenever any module date existed, and would have
    // locked this client while getAccessState let them in.
    expect(swept({ ims_ends_at: daysFromNow(-40), subscription_ends_at: daysFromNow(40) })).toBe(false)
  })

  it('never sweeps on a trial date — expired trials lock through their own branch', () => {
    expect(swept({ is_trial: true, trial_approved_at: daysFromNow(-20), trial_expires_at: daysFromNow(-30) })).toBe(false)
    expect(swept({ is_trial: true, trial_approved_at: null, trial_expires_at: daysFromNow(-30) })).toBe(false)
  })

  it('never sweeps a client with no dates at all — that state fails open by design', () => {
    expect(swept({})).toBe(false)
  })

  it('does not touch a client already deactivated', () => {
    expect(swept({ is_active: false, ims_ends_at: daysFromNow(-60) })).toBe(false)
  })
})
