import { monthDeposit } from './monthDeposit'

// S798 PAYROLL-2 / REPORTS-2: the month's deposit is the run's payslips plus the month's finalized
// settlements plus tax on the month's finalized bonuses — the sum HR Reports' SSF Challan and TDS
// Report make, which the approval sheet, the strip and the HR Dashboard now share.
describe('monthDeposit', () => {
  const payslips = [
    { ssf_employee: 1650, ssf_employer: 3000, tds: 0 },
    { ssf_employee: 0, ssf_employer: 0, tds: 250 },
  ]
  const hari = { employee_name: 'Hari', month_ssf_employee: '1277.20', month_ssf_employer: '2322.18', month_tds: '0', lump_tds: '850' }
  const dashain = [{ run: 'Dashain', tds: '300' }, { run: 'Dashain', tds: '120' }, { run: 'Cook of the month', tds: '0' }]

  it('adds a settled leaver and the month’s bonuses to the run', () => {
    const d = monthDeposit({ payslips, settlements: [hari], bonuses: dashain })
    expect(d.ssf).toMatchObject({ payroll: 4650, settlements: 3599.38, total: 8249.38, employee: 2927.2, employer: 5322.18, settledNames: ['Hari'] })
    expect(d.tds).toMatchObject({ payroll: 250, settlements: 850, bonuses: 420, total: 1520, settledNames: ['Hari'] })
    expect(d.tds.bonusRuns).toEqual([{ run: 'Dashain', tds: 420 }])
  })

  it('is the payroll alone when nothing else was paid this month', () => {
    const d = monthDeposit({ payslips })
    expect(d.ssf.total).toBe(4650)
    expect(d.tds.total).toBe(250)
    expect(d.ssf.settledNames).toEqual([])
  })

  // The strip used to say "nothing to deposit — nobody on SSF" when the leaver was the only contributor.
  it('counts a leaver who was the month’s only SSF contributor', () => {
    const d = monthDeposit({ payslips: [{ ssf_employee: 0, ssf_employer: 0, tds: 0 }], settlements: [hari] })
    expect(d.ssf.total).toBe(3599.38)
  })

  it('names nobody for a settlement that deducted no SSF or tax', () => {
    const d = monthDeposit({ settlements: [{ employee_name: 'Sita', month_ssf_employee: 0, month_ssf_employer: 0, month_tds: 0, lump_tds: 0 }] })
    expect(d.ssf.settledNames).toEqual([])
    expect(d.tds.settledNames).toEqual([])
  })
})
