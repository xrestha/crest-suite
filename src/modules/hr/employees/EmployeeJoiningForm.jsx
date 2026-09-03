import { useAuth } from '../../../context/AuthContext'
import Modal from '../../../components/Modal'
import { printWithTitle } from '../../../utils/printTitle'
// The registered entity. Hand-typed here as "Crest Hospitality (Pvt. Ltd.)" until S672 — this is
// a form a new employee signs, so the company it names has to be the one that exists.
import { COMPANY } from '../../../legal'

// ── Auth hook helper ──────────────────────────────────────────────────────────

function useClientName() {
  const { profile, isAdmin, adminViewClientName } = useAuth()
  if (isAdmin) return adminViewClientName || 'Organisation Name'
  return profile?.clients?.name || 'Organisation Name'
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function Line({ label, wide, half }) {
  return (
    <div style={{ flex: wide ? 2 : half ? 0.5 : 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ fontSize: 9, color: '#444', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      <div style={{ borderBottom: '1px solid #222', minHeight: 20 }} />
    </div>
  )
}

function CheckRow({ label, options }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ fontSize: 9, color: '#444', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', gap: 14, paddingTop: 3 }}>
        {options.map(opt => (
          <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, cursor: 'default' }}>
            <input type="checkbox" style={{ width: 12, height: 12, accentColor: '#000' }} readOnly />
            {opt}
          </label>
        ))}
      </div>
    </div>
  )
}

