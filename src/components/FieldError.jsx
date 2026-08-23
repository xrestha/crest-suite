/**
 * Per-field validation message + the ARIA that binds it to its input.
 *
 * The pattern was formalised on the login/reset surface (S534) and lived only there for as long as
 * it existed — DESIGN.md described it as "the pattern to extend", and `aria-invalid` appeared in
 * exactly one file in the whole product. Everywhere else a form reported "Full name is required."
 * as one string somewhere in the modal, with nothing tying the sentence to the box: a sighted user
 * hunts for the field, a screen-reader user is told a form failed and never told which control.
 * `EmployeeForm.jsx` switching TAB to reveal the offending field is the tell that the author
 * already knew which field it was — the information was computed and then thrown away.
 *
 * The two halves are deliberately separate exports rather than one wrapper component: a field's
 * control is often a `SearchableSelect`, a `BsCalendarPicker`, a `QtyInput` or a raw `<select>`,
 * so there is no single element for a wrapper to clone props onto. Spread `fieldAria(...)` on
 * whatever the control turns out to be, and render `<FieldError>` under it.
 *
 *   <div className="form-field">
 *     <label htmlFor="emp-name">Full Name</label>
 *     <input id="emp-name" {...fieldAria('emp-name', errors.full_name)} … />
 *     <FieldError id="emp-name" message={errors.full_name} />
 *   </div>
 *
 * `id` must be the CONTROL's id — the message derives its own id from it, which is what
 * `aria-describedby` then points at. Passing two different ids silently produces a message that
 * describes nothing.
 */

/** ARIA props for the control itself. Returns `undefined` (not `false`/`'false'`) when the field
 *  is valid, so React omits both attributes entirely rather than rendering `aria-invalid="false"`
 *  on every field in the form. */
export function fieldAria(id, message) {
  return {
    'aria-invalid': message ? 'true' : undefined,
    'aria-describedby': message ? `${id}-err` : undefined,
  }
}

// `invalidStyle(base, message)` — the red border for a control still styled inline, which no CSS
// attribute selector can reach — lives in `shared/inlineFieldState.js`, next to `disabledStyle`.
// Both are there for the same reason and neither is about the message, which is what this file is.

/** The message. `role="alert"` so it is announced when it appears, not merely shown — an inline
 *  error that is only visible tells a screen-reader user nothing at the moment they pressed Save. */
export default function FieldError({ id, message }) {
  if (!message) return null
  return (
    <span className="field-error" id={`${id}-err`} role="alert">{message}</span>
  )
}
