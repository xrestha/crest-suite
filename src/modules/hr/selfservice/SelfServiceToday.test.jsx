import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import SelfServiceToday from './SelfServiceToday'

// SelfServiceToday takes everything as props and fetches nothing, which is what makes this a plain
// render with no mocks at all.
const cell = { bsYear: 2082, bsMonth: 5, bsDay: 6, weekday: 'Sat', ad: new Date(2026, 7, 22) }
const labelFor = (c, mode) => (mode === 'short' ? `${c.weekday} ${c.bsDay}` : `${c.weekday} ${c.bsDay} Bhadra`)

const base = {
  today: { state: 'unknown' },
  next: null,
  swapsForMe: [],
  latestPayslip: null,
  rosterErr: '',
  payslipsErr: '',
  onRetryRoster: () => {},
  onRetryPayslips: () => {},
  labelFor,
  onGo: () => {},
}

const renderToday = props => render(<SelfServiceToday {...base} {...props} />)

describe('SelfServiceToday', () => {
  it('leads with the shift and its times on a working day', () => {
    renderToday({ today: { state: 'working', cell, row: { shift_type_name: 'Morning', shift_start: '07:00', shift_end: '15:00' } } })
    expect(screen.getByText('Morning')).toBeInTheDocument()
    expect(screen.getByText('07:00 – 15:00')).toBeInTheDocument()
    expect(screen.getByText('Sat 6 Bhadra')).toBeInTheDocument()
  })

  it('distinguishes a day off, a day with no shift, and an unpublished month', () => {
    const { rerender } = renderToday({ today: { state: 'off', cell, row: { shift_type_name: 'Day Off' } } })
    expect(screen.getByText('Day off')).toBeInTheDocument()

    rerender(<SelfServiceToday {...base} today={{ state: 'not-scheduled', cell }} />)
    expect(screen.getByText('Not scheduled today')).toBeInTheDocument()

    // The one that matters most: get_my_roster returns only published days, so these two look
    // identical in the data and mean completely different things to someone deciding to come in.
    rerender(<SelfServiceToday {...base} today={{ state: 'unpublished', cell }} />)
    expect(screen.getByText('Not published yet')).toBeInTheDocument()
    expect(screen.queryByText('Not scheduled today')).not.toBeInTheDocument()
  })

  it('shows a failed roster read as an error with a retry, never as an empty day', () => {
    const onRetryRoster = jest.fn()
    renderToday({ rosterErr: "You're offline, or the connection dropped.", today: { state: 'not-scheduled', cell }, onRetryRoster })
    expect(screen.getByRole('alert')).toHaveTextContent(/offline/i)
    expect(screen.queryByText('Not scheduled today')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Try again'))
    expect(onRetryRoster).toHaveBeenCalled()
  })

  it('shows the next working shift, and nothing at all when there is none', () => {
    const { rerender } = renderToday({ next: { cell, row: { shift_type_name: 'Evening', shift_start: '17:00', shift_end: '01:00' } } })
    expect(screen.getByText('Next shift')).toBeInTheDocument()
    expect(screen.getByText(/Evening/)).toBeInTheDocument()

    rerender(<SelfServiceToday {...base} next={null} />)
    expect(screen.queryByText('Next shift')).not.toBeInTheDocument()
  })

  it('surfaces swaps waiting on this employee and names who asked', () => {
    renderToday({ swapsForMe: [{ id: 1, requester_name: 'Ronish Dangol' }, { id: 2, requester_name: 'Sarita B.' }] })
    expect(screen.getByText('2 shift swaps to answer')).toBeInTheDocument()
    expect(screen.getByText('Ronish Dangol, Sarita B.')).toBeInTheDocument()
  })

  it('hides the "needs you" section entirely when nothing is waiting', () => {
    renderToday({ swapsForMe: [] })
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument()
  })

  it('never says "no payslips yet" because a payslip read failed', () => {
    renderToday({ payslipsErr: 'This part of the app isn\'t ready yet.', latestPayslip: null })
    expect(screen.queryByText(/No payslips yet/i)).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/isn't ready yet/i)
  })

  it('taps the payslip card through to the Pay tab', () => {
    const onGo = jest.fn()
    renderToday({ latestPayslip: { label: 'Bhadra 2082', net: '74,250' }, onGo })
    fireEvent.click(screen.getByText('Bhadra 2082'))
    expect(onGo).toHaveBeenCalledWith('pay')
  })
})
