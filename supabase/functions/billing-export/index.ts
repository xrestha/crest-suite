import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
}

// Called by HSS Suite's own it-crest-sync Edge Function, which has no crest-suite Supabase session
// and so can never send a Supabase JWT — this is why verify_jwt is off for this function
// (supabase/config.toml). Auth here is a static shared secret instead, compared in constant time so
// how quickly a mismatch is rejected can't leak how many characters were right (copied verbatim from
// pos-payment-webhook/index.ts, which has the identical concern for its own signature check).
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

// Ported from src/data/pricingPlans.js — this function is pasted into the Supabase dashboard editor
// (no build step, no shared import with the frontend bundle), so these are a deliberate duplicate.
// ims/hr/pos flat prices ARE overridable live via settings.plan_prices (read below); SUITE_BUNDLES has
// no DB override anywhere in this app — if pricingPlans.js ever changes, mirror it here too.
const DEFAULT_IMS_PRICES: Record<string, number> = { starter: 2000, growth: 2600, pro: 3500 }
const DEFAULT_HR_PRICE = 2600
const DEFAULT_POS_PRICE = 2000
const SUITE_BUNDLES: { key: string; monthly: number; annual: number }[] = [
  { key: 'starter', monthly: 5300, annual: 3975 },
  { key: 'growth', monthly: 5800, annual: 4350 },
  { key: 'pro', monthly: 6500, annual: 4875 },
]

function monthlyRate(base: number, billingCycle: string | null) {
  return billingCycle === 'annual' ? Math.round(base * 0.75) : base
}
function daysUntil(dateStr: string | null) {
  return dateStr ? Math.ceil((new Date(dateStr).getTime() - Date.now()) / 86400000) : null
}

