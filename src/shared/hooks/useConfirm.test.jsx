import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { useConfirm } from './useConfirm'

// S803: a busy confirm cannot be cancelled, so without an upper bound a run that never answers
// keeps the dialog on screen until a reload. The bound is opt-in per page.
function Harness({ options, run, onTimeoutAsk }) {
  const { ask, confirmEl } = useConfirm(options)
  return (
    <div>
      <button type="button" onClick={() => ask({ title: 'Delete it?', body: 'It goes.', confirmLabel: 'Delete', run, onTimeout: onTimeoutAsk })}>open</button>
      {confirmEl}
    </div>
  )
}

const never = () => new Promise(() => {})

describe('useConfirm time limit', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('releases a stuck dialog after timeoutMs and tells the page', async () => {
    const onTimeout = jest.fn()
    render(<Harness options={{ timeoutMs: 1000, onTimeout }} run={never} />)
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(screen.getByText('Delete'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await act(async () => { jest.advanceTimersByTime(1000) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onTimeout.mock.calls[0][0].title).toBe('Delete it?')
  })

  it('holds the dialog for ever without the option (the default is unchanged)', async () => {
    render(<Harness run={never} />)
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(screen.getByText('Delete'))
    await act(async () => { jest.advanceTimersByTime(120000) })
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('does not call onTimeout for a run that finishes in time', async () => {
    const onTimeout = jest.fn()
    render(<Harness options={{ timeoutMs: 1000, onTimeout }} run={() => Promise.resolve()} />)
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(screen.getByText('Delete'))
    await act(() => Promise.resolve())
    await act(async () => { jest.advanceTimersByTime(5000) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('lets a single ask override the page default', async () => {
    const pageDefault = jest.fn()
    const own = jest.fn()
    render(<Harness options={{ timeoutMs: 1000, onTimeout: pageDefault }} run={never} onTimeoutAsk={own} />)
    fireEvent.click(screen.getByText('open'))
    fireEvent.click(screen.getByText('Delete'))
    await act(async () => { jest.advanceTimersByTime(1000) })
    expect(own).toHaveBeenCalledTimes(1)
    expect(pageDefault).not.toHaveBeenCalled()
  })
})

// S852: Confirm was `disabled` while busy, which dropped the focus of the keyboard user who had just
// pressed it to <body> for as long as the write took. It stays focusable now, marked busy, and a
// second press must not start a second run.
describe('useConfirm while busy', () => {
  it('keeps focus on Confirm, marks it busy, says so, and ignores a second press', async () => {
    const run = jest.fn(never)
    render(<Harness run={run} />)
    fireEvent.click(screen.getByText('open'))
    const confirm = screen.getByRole('button', { name: 'Delete' })
    act(() => { confirm.focus() })
    fireEvent.click(confirm)
    // The run starts on the next microtask.
    await act(() => Promise.resolve())
    expect(run).toHaveBeenCalledTimes(1)
    const busy = screen.getByRole('button', { name: 'Working…' })
    expect(busy).toBe(confirm)
    expect(busy).not.toBeDisabled()
    expect(busy).toHaveAttribute('aria-busy', 'true')
    expect(busy).toHaveAttribute('aria-disabled', 'true')
    expect(busy).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent('Working… Please wait.')
    fireEvent.click(busy)
    await act(() => Promise.resolve())
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('a double press in the same tick still runs once', async () => {
    const run = jest.fn(() => Promise.resolve())
    render(<Harness run={run} />)
    fireEvent.click(screen.getByText('open'))
    const confirm = screen.getByRole('button', { name: 'Delete' })
    // Both presses inside one act, so the second lands before the re-render that would show the
    // dialog busy: this is the case only the run guard can catch.
    act(() => { confirm.click(); confirm.click() })
    await act(() => Promise.resolve())
    expect(run).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
})
