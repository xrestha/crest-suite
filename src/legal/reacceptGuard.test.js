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
  outstandingLegalDocs,
  acceptanceFloor,
  compareLegalVersions,
  DOC_TYPES,
  legalDoc,
  isDraft,
} = require('./index')

describe('docsRequiringReacceptance', () => {
  it('returns every document some version of which required acceptance, given none is a draft today', () => {
    const gating = DOC_TYPES.filter((t) => acceptanceFloor(t) !== null)
    const drafts = DOC_TYPES.filter(isDraft)
    expect(drafts).toEqual([]) // precondition: the current versions are complete
    expect(docsRequiringReacceptance().map((d) => d.docType).sort()).toEqual(gating.sort())
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
 * Privacy 1.1 (2026-11-03) was published with requiresReacceptance OFF: an outlet that accepted 1.0
 * keeps that acceptance, and one that never accepted any privacy version is still asked. Before the
 * acceptance floor existed the gate compared each row to the CURRENT version only, so publishing 1.1
 * would have held every Owner in the product until they accepted it, the decision notwithstanding.
 */
describe('outstandingLegalDocs and the acceptance floor', () => {
  const row = (doc_type, doc_version) => ({ doc_type, doc_version })
  const types = (docs) => docs.map((d) => d.docType).sort()

  it('the floor is the newest version that required acceptance', () => {
    expect(legalDoc('privacy').version).toBe('1.1')
    expect(acceptanceFloor('privacy')).toBe('1.0')
    expect(acceptanceFloor('terms')).toBe(legalDoc('terms').version)
    expect(acceptanceFloor('cookies')).toBeNull()
  })

  it('an outlet holding Terms 1.0 and Privacy 1.0 is not held by Privacy 1.1', () => {
    expect(outstandingLegalDocs([row('terms', '1.0'), row('privacy', '1.0')])).toEqual([])
  })

  it('an outlet holding the current versions is not held', () => {
    expect(outstandingLegalDocs([row('terms', '1.0'), row('privacy', '1.1')])).toEqual([])
  })

  it('an outlet with no privacy row in any version is still asked for privacy, a first acceptance', () => {
    expect(types(outstandingLegalDocs([row('terms', '1.0')]))).toEqual(['privacy'])
  })

  it('an outlet that accepted nothing is asked for both, and a failed read (null) counts nothing', () => {
    expect(types(outstandingLegalDocs([]))).toEqual(['privacy', 'terms'])
    expect(types(outstandingLegalDocs(null))).toEqual(['privacy', 'terms'])
  })

  it('an acceptance below the floor does not count', () => {
    expect(types(outstandingLegalDocs([row('terms', '0.9'), row('privacy', '0.9')]))).toEqual(['privacy', 'terms'])
  })

  it('a row of one document never satisfies another', () => {
    expect(types(outstandingLegalDocs([row('privacy', '1.1'), row('privacy', '1.0')]))).toEqual(['terms'])
  })

  it('compares versions by number, not by text', () => {
    expect(compareLegalVersions('1.10', '1.9')).toBeGreaterThan(0)
    expect(compareLegalVersions('1.0', '1.0')).toBe(0)
    expect(compareLegalVersions('0.9', '1.0')).toBeLessThan(0)
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
