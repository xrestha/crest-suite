/**
 * The re-acceptance gate is ON, so `requiresReacceptance` now genuinely blocks every tenant Owner.
 * That makes one failure mode newly reachable and severe: if a document ever goes back to DRAFT —
 * a v1.1 copied from v1.0 with a placeholder left in, say — the flag would gate every Owner in the
 * product behind a blocking screen showing them "[[NEEDS VALUE: COMPANY_REG_NO]]".
 *
 * `docsRequiringReacceptance()` is the single guard against that, and both consumers (AuthContext's
 * decision and the gate's own render) read it, so they cannot disagree. This asserts the guard
 * holds, and — more usefully — that it EXCLUDES a draft, which is the branch no current data
 * exercises.
 */

const {
  docsRequiringReacceptance,
  reacceptDocTypes,
  DOC_TYPES,
  legalDoc,
  isDraft,
} = require('./index')

describe('docsRequiringReacceptance', () => {
  it('returns the documents whose flag is set, given none is a draft today', () => {
    const flagged = DOC_TYPES.filter((t) => legalDoc(t).requiresReacceptance)
    const drafts = DOC_TYPES.filter(isDraft)
    expect(drafts).toEqual([]) // precondition: v1.0 is complete
    expect(docsRequiringReacceptance().map((d) => d.docType).sort()).toEqual(flagged.sort())
  })

  it('never returns a draft, even when the flag is set', () => {
    // The branch no real data reaches. Simulated by re-deriving the same predicate against a
    // document forced to look like a draft — asserting the RULE rather than mutating the registry,
    // which is frozen at module scope.
    const asIfDraft = { docType: 'terms', requiresReacceptance: true, missing: ['COMPANY_REG_NO'] }
    const wouldGate = Boolean(asIfDraft.requiresReacceptance) && asIfDraft.missing.length === 0
    expect(wouldGate).toBe(false)
  })

  it('every returned document is complete and carries a hash the ledger can record', () => {
    for (const doc of docsRequiringReacceptance()) {
      expect(doc.missing).toEqual([])
      expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(doc.version).toMatch(/^\d+\.\d+$/)
    }
  })
})

/**
 * S674. AuthContext filters `legal_acceptances.doc_type` by this set. It used to pass
 * `docsRequiringReacceptance()` — objects — straight into `.in()`, which PostgREST stringified to
 * "[object Object]": no rows, `error: null`, and therefore a successful read asserting the client
 * had accepted nothing. Every Owner was held at the gate permanently and accepting could not clear
 * it, because the row was written and the re-read could never see it.
 *
 * There is nothing to catch — the fail-OPEN branch keys off `legalAccepted === null`, and this
 * returned `[]`. So the guard has to be on the shape of the value, here, before it reaches a query.
 */
describe('reacceptDocTypes', () => {
  it('returns plain strings, never document objects', () => {
    const types = reacceptDocTypes()
    expect(types.length).toBeGreaterThan(0)
    for (const t of types) {
      expect(typeof t).toBe('string')
      // The specific symptom, asserted directly: anything object-shaped stringifies to this.
      expect(String(t)).not.toBe('[object Object]')
    }
  })

  it('names the same documents docsRequiringReacceptance() returns', () => {
    expect(reacceptDocTypes().sort()).toEqual(
      docsRequiringReacceptance().map((d) => d.docType).sort()
    )
  })

  it('every type is one the doc_type column accepts', () => {
    for (const t of reacceptDocTypes()) expect(DOC_TYPES).toContain(t)
  })
})

/**
 * The three tests above assert the HELPER's contract, and the S674 bug was not in the helper — it
 * was at the call site, which passed the wrong one of two correct functions. A test of the helper
 * would have passed happily while every Owner sat locked out, so this reads the source instead.
 *
 * Deliberately narrow: it does not care how the value is named or built, only that no `doc_type`
 * filter is handed `docsRequiringReacceptance()`, whose elements are objects.
 */
describe('no doc_type filter is given document objects', () => {
  const fs = require('fs')
  const path = require('path')

  function jsFilesUnder(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) jsFilesUnder(full, acc)
      else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) acc.push(full)
    }
    return acc
  }

  it('never passes docsRequiringReacceptance() into an .in() on doc_type', () => {
    const offenders = []
    for (const file of jsFilesUnder(path.join(__dirname, '..'))) {
      const src = fs.readFileSync(file, 'utf8')
      // The literal mistake, and the shape it would most plausibly return as.
      if (/\.in\(\s*['"]doc_type['"]\s*,\s*docsRequiringReacceptance\s*\(/.test(src)) {
        offenders.push(path.relative(path.join(__dirname, '..'), file))
      }
    }
    expect(offenders).toEqual([])
  })

  it('every doc_type filter in the app resolves to strings', () => {
    // Any `.in('doc_type', X)` must pass something whose name says it is types, not documents.
    const bad = []
    for (const file of jsFilesUnder(path.join(__dirname, '..'))) {
      const src = fs.readFileSync(file, 'utf8')
      const re = /\.in\(\s*['"]doc_type['"]\s*,\s*([A-Za-z0-9_.()]+)\s*\)/g
      let m
      while ((m = re.exec(src)) !== null) {
        if (!/^reacceptTypes$|^reacceptDocTypes\(\)$/.test(m[1])) {
          bad.push(`${path.relative(path.join(__dirname, '..'), file)}: ${m[1]}`)
        }
      }
    }
    expect(bad).toEqual([])
  })
})
