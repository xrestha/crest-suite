import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Sends real Web Push notifications for the Roster module (publish + shift-swap events). Holds
// the VAPID private key (Edge Function secret, never in the frontend bundle) — this is the only
// place in the codebase that can actually sign and send a push.
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

    const admin = createClient(url, svc, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    webpush.setVapidDetails(
      Deno.env.get('VAPID_SUBJECT')!,
      Deno.env.get('VAPID_PUBLIC_KEY')!,
      Deno.env.get('VAPID_PRIVATE_KEY')!,
    )

    const body = await req.json()
    const { action, ...params } = body

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)

    const caller = createClient(url, anon, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authErr } = await caller.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    const { data: profile } = await admin
      .from('profiles').select('role, client_id, hr_self_service, hr_employee_id').eq('id', user.id).single()

    const isCallerAdmin = profile?.role === 'admin'
    // A "real" (non-self-service) profile tied to the client — owner/manager, whoever can reach
    // the main Roster page. Self-service employees never get here for publish/admin-decision actions.
    const isCallerStaffUser = !profile?.hr_self_service

    // Sends one push payload to every subscription for a profile, pruning dead (404/410) ones.
    async function sendToProfile(profileId: string, payload: Record<string, string>) {
      const { data: subs } = await admin.from('push_subscriptions').select('*').eq('profile_id', profileId)
      for (const sub of subs || []) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
          )
        } catch (err) {
          const statusCode = (err as { statusCode?: number })?.statusCode
          if (statusCode === 404 || statusCode === 410) {
            await admin.from('push_subscriptions').delete().eq('id', sub.id)
          }
        }
      }
    }

    // ── Roster published — notify every self-service employee with a shift on one of the days
    // that were just published (bs_days), not the whole month's staff — publishing now happens
    // incrementally (e.g. one week at a time), so a month-wide notify would over-notify. ─────────
    if (action === 'notify_roster_published') {
      const { client_id, bs_year, bs_month, bs_days } = params
      if (!(isCallerAdmin || (isCallerStaffUser && profile?.client_id === client_id))) {
        return json({ error: 'Forbidden' }, 403)
      }
      if (!Array.isArray(bs_days) || bs_days.length === 0) return json({ error: 'bs_days required' }, 400)

      const { data: rows } = await admin
        .from('hr_roster')
        .select('employee_id')
        .eq('client_id', client_id).eq('bs_year', bs_year).eq('bs_month', bs_month).in('bs_day', bs_days)
      const employeeIds = [...new Set((rows || []).map(r => r.employee_id))]
      if (employeeIds.length === 0) return json({ success: true, notified: 0 })

      const { data: profiles } = await admin
        .from('profiles').select('id')
        .eq('client_id', client_id).eq('hr_self_service', true).in('hr_employee_id', employeeIds)

      for (const p of profiles || []) {
        await sendToProfile(p.id, {
          title: 'Roster Published',
          body: 'Your work schedule has been published — open Self-Service to view it.',
          url: '/hr/self-service',
        })
      }
      return json({ success: true, notified: (profiles || []).length })
    }

    // ── A requester just created a swap request — notify the target coworker ──────────────────
    if (action === 'notify_swap_request') {
      const { request_id } = params
      const { data: swap } = await admin.from('hr_shift_swap_requests').select('*').eq('id', request_id).single()
      if (!swap) return json({ error: 'Not found' }, 404)
      if (!(profile?.hr_self_service && profile.hr_employee_id === swap.requester_employee_id)) {
        return json({ error: 'Forbidden' }, 403)
      }

      const { data: requester } = await admin.from('hr_employees').select('full_name').eq('id', swap.requester_employee_id).single()
      const { data: targetProfile } = await admin
        .from('profiles').select('id').eq('client_id', swap.client_id)
        .eq('hr_self_service', true).eq('hr_employee_id', swap.target_employee_id).maybeSingle()

      if (targetProfile) {
        await sendToProfile(targetProfile.id, {
          title: 'Shift Swap Request',
          body: `${requester?.full_name || 'A coworker'} wants to swap shifts with you.`,
          url: '/hr/self-service',
        })
      }
      return json({ success: true })
    }

    // ── Target accepted/declined — notify the requester ────────────────────────────────────────
    if (action === 'notify_swap_target_response') {
      const { request_id } = params
      const { data: swap } = await admin.from('hr_shift_swap_requests').select('*').eq('id', request_id).single()
      if (!swap) return json({ error: 'Not found' }, 404)
      if (!(profile?.hr_self_service && profile.hr_employee_id === swap.target_employee_id)) {
        return json({ error: 'Forbidden' }, 403)
      }

      const { data: target } = await admin.from('hr_employees').select('full_name').eq('id', swap.target_employee_id).single()
      const { data: requesterProfile } = await admin
        .from('profiles').select('id').eq('client_id', swap.client_id)
        .eq('hr_self_service', true).eq('hr_employee_id', swap.requester_employee_id).maybeSingle()

      if (requesterProfile) {
        const accepted = swap.status === 'pending_admin'
        await sendToProfile(requesterProfile.id, {
          title: 'Shift Swap Update',
          body: `${target?.full_name || 'Your coworker'} ${accepted ? 'accepted' : 'declined'} your swap request${accepted ? ' — awaiting manager approval.' : '.'}`,
          url: '/hr/self-service',
        })
      }
      return json({ success: true })
    }

    // ── Admin approved/rejected — notify both employees ────────────────────────────────────────
    if (action === 'notify_swap_admin_decision') {
      const { request_id } = params
      const { data: swap } = await admin.from('hr_shift_swap_requests').select('*').eq('id', request_id).single()
      if (!swap) return json({ error: 'Not found' }, 404)
      if (!(isCallerAdmin || (isCallerStaffUser && profile?.client_id === swap.client_id))) {
        return json({ error: 'Forbidden' }, 403)
      }

      const approved = swap.status === 'approved'
      const { data: parties } = await admin
        .from('profiles').select('id').eq('client_id', swap.client_id).eq('hr_self_service', true)
        .in('hr_employee_id', [swap.requester_employee_id, swap.target_employee_id])

      for (const p of parties || []) {
        await sendToProfile(p.id, {
          title: 'Shift Swap Update',
          body: `Your shift swap request was ${approved ? 'approved' : 'rejected'} by your manager.`,
          url: '/hr/self-service',
        })
      }
      return json({ success: true })
    }

    return json({ error: 'Unknown action' }, 400)
  } catch (err) {
    return json({ error: (err as Error)?.message || 'Internal error' }, 500)
  }
})
