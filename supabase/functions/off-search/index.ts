import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Open Food Facts NAME search for the nutrition editor (S883). A barcode lookup stays a browser
// call (`/api/v2/product/<code>.json` answers with CORS); a name search cannot.
//
// Why this is a server function: the legacy `world.openfoodfacts.org/cgi/search.pl` answers an
// anonymous browser with a 503 "Page temporarily unavailable … not available to anonymous users"
// page at busy times, and that page carries no Access-Control-Allow-Origin, so the browser saw a
// dead connection (measured 2026-11-04: 3 of 3 refused). Their newer search
// (`search.openfoodfacts.org`) answers, but sends no CORS header for any origin. From here neither
// limit applies, and OFF asks every caller for an identifying User-Agent, which a browser cannot set.
//
// Signed-in callers only, so it is not a free relay. No tenant data is read or written. The answer is
// trimmed to the fields the editor maps, and many hits carry no figures, so it asks for 24 and the
// editor keeps the usable ones.

const PAGE_SIZE = 24
const TIMEOUT_MS = 8000
const FIELDS = 'product_name,brands,code,nutriments,allergens_tags'
const NUTRIMENT_KEYS = [
  'energy-kcal_100g', 'energy_100g', 'proteins_100g', 'carbohydrates_100g',
  'fat_100g', 'sugars_100g', 'sodium_100g', 'salt_100g',
]

type Product = {
  code: string | null
  product_name: string | null
  brands: string | null
  nutriments: Record<string, number>
  allergens_tags: string[]
}

function trim(p: Record<string, unknown>): Product {
  const n = (p.nutriments ?? {}) as Record<string, unknown>
  const nutriments: Record<string, number> = {}
  for (const k of NUTRIMENT_KEYS) {
    const v = Number(n[k])
    if (n[k] != null && Number.isFinite(v)) nutriments[k] = v
  }
  // The newer search returns brands as an array, the legacy one as a comma string.
  const brands = Array.isArray(p.brands)
    ? p.brands.map(b => String(b).trim()).filter(Boolean).join(', ')
    : typeof p.brands === 'string' ? p.brands : null
  return {
    code: p.code == null ? null : String(p.code),
    product_name: typeof p.product_name === 'string' ? p.product_name : null,
    brands: brands || null,
    nutriments,
    allergens_tags: Array.isArray(p.allergens_tags) ? p.allergens_tags.map(String) : [],
  }
}

async function getJson(url: string, userAgent: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  try {
    const url  = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)
    const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error: authErr } = await caller.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json().catch(() => ({}))
    const q = typeof body?.q === 'string' ? body.q.trim() : ''
    if (q.length < 2 || q.length > 80) return json({ error: 'q must be 2 to 80 characters' }, 400)

    // The weather function's identifying string serves here too; OFF_USER_AGENT overrides it.
    const userAgent = Deno.env.get('OFF_USER_AGENT') || Deno.env.get('MET_USER_AGENT') || 'CrestSuite/1.0'
    const term = encodeURIComponent(q)

    const fresh = await getJson(
      `https://search.openfoodfacts.org/search?q=${term}&page_size=${PAGE_SIZE}&fields=${FIELDS}`, userAgent)
    if (fresh && Array.isArray(fresh.hits)) {
      return json({ products: (fresh.hits as Record<string, unknown>[]).map(trim), via: 'search' })
    }

    const legacy = await getJson(
      `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${term}&search_simple=1&action=process&json=1&page_size=${PAGE_SIZE}&fields=${FIELDS}`,
      userAgent)
    if (legacy && Array.isArray(legacy.products)) {
      return json({ products: (legacy.products as Record<string, unknown>[]).map(trim), via: 'legacy' })
    }

    // Both refused or timed out: an answer, not a failure of this function, so the editor can say
    // Open Food Facts is busy rather than that the connection dropped.
    return json({ products: [], reason: 'unavailable' })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
