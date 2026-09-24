// Who gets a setup guide (S790). Its own small file because Layout — which is in the eager bundle —
// reads it to decide whether the account menu offers "Setup guide", and must not pull the whole
// step catalogue (setupSteps.js) in with it. setupSteps.js re-exports it.

const RANK = { staff: 1, supervisor: 2, manager: 3 }

/**
 * Who is looking, as the guide needs it. Owner and admin see everything the client has. A
 * "manager" is an email login (never a PIN) holding supervisor or manager rank in exactly ONE
 * module: the staff-isolation policies fence a login carrying one module's marker out of the other
 * modules' tables (no_ims_staff / no_hr_role_staff), so a second marker would make every signal in
 * that other module read an empty table as "not done yet". Everyone else gets no guide (S790:
 * "Owner + email-login managers").
 */
export function viewerOf({ isAdmin, isOwner, profile }) {
  if (isAdmin) return { kind: 'admin' }
  if (isOwner) return { kind: 'owner' }
  const p = profile || {}
  if (p.role !== 'client' || p.pos_role || p.pos_email || p.ims_email || p.hr_self_service) return null
  const held = [p.ims_role && 'ims', p.hr_role && 'hr'].filter(Boolean)
  if (held.length !== 1) return null
  const module = held[0]
  const rank = module === 'ims' ? p.ims_role : p.hr_role
  if ((RANK[rank] || 0) < RANK.supervisor) return null
  return { kind: 'manager', module, rank }
}
