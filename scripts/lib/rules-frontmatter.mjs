// Shared reader for the `.claude/rules/*.md` corpus, used by check-rules-globs.mjs (T3) and
// check-rules-stubs.mjs (T4).
//
// It exists as one module rather than two copies for the reason CLAUDE.md gives about
// `clientMrr.js`: two parsers of the same frontmatter drift, and the drift shows up as one check
// passing while the other fails on the same file, which reads as a bug in the corpus rather than
// a bug in the tooling.
//
// The frontmatter is deliberately parsed by hand instead of pulling in a YAML dependency. The
// shape is fixed and trivial — a `paths:` key holding a list of quoted globs, with `#` comment
// lines allowed inside the list (report-pages.md uses one to record why its glob set is as wide
// as it is). A parser that accepted more than that would be accepting shapes the loader itself
// does not, which would make this check pass on a file that never loads.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const RULES_DIR = join(ROOT, '.claude', 'rules')

// Read as UTF-8 and normalise CRLF away. With `core.autocrlf=true` and no `.gitattributes` (see
// T1), the same file is CRLF in this working tree and LF in a Linux checkout — every character
// count and line split below would otherwise differ by platform.
export function readText(path) {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

/** Every `.claude/rules/*.md`, sorted, as repo-relative paths. */
export function ruleFiles() {
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => join(RULES_DIR, f))
}

/**
 * Split leading `---` frontmatter off a document.
 * Returns { frontmatter, body, hasFrontmatter } with frontmatter as raw text.
 */
export function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return { frontmatter: '', body: text, hasFrontmatter: false }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { frontmatter: '', body: text, hasFrontmatter: false }
  return {
    frontmatter: text.slice(4, end + 1),
    body: text.slice(end + 4),
    hasFrontmatter: true,
  }
}

/**
 * The `paths:` globs of one rule file, with the 1-based line number each was declared on so a
 * failure can point at the exact line to edit.
 * Returns [] for a file with no frontmatter or no `paths:` key — the caller decides whether that
 * is a failure, because it means different things in T3 and T4.
 */
export function parsePaths(text) {
  const { frontmatter, hasFrontmatter } = splitFrontmatter(text)
  if (!hasFrontmatter) return []

  const out = []
  let inPaths = false
  frontmatter.split('\n').forEach((line, i) => {
    const lineNo = i + 2 // +1 for 0-index, +1 for the opening `---`
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return
    if (/^paths:\s*$/.test(trimmed)) {
      inPaths = true
      return
    }
    // Any other top-level key ends the list. Indentation is what distinguishes a list item
    // (`  - "…"`) from a sibling key at column 0.
    if (!/^\s/.test(line) && trimmed.endsWith(':')) {
      inPaths = false
      return
    }
    if (!inPaths) return
    const m = trimmed.match(/^-\s*["']?(.+?)["']?\s*$/)
    if (m) out.push({ glob: m[1], line: lineNo })
  })
  return out
}

/**
 * Translate one `paths:` glob to a RegExp over forward-slash repo-relative paths.
 *
 * Supports the three forms the corpus actually uses: a literal path (`vercel.json`), a trailing
 * `/**` subtree (`src/modules/hr/**`), and an embedded `**\/` crossing directories
 * (`src/**\/*.css`). `*` stops at a separator, `**` does not — the standard globstar split, and
 * the one the loader applies.
 */
export function globToRegExp(glob) {
  let re = '^'
  let i = 0
  while (i < glob.length) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 2
        if (glob[i] === '/') {
          // `**/` matches zero or more directories, so `src/**/*.css` covers `src/index.css`.
          re += '(?:[^/]*/)*'
          i += 1
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
        i += 1
      }
    } else if (c === '?') {
      re += '[^/]'
      i += 1
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      i += 1
    }
  }
  return new RegExp(re + '$')
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'coverage', '.vercel', '.next'])

/** Every tracked-ish file in the working tree, repo-relative, forward slashes. */
export function walkTree(dir = ROOT, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkTree(join(dir, entry.name), acc)
    } else if (entry.isFile()) {
      acc.push(relative(ROOT, join(dir, entry.name)).split(sep).join('/'))
    }
  }
  return acc
}

export function relFromRoot(path) {
  return relative(ROOT, path).split(sep).join('/')
}

export { statSync }
