import { render, screen, act, fireEvent } from '@testing-library/react'
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
    await act(async () => { fireEvent.click(screen.getByText('Delete')) })
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
