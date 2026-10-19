import { sectionLabel, sectionList, failedSectionKeys, newlyMissingSections, trendUnavailableText } from './sectionNames'

describe('section names in words (S849, OWNER-REPORT-2)', () => {
  test('each section key has its words, and an unknown key comes back as itself', () => {
    expect(sectionLabel('hr')).toBe('Crest HR')
    expect(sectionLabel('laborAnalytics')).toBe('Labor Analytics')
    expect(sectionLabel('shrinkageTrend')).toBe('Shrinkage Trend')
    expect(sectionLabel('deliveryCommission')).toBe('Delivery commission')
    expect(sectionLabel('somethingNew')).toBe('somethingNew')
  })

  test('a list reads as a sentence', () => {
    expect(sectionList([])).toBe('')
    expect(sectionList(['hr'])).toBe('Crest HR')
    expect(sectionList(['hr', 'laborAnalytics'])).toBe('Crest HR and Labor Analytics')
    expect(sectionList(['ims', 'trend', 'variance'])).toBe('Crest IMS, Trend and Item Variance')
  })

  test('failed sections are the top-level ones, then Inventory Depth’s sub-sections, each once', () => {
    expect(failedSectionKeys(null)).toEqual([])
    expect(failedSectionKeys({ sectionErrors: null })).toEqual([])
    expect(failedSectionKeys({
      sectionErrors: { hr: 'x', laborAnalytics: 'y' },
      inventoryDepth: { sectionErrors: { shrinkageTrend: 'z' } },
    })).toEqual(['hr', 'laborAnalytics', 'shrinkageTrend'])
  })
})

describe('newlyMissingSections: Regenerate never swaps a complete report for a partial one (OWNER-REPORT-3)', () => {
  const stored = {
    ims: {}, hr: { payroll: {} }, pos: null, trend: {}, laborAnalytics: {},
    inventoryDepth: { deadSlowStock: {}, variance: {}, shrinkageTrend: {}, sectionErrors: null },
    sectionErrors: null,
  }

  test('a fresh snapshot missing a section the stored one has: named', () => {
    const fresh = { ...stored, hr: null, laborAnalytics: null, sectionErrors: { hr: 'Failed to fetch', laborAnalytics: 'x' } }
    expect(newlyMissingSections(stored, fresh)).toEqual(['hr', 'laborAnalytics'])
  })

  test('an Inventory Depth sub-section the stored one has: named', () => {
    const fresh = { ...stored, inventoryDepth: { ...stored.inventoryDepth, variance: null, sectionErrors: { variance: 'timeout' } } }
    expect(newlyMissingSections(stored, fresh)).toEqual(['variance'])
  })

  test('a section the stored report never had (module off then) does not block the write', () => {
    const fresh = { ...stored, sectionErrors: { pos: 'x' } }
    expect(newlyMissingSections(stored, fresh)).toEqual([])
  })

  test('a section that had already failed in the stored report does not block it either', () => {
    const storedPartial = { ...stored, hr: null, sectionErrors: { hr: 'x' } }
    const fresh = { ...stored, hr: null, sectionErrors: { hr: 'y' } }
    expect(newlyMissingSections(storedPartial, fresh)).toEqual([])
  })

  test('a complete fresh snapshot: nothing missing', () => {
    expect(newlyMissingSections(stored, stored)).toEqual([])
    expect(newlyMissingSections(null, stored)).toEqual([])
  })
})

describe('why a Trend comparison is missing, in words (S849, OWNER-REPORT-19)', () => {
  test('a prior whose report was not made yet names the two presses that fix it', () => {
    expect(trendUnavailableText({ reason: 'no_report', period: { bs_year: 2082, bs_month: 5 } }))
      .toBe("Bhadra 2082's report had not been made when this one was. Open Bhadra's report, then Regenerate this one to compare.")
  })
  test('no period, and a period still open', () => {
    expect(trendUnavailableText({ reason: 'no_period', period: null })).toBe('No period exists for this comparison.')
    expect(trendUnavailableText({ reason: 'not_closed', period: { bs_year: 2083, bs_month: 1 } })).toBe('Baisakh 2083 is still open.')
  })
})
