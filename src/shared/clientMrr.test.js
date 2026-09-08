import fs from 'fs'
import path from 'path'
import { clientMRR, clientMrrBreakdown, monthlyRate } from './clientMrr'
import { SUITE_ADDON, DEFAULT_PLAN_PRICES } from '../data/pricingPlans'

// Money shared by two admin screens (the Admin Dashboard's platform MRR and Admin → Clients' per
// property figure), so a regression here misreports revenue in two places at once and agrees with
// itself while doing it. Every case below is a rule the original implementation got wrong once.

const PRICES = { ims: { starter: 1000, growth: 3000, pro: 5000 }, hr: 1500, pos: 2000 }

const future = new Date(Date.now() + 90 * 86400000).toISOString()
const past   = new Date(Date.now() - 90 * 86400000).toISOString()

const client = over => ({
  plan: 'pro',
  ims_enabled: true, ims_ends_at: future,
  hr_enabled: false, pos_enabled: false,
  suite_plan: null, billing_cycle: 'monthly',
  ...over,
})

describe('module windows', () => {
  it('bills a module that is enabled and paid through', () => {
    expect(clientMRR(client(), PRICES)).toBe(5000)
  })

  // The documented bug: checking the date alone billed a client whose module had been switched
  // off without its *_ends_at ever being cleared.
  it('does NOT bill a disabled module whose date is still in the future', () => {
    expect(clientMRR(client({ hr_enabled: false, hr_ends_at: future }), PRICES)).toBe(5000)
    expect(clientMRR(client({ ims_enabled: false }), PRICES)).toBe(0)
  })

  it('does NOT bill an enabled module whose date has passed', () => {
    expect(clientMRR(client({ hr_enabled: true, hr_ends_at: past }), PRICES)).toBe(5000)
    expect(clientMRR(client({ ims_ends_at: past }), PRICES)).toBe(0)
  })

  it('falls back to the legacy subscription_ends_at for IMS', () => {
    expect(clientMRR(client({ ims_ends_at: null, subscription_ends_at: future }), PRICES)).toBe(5000)
  })

  it('adds every enabled module', () => {
    const c = client({ hr_enabled: true, hr_ends_at: future, pos_enabled: true, pos_ends_at: future })
    expect(clientMRR(c, PRICES)).toBe(5000 + 1500 + 2000)
  })

  // ims_enabled defaults to true in the schema, so an absent flag must not read as "off".
  it('treats a missing ims_enabled as enabled', () => {
    const c = client({ ims_enabled: undefined })
    expect(clientMRR(c, PRICES)).toBe(5000)
  })
})

describe('Crest Suite is an add-on, not a bundle', () => {
  it('adds to the module sum rather than replacing it', () => {
    const c = client({ suite_plan: 'pro', suite_ends_at: future })
    expect(clientMRR(c, PRICES)).toBe(5000 + SUITE_ADDON.monthly)
  })

  it('tracks its own expiry independently of the modules', () => {
    const c = client({ suite_plan: 'pro', suite_ends_at: past })
    expect(clientMRR(c, PRICES)).toBe(5000)
  })

  // Rows written before suite_ends_at existed carry only suite_plan.
  it('falls back to the IMS window when suite_ends_at is absent', () => {
    const c = client({ suite_plan: 'pro', suite_ends_at: null })
    expect(clientMRR(c, PRICES)).toBe(5000 + SUITE_ADDON.monthly)
  })

  // The fallback must not resurrect Suite on a client whose IMS has lapsed — that is the case
  // where the pill and the money would disagree on the same screen.
  it('does not bill the fallback when IMS itself is not live', () => {
    const c = client({ ims_ends_at: past, suite_plan: 'pro', suite_ends_at: null })
    expect(clientMRR(c, PRICES)).toBe(0)
  })

  it('bills nothing extra without suite_plan, whatever the date says', () => {
    expect(clientMRR(client({ suite_plan: null, suite_ends_at: future }), PRICES)).toBe(5000)
  })
})

describe('annual billing', () => {
  it('is 25% off the monthly rate, rounded', () => {
    expect(monthlyRate(1000, 'annual')).toBe(750)
    expect(monthlyRate(1000, 'monthly')).toBe(1000)
    expect(monthlyRate(3333, 'annual')).toBe(2500) // 2499.75 rounds
  })

  it('applies to every module', () => {
    const c = client({ billing_cycle: 'annual', hr_enabled: true, hr_ends_at: future })
    expect(clientMRR(c, PRICES)).toBe(3750 + 1125)
  })

  // Suite discounts annually like everything else, off whatever it is currently priced at. The
  // published 2,000/1,500 pair already WAS that derivation, so this figure did not move when
  // Suite became admin-editable (S701) — asserted against the constant so it stays honest if the
  // shipped price does move.
  it('discounts Suite annually like every other line', () => {
    const c = client({ billing_cycle: 'annual', suite_plan: 'pro', suite_ends_at: future })
    expect(clientMRR(c, PRICES)).toBe(3750 + SUITE_ADDON.annual)
  })
})

