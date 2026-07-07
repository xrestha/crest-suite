import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'
import { NUTRIENTS } from '../../../utils/nutrition'
import Modal from '../../../components/Modal'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
const fmtNutrient = (def, value) => `${(Number(value) || 0).toFixed(def.dp)} ${def.unit}`
const priceIncVat = item => Math.round((parseFloat(item.selling_price) || 0) * (1 + (parseFloat(item.vat_rate) || 0)))

// Same three stages + wording as the staff-side floor-view badge (PosOrders.jsx) and KDS board —
// used as a fallback badge when this browser has no submitted-order snapshot of its own (e.g. a
// guest who never ordered, just checking a table staff already opened manually).
const KOT_STATUS_BADGE = { new: 'badge-red', in_progress: 'badge-amber', ready: 'badge-green' }
const KOT_STATUS_LABEL = { new: 'Order sent to kitchen', in_progress: 'Being prepared', ready: 'Ready to serve' }

// Unified 5-stage view of the guest's own order, combining pos_guest_order_requests.status
// (whether staff has even Accepted yet) with the table's pos_kot_log status (once the accepted
// items are actually sent to the kitchen) — kotStatus supersedes requestStatus once it exists,
// same precedence the small pre-redesign badge used.
const STAGES = ['placed', 'confirmed', 'kot_sent', 'preparing', 'ready']
const STAGE_LABEL = {
  placed: 'Order placed — waiting for staff to confirm…',
  confirmed: 'Confirmed by staff — heading to the kitchen',
  kot_sent: 'Sent to kitchen',
  preparing: 'Being prepared',
  ready: 'Ready to serve',
}
function computeStage(requestStatus, kotStatus) {
  if (kotStatus === 'ready') return 'ready'
  if (kotStatus === 'in_progress') return 'preparing'
  if (kotStatus === 'new') return 'kot_sent'
  if (requestStatus === 'accepted') return 'confirmed'
  return 'placed'
}

// Short ascending two-tone chime — same Web Audio synthesis approach as the staff-side alert in
// PosOrders.jsx (no audio asset to ship), just pitched the other way round so it reads as a
// distinct "your order updated" cue rather than the staff's "new order arrived" one.
function playStageChangeChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const now = ctx.currentTime
    ;[660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, now + i * 0.15)
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.15 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.15 + 0.14)
      osc.connect(gain); gain.connect(ctx.destination)
      osc.start(now + i * 0.15)
      osc.stop(now + i * 0.15 + 0.15)
    })
  } catch (_) { /* audio blocked or unsupported — the status card still updates visually */ }
}

