import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import LetterheadButton, { LETTERHEAD_WAIT_TEXT, LETTERHEAD_ERROR_TEXT } from './LetterheadButton'

// S877: an export or print that waits for the letterhead's business name is aria-disabled with a
// press that says why, never a bare `disabled` (page-layout.md, Controls).
describe('LetterheadButton', () => {
  it('while the name is loading: stays pressable, aria-disabled, and a press explains instead of exporting', () => {
    const onClick = jest.fn()
    render(<LetterheadButton ready={false} error={null} onClick={onClick}>Export Excel</LetterheadButton>)
    const button = screen.getByRole('button', { name: 'Export Excel' })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('type', 'button')
    expect(button).toHaveClass('btn', 'btn-ghost')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(LETTERHEAD_WAIT_TEXT)
    expect(status).toHaveClass('no-print')
  })

  it('after a failed read: aria-disabled, and a press says the letterhead would be blank', () => {
    const onClick = jest.fn()
    render(<LetterheadButton ready={false} error={{ code: 'PGRST301', message: 'JWT expired' }} onClick={onClick}>Print</LetterheadButton>)
    const button = screen.getByRole('button', { name: 'Print' })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent(LETTERHEAD_ERROR_TEXT)
  })

  it('an error wins even if ready is somehow true', () => {
    const onClick = jest.fn()
    render(<LetterheadButton ready error={{ message: 'x' }} onClick={onClick}>Print</LetterheadButton>)
    fireEvent.click(screen.getByRole('button', { name: 'Print' }))
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent(LETTERHEAD_ERROR_TEXT)
  })

  it('once ready it is the plain button: no aria-disabled, no status, and a press runs onClick', () => {
    const onClick = jest.fn()
    render(<LetterheadButton ready error={null} onClick={onClick} className="btn btn-primary" style={{ fontSize: 12 }}>Print</LetterheadButton>)
    const button = screen.getByRole('button', { name: 'Print' })
    expect(button).not.toHaveAttribute('aria-disabled')
    expect(button).toHaveClass('btn', 'btn-primary')
    expect(button).toHaveStyle({ fontSize: '12px' })
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('the line goes away when the name arrives, and the next press exports', () => {
    const onClick = jest.fn()
    const { rerender } = render(<LetterheadButton ready={false} error={null} onClick={onClick}>Export Excel</LetterheadButton>)
    fireEvent.click(screen.getByRole('button', { name: 'Export Excel' }))
    expect(screen.getByRole('status')).toBeInTheDocument()

    rerender(<LetterheadButton ready error={null} onClick={onClick}>Export Excel</LetterheadButton>)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Export Excel' })
    expect(button).not.toHaveAttribute('aria-disabled')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('a page reason on `disabled` is left exactly as it was, with no aria-disabled on top', () => {
    const onClick = jest.fn()
    render(<LetterheadButton ready={false} error={null} disabled onClick={onClick}>Export Excel</LetterheadButton>)
    const button = screen.getByRole('button', { name: 'Export Excel' })
    expect(button).toBeDisabled()
    expect(button).not.toHaveAttribute('aria-disabled')
    fireEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('tip puts the Tip around the inner button, so it adds no tab stop of its own', () => {
    render(<LetterheadButton ready={false} error={null} tip="Exports the view." onClick={() => {}}>Export Excel</LetterheadButton>)
    const button = screen.getByRole('button', { name: 'Export Excel' })
    fireEvent.focus(button)
    // Tip describes the BUTTON only when the button is its host; around a component it would put
    // a focusable span of its own in front and describe that instead.
    const tooltip = screen.getByRole('tooltip')
    expect(tooltip).toHaveTextContent('Exports the view.')
    expect(button.getAttribute('aria-describedby')).toContain(tooltip.id)
    fireEvent.click(button)
    expect(screen.getByRole('status')).toHaveTextContent(LETTERHEAD_WAIT_TEXT)
  })

  it('a ready button that the page disables stays disabled', () => {
    render(<LetterheadButton ready error={null} disabled onClick={() => {}}>Export Excel</LetterheadButton>)
    expect(screen.getByRole('button', { name: 'Export Excel' })).toBeDisabled()
  })
})
