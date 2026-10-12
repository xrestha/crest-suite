// What happened to a guest-menu logo save whose answer never arrived (S814, GUEST-8). Pure, so the
// rule is tested on its own (guestLogoSave.test.js); GuestMenuSetup.jsx reads the stored logo back
// and asks this which of four things to say.
//
// A save that timed out or lost its connection may still have landed, so the page never says it
// failed and never deletes the file it uploaded on the strength of a lost answer — that was how a
// slow save could leave the menu pointing at a deleted file. It reads `guest_menu_logo_url` back:
//
//   landed     the stored logo is the one this save wanted   → it saved, just slowly
//   pending    the stored logo is still the one from before  → it may still go through; keep both files
//   unknown    the read-back failed too (`stored` undefined) → nobody can say which logo guests see
//   elsewhere  the stored logo is neither                    → another device saved one meanwhile
//
// `wanted` is null for a Remove. An empty string and null are the same "no logo".

const norm = v => (v == null || v === '' ? null : v)

export function logoSaveOutcome({ wanted, before, stored }) {
  if (stored === undefined) return 'unknown'
  const s = norm(stored)
  if (s === norm(wanted)) return 'landed'
  if (s === norm(before)) return 'pending'
  return 'elsewhere'
}