const sessionKey = tableId => `guestOrderReq:${tableId}`
function loadStoredRequest(tableId) {
  try {
    const raw = sessionStorage.getItem(sessionKey(tableId))
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// Fully public, unauthenticated page — reached by a guest scanning a table's QR code (see
// PosTableManagement.jsx's "Print QR" action). Shows the live POS menu for that table's client;
// if the client has guest_ordering enabled (Pro-tier feature flag, see migration
// 20260707210000_guest_ordering.sql) guests can also add items to a cart and submit an order.
// A submitted order lands as a 'pending' pos_guest_order_requests row, NOT directly in
// pos_order_items — a staff member must review and Accept it in PosOrders.jsx before it becomes
// part of the real order. All data comes from get_guest_menu, which does its own authorization
// (table → client → pos_enabled check) since there's no logged-in session here to gate on.
export default function GuestMenu() {
  const { tableId } = useParams()
  const [rows, setRows] = useState(null) // null = loading, [] = loaded-but-empty
  const [error, setError] = useState(false)
  const [kotStatus, setKotStatus] = useState(null) // null = no open order / nothing sent yet

  const [cart, setCart] = useState({}) // recipe_id -> qty
  const [covers, setCovers] = useState(2)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [guestNote, setGuestNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [requestId, setRequestId] = useState(() => loadStoredRequest(tableId)?.requestId || null)
  // { items: [{name, qty}], covers } — kept alongside the request id so the confirmation card can
  // show what was actually ordered even after items/cart are cleared, and survives a page reload.
  const [requestSnapshot, setRequestSnapshot] = useState(() => {
    const stored = loadStoredRequest(tableId)
    return stored ? { items: stored.items || [], covers: stored.covers || 1 } : null
  })
  const [requestStatus, setRequestStatus] = useState(null)

  useEffect(() => {
    let cancelled = false
    supabase.rpc('get_guest_menu', { p_table_id: tableId }).then(({ data, error: err }) => {
      if (cancelled) return
      if (err) { setError(true); setRows([]); return }
      setRows(data || [])
    })
    return () => { cancelled = true }
  }, [tableId])

  // 5s poll while the guest has the menu open — same cadence as the staff floor-view badge.
  useEffect(() => {
    let cancelled = false
    const poll = () => supabase.rpc('get_guest_table_status', { p_table_id: tableId }).then(({ data }) => {
      if (cancelled) return
      const row = data?.[0]
      setKotStatus(row?.has_open_order ? row.kot_status : null)
    })
    poll()
    const id = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [tableId])

  // Poll the guest's own submitted request, if any, for staff Accept/Dismiss.
  useEffect(() => {
    if (!requestId) return
    let cancelled = false
    const poll = () => supabase.rpc('get_guest_order_request_status', { p_request_id: requestId }).then(({ data }) => {
      if (cancelled) return
      const row = data?.[0]
      if (row) setRequestStatus(row.status)
    })
    poll()
    const id = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [requestId])

  // Chime once whenever the guest's own order actually advances a stage (placed → confirmed →
  // sent to kitchen → preparing → ready, or dismissed) — not on every 5s poll that finds no
  // change. null on first render (nothing to compare against yet) so mounting never chimes.
  const prevStageRef = useRef(null)
  useEffect(() => {
    if (!requestId) return
    const stage = requestStatus === 'dismissed' ? 'dismissed' : computeStage(requestStatus, kotStatus)
    if (prevStageRef.current !== null && prevStageRef.current !== stage) {
      playStageChangeChime()
    }
    prevStageRef.current = stage
  }, [requestId, requestStatus, kotStatus])

  if (rows === null) {
    return <CenteredMessage>Loading menu…</CenteredMessage>
  }
  if (error || rows.length === 0) {
    return <CenteredMessage>
      Menu not available. Please ask staff for assistance.
    </CenteredMessage>
  }

  const outletName = rows[0].outlet_name
  const tableName = rows[0].table_name
  const nutritionEnabled = rows[0].nutrition_enabled
  const orderingEnabled = rows[0].guest_ordering_enabled

  const byRecipe = Object.fromEntries(rows.map(r => [r.recipe_id, r]))
  const categories = []
  const byCategory = {}
  for (const r of rows) {
    const cat = r.category || 'Other'
    if (!byCategory[cat]) { byCategory[cat] = []; categories.push(cat) }
    byCategory[cat].push(r)
  }

  const cartLines = Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .map(([recipeId, qty]) => ({ item: byRecipe[recipeId], qty }))
    .filter(l => l.item)
  const cartCount = cartLines.reduce((s, l) => s + l.qty, 0)
  const cartTotal = cartLines.reduce((s, l) => s + priceIncVat(l.item) * l.qty, 0)

  function setQty(recipeId, qty) {
    setCart(prev => ({ ...prev, [recipeId]: Math.max(0, Math.min(50, qty)) }))
  }

  async function placeOrder() {
    setSubmitting(true)
    setSubmitError('')
    const payload = cartLines.map(l => ({ recipe_id: l.item.recipe_id, qty: l.qty }))
    const itemsSnapshot = cartLines.map(l => ({ name: l.item.name, qty: l.qty }))
    const { data, error: err } = await supabase.rpc('submit_guest_order', {
      p_table_id: tableId, p_items: payload, p_notes: guestNote || null, p_covers: covers,
    })
    setSubmitting(false)
    if (err) {
      setSubmitError(err.message || 'Could not place order — please ask staff for assistance.')
      return
    }
    sessionStorage.setItem(sessionKey(tableId), JSON.stringify({ requestId: data, items: itemsSnapshot, covers }))
    setRequestId(data)
    setRequestSnapshot({ items: itemsSnapshot, covers })
    setRequestStatus('pending')
    setCart({})
    setGuestNote('')
    setCovers(2)
    setReviewOpen(false)
  }

  function orderAgain() {
    sessionStorage.removeItem(sessionKey(tableId))
    setRequestId(null)
    setRequestSnapshot(null)
    setRequestStatus(null)
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--theme-bg)', color: 'var(--theme-text1)' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '28px 20px 100px' }}>
        <div style={{ textAlign: 'center', marginBottom: 20 }}>
          <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700 }}>{outletName}</h1>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>{tableName}</p>
        </div>

        {requestSnapshot ? (
          <OrderStatusCard
            requestStatus={requestStatus} kotStatus={kotStatus}
            items={requestSnapshot.items} covers={requestSnapshot.covers}
            onOrderAgain={orderAgain}
          />
        ) : kotStatus && (
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <span className={KOT_STATUS_BADGE[kotStatus]} style={{ display: 'inline-block', fontSize: 11 }}>
              {KOT_STATUS_LABEL[kotStatus]}
            </span>
          </div>
        )}

        {categories.map(cat => (
          <div key={cat} style={{ marginBottom: 28 }}>
            <h2 style={{
              fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
              color: 'var(--theme-accent)', margin: '0 0 12px', paddingBottom: 6,
              borderBottom: '1px solid var(--theme-border)',
            }}>{cat}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {byCategory[cat].map(item => (
                <MenuItemCard
                  key={item.recipe_id} item={item} nutritionEnabled={nutritionEnabled}
                  orderingEnabled={orderingEnabled}
                  qty={cart[item.recipe_id] || 0}
                  onQtyChange={qty => setQty(item.recipe_id, qty)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {orderingEnabled && cartCount > 0 && (
        <button
          onClick={() => setReviewOpen(true)}
          style={{
            position: 'fixed', left: 16, right: 16, bottom: 16, zIndex: 50,
            maxWidth: 608, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 18px', borderRadius: 10, border: 'none', cursor: 'pointer',
            background: 'var(--theme-accent)', color: '#fff', fontSize: 14, fontWeight: 700,
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
          }}
        >
          <span>{cartCount} item{cartCount > 1 ? 's' : ''} · {fmtNpr(cartTotal)}</span>
          <span>View Order →</span>
        </button>
      )}

      {reviewOpen && (
        <Modal title="Your Order" onClose={() => setReviewOpen(false)} maxWidth={480}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {cartLines.length === 0 && <p style={{ fontSize: 13, color: 'var(--theme-text2)' }}>Your cart is empty.</p>}
            {cartLines.map(l => (
              <div key={l.item.recipe_id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ flex: 1, fontSize: 14 }}>{l.item.name}</span>
                <Stepper qty={l.qty} onChange={qty => setQty(l.item.recipe_id, qty)} />
                <span style={{ width: 74, textAlign: 'right', fontSize: 13, color: 'var(--theme-text2)' }}>
                  {fmtNpr(priceIncVat(l.item) * l.qty)}
                </span>
              </div>
            ))}
            {cartLines.length > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: 15, marginTop: 6, paddingTop: 10, borderTop: '1px solid var(--theme-border)' }}>
                  <span>Total</span>
                  <span>{fmtNpr(cartTotal)}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                  <span style={{ fontSize: 13 }}>How many of you are dining?</span>
                  <Stepper qty={covers} onChange={n => setCovers(Math.max(1, Math.min(50, n)))} />
                </div>
                <textarea
                  value={guestNote} onChange={e => setGuestNote(e.target.value)}
                  placeholder="Any notes for the kitchen? (optional)"
                  rows={2}
                  style={{
                    marginTop: 8, width: '100%', resize: 'vertical', borderRadius: 6,
                    border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)',
                    color: 'var(--theme-text1)', padding: '8px 10px', fontSize: 13, boxSizing: 'border-box',
                  }}
                />
                {submitError && <p style={{ color: 'var(--theme-red)', fontSize: 12.5, margin: 0 }}>{submitError}</p>}
                <button
                  className="btn btn-primary" disabled={submitting} onClick={placeOrder}
                  style={{ marginTop: 4 }}
                >
                  {submitting ? 'Placing order…' : 'Place Order'}
                </button>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

function OrderStatusCard({ requestStatus, kotStatus, items, covers, onOrderAgain }) {
  if (requestStatus === 'dismissed') {
    return (
      <div className="card" style={{ padding: 16, marginBottom: 24, borderColor: 'var(--theme-red)' }}>
        <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--theme-red)' }}>
          Staff couldn't take this order
        </p>
        <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--theme-text2)' }}>
          Please ask a staff member for assistance.
        </p>
        <button className="btn btn-ghost" style={{ marginTop: 10, fontSize: 12 }} onClick={onOrderAgain}>Order again</button>
      </div>
    )
  }

  const stage = computeStage(requestStatus, kotStatus)
  const stageIdx = STAGES.indexOf(stage)

  return (
    <div className="card" style={{ padding: 16, marginBottom: 24, borderColor: 'var(--theme-accent)' }}>
      <p style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>
        {STAGE_LABEL[stage]}
      </p>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        {STAGES.map((s, i) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', flex: i < STAGES.length - 1 ? 1 : '0 0 auto' }}>
            <div style={{
              width: 11, height: 11, borderRadius: '50%', flexShrink: 0,
              background: i <= stageIdx ? 'var(--theme-accent)' : 'var(--theme-border)',
              transition: 'background 0.2s',
            }} />
            {i < STAGES.length - 1 && (
              <div style={{
                flex: 1, height: 2, margin: '0 2px',
                background: i < stageIdx ? 'var(--theme-accent)' : 'var(--theme-border)',
                transition: 'background 0.2s',
              }} />
            )}
          </div>
        ))}
      </div>
      {items?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 10, borderTop: '1px solid var(--theme-border)' }}>
          {items.map((it, i) => (
            <span key={i} style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{it.qty}× {it.name}</span>
          ))}
          {covers > 0 && (
            <span style={{ fontSize: 11.5, color: 'var(--theme-text3)', marginTop: 4 }}>{covers} guest{covers > 1 ? 's' : ''}</span>
          )}
        </div>
      )}
    </div>
  )
}

function Stepper({ qty, onChange }) {
  const btn = {
    width: 26, height: 26, borderRadius: 4, border: '1px solid var(--theme-border)',
    background: 'var(--theme-input-bg)', color: 'var(--theme-text1)', cursor: 'pointer',
    fontSize: 15, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button type="button" style={btn} onClick={() => onChange(qty - 1)}>−</button>
      <span style={{ minWidth: 18, textAlign: 'center', fontSize: 13 }}>{qty}</span>
      <button type="button" style={btn} onClick={() => onChange(qty + 1)}>+</button>
    </div>
  )
}

function MenuItemCard({ item, nutritionEnabled, orderingEnabled, qty, onQtyChange }) {
  const [imgFailed, setImgFailed] = useState(false)
  const priceInc = priceIncVat(item)

  return (
    <div className="card" style={{ display: 'flex', gap: 14, padding: 14 }}>
      {item.image_url && !imgFailed && (
        <img
          src={item.image_url} alt={item.name} onError={() => setImgFailed(true)}
          style={{ width: 84, height: 84, borderRadius: 8, objectFit: 'cover', flexShrink: 0, background: 'var(--theme-input-bg)' }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {item.is_veg != null && (
              <span title={item.is_veg ? 'Veg' : 'Non-Veg'} style={{
                display: 'inline-block', width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                border: `1.5px solid ${item.is_veg ? 'var(--theme-green)' : 'var(--theme-red)'}`,
              }}>
                <span style={{
                  display: 'block', width: 6, height: 6, margin: '2px auto', borderRadius: '50%',
                  background: item.is_veg ? 'var(--theme-green)' : 'var(--theme-red)',
                }} />
              </span>
            )}
            <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--theme-text1)' }}>{item.name}</span>
          </div>
          <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--theme-accent)', whiteSpace: 'nowrap' }}>{fmtNpr(priceInc)}</span>
        </div>
        {item.description && (
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--theme-text2)', lineHeight: 1.4 }}>{item.description}</p>
        )}
        {nutritionEnabled && item.has_nutrition && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
            {NUTRIENTS.map(def => (
              <span key={def.key} style={{ fontSize: 10.5, color: 'var(--theme-text3)' }}>
                {def.label} {fmtNutrient(def, item[def.key])}
              </span>
            ))}
          </div>
        )}
        {nutritionEnabled && item.has_nutrition && item.allergens?.length > 0 && (
          <p style={{ margin: '4px 0 0', fontSize: 10.5, color: 'var(--theme-amber)', textTransform: 'capitalize' }}>
            Allergens: {item.allergens.join(', ')}
          </p>
        )}
        {orderingEnabled && (
          <div style={{ marginTop: 10 }}>
            {qty > 0 ? (
              <Stepper qty={qty} onChange={onQtyChange} />
            ) : (
              <button
                type="button" className="btn btn-ghost" style={{ fontSize: 12.5, padding: '4px 12px' }}
                onClick={() => onQtyChange(1)}
              >+ Add</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function CenteredMessage({ children }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--theme-bg)', color: 'var(--theme-text2)', fontSize: 14, padding: 24, textAlign: 'center',
    }}>
      {children}
    </div>
  )
}
