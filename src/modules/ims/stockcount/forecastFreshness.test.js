import { forecastFreshness, canAutoRefresh, staffingForecastNote, AUTO_REFRESH_DAYS } from './forecastFreshness'
import { adToBs, BS_MONTHS } from '../../../utils/bsCalendar'
import { nepalCivilDate } from '../../../shared/nepalTime'

// 19 Kartik 2083, late morning in Kathmandu.
const NOW = Date.parse('2026-11-05T06:00:00Z')
const DAY = 86400000
const bsIn = days => { const d = nepalCivilDate(NOW); d.setDate(d.getDate() + days); return adToBs(d) }
const runAgo = days => new Date(NOW - days * DAY).toISOString()

describe('forecastFreshness (S888: weekly, judged across every horizon)', () => {
  test('no stored forecast at all is stale, and says so', () => {
    expect(forecastFreshness({ newestRunAt: null, lastDay: null, now: NOW })).toMatchObject({ stale: true, reason: 'none' })
  })
  test('a 30-day run made today is fresh', () => {
    expect(forecastFreshness({ newestRunAt: runAgo(0), lastDay: bsIn(30), now: NOW })).toMatchObject({ stale: false, reason: null, daysLeft: 30 })
  })
  test('a week-old run that still reaches far ahead is stale as old', () => {
    expect(forecastFreshness({ newestRunAt: runAgo(AUTO_REFRESH_DAYS), lastDay: bsIn(23), now: NOW })).toMatchObject({ stale: true, reason: 'old' })
    expect(forecastFreshness({ newestRunAt: runAgo(6), lastDay: bsIn(24), now: NOW }).stale).toBe(false)
  })
  test('a forecast that runs out within a week is stale whatever its age', () => {
    expect(forecastFreshness({ newestRunAt: runAgo(1), lastDay: bsIn(5), now: NOW })).toMatchObject({ stale: true, reason: 'running_out', daysLeft: 5 })
  })
  test('one that ran out reports a negative daysLeft', () => {
    expect(forecastFreshness({ newestRunAt: runAgo(16), lastDay: bsIn(-9), now: NOW })).toMatchObject({ stale: true, reason: 'running_out', daysLeft: -9 })
  })
  test('a 7-day run made today is not stale today, and is the next day (why the refresh builds 30 days)', () => {
    expect(forecastFreshness({ newestRunAt: runAgo(0), lastDay: bsIn(7), now: NOW }).stale).toBe(false)
    expect(forecastFreshness({ newestRunAt: runAgo(1), lastDay: bsIn(7), now: NOW + DAY }).stale).toBe(true)
  })
})

describe('canAutoRefresh', () => {
  test('the Owner or an inventory supervisor or manager, on an outlet with Demand Forecast', () => {
    expect(canAutoRefresh({ isAdmin: false, imsSupervisor: true, forecastAllowed: true })).toBe(true)
  })
  test('never Crest support viewing an outlet (owner decision)', () => {
    expect(canAutoRefresh({ isAdmin: true, imsSupervisor: true, forecastAllowed: true })).toBe(false)
  })
  test('not a login below inventory supervisor, nor an outlet without Demand Forecast', () => {
    expect(canAutoRefresh({ isAdmin: false, imsSupervisor: false, forecastAllowed: true })).toBe(false)
    expect(canAutoRefresh({ isAdmin: false, imsSupervisor: true, forecastAllowed: false })).toBe(false)
    expect(canAutoRefresh({ isAdmin: false, imsSupervisor: true, forecastAllowed: undefined })).toBe(false)
  })
})

describe('staffingForecastNote (the Roster line for someone who cannot refresh it)', () => {
  test('says nothing while recommendations still reach a week ahead', () => {
    expect(staffingForecastNote(null)).toBeNull()
    expect(staffingForecastNote({ stale: false, reason: null })).toBeNull()
    expect(staffingForecastNote({ stale: true, reason: 'old', lastDay: bsIn(23), daysLeft: 23 })).toBeNull()
  })
  test('names the last day covered, by its BS month, and who refreshes it', () => {
    const last = bsIn(-9)
    const text = staffingForecastNote({ stale: true, reason: 'running_out', lastDay: last, daysLeft: -9 })
    expect(text).toContain(`only covers days up to ${last.day} ${BS_MONTHS[last.month - 1]}`)
    expect(text).toContain('The Owner or an inventory supervisor or manager refreshes it')
  })
  test('says plainly when the outlet has never run one', () => {
    expect(staffingForecastNote({ stale: true, reason: 'none', lastDay: null })).toContain('has not been run for this outlet yet')
  })
  test('carries no apostrophe (it is a JS string the build has tripped on)', () => {
    expect(staffingForecastNote({ stale: true, reason: 'none' })).not.toMatch(/'/)
    expect(staffingForecastNote({ stale: true, reason: 'running_out', lastDay: bsIn(2), daysLeft: 2 })).not.toMatch(/'/)
  })
})
