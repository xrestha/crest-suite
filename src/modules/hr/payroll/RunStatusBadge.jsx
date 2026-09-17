// A run's state beside its page title — Payroll, Festival Allowance, Incentives and HR Reports.
//
// Four pages hand-rolled this chip and they had drifted (S768): two squared corners, two
// `--radius-sm`, and Draft in the ACCENT, while Festival Allowance's own per-run list two hundred
// lines lower called the same Draft amber. HR's status vocabulary (payrollConstants.js) is the
// answer: amber is open — something is still required, here a Finalize — and green is closed, good.
export default function RunStatusBadge({ finalized }) {
  return (
    <span className={`badge ${finalized ? 'badge-green' : 'badge-amber'}`} style={{ marginLeft: 8, verticalAlign: 'middle' }}>
      {finalized ? 'Finalized' : 'Draft'}
    </span>
  )
}
