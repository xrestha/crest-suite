// Legal.jsx used to hard-code mailto:support@crestsuite.com — a domain the project does not own
// (S672 moved every other legal contact off it; this was the one that survived). Stops it coming
// back under any file, not just the one it shipped in.
import fs from 'fs'
import path from 'path'

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'generated') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(js|jsx)$/.test(entry.name) && full !== __filename) out.push(full)
  }
  return out
}

// Built by concatenation rather than written as one literal, so this file's own source text does
// not itself match the pattern it's asserting nothing else matches.
const DEAD_DOMAIN = 'crestsuite' + '.com'

test('no file under src/ links to the unowned domain in a mailto:', () => {
  const root = path.join(__dirname, '..')
  const pattern = new RegExp('mailto:[^"\'\\s]*' + DEAD_DOMAIN, 'i')
  const offenders = walk(root).filter((f) => pattern.test(fs.readFileSync(f, 'utf8')))
  expect(offenders).toEqual([])
})