function SectionHead({ title }) {
  return (
    <div style={{ marginTop: 18, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', background: '#111', color: '#fff', padding: '3px 10px', borderRadius: 3 }}>
          {title}
        </div>
        <div style={{ flex: 1, borderBottom: '1.5px solid #111' }} />
      </div>
    </div>
  )
}

function FieldRow({ children }) {
  return (
    <div style={{ display: 'flex', gap: 16, marginBottom: 14 }}>
      {children}
    </div>
  )
}

function SubHead({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#555', borderBottom: '1px solid #bbb', paddingBottom: 3, marginBottom: 10, marginTop: 12 }}>
      {children}
    </div>
  )
}

function TextBox({ label, rows = 2 }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ fontSize: 9, color: '#444', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600 }}>{label}</div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ borderBottom: '1px solid #222', minHeight: 18, marginTop: i === 0 ? 0 : 4 }} />
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function EmployeeJoiningForm({ onClose }) {
  const clientName = useClientName()

  return (
    // The shared Modal rather than the hand-rolled overlay this used to be: it is a dialog, so
    // it needs Escape, the Tab trap and focus restoration, and it had none of the three.
    // `unstyled` because an A4 sheet is not a card, `printable` because this document is the
    // print target (see Modal.js), and alignSelf clears the overlay's cross-axis centring —
    // a full page is always taller than the viewport, and a centred flex item that overflows
    // is clipped at its TOP edge with no way to scroll back up to it.
    <Modal
      onClose={onClose}
      title="Employee joining form"
      unstyled
      printable
      zIndex={400}
      panelStyle={{ alignSelf: 'flex-start', display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}
    >

      <style>{`
        @media print {
          @page { size: A4 portrait; margin: 14mm 14mm; }
          .empform-chrome { display: none !important; }
          .empform-paper  { box-shadow: none !important; border: none !important; margin: 0 !important; max-width: 100% !important; }
          body * { visibility: hidden; }
          .empform-paper, .empform-paper * { visibility: visible !important; }
          .empform-paper { position: fixed; inset: 0; }
        }
      `}</style>

      {/* Action bar — hidden in print */}
      <div className="empform-chrome" style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
        <button
          onClick={() => printWithTitle(`${clientName} - Employee Joining Form`)}
          style={{ background: 'var(--theme-accent)', color: 'var(--theme-accent-text)', border: 'none', borderRadius: 8, padding: '10px 28px', fontWeight: 700, fontSize: 14, cursor: 'pointer', letterSpacing: '0.03em' }}
        >
          Print / Save PDF
        </button>
        <button
          onClick={onClose}
          style={{ background: 'transparent', color: 'var(--theme-text3)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: '10px 20px', fontSize: 13, cursor: 'pointer' }}
        >
          Close
        </button>
      </div>

      {/* A4 Paper */}
      <div className="empform-paper" style={{
        background: '#fff', color: '#111',
        width: 794, maxWidth: '100%',
        padding: '32px 36px',
        boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
        fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
        fontSize: 12, lineHeight: 1.4,
        boxSizing: 'border-box',
        marginBottom: 24,
      }}>

        {/* ── Document Header ── */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em', color: '#111' }}>{clientName}</div>
            <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>Human Resources Department</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111' }}>Employee Joining Form</div>
            <div style={{ fontSize: 10, color: '#777', marginTop: 4 }}>
              Date: <span style={{ borderBottom: '1px solid #555', paddingBottom: 1, display: 'inline-block', minWidth: 90 }}>&nbsp;</span>
            </div>
          </div>
        </div>
        <div style={{ borderBottom: '2.5px solid #111', marginBottom: 4 }} />
        <div style={{ fontSize: 9, color: '#888', marginBottom: 16, fontStyle: 'italic' }}>
          Please complete all sections in BLOCK LETTERS using black or blue ink. Fields marked <span style={{ color: '#000', fontStyle: 'normal', fontWeight: 700 }}>*</span> are required.
        </div>

        {/* ── Section 1: Personal Information ── */}
        <SectionHead title="1 · Personal Information" />

        {/* Photo box */}
        <div style={{ float: 'right', marginLeft: 20, marginTop: -8, marginBottom: 10 }}>
          <div style={{ width: 90, height: 110, border: '1.5px solid #555', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 8, color: '#888', textAlign: 'center', lineHeight: 1.5 }}>Passport Size<br />Photo</div>
          </div>
          <div style={{ fontSize: 8, color: '#777', textAlign: 'center', marginTop: 3 }}>3.5 × 4.5 cm</div>
        </div>

        <FieldRow>
          <Line label="Employee Code (if assigned)" />
          <Line label="Full Name (as per Citizenship / PAN) *" wide />
        </FieldRow>

        <FieldRow>
          <CheckRow label="Gender" options={['Male', 'Female', 'Other']} />
          <Line label="Date of Birth (BS)" />
          <Line label="Date of Birth (AD)" />
        </FieldRow>

        <FieldRow>
          <Line label="NID / Citizenship No." />
          <Line label="PAN No. (9-digit, if applicable)" />
        </FieldRow>

        <FieldRow>
          <Line label="Phone No." />
          <Line label="Email Address" />
        </FieldRow>

        <FieldRow>
          <Line label="Emergency Contact Name" />
          <Line label="Emergency Contact Phone" />
        </FieldRow>

        {/* ── Section 2: Employment Details ── */}
        <SectionHead title="2 · Employment Details" />

        <FieldRow>
          <Line label="Designation *" />
          <Line label="Department" />
        </FieldRow>

        <FieldRow>
          <CheckRow label="Employment Type" options={['Permanent', 'Probation', 'Contract', 'Part-time']} />
        </FieldRow>

        <FieldRow>
          <Line label="Join Date (BS) *" />
          <Line label="Join Date (AD) *" />
          <Line label="Contract End Date (if applicable)" />
        </FieldRow>

        <FieldRow>
          <Line label="Reporting Supervisor" />
        </FieldRow>

        <FieldRow>
          <CheckRow label="Status" options={['Active', 'Probation', 'Contract', 'Resigned', 'Terminated']} />
        </FieldRow>

        <FieldRow>
          <TextBox label="Notes / Remarks" rows={2} />
        </FieldRow>

        {/* ── Section 3: Address ── */}
        <SectionHead title="3 · Address" />

        <SubHead>Permanent Address</SubHead>

        <FieldRow>
          <CheckRow label="Province" options={['Koshi', 'Madhesh', 'Bagmati', 'Gandaki', 'Lumbini', 'Karnali', 'Sudurpashchim']} />
        </FieldRow>

        <FieldRow>
          <Line label="District" />
          <Line label="Municipality / VDC" wide />
          <Line label="Ward No." half />
        </FieldRow>

        <FieldRow>
          <Line label="Tole / Street" wide />
        </FieldRow>

        <div style={{ marginBottom: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'default' }}>
            <input type="checkbox" style={{ width: 12, height: 12 }} readOnly />
            <span style={{ fontWeight: 600 }}>Current address is same as permanent address</span>
          </label>
        </div>

        <SubHead>Current / Temporary Address (if different)</SubHead>

        <FieldRow>
          <CheckRow label="Province" options={['Koshi', 'Madhesh', 'Bagmati', 'Gandaki', 'Lumbini', 'Karnali', 'Sudurpashchim']} />
        </FieldRow>

        <FieldRow>
          <Line label="District" />
          <Line label="Municipality / VDC" wide />
          <Line label="Ward No." half />
        </FieldRow>

        <FieldRow>
          <Line label="Tole / Street" wide />
        </FieldRow>

        {/* ── Section 4: Family ── */}
        <SectionHead title="4 · Family Information" />

        <FieldRow>
          <CheckRow label="Marital Status" options={['Single', 'Married', 'Divorced', 'Widowed']} />
          <Line label="No. of Children" half />
        </FieldRow>

        <FieldRow>
          <Line label="Spouse Name (if married)" />
        </FieldRow>

        <FieldRow>
          <Line label="Father's Full Name" />
          <Line label="Mother's Full Name" />
        </FieldRow>

        <FieldRow>
          <Line label="Grandfather's Full Name" wide />
        </FieldRow>

        <SubHead>Nominee Information (for SSF / Gratuity / Final Settlement)</SubHead>

        <FieldRow>
          <Line label="Nominee Full Name" />
          <Line label="Relationship to Employee" />
          <Line label="Nominee Phone" />
        </FieldRow>

        {/* ── Section 5: Bank & SSF ── */}
        <SectionHead title="5 · Bank Account & SSF" />

        <FieldRow>
          <Line label="Bank Name" />
          <Line label="Branch" />
        </FieldRow>

        <FieldRow>
          <Line label="Account Number" wide />
          <Line label="Account Holder Name" />
        </FieldRow>

        <FieldRow>
          <Line label="SSF Membership No. (if enrolled)" />
          <CheckRow label="SSF Enrolled?" options={['Yes', 'No']} />
        </FieldRow>

        {/* ── Section 6: Pay Basis ── */}
        <SectionHead title="6 · Pay Details" />

        <FieldRow>
          <CheckRow label="Pay Basis" options={['Monthly', 'Daily', 'Hourly']} />
          <Line label="Basic Salary / Rate (NPR)" />
        </FieldRow>

        {/* ── Declaration ── */}
        <SectionHead title="7 · Declaration" />

        <div style={{ fontSize: 10, color: '#333', lineHeight: 1.7, marginBottom: 16, background: '#f8f8f8', border: '1px solid #ddd', padding: '10px 14px', borderRadius: 4 }}>
          I hereby declare that the information provided in this form is true and correct to the best of my knowledge. I understand that any false or misleading information may result in termination of my employment. I agree to notify HR of any changes to the above information.
        </div>

        <div style={{ display: 'flex', gap: 40, marginTop: 24 }}>
          <div style={{ flex: 1 }}>
            <div style={{ borderBottom: '1px solid #555', minHeight: 36 }} />
            <div style={{ fontSize: 10, color: '#555', marginTop: 5 }}>Employee Signature</div>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              <span style={{ fontSize: 10, color: '#555' }}>Date:</span>
              <div style={{ flex: 1, borderBottom: '1px solid #555', minHeight: 18 }} />
            </div>
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ borderBottom: '1px solid #555', minHeight: 36 }} />
            <div style={{ fontSize: 10, color: '#555', marginTop: 5 }}>HR / Admin Signature & Stamp</div>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              <span style={{ fontSize: 10, color: '#555' }}>Date:</span>
              <div style={{ flex: 1, borderBottom: '1px solid #555', minHeight: 18 }} />
            </div>
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ borderBottom: '1px solid #555', minHeight: 36 }} />
            <div style={{ fontSize: 10, color: '#555', marginTop: 5 }}>Authorised By (Name & Designation)</div>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              <span style={{ fontSize: 10, color: '#555' }}>Date:</span>
              <div style={{ flex: 1, borderBottom: '1px solid #555', minHeight: 18 }} />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ marginTop: 24, borderTop: '1px solid #ddd', paddingTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 9, color: '#aaa' }}>Powered by Crest HR — {COMPANY.name}</div>
          <div style={{ fontSize: 9, color: '#aaa' }}>For official use only — keep on file</div>
        </div>
      </div>
    </Modal>
  )
}
