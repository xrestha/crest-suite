// What Final Settlement does to a leaver's staff logins (S798 3f-2, GAP-OUTLETS-3, owner decision H22 (a)).
//
// settlement_linked_logins lists each login tied to the record with what Finalize will do to it, read
// from the same settlement_login_plan Finalize applies, so the confirm says what the click does:
//   block          no other job in the group: the whole login is blocked (S753)
//   move           a home login linked to an active record at another outlet: its home becomes that
//                  outlet, at the same rank, and it can no longer open this one
//   remove_access  a login from another outlet linked to this record: it loses this outlet only
// The settlement row's login_changes records each move and removal so Reopen can put it back. After a
// Reopen it holds only what could not be put back, each with a not_undone reason.

export function splitPlan(rows) {
  const list = Array.isArray(rows) ? rows : []
  return {
    block: list.filter(l => !l.action || l.action === 'block'),
    move: list.filter(l => l.action === 'move'),
    remove: list.filter(l => l.action === 'remove_access'),
  }
}

export const loginLabel = l => `${l.full_name} (${l.modules}${l.hr_manager ? ', HR Manager' : ''})`

export function moveLine(l) {
  return `${loginLabel(l)} still works at ${l.outlet_name}, where it is linked to their record there, so it is not blocked: `
    + `it moves to ${l.outlet_name} at the same rank, and can no longer open this outlet. Reopen moves it back.`
}

export function removeLine(l) {
  return `${loginLabel(l)} belongs to another of your outlets and loses access to ${l.outlet_name} only; `
    + 'it keeps working where it belongs. Reopen gives the access back.'
}

function changesOf(row) {
  const list = Array.isArray(row?.login_changes) ? row.login_changes : []
  return list.filter(c => c && (c.kind === 'moved' || c.kind === 'access_removed'))
}

// The tail of the "Settlement finalized" message.
export function finalizedLoginNote(row) {
  const parts = []
  const blocked = Array.isArray(row?.blocked_logins) ? row.blocked_logins : []
  if (blocked.length > 0) parts.push('staff login blocked: ' + blocked.join(', '))
  for (const c of changesOf(row)) {
    parts.push(c.kind === 'moved'
      ? `${c.name}'s login now belongs to ${c.outlet || 'their other outlet'}`
      : `${c.name} can no longer open ${c.outlet || 'this outlet'}`)
  }
  return parts.length > 0 ? '; ' + parts.join('; ') : ''
}

// The Reopen dialog: what Reopen puts back, for a finalized settlement.
export function reopenLoginLines(row) {
  return changesOf(row).filter(c => !c.not_undone).map(c => (c.kind === 'moved'
    ? `${c.name}'s login moves back to this outlet and can still open ${c.outlet || 'the outlet it moved to'}, unless it was moved or relinked since.`
    : `${c.name} can open ${c.outlet || 'this outlet'} again, unless their login has changed outlet since.`))
}

// A reopened draft: what Reopen could not put back, and why.
export function notUndoneLines(row) {
  return changesOf(row).filter(c => c.not_undone).map(c => (c.kind === 'moved'
    ? `${c.name}'s login was not moved back from ${c.outlet || 'the other outlet'}: ${c.not_undone}. Check it on HR Staff there.`
    : `${c.name}'s access to ${c.outlet || 'this outlet'} was not put back: ${c.not_undone}. The Owner can tick it again in Outlet Access and link it on HR Staff.`))
}
