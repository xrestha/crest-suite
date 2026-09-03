/**
 * The provider's legal identity — registration number, PAN, registered office — now exists in three
 * places: the Terms markdown, the Privacy Policy markdown, and the COMPANY constant the printed
 * Subscription Agreement reads from.
 *
 * That duplication cannot be removed. The markdown must carry the literal text because it is what
 * gets hashed, and a hash computed over a template with placeholders in it would verify nothing at
 * all. So the copies stay, and this test is what makes them safe: it asserts every value in COMPANY
 * still appears verbatim in both documents.
 *
 * The failure it guards against is specific and quiet. Someone corrects the registration number in
 * the Terms, re-runs the hash script, ships — and the signed paper agreement generated the next day
 * still carries the old number, because the generator reads a constant nobody thought to update.
 * Two documents that are supposed to be the same contract then name two different companies, and
 * nothing anywhere fails. Only a comparison catches it.
 */

const { COMPANY, DOC_TYPES } = require('./index')
const { LEGAL_TEXT } = require('./generated/legalText')

// Values that must be identical everywhere they appear. `name` is checked separately because the
// Privacy Policy wraps it in markdown bold, so the raw string is not a substring of that line.
const IDENTITY_FIELDS = ['regNo', 'pan', 'address']

describe('company identity is the same in every document', () => {
  it.each(IDENTITY_FIELDS)('terms carries the same %s as COMPANY', (field) => {
    expect(LEGAL_TEXT.terms).toContain(COMPANY[field])
  })

  it('privacy policy carries the same registered address as COMPANY', () => {
    // The Privacy Policy names the address (section 10 and section 13) but has no reason to quote a
    // registration number or PAN — it is not the contracting instrument.
    expect(LEGAL_TEXT.privacy).toContain(COMPANY.address)
  })

  it.each(DOC_TYPES)('%s names the company', (docType) => {
    expect(LEGAL_TEXT[docType]).toContain(COMPANY.name)
  })

  it.each(['legalEmail', 'privacyEmail', 'supportEmail'])(
    'the %s in COMPANY appears in at least one document',
    (field) => {
      const anywhere = DOC_TYPES.some((t) => LEGAL_TEXT[t].includes(COMPANY[field]))
      expect(anywhere).toBe(true)
    }
  )

  it('the privacy officer named in COMPANY is the one the Privacy Policy names', () => {
    expect(LEGAL_TEXT.privacy).toContain(COMPANY.privacyOfficer)
  })
})

describe('no placeholder survived into a published document', () => {
  // Distinct from the draft detector in legalHash.test.js, which asserts the detector AGREES with
  // the markers present. This asserts there are none left at all — the state that makes v1.0
  // publishable, and one that must not silently regress when v1.1 is copied from v1.0.
  it.each(DOC_TYPES)('%s contains no [[NEEDS VALUE]] marker', (docType) => {
    expect(LEGAL_TEXT[docType]).not.toMatch(/\[\[NEEDS VALUE:/)
  })

  it.each(DOC_TYPES)('%s contains no unreplaced {{PLACEHOLDER}} from the source spec', (docType) => {
    expect(LEGAL_TEXT[docType]).not.toMatch(/\{\{[A-Z0-9_]+\}\}/)
  })
})
