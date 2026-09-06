import fs from 'fs'
import path from 'path'
import { FEATURE_GROUPS, FEATURE_LABELS, FEATURE_TIER } from './featureCatalog'

// PremiumGate headlines the feature the reader clicked, by looking its `featureKey` up here. A
// key that is routed in App.js (or tagged on a nav item) but missing from the catalog silently
// falls back to the plan-only headline — so the mapping is asserted against the source.
describe('featureCatalog covers every gated key in the product', () => {
  const read = rel => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8')
  const keysIn = (src, re) => [...new Set([...src.matchAll(re)].map(m => m[1]))]

  test('every featureKey in App.js has a label', () => {
    const keys = keysIn(read('App.js'), /featureKey="([a-z_]+)"/g)
    expect(keys.length).toBeGreaterThan(20)
    const missing = keys.filter(k => !FEATURE_LABELS[k])
    expect(missing).toEqual([])
  })

  test('every featureKey on a Layout.js nav item has a label', () => {
    const keys = keysIn(read('components/Layout.js'), /featureKey:\s*'([a-z_]+)'/g)
    expect(keys.length).toBeGreaterThan(20)
    const missing = keys.filter(k => !FEATURE_LABELS[k])
    expect(missing).toEqual([])
  })

  test('keys are unique across tiers, and every keyed feature has a tier', () => {
    const all = FEATURE_GROUPS.flatMap(g => g.features).filter(f => f.key).map(f => f.key)
    expect(new Set(all).size).toBe(all.length)
    for (const k of all) expect(['starter', 'growth', 'pro', 'pos']).toContain(FEATURE_TIER[k])
  })
})
