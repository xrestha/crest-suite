// The legalHash.test.js pattern (src/legal/legalHash.test.js): a test that fails when you forget
// to keep two things in sync, rather than a comment that trusts you to remember. APP_VERSION and
// public/service-worker.js's CACHE_NAME must move together, or a fix never reaches a browser still
// serving the cached bundle (CLAUDE.md's PWA service worker rule).
import fs from 'fs'
import path from 'path'
import { APP_VERSION } from './appVersion'

test('APP_VERSION matches public/service-worker.js CACHE_NAME', () => {
  const swPath = path.join(__dirname, '..', '..', 'public', 'service-worker.js')
  const sw = fs.readFileSync(swPath, 'utf8')
  const match = sw.match(/const CACHE_NAME = '([^']+)'/)
  expect(match).not.toBeNull()
  expect(APP_VERSION).toBe(match[1])
})
