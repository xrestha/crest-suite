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
  placed: 'Order placed. Waiting for staff to confirm…',
  confirmed: 'Confirmed by staff, heading to the kitchen',
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

// A cart in progress (not yet submitted) is just as vulnerable to a phone lock, incoming call,
// or accidental tab switch as a submitted request already was — this survives that the same way
// loadStoredRequest/sessionKey above do for a submitted one.
const cartSessionKey = tableId => `guestCart:${tableId}`
function loadStoredCart(tableId) {
  try {
    const raw = sessionStorage.getItem(cartSessionKey(tableId))
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
  // Minutes until the kitchen's estimated ready time (get_guest_table_status), only ever set
  // while kotStatus === 'in_progress' and at least one in-progress ticket has an estimate on it —
  // NULL otherwise, including once it goes non-positive (see the >0 guards below this is used
  // with) so a guest is never shown a negative "your food is late" countdown.
  const [remainingMinutes, setRemainingMinutes] = useState(null)

  const [cart, setCart] = useState(() => loadStoredCart(tableId)?.cart || {}) // recipe_id -> qty
  const [covers, setCovers] = useState(() => loadStoredCart(tableId)?.covers ?? 2)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [guestNote, setGuestNote] = useState(() => loadStoredCart(tableId)?.guestNote || '')
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
  const prevStageRef = useRef(null)
  // True for a few seconds right after this guest's own placeOrder() call succeeds — separate
  // from the stage-change chime below, which deliberately stays silent on mount/reload so a
  // returning guest isn't chimed at for an order they placed minutes ago. This one always fires,
  // including the very first order, because it's tied to an explicit action just taken, not to
  // detecting a change since last render.
  const [justPlaced, setJustPlaced] = useState(false)
  const statusCardRef = useRef(null)

  const [activeCategory, setActiveCategory] = useState(null)
  const categoryRefs = useRef({}) // category name -> section DOM node, populated during render

  // requestId/requestSnapshot above are only seeded once, via a lazy useState initializer that
  // runs on mount — if tableId changes without a full remount (client-side back/forward between
  // two different tables' QR links in the same tab, or a shared kiosk device reused across guest
  // turns), they'd otherwise keep showing the PREVIOUS table's order status. Re-derive everything
  // per-table here instead, including clearing any half-filled cart from the previous table so it
  // can never accidentally get submitted against the wrong one.
  useEffect(() => {
    const stored = loadStoredRequest(tableId)
    setRequestId(stored?.requestId || null)
    setRequestSnapshot(stored ? { items: stored.items || [], covers: stored.covers || 1 } : null)
    setRequestStatus(null)
    prevStageRef.current = null
    const storedCart = loadStoredCart(tableId)
    setCart(storedCart?.cart || {})
    setCovers(storedCart?.covers ?? 2)
    setGuestNote(storedCart?.guestNote || '')
    setSubmitError('')
    setReviewOpen(false)
  }, [tableId])

  // Persist the in-progress cart on every change so a phone lock, incoming call, or accidental
  // tab switch doesn't silently wipe it — the same protection the submitted-request snapshot
  // above already had via sessionStorage, just extended to the pre-submission cart.
  useEffect(() => {
    try {
      sessionStorage.setItem(cartSessionKey(tableId), JSON.stringify({ cart, covers, guestNote }))
    } catch { /* private-browsing / quota — cart still works for this session, just won't survive a reload */ }
  }, [tableId, cart, covers, guestNote])

  // retryToken bumps on a manual Retry click, forcing the effect below to re-run against the
  // same tableId — same effect this ran on mount, just re-triggerable from a button instead of
  // only from a tableId change.
  const [retryToken, setRetryToken] = useState(0)
  const retryLoadMenu = () => { setRows(null); setError(false); setRetryToken(t => t + 1) }

  useEffect(() => {
    let cancelled = false
    supabase.rpc('get_guest_menu', { p_table_id: tableId }).then(({ data, error: err }) => {
      if (cancelled) return
      if (err) { setError(true); setRows([]); return }
      setRows(data || [])
    })
    return () => { cancelled = true }
  }, [tableId, retryToken])

  // 5s poll while the guest has the menu open — same cadence as the staff floor-view badge.
  useEffect(() => {
    let cancelled = false
    const poll = () => supabase.rpc('get_guest_table_status', { p_table_id: tableId }).then(({ data }) => {
      if (cancelled) return
      const row = data?.[0]
      setKotStatus(row?.has_open_order ? row.kot_status : null)
      setRemainingMinutes(row?.has_open_order ? (row.remaining_minutes ?? null) : null)
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
  useEffect(() => {
    if (!requestId) return
    const stage = requestStatus === 'dismissed' ? 'dismissed' : computeStage(requestStatus, kotStatus)
    if (prevStageRef.current !== null && prevStageRef.current !== stage) {
      playStageChangeChime()
    }
    prevStageRef.current = stage
  }, [requestId, requestStatus, kotStatus])

  // Scroll the confirmation card into view and chime the instant an order is placed — the
  // review modal has just closed, so without this the guest lands back on a menu list with no
  // visible sign anything happened. Runs once per justPlaced=true, then clears itself; the pulse
  // classes (guest-order-glow/guest-order-banner) fade back to a normal card after ~2.8s (two
  // animation cycles) rather than looping forever on a page the guest may sit on.
  useEffect(() => {
    if (!justPlaced) return
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    statusCardRef.current?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
    playStageChangeChime()
    const id = setTimeout(() => setJustPlaced(false), 2800)
    return () => clearTimeout(id)
  }, [justPlaced])

  // Computed unconditionally (safe on the loading/error/empty renders too, via the `rows || []`
  // fallback) so the category-nav effect right below — a hook, which can't follow a conditional
  // early return — has something stable to key off of.
  const byRecipe = Object.fromEntries((rows || []).map(r => [r.recipe_id, r]))
  const categories = []
  const byCategory = {}
  for (const r of (rows || [])) {
    const cat = r.category || 'Other'
    if (!byCategory[cat]) { byCategory[cat] = []; categories.push(cat) }
    byCategory[cat].push(r)
  }

  // Default the highlighted chip to the first category before the guest has scrolled at all —
  // otherwise the bar renders with no active chip until the observer's first callback fires.
  useEffect(() => {
    if (categories.length > 0 && activeCategory === null) setActiveCategory(categories[0])
  }, [categories.join('|'), activeCategory]) // eslint-disable-line react-hooks/exhaustive-deps

  // Track which category section is currently in view so the sticky chip bar can highlight it —
  // only meaningful (and only wired up) once there's more than one category to navigate between.
  useEffect(() => {
    if (categories.length < 2) return
    const targets = categories.map(cat => categoryRefs.current[cat]).filter(Boolean)
    if (targets.length === 0) return
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.filter(e => e.isIntersecting)
        if (visible.length === 0) return
        // Topmost visible section wins — matches "which category am I looking at" better than
        // largest-intersection-ratio when a short category is fully visible alongside a long one.
        const top = visible.reduce((a, b) => (a.boundingClientRect.top < b.boundingClientRect.top ? a : b))
        const cat = categories.find(c => categoryRefs.current[c] === top.target)
        if (cat) setActiveCategory(cat)
      },
      { rootMargin: '-60px 0px -70% 0px', threshold: 0 } // -60px ~= sticky nav bar height (52px) + a small buffer
    )
    targets.forEach(el => observer.observe(el))
    return () => observer.disconnect()
  }, [categories.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  function scrollToCategory(cat) {
    setActiveCategory(cat)
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    categoryRefs.current[cat]?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' })
  }

  if (rows === null) {
    return <CenteredMessage>Loading menu…</CenteredMessage>
  }
  if (error) {
    return (
      <CenteredMessage>
        <p style={{ margin: '0 0 14px' }}>We couldn't reach the menu. Check your connection and try again.</p>
        <button type="button" className="btn btn-primary" onClick={retryLoadMenu}>Try again</button>
      </CenteredMessage>
    )
  }
  if (rows.length === 0) {
    return <CenteredMessage>
      This menu isn't available right now. Please ask staff for assistance.
    </CenteredMessage>
  }

  const outletName = rows[0].outlet_name
  const tableName = rows[0].table_name
  const nutritionEnabled = rows[0].nutrition_enabled
  const orderingEnabled = rows[0].guest_ordering_enabled

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
    // Force a false->true transition even if a previous order's pulse hasn't finished yet
    // (e.g. a guest immediately places a second order) — React bails out of the justPlaced
    // effect on a same-value update, which would otherwise silently skip the scroll/chime.
    setJustPlaced(false)
    const payload = cartLines.map(l => ({ recipe_id: l.item.recipe_id, qty: l.qty }))
    const itemsSnapshot = cartLines.map(l => ({ name: l.item.name, qty: l.qty }))
    const { data, error: err } = await supabase.rpc('submit_guest_order', {
      p_table_id: tableId, p_items: payload, p_notes: guestNote || null, p_covers: covers,
    })
    setSubmitting(false)
    if (err) {
      setSubmitError(err.message || 'Could not place order. Please ask staff for assistance.')
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
    setJustPlaced(true)
  }

  function orderAgain() {
    sessionStorage.removeItem(sessionKey(tableId))
    setRequestId(null)
    setRequestSnapshot(null)
    setRequestStatus(null)
    // Without this, prevStageRef stays at 'dismissed' — the next order's first 'placed' stage
    // would then look like a change from mount's perspective and chime immediately, when it
    // should stay silent just like a fresh page load does.
    prevStageRef.current = null
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--theme-bg)', color: 'var(--theme-text1)' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '28px 20px 100px', '--guest-menu-nav-h': '52px' }}>
        {/* This is the one page PRODUCT.md names as the deliberate brand-facing exception — a
            guest's own leisurely browsing moment, not an ops screen — so the outlet name gets the
            same Georgia serif signature the sidebar wordmark and login screen use, rather than
            reading identically to every staff tool in the app. */}
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <h1 style={{ margin: '0 0 10px', fontSize: 30, fontWeight: 700, fontFamily: 'Georgia, serif', letterSpacing: '0.01em' }}>{outletName}</h1>
          {/* A short brass rule — the one restrained brand signature on this, the sole brand-facing
              page (PRODUCT.md), giving a diner's menu a touch more identity than a staff tool without
              breaking the One Accent Rule. */}
          <div aria-hidden="true" style={{ width: 34, height: 2, borderRadius: 1, background: 'var(--theme-accent)', margin: '0 auto 10px' }} />
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>{tableName}</p>
        </div>

        {categories.length > 1 && (
          <div
            className="tab-bar tab-bar--scroll"
            style={{
              position: 'sticky', top: 0, zIndex: 40, marginBottom: 20,
              padding: '10px 0', background: 'var(--theme-bg)', borderBottom: '1px solid var(--theme-border)',
            }}
          >
            {categories.map(cat => (
              <button
                key={cat} type="button"
                className={`tab-btn${activeCategory === cat ? ' tab-btn--active' : ''}`}
                aria-current={activeCategory === cat ? 'true' : undefined}
                onClick={() => scrollToCategory(cat)}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {requestSnapshot ? (
          <div
            ref={statusCardRef} className={justPlaced ? 'guest-order-glow' : undefined}
            style={{ borderRadius: 10, scrollMarginTop: categories.length > 1 ? 'var(--guest-menu-nav-h)' : 0 }}
            aria-live="polite"
          >
            <OrderStatusCard
              requestStatus={requestStatus} kotStatus={kotStatus} remainingMinutes={remainingMinutes}
              items={requestSnapshot.items} covers={requestSnapshot.covers}
              onOrderAgain={orderAgain}
            />
          </div>
        ) : kotStatus && (
          <div style={{ textAlign: 'center', marginBottom: 20 }}>
            <span className={`badge ${KOT_STATUS_BADGE[kotStatus]}`} style={{ display: 'inline-block', fontSize: 11 }}>
              {KOT_STATUS_LABEL[kotStatus]}
              {kotStatus === 'in_progress' && remainingMinutes > 0 && ` — about ${remainingMinutes} min left`}
            </span>
          </div>
        )}

        {categories.map(cat => (
          <div
            key={cat} ref={el => { categoryRefs.current[cat] = el }}
            style={{ marginBottom: 28, scrollMarginTop: 'var(--guest-menu-nav-h)' }}
          >
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
            background: 'var(--theme-accent)', color: 'var(--theme-accent-text)', fontSize: 14, fontWeight: 700,
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
                {submitError && <p role="alert" style={{ color: 'var(--theme-red)', fontSize: 12.5, margin: 0 }}>{submitError}</p>}
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

function OrderStatusCard({ requestStatus, kotStatus, remainingMinutes, items, covers, onOrderAgain }) {
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
  // "About" rather than a bare countdown — this is the kitchen's own estimate, not a measured
  // time, so the wording deliberately avoids reading as a precise promise. Omitted once it's
  // no longer positive rather than showing a negative/overdue number to a paying guest.
  const stageLabel = stage === 'preparing' && remainingMinutes > 0
    ? `Being prepared — about ${remainingMinutes} min left`
    : STAGE_LABEL[stage]

  return (
    <div className="card" style={{ padding: 16, marginBottom: 24, borderColor: 'var(--theme-accent)' }}>
      <p style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>
        {stageLabel}
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
  // Matches posOrdersConstants.js's btnSm sizing — same widget, same touch-target standard,
  // and here on the guest's own phone there's no cramped side panel forcing a smaller size.
  const btn = {
    width: 40, height: 40, borderRadius: 8, border: '1px solid var(--theme-border)',
    background: 'var(--theme-input-bg)', color: 'var(--theme-text1)', cursor: 'pointer',
    fontSize: 18, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button type="button" style={btn} aria-label="Decrease quantity" onClick={() => onChange(qty - 1)}>−</button>
      <span style={{ minWidth: 20, textAlign: 'center', fontSize: 14 }} aria-live="polite">{qty}</span>
      <button type="button" style={btn} aria-label="Increase quantity" onClick={() => onChange(qty + 1)}>+</button>
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
          loading="lazy" decoding="async"
          style={{ width: 84, height: 84, borderRadius: 8, objectFit: 'cover', flexShrink: 0, background: 'var(--theme-input-bg)' }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {item.is_veg != null && (
              <span
                role="img"
                aria-label={item.is_veg ? 'Vegetarian' : 'Non-vegetarian'}
                title={item.is_veg ? 'Veg' : 'Non-Veg'}
                style={{
                  display: 'inline-block', width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                  border: `1.5px solid ${item.is_veg ? 'var(--theme-green)' : 'var(--theme-red)'}`,
                }}>
                <span aria-hidden="true" style={{
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
