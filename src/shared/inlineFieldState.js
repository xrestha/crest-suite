/**
 * Field state for a control that is styled INLINE.
 *
 * Both helpers here exist for one reason: an inline `style` object cannot be reached by a CSS
 * attribute selector or a media query, so the `[aria-invalid="true"]` and `:disabled` rules in
 * `Layout.css` skip every control that hand-rolls its own look. That is not a small minority —
 * the period-lock inputs on Sales and Overheads, the two pages where a locked month must be
 * obvious, are all inline — so the choice is between letting those states be invisible there or
 * giving them one shared definition that composes into the base object.
 *
 * The right long-term fix is the control moving onto `.form-input`/`.form-select`, which also wins
 * it the `@media (pointer: coarse)` touch sizing it currently escapes. Until then, compose here
 * rather than writing a red or a grey per call site.
 */

/** Red border for a field failing validation. Pair with `fieldAria` + `<FieldError>` from
 *  `components/FieldError` — the border is never the message (WCAG 1.4.1). */
export function invalidStyle(base, message) {
  return message ? { ...base, borderColor: 'var(--theme-red)' } : base
}

/** The not-editable treatment, mirroring the `:disabled` / `[readonly]` rule in `Layout.css`.
 *
 *  The state is carried by the SURFACE, never by the value: the well flattens to transparent and
 *  the border steps down, while the text stays exactly as readable as it was. Dimming it would be
 *  the opacity mistake DESIGN.md already names — a locked period still shows a real month of real
 *  figures, and those have to be legible precisely because they can no longer be corrected. */
export function disabledStyle(base, isDisabled) {
  if (!isDisabled) return base
  return {
    ...base,
    background: 'transparent',
    borderColor: 'var(--theme-border-lt)',
    cursor: 'not-allowed',
    // WebKit paints a disabled control's text with -webkit-text-fill-color, which plain `color`
    // does not override, and iOS Safari layers its own opacity on top. Without both of these the
    // value greys out anyway and the rule above is defeated by the UA stylesheet.
    WebkitTextFillColor: base?.color || 'var(--theme-text1)',
    opacity: 1,
  }
}
