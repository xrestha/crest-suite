import fs from 'fs'
import path from 'path'

// PERF-9 (S876): Help's five Module Guide lists load as chunks of their own, once per page load, and
// a failed fetch is asked for again by the next call rather than replayed to it.

// POS stands in for any of the five. Its list is read through a getter, so a test can count the
// reads and make one throw the way a chunk that never arrived does.
const mockPos = { fail: false, reads: 0 }
jest.mock('./posFeatures', () => ({
  __esModule: true,
  get POS_FEATURES() {
    mockPos.reads += 1
    if (mockPos.fail) throw Object.assign(new Error('Loading chunk 812 failed.'), { name: 'ChunkLoadError' })
    return [{ icon: '🔐', name: 'POS Login' }]
  },
}))

let loader
beforeEach(() => {
  jest.resetModules()
  mockPos.fail = false
  mockPos.reads = 0
  loader = require('./loadHelpFeatures')
})

describe('loadHelpFeatures', () => {
  it('fetches the five lists once, however many callers ask', async () => {
    expect(loader.loadedHelpFeatures()).toBeNull()
    const first = loader.loadHelpFeatures()
    expect(loader.loadHelpFeatures()).toBe(first)

    const lists = await first
    for (const key of ['IMS_FEATURES', 'SUITE_FEATURES', 'HR_FEATURES', 'POS_FEATURES', 'ADMIN_FEATURES']) {
      expect(Array.isArray(lists[key]) && lists[key].length > 0).toBe(true)
    }
    const filed = lists.IMS_FEATURE_TIERS.reduce((n, band) => n + band.features.length, 0)
    expect(filed).toBe(lists.IMS_FEATURES.length)

    expect(loader.loadedHelpFeatures()).toBe(lists)
    expect(await loader.loadHelpFeatures()).toBe(lists)
    expect(mockPos.reads).toBe(1)
  })

  it('surfaces a failed fetch, and the next call asks again', async () => {
    mockPos.fail = true
    const failed = loader.loadHelpFeatures()
    await expect(failed).rejects.toThrow('Loading chunk 812 failed.')
    expect(loader.loadedHelpFeatures()).toBeNull()

    mockPos.fail = false
    const retry = loader.loadHelpFeatures()
    expect(retry).not.toBe(failed)
    const lists = await retry
    expect(lists.POS_FEATURES.map(f => f.name)).toEqual(['POS Login'])
    expect(loader.loadedHelpFeatures()).toBe(lists)
    expect(mockPos.reads).toBe(2)
  })
})

// A static import of a list file anywhere in the app puts it back in that file's chunk, and in the
// main bundle if the file is eager, which is the ~430 KB this split took out of /help's first paint.
// Only loadHelpFeatures.js may reach them, through import(); tests are free to import them.
describe('the lists stay out of every static import', () => {
  const SRC = path.join(__dirname, '..', '..')
  const STATIC_IMPORT = /(^|\n)\s*(import|export)\b[^;]*?\bfrom\s+['"][^'"]*\b(ims|suite|hr|pos|admin)Features['"]/

  function sourceFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) sourceFiles(full, out)
      else if (/\.jsx?$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) out.push(full)
    }
    return out
  }

  it('no source file imports a list file directly', () => {
    const offenders = sourceFiles(SRC)
      .filter(file => STATIC_IMPORT.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(SRC, file))
    expect(offenders).toEqual([])
  })
})