// Suite used to be the one line here that no admin could reprice: its figure came from the
// SUITE_ADDON constant while every other line read the price table. A client's bill would not
// follow Settings > Plan Pricing for the most expensive thing on it (S701).
describe('the Suite add-on is priced from the table', () => {
  const suiteAt = n => ({ ...PRICES, suite: n })

  it('bills the admin-set Suite price', () => {
    const c = client({ suite_plan: 'pro', suite_ends_at: future })
    expect(clientMRR(c, suiteAt(3000))).toBe(5000 + 3000)
  })

  it('discounts the admin-set price annually', () => {
    const c = client({ billing_cycle: 'annual', suite_plan: 'pro', suite_ends_at: future })
    expect(clientMRR(c, suiteAt(3000))).toBe(3750 + 2250)
  })

  // A price table written before Suite was editable has no `suite` key at all, and a table that
  // sets it to 0 means 0 — the same 'is this a number' rule resolvePricing() applies.
  it('falls back to the shipped price when the table has no suite key', () => {
    const c = client({ suite_plan: 'pro', suite_ends_at: future })
    expect(clientMRR(c, PRICES)).toBe(5000 + SUITE_ADDON.monthly)
  })

  it('honours a Suite priced at 0 rather than restoring the default', () => {
    const c = client({ suite_plan: 'pro', suite_ends_at: future })
    expect(clientMRR(c, suiteAt(0))).toBe(5000)
  })
})

describe('breakdown', () => {
  it('lines always sum to the total', () => {
    const c = client({
      hr_enabled: true, hr_ends_at: future, pos_enabled: true, pos_ends_at: future,
      suite_plan: 'pro', suite_ends_at: future,
    })
    const { total, lines } = clientMrrBreakdown(c, PRICES)
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(total)
    expect(lines.map(l => l.key)).toEqual(['ims', 'hr', 'pos', 'suite'])
  })

  it('omits a module that is not billed rather than listing it at zero', () => {
    const { lines } = clientMrrBreakdown(client(), PRICES)
    expect(lines.map(l => l.key)).toEqual(['ims'])
  })

  // A Starter tier priced at 0 is a real configuration: the line stays, because a missing line
  // would read as IMS being switched off.
  it('keeps a zero-priced but live module as a line', () => {
    const c = client({ plan: 'starter' })
    const { total, lines } = clientMrrBreakdown(c, { ...PRICES, ims: { starter: 0 } })
    expect(total).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0].label).toBe('IMS · starter')
  })

  it('falls back to the shipped defaults when no price table is passed', () => {
    expect(clientMrrBreakdown(client()).total).toBeGreaterThan(0)
  })
})

// The billing-export Edge Function is a deliberate SECOND copy of the arithmetic above: it is
// pasted into the Supabase dashboard editor, so it cannot import this file. Nothing else in the
// suite can see it, and it drifted for months — it priced Crest Suite as a bundle REPLACING the
// module sum, the model this product retired in S552, while hss-suite billed off its payload. A
// comment saying "mirror any change here by hand" is not a mechanism; this is (S703).
//
// Source-read guard, the technique nepalMoney.test.js already uses. Full-line comments are
// stripped first, so the prose ABOUT the retired bundle does not trip the assertions against it.
describe('the billing-export copy keeps step with this file', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'supabase', 'functions', 'billing-export', 'index.ts'),
    'utf8',
  )
  const CODE = SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter(line => !line.trim().startsWith('//'))
    .join(' ')

  const shippedDefault = name => {
    const m = CODE.match(new RegExp('const ' + name + ' = (\\d+)'))
    expect(m).not.toBeNull()
    return Number(m[1])
  }

  it('prices Suite additively, not as a bundle', () => {
    expect(CODE).not.toMatch(/SUITE_BUNDLES/)
    expect(CODE).not.toMatch(/suite_bundle/)
    expect(CODE).toMatch(/breakdown\.suite = v/)
  })

  it('reads every price from settings.plan_prices, Suite included', () => {
    expect(CODE).toMatch(/planPrices\?\.ims/)
    expect(CODE).toMatch(/planPrices\?\.hr/)
    expect(CODE).toMatch(/planPrices\?\.pos/)
    expect(CODE).toMatch(/planPrices\?\.suite/)
  })

  // The fallbacks are the same shipped prices, hand-copied. Asserting the VALUES rather than their
  // presence is what makes a repricing in pricingPlans.js fail here instead of going unnoticed.
  it('falls back to the same shipped prices this repo ships', () => {
    expect(shippedDefault('DEFAULT_HR_PRICE')).toBe(DEFAULT_PLAN_PRICES.hr)
    expect(shippedDefault('DEFAULT_POS_PRICE')).toBe(DEFAULT_PLAN_PRICES.pos)
    expect(shippedDefault('DEFAULT_SUITE_PRICE')).toBe(DEFAULT_PLAN_PRICES.suite)

    const ims = CODE.match(/const DEFAULT_IMS_PRICES[^=]*= \{([^}]*)\}/)
    expect(ims).not.toBeNull()
    const parsed = {}
    ims[1].split(',').forEach(pair => {
      const [k, v] = pair.split(':').map(x => x.trim())
      if (k) parsed[k] = Number(v)
    })
    expect(parsed).toEqual(DEFAULT_PLAN_PRICES.ims)
  })
})
