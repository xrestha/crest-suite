import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import Tabs from '../../../components/Tabs'
import Modal from '../../../components/Modal'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { errorLine } from '../../../shared/errorText'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { useIsOwnEmployee } from '../ownRecord'
import { BS_MONTHS, formatAd } from '../../../utils/bsCalendar'
import { changedEmployeeFields, newEmployeePayload, endDateHasPassed, endsBeforeJoining, rehireNeedsNewJoinDate, staleRehireEndDate, PAY_HISTORY_LABELS, OFF_PAYROLL_STATUSES, NOT_SAVED_RLS } from './employeeFormData'

// The fields THIS form owns. Pay basis, basic salary, bank and SSF are not here on purpose: Pay
// Setup owns them, and until S748 this form carried them anyway (spread in from the loaded row) and
// wrote them back on every save — so an Employees save undid a Pay Setup raise, a Final Settlement's
// status/end date, or a login block made in another tab. `changedEmployeeFields` now sends only what
// the user actually changed.
const EMPTY = {
  employee_code: '',
  full_name: '',
  gender: '',
  date_of_birth: '',
  pan_no: '',
  citizenship_no: '',
  designation: '',
  department: '',
  employment_type: 'permanent',
  join_date: '',
  end_date: '',
  status: 'active',
  phone: '',
  email: '',
  address: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  notes: '',
  // Reporting & lifecycle
  supervisor_id: '',
  retirement_date: '',
  // Family
  marital_status: '',
  spouse_name: '',
  father_name: '',
  mother_name: '',
  grandfather_name: '',
  children_count: '',
  nominee_name: '',
  nominee_relationship: '',
  nominee_contact: '',
  // Permanent address (Nepal: Province → District → Municipality/VDC → Ward → Tole)
  perm_province: '',
  perm_district: '',
  perm_municipality: '',
  perm_ward: '',
  perm_tole: '',
  // Current / temporary address
  same_as_permanent: false,
  temp_province: '',
  temp_district: '',
  temp_municipality: '',
  temp_ward: '',
  temp_tole: '',
}

const TABS = [
  { key: 'personal',   label: 'Personal'   },
  { key: 'employment', label: 'Employment' },
  { key: 'address',    label: 'Address'    },
  { key: 'family',     label: 'Family'     },
]

const PROVINCES = ['Koshi', 'Madhesh', 'Bagmati', 'Gandaki', 'Lumbini', 'Karnali', 'Sudurpashchim']
const MARITAL    = ['single', 'married', 'divorced', 'widowed']
const NOMINEE_RELATIONS = ['Spouse', 'Father', 'Mother', 'Son', 'Daughter', 'Brother', 'Sister', 'Other']

// `inp` used to live here — a hand-rolled copy of `.form-input` on 33 controls, including a
// `borderRadius: 6` that was off the closed radius scale of the day. Replaced with the real classes
// 2026-08-23/S603, which also wins these fields the `[aria-invalid]` and `:disabled` hooks and the
// coarse-pointer 16px floor, none of which can reach an inline style.
const lbl = { fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4, display: 'block', letterSpacing: '0.02em' }
const row = { display: 'flex', gap: 12 }
const col = { flex: 1, display: 'flex', flexDirection: 'column' }

