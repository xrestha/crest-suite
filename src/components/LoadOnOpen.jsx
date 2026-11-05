import { Component, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { reportCrash } from '../shared/monitoring'

// A tool the shell offers on every screen but most sessions never open: the command palette (Ctrl+K)
// and the Quick Calculator (Alt+C). Each comes from its own file instead of the main one every page
// waits for (S876, PERF-8). Not React.lazy, for three reasons each of which it gets wrong here:
//
//   * The first press must open at once. The file is fetched when the browser is first idle after
//     the shell mounts, and the tool is MOUNTED, closed, as soon as it arrives, so Ctrl+K and Alt+C
//     open exactly as they did from the main file. A lazy component suspends on its first render
//     even when its file is already here, so a first press would show nothing for a moment and the
//     keys typed in it would land on the page underneath.
//   * Once mounted it stays mounted. The calculator's tape and position survive a close only because
//     the component does (Calculator.js).
//   * A failed download is a note, not a crash and not a reload. React.lazy keeps a rejection for the
//     life of the page and throws it as a render error, which AppErrorBoundary answers by reloading
//     (chunkReload.js), in the middle of a purchase bill. Here the next open simply tries again.
//
// `label` names the tool as the subject of a sentence ("Page search", "The calculator").

/** One tool's file: fetched once, remembered, and fetched again after a failure. */
export function onDemand(load) {
  let loaded = null
  let pending = null
  return {
    loaded: () => loaded,
    load() {
      if (loaded) return Promise.resolve(loaded)
      if (!pending) {
        pending = load().then(
          m => { loaded = m.default; return loaded },
          err => { pending = null; throw err },
        )
      }
      return pending
    },
  }
}

/** Runs `cb` when the browser is idle (a timer where requestIdleCallback is missing). Returns the
 *  cancel, so it can be an effect's cleanup. */
export function whenIdle(cb) {
  if (typeof window === 'undefined') return () => {}
  if (window.requestIdleCallback) {
    const id = window.requestIdleCallback(cb, { timeout: 5000 })
    return () => window.cancelIdleCallback(id)
  }
  const t = setTimeout(cb, 500)
  return () => clearTimeout(t)
}

// The idle-lock warning's box (Layout.js), at the calculator's height (2500), so it shows above any
// Modal the tool was opened over: the purchase-bill form is where Alt+C is reached for most. Escape
// dismisses the note and only the note, the way it closes only the calculator: capture phase, so it
// runs before a Modal's own Escape listener, which skips a key already handled (Calculator.js).
function ToolNote({ text, onClose }) {
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])
  return createPortal(
    <div role="alert" className="no-print" style={{
      position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 2500,
      display: 'flex', alignItems: 'center', gap: 12,
      background: 'var(--theme-card)', border: '1px solid var(--theme-amber)',
      borderRadius: 'var(--radius-md)', padding: '10px 18px', boxShadow: '0 6px 24px rgba(0,0,0,0.25)',
      fontSize: 13, color: 'var(--theme-text1)', maxWidth: 'calc(100vw - 32px)',
    }}>
      <span>{text}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Dismiss</button>
    </div>,
    document.body
  )
}

// The tools sit outside Layout's page-scope AppErrorBoundary, so a crash in one used to take the
// whole shell down to the app-scope fallback. This keeps it to a note; closing the note clears it,
// and the next open mounts the tool afresh.
class ToolBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { crashed: false }
  }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error(`${this.props.label} crashed:`, error, info)
    // React 19 hands a caught render error to the boundary alone, so this is the only report of it.
    reportCrash(error, info && info.componentStack)
  }

  componentDidUpdate(prevProps) {
    if (this.state.crashed && prevProps.open && !this.props.open) this.setState({ crashed: false })
  }

  render() {
    if (!this.state.crashed) return this.props.children
    if (!this.props.open) return null
    return (
      <ToolNote
        text={`${this.props.label} hit an error and closed. Open it again, or reload the page if this keeps happening.`}
        onClose={this.props.onClose}
      />
    )
  }
}

export default function LoadOnOpen({ tool, label, open, onClose, ...props }) {
  const [Tool, setTool] = useState(() => tool.loaded())
  const [failed, setFailed] = useState(false)

  // Fetched when the browser is first idle, and mounted (closed) on arrival. A failure here says
  // nothing: the first open tries again and speaks for itself.
  useEffect(() => {
    if (Tool) return undefined
    return whenIdle(() => { tool.load().then(T => setTool(() => T), () => {}) })
    // Once, on mount: an open before then fetches on its own, below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount; later opens fetch in the effect below
  }, [])

  // Opened before that file arrived, or after it failed: fetch it now. Every open tries again.
  useEffect(() => {
    if (!open || Tool) return
    setFailed(false)
    tool.load().then(T => setTool(() => T), () => setFailed(true))
  }, [open, Tool, tool])

  if (Tool) {
    return (
      <ToolBoundary label={label} open={open} onClose={onClose}>
        <Tool {...props} open={open} onClose={onClose} />
      </ToolBoundary>
    )
  }
  if (open && failed) {
    return <ToolNote text={`${label} could not load. Check the connection and try again, or reload the page if this keeps happening.`} onClose={onClose} />
  }
  return null
}
