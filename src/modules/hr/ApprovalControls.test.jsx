import { render, screen, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { BulkApproveBar, DecisionButtons, decideEach } from './ApprovalControls'

describe('decideEach', () => {
  it('runs one row at a time and names what did not go through', async () => {
    const order = []
    const { done, failed } = await decideEach([1, 2, 3], async n => {
      order.push(`start ${n}`)
      await new Promise(r => setTimeout(r, 5))
      order.push(`end ${n}`)
      return n === 2 ? 'it was decided on another screen first' : true
    })
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3'])
    expect(done).toEqual([1, 3])
    expect(failed).toEqual([{ item: 2, reason: 'it was decided on another screen first' }])
  })

  it('turns a thrown error into a reason instead of stopping the batch', async () => {
    const { done, failed } = await decideEach(['a', 'b'], async x => { if (x === 'a') throw new Error('network down'); return true })
    expect(done).toEqual(['b'])
    expect(failed[0].reason).toBe('network down')
  })
})

describe('BulkApproveBar', () => {
  it('stays out of the way for a queue of one — that is a row button', () => {
    const { container } = render(<BulkApproveBar count={1} noun="claims" onApprove={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('states the count before offering the batch', () => {
    render(<BulkApproveBar count={4} noun="leave requests" detail="9 days" onApprove={() => {}} />)
    expect(screen.getByText(/leave requests waiting/)).toHaveTextContent('4 leave requests waiting · 9 days')
    expect(screen.getByRole('button', { name: 'Approve all 4…' })).toBeInTheDocument()
  })
})

describe('DecisionButtons', () => {
  it('names the person on each button for a screen reader', () => {
    render(<DecisionButtons who="Sita, 3rd Bhadra" onApprove={() => {}} onReject={() => {}} />)
    expect(screen.getByRole('button', { name: 'Approve — Sita, 3rd Bhadra' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject — Sita, 3rd Bhadra' })).toBeInTheDocument()
  })

  // S805: the rule that used to sit in a footnote under the queue is on the button it governs.
  it('describes Approve with approveTip when focused, and adds no tab stop of its own', () => {
    render(<DecisionButtons who="Sita" approveTip="Marks these days on the attendance sheet." onApprove={() => {}} onReject={() => {}} />)
    const approve = screen.getByRole('button', { name: 'Approve — Sita' })
    act(() => { approve.focus() })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Marks these days on the attendance sheet.')
    expect(approve).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('leaves both buttons bare when no tip is given', () => {
    const { container } = render(<DecisionButtons who="Sita" onApprove={() => {}} onReject={() => {}} />)
    expect(container.querySelectorAll('button')).toHaveLength(2)
    expect(container.querySelector('.tip-trigger')).toBeNull()
  })
})