// Exact port of clientMRR() (src/pages/dashboard/AdminDashboardOverview.jsx:95-119) — same
// suite-bundle-replaces-the-per-module-sum rule, same enabled+ends_at-in-future gates per module,
// same 25%-off-annual conversion. Adds three fields the live dashboard doesn't compute today, purely
// for the HSS side's benefit: next_renewal_at, billable, and pricing_basis (so a synced number is
// auditable, not a black box).
function computeBilling(c: any, planPrices: any) {
  const imsPrices = planPrices?.ims || DEFAULT_IMS_PRICES
  const hrPrice = planPrices?.hr ?? DEFAULT_HR_PRICE
  const posPrice = planPrices?.pos ?? DEFAULT_POS_PRICE

  const imsEnd = c.ims_ends_at || c.subscription_ends_at
  const imsD = daysUntil(imsEnd)
  const imsActive = c.ims_enabled !== false && !!imsEnd && imsD !== null && imsD > 0

  const suiteEnd = c.suite_ends_at || (imsActive ? imsEnd : null)
  const suiteD = daysUntil(suiteEnd)
  const suiteActive = !!c.suite_plan && !!suiteEnd && suiteD !== null && suiteD > 0

  const hrD = daysUntil(c.hr_ends_at)
  const hrActive = !!c.hr_enabled && !!c.hr_ends_at && hrD !== null && hrD > 0
  const posD = daysUntil(c.pos_ends_at)
  const posActive = !!c.pos_enabled && !!c.pos_ends_at && posD !== null && posD > 0

  let monthlyAmount = 0
  let pricingBasis = 'none'
  const breakdown: Record<string, number | null> = { ims: null, hr: null, pos: null, suite: null }

  if (suiteActive) {
    const bundle = SUITE_BUNDLES.find(b => b.key === c.suite_plan)
    if (bundle) {
      monthlyAmount = c.billing_cycle === 'annual' ? bundle.annual : bundle.monthly
      pricingBasis = 'suite_bundle'
      breakdown.suite = monthlyAmount
    }
  }
  if (pricingBasis !== 'suite_bundle') {
    if (imsActive) { const v = monthlyRate(imsPrices[c.plan] || 0, c.billing_cycle); monthlyAmount += v; breakdown.ims = v }
    if (hrActive) { const v = monthlyRate(hrPrice, c.billing_cycle); monthlyAmount += v; breakdown.hr = v }
    if (posActive) { const v = monthlyRate(posPrice, c.billing_cycle); monthlyAmount += v; breakdown.pos = v }
    if (monthlyAmount > 0) pricingBasis = 'per_module'
  }

  const candidates: string[] = []
  if (suiteActive && suiteEnd) candidates.push(suiteEnd)
  else {
    if (imsActive && imsEnd) candidates.push(imsEnd)
    if (hrActive) candidates.push(c.hr_ends_at)
    if (posActive) candidates.push(c.pos_ends_at)
  }
  const nextRenewalAt = candidates.length ? candidates.sort()[0] : null

  return {
    monthly_amount: monthlyAmount,
    pricing_basis: pricingBasis,
    module_breakdown: breakdown,
    next_renewal_at: nextRenewalAt,
    billable: monthlyAmount > 0,
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const expected = Deno.env.get('HSS_CREST_SYNC_SECRET')
    if (!expected) return json({ error: 'Server misconfigured: HSS_CREST_SYNC_SECRET not set' }, 500)
    // Compared as fixed-length SHA-256 digests rather than raw bytes. timingSafeEqual returns
    // early when the lengths differ, so feeding it the raw strings leaked the secret's length
    // through response timing — hashing first makes every comparison exactly 32 bytes regardless
    // of what was submitted.
    const given = req.headers.get('x-sync-secret') || ''
    const enc = new TextEncoder()
    const [expectedHash, givenHash] = await Promise.all([
      crypto.subtle.digest('SHA-256', enc.encode(expected)),
      crypto.subtle.digest('SHA-256', enc.encode(given)),
    ])
    if (!timingSafeEqual(new Uint8Array(expectedHash), new Uint8Array(givenHash))) {
      return json({ error: 'Invalid secret' }, 401)
    }

    const url = Deno.env.get('SUPABASE_URL')!
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } })

    const { data: clients, error: cErr } = await admin
      .from('clients')
      .select(
        'id, name, location, contact_person, contact_phone, is_active, is_premium, plan, ' +
        'hr_enabled, hr_plan, ims_enabled, pos_enabled, pos_plan, suite_plan, billing_cycle, ' +
        'is_trial, trial_expires_at, ims_ends_at, hr_ends_at, pos_ends_at, suite_ends_at, subscription_ends_at',
      )
    if (cErr) return json({ error: cErr.message }, 500)

    const { data: globalSettings } = await admin.from('settings').select('plan_prices').is('client_id', null).maybeSingle()
    const planPrices = (globalSettings as any)?.plan_prices || null

    const clientIds = (clients || []).map((c: any) => c.id)
    const { data: perClientSettings } = clientIds.length
      ? await admin
          .from('settings')
          .select('client_id, app_name, property_address, property_phone, property_email, vat_number, is_vat_registered, invoice_prefix, contact_phone, contact_email, contact_website')
          .in('client_id', clientIds)
      : { data: [] as any[] }
    const settingsByClient: Record<string, any> = {}
    ;(perClientSettings || []).forEach((s: any) => { settingsByClient[s.client_id] = s })

    const result = (clients || []).map((c: any) => {
      const billing = computeBilling(c, planPrices)
      const s = settingsByClient[c.id] || null
      return {
        crest_client_id: c.id,
        name: c.name,
        location: c.location,
        contact_person: c.contact_person,
        contact_phone: c.contact_phone,
        is_active: c.is_active,
        is_trial: c.is_trial,
        trial_expires_at: c.trial_expires_at,
        plan: c.plan,
        hr_enabled: c.hr_enabled,
        hr_plan: c.hr_plan,
        ims_enabled: c.ims_enabled,
        pos_enabled: c.pos_enabled,
        pos_plan: c.pos_plan,
        suite_plan: c.suite_plan,
        billing_cycle: c.billing_cycle,
        ims_ends_at: c.ims_ends_at,
        hr_ends_at: c.hr_ends_at,
        pos_ends_at: c.pos_ends_at,
        suite_ends_at: c.suite_ends_at,
        ...billing,
        buyer: s
          ? {
              app_name: s.app_name,
              property_address: s.property_address,
              property_phone: s.property_phone,
              property_email: s.property_email,
              vat_number: s.vat_number,
              is_vat_registered: s.is_vat_registered,
              invoice_prefix: s.invoice_prefix,
              contact_phone: s.contact_phone,
              contact_email: s.contact_email,
              contact_website: s.contact_website,
            }
          : null,
      }
    })

    return json({ generated_at: new Date().toISOString(), clients: result })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
