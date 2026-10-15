import fs from 'fs'
import path from 'path'
import { useState } from 'react'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import TillNotice, { noticeLines, TILL_NOTICE_Z } from './TillNotice'
import Modal from '../../../components/Modal'

// Owner decision (2026-10-15 audit): the till's browser pop-ups are an on-screen notice. window.alert
// froze the whole page, so the guest-order chime and every poll stopped until OK was tapped.

function Harness({ initial = null, withDialog = false }) {
  const [notice, setNotice] = useState(initial)
  const show = text => setNotice(prev => ({ id: (prev?.id || 0) + 1, text }))
  return (
    <>
      <button type="button" onClick={() => show("Couldn't load bill 12 to reprint. The connection dropped.\n\nNothing was printed — try again.")}>Reprint</button>
      <button type="button" onClick={() => show("Couldn't read the open orders. Permission denied.\n\nNothing was cleared — the tables were left as they are.")}>Clear</button>
      {withDialog && (
        <Modal title="Recent Bills — Today" onClose={() => {}} zIndex={2100}>
          <button type="button" onClick={() => show('Nothing printed — this browser blocked the print window.')}>Reprint in dialog</button>
        </Modal>
      )}
      <TillNotice notice={notice} onDismiss={() => setNotice(null)} />
    </>
  )
}

describe('TillNotice', () => {
  test('a failure shows the same words on two lines, as an alert, and never calls window.alert', () => {
    const alertSpy = jest.spyOn(window, 'alert').mockImplementation(() => {})
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Reprint' }))
    const bar = screen.getByRole('alert')
    // Two lines, each its own paragraph in the ActionError text style.
    expect(within(bar).getByText("Couldn't load bill 12 to reprint. The connection dropped.")).toHaveClass('action-error-text')
    expect(within(bar).getByText('Nothing was printed — try again.')).toHaveClass('action-error-text')
    expect(alertSpy).not.toHaveBeenCalled()
    alertSpy.mockRestore()
  })

  test('it stays until ✕ is tapped, and ✕ is a named 44px till control', () => {
    jest.useFakeTimers()
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Reprint' }))
    act(() => { jest.advanceTimersByTime(10 * 60 * 1000) }) // no timer takes it down
    jest.useRealTimers()
    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    expect(dismiss).toHaveClass('till-hit')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(dismiss)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  test('a newer notice replaces the older one', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'Reprint' }))
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toHaveTextContent("Couldn't read the open orders.")
    expect(alerts[0]).not.toHaveTextContent('reprint')
  })

  test('it sits on <body> above every dialog and below the guest-order banner', () => {
    render(<Harness withDialog />)
    fireEvent.click(screen.getByRole('button', { name: 'Reprint in dialog' }))
    const bar = screen.getByRole('alert')
    expect(bar.parentElement).toBe(document.body) // eslint-disable-line testing-library/no-node-access
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull()
    expect(TILL_NOTICE_Z).toBeGreaterThan(2100) // Modal callers pass up to 2100; the till layers are 1000
    expect(TILL_NOTICE_Z).toBeLessThan(2500)    // the Quick Calculator, and ArrivalAlert's 3000 above it
    expect(Number(bar.style.zIndex)).toBe(TILL_NOTICE_Z)
    expect(bar.style.position).toBe('fixed')
  })

  test('✕ hands focus back to where it was', () => {
    render(<Harness />)
    const reprint = screen.getByRole('button', { name: 'Reprint' })
    reprint.focus()
    fireEvent.click(reprint)
    const dismiss = screen.getByRole('button', { name: 'Dismiss' })
    dismiss.focus()
    fireEvent.click(dismiss)
    expect(reprint).toHaveFocus()
  })

  test('noticeLines splits on the blank line, either spelling', () => {
    expect(noticeLines('One.\n\nTwo.')).toEqual(['One.', 'Two.'])
    expect(noticeLines('One.\n\n  Two.\n')).toEqual(['One.', 'Two.'])
    expect(noticeLines('Only one.')).toEqual(['Only one.'])
    expect(noticeLines('')).toEqual([])
  })
})

// The till's own files raise no browser pop-up: every refusal goes through showTillNotice. A source
// read, like kitchenWindow.test.js, because the pop-up sites are deep in PosOrders' flows.
describe('the till raises no window.alert', () => {
  const ROOT = path.join(__dirname, '..', '..', '..', '..')
  const stripComments = src => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ')
  const read = file => stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))

  test.each(['src/modules/pos/orders/PosOrders.jsx', 'src/modules/pos/orders/BillingStation.jsx'])('%s', file => {
    const src = read(file)
    expect(src).not.toMatch(/\bwindow\.alert\s*\(/)
    expect(src).not.toMatch(/(^|[^.\w])alert\s*\(/m)
  })

  test('PosOrders renders the notice in all three of its returns', () => {
    const src = read('src/modules/pos/orders/PosOrders.jsx')
    expect(src.match(/\{tillNoticeEl\}/g)).toHaveLength(3)
    expect((src.match(/showTillNotice\(/g) || []).length).toBeGreaterThanOrEqual(15) // every former pop-up site
  })
})
