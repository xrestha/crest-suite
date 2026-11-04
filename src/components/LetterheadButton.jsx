import { useEffect, useState } from 'react'
import Tip from './Tip'

// What a press says while the letterhead is not ready (S877). Exported so a page or a test can
// name the same sentence rather than a copy of it.
export const LETTERHEAD_WAIT_TEXT = 'Getting the business name for the letterhead. Try again in a moment.'
export const LETTERHEAD_ERROR_TEXT = 'The business name could not be read, so the letterhead would be blank. Reload the page to try again.'

/**
 * An Excel export or Print button that waits for the letterhead's business name (S877).
 *
 * `ready` and `error` are the letterhead read's state, normally `biz.ready` / `biz.error` from
 * useBizInfo (or a page's own pair). Until `ready` is true, or once `error` is set, the button is
 * `aria-disabled`, not `disabled`: it keeps its focus and a press does not run `onClick` but shows
 * one short polite status line beside it saying what is missing (page-layout.md, Controls: a
 * precondition on an action is aria-disabled plus a press that says what is missing; `disabled` is
 * for an action in flight). Before this, 25 pages greyed the button with `disabled` and said
 * nothing, so a touch screen or a keyboard got a dead button with no reason.
 *
 * Every other prop goes to the `<button>` unchanged, `disabled` included: a page keeps its own
 * reasons (loading, a failed report read, no rows, an export in flight) on `disabled` exactly as
 * before, and while `disabled` holds the button is left as it was, with no aria-disabled on top.
 * Once ready it is the plain button it replaced.
 *
 * It renders a fragment, so the button stays a direct child of its toolbar (a `marginLeft: 'auto'`
 * on it still pushes it right) and the status line is a sibling only while it is showing. Print
 * hides every button, and the line carries `no-print` so it does not print alone.
 *
 * Never wrap it in `Tip`: Tip adds no tab stop only when its one child is a NATIVE element, so
 * around this component it would add a second one. Pass `tip` (and `tipWidth`) instead, which puts
 * the Tip around the inner `<button>`.
 */
export default function LetterheadButton({
  ready, error, onClick, disabled, className = 'btn btn-ghost', type = 'button', tip, tipWidth, children, ...rest
}) {
  const [asked, setAsked] = useState(false)
  const blocked = !ready || !!error
  // The line answers a press and lasts only while the reason does.
  useEffect(() => { if (!blocked) setAsked(false) }, [blocked])

  function handleClick(event) {
    if (blocked) { setAsked(true); return }
    if (onClick) onClick(event)
  }

  const button = (
    <button
      {...rest}
      type={type}
      className={className}
      disabled={disabled}
      aria-disabled={!disabled && blocked ? 'true' : undefined}
      onClick={handleClick}
    >
      {children}
    </button>
  )

  return (
    <>
      {tip ? <Tip text={tip} width={tipWidth}>{button}</Tip> : button}
      {asked && blocked && (
        <span role="status" className="page-footnote no-print" style={{ margin: 0 }}>
          {error ? LETTERHEAD_ERROR_TEXT : LETTERHEAD_WAIT_TEXT}
        </span>
      )}
    </>
  )
}
