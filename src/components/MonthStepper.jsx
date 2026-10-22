import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * ‹ › around a page's month picker (S858). The S857 Suite Pro critique found no way to step to the
 * month beside the one on screen: comparing two months meant opening a list and finding the
 * neighbour by hand, on the pages an owner compares months on. The page owns its list and its change
 * handler; this only draws the two buttons and names where each one goes.
 *
 * `prev` / `next` are `{ key, label }` or null. At an end of the list the button stays where it is,
 * `aria-disabled` and named "No earlier month", rather than vanishing and moving the picker under the
 * reader's thumb. `busy` is the one case for a real `disabled`: an action in flight (page-layout.md).
 * `unit` names what is stepped ("month", "fiscal year"). `month-stepper--fields` is the variant for
 * labelled fields (the Group Console's Month and Year), which lines the buttons up with the boxes.
 */
export default function MonthStepper({ prev, next, onStep, busy = false, unit = 'month', className = '', children }) {
  const button = (target, dir) => {
    const Icon = dir === 'prev' ? ChevronLeft : ChevronRight
    const name = target
      ? `${dir === 'prev' ? 'Previous' : 'Next'} ${unit}: ${target.label}`
      : `No ${dir === 'prev' ? 'earlier' : 'later'} ${unit}`
    return (
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        aria-label={name}
        title={name}
        disabled={busy}
        aria-disabled={!target ? 'true' : undefined}
        onClick={() => { if (target && !busy) onStep(target.key) }}
      >
        <Icon size={15} aria-hidden="true" />
      </button>
    )
  }
  return (
    <div className={`month-stepper no-print${className ? ` ${className}` : ''}`}>
      {button(prev, 'prev')}
      {children}
      {button(next, 'next')}
    </div>
  )
}

// The neighbours of `currentKey` in a list ordered NEWEST FIRST (how every period list here is read):
// the previous month is the next item down, the next month the one above. `labelOf` names an item.
export function neighboursOf(list, currentKey, keyOf, labelOf) {
  const i = (list || []).findIndex(x => keyOf(x) === currentKey)
  if (i < 0) return { prev: null, next: null }
  const at = j => (j >= 0 && j < list.length ? { key: keyOf(list[j]), label: labelOf(list[j]) } : null)
  return { prev: at(i + 1), next: at(i - 1) }
}
