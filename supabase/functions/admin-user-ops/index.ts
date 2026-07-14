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
    const isCallerOwner   = profile?.role === 'client' && !profile?.pos_role // owner has no pos_role
    const isPosPrivileged = isCallerAdmin || isCallerManager || isCallerOwner

    if (action === 'create_pos_staff' || action === 'reset_pos_pin' || action === 'delete_pos_staff' || action === 'update_pos_role') {
      if (!isPosPrivileged) return json({ error: 'Forbidden' }, 403)
    }

    // ── Create a POS staff member — name + PIN, auto-generated email ──────────
    // Optional employee_id links the new POS account to an existing hr_employees record
    // (client has both HR + POS) — full_name is then taken from that employee, not retyped.
    if (action === 'create_pos_staff') {
      const targetClientId = isCallerAdmin ? params.client_id : profile?.client_id
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { pin, pos_role, pos_job_title, employee_id } = params
      let { full_name } = params
      if (!pin) return json({ error: 'pin is required' }, 400)
      if (!/^\d{4,6}$/.test(pin)) return json({ error: 'PIN must be 4–6 digits' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      if (pos_role && !validRoles.includes(pos_role)) return json({ error: 'Invalid pos_role' }, 400)

      if (employee_id) {
        const { data: employee } = await admin
          .from('hr_employees').select('id, full_name, client_id')
          .eq('id', employee_id).eq('client_id', targetClientId).single()
        if (!employee) return json({ error: 'Employee not found' }, 400)

        const { data: existingLink } = await admin
          .from('profiles').select('id').eq('hr_employee_id', employee_id).not('pos_email', 'is', null).maybeSingle()
        if (existingLink) return json({ error: 'This employee already has a POS staff account' }, 400)

        full_name = employee.full_name
      }
      if (!full_name) return json({ error: 'full_name is required' }, 400)

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
        id:            authData.user.id,
        full_name,
        role:          'client',
        client_id:     targetClientId,
        pos_role:      pos_role || null,
        pos_job_title: pos_job_title || null,
        pos_email:     email,
        hr_employee_id: employee_id || null,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      return json({ success: true, userId: authData.user.id })
    }

    // ── Enable HR Employee Self-Service — PIN login, mirrors create_pos_staff exactly ────────
    // Restricted to admin or the client owner (not POS managers — HR access isn't necessarily
    // delegated to a floor manager the way POS staff management is).
    if (action === 'create_hr_self_service_login') {
      if (!(isCallerAdmin || isCallerOwner)) return json({ error: 'Forbidden' }, 403)

      const targetClientId = isCallerAdmin ? params.client_id : profile?.client_id
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { employee_id, pin } = params
      if (!employee_id || !pin) return json({ error: 'employee_id and pin are required' }, 400)
      if (!/^\d{4,6}$/.test(pin)) return json({ error: 'PIN must be 4–6 digits' }, 400)

      const { data: employee } = await admin
        .from('hr_employees').select('id, full_name, client_id')
        .eq('id', employee_id).eq('client_id', targetClientId).single()
      if (!employee) return json({ error: 'Employee not found' }, 400)

      const slug   = employee.full_name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)
      const suffix = Math.random().toString(36).slice(2, 7)
      const email  = `${slug}_${suffix}@hr.internal`

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password:      pin,
        email_confirm: true,
        user_metadata: { full_name: employee.full_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const { error: profileErr } = await admin.from('profiles').upsert({
        id:                     authData.user.id,
        full_name:              employee.full_name,
        role:                   'client',
        client_id:              targetClientId,
        hr_employee_id:         employee.id,
        hr_self_service:        true,
        hr_self_service_email:  email,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      return json({ success: true, userId: authData.user.id })
    }

    // ── Update a POS staff member's role ─────────────────────────────────────
    if (action === 'update_pos_role') {
      const { userId, pos_role, pos_job_title } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      if (pos_role && !validRoles.includes(pos_role)) return json({ error: 'Invalid pos_role' }, 400)

      if (!isCallerAdmin) {
        const { data: targetProfile } = await admin
          .from('profiles').select('client_id').eq('id', userId).single()
        if (targetProfile?.client_id !== profile?.client_id) return json({ error: 'Forbidden' }, 403)
      }

      const { error: updateErr } = await admin.from('profiles')
        .update({ pos_role: pos_role || null, pos_job_title: pos_job_title || null })
        .eq('id', userId)
      if (updateErr) return json({ error: updateErr.message }, 400)
      return json({ success: true })
    }

    // ── Delete a POS staff member ─────────────────────────────────────────────
    if (action === 'delete_pos_staff') {
      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      if (!isCallerAdmin) {
        const { data: targetProfile } = await admin
          .from('profiles').select('client_id, pos_role').eq('id', userId).single()
        if (targetProfile?.client_id !== profile?.client_id) return json({ error: 'Forbidden' }, 403)
        if (targetProfile?.pos_role === 'manager') return json({ error: 'Managers can only be deleted by admin' }, 403)
      }

      const { error: delErr } = await admin.auth.admin.deleteUser(userId)
      if (delErr) return json({ error: delErr.message }, 400)
      return json({ success: true })
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

    // ── Clear one module's transactions, keeping setup/master data ────────────
    // ims: keeps items/vendors/categories/recipes/par levels/periods (periods are shared with HR)
    // hr:  keeps employees/salary components/leave types/holiday calendar/shift types
    // pos: keeps tables/floor plan/staff accounts; frees occupied tables
    if (action === 'clearModuleData') {
      const { clientId, module } = params
      if (!clientId) return json({ error: 'clientId is required' }, 400)
      if (!['ims', 'hr', 'pos'].includes(module)) return json({ error: "module must be 'ims', 'hr' or 'pos'" }, 400)

      async function del(query: Promise<{ error: unknown }>, label: string) {
        const { error } = await query
        if (error) throw new Error(`Failed to delete ${label}: ${(error as { message?: string }).message ?? String(error)}`)
      }

      if (module === 'ims') {
        const { data: periods } = await admin.from('monthly_periods').select('id').eq('client_id', clientId)
        const periodIds = (periods || []).map((p: { id: string }) => p.id)

        if (periodIds.length > 0) {
          const { data: peRows } = await admin.from('purchase_entries').select('id').in('period_id', periodIds)
          const peIds = (peRows || []).map((r: { id: string }) => r.id)
          if (peIds.length > 0) {
            await del(admin.from('payable_payments').delete().in('purchase_entry_id', peIds), 'payable_payments')
          }
          await del(admin.from('purchase_entries').delete().in('period_id', periodIds), 'purchase_entries')
          await del(admin.from('vendor_returns').delete().in('period_id', periodIds), 'vendor_returns')
          await del(admin.from('opening_stock').delete().in('period_id', periodIds), 'opening_stock')
          await del(admin.from('closing_stock').delete().in('period_id', periodIds), 'closing_stock')
          await del(admin.from('wastages').delete().in('period_id', periodIds), 'wastages')
          await del(admin.from('staff_meals').delete().in('period_id', periodIds), 'staff_meals')
          await del(admin.from('sales_entries').delete().in('period_id', periodIds).eq('source', 'manual'), 'sales_entries')
          await del(admin.from('budgets').delete().in('period_id', periodIds), 'budgets')
        }

        await del(admin.from('stock_movements').delete().eq('client_id', clientId), 'stock_movements')

        const { data: poRows } = await admin.from('purchase_orders').select('id').eq('client_id', clientId)
        const poIds = (poRows || []).map((p: { id: string }) => p.id)
        if (poIds.length > 0) {
          await del(admin.from('purchase_order_items').delete().in('po_id', poIds), 'purchase_order_items')
        }
        await del(admin.from('purchase_orders').delete().eq('client_id', clientId), 'purchase_orders')

        const { data: reqRows } = await admin.from('requisitions').select('id').eq('client_id', clientId)
        const reqIds = (reqRows || []).map((r: { id: string }) => r.id)
        if (reqIds.length > 0) {
          await del(admin.from('requisition_lines').delete().in('requisition_id', reqIds), 'requisition_lines')
        }
        await del(admin.from('requisitions').delete().eq('client_id', clientId), 'requisitions')

        await del(admin.from('overheads').delete().eq('client_id', clientId), 'overheads')
        await del(admin.from('demand_forecast_daily').delete().eq('client_id', clientId), 'demand_forecast_daily')
        await del(admin.from('demand_forecast_run_log').delete().eq('client_id', clientId), 'demand_forecast_run_log')
        // monthly_periods are intentionally KEPT — HR attendance/payroll reference the same periods
        return json({ success: true })
      }

      if (module === 'hr') {
        const { data: runRows } = await admin.from('hr_payroll_runs').select('id').eq('client_id', clientId)
        const runIds = (runRows || []).map((r: { id: string }) => r.id)
        if (runIds.length > 0) {
          await del(admin.from('hr_payslips').delete().in('run_id', runIds), 'hr_payslips')
        }
        await del(admin.from('hr_payroll_runs').delete().eq('client_id', clientId), 'hr_payroll_runs')
        await del(admin.from('hr_attendance').delete().eq('client_id', clientId), 'hr_attendance')
        await del(admin.from('hr_leave_requests').delete().eq('client_id', clientId), 'hr_leave_requests')
        await del(admin.from('hr_overtime_entries').delete().eq('client_id', clientId), 'hr_overtime_entries')
        await del(admin.from('hr_festival_allowances').delete().eq('client_id', clientId), 'hr_festival_allowances')
        await del(admin.from('hr_advance_repayments').delete().eq('client_id', clientId), 'hr_advance_repayments')
        await del(admin.from('hr_advances').delete().eq('client_id', clientId), 'hr_advances')
        await del(admin.from('hr_roster').delete().eq('client_id', clientId), 'hr_roster')
        // hr_tada_claim_items cascades from hr_tada_claims; hr_incentives.config_id SET NULLs on config delete
        await del(admin.from('hr_tada_claims').delete().eq('client_id', clientId), 'hr_tada_claims')
        await del(admin.from('hr_incentives').delete().eq('client_id', clientId), 'hr_incentives')
        await del(admin.from('hr_incentive_configs').delete().eq('client_id', clientId), 'hr_incentive_configs')
        await del(admin.from('hr_roster_publish_state').delete().eq('client_id', clientId), 'hr_roster_publish_state')
        await del(admin.from('hr_shift_swap_requests').delete().eq('client_id', clientId), 'hr_shift_swap_requests')
        return json({ success: true })
      }

      if (module === 'pos') {
        // Circular FK: pos_orders.credit_note_id -> pos_credit_notes.id AND
        // pos_credit_notes.order_id -> pos_orders.id, neither ON DELETE CASCADE.
        // Null the order-side link first or deleting pos_credit_notes fails.
        await del(admin.from('pos_orders').update({ credit_note_id: null }).eq('client_id', clientId), 'pos_orders.credit_note_id reset')
        await del(admin.from('pos_credit_notes').delete().eq('client_id', clientId), 'pos_credit_notes')
        await del(admin.from('pos_payment_confirmations').delete().eq('client_id', clientId), 'pos_payment_confirmations')
        await del(admin.from('pos_guest_order_requests').delete().eq('client_id', clientId), 'pos_guest_order_requests')
        const { data: orderRows } = await admin.from('pos_orders').select('id').eq('client_id', clientId)
        const orderIds = (orderRows || []).map((o: { id: string }) => o.id)
        if (orderIds.length > 0) {
          await del(admin.from('pos_order_items').delete().in('order_id', orderIds), 'pos_order_items')
        }
        // POS-generated depletion ledger + POS-sourced sales entries go with the orders
        await del(admin.from('stock_movements').delete().eq('client_id', clientId), 'stock_movements')
        const { data: periods } = await admin.from('monthly_periods').select('id').eq('client_id', clientId)
        const periodIds = (periods || []).map((p: { id: string }) => p.id)
        if (periodIds.length > 0) {
          await del(admin.from('sales_entries').delete().in('period_id', periodIds).in('source', ['pos', 'pos_comp', 'pos_credit']), 'pos sales_entries')
        }
        await del(admin.from('pos_orders').delete().eq('client_id', clientId), 'pos_orders')
        await del(admin.from('pos_shifts').delete().eq('client_id', clientId), 'pos_shifts')
        await del(admin.from('pos_customers').delete().eq('client_id', clientId), 'pos_customers')
        // Tables are kept (setup) but any left "occupied" by a deleted order are freed
        await admin.from('pos_tables').update({ status: 'available' }).eq('client_id', clientId)
        return json({ success: true })
      }
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
        await del(admin.from('recipe_suggestions').delete().in('recipe_id', recipeIds), 'recipe_suggestions')
        await del(admin.from('recipe_suggestions').delete().in('suggest_recipe_id', recipeIds), 'recipe_suggestions (reverse)')
      }
      if (poIds.length > 0) {
        await del(admin.from('purchase_order_items').delete().in('po_id', poIds), 'purchase_order_items')
      }
      if (reqIds.length > 0) {
        await del(admin.from('requisition_lines').delete().in('requisition_id', reqIds), 'requisition_lines')
      }

      if (periodIds.length > 0) {
        const { data: peRows } = await admin.from('purchase_entries').select('id').in('period_id', periodIds)
        const peIds = (peRows || []).map((r: { id: string }) => r.id)
        if (peIds.length > 0) {
          await del(admin.from('payable_payments').delete().in('purchase_entry_id', peIds), 'payable_payments')
        }
        await del(admin.from('purchase_entries').delete().in('period_id', periodIds), 'purchase_entries')
        await del(admin.from('vendor_returns').delete().in('period_id', periodIds), 'vendor_returns')
        await del(admin.from('opening_stock').delete().in('period_id', periodIds), 'opening_stock')
        await del(admin.from('closing_stock').delete().in('period_id', periodIds), 'closing_stock')
        await del(admin.from('wastages').delete().in('period_id', periodIds), 'wastages')
        await del(admin.from('staff_meals').delete().in('period_id', periodIds), 'staff_meals')
        await del(admin.from('sales_entries').delete().in('period_id', periodIds), 'sales_entries')
        await del(admin.from('budgets').delete().in('period_id', periodIds), 'budgets')
      }

      // POS module data (orders reference tables; movements/orders must go before periods)
      // Circular FK: pos_orders.credit_note_id -> pos_credit_notes.id AND
      // pos_credit_notes.order_id -> pos_orders.id, neither ON DELETE CASCADE.
      // Null the order-side link first or deleting pos_credit_notes fails.
      await del(admin.from('pos_orders').update({ credit_note_id: null }).eq('client_id', clientId), 'pos_orders.credit_note_id reset')
      await del(admin.from('pos_credit_notes').delete().eq('client_id', clientId), 'pos_credit_notes')
      await del(admin.from('pos_payment_confirmations').delete().eq('client_id', clientId), 'pos_payment_confirmations')
      await del(admin.from('pos_guest_order_requests').delete().eq('client_id', clientId), 'pos_guest_order_requests')
      const { data: orderRows } = await admin.from('pos_orders').select('id').eq('client_id', clientId)
      const orderIds = (orderRows || []).map((o: { id: string }) => o.id)
      if (orderIds.length > 0) {
        await del(admin.from('pos_order_items').delete().in('order_id', orderIds), 'pos_order_items')
      }
      await del(admin.from('stock_movements').delete().eq('client_id', clientId), 'stock_movements')
      await del(admin.from('pos_orders').delete().eq('client_id', clientId), 'pos_orders')
      await del(admin.from('pos_shifts').delete().eq('client_id', clientId), 'pos_shifts')
      await del(admin.from('pos_customers').delete().eq('client_id', clientId), 'pos_customers')
      await del(admin.from('pos_tables').delete().eq('client_id', clientId), 'pos_tables')

      // HR module data (payslips reference runs; attendance/payroll reference monthly_periods)
      const { data: runRows } = await admin.from('hr_payroll_runs').select('id').eq('client_id', clientId)
      const runIds = (runRows || []).map((r: { id: string }) => r.id)
      if (runIds.length > 0) {
        await del(admin.from('hr_payslips').delete().in('run_id', runIds), 'hr_payslips')
      }
      await del(admin.from('hr_payroll_runs').delete().eq('client_id', clientId), 'hr_payroll_runs')
      await del(admin.from('hr_attendance').delete().eq('client_id', clientId), 'hr_attendance')
      await del(admin.from('hr_leave_requests').delete().eq('client_id', clientId), 'hr_leave_requests')
      await del(admin.from('hr_overtime_entries').delete().eq('client_id', clientId), 'hr_overtime_entries')
      await del(admin.from('hr_festival_allowances').delete().eq('client_id', clientId), 'hr_festival_allowances')
      await del(admin.from('hr_advance_repayments').delete().eq('client_id', clientId), 'hr_advance_repayments')
      await del(admin.from('hr_advances').delete().eq('client_id', clientId), 'hr_advances')
      await del(admin.from('hr_roster').delete().eq('client_id', clientId), 'hr_roster')
      // hr_tada_claim_items cascades from hr_tada_claims; hr_incentives.config_id SET NULLs on config delete
      await del(admin.from('hr_tada_claims').delete().eq('client_id', clientId), 'hr_tada_claims')
      await del(admin.from('hr_incentives').delete().eq('client_id', clientId), 'hr_incentives')
      await del(admin.from('hr_incentive_configs').delete().eq('client_id', clientId), 'hr_incentive_configs')
      await del(admin.from('hr_roster_publish_state').delete().eq('client_id', clientId), 'hr_roster_publish_state')
      await del(admin.from('hr_shift_swap_requests').delete().eq('client_id', clientId), 'hr_shift_swap_requests')
      await del(admin.from('hr_salary_components').delete().eq('client_id', clientId), 'hr_salary_components')
      await del(admin.from('hr_employees').delete().eq('client_id', clientId), 'hr_employees')
      await del(admin.from('hr_leave_types').delete().eq('client_id', clientId), 'hr_leave_types')
      await del(admin.from('hr_holiday_calendar').delete().eq('client_id', clientId), 'hr_holiday_calendar')
      await del(admin.from('hr_shift_types').delete().eq('client_id', clientId), 'hr_shift_types')

      await del(admin.from('purchase_orders').delete().eq('client_id', clientId), 'purchase_orders')
      await del(admin.from('requisitions').delete().eq('client_id', clientId), 'requisitions')
      await del(admin.from('overheads').delete().eq('client_id', clientId), 'overheads')
      await del(admin.from('par_levels').delete().eq('client_id', clientId), 'par_levels')
      await del(admin.from('demand_forecast_daily').delete().eq('client_id', clientId), 'demand_forecast_daily')
      await del(admin.from('demand_forecast_run_log').delete().eq('client_id', clientId), 'demand_forecast_run_log')
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
