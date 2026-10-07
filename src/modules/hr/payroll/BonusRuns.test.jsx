import { render, screen, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { BonusRunList, NewBonusRunDialog, normName, runStatusChip } from './BonusRuns'

const runs = [
  { name: 'Dashain', bs_month: 6, count: 3, staff: 2, finalized: 3, gross: 30000, tds: 300 },
  { name: 'Tihar', bs_month: 7, count: 2, staff: 2, finalized: 1, gross: 10000, tds: 0 },
]

describe('normName and runStatusChip', () => {
  it('treats case and spaces as one name', () => {
    expect(normName(' Dash ain ')).toBe(normName('dashain'))
  })
  it('names a run by how many of its rows are finalized', () => {
    expect(runStatusChip({ count: 2, finalized: 2 })).toEqual({ label: 'Finalized', cls: 'badge-green' })
    expect(runStatusChip({ count: 2, finalized: 0 }).label).toBe('Draft')
    expect(runStatusChip({ count: 2, finalized: 1 }).label).toBe('Part finalized')
  })
})

describe('BonusRunList', () => {
  it('lists each run with what it paid, and opens one by name', () => {
    const onOpen = jest.fn()
    render(<BonusRunList runs={runs} year={2083} noun="festival allowance" onOpen={onOpen} emptyTitle="none" emptyText="none" />)
    const table = screen.getByRole('table', { name: 'Festival allowances in BS 2083' })
    const row = within(table).getByRole('button', { name: 'Dashain' }).closest('tr')
    expect(row).toHaveTextContent('Ashwin 2083')
    expect(row).toHaveTextContent('29,700') // net = gross − income tax
    expect(row).toHaveTextContent('Finalized')
    fireEvent.click(within(table).getByRole('button', { name: 'Tihar' }))
    expect(onOpen).toHaveBeenCalledWith('Tihar')
  })

  it('says there are none rather than drawing an empty table', () => {
    render(<BonusRunList runs={[]} year={2083} noun="bonus run" onOpen={() => {}} emptyTitle="No bonus runs for BS 2083 yet" emptyText="Press + New bonus run." />)
    expect(screen.getByText('No bonus runs for BS 2083 yet')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

describe('NewBonusRunDialog', () => {
  const setup = (props = {}) => {
    const onContinue = jest.fn()
    render(<NewBonusRunDialog title="New bonus run" runs={runs} year={2083} noun="bonus run" defaultMonth={6}
      nameLabel="Bonus name" monthTip="tip" onClose={() => {}} onContinue={onContinue} {...props} />)
    return onContinue
  }
  const name = () => screen.getByLabelText('Bonus name')

  it('cannot continue without a name', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('opens an existing run rather than starting a second one under the same name', () => {
    const onContinue = setup()
    fireEvent.change(name(), { target: { value: 'Dashain' } })
    expect(screen.getByText(/already exists in BS 2083: Continue opens it/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Open it' }))
    expect(onContinue).toHaveBeenCalledWith({ name: 'Dashain' })
  })

  it('warns about a name that differs only by case or spaces, and offers the existing run', () => {
    const onContinue = setup()
    fireEvent.change(name(), { target: { value: 'dash ain' } })
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('differs from “Dashain” only by capital letters or spaces')
    fireEvent.click(within(alert).getByRole('button', { name: 'Dashain' }))
    expect(onContinue).toHaveBeenCalledWith({ name: 'Dashain' })
  })

  it('names a blank run after the type picked, and hands back the name, month and type', () => {
    const onContinue = setup({ types: [{ id: 't1', name: 'Quarterly Sales' }] })
    fireEvent.change(screen.getByLabelText('Bonus type'), { target: { value: 't1' } })
    expect(name()).toHaveValue('Quarterly Sales')
    fireEvent.change(screen.getByLabelText('Paid in'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(onContinue).toHaveBeenCalledWith({ name: 'Quarterly Sales', month: 8, typeId: 't1' })
  })

  it('says how many runs already exist before a new one is taxed on top of them', () => {
    setup()
    fireEvent.change(name(), { target: { value: 'Year End' } })
    expect(screen.getByText(/2 bonus runs already exist in BS 2083/)).toBeInTheDocument()
  })
})
