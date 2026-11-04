import { sampleDaysText, plateAverageLine, occasionalAverageLine, printedAverage } from './forecastAverageNote'

// S877: Demand Forecast's "Show averages" second line. The figure is the same toFixed(1) average
// the hover and the printed sheet already showed; only the sample count is new on screen.
describe('forecastAverageNote', () => {
  it('names the sample days, singular and plural, and nothing for an unknown or empty count', () => {
    expect(sampleDaysText(8)).toBe('8 days')
    expect(sampleDaysText(1)).toBe('1 day')
    expect(sampleDaysText(0)).toBeNull()
    expect(sampleDaysText(null)).toBeNull()
    expect(sampleDaysText(undefined)).toBeNull()
  })

  it('a plate line is the raw average and the days behind it', () => {
    expect(plateAverageLine(2.36, 8)).toBe('avg 2.4 · 8 days')
    expect(plateAverageLine(1, 1)).toBe('avg 1.0 · 1 day')
    // A run written before sample_count existed: the average alone, never a guessed count.
    expect(plateAverageLine(2.36, null)).toBe('avg 2.4')
  })

  it('an occasional line adds only the days, since its average is already beside its name', () => {
    expect(occasionalAverageLine(6)).toBe('over 6 days')
    expect(occasionalAverageLine(null)).toBeNull()
  })

  it('the printed bracket is unchanged while the toggle is off', () => {
    expect(printedAverage(2.36, 8, false)).toBe('(2.4)')
    expect(printedAverage(2.36, 8, true)).toBe('(2.4 · 8 days)')
    expect(printedAverage(0.44, null, true)).toBe('(0.4)')
  })
})
