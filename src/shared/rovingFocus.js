// Arrow-key movement inside a group of like controls — a radiogroup of chips, a tab row (S759).
//
// WAI-ARIA's pattern for a radiogroup and for tabs is ONE Tab stop for the group and arrow keys
// between its members. Every chip on the till picker and the guest sheet was its own Tab stop, so
// a 20-option group cost twenty presses to cross, and the two tab rows on the Customization pages
// had no arrow movement at all. This is the one place that movement is written.
//
// Two helpers, both taking the keydown event:
//   moveRovingFocus(e, selector)  — focuses the previous/next enabled member matching `selector`
//                                   inside e.currentTarget (Home/End jump). Returns the element it
//                                   focused, or null when the key was not a movement key, so the
//                                   caller can `?.click()` it for a tab row (automatic activation).
//   rovingTabIndex(isActive)      — 0 for the group's one Tab stop, -1 for the rest.

const KEYS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last' }

export function moveRovingFocus(e, selector) {
  const step = KEYS[e.key]
  if (step === undefined) return null
  const members = Array.from(e.currentTarget.querySelectorAll(selector))
    .filter(el => !el.disabled && el.getAttribute('aria-disabled') !== 'true')
  if (members.length === 0) return null
  const at = members.indexOf(document.activeElement)
  let next
  if (step === 'first') next = 0
  else if (step === 'last') next = members.length - 1
  else next = at < 0 ? 0 : (at + step + members.length) % members.length
  e.preventDefault()
  members[next].focus()
  return members[next]
}

export function rovingTabIndex(isActive) {
  return isActive ? 0 : -1
}

// The ready-made keydown handler for a row of filter/sort chips — `onKeyDown={chipKeys}` on the
// `role="group"` container. Added S765, when an IMS sweep found 15 of 24 such rows carrying no
// keyboard movement and no `aria-pressed` at all, so which filter was applied was visible only as
// a colour. Named rather than inlined because the selector is the part worth getting right once:
// it skips disabled AND aria-disabled members, so a chip that is present-but-not-pressable (the
// product's documented pattern for "the press tells you what is missing") is stepped over rather
// than trapping the arrow key on it.
export function chipKeys(e) {
  moveRovingFocus(e, 'button:not([disabled]):not([aria-disabled="true"])')
}
