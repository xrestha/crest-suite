import { useState, useEffect } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'

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
  pay_basis: 'monthly',
  join_date: '',
  end_date: '',
  status: 'active',
  phone: '',
  email: '',
  address: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  bank_name: '',
  bank_account_no: '',
  bank_branch: '',
  ssf_no: '',
  ssf_enrolled: false,
  basic_salary: '',
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

const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6,
  padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%',
  fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4, display: 'block', letterSpacing: '0.02em' }
const row = { display: 'flex', gap: 12 }
const col = { flex: 1, display: 'flex', flexDirection: 'column' }

export default function EmployeeForm({ clientId, employee, onSave, onClose }) {
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const isEdit = !!employee
  const [tab, setTab]         = useState('personal')
  const [form, setForm]       = useState(isEdit ? { ...EMPTY, ...employee } : { ...EMPTY })
  const [supervisors, setSupervisors] = useState([])
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')

  // Active employees available as reporting supervisors (exclude self to prevent self-reporting).
  useEffect(() => {
    if (!clientId) return
    scopedFrom('hr_employees', 'id, full_name, designation')
      .eq('status', 'active')
      .order('full_name')
      .then(({ data }) => setSupervisors((data || []).filter(e => e.id !== employee?.id)))
  }, [clientId, employee?.id, scopedFrom])

  function set(field, value) { setForm(f => ({ ...f, [field]: value })) }

  // Suggest retirement date = date of birth + 60 years (SSF pension age in Nepal).
  function calcRetirement() {
    if (!form.date_of_birth) return
    const d = new Date(form.date_of_birth)
    d.setFullYear(d.getFullYear() + 60)
    set('retirement_date', d.toISOString().slice(0, 10))
  }

  async function handleSave() {
    if (!form.full_name.trim()) { setError('Full name is required.'); setTab('personal'); return }
    if (!form.join_date)        { setError('Join date is required.'); setTab('employment'); return }
    setError('')
    setSaving(true)

    const samePerm = !!form.same_as_permanent
    const payload = {
      ...form,
      full_name:      form.full_name.trim(),
      basic_salary:   parseFloat(form.basic_salary) || 0,
      gender:         form.gender         || null,
      date_of_birth:  form.date_of_birth  || null,
      end_date:       form.end_date       || null,
      pan_no:         form.pan_no         || null,
      citizenship_no: form.citizenship_no || null,
      // Typed columns must be null (not '') when empty.
      supervisor_id:   form.supervisor_id   || null,
      retirement_date: form.retirement_date || null,
      marital_status:  form.marital_status  || null,
      children_count:  form.children_count === '' ? null : parseInt(form.children_count, 10),
      // When "same as permanent" is ticked, mirror the permanent address into current.
      temp_province:     samePerm ? form.perm_province     : form.temp_province,
      temp_district:     samePerm ? form.perm_district     : form.temp_district,
      temp_municipality: samePerm ? form.perm_municipality : form.temp_municipality,
      temp_ward:         samePerm ? form.perm_ward         : form.temp_ward,
      temp_tole:         samePerm ? form.perm_tole         : form.temp_tole,
    }

    if (isEdit) {
      const { error: err } = await scopedUpdate('hr_employees', payload).eq('id', employee.id)
      if (err) { setError(err.message); setSaving(false); return }
    } else {
      const { error: err } = await scopedInsert('hr_employees', payload)
      if (err) { setError(err.message); setSaving(false); return }
    }

    setSaving(false)
    onSave()
  }

  async function handleDeactivate() {
    if (!window.confirm(`Mark ${employee.full_name} as inactive?`)) return
    await scopedUpdate('hr_employees', { status: 'inactive' }).eq('id', employee.id)
    onSave()
  }

  async function handleDelete() {
    if (!window.confirm(`Delete ${employee.full_name}? This cannot be undone.`)) return
    if (!window.confirm(`Are you sure? All data for ${employee.full_name} will be permanently deleted.`)) return
    const { error: err } = await scopedDelete('hr_employees').eq('id', employee.id)
    if (err) { setError(err.message); return }
    onSave()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 20 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={onClose} />
      <div style={{
        position: 'relative', width: 560, maxWidth: '100%', maxHeight: '90vh',
        background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 12,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
      }}>

        {/* Header */}
        <div style={{ padding: '20px 24px 0', borderBottom: '1px solid var(--theme-border)', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 16, color: 'var(--theme-text1)' }}>
              {isEdit ? `Edit — ${employee.full_name}` : 'Add Employee'}
            </h2>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>
          <div className="tab-bar" style={{ marginBottom: 0 }}>
            {TABS.map(t => (
              <button key={t.key} className={`tab-btn${tab === t.key ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, padding: 24, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* ── PERSONAL ── */}
          {tab === 'personal' && <>
            <div style={col}>
              <label style={lbl}>
                <Tip text="Auto-generated if left blank (e.g. EMP-001). You can set a custom code." width={240}>Employee Code</Tip>
              </label>
              <input style={inp} placeholder="EMP-001 (optional)" value={form.employee_code} onChange={e => set('employee_code', e.target.value)} />
            </div>
            <div style={col}>
              <label style={lbl}>Full Name <span style={{ color: 'var(--theme-red)' }}>*</span></label>
              <input style={inp} placeholder="As per citizenship / PAN" value={form.full_name} onChange={e => set('full_name', e.target.value)} />
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Gender</label>
                <select style={inp} value={form.gender} onChange={e => set('gender', e.target.value)}>
                  <option value="">Select</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div style={col}>
                <label style={lbl}>
                  <Tip text="Date of birth in BS. Used for age and retirement calculations." width={220}>Date of Birth</Tip>
                </label>
                <BsCalendarPicker value={form.date_of_birth} onChange={v => set('date_of_birth', v)} placeholder="Pick DOB" clearable />
              </div>
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>
                  <Tip text="PAN number from IRD. Required for TDS computation." width={220}>PAN No.</Tip>
                </label>
                <input style={inp} placeholder="9-digit PAN" value={form.pan_no} onChange={e => set('pan_no', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl}>National Identity No.</label>
                <input style={inp} placeholder="NID / Citizenship No." value={form.citizenship_no} onChange={e => set('citizenship_no', e.target.value)} />
              </div>
            </div>
            <div style={col}>
              <label style={lbl}>Phone</label>
              <input style={inp} placeholder="98XXXXXXXX" value={form.phone} onChange={e => set('phone', e.target.value)} />
            </div>
            <div style={col}>
              <label style={lbl}>Email</label>
              <input type="email" style={inp} placeholder="employee@email.com" value={form.email} onChange={e => set('email', e.target.value)} />
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Emergency Contact Name</label>
                <input style={inp} placeholder="Name" value={form.emergency_contact_name} onChange={e => set('emergency_contact_name', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl}>Emergency Contact Phone</label>
                <input style={inp} placeholder="98XXXXXXXX" value={form.emergency_contact_phone} onChange={e => set('emergency_contact_phone', e.target.value)} />
              </div>
            </div>
          </>}

          {/* ── EMPLOYMENT ── */}
          {tab === 'employment' && <>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Designation</label>
                <input style={inp} placeholder="e.g. Head Chef, Cashier" value={form.designation} onChange={e => set('designation', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl}>Department</label>
                <input style={inp} placeholder="e.g. Kitchen, FOH, Admin" value={form.department} onChange={e => set('department', e.target.value)} />
              </div>
            </div>
            <div style={col}>
              <label style={lbl}>
                <Tip text="Permanent — no end date. Probation — first 3–6 months. Contract — defined end date. Part-time — paid per day/hour." width={280}>Employment Type</Tip>
              </label>
              <select style={inp} value={form.employment_type} onChange={e => set('employment_type', e.target.value)}>
                <option value="permanent">Permanent</option>
                <option value="probation">Probation</option>
                <option value="contract">Contract</option>
                <option value="part_time">Part-time</option>
              </select>
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Join Date <span style={{ color: 'var(--theme-red)' }}>*</span></label>
                <BsCalendarPicker value={form.join_date} onChange={v => set('join_date', v)} placeholder="Pick join date" />
              </div>
              {(form.employment_type === 'contract' || form.employment_type === 'part_time') && (
                <div style={col}>
                  <label style={lbl}>Contract End Date</label>
                  <BsCalendarPicker value={form.end_date} onChange={v => set('end_date', v)} placeholder="Pick end date" clearable />
                </div>
              )}
            </div>
            <div style={col}>
              <label style={lbl}>Status</label>
              <select style={inp} value={form.status} onChange={e => set('status', e.target.value)}>
                <option value="active">Active</option>
                <option value="probation">Probation</option>
                <option value="inactive">Inactive</option>
                <option value="resigned">Resigned</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>
            <div style={col}>
              <label style={lbl}>
                <Tip text="The person this employee reports to. Only active employees are listed." width={260}>Reporting Supervisor</Tip>
              </label>
              <select style={inp} value={form.supervisor_id || ''} onChange={e => set('supervisor_id', e.target.value)}>
                <option value="">— None —</option>
                {supervisors.map(s => (
                  <option key={s.id} value={s.id}>{s.full_name}{s.designation ? ` — ${s.designation}` : ''}</option>
                ))}
              </select>
            </div>
            <div style={col}>
              <label style={lbl}>
                <Tip text="Expected retirement date. SSF pension age in Nepal is 60 — use ↻ to set DOB + 60 years." width={280}>Retirement Date</Tip>
              </label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <BsCalendarPicker value={form.retirement_date || ''} onChange={v => set('retirement_date', v)} placeholder="Pick retirement date" clearable />
                </div>
                <button
                  type="button"
                  onClick={calcRetirement}
                  disabled={!form.date_of_birth}
                  title={form.date_of_birth ? 'Set to date of birth + 60 years' : 'Enter Date of Birth first (Personal tab)'}
                  style={{ background: 'none', border: '1px solid var(--theme-border)', borderRadius: 5, color: form.date_of_birth ? 'var(--theme-text3)' : 'var(--theme-text2)', fontSize: 11, padding: '8px 10px', cursor: form.date_of_birth ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap' }}>
                  ↻ Age 60
                </button>
              </div>
            </div>
            <div style={col}>
              <label style={lbl}>Notes</label>
              <textarea
                rows={3}
                style={{ ...inp, resize: 'vertical' }}
                placeholder="Any notes about this employee's employment…"
                value={form.notes}
                onChange={e => set('notes', e.target.value)}
              />
            </div>
          </>}

          {/* ── ADDRESS ── */}
          {tab === 'address' && <>
            {isEdit && form.address && (
              <div style={{ fontSize: 11, color: 'var(--theme-text2)', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px' }}>
                On file (legacy): <span style={{ color: 'var(--theme-text3)' }}>{form.address}</span>
              </div>
            )}
            <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '4px 0 0' }}>Permanent Address</p>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Province</label>
                <select style={inp} value={form.perm_province} onChange={e => set('perm_province', e.target.value)}>
                  <option value="">Select</option>
                  {PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div style={col}>
                <label style={lbl}>District</label>
                <input style={inp} placeholder="e.g. Kathmandu" value={form.perm_district} onChange={e => set('perm_district', e.target.value)} />
              </div>
            </div>
            <div style={row}>
              <div style={{ ...col, flex: 2 }}>
                <label style={lbl}>Municipality / VDC</label>
                <input style={inp} placeholder="e.g. Lalitpur Metropolitan City" value={form.perm_municipality} onChange={e => set('perm_municipality', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl}>Ward No.</label>
                <input style={inp} placeholder="e.g. 5" value={form.perm_ward} onChange={e => set('perm_ward', e.target.value)} />
              </div>
            </div>
            <div style={col}>
              <label style={lbl}>Tole / Street</label>
              <input style={inp} placeholder="e.g. Jhamsikhel" value={form.perm_tole} onChange={e => set('perm_tole', e.target.value)} />
            </div>

            <label style={{ ...lbl, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 8 }}>
              <input type="checkbox" checked={!!form.same_as_permanent} onChange={e => set('same_as_permanent', e.target.checked)} />
              Current address same as permanent
            </label>

            {!form.same_as_permanent && <>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '8px 0 0' }}>Current Address</p>
              <div style={row}>
                <div style={col}>
                  <label style={lbl}>Province</label>
                  <select style={inp} value={form.temp_province} onChange={e => set('temp_province', e.target.value)}>
                    <option value="">Select</option>
                    {PROVINCES.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div style={col}>
                  <label style={lbl}>District</label>
                  <input style={inp} placeholder="e.g. Kathmandu" value={form.temp_district} onChange={e => set('temp_district', e.target.value)} />
                </div>
              </div>
              <div style={row}>
                <div style={{ ...col, flex: 2 }}>
                  <label style={lbl}>Municipality / VDC</label>
                  <input style={inp} placeholder="e.g. Kathmandu Metropolitan City" value={form.temp_municipality} onChange={e => set('temp_municipality', e.target.value)} />
                </div>
                <div style={col}>
                  <label style={lbl}>Ward No.</label>
                  <input style={inp} placeholder="e.g. 10" value={form.temp_ward} onChange={e => set('temp_ward', e.target.value)} />
                </div>
              </div>
              <div style={col}>
                <label style={lbl}>Tole / Street</label>
                <input style={inp} placeholder="e.g. Baluwatar" value={form.temp_tole} onChange={e => set('temp_tole', e.target.value)} />
              </div>
            </>}
          </>}

          {/* ── FAMILY ── */}
          {tab === 'family' && <>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Marital Status</label>
                <select style={inp} value={form.marital_status} onChange={e => set('marital_status', e.target.value)}>
                  <option value="">Select</option>
                  {MARITAL.map(m => <option key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</option>)}
                </select>
              </div>
              <div style={col}>
                <label style={lbl}>No. of Children</label>
                <input type="number" min="0" style={inp} placeholder="0" value={form.children_count} onChange={e => set('children_count', e.target.value)} />
              </div>
            </div>
            {form.marital_status === 'married' && (
              <div style={col}>
                <label style={lbl}>Spouse Name</label>
                <input style={inp} placeholder="Spouse full name" value={form.spouse_name} onChange={e => set('spouse_name', e.target.value)} />
              </div>
            )}
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Father's Name</label>
                <input style={inp} placeholder="Father's full name" value={form.father_name} onChange={e => set('father_name', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl}>Mother's Name</label>
                <input style={inp} placeholder="Mother's full name" value={form.mother_name} onChange={e => set('mother_name', e.target.value)} />
              </div>
            </div>
            <div style={col}>
              <label style={lbl}>
                <Tip text="Required on Nepal employment/PAN forms — grandfather's name establishes lineage." width={260}>Grandfather's Name</Tip>
              </label>
              <input style={inp} placeholder="Grandfather's full name" value={form.grandfather_name} onChange={e => set('grandfather_name', e.target.value)} />
            </div>

            <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 14, marginTop: 6 }}>
              <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-accent)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px' }}>
                <Tip text="The person who receives this employee's SSF / gratuity / final settlement in the event of death. Keep this current." width={300}>Nominee</Tip>
              </p>
              <div style={col}>
                <label style={lbl}>Nominee Name</label>
                <input style={inp} placeholder="Full name" value={form.nominee_name} onChange={e => set('nominee_name', e.target.value)} />
              </div>
              <div style={row}>
                <div style={col}>
                  <label style={lbl}>Relationship</label>
                  <select style={inp} value={form.nominee_relationship} onChange={e => set('nominee_relationship', e.target.value)}>
                    <option value="">Select</option>
                    {NOMINEE_RELATIONS.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div style={col}>
                  <label style={lbl}>Contact</label>
                  <input style={inp} placeholder="98XXXXXXXX" value={form.nominee_contact} onChange={e => set('nominee_contact', e.target.value)} />
                </div>
              </div>
            </div>
          </>}

        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--theme-border)', display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {isEdit && employee.status === 'active' && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.25)' }} onClick={handleDeactivate}>
                Deactivate
              </button>
            )}
            {isEdit && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.25)' }} onClick={handleDelete}>
                Delete
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {error && <span style={{ fontSize: 12, color: 'var(--theme-red)' }}>{error}</span>}
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Employee'}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
