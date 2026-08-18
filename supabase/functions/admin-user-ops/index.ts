import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  derivePinPassword, isPasswordPwned, getAppSecrets, encryptPin, decryptPin, resetAppSecretsCache,
} from '../_shared/pinPassword.ts'

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

    // ── PIN vault write (20260812110000) ──────────────────────────────────────
    // Deliberately best-effort: a vault failure must NEVER fail the operation that called it.
    // The account is already valid without a vault row -- the PIN works, login works, only
    // admin recovery is unavailable -- and the next reset, or the login functions' lazy-upgrade
    // branch, repopulates it. Failing the create/reset here would trade a recovery convenience
    // for an outage on the restaurant floor, which is the wrong way round.
    const vaultPin = async (userId: string, clientId: string, kind: 'pos' | 'hr_self_service', pin: string) => {
      try {
        const { vaultKey } = await getAppSecrets(admin)
        if (!vaultKey) {
          console.error('[admin-user-ops] no vault key available — PIN not recoverable for', userId)
          return
        }
        const { error } = await admin.from('staff_pin_vault').upsert({
          user_id:    userId,
          client_id:  clientId,
          kind,
          pin_cipher: await encryptPin(pin, vaultKey),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })
        if (error) console.error('[admin-user-ops] staff_pin_vault write failed:', error.message)
      } catch (e) {
        console.error('[admin-user-ops] staff_pin_vault encrypt failed:', e instanceof Error ? e.message : e)
      }
    }

    // ── Self-service trial signup — no admin auth required ────────────────────
    if (action === 'register_trial') {
      const { business_name, email, password, full_name, phone } = params
      if (!business_name || !email || !password) {
        return json({ error: 'business_name, email and password are required' }, 400)
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email is required' }, 400)
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)
      if (String(business_name).length > 120) return json({ error: 'Business name is too long' }, 400)

      // Rate limit. This action is unauthenticated by design (it IS the public signup form), so
      // without a cap a loop here creates unbounded auth users + clients + profiles, each of which
      // then sits in Admin -> Clients until trial_purge_at 22 days later.
      //
      // Per-IP first, then a global circuit breaker so a distributed attempt still can't run away
      // — a real product doing 30 genuine signups in one hour is a good problem to notice manually.
      const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()

      const { count: ipCount } = await admin
        .from('trial_signup_attempts').select('id', { count: 'exact', head: true })
        .eq('ip', ip).gte('created_at', since)
      if ((ipCount ?? 0) >= 3) {
        return json({ error: 'Too many signup attempts from this network. Please try again in an hour.' }, 429)
      }

      const { count: globalCount } = await admin
        .from('trial_signup_attempts').select('id', { count: 'exact', head: true })
        .gte('created_at', since)
      if ((globalCount ?? 0) >= 30) {
        return json({ error: 'Signups are temporarily paused. Please try again shortly.' }, 429)
      }

      // Recorded BEFORE the attempt, so a failing loop (duplicate email, weak password) burns
      // quota exactly like a succeeding one — otherwise the cheapest attack is to keep failing.
      await admin.from('trial_signup_attempts').insert({ ip, email })

      // Breached-password screening, the server-side half of NIST SP 800-63B-4's blocklist
      // control. weakPasswordReason() in the browser is the offline half (common passwords,
      // repeats, runs, business-name/email derivations) and is explicitly NOT a boundary — an
      // attacker just skips it. This is the half that isn't skippable.
      //
      // It has to live here rather than being delegated to Supabase's "Leaked Password
      // Protection" toggle, because that toggle cannot see this call: GoTrue runs its HIBP
      // check inside checkPasswordStrength(), and adminUserCreate — which is what
      // auth.admin.createUser() hits — never calls it. Enabling the dashboard setting does
      // nothing for the signup form. (It does cover ResetPassword.js and the IMS/HR resets,
      // which go through the user-facing and adminUserUpdate paths respectively.)
      //
      // Fail-open on null, loudly: a HIBP outage must not take signups down. Same stance as the
      // PIN lockout RPCs, and for the same reason — the availability cost of failing closed is
      // certain while the security cost of failing open is probabilistic.
      const pwned = await isPasswordPwned(password)
      if (pwned === true) {
        return json({
          error: 'This password has appeared in a known data breach. Please choose a different one.',
        }, 400)
      }
      if (pwned === null) {
        console.error('[register_trial] HIBP check unavailable — signup allowed without breach screening')
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
      .from('profiles').select('role, pos_role, ims_role, hr_self_service, hr_role, client_id').eq('id', user.id).single()

    // ── POS/IMS/HR manager-accessible actions (before admin-only guard) ──────
    // isCallerOwner must exclude every staff-account marker (pos_role, ims_role, hr_self_service,
    // hr_role) — a staff account of one type has none of the other three set, so without excluding
    // all four here it would incorrectly pass as "owner" for privileged actions outside its own
    // domain (e.g. an HR self-service PIN account calling create_pos_staff).
    const isCallerAdmin      = profile?.role === 'admin'
    const isCallerPosManager = profile?.pos_role === 'manager'
    const isCallerImsManager = profile?.ims_role === 'manager'
    const isCallerHrManager  = profile?.hr_role === 'manager'
    const isCallerOwner      = profile?.role === 'client' && !profile?.pos_role && !profile?.ims_role && !profile?.hr_self_service && !profile?.hr_role
    const isPosPrivileged    = isCallerAdmin || isCallerPosManager || isCallerOwner
    const isImsPrivileged    = isCallerAdmin || isCallerImsManager || isCallerOwner
    const isHrPrivileged     = isCallerAdmin || isCallerHrManager || isCallerOwner

    if (action === 'create_pos_staff' || action === 'reset_pos_pin' || action === 'delete_pos_staff' || action === 'update_pos_role') {
      if (!isPosPrivileged) return json({ error: 'Forbidden' }, 403)
    }
    if (action === 'create_ims_staff' || action === 'reset_ims_password' || action === 'delete_ims_staff' || action === 'update_ims_role') {
      if (!isImsPrivileged) return json({ error: 'Forbidden' }, 403)
    }
    if (action === 'create_hr_staff' || action === 'reset_hr_password' || action === 'delete_hr_staff' || action === 'update_hr_role') {
      if (!isHrPrivileged) return json({ error: 'Forbidden' }, 403)
    }

    // ── Target resolution for every staff-management action ───────────────────
    // Until this existed, each of reset_pos_pin / reset_ims_password / reset_hr_password /
    // delete_*_staff verified ONLY that the target shared the caller's client_id — and never that
    // the target was actually a staff account. The client Owner shares that client_id, so any
    // module manager could:
    //
    //   reset_ims_password { userId: <owner id> }  -> overwrite the Owner's password, then log in
    //                                                 as them (the Owner's email comes free from
    //                                                 get_ims_eligible_users, which any same-client
    //                                                 session could call -- see the companion
    //                                                 migration 20260810130000)
    //   delete_ims_staff   { userId: <owner id> }  -> delete the Owner's auth user outright; the
    //                                                 "managers can only be deleted by admin"
    //                                                 guard misses the Owner, whose ims_role is
    //                                                 NULL rather than 'manager'
    //   update_ims_role    { userId: <owner id> }  -> stamp a staff marker on the Owner, which per
    //                                                 the negative isOwner test silently demotes
    //                                                 them out of Owner-level access
    //
    // requireStaffTarget() closes all three: a non-admin caller may only act on an account that
    // already carries the staff marker for the module being acted on, and never on an admin.
    // Admin callers are deliberately exempt from the marker requirement -- resetting a locked-out
    // Owner's password is legitimate operator support, and admin already has unrestricted
    // createUser/deleteUser below.
    //
    // The marker per module mirrors that module's own RESTRICTIVE RLS predicate exactly, so
    // "is a POS staff account" means the same thing here as it does to the database:
    //   pos -> pos_email IS NOT NULL   (same filter as get_pos_staff / is_pos_pin_staff())
    //   ims -> ims_role  IS NOT NULL   (same filter as is_ims_staff())
    //   hr  -> hr_role   IS NOT NULL   (same filter as is_hr_role_staff())
    const STAFF_MARKER: Record<string, (t: Record<string, unknown>) => boolean> = {
      pos: t => !!t.pos_email,
      ims: t => !!t.ims_role,
      hr:  t => !!t.hr_role,
      // Self-Service is its own axis, not an HR rank: these accounts carry hr_self_service with
      // no hr_role at all, so the `hr` marker above would reject them. Keeping them separate also
      // means delete_hr_self_service_login can never be aimed at an HR *manager* account.
      self_service: t => t.hr_self_service === true,
    }
    const MODULE_LABEL: Record<string, string> = { pos: 'POS', ims: 'IMS', hr: 'HR', self_service: 'HR Self-Service' }

    async function loadTarget(userId: string) {
      const { data } = await admin
        .from('profiles')
        .select('id, role, client_id, pos_role, pos_email, ims_role, hr_role, hr_self_service')
        .eq('id', userId).single()
      return data as Record<string, unknown> | null
    }

    // Returns a ready-to-send error response, or null when the target is acceptable.
    function requireStaffTarget(target: Record<string, unknown> | null, module: string) {
      if (!target) return json({ error: 'User not found' }, 404)
      if (target.role === 'admin') return json({ error: 'Forbidden' }, 403)
      if (isCallerAdmin) return null
      if (target.client_id !== profile?.client_id) return json({ error: 'Forbidden' }, 403)
      if (!STAFF_MARKER[module](target)) {
        return json({ error: `This is not a ${MODULE_LABEL[module]} staff account and cannot be managed from here` }, 403)
      }
      return null
    }

    // ── Create a POS staff member — name + PIN, auto-generated email ──────────
    // Optional employee_id links the new POS account to an existing hr_employees record
    // (client has both HR + POS) — full_name is then taken from that employee, not retyped.
    if (action === 'create_pos_staff') {
      const targetClientId = isCallerAdmin ? params.client_id : profile?.client_id
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { pin, pos_role, pos_job_title, pos_team, employee_id } = params
      let { full_name } = params
      if (!pin) return json({ error: 'pin is required' }, 400)
      if (!/^\d{4,6}$/.test(pin)) return json({ error: 'PIN must be 4–6 digits' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      if (pos_role && !validRoles.includes(pos_role)) return json({ error: 'Invalid pos_role' }, 400)

      const validTeams = ['foh', 'kitchen', 'bar']
      if (pos_team && !validTeams.includes(pos_team)) return json({ error: 'Invalid pos_team' }, 400)

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

      // The stored password is derived, never the PIN itself — see _shared/pinPassword.ts. The
      // account's own generated email is the salt, and both this call and pos-staff-login
      // compute the same value from it.
      const { pepper: posPepper } = await getAppSecrets(admin)
      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password:      await derivePinPassword(email, pin, posPepper),
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
        // Omitted (not `pos_team: pos_team || null`) so a brand-new row falls through to the
        // column's own DEFAULT 'foh' rather than an explicit null clashing with the NOT NULL.
        ...(pos_team ? { pos_team } : {}),
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      await vaultPin(authData.user.id, targetClientId, 'pos', pin)

      return json({ success: true, userId: authData.user.id })
    }

    // ── Rebuild PIN logins from a backup's roster + vault ────────────────────────────────────
    //
    // Restores POS and HR Self-Service accounts after a full client delete, from the roster and
    // ciphertext captured by the frontend export. Platform admin only — this creates accounts in
    // bulk with known credentials, which is not something a client-side manager should be able
    // to drive.
    //
    // Faithful rather than approximate, because both halves of the original derivation survive
    // in the backup: the account's generated *.pos.internal / *.hr.internal email is exported
    // verbatim, and the PIN is recoverable from the vault ciphertext. Recreating with the same
    // email + same PIN yields the same derived password, so staff sign in exactly as before.
    //
    // Password accounts (IMS staff, HR staff, Owner) are deliberately NOT handled here: their
    // login is a real human email address that the export intentionally does not carry, and
    // their passwords are user-chosen 8+ character secrets that are never vaulted (S539). They
    // come back as a named to-recreate list instead.
    if (action === 'restore_staff_accounts') {
      if (!isCallerAdmin) return json({ error: 'Forbidden' }, 403)

      const { client_id, roster, vault } = params
      if (!client_id || !Array.isArray(roster)) {
        return json({ error: 'client_id and roster are required' }, 400)
      }

      const { pepper, vaultKey } = await getAppSecrets(admin)
      const cipherByUser: Record<string, string> = Object.fromEntries(
        (vault || []).map((v: { user_id: string; pin_cipher: string }) => [v.user_id, v.pin_cipher]),
      )

      const restored: Array<{ full_name: string; kind: string }> = []
      const manual:   Array<{ full_name: string; kind: string; reason: string }> = []

      for (const p of roster) {
        const isPos = !!p.pos_email
        const isSelfService = !!p.hr_self_service_email
        if (!isPos && !isSelfService) {
          manual.push({
            full_name: p.full_name || '(unnamed)',
            kind: p.ims_role ? 'IMS staff' : p.hr_role ? 'HR staff' : 'Owner / admin',
            reason: 'password account — email and password are not in the backup',
          })
          continue
        }

        const cipher = cipherByUser[p.id]
        if (!cipher || !vaultKey) {
          manual.push({ full_name: p.full_name, kind: isPos ? 'POS' : 'Self-Service', reason: 'no vaulted PIN in this backup' })
          continue
        }

        let pin: string
        try {
          pin = await decryptPin(cipher, vaultKey)
        } catch {
          // Almost always means pin_vault_key was rotated after this backup was taken.
          manual.push({ full_name: p.full_name, kind: isPos ? 'POS' : 'Self-Service', reason: 'vaulted PIN could not be decrypted (vault key rotated?)' })
          continue
        }

        const email = isPos ? p.pos_email : p.hr_self_service_email
        const { data: authData, error: authErr } = await admin.auth.admin.createUser({
          email,
          password:      await derivePinPassword(email, pin, pepper),
          email_confirm: true,
          user_metadata: { full_name: p.full_name },
        })
        if (authErr || !authData?.user) {
          manual.push({ full_name: p.full_name, kind: isPos ? 'POS' : 'Self-Service', reason: authErr?.message || 'account creation failed' })
          continue
        }

        const { error: profileErr } = await admin.from('profiles').upsert({
          id:        authData.user.id,
          full_name: p.full_name,
          role:      'client',
          client_id,
          ...(isPos ? {
            pos_role:            p.pos_role || null,
            pos_job_title:       p.pos_job_title || null,
            pos_email:           email,
            pos_discount_limit:  p.pos_discount_limit ?? null,
            pos_allow_void:      p.pos_allow_void ?? false,
            // Omitted when absent so the column's own DEFAULT 'foh' applies rather than a null
            // colliding with NOT NULL — same reasoning as create_pos_staff.
            ...(p.pos_team ? { pos_team: p.pos_team } : {}),
          } : {
            hr_self_service:       true,
            hr_self_service_email: email,
          }),
          // hr_employee_id points at the restored hr_employees row, which keeps its original id
          // because restoreClientData inserts rows verbatim.
          hr_employee_id: p.hr_employee_id || null,
        }, { onConflict: 'id' })

        if (profileErr) {
          await admin.auth.admin.deleteUser(authData.user.id)
          manual.push({ full_name: p.full_name, kind: isPos ? 'POS' : 'Self-Service', reason: profileErr.message })
          continue
        }

        await vaultPin(authData.user.id, client_id, isPos ? 'pos' : 'hr_self_service', pin)
        restored.push({ full_name: p.full_name, kind: isPos ? 'POS' : 'Self-Service' })
      }

      return json({ success: true, restored, manual })
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

      // Derived, not the raw PIN — same treatment as create_pos_staff above, and the reason
      // hr-selfservice-login must derive with this same email before signing in.
      const { pepper: hrPepper } = await getAppSecrets(admin)
      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password:      await derivePinPassword(email, pin, hrPepper),
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

      await vaultPin(authData.user.id, targetClientId, 'hr_self_service', pin)

      return json({ success: true, userId: authData.user.id })
    }

    // ── Remove an HR Self-Service login ───────────────────────────────────────
    // The inverse of create_hr_self_service_login, and it did not exist until S571: Enable was a
    // one-way door, so revoking a departed employee's payslip/leave portal access meant deleting
    // the auth user by hand in SQL (found doing exactly that during the S569 PIN-vault cleanup).
    // Note this is NOT the same as hr_employees.access_blocked (S563), which suspends login while
    // keeping the account — this deletes the login outright. The employee RECORD is untouched:
    // profiles.hr_employee_id is ON DELETE SET NULL in that direction, and payroll history hangs
    // off hr_employees, not off this login. Same admin-or-Owner gate as creating one.
    if (action === 'delete_hr_self_service_login') {
      if (!(isCallerAdmin || isCallerOwner)) return json({ error: 'Forbidden' }, 403)

      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const ssTarget = await loadTarget(userId)
      const ssDenied = requireStaffTarget(ssTarget, 'self_service')
      if (ssDenied) return ssDenied

      // Deleting the auth user cascades profiles (profiles_id_fkey) and, through it, the
      // staff_pin_vault row — so no orphaned PIN ciphertext is left behind.
      const { error: delErr } = await admin.auth.admin.deleteUser(userId)
      if (delErr) return json({ error: delErr.message }, 400)
      return json({ success: true })
    }

    // ── Update a POS staff member's role ─────────────────────────────────────
    if (action === 'update_pos_role') {
      const { userId, pos_role, pos_job_title, pos_team, pos_discount_limit, pos_allow_void } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      if (pos_role && !validRoles.includes(pos_role)) return json({ error: 'Invalid pos_role' }, 400)

      const validTeams = ['foh', 'kitchen', 'bar']
      if (pos_team && !validTeams.includes(pos_team)) return json({ error: 'Invalid pos_team' }, 400)

      if (pos_discount_limit !== undefined && pos_discount_limit !== null &&
          (typeof pos_discount_limit !== 'number' || pos_discount_limit < 0 || pos_discount_limit > 100)) {
        return json({ error: 'Invalid pos_discount_limit' }, 400)
      }

      if (pos_allow_void !== undefined && typeof pos_allow_void !== 'boolean') {
        return json({ error: 'Invalid pos_allow_void' }, 400)
      }

      // POS has no "assign an existing login" mode -- every one of PosStaff.jsx's four callers
      // (updateRole / updateTeam / updateDiscountLimit / updateAllowVoid) acts on a row from
      // get_pos_staff_list, which returns PIN accounts only. So the target must already be one.
      const posTarget = await loadTarget(userId)
      const posDenied = requireStaffTarget(posTarget, 'pos')
      if (posDenied) return posDenied

      // Every field here is only written when the caller actually sent it. updateTeam/
      // updateDiscountLimit/updateAllowVoid each call this action with only their one field set
      // (e.g. { pos_team } alone) — pos_role was previously unconditional (`pos_role || null`),
      // which meant any one of those team/discount/void-only calls silently wiped the staff
      // member's role to "No Access" on every use, not just on page load. Found live (S517)
      // testing the new Discount Limit field: setting a limit on a Staff-role account reset their
      // role to null on the very next page load. Symmetric with the reverse case this function
      // already guarded against — PosStaff.jsx's silent mismatched-role auto-fix loop (init())
      // calls this action with just { pos_role, pos_job_title }, which is why pos_team's own
      // conditional write was added first (S431) but pos_role's wasn't.
      const updatePayload = {}
      if (pos_role !== undefined) updatePayload.pos_role = pos_role || null
      if (pos_job_title !== undefined) updatePayload.pos_job_title = pos_job_title || null
      if (pos_team !== undefined) updatePayload.pos_team = pos_team || 'foh'
      if (pos_discount_limit !== undefined) updatePayload.pos_discount_limit = pos_discount_limit
      if (pos_allow_void !== undefined) updatePayload.pos_allow_void = pos_allow_void

      if (Object.keys(updatePayload).length === 0) return json({ error: 'No fields to update' }, 400)

      const { error: updateErr } = await admin.from('profiles')
        .update(updatePayload)
        .eq('id', userId)
      if (updateErr) return json({ error: updateErr.message }, 400)
      return json({ success: true })
    }

    // ── Delete a POS staff member ─────────────────────────────────────────────
    if (action === 'delete_pos_staff') {
      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const posTarget = await loadTarget(userId)
      const posDenied = requireStaffTarget(posTarget, 'pos')
      if (posDenied) return posDenied
      if (!isCallerAdmin && posTarget?.pos_role === 'manager') {
        return json({ error: 'Managers can only be deleted by admin' }, 403)
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

      // Same client AND actually a POS PIN account. The client_id check alone used to let a POS
      // manager point this at the Owner (who shares the client_id) and overwrite their password
      // with a 4-6 digit PIN they chose -- see requireStaffTarget's note above.
      const pinTarget = await loadTarget(userId)
      const pinDenied = requireStaffTarget(pinTarget, 'pos')
      if (pinDenied) return pinDenied

      // Salt must be this account's existing email, not a freshly generated one — the login
      // side derives from whatever pos_email currently holds, so a reset that salted with
      // anything else would produce a password nobody can ever reproduce.
      if (!pinTarget?.pos_email) return json({ error: 'This account has no POS login to reset' }, 400)

      // This is the one call in the codebase that Supabase's leaked-password protection would
      // have broken outright: updateUserById routes through GoTrue's adminUserUpdate, which
      // DOES run checkPasswordStrength (unlike adminUserCreate), and every 4-6 digit PIN is in
      // the HIBP corpus. Creating staff would have kept working while resetting their PIN
      // failed with "password is known to be weak" on every possible value. Deriving first is
      // what makes the toggle safe to enable.
      const { pepper: resetPepper } = await getAppSecrets(admin)
      const { error: updateErr } = await admin.auth.admin.updateUserById(userId, {
        password: await derivePinPassword(pinTarget.pos_email, pin, resetPepper),
      })
      if (updateErr) return json({ error: updateErr.message }, 400)

      await vaultPin(userId, pinTarget.client_id, 'pos', pin)

      return json({ success: true })
    }

    // ── Reveal a staff member's PIN — PLATFORM ADMIN ONLY ─────────────────────
    // Not available to the client Owner or a POS manager, deliberately. They already have a
    // one-click Reset PIN on PosStaff.jsx, which stays the normal answer to "the waiter forgot
    // their PIN" — this exists for recovery and audit, not as a helpdesk shortcut. Widening it
    // to Owners is a one-line change to this gate, but it exposes every PIN to every client login.
    if (action === 'view_staff_pin') {
      if (!isCallerAdmin) return json({ error: 'Forbidden' }, 403)

      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const { data: vaultRow } = await admin
        .from('staff_pin_vault').select('pin_cipher, client_id, kind')
        .eq('user_id', userId).maybeSingle()

      // A missing row is normal, not an error state: accounts created before this feature have
      // no stored PIN and never will until someone resets it or the owner signs in through the
      // login functions' upgrade branch. Say so plainly rather than implying something broke.
      if (!vaultRow) {
        return json({
          error: 'No stored PIN for this account. It predates the PIN vault and has not been reset since. Use Reset PIN to set a new one.',
        }, 404)
      }

      const { vaultKey } = await getAppSecrets(admin)
      let revealedPin: string
      try {
        revealedPin = await decryptPin(vaultRow.pin_cipher, vaultKey)
      } catch {
        return json({
          error: 'The stored PIN could not be decrypted — app_secrets.pin_vault_key has changed since it was written. Use Reset PIN.',
        }, 500)
      }

      // Revealing a credential must leave a trace. Note what is stored: who looked, at which
      // account, when — never the PIN itself, which would put it in audit_logs in plaintext and
      // undo the point of encrypting it.
      const { data: vaultClient } = await admin
        .from('clients').select('name').eq('id', vaultRow.client_id).maybeSingle()

      await admin.from('audit_logs').insert({
        client_id:   vaultRow.client_id,
        client_name: vaultClient?.name ?? null,
        user_id:     user.id,
        user_name:   user.email,
        table_name:  'staff_pin_vault',
        action:      'VIEW',
        record_id:   userId,
        new_data:    { kind: vaultRow.kind, revealed: true },
      })

      return json({ pin: revealedPin })
    }

    // ── Rebuild every PIN account's password from the vault — PLATFORM ADMIN ONLY ─────────────
    // This is the whole reason the vault exists. Before it, PIN_PEPPER was neither recoverable
    // nor rotatable: PINs were stored nowhere, so losing or changing the pepper meant hand-
    // resetting every POS and Self-Service account across every client. With the plaintext PINs
    // recoverable, that becomes this one call.
    //
    // Run it when: the pepper is being rotated deliberately, or app_secrets was restored from a
    // backup that disagrees with what accounts were created under.
    if (action === 'rederive_pin_passwords') {
      if (!isCallerAdmin) return json({ error: 'Forbidden' }, 403)

      const { rotate_pepper } = params

      // An env pepper wins over the DB one inside getAppSecrets, so rotating the DB column while
      // PIN_PEPPER is set would silently do nothing and report success. Refuse instead.
      if (rotate_pepper && Deno.env.get('PIN_PEPPER')) {
        return json({
          error: 'PIN_PEPPER is set as an Edge Function secret and overrides the database value. Unset it (supabase secrets unset PIN_PEPPER) before rotating.',
        }, 400)
      }

      if (rotate_pepper) {
        const fresh = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
        const { error: rotErr } = await admin
          .from('app_secrets').update({ pin_pepper: fresh, updated_at: new Date().toISOString() }).eq('id', 1)
        if (rotErr) return json({ error: 'Failed to rotate pepper: ' + rotErr.message }, 500)
        resetAppSecretsCache()
      }

      const { pepper, vaultKey } = await getAppSecrets(admin)

      // Every vaulted account, with the email each derivation must be salted with. pos_email and
      // hr_self_service_email are the two salts, picked by `kind` — using the wrong one produces
      // a password nobody can ever reproduce.
      const { data: vaulted } = await admin
        .from('staff_pin_vault').select('user_id, kind, pin_cipher')
      const { data: emails } = await admin
        .from('profiles').select('id, pos_email, hr_self_service_email')
        .in('id', (vaulted ?? []).map((v: { user_id: string }) => v.user_id))

      const emailById = new Map(
        (emails ?? []).map((p: { id: string; pos_email: string | null; hr_self_service_email: string | null }) => [p.id, p]),
      )

      let updated = 0
      const failures: { user_id: string; reason: string }[] = []

      for (const row of vaulted ?? []) {
        try {
          const prof  = emailById.get(row.user_id) as { pos_email: string | null; hr_self_service_email: string | null } | undefined
          const salt  = row.kind === 'pos' ? prof?.pos_email : prof?.hr_self_service_email
          if (!salt) { failures.push({ user_id: row.user_id, reason: 'no login email on profile' }); continue }

          const pin = await decryptPin(row.pin_cipher, vaultKey)
          const { error: upErr } = await admin.auth.admin.updateUserById(row.user_id, {
            password: await derivePinPassword(salt, pin, pepper),
          })
          if (upErr) { failures.push({ user_id: row.user_id, reason: upErr.message }); continue }
          updated++
        } catch (e) {
          failures.push({ user_id: row.user_id, reason: e instanceof Error ? e.message : 'unknown' })
        }
      }

      // Accounts with no vault row cannot be rebuilt — their PIN was never observed. Reported
      // rather than hidden, because those are exactly the ones that still need a manual reset.
      const { count: totalPinAccounts } = await admin
        .from('profiles').select('id', { count: 'exact', head: true })
        .or('pos_email.not.is.null,hr_self_service.eq.true')

      return json({
        success:       true,
        rotated:       !!rotate_pepper,
        updated,
        failures,
        vaulted:       (vaulted ?? []).length,
        pin_accounts:  totalPinAccounts ?? null,
        unrecoverable: Math.max(0, (totalPinAccounts ?? 0) - (vaulted ?? []).length),
      })
    }

    // ── Create an IMS staff member — real email + password (not a PIN like POS) ───────────────
    // Optional employee_id links the new IMS account to an existing hr_employees record, same
    // pattern as create_pos_staff's HR Employee mode — full_name is taken from that employee.
    if (action === 'create_ims_staff') {
      const targetClientId = isCallerAdmin ? params.client_id : profile?.client_id
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { email, password, ims_role, ims_job_title, employee_id } = params
      let { full_name } = params
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email is required' }, 400)
      if (!password || password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

      // createUser bypasses GoTrue's HIBP check (adminUserCreate never calls
      // checkPasswordStrength), so the dashboard toggle cannot screen this path even when it is
      // switched on — while the matching reset_*_password action below, which goes through
      // adminUserUpdate, IS screened by it. Without this the two halves of the same feature
      // disagree: a manager could set a breached password at creation and then be refused that
      // exact password on reset. Fail-open on null and loudly, same stance as register_trial.
      const createPwned = await isPasswordPwned(password)
      if (createPwned === true) {
        return json({ error: 'This password has appeared in a known data breach. Please choose a different one.' }, 400)
      }
      if (createPwned === null) {
        console.error('[admin-user-ops] HIBP check unavailable — staff account created without breach screening')
      }

      const validRoles = ['staff', 'supervisor', 'manager']
      if (ims_role && !validRoles.includes(ims_role)) return json({ error: 'Invalid ims_role' }, 400)

      if (employee_id) {
        const { data: employee } = await admin
          .from('hr_employees').select('id, full_name, client_id')
          .eq('id', employee_id).eq('client_id', targetClientId).single()
        if (!employee) return json({ error: 'Employee not found' }, 400)

        const { data: existingLink } = await admin
          .from('profiles').select('id').eq('hr_employee_id', employee_id).not('ims_role', 'is', null).maybeSingle()
        if (existingLink) return json({ error: 'This employee already has an IMS staff account' }, 400)

        full_name = employee.full_name
      }
      if (!full_name) return json({ error: 'full_name is required' }, 400)

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const { error: profileErr } = await admin.from('profiles').upsert({
        id:             authData.user.id,
        full_name,
        role:           'client',
        client_id:      targetClientId,
        ims_role:       ims_role || null,
        ims_job_title:  ims_job_title || null,
        hr_employee_id: employee_id || null,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      return json({ success: true, userId: authData.user.id })
    }

    // ── Update an IMS staff member's role ────────────────────────────────────
    if (action === 'update_ims_role') {
      const { userId, ims_role, ims_job_title } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      if (ims_role && !validRoles.includes(ims_role)) return json({ error: 'Invalid ims_role' }, 400)

      const targetProfile = await loadTarget(userId)
      if (!targetProfile) return json({ error: 'User not found' }, 404)
      if (targetProfile.role === 'admin') return json({ error: 'Forbidden' }, 403)
      if (!isCallerAdmin && targetProfile.client_id !== profile?.client_id) {
        return json({ error: 'Forbidden' }, 403)
      }
      // Unlike POS, IMS has an "Existing User" mode (ImsStaff.jsx:190) that deliberately targets a
      // login with NO staff markers yet -- which is exactly the shape of the client Owner's own
      // account. So this can't simply require an existing ims_role the way update_pos_role does.
      // Instead: converting a non-staff login into IMS staff is an Owner-level decision, because
      // stamping ims_role onto the Owner demotes them out of Owner access (the isOwner test in
      // AuthContext.js is a negative one). A module manager may still change or clear the role of
      // someone who is already IMS staff.
      if (ims_role && !targetProfile.ims_role && !(isCallerAdmin || isCallerOwner)) {
        return json({ error: 'Only the account owner or an administrator can give an existing login IMS access' }, 403)
      }
      // An account already marked POS PIN staff, HR self-service, or HR staff is RLS-blocked from
      // every pure-IMS / IMS+POS table regardless of ims_role (no_pos_pin_staff /
      // no_self_service_accounts / no_hr_role_staff don't check ims_role at all) — granting
      // ims_role here would look like it worked in the UI while every real read/write still
      // silently failed. Only reject when actually setting a role; clearing one (ims_role: null)
      // is always safe.
      if (ims_role && (targetProfile?.pos_role || targetProfile?.hr_self_service || targetProfile?.hr_role)) {
        return json({ error: 'This account already has POS, HR self-service, or HR staff access and cannot also be an IMS staff account' }, 400)
      }

      const { error: updateErr } = await admin.from('profiles')
        .update({ ims_role: ims_role || null, ims_job_title: ims_job_title || null })
        .eq('id', userId)
      if (updateErr) return json({ error: updateErr.message }, 400)
      return json({ success: true })
    }

    // ── Delete an IMS staff member ────────────────────────────────────────────
    if (action === 'delete_ims_staff') {
      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const imsTarget = await loadTarget(userId)
      const imsDenied = requireStaffTarget(imsTarget, 'ims')
      if (imsDenied) return imsDenied
      if (!isCallerAdmin && imsTarget?.ims_role === 'manager') {
        return json({ error: 'Managers can only be deleted by admin' }, 403)
      }

      const { error: delErr } = await admin.auth.admin.deleteUser(userId)
      if (delErr) return json({ error: delErr.message }, 400)
      return json({ success: true })
    }

    // ── Reset an IMS staff member's password ──────────────────────────────────
    if (action === 'reset_ims_password') {
      const { userId, password } = params
      if (!userId || !password) return json({ error: 'userId and password are required' }, 400)
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

      // Same client AND actually an IMS staff account -- this was the sharpest edge of the
      // Owner-takeover chain: the Owner's id and real email both come back from
      // get_ims_eligible_users, so a client_id-only check meant one call here handed a manager a
      // working Owner login.
      const imsPwTarget = await loadTarget(userId)
      const imsPwDenied = requireStaffTarget(imsPwTarget, 'ims')
      if (imsPwDenied) return imsPwDenied

      const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password })
      if (updateErr) return json({ error: updateErr.message }, 400)

      return json({ success: true })
    }

    // ── Create an HR staff member — real email + password (not a PIN, not self-service) ───────
    // Structural mirror of create_ims_staff. Optional employee_id links the new HR-staff account
    // to an existing hr_employees record, same pattern as create_pos_staff's HR Employee mode.
    if (action === 'create_hr_staff') {
      const targetClientId = isCallerAdmin ? params.client_id : profile?.client_id
      if (!targetClientId) return json({ error: 'client_id required' }, 400)

      const { email, password, hr_role, hr_job_title, employee_id } = params
      let { full_name } = params
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'A valid email is required' }, 400)
      if (!password || password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

      // createUser bypasses GoTrue's HIBP check (adminUserCreate never calls
      // checkPasswordStrength), so the dashboard toggle cannot screen this path even when it is
      // switched on — while the matching reset_*_password action below, which goes through
      // adminUserUpdate, IS screened by it. Without this the two halves of the same feature
      // disagree: a manager could set a breached password at creation and then be refused that
      // exact password on reset. Fail-open on null and loudly, same stance as register_trial.
      const createPwned = await isPasswordPwned(password)
      if (createPwned === true) {
        return json({ error: 'This password has appeared in a known data breach. Please choose a different one.' }, 400)
      }
      if (createPwned === null) {
        console.error('[admin-user-ops] HIBP check unavailable — staff account created without breach screening')
      }

      const validRoles = ['staff', 'supervisor', 'manager']
      if (hr_role && !validRoles.includes(hr_role)) return json({ error: 'Invalid hr_role' }, 400)

      if (employee_id) {
        const { data: employee } = await admin
          .from('hr_employees').select('id, full_name, client_id')
          .eq('id', employee_id).eq('client_id', targetClientId).single()
        if (!employee) return json({ error: 'Employee not found' }, 400)

        const { data: existingLink } = await admin
          .from('profiles').select('id').eq('hr_employee_id', employee_id).not('hr_role', 'is', null).maybeSingle()
        if (existingLink) return json({ error: 'This employee already has an HR staff account' }, 400)

        full_name = employee.full_name
      }
      if (!full_name) return json({ error: 'full_name is required' }, 400)

      const { data: authData, error: authErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name },
      })
      if (authErr || !authData?.user) {
        return json({ error: authErr?.message || 'Failed to create user' }, 400)
      }

      const { error: profileErr } = await admin.from('profiles').upsert({
        id:             authData.user.id,
        full_name,
        role:           'client',
        client_id:      targetClientId,
        hr_role:        hr_role || null,
        hr_job_title:   hr_job_title || null,
        hr_employee_id: employee_id || null,
      }, { onConflict: 'id' })

      if (profileErr) {
        await admin.auth.admin.deleteUser(authData.user.id)
        return json({ error: profileErr.message }, 400)
      }

      return json({ success: true, userId: authData.user.id })
    }

    // ── Update an HR staff member's role ──────────────────────────────────────
    if (action === 'update_hr_role') {
      const { userId, hr_role, hr_job_title } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const validRoles = ['staff', 'supervisor', 'manager']
      if (hr_role && !validRoles.includes(hr_role)) return json({ error: 'Invalid hr_role' }, 400)

      const targetProfile = await loadTarget(userId)
      if (!targetProfile) return json({ error: 'User not found' }, 404)
      if (targetProfile.role === 'admin') return json({ error: 'Forbidden' }, 403)
      if (!isCallerAdmin && targetProfile.client_id !== profile?.client_id) {
        return json({ error: 'Forbidden' }, 403)
      }
      // Mirror of update_ims_role's first-assignment gate — HR has the same "Existing User" mode
      // (HrStaff.jsx:189), so the same Owner-demotion path exists here.
      if (hr_role && !targetProfile.hr_role && !(isCallerAdmin || isCallerOwner)) {
        return json({ error: 'Only the account owner or an administrator can give an existing login HR access' }, 403)
      }
      // Same reasoning as update_ims_role's guard — an account already marked POS PIN staff, IMS
      // staff, or HR self-service is RLS-blocked from every hr_ table regardless of hr_role.
      if (hr_role && (targetProfile?.pos_role || targetProfile?.ims_role || targetProfile?.hr_self_service)) {
        return json({ error: 'This account already has POS, IMS, or HR self-service access and cannot also be an HR staff account' }, 400)
      }

      const { error: updateErr } = await admin.from('profiles')
        .update({ hr_role: hr_role || null, hr_job_title: hr_job_title || null })
        .eq('id', userId)
      if (updateErr) return json({ error: updateErr.message }, 400)
      return json({ success: true })
    }

    // ── Delete an HR staff member ──────────────────────────────────────────────
    if (action === 'delete_hr_staff') {
      const { userId } = params
      if (!userId) return json({ error: 'userId is required' }, 400)

      const hrTarget = await loadTarget(userId)
      const hrDenied = requireStaffTarget(hrTarget, 'hr')
      if (hrDenied) return hrDenied
      if (!isCallerAdmin && hrTarget?.hr_role === 'manager') {
        return json({ error: 'Managers can only be deleted by admin' }, 403)
      }

      const { error: delErr } = await admin.auth.admin.deleteUser(userId)
      if (delErr) return json({ error: delErr.message }, 400)
      return json({ success: true })
    }

    // ── Reset an HR staff member's password ────────────────────────────────────
    if (action === 'reset_hr_password') {
      const { userId, password } = params
      if (!userId || !password) return json({ error: 'userId and password are required' }, 400)
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)

      // Same client AND actually an HR staff account — mirror of reset_ims_password's guard.
      const hrPwTarget = await loadTarget(userId)
      const hrPwDenied = requireStaffTarget(hrPwTarget, 'hr')
      if (hrPwDenied) return hrPwDenied

      const { error: updateErr } = await admin.auth.admin.updateUserById(userId, { password })
      if (updateErr) return json({ error: updateErr.message }, 400)

      return json({ success: true })
    }

    // ── All remaining actions require admin role ──────────────────────────────
    if (profile?.role !== 'admin') return json({ error: 'Forbidden' }, 403)

    // ── Delete a single fixed asset, admin-only — never exposed to any client
    // login (including Owner-rank), even though hasImsAccess('manager') would
    // normally be enough to post/edit within this module. A posted asset's
    // assets_depreciation_schedule rows are blocked by the immutability trigger
    // (enforce_asset_schedule_immutable) for every authenticated session — only
    // this function's service-role client (auth.uid() IS NULL) can clear them,
    // same mechanism Danger Zone already relies on. assets_repair_expenses.asset_id
    // is ON DELETE SET NULL so it needs no explicit cleanup here.
    if (action === 'deleteAsset') {
      const { clientId, assetId } = params
      if (!clientId || !assetId) return json({ error: 'clientId and assetId are required' }, 400)

      const { error: scheduleErr } = await admin
        .from('assets_depreciation_schedule').delete().eq('client_id', clientId).eq('asset_id', assetId)
      if (scheduleErr) return json({ error: `Failed to delete depreciation history: ${scheduleErr.message}` }, 400)

      const { error: assetErr } = await admin
        .from('assets_register').delete().eq('client_id', clientId).eq('id', assetId)
      if (assetErr) return json({ error: `Failed to delete asset: ${assetErr.message}` }, 400)

      return json({ success: true })
    }

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
        await del(admin.from('ims_gate_passes').delete().eq('client_id', clientId), 'ims_gate_passes')
        // Fixed Assets — schedule/pool-lines before their parent runs (no cascade on asset_id/
        // category_id, so register/categories must go last too, in that order).
        await del(admin.from('assets_depreciation_schedule').delete().eq('client_id', clientId), 'assets_depreciation_schedule')
        await del(admin.from('assets_depreciation_runs').delete().eq('client_id', clientId), 'assets_depreciation_runs')
        await del(admin.from('assets_tax_pool_lines').delete().eq('client_id', clientId), 'assets_tax_pool_lines')
        await del(admin.from('assets_tax_pool_runs').delete().eq('client_id', clientId), 'assets_tax_pool_runs')
        await del(admin.from('assets_repair_expenses').delete().eq('client_id', clientId), 'assets_repair_expenses')
        await del(admin.from('assets_register').delete().eq('client_id', clientId), 'assets_register')
        await del(admin.from('assets_categories').delete().eq('client_id', clientId), 'assets_categories')
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
        await del(admin.from('pos_parking_slips').delete().eq('client_id', clientId), 'pos_parking_slips')
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
      await del(admin.from('pos_parking_slips').delete().eq('client_id', clientId), 'pos_parking_slips')
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
      // No FK cascade from monthly_owner_reports.period_id -> monthly_periods.id — must go first.
      await del(admin.from('monthly_owner_reports').delete().eq('client_id', clientId), 'monthly_owner_reports')
      await del(admin.from('monthly_periods').delete().eq('client_id', clientId), 'monthly_periods')
      await del(admin.from('recipes').delete().eq('client_id', clientId), 'recipes')
      await del(admin.from('items').delete().eq('client_id', clientId), 'items')
      await del(admin.from('ims_gate_passes').delete().eq('client_id', clientId), 'ims_gate_passes')
      await del(admin.from('assets_depreciation_schedule').delete().eq('client_id', clientId), 'assets_depreciation_schedule')
      await del(admin.from('assets_depreciation_runs').delete().eq('client_id', clientId), 'assets_depreciation_runs')
      await del(admin.from('assets_tax_pool_lines').delete().eq('client_id', clientId), 'assets_tax_pool_lines')
      await del(admin.from('assets_tax_pool_runs').delete().eq('client_id', clientId), 'assets_tax_pool_runs')
      await del(admin.from('assets_repair_expenses').delete().eq('client_id', clientId), 'assets_repair_expenses')
      await del(admin.from('assets_register').delete().eq('client_id', clientId), 'assets_register')
      await del(admin.from('assets_categories').delete().eq('client_id', clientId), 'assets_categories')
      await del(admin.from('vendors').delete().eq('client_id', clientId), 'vendors')
      await del(admin.from('categories').delete().eq('client_id', clientId), 'categories')
      // Cascades from both profiles and clients, so this is belt-and-braces rather than required —
      // but CLAUDE.md step 7 asks for every client-scoped table to be listed explicitly, and a
      // table that only ever cleans itself up implicitly is the kind that gets missed when the
      // cascade is later changed. app_secrets is deliberately absent: it is app-wide, not
      // per-client, and must never be touched by a client clear/delete path.
      await del(admin.from('staff_pin_vault').delete().eq('client_id', clientId), 'staff_pin_vault')

      return json({ success: true })
    }

    return json({ error: `Unknown action: ${action}` }, 400)
  } catch (err) {
    // Was defaulting to HTTP 200 with an error body, so callers had no way to tell a thrown
    // failure from a success by status alone (and the clearModuleData/deleteClientData sequences
    // throw mid-run by design when an FK blocks them).
    return json({ error: (err as Error).message }, 500)
  }
})
