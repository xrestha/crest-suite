import { render, screen, fireEvent } from '@testing-library/react'
import * as XLSX from 'xlsx'
import AttendanceImportModal from './AttendanceImportModal'

const PERIOD = { id: 'p', bs_year: 2083, bs_month: 5 }
const EMPLOYEES = [
  { id: 'e1', full_name: 'Sarita Thapa', employee_code: '' },
  { id: 'e2', full_name: 'Ronish Shrestha', employee_code: '' },
]

// An .xlsx the way a machine writes one. jsdom's File has no arrayBuffer(), so the test gives it one.
function workbookFile(rows, name = 'Monthly Check In&Out.xlsx') {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1')
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  const file = new File([buf], name)
  file.arrayBuffer = async () => buf
  return file
}

function renderModal(props = {}) {
  const onApply = jest.fn()
  render(
    <AttendanceImportModal
      period={PERIOD} periodLabel="Bhadra 2083" employees={EMPLOYEES} records={{}}
      rosterByKey={{ 'e1:2': 'off' }} shiftTypesById={{ off: { id: 'off', name: 'Day Off', hours: 0 } }}
      autoHours={() => ({ hours_worked: 11, ot_hours: 2 })} defaultBreak={45}
      onApply={onApply} onClose={() => {}} {...props}
    />,
  )
  const choose = file => fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [file] } })
  return { onApply, choose }
}

it('takes a machine export through who-is-who and review to the sheet', async () => {
  const { onApply, choose } = renderModal()
  choose(workbookFile([
    ['Monthly Check In&Out Report'],
    ['Time Period: 2083-05-01 - 2083-05-31'],
    ['First Name', 'ID', '05-01', '05-02', '05-03', '05-04', '05-05', '05-06', '05-07'],
    ['sarita', '5', '08:05-20:00', '-', '16:58-None', '11:01-20:09', '11:03-20:03', '11:04-20:05', '11:03-20:00'],
    ['dipen', '2', '-', '-', '11:07-None', '-', '-', '-', '-'],
  ]))

  expect(await screen.findByText(/Who is who/)).toBeInTheDocument()
  expect(screen.getByLabelText('Crest employee for sarita')).toHaveValue('e1')
  const dipen = screen.getByLabelText('Crest employee for dipen')
  expect(dipen).toHaveValue('')
  // Nobody is imported while anyone is undecided.
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  fireEvent.change(dipen, { target: { value: 'skip' } })
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

  expect(await screen.findByText(/Check what will change/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Put 7 days on the sheet' }))
  const changes = onApply.mock.calls[0][0]
  expect(changes.map(c => c.kind).sort()).toEqual(['flagged', 'off', 'worked', 'worked', 'worked', 'worked', 'worked'])
  expect(changes.find(c => c.day === 1).cell).toMatchObject({ start_time: '8:05', end_time: '20:00', break_minutes: 45 })
})

it('asks for the Excel export when given a PDF', async () => {
  const { choose } = renderModal()
  choose(new File(['%PDF'], 'Monthly Check In&Out.pdf'))
  expect(await screen.findByText(/This is a PDF/)).toBeInTheDocument()
})

it('opens the column chooser for a layout it cannot recognise', async () => {
  const { choose } = renderModal()
  choose(workbookFile([['Staff list'], ['Sarita', 'Kitchen'], ['Ronish', 'Floor']]))
  expect(await screen.findByText(/Choose the columns/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Read the file' })).toBeDisabled()
})