export default function EmployeeForm({ clientId, employee, onSave, onClose }) {
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const isEdit = !!employee
  // Your own record's email is the Owner's to change (S798 3a, H2): it is one of the two links that
  // make the record yours, so changing it would lift the own-pay rule (hr_own_pay refuses it).
  const isOwnEmployee = useIsOwnEmployee(useMemo(() => (employee ? { [employee.id]: employee } : {}), [employee]))
  const isOwnRecord = isEdit && isOwnEmployee(employee.id)
  const [tab, setTab]         = useState('personal')
  // Only the fields this form owns are copied in — see EMPTY above. `?? ''` keeps a NULL column a
  // controlled input instead of flipping it to uncontrolled.
  const [form, setForm]       = useState(() => (isEdit
    ? Object.fromEntries(Object.keys(EMPTY).map(k => [k, employee[k] ?? EMPTY[k]]))
    : { ...EMPTY }))
  const [supervisors, setSupervisors] = useState([])
  const [supervisorErr, setSupervisorErr] = useState('')
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')
  // The last working day of a FINALIZED Final Settlement for this employee (S791), so taking a
  // settled leaver back onto payroll asks for a new join date. undefined = not read yet; an
  // { error } refuses that one move rather than letting it through unchecked.
  const [settledLastDay, setSettledLastDay] = useState(undefined)
  // A Final Settlement reopened as a draft, and the finalized payroll months that left this person out
  // because it was paying them (S798 3b, H5). null = none to report; { months } or { error }.
  const [reopenedSkip, setReopenedSkip] = useState(null)
  // Keyed by field, not one string for the whole form. This form already KNEW which field had
  // failed — it switched tab to reveal it — and then reported the fact as prose the box itself
  // never carried, so a screen-reader user was told a save failed and never told by what (S603).
  const [fieldErr, setFieldErr] = useState({})

  // Employees available as reporting supervisors (excluding self). Active AND probation — a new
  // shift lead on probation is a real supervisor. The CURRENT supervisor is kept in the list even
  // after they have left, labelled, because a <select> whose value matches no option renders its
  // first option: the form showed "— None —" for a supervisor who was still on the record.
  useEffect(() => {
    if (!clientId) return
    let live = true
    const currentSup = employee?.supervisor_id
    scopedFrom('hr_employees', 'id, full_name, designation, status')
      .order('full_name')
      .then(({ data, error: readErr }) => {
        if (!live) return
        if (readErr) { setSupervisorErr(errorLine(readErr)); return }
        setSupervisorErr('')
        setSupervisors((data || []).filter(e =>
          e.id !== employee?.id && (e.status === 'active' || e.status === 'probation' || e.id === currentSup)))
      })
    return () => { live = false }
  }, [clientId, employee?.id, employee?.supervisor_id, scopedFrom])

  useEffect(() => {
    if (!isEdit || !employee?.id) return
    let live = true
    scopedFrom('hr_final_settlements', 'last_working_date')
      .eq('employee_id', employee.id).eq('status', 'finalized')
      .order('last_working_date', { ascending: false }).limit(1)
      .then(({ data, error: readErr }) => {
        if (!live) return
        setSettledLastDay(readErr ? { error: readErr } : (data?.[0]?.last_working_date || null))
      })
    return () => { live = false }
  }, [isEdit, employee?.id, scopedFrom])

  // Reopening a settlement leaves the person marked as left. Set back on payroll, they are paid from
  // the next payroll on, but a month already finalized without them stays unpaid until that payroll
  // is reopened and regenerated (S798 3b, GAP-PAY-STATE-4).
  useEffect(() => {
    if (!isEdit || !employee?.id) return
    let live = true
    ;(async () => {
      const { data, error: readErr } = await scopedFrom('hr_final_settlements', 'id, last_working_date')
        .eq('employee_id', employee.id).eq('status', 'draft').not('reopened_at', 'is', null)
        .order('last_working_date', { ascending: false }).limit(1)
      if (!live) return
      if (readErr) { setReopenedSkip({ error: readErr }); return }
      const row = data?.[0]
      if (!row) { setReopenedSkip(null); return }
      const res = await supabase.rpc('settlement_skipped_payroll_months', { p_employee_id: employee.id, p_last_working_date: row.last_working_date })
      if (!live) return
      setReopenedSkip(res.error ? { error: res.error } : { months: res.data || [] })
    })()
    return () => { live = false }
  }, [isEdit, employee?.id, scopedFrom])

  // A settled leaver taken back gets the staff logins their settlement blocked (S798 3b, H21), on every
  // save that leaves them on payroll after the settled last day, so a failed call is retried by saving
  // again. Returns { tone, text } for the list, or null when there was nothing to unblock.
  async function unblockRehiredLogins(savedStatus, savedJoin) {
    if (!isEdit || typeof settledLastDay !== 'string') return null
    if (!['active', 'probation'].includes(savedStatus) || !savedJoin || savedJoin <= settledLastDay) return null
    const { data, error: rpcErr } = await supabase.rpc('hr_unblock_rehired_logins', { p_employee_id: employee.id })
    const who = employee.full_name || 'This employee'
    if (rpcErr) {
      return { tone: 'warn', text: `${who} was saved, but the staff logins their Final Settlement blocked could not be unblocked, so they still cannot sign in. Open the record and save it again to retry. ${errorLine(rpcErr)}` }
    }
    const done = (data || []).filter(l => l.unblocked)
    const kept = (data || []).filter(l => !l.unblocked)
    if (done.length === 0 && kept.length === 0) return null
    const names = list => list.map(l => `${l.full_name} (${l.modules})`).join(', ')
    const parts = []
    if (done.length) parts.push(`${names(done)} ${done.length === 1 ? 'was' : 'were'} blocked when ${who} left and can sign in again.`)
    if (kept.length) parts.push(`${names(kept)} ${kept.length === 1 ? 'is an HR Manager login, which stays' : 'are HR Manager logins, which stay'} blocked until the Owner saves this record.`)
    return { tone: kept.length ? 'warn' : 'ok', text: parts.join(' ') }
  }

  // Taking a settled leaver back onto payroll is a rehire (S791). Returns the message to show, or ''.
  // Checked only when the move is being made — status becoming Active/Probation, or the join date
  // changing — so an unrelated edit of anyone is never held up by it.
  function rehireProblem(nextStatus, nextJoin) {
    const onPayroll = nextStatus === 'active' || nextStatus === 'probation'
    const moving = !isEdit || nextStatus !== employee.status || String(nextJoin || '') !== String(employee.join_date || '')
    if (!isEdit || !onPayroll || !moving) return ''
    if (settledLastDay === undefined) return 'Still checking whether this employee has a finalized Final Settlement — try again in a moment.'
    if (settledLastDay?.error) return 'Could not check whether this employee has a finalized Final Settlement, so they were not put back on payroll. Try again. ' + errorLine(settledLastDay.error)
    const last = rehireNeedsNewJoinDate({ settledLastDay, joinDate: nextJoin, status: nextStatus })
    if (!last) return ''
    return `${employee.full_name} left in a finalized Final Settlement (last working day ${last}), which already paid their last month. ` +
      'To take them back, set a Join Date after that day — the rehire is a new employment and is paid from then; ' +
      'saving also clears the old End Date. If the settlement was a mistake, reopen it in Final Settlement instead.'
  }

  // The old employment's End Date, which this save clears (S798 H27) — shown under the dates before
  // Save, so the change is said rather than made quietly.
  const staleEnd = staleRehireEndDate({ settledLastDay, joinDate: form.join_date, endDate: form.end_date, status: form.status })

  // Editing a field clears its own error. Leaving a red border under a box the user has just
  // corrected teaches them the message is stale and worth ignoring, which is how a real one gets
  // scrolled past.
  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }))
    setFieldErr(e => (e[field] ? { ...e, [field]: '' } : e))
  }

  // Suggest retirement date = date of birth + 60 years (SSF pension age in Nepal).
  function calcRetirement() {
    if (!form.date_of_birth) return
    const d = new Date(form.date_of_birth)
    d.setFullYear(d.getFullYear() + 60)
    set('retirement_date', d.toISOString().slice(0, 10))
  }

  async function handleSave() {
    const fe = {}
    if (!form.full_name.trim()) fe.full_name = 'Full name is required.'
    if (!form.join_date)        fe.join_date = 'Join date is required.'
    setFieldErr(fe)
    if (fe.full_name || fe.join_date) {
      // Switch to the tab holding the FIRST failure, so the field carrying the message is the one
      // on screen — the message is useless on a tab the user cannot see.
      setTab(fe.full_name ? 'personal' : 'employment')
      return
    }
    const rehire = rehireProblem(form.status, form.join_date)
    if (rehire) {
      setFieldErr({ join_date: rehire })
      setTab('employment')
      return
    }
    // A rehire's old End Date goes in the same save (H27); then no End Date may precede the Join Date.
    const toSave = staleEnd ? { ...form, end_date: '' } : form
    if (endsBeforeJoining(toSave.join_date, toSave.end_date)) {
      setFieldErr({ end_date: 'The End Date is before the Join Date. Payroll would pay nothing for this employment — clear the End Date, or correct one of the two.' })
      setTab('employment')
      return
    }
    setError('')
    setSaving(true)

    const keys = Object.keys(EMPTY)
    if (isEdit) {
      const patch = changedEmployeeFields(employee, toSave, keys)
      if (Object.keys(patch).length > 0) {
        const { data: savedRows, error: err } = await scopedUpdate('hr_employees', patch).eq('id', employee.id).select('id')
        if (err) { setError('The changes were not saved. ' + errorLine(err)); setSaving(false); return }
        // A write RLS refuses is 0 rows and no error; writes here need HR manager rank (S798).
        if (!savedRows?.length) { setError('The changes were not saved. ' + NOT_SAVED_RLS); setSaving(false); return }
      }
    } else {
      const { error: err } = await scopedInsert('hr_employees', newEmployeePayload(toSave, keys))
      if (err) { setError('The employee was not added. ' + errorLine(err)); setSaving(false); return }
    }

    const notice = await unblockRehiredLogins(toSave.status, toSave.join_date)
    setSaving(false)
    onSave(notice)
  }

  // Deactivate takes someone off every payroll picker, and that is the consequence the old
  // "Mark X as inactive?" box never named: a mid-month leaver deactivated BEFORE their Final
  // Settlement can no longer be settled at all, because Final Settlement lists active/probation
  // staff only. It also does not block their Self-Service login — a different control, on the list.
  function handleDeactivate() {
    askConfirm({
      title: `Deactivate ${employee.full_name}?`,
      confirmLabel: 'Deactivate', danger: true, busyLabel: 'Saving…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            They come off Final Settlement, the Roster and Attendance{employee.end_date ? ', and off payroll after their End Date' : ''}. Their
            record and pay history are kept, and Activate brings them back.
          </p>
          <p style={{ margin: '0 0 8px' }}>
            <strong>If they are leaving, run Final Settlement first</strong> — once inactive they no longer appear there.
          </p>
          {/* S798 3e (PAYROLL-1, H9 (a)): with no End Date nothing says how far to pay them, so Payroll
              stops and names them rather than paying their days in this month to nobody. */}
          {!employee.end_date && (
            <p style={{ margin: '0 0 8px' }}>
              <strong>They have no End Date.</strong> If they worked any part of this month, Edit and enter their last working day
              first: payroll pays them up to it. Without one, Payroll names them and will not finalize until it is entered.
            </p>
          )}
          <p style={{ margin: 0 }}>This does not block their Self-Service login; use Deactivate (block login) on the Employees list for that.</p>
        </>
      ),
      run: async () => {
        const { data: savedRows, error: err } = await scopedUpdate('hr_employees', { status: 'inactive' }).eq('id', employee.id).select('id')
        if (err) { setError(`${employee.full_name} is still ${employee.status} — the change was not saved. ` + errorLine(err)); return }
        if (!savedRows?.length) { setError(`${employee.full_name} is still ${employee.status} — the change was not saved. ` + NOT_SAVED_RLS); return }
        onSave()
      },
    })
  }

  async function handleActivate() {
    const rehire = rehireProblem('active', employee.join_date)
    if (rehire) { setError(rehire); return }
    if (!window.confirm(`Reactivate ${employee.full_name}? They return to payroll, the Roster and Attendance.`)) return
    const { data: savedRows, error: err } = await scopedUpdate('hr_employees', { status: 'active' }).eq('id', employee.id).select('id')
    if (err) { setError(`${employee.full_name} is still inactive — the change was not saved. ` + errorLine(err)); return }
    if (!savedRows?.length) { setError(`${employee.full_name} is still inactive — the change was not saved. ` + NOT_SAVED_RLS); return }
    onSave(await unblockRehiredLogins('active', employee.join_date))
  }

  // Most HR tables cascade from hr_employees, but three deliberately do not: hr_tada_claims,
  // hr_incentives and hr_shift_swap_requests hold financial/approval history that should not
  // vanish silently with an employee record. Deleting anyone who has any of them therefore hit a
  // raw Postgres foreign-key error ("violates foreign key constraint ...") shown verbatim in the
  // form — accurate, unreadable, and with no hint that Deactivate is what the user actually
  // wanted. Checking first lets the block be explained in the user's own terms.
  //
  // The pre-check runs FIRST, then one ConfirmModal carries the consequence. It used to be two
  // native confirms in a row ("Delete?" then "Are you sure?") — a doubled window.confirm is the
  // tell that the box could not carry what deleting actually does (S682). A failed count is a
  // check that did not run, so it refuses rather than treating null as zero.
  //
  // S748: an employee with PAY HISTORY — finalized payslips, a finalized Final Settlement, finalized
  // festival allowances, any advance — or a Self-Service login is refused outright, by the database
  // (hr_employees_guard_delete) as well as here. Those five cascade from hr_employees, so a delete
  // used to take the records the TDS certificate and SSF challan are built from; and the login
  // survived its employee (hr_employee_id is SET NULL) with a PIN that kept working. The page asks
  // first only so it can say which; the trigger is the guard.
  async function handleDelete() {
    setError('')

    const checks = await Promise.all([
      supabase.rpc('employee_pay_history', { p_ids: [employee.id] }),
      scopedFrom('hr_tada_claims', 'id', { count: 'exact', head: true }).eq('employee_id', employee.id),
      scopedFrom('hr_incentives', 'id', { count: 'exact', head: true }).eq('employee_id', employee.id),
      scopedFrom('hr_shift_swap_requests', 'id', { count: 'exact', head: true }).eq('requester_employee_id', employee.id),
      scopedFrom('hr_shift_swap_requests', 'id', { count: 'exact', head: true }).eq('target_employee_id', employee.id),
    ])
    const checkFailed = checks.find(r => r && r.error)
    if (checkFailed) {
      setError(`Could not check ${employee.full_name}'s pay history and linked records, so nothing was deleted. Try again. ` + errorLine(checkFailed.error))
      return
    }
    const [{ data: history }, { count: tadaCount }, { count: incentiveCount }, { count: swapReqCount }, { count: swapTgtCount }] = checks
    const swapCount = (swapReqCount || 0) + (swapTgtCount || 0)
    const blockers = [
      ...(history || []).map(h => PAY_HISTORY_LABELS[h.ref_kind] || h.ref_kind),
      tadaCount      ? `${tadaCount} TADA claim${tadaCount === 1 ? '' : 's'}` : '',
      incentiveCount ? `${incentiveCount} incentive/bonus record${incentiveCount === 1 ? '' : 's'}` : '',
      swapCount      ? `${swapCount} shift-swap request${swapCount === 1 ? '' : 's'}` : '',
    ].filter(Boolean)

    if (blockers.length > 0) {
      const loginOnly = blockers.length === 1 && (history || []).some(h => h.ref_kind === 'self_service_login')
      setError(loginOnly
        ? `${employee.full_name} still has a Self-Service login. Remove it from the Employees list first — deleting the employee would leave that PIN able to sign in.`
        : `${employee.full_name} can't be deleted — they have ${blockers.join(', ')} on record. ` +
          'That history covers money paid and approvals given, so it is kept. Use Deactivate instead: it takes them off payroll, the Roster and Attendance and keeps the record.')
      return
    }

    askConfirm({
      title: `Delete ${employee.full_name}?`,
      confirmLabel: 'Delete Employee', danger: true, busyLabel: 'Deleting…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            {employee.full_name} has no finalized pay, no advances and no Self-Service login, so the record can go. Their
            attendance, leave requests, roster shifts, overtime entries, salary setup and any draft payslip go with it.
          </p>
          <p style={{ margin: 0 }}>This cannot be undone. To keep the record, use Deactivate instead.</p>
        </>
      ),
      run: async () => {
        const { data: deletedRows, error: err } = await scopedDelete('hr_employees').eq('id', employee.id).select('id')
        if (!err && !deletedRows?.length) {
          // A delete RLS refuses is 0 rows and no error, which used to close the form as if it had gone.
          setError(`${employee.full_name} was not deleted — the record is unchanged. ` + NOT_SAVED_RLS)
          return
        }
        if (err) {
          // Backstops: a pay record or login that appeared after the check above (the trigger), or a
          // table added later with a non-cascading FK. Add either to the pre-check when it happens.
          const history = String(err.message || '').includes('employee_has_pay_history')
          setError(history
            ? `${employee.full_name} was not deleted — they now have pay history or a Self-Service login on record. Use Deactivate instead.`
            : err.code === '23503'
              ? `${employee.full_name} still has linked records elsewhere in HR and can't be deleted. Use Deactivate instead.`
              : `${employee.full_name} was not deleted — the record is unchanged. ` + errorLine(err))
          return
        }
        onSave()
      },
    })
  }

  return (
    <Modal
      onClose={onClose}
      maxWidth={560}
      title={isEdit ? `Edit — ${employee.full_name}` : 'Add Employee'}
    >
      <div>

        {/* Header */}
        <div style={{ borderBottom: '1px solid var(--theme-border)', marginBottom: 20 }}>
          <Tabs idBase="emp-form" label="Employee record sections" tabs={TABS} active={tab} onChange={setTab} style={{ marginBottom: 0 }} />
        </div>

        {/* Body */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* ── PERSONAL ── */}
          {tab === 'personal' && <>
            <div style={col}>
              <label style={lbl} htmlFor="emp-code">
                <Tip text="Optional short reference shown on payroll, attendance and reports (e.g. EMP-001). Nothing is generated if you leave it blank." width={240}>Employee Code</Tip>
              </label>
              <input id="emp-code" className="form-input" placeholder="EMP-001 (optional)" value={form.employee_code} onChange={e => set('employee_code', e.target.value)} />
            </div>
            <div style={col}>
              <label style={lbl} htmlFor="emp-full-name">Full Name <span style={{ color: 'var(--theme-red-text)' }}>*</span></label>
              <input id="emp-full-name" className="form-input" placeholder="As per citizenship / PAN" value={form.full_name} onChange={e => set('full_name', e.target.value)} {...fieldAria('emp-full-name', fieldErr.full_name)} />
              <FieldError id="emp-full-name" message={fieldErr.full_name} />
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl} htmlFor="emp-gender">Gender</label>
                <select id="emp-gender" className="form-select" style={{ width: '100%' }} value={form.gender} onChange={e => set('gender', e.target.value)}>
                  <option value="">Select</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div style={col}>
                <label style={lbl} htmlFor="emp-dob">
                  <Tip text="Date of birth in BS. Used for age and retirement calculations." width={220}>Date of Birth</Tip>
                </label>
                <BsCalendarPicker id="emp-dob" value={form.date_of_birth} onChange={v => set('date_of_birth', v)} placeholder="Pick DOB" clearable />
              </div>
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl} htmlFor="emp-pan">
                  <Tip text="PAN number from IRD. Printed on the employee's TDS certificate and in HR Reports." width={220}>PAN No.</Tip>
                </label>
                <input id="emp-pan" className="form-input" placeholder="9-digit PAN" value={form.pan_no} onChange={e => set('pan_no', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl} htmlFor="emp-nid">National Identity No.</label>
                <input id="emp-nid" className="form-input" placeholder="NID / Citizenship No." value={form.citizenship_no} onChange={e => set('citizenship_no', e.target.value)} />
              </div>
            </div>
            <div style={col}>
              <label style={lbl} htmlFor="emp-phone">Phone</label>
              <input id="emp-phone" className="form-input" placeholder="98XXXXXXXX" value={form.phone} onChange={e => set('phone', e.target.value)} />
            </div>
            <div style={col}>
              <label style={lbl} htmlFor="emp-email">
                {isOwnRecord
                  ? <Tip text="This is your own record. Its email is what links your login to it, so only the Owner can change it." width={260}>Email</Tip>
                  : 'Email'}
              </label>
              <input id="emp-email" type="email" className="form-input" placeholder="employee@email.com" value={form.email} onChange={e => set('email', e.target.value)} disabled={isOwnRecord} />
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl} htmlFor="emp-emergency-name">Emergency Contact Name</label>
                <input id="emp-emergency-name" className="form-input" placeholder="Name" value={form.emergency_contact_name} onChange={e => set('emergency_contact_name', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl} htmlFor="emp-emergency-phone">Emergency Contact Phone</label>
                <input id="emp-emergency-phone" className="form-input" placeholder="98XXXXXXXX" value={form.emergency_contact_phone} onChange={e => set('emergency_contact_phone', e.target.value)} />
              </div>
            </div>
          </>}

          {/* ── EMPLOYMENT ── */}
          {tab === 'employment' && <>
            <div style={row}>
              <div style={col}>
                <label style={lbl} htmlFor="emp-designation">Designation</label>
                <input id="emp-designation" className="form-input" placeholder="e.g. Head Chef, Cashier" value={form.designation} onChange={e => set('designation', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl} htmlFor="emp-department">Department</label>
                <input id="emp-department" className="form-input" placeholder="e.g. Kitchen, FOH, Admin" value={form.department} onChange={e => set('department', e.target.value)} />
              </div>
            </div>
            <div style={col}>
              <label style={lbl} htmlFor="emp-employment-type">
                <Tip text="Permanent — no end date. Probation — first 3–6 months. Contract — a defined end date. Part-time — reduced hours. How someone is PAID (monthly, daily or hourly) is set separately, in Pay Setup." width={280}>Employment Type</Tip>
              </label>
              <select id="emp-employment-type" className="form-select" style={{ width: '100%' }} value={form.employment_type} onChange={e => set('employment_type', e.target.value)}>
                <option value="permanent">Permanent</option>
                <option value="probation">Probation</option>
                <option value="contract">Contract</option>
                <option value="part_time">Part-time</option>
              </select>
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl} htmlFor="emp-join-date">Join Date <span style={{ color: 'var(--theme-red-text)' }}>*</span></label>
                <BsCalendarPicker id="emp-join-date" value={form.join_date} onChange={v => set('join_date', v)} placeholder="Pick join date" invalid={fieldErr.join_date} />
                <FieldError id="emp-join-date" message={fieldErr.join_date} />
              </div>
              {/* Shown for a contract/part-time type AND whenever a date is already set. It used to
                  hide on any other type while the value stayed saved, and payroll pays a monthly
                  employee nothing after end_date — so a contract hire switched to Permanent kept a
                  date nobody could see or clear, and their pay stopped at it (S748). */}
              {/* Also for every off-payroll status (S798 3e, H9 (a)): a leaver's last working day is how payroll
                  knows how far to pay them, and the box used to be hidden for a permanent employee with none. */}
              {(form.employment_type === 'contract' || form.employment_type === 'part_time' || !!form.end_date || OFF_PAYROLL_STATUSES.has(form.status)) && (
                <div style={col}>
                  <label style={lbl} htmlFor="emp-end-date">
                    <Tip text="The last day this employee is paid for. Payroll pays nothing for days after it. Final Settlement sets it when someone leaves; clear it if they are still working." width={280}>
                      {form.employment_type === 'contract' || form.employment_type === 'part_time' ? 'Contract End Date' : 'End Date'}
                    </Tip>
                  </label>
                  <BsCalendarPicker id="emp-end-date" value={form.end_date} onChange={v => set('end_date', v)} placeholder="Pick end date" clearable invalid={fieldErr.end_date} />
                  <FieldError id="emp-end-date" message={fieldErr.end_date} />
                  {OFF_PAYROLL_STATUSES.has(form.status) && !form.end_date && !fieldErr.end_date && (
                    <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 4, lineHeight: 1.5 }}>
                      △ Enter the last day they worked. Payroll pays them up to it; left blank, Payroll names them and waits.
                    </span>
                  )}
                </div>
              )}
            </div>
            {staleEnd && (
              <div role="status" className="note-banner" style={{ fontSize: 12, lineHeight: 1.5 }}>
                <strong>Saving clears the End Date ({staleEnd}).</strong> It is the last day of {form.full_name.trim() || 'this employee'}'s earlier
                employment, from their Final Settlement. Kept, payroll would leave them out of every month from the new Join Date.
              </div>
            )}
            {['active', 'probation'].includes(form.status) && reopenedSkip?.months?.length > 0 && (
              <div role="alert" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--theme-amber-text)', padding: '8px 12px', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)' }}>
                △ Payroll for {reopenedSkip.months.map(m => `${BS_MONTHS[m.bs_month - 1]} ${m.bs_year}`).join(', ')} was finalized without {form.full_name.trim() || 'this employee'},
                {' '}because their reopened Final Settlement was paying it. Putting them back on payroll does not pay that month: reopen that payroll
                {' '}and Regenerate so they are paid there. If they are leaving after all, finalize the settlement again instead.
              </div>
            )}
            {['active', 'probation'].includes(form.status) && reopenedSkip?.error && (
              <div role="status" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--theme-amber-text)' }}>
                △ Could not check whether a reopened Final Settlement left a payroll month unpaid. {errorLine(reopenedSkip.error)}
              </div>
            )}
            {!staleEnd && endDateHasPassed(form.end_date, form.status, formatAd(new Date())) && (
              <div role="alert" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--theme-amber-text)', padding: '8px 12px', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)' }}>
                ⚠ This end date has passed, but {form.full_name.trim() || 'this employee'} is still on payroll — payroll pays them nothing after it. Clear the date if they are still working.
              </div>
            )}
            <div style={col}>
              <label style={lbl} htmlFor="emp-status">Status</label>
              <select id="emp-status" className="form-select" style={{ width: '100%' }} value={form.status} onChange={e => set('status', e.target.value)}>
                <option value="active">Active</option>
                <option value="probation">Probation</option>
                <option value="inactive">Inactive</option>
                <option value="resigned">Resigned</option>
                <option value="terminated">Terminated</option>
              </select>
              {OFF_PAYROLL_STATUSES.has(form.status) && form.status !== (employee?.status ?? 'active') && (
                <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 4, lineHeight: 1.5 }}>
                  Saving takes {form.full_name.trim() || 'this employee'} off Final Settlement{form.end_date ? ', and off payroll after the End Date' : ''}. If they are leaving, run Final Settlement first — it sets this and the End Date for you.
                  {!form.end_date && ' Otherwise enter their last working day as the End Date, so payroll pays the days they worked.'}
                </span>
              )}
            </div>
            <div style={col}>
              <label style={lbl} htmlFor="emp-supervisor">
                <Tip text="The person this employee reports to. Active and probation employees are listed; a current supervisor who has since left stays selected, marked as such." width={260}>Reporting Supervisor</Tip>
              </label>
              <select id="emp-supervisor" className="form-select" style={{ width: '100%' }} value={form.supervisor_id || ''} onChange={e => set('supervisor_id', e.target.value)}>
                <option value="">— None —</option>
                {supervisors.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}{s.designation ? ` — ${s.designation}` : ''}{s.status === 'active' || s.status === 'probation' ? '' : ` (${s.status})`}
                  </option>
                ))}
              </select>
              {supervisorErr && (
                <span role="alert" style={{ fontSize: 11, color: 'var(--theme-red-text)', marginTop: 4 }}>
                  Couldn't load the supervisor list, so the current choice may show as None — leave this unchanged and it is kept. {supervisorErr}
                </span>
              )}
            </div>
            <div style={col}>
              <label style={lbl} htmlFor="emp-retirement-date">
                <Tip text="Expected retirement date. SSF pension age in Nepal is 60 — use ↻ to set DOB + 60 years." width={280}>Retirement Date</Tip>
              </label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <BsCalendarPicker id="emp-retirement-date" value={form.retirement_date || ''} onChange={v => set('retirement_date', v)} placeholder="Pick retirement date" clearable />
                </div>
                <button
                  type="button"
                  onClick={calcRetirement}
                  disabled={!form.date_of_birth}
                  title={form.date_of_birth ? 'Set to date of birth + 60 years' : 'Enter Date of Birth first (Personal tab)'}
                  style={{ background: 'none', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', color: form.date_of_birth ? 'var(--theme-text3)' : 'var(--theme-text2)', fontSize: 11, padding: '8px 10px', cursor: form.date_of_birth ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap' }}>
                  ↻ Age 60
                </button>
              </div>
            </div>
            <div style={col}>
              <label style={lbl} htmlFor="emp-notes">Notes</label>
              <textarea
                id="emp-notes"
                rows={3}
                className="form-input"
                style={{ resize: 'vertical' }}
                placeholder="Any notes about this employee's employment…"
                value={form.notes}
                onChange={e => set('notes', e.target.value)}
              />
            </div>
          </>}

          {/* ── ADDRESS ── */}
          {tab === 'address' && <>
            {isEdit && form.address && (
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 0, padding: '8px 12px' }}>
                On file (legacy): <span style={{ color: 'var(--theme-text3)' }}>{form.address}</span>
              </div>
            )}
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '4px 0 0' }}>Permanent Address</p>
            <div style={row}>
              <div style={col}>
                <label style={lbl} htmlFor="emp-perm-province">Province</label>
                <select id="emp-perm-province" className="form-select" style={{ width: '100%' }} value={form.perm_province} onChange={e => set('perm_province', e.target.value)}>
                  <option value="">Select</option>
                  {PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div style={col}>
                <label style={lbl} htmlFor="emp-perm-district">District</label>
                <input id="emp-perm-district" className="form-input" placeholder="e.g. Kathmandu" value={form.perm_district} onChange={e => set('perm_district', e.target.value)} />
              </div>
            </div>
            <div style={row}>
              <div style={{ ...col, flex: 2 }}>
                <label style={lbl} htmlFor="emp-perm-municipality">Municipality / VDC</label>
                <input id="emp-perm-municipality" className="form-input" placeholder="e.g. Lalitpur Metropolitan City" value={form.perm_municipality} onChange={e => set('perm_municipality', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl} htmlFor="emp-perm-ward">Ward No.</label>
                <input id="emp-perm-ward" className="form-input" placeholder="e.g. 5" value={form.perm_ward} onChange={e => set('perm_ward', e.target.value)} />
              </div>
            </div>
            <div style={col}>
              <label style={lbl} htmlFor="emp-perm-tole">Tole / Street</label>
              <input id="emp-perm-tole" className="form-input" placeholder="e.g. Jhamsikhel" value={form.perm_tole} onChange={e => set('perm_tole', e.target.value)} />
            </div>

            <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 8 }}>
              <input type="checkbox" checked={!!form.same_as_permanent} onChange={e => set('same_as_permanent', e.target.checked)} />
              Current address same as permanent
            </label>

            {!form.same_as_permanent && <>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '8px 0 0' }}>Current Address</p>
              <div style={row}>
                <div style={col}>
                  <label style={lbl} htmlFor="emp-temp-province">Province</label>
                  <select id="emp-temp-province" className="form-select" style={{ width: '100%' }} value={form.temp_province} onChange={e => set('temp_province', e.target.value)}>
                    <option value="">Select</option>
                    {PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div style={col}>
                  <label style={lbl} htmlFor="emp-temp-district">District</label>
                  <input id="emp-temp-district" className="form-input" placeholder="e.g. Kathmandu" value={form.temp_district} onChange={e => set('temp_district', e.target.value)} />
                </div>
              </div>
              <div style={row}>
                <div style={{ ...col, flex: 2 }}>
                  <label style={lbl} htmlFor="emp-temp-municipality">Municipality / VDC</label>
                  <input id="emp-temp-municipality" className="form-input" placeholder="e.g. Kathmandu Metropolitan City" value={form.temp_municipality} onChange={e => set('temp_municipality', e.target.value)} />
                </div>
                <div style={col}>
                  <label style={lbl} htmlFor="emp-temp-ward">Ward No.</label>
                  <input id="emp-temp-ward" className="form-input" placeholder="e.g. 10" value={form.temp_ward} onChange={e => set('temp_ward', e.target.value)} />
                </div>
              </div>
              <div style={col}>
                <label style={lbl} htmlFor="emp-temp-tole">Tole / Street</label>
                <input id="emp-temp-tole" className="form-input" placeholder="e.g. Baluwatar" value={form.temp_tole} onChange={e => set('temp_tole', e.target.value)} />
              </div>
            </>}
          </>}

          {/* ── FAMILY ── */}
          {tab === 'family' && <>
            <div style={row}>
              <div style={col}>
                <label style={lbl} htmlFor="emp-marital-status">Marital Status</label>
                <select id="emp-marital-status" className="form-select" style={{ width: '100%' }} value={form.marital_status} onChange={e => set('marital_status', e.target.value)}>
                  <option value="">Select</option>
                  {MARITAL.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
                </select>
              </div>
              <div style={col}>
                <label style={lbl} htmlFor="emp-children-count">No. of Children</label>
                <input id="emp-children-count" type="number" min="0" className="form-input" placeholder="0" value={form.children_count} onChange={e => set('children_count', e.target.value)} />
              </div>
            </div>
            {form.marital_status === 'married' && (
              <div style={col}>
                <label style={lbl} htmlFor="emp-spouse-name">Spouse Name</label>
                <input id="emp-spouse-name" className="form-input" placeholder="Spouse full name" value={form.spouse_name} onChange={e => set('spouse_name', e.target.value)} />
              </div>
            )}
            <div style={row}>
              <div style={col}>
                <label style={lbl} htmlFor="emp-father-name">Father's Name</label>
                <input id="emp-father-name" className="form-input" placeholder="Father's full name" value={form.father_name} onChange={e => set('father_name', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl} htmlFor="emp-mother-name">Mother's Name</label>
                <input id="emp-mother-name" className="form-input" placeholder="Mother's full name" value={form.mother_name} onChange={e => set('mother_name', e.target.value)} />
              </div>
            </div>
            <div style={col}>
              <label style={lbl} htmlFor="emp-grandfather-name">
                <Tip text="Required on Nepal employment/PAN forms — grandfather's name establishes lineage." width={260}>Grandfather's Name</Tip>
              </label>
              <input id="emp-grandfather-name" className="form-input" placeholder="Grandfather's full name" value={form.grandfather_name} onChange={e => set('grandfather_name', e.target.value)} />
            </div>

            <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 14, marginTop: 6 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px' }}>
                <Tip text="The person who receives this employee's SSF / gratuity / final settlement in the event of death. Keep this current." width={300}>Nominee</Tip>
              </p>
              <div style={col}>
                <label style={lbl} htmlFor="emp-nominee-name">Nominee Name</label>
                <input id="emp-nominee-name" className="form-input" placeholder="Full name" value={form.nominee_name} onChange={e => set('nominee_name', e.target.value)} />
              </div>
              <div style={row}>
                <div style={col}>
                  <label style={lbl} htmlFor="emp-nominee-relationship">Relationship</label>
                  <select id="emp-nominee-relationship" className="form-select" style={{ width: '100%' }} value={form.nominee_relationship} onChange={e => set('nominee_relationship', e.target.value)}>
                    <option value="">Select</option>
                    {NOMINEE_RELATIONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div style={col}>
                  <label style={lbl} htmlFor="emp-nominee-contact">Contact</label>
                  <input id="emp-nominee-contact" className="form-input" placeholder="98XXXXXXXX" value={form.nominee_contact} onChange={e => set('nominee_contact', e.target.value)} />
                </div>
              </div>
            </div>
          </>}

        </div>

        {/* Footer */}
        {/* Wraps (S803): on a 390px phone the two groups needed ~380px against ~310px of card, so the
            row overflowed the dialog and Save Changes sat off its right edge. */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--theme-border)', display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isEdit && (employee.status === 'active' || employee.status === 'probation') && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)' }} onClick={handleDeactivate}>
                Deactivate
              </button>
            )}
            {isEdit && employee.status === 'inactive' && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-green-text)' }} onClick={handleActivate}>
                Activate
              </button>
            )}
            {isEdit && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 25%, transparent)' }} onClick={handleDelete}>
                Delete
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', marginLeft: 'auto' }}>
            {error && <span role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)' }}>{error}</span>}
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Employee'}
            </button>
          </div>
        </div>

      </div>
      {confirmEl}
    </Modal>
  )
}
