import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const url  = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const svc  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Verify caller is admin using their own JWT
    const caller = createClient(url, anon, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await caller.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    const { data: profile } = await caller
      .from('profiles').select('role').eq('id', user.id).single()
    if (profile?.role !== 'admin') return json({ error: 'Forbidden' }, 403)

    // Caller verified as admin — perform operation with service role
    const admin = createClient(url, svc, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { action, ...params } = await req.json()

    if (action === 'getUser') {
      const result = await admin.auth.admin.getUserById(params.userId)
      return json(result)
    }

    if (action === 'createUser') {
      const result = await admin.auth.admin.createUser({
        email: params.email,
        password: params.password,
        email_confirm: true,
        user_metadata: { full_name: params.full_name ?? '' },
      })
      return json(result)
    }

    if (action === 'deleteUser') {
      const result = await admin.auth.admin.deleteUser(params.userId)
      return json(result)
    }

    if (action === 'deleteClientData') {
      const { clientId } = params
      if (!clientId) return json({ error: 'clientId is required' }, 400)

      // Helper — throws on any Supabase error so failures surface immediately
      async function del(query: Promise<{ error: unknown }>, label: string) {
        const { error } = await query
        if (error) throw new Error(`Failed to delete ${label}: ${(error as { message?: string }).message ?? String(error)}`)
      }

      // ── Step 1: collect IDs we need for child lookups ──────────────────
      const { data: periods } = await admin.from('monthly_periods').select('id').eq('client_id', clientId)
      const periodIds = (periods || []).map((p: { id: string }) => p.id)

      const { data: recipeRows } = await admin.from('recipes').select('id').eq('client_id', clientId)
      const recipeIds = (recipeRows || []).map((r: { id: string }) => r.id)

      const { data: poRows } = await admin.from('purchase_orders').select('id').eq('client_id', clientId)
      const poIds = (poRows || []).map((p: { id: string }) => p.id)

      const { data: reqRows } = await admin.from('requisitions').select('id').eq('client_id', clientId)
      const reqIds = (reqRows || []).map((r: { id: string }) => r.id)

      // ── Step 2: delete deepest children first (FK → other tables in list) ──
      if (recipeIds.length > 0) {
        await del(admin.from('recipe_ingredients').delete().in('recipe_id', recipeIds), 'recipe_ingredients')
      }
      if (poIds.length > 0) {
        await del(admin.from('purchase_order_items').delete().in('po_id', poIds), 'purchase_order_items')
      }
      if (reqIds.length > 0) {
        await del(admin.from('requisition_lines').delete().in('requisition_id', reqIds), 'requisition_lines')
      }

      // ── Step 3: period-keyed tables (all reference monthly_periods.id) ──
      if (periodIds.length > 0) {
        await del(admin.from('purchase_entries').delete().in('period_id', periodIds), 'purchase_entries')
        await del(admin.from('vendor_returns').delete().in('period_id', periodIds), 'vendor_returns')
        await del(admin.from('opening_stock').delete().in('period_id', periodIds), 'opening_stock')
        await del(admin.from('closing_stock').delete().in('period_id', periodIds), 'closing_stock')
        await del(admin.from('wastages').delete().in('period_id', periodIds), 'wastages')
        await del(admin.from('sales_entries').delete().in('period_id', periodIds), 'sales_entries')
        await del(admin.from('budgets').delete().in('period_id', periodIds), 'budgets')
      }

      // purchase_orders and requisitions have both period_id and client_id —
      // delete by client_id to catch any without a period too
      await del(admin.from('purchase_orders').delete().eq('client_id', clientId), 'purchase_orders')
      await del(admin.from('requisitions').delete().eq('client_id', clientId), 'requisitions')

      // ── Step 4: client-keyed root tables ───────────────────────────────
      await del(admin.from('overheads').delete().eq('client_id', clientId), 'overheads')
      await del(admin.from('par_levels').delete().eq('client_id', clientId), 'par_levels')
      await del(admin.from('monthly_periods').delete().eq('client_id', clientId), 'monthly_periods')
      await del(admin.from('recipes').delete().eq('client_id', clientId), 'recipes')
      await del(admin.from('items').delete().eq('client_id', clientId), 'items')
      await del(admin.from('vendors').delete().eq('client_id', clientId), 'vendors')
      await del(admin.from('categories').delete().eq('client_id', clientId), 'categories')

      return json({ success: true })
    }

    return json({ error: `Unknown action: ${action}` }, 400)
  } catch (err) {
    // Always return 200 so supabase-js forwards the body — non-2xx responses
    // are swallowed by the client and the actual message is lost.
    return json({ error: (err as Error).message })
  }
})
