import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Placeholder verification scheme — real FonePay/eSewa webhook payload shapes and signature
// schemes differ per provider and aren't onboarded yet (see product-roadmap memory: "QR
// payment auto-confirmation"). Until a real merchant account is wired up, this expects a
// normalized body and a signature computed as HMAC-SHA256(secret, `txn_ref|amount|provider`),
// hex-encoded. Swap this function out for the provider's real scheme when that day comes —
// everything below it (idempotency, best-effort order matching) stays as-is.
async function verifySignature(
  secret: string,
  payload: { txn_ref: string; amount: number; provider: string },
  signature: string,
): Promise<boolean> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${payload.txn_ref}|${payload.amount}|${payload.provider}`))
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')
  return hex === (signature || '').toLowerCase()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } })

    const body = await req.json()
    const { client_id, provider, amount, reference, txn_ref, signature } = body

    if (!client_id || !provider || !(amount > 0) || !txn_ref) {
      return json({ error: 'client_id, provider, amount, txn_ref are required' }, 400)
    }

    const { data: settings } = await admin
      .from('settings').select('pos_webhook_secret').eq('client_id', client_id).maybeSingle()
    if (!settings?.pos_webhook_secret) return json({ error: 'Webhook not configured for this client' }, 400)

    const ok = await verifySignature(settings.pos_webhook_secret, { txn_ref, amount, provider }, signature)
    if (!ok) return json({ error: 'Invalid signature' }, 401)

    // Idempotent — a provider retry lands the same txn_ref twice; the unique constraint on
    // (client_id, provider, txn_ref) makes the second call a no-op instead of a duplicate row.
    const { data: existing } = await admin
      .from('pos_payment_confirmations')
      .select('id, matched_order_id')
      .eq('client_id', client_id).eq('provider', provider).eq('txn_ref', txn_ref)
      .maybeSingle()
    if (existing) return json({ ok: true, already_processed: true, matched_order_id: existing.matched_order_id })

    // Best-effort match by the reference embedded in the QR (buildDynamicQr's `reference`
    // param in src/utils/emvQr.js writes it as "CR<order_no>") against an order still open
    // on the floor. No match just means the confirmation sits unmatched for staff to
    // reconcile manually in the POS — it's logged either way.
    let matchedOrderId: string | null = null
    const orderNo = typeof reference === 'string' ? parseInt(reference.replace(/^CR/i, ''), 10) : NaN
    if (!isNaN(orderNo)) {
      const { data: order } = await admin
        .from('pos_orders').select('id')
        .eq('client_id', client_id).eq('order_no', orderNo).eq('status', 'open')
        .maybeSingle()
      matchedOrderId = order?.id ?? null
    }

    const { data: inserted, error } = await admin
      .from('pos_payment_confirmations')
      .insert({
        client_id, provider, amount, reference: reference || null, txn_ref,
        matched_order_id: matchedOrderId, raw_payload: body,
      })
      .select('id')
      .single()
    if (error) return json({ error: error.message }, 400)

    // Deliberately does NOT close the order itself — that requires the app's BS-fiscal-year
    // and invoice-numbering logic (src/utils/bsCalendar.js, assign_pos_invoice_no trigger),
    // which would mean re-implementing it a second time here in Deno and risking drift. The
    // POS floor screen (PosOrders.jsx) polls for a matched, unconsumed confirmation while the
    // Charge modal is showing a QR and finishes the close through its own existing, tested
    // closeOrder() path — this function's only job is verify + log + match.
    return json({ ok: true, id: inserted.id, matched_order_id: matchedOrderId })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Unknown error' }, 500)
  }
})
