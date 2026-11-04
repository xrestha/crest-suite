import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import ReportLoadError from './ReportLoadError'

// The could-not-load card (S612) and its Try again (S863, wired across the report pages in S876).
// The card takes everything as props and reads nothing, so these are plain renders.
const dropped = { message: 'TypeError: Failed to fetch' }
const timedOut = { name: 'TimeoutError', message: 'Loading the report timed out after 20s' }

describe('ReportLoadError', () => {
  it('offers Try again when given onRetry, and the press calls it', () => {
    const onRetry = jest.fn()
    render(<ReportLoadError error={dropped} onRetry={onRetry} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this report')
    expect(screen.getByText(/Try again, and if it keeps happening/)).toBeInTheDocument()
    expect(screen.queryByText(/Reload the page/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('without onRetry says to reload the page and shows no button', () => {
    render(<ReportLoadError error={dropped} />)
    expect(screen.getByText(/Reload the page, and if it keeps happening/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('keeps the technical detail as fine print either way', () => {
    render(<ReportLoadError error={{ code: '42501', message: 'permission denied for table items' }} onRetry={() => {}} />)
    expect(screen.getByText('42501 · permission denied for table items')).toBeInTheDocument()
  })

  it('words a timed-out read for a reload when there is no retry', () => {
    render(<ReportLoadError error={timedOut} />)
    expect(screen.getByText(/took too long to answer, so this report could not be read/)).toHaveTextContent(/then reload the page\.$/)
    expect(screen.queryByText(/then try again\./)).not.toBeInTheDocument()
  })

  it('words a timed-out read for Try again when there is one', () => {
    render(<ReportLoadError error={timedOut} onRetry={() => {}} />)
    expect(screen.getByText(/took too long to answer, so this report could not be read/)).toHaveTextContent(/then try again\.$/)
    expect(screen.queryByText(/then reload the page\./)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
