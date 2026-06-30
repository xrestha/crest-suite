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
    const url  = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const svc  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    // Service-role client used for all privileged writes
    const admin = createClient(url, svc, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const body = await req.json()
    const { action, ...params } = body

    // ── Self-service trial signup — no admin auth required ────────────────────
    if (action === 'register_trial') {
      const { business_name, email, password, full_name, phone } = params
      if (!business_name || !email || !password) {
        return json({ error: 'business_name, email and password are required' }, 400)
      }

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: full_name || business_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const now          = new Date()
      const trialExpires = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000) // +7 days
      const trialPurge   = new Date(now.getTime() + 22 * 24 * 60 * 60 * 1000) // +7+15 days

      const { data: client, error: clientErr } = await admin
        .from('clients')
        .insert({
          name:              business_name,
          contact_person:    full_name || business_name,
          contact_phone:     phone || null,
          plan:              'starter',
          is_trial:          true,
          trial_start_date:  now.toISOString(),
          trial_expires_at:  trialExpires.toISOString(),
          trial_purge_at:    trialPurge.toISOString(),
          ims_enabled:       true,
          hr_enabled:        false,
        })
        .select('id')
        .single()

      if (clientErr || !client) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: clientErr?.message || 'Failed to create client' }, 400)
      }

      // handle_new_user trigger may have already inserted a bare profile row;
      // upsert ensures we always write our values regardless
      const { error: profileErr } = await admin.from('profiles').upsert({
        id:        authData.user.id,
        full_name: full_name || business_name,
        role:      'client',
        client_id: client.id,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        await admin.from('clients').delete().eq('id', client.id)
        return json({ error: profileErr.message }, 400)
      }

      return json({ success: true })
    }

    // ── All other actions require admin auth ──────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const caller = createClient(url, anon, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await caller.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    // Use service-role client to fetch profile — RLS on profiles can block anon+JWT reads;
    // identity is already verified above via caller.auth.getUser()
    const { data: profile } = await admin
      .from('profiles').select('role, pos_role, client_id').eq('id', user.id).single()

    // ── POS manager-accessible actions (before admin-only guard) ─────────────
    const isCallerAdmin   = profile?.role === 'admin'
    const isCallerManager = profile?.pos_role === 'manager'
    const isPosPrivileged = isCallerAdmin || isCallerManager

    if (action === 'create_pos_staff' || action === 'reset_pos_pin') {
      if (!isPosPrivileged) return json({ error: 'Forbidden' }, 403)
    }

    // ── Create a POS staff member — name + PIN, auto-generated email ──────────
    if (action === 'create_pos_staff') {
      const targetClientId = isCallerAdmin ? params.client_id : profile?.client_id
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { full_name, pin, pos_role } = params
      if (!full_name || !pin) return json({ error: 'full_name and pin are required' }, 400)
      if (!/^\d{4,6}$/.test(pin)) return json({ error: 'PIN must be 4–6 digits' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      if (pos_role && !validRoles.includes(pos_role)) return json({ error: 'Invalid pos_role' }, 400)

      // Generate a stable internal email — staff never see or type this
      const slug   = full_name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
      const suffix = Math.random().toString(36).slice(2, 7)
      const email  = `${slug}_${suffix}@pos.internal`

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password:      pin,
        email_confirm: true,
        user_metadata: { full_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const { error: profileErr } = await admin.from('profiles').upsert({
        id:        authData.user.id,
        full_name,
        role:      'client',
        client_id: targetClientId,
        pos_role:  pos_role || null,
        pos_email: email,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      return json({ success: true, userId: authData.user.id })
    }

    // ── Reset a POS staff PIN ─────────────────────────────────────────────────
    if (action === 'reset_pos_pin') {
      const { userId, pin } = params
      if (!userId || !pin) return json({ error: 'userId and pin are required' }, 400)
      if (!/^\d{4,6}$/.test(pin)) return json({ error: 'PIN must be 4–6 digits' }, 400)

      // Verify the target user belongs to the same client (managers can't reset other clients' pins)
      if (!isCallerAdmin) {
        const { data: targetProfile } = await admin
          .from('profiles').select('client_id').eq('id', userId).single()
        if (targetProfile?.client_id !== profile?.client_id) {
          return json({ error: 'Forbidden' }, 403)
        }
      }

      const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password: pin })
      if (updateErr) return json({ error: updateErr.message }, 400)

      return json({ success: true })
    }

    // ── All remaining actions require admin role ──────────────────────────────
    if (profile?.role !== 'admin') return json({ error: 'Forbidden' }, 403)

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

      async function del(query: Promise<{ error: unknown }>, label: string) {
        const { error } = await query
        if (error) throw new Error(`Failed to delete ${label}: ${(error as { message?: string }).message ?? String(error)}`)
      }

      const { data: periods } = await admin.from('monthly_periods').select('id').eq('client_id', clientId)
      const periodIds = (periods || []).map((p: { id: string }) => p.id)

      const { data: recipeRows } = await admin.from('recipes').select('id').eq('client_id', clientId)
      const recipeIds = (recipeRows || []).map((r: { id: string }) => r.id)

      const { data: poRows } = await admin.from('purchase_orders').select('id').eq('client_id', clientId)
      const poIds = (poRows || []).map((p: { id: string }) => p.id)

      const { data: reqRows } = await admin.from('requisitions').select('id').eq('client_id', clientId)
      const reqIds = (reqRows || []).map((r: { id: string }) => r.id)

      if (recipeIds.length > 0) {
        await del(admin.from('recipe_ingredients').delete().in('recipe_id', recipeIds), 'recipe_ingredients')
      }
      if (poIds.length > 0) {
        await del(admin.from('purchase_order_items').delete().in('po_id', poIds), 'purchase_order_items')
      }
      if (reqIds.length > 0) {
        await del(admin.from('requisition_lines').delete().in('requisition_id', reqIds), 'requisition_lines')
      }

      if (periodIds.length > 0) {
        await del(admin.from('purchase_entries').delete().in('period_id', periodIds), 'purchase_entries')
        await del(admin.from('vendor_returns').delete().in('period_id', periodIds), 'vendor_returns')
        await del(admin.from('opening_stock').delete().in('period_id', periodIds), 'opening_stock')
        await del(admin.from('closing_stock').delete().in('period_id', periodIds), 'closing_stock')
        await del(admin.from('wastages').delete().in('period_id', periodIds), 'wastages')
        await del(admin.from('sales_entries').delete().in('period_id', periodIds), 'sales_entries')
        await del(admin.from('budgets').delete().in('period_id', periodIds), 'budgets')
      }

      await del(admin.from('purchase_orders').delete().eq('client_id', clientId), 'purchase_orders')
      await del(admin.from('requisitions').delete().eq('client_id', clientId), 'requisitions')
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
    return json({ error: (err as Error).message })
  }
})
