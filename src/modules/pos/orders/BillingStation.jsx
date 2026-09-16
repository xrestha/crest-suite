import Tip from '../../../components/Tip'
import SupportContactLine from '../../../components/SupportContactLine'
import { fmtNpr } from './posOrdersConstants'

// The Billing station (S762) — the cashier's own way in, reached from Floor → Billing rather than
// by tapping through the order screen. It is deliberately a LIST, not a second floor plan: the
// person using it is not looking for a table in the room, they are looking for the bill a guest
// just asked for, and a list can carry the covers, the running total and how long the table has
// been open in one readable line.
//
// Presentational on purpose. Every row here comes from the floor data PosOrders already loads and
// polls (loadFloor), and onBill() goes back through that file's own open-order path — so this
// screen has no second copy of the bill arithmetic, and no second idea of what "open" means.

// Minutes since the order opened, as a short chip. An order queued offline has no opened_at (the
// server assigns it on sync), so those simply carry no age rather than a made-up one.
function openFor(openedAt, now) {
  if (!openedAt) return null
  const ms = now - new Date(openedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just opened'
  if (mins < 60) return `open ${mins} min`
  const h = Math.floor(mins / 60)
  // Past a day the minutes stop being information and start being noise — a bill open for 48 days
  // is a forgotten table to chase, not something to time to the minute (and "open 1168 h 13 min"
  // is what the hours-only form actually printed).
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `open ${d} day${d !== 1 ? 's' : ''}`
  }
  const m = mins % 60
  return m === 0 ? `open ${h} h` : `open ${h} h ${m} min`
}

export default function BillingStation({
  rows,
  loading,
  loadError,
  onRetry,
  onBill,
  isOnline,
  now,
  canVoid,
}) {
  const grandTotal = rows.reduce((s, r) => s + r.total, 0)

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Billing</h1>
          <p className="page-subtitle">
            Every open bill in the outlet. Tap one to take payment — the same Pay, Void and
            Complimentary window you get from the order screen.
          </p>
        </div>
        {rows.length > 0 && (
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
              {rows.length} open bill{rows.length !== 1 ? 's' : ''}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-accent-ink)', marginTop: 2 }}>
              {fmtNpr(grandTotal)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
              <Tip text="The sum of every bill still open on the floor right now — what is sitting on tables uncollected, not today's takings. It moves as orders are added to and bills are settled.">
                on the floor
              </Tip>
            </div>
          </div>
        )}
      </div>

      {/* Billing is online-only (a bill gets a server-assigned invoice number and a shift to land
          in), so this screen says so up front rather than letting a cashier tap a dead button. */}
      {!isOnline && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--theme-amber-text)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>📵</span>
            <span><strong>Offline</strong> — no bill can be closed until this device reconnects. Orders can still be taken on the Orders screen; the totals below are as last loaded.</span>
          </div>
          <SupportContactLine variant="inline" />
        </div>
      )}

      {loadError && (
        <p role="alert" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-red-text)' }}>
          Couldn't refresh the open bills — {loadError}.{rows.length > 0 ? ' The list below is as last loaded and may be out of date — check the total on screen before taking payment.' : ''}{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>Retry</button>
        </p>
      )}

      {loading ? (
        <p style={{ color: 'var(--theme-text3)' }}>Loading open bills…</p>
      ) : rows.length === 0 && loadError ? null : rows.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text3)' }}>
          Nothing to bill — every table is settled.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(r => {
            const age = openFor(r.openedAt, now)
            return (
              <div
                key={r.key}
                className="card"
                style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}
              >
                <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>
                      {r.label}
                    </span>
                    {r.section && (
                      <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{r.section}</span>
                    )}
                    {r.pending > 0 && (
                      <Tip text="Items are on this bill that have never been sent to the kitchen or bar. Billing now charges the guest for food nobody is cooking — open the order first and send them, or take them off.">
                        <span className="badge badge-amber" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>
                          ⚠ {r.pending} unsent
                        </span>
                      </Tip>
                    )}
                    {r.offlinePending && (
                      <Tip text="Taken on this device while it was offline and not yet uploaded. It has no invoice number yet and cannot be billed until it syncs.">
                        <span className="badge badge-amber" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>📵 not synced</span>
                      </Tip>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 3 }}>
                    {r.covers} cover{r.covers !== 1 ? 's' : ''} · {r.itemCount} item{r.itemCount !== 1 ? 's' : ''}
                    {age && <> · <span style={{ color: 'var(--theme-text3)' }}>{age}</span></>}
                  </div>
                </div>

                <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--theme-accent-ink)', whiteSpace: 'nowrap' }}>
                  {fmtNpr(r.total)}
                </div>

                <button
                  className="btn btn-primary"
                  style={{ minWidth: 120, justifyContent: 'center', flexShrink: 0 }}
                  disabled={!isOnline || r.offlinePending}
                  onClick={() => onBill(r)}
                  aria-label={`Bill ${r.label}, ${fmtNpr(r.total)}`}
                >
                  Bill
                </button>
              </div>
            )
          })}
        </div>
      )}

      <p style={{ marginTop: 20, fontSize: 12, color: 'var(--theme-text3)' }}>
        To add or change items on a bill, open it from <strong>Orders</strong> instead
        {canVoid ? ' — Void and Complimentary live on the payment window here too.' : '.'}
      </p>
    </div>
  )
}
