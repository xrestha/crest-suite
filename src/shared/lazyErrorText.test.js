/**
 * The error sentences off the main file (S876, PERF-8).
 *
 * errorText.js (~178 KB of source) rode in the main file every page waits for, through three eager
 * screens that need a sentence only after something has failed. They fetch it through
 * lazyErrorText.js now, and the command palette and the Quick Calculator load on demand as well
 * (LoadOnOpen.jsx). Two things are pinned here: the fallback when the table cannot be fetched, and
 * that nothing on the main file imports any of them again, which no other test would notice: the
 * build stays green and the first screen is simply slower.
 */
import fs from 'fs'
import path from 'path'
import { errorInfoLater, errorLineLater, UNAVAILABLE_TEXT } from './lazyErrorText'

// The table's file cannot be fetched: offline, on a device that never downloaded it.
jest.mock('./errorText', () => { throw new Error('Loading chunk 812 failed.') })

describe('when the error table cannot be fetched', () => {
  it('still gives a sentence, with the detail kept as errorInfo builds it', async () => {
    const dup = { code: '23505', message: 'duplicate key value violates unique constraint "items_client_name_key"' }
    expect(await errorInfoLater(dup, 'staff')).toEqual({
      text: UNAVAILABLE_TEXT,
      detail: '23505 · duplicate key value violates unique constraint "items_client_name_key"',
    })
    expect(await errorLineLater({ message: 'TypeError: Failed to fetch' })).toBe(`${UNAVAILABLE_TEXT} (TypeError: Failed to fetch)`)
    expect(await errorLineLater('Request timed out after 20s')).toBe(`${UNAVAILABLE_TEXT} (Request timed out after 20s)`)
    expect(await errorLineLater(null)).toBe(UNAVAILABLE_TEXT)
  })

  it('never claims the write did not land: a dead fetch does not prove that', () => {
    expect(UNAVAILABLE_TEXT).not.toMatch(/nothing was saved|not saved|did not save|was not recorded/i)
    expect(UNAVAILABLE_TEXT).toMatch(/whether it went through/)
  })
})

// Every module a STATIC import reaches from src/index.js is in the main file; a dynamic import()
// is not followed, because webpack gives it a file of its own.
const SRC = path.join(__dirname, '..')
const EXTS = ['', '.js', '.jsx', '/index.js', '/index.jsx']
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g

function resolveFrom(file, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.resolve(path.dirname(file), spec)
  for (const ext of EXTS) {
    const p = base + ext
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  return null
}

function mainFileModules() {
  const seen = new Set()
  const queue = [path.join(SRC, 'index.js')]
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file) || !/\.jsx?$/.test(file)) continue
    seen.add(file)
    for (const m of fs.readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      const next = resolveFrom(file, m[1])
      if (next) queue.push(next)
    }
  }
  return [...seen].map(f => path.relative(SRC, f).split(path.sep).join('/'))
}

describe('the main file', () => {
  const eager = mainFileModules()

  // S878: the legal re-acceptance screen too, fetched only for an Owner with a document to accept.
  it('reaches neither the error table, ActionError, the command palette, the calculator nor the legal re-acceptance screen', () => {
    for (const file of ['shared/errorText.js', 'components/ActionError.jsx', 'components/CommandPalette.js', 'components/Calculator.js', 'components/LegalReacceptance.jsx']) {
      expect(eager).not.toContain(file)
    }
  })

  // A source walk that reaches nothing passes every check above, so it must reach what is eager.
  it('the walk is real: it reaches the screens that stand in for them', () => {
    expect(eager).toEqual(expect.arrayContaining([
      'App.js', 'components/Layout.js', 'components/LoadOnOpen.jsx', 'context/SettingsContext.js',
      'modules/pos/TillOutletGate.jsx', 'components/ProtectedRoute.js', 'components/ActionErrorView.jsx',
      'shared/lazyErrorText.js',
    ]))
  })
})
