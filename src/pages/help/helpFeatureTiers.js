import { FEATURE_TIER } from '../../shared/featureCatalog'

// Help's Module Guide files each IMS page under the plan that unlocks it. The plan is never typed into
// Help: it is read from featureCatalog.js (FEATURE_TIER), the same list FeatureAccessModal and
// PremiumGate read, and helpFeatureTiers.test.js holds that list to AuthContext's plan sets. A page
// re-tiered there moves here with no edit. Until S849 every Help entry was filed by hand, and seven sat
// under the wrong plan: Stock Report under Starter while its route asked for Growth, and so on (DOCS-1).

// The four IMS bands, in the order the guide shows them.
export const TIER_META = Object.freeze([
  { tier: 'core',    label: 'Core — All Plans', planLabel: null,      planColor: 'var(--theme-text2)' },
  { tier: 'starter', label: 'Starter Plan',     planLabel: 'Starter', planColor: 'var(--theme-text3)' },
  { tier: 'growth',  label: 'Growth Plan',      planLabel: 'Growth',  planColor: 'var(--theme-green-text)' },
  { tier: 'pro',     label: 'Pro Plan',         planLabel: 'Pro',     planColor: 'var(--theme-accent-ink)' },
])

// The band one Help entry belongs in: its featureKey's tier, or core for a page every plan has.
export function tierOfEntry(entry) {
  return FEATURE_TIER[entry?.featureKey] ?? 'core'
}

// Help's flat entry list → [{ tier, label, planLabel, planColor, features }], entries kept in list
// order inside each band, empty bands left out.
export function groupImsFeatures(entries) {
  return TIER_META
    .map(meta => ({ ...meta, features: (entries || []).filter(e => tierOfEntry(e) === meta.tier) }))
    .filter(band => band.features.length > 0)
}
