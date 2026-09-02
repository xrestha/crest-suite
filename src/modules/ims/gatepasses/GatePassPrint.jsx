import { BS_MONTHS, adToBs } from '../../../utils/bsCalendar'
import { nepalTime } from '../../../shared/nepalTime'

const PURPOSE_LABELS = { delivery: 'Delivery', pickup: 'Pickup', maintenance: 'Maintenance', other: 'Other' }

// A4 print-only Gate Pass — auto-printed right after a new gate pass is saved (GatePasses.jsx),
// modeled on PurchaseBillPrint.jsx's letterhead/print-only-div convention (the IMS-side print
// pattern, distinct from POS's popup-window pattern). No staff/supervisor role gate on this side
// (IMS has no such concept) — anyone who can reach /gate-passes under ModuleGate can issue one.
export default function GatePassPrint({ gatePass, bizInfo, issuedByName }) {
  const now = new Date(gatePass.time_in || Date.now())
  const adDateStr = now.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const nowStr    = nepalTime(now)
  const bs        = adToBs(now)
  const bsDateStr = `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`

  return (
    <div style={{ fontFamily: 'Georgia, serif', color: '#000', padding: '20px 24px', maxWidth: 720, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #000', paddingBottom: 10, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#000' }}>{bizInfo?.name || 'Crest Suite'}</div>
          {bizInfo?.address && <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>{bizInfo.address}</div>}
          {bizInfo?.vatNumber && <div style={{ fontSize: 11, color: '#555', marginTop: 2 }}>PAN/VAT No: {bizInfo.vatNumber}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Gate Pass</div>
          <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>{adDateStr} · {nowStr}</div>
          <div style={{ fontSize: 11, color: '#555' }}>{bsDateStr} (BS)</div>
        </div>
      </div>

      {/* Pass meta */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12, marginBottom: 20 }}>
        <div><span style={{ color: '#777' }}>Pass No: </span><span style={{ fontWeight: 700 }}>G-{gatePass.pass_no}</span></div>
        <div><span style={{ color: '#777' }}>Purpose: </span><span style={{ fontWeight: 700 }}>{PURPOSE_LABELS[gatePass.purpose] || gatePass.purpose}</span></div>
        <div><span style={{ color: '#777' }}>Vendor / Company: </span><span style={{ fontWeight: 700 }}>{gatePass.vendor_name}</span></div>
        <div><span style={{ color: '#777' }}>Driver Name: </span><span style={{ fontWeight: 700 }}>{gatePass.driver_name}</span></div>
        <div><span style={{ color: '#777' }}>Vehicle Number: </span><span style={{ fontWeight: 700, fontSize: 14 }}>{gatePass.vehicle_number}</span></div>
        <div><span style={{ color: '#777' }}>Issued By: </span><span style={{ fontWeight: 700 }}>{issuedByName || '—'}</span></div>
        {gatePass.notes && (
          <div style={{ gridColumn: '1 / -1' }}><span style={{ color: '#777' }}>Notes: </span><span>{gatePass.notes}</span></div>
        )}
      </div>

      {/* Approval signature strip */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, marginTop: 64, fontSize: 11 }}>
        {['Security Signature', 'Supervisor Signature'].map(label => (
          <div key={label} style={{ textAlign: 'center' }}>
            <div style={{ borderTop: '1px solid #000', paddingTop: 4, color: '#555' }}>{label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
