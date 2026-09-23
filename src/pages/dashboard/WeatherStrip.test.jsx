import { dayTip } from './WeatherStrip'
import { weatherLook } from '../../modules/dashboard/weatherEffect'

// The Tip is where the strip explains itself, so its sentences are claims about the code (S785).
const tip = (w, extra = {}) => dayTip({ iso: '2026-09-24', isToday: false, w, look: weatherLook(w), tagPct: null, ...extra })
const wet = { precip_mm: 40.2, complete: true, temp_max: 22.4, temp_min: 17, cloud_pct: 96, thunder: false }

describe('dayTip', () => {
  test('names the day in BS and states the rain and the high/low', () => {
    const t = tip(wet)
    expect(t).toMatch(/^Thursday, 8th Ashwin: heavy rain\./)
    expect(t).toContain('40.2 mm of rain between 5:45 am and 11:45 pm.')
    expect(t).toContain('High 22°, low 17° over the same hours.')
  })

  test('a missing temperature promises no time it will arrive', () => {
    const t = tip({ ...wet, temp_max: null, temp_min: null })
    expect(t).toContain('No temperature in this forecast yet.')
    expect(t).not.toMatch(/next update|arrives/)
  })

  test('the tag sentence follows the direction of the Owner\'s figure', () => {
    expect(tip(wet, { tagPct: 60 })).toContain('lowering this day\'s sales forecast to 60%')
    expect(tip(wet, { tagPct: 120 })).toContain('raising this day\'s sales forecast to 120%')
    expect(tip(wet, { tagPct: 100 })).toContain('at a usual day\'s level (100%')
    expect(tip(wet)).not.toMatch(/sales forecast/)
  })

  test('today says which parts are frozen before opening and which follow updates', () => {
    expect(tip(wet, { isToday: true })).toContain('the sky picture follows the latest update')
    expect(tip({ ...wet, complete: false }, { isToday: true })).toContain('covers the rest of today')
    expect(tip(wet)).not.toContain('sky picture follows')
  })

  test('a day the forecast does not reach says so', () => {
    expect(dayTip({ iso: '2026-09-24', isToday: false, w: null, look: null, tagPct: null }))
      .toBe('Thursday, 8th Ashwin. The forecast does not reach this day yet.')
  })
})
