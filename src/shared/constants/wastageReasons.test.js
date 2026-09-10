import { WASTAGE_REASON_GROUPS, WASTAGE_REASONS, DEFAULT_WASTAGE_REASON } from './wastageReasons'

// `wastages.reason` has no CHECK constraint and nothing downstream validates it, so every one of
// these invariants fails SILENTLY in production: a duplicate renders twice and totals once, a
// missing 'Other' writes a reason nobody can pick, and the reserved key collides in a report that
// still adds up. A test that fails when you forget beats a comment that trusts you to remember.

describe('wastage reasons', () => {
  test('no reason is spelled twice across the groups', () => {
    // A duplicate gives the user two identical-looking options and WastageReport keys byReason on
    // the string, so the two would silently merge into one row with the wrong provenance.
    const dupes = WASTAGE_REASONS.filter((r, i) => WASTAGE_REASONS.indexOf(r) !== i)
    expect(dupes).toEqual([])
  })

  test("'Other' is present, because two call sites in Stock.js fall back to it", () => {
    // Stock.js uses DEFAULT_WASTAGE_REASON as the initial form value AND as the insert fallback for
    // a blank reason. Drop it from the list and the dropdown opens on an option that is not there.
    expect(DEFAULT_WASTAGE_REASON).toBe('Other')
    expect(WASTAGE_REASONS).toContain(DEFAULT_WASTAGE_REASON)
  })

  test("'Monthly (untagged)' is not offered — WastageReport reserves it", () => {
    // WastageReport.js keys undated catch-all rows (bs_day IS NULL) under this synthetic label.
    // Offering it as a real reason would merge two different facts into one row of the breakdown.
    expect(WASTAGE_REASONS).not.toContain('Monthly (untagged)')
  })

  test('every group has a label and at least one reason', () => {
    // An empty group renders a bare <optgroup> heading with nothing under it.
    WASTAGE_REASON_GROUPS.forEach(g => {
      expect(typeof g.group).toBe('string')
      expect(g.group.length).toBeGreaterThan(0)
      expect(g.reasons.length).toBeGreaterThan(0)
    })
  })

  test('the flat list is exactly the groups, in group order', () => {
    // The guide copy is derived from these two, so they must not be able to disagree.
    expect(WASTAGE_REASONS).toEqual(WASTAGE_REASON_GROUPS.reduce((a, g) => a.concat(g.reasons), []))
  })
})
