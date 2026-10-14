// Prints one ticket document through a hidden iframe (S837, the print station page).
//
// Chrome started with --kiosk-printing sends window.print() straight to the default printer with no
// dialog, so the page prints by loading the ticket into a frame and asking the FRAME to print: the
// page's own screen is never what goes to paper.
//
// The frame is sandboxed "allow-same-origin allow-modals": the ticket's text was typed by staff and
// guests, so no script in it may run (no allow-scripts), while print() still needs allow-modals and
// this page reaching into the frame needs allow-same-origin. Off-screen and zero-sized rather than
// display:none, which some browsers decline to print.
//
// After print() returns, the frame is kept for `settleMs` before it is removed: with kiosk printing
// print() returns as soon as the job is handed over, and removing the frame at once can cancel a job
// Chrome is still spooling.

export const LOAD_TIMEOUT_MS = 10000
export const PRINT_SETTLE_MS = 800

export function printHtmlInHiddenFrame(html, {
  doc = typeof document !== 'undefined' ? document : null,
  loadTimeoutMs = LOAD_TIMEOUT_MS,
  settleMs = PRINT_SETTLE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = id => clearTimeout(id),
} = {}) {
  return new Promise((resolve, reject) => {
    if (!doc?.body) { reject(new Error('This page cannot print here.')); return }
    const frame = doc.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('tabindex', '-1')
    frame.setAttribute('title', 'Ticket being printed')
    Object.assign(frame.style, {
      position: 'fixed', left: '-10000px', top: '0', width: '0', height: '0', border: '0', pointerEvents: 'none',
    })

    let settled = false
    const remove = () => {
      frame.onload = null
      if (frame.parentNode) frame.parentNode.removeChild(frame)
    }
    const timer = setTimer(() => {
      if (settled) return
      settled = true
      remove()
      reject(new Error(`The ticket did not load within ${Math.round(loadTimeoutMs / 1000)} s, so it was not printed.`))
    }, loadTimeoutMs)

    frame.onload = () => {
      if (settled) return
      settled = true
      clearTimer(timer)
      try {
        frame.contentWindow.print()
      } catch (err) {
        remove()
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      setTimer(() => { remove(); resolve() }, settleMs)
    }

    // srcdoc before the frame joins the page, so it loads once, with the ticket in it.
    frame.srcdoc = String(html ?? '')
    doc.body.appendChild(frame)
  })
}
