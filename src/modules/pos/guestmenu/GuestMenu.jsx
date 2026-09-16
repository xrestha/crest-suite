import { npr } from '../../../shared/nepalMoney'
import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { Plus, Minus, X, Search, SlidersHorizontal, ChevronRight } from 'lucide-react'
import { supabase } from '../../../supabaseClient'
import { NUTRIENTS } from '../../../utils/nutrition'
import { withTimeout } from '../../../utils/withTimeout'
import { DEFAULT_RECIPE_CATS } from '../../../context/SettingsContext'
import Modal from '../../../components/Modal'
import { useGuestDocumentIdentity } from './guestDocument'
import { guestOrderRefusal } from './guestOrderRefusal'
import GuestOptionSheet from './GuestOptionSheet'
import { groupsForDish, describeSelection, lowestDishPrice, selectionProblems, inclFromEx } from '../../../shared/optionPricing'
import { selectionKeyOf } from '../orders/posOrdersConstants'
import { playChime } from '../posChime'
import {
  tidyName, orderCategories, matchesSearch, SEARCH_THRESHOLD,
  STAGES, STAGE_SHORT, stageFromProgress, laterStage,
} from './guestMenuHelpers'
// The page's structure, the order tracker, the choice sheet and the touch tier. Colour comes from the
// app theme, which ThemeContext pins to the default preset on this route (S767) — see the header
// of guestMenu.css.
import './guestMenu.css'

const fmtNpr = npr
const fmtNutrient = (def, value) => `${(Number(value) || 0).toFixed(def.dp)} ${def.unit}`
// The price a guest will actually be charged for one of these.
//
// `vatRegistered` is NOT optional and must not be defaulted here. The till applies vat_rate only
// when `settings.is_vat_registered` (`computeOrderAmounts` in utils/posBillingMath.js) and prints
// "BILL" rather than "TAX INVOICE" when it is false — this page used to apply it unconditionally,
// so a non-registered outlet advertised every dish ~13% above what it then billed. Taking the flag
// as a required argument is what stops that drifting back: a call site that forgets it gets
// `undefined`, i.e. no VAT, which is the safe direction (a menu that understates is a smaller
// betrayal than one that overstates) and is visibly wrong on a registered client's own menu.
const priceIncVat = (item, vatRegistered) =>
  Math.round((parseFloat(item.selling_price) || 0) * (1 + (vatRegistered ? (parseFloat(item.vat_rate) || 0) : 0)))

// A guest who never ordered from this phone but sits at a table staff opened still sees what the
// kitchen is doing with the table's order. Neutral for "sent" — it is the normal state of every order
// ever taken, and the danger colour it used to wear read as something having gone wrong (S767).
const KOT_STATUS_BADGE = { new: 'badge-gray', in_progress: 'badge-gray', ready: 'badge-green' }
const KOT_STATUS_LABEL = { new: 'Your table’s order is with the kitchen', in_progress: 'Your table’s order is being prepared', ready: 'Your table’s order is ready' }

const STAGE_LABEL = {
  placed: 'Order sent. Waiting for staff to accept it.',
  confirmed: 'Accepted. It goes to the kitchen next.',
  kot_sent: 'With the kitchen.',
  preparing: 'Being prepared.',
  ready: 'Ready to serve.',
}

// Ascending, where the staff-side alert descends, so it reads as "your order updated" rather than
// the staff's "new order arrived". It is `playChime` with the tones reversed since S763 — the
// inline copy this replaces built a new AudioContext per stage change and never closed one, and a
// guest whose order walks Placed → Confirmed → Sent → Preparing → Ready is five of the six Chrome
// allows before it stops making any sound.
function playStageChangeChime() { playChime([660, 880], 0.15) }

// The submit is bounded. A stalled call used to leave "Placing order…" on screen indefinitely with
// no way out (measured past 25 s in the critique); the booking page already bounds its submit at 20.
const SUBMIT_TIMEOUT_MS = 20000

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
    if (!raw) return null
    const stored = JSON.parse(raw)
    return stored ? { ...stored, cart: normalizeCart(stored.cart) } : null
  } catch {
    return null
  }
}

// The cart is { [lineKey]: { recipe_id, qty, option_ids } } since Crest Customization (S758): the
// same dish with different choices is two lines. A cart saved by the page before that was
// { recipe_id: qty } and is read as plain lines, so a guest mid-order across a deploy keeps it.
const cartKey = (recipeId, optionIds) => {
  const sel = selectionKeyOf(optionIds)
  return sel ? `${recipeId}#${sel}` : recipeId
}
function normalizeCart(cart) {
  const out = {}
  for (const [key, v] of Object.entries(cart || {})) {
    if (typeof v === 'number') { if (v > 0) out[key] = { recipe_id: key, qty: v, option_ids: [] } }
    else if (v && v.recipe_id && Number(v.qty) > 0) out[key] = { recipe_id: v.recipe_id, qty: Number(v.qty), option_ids: v.option_ids || [] }
  }
  return out
}

// `UNCATEGORISED` is a sentinel, not a heading. An item with no category used to land in a section
// literally titled "OTHER" on a paying customer's screen — a database default reaching a diner. It
// renders with no heading at all when it is the only group, and as "More" beside real ones.
// Built with fromCharCode rather than written as an escape: a scripted edit collapsed the backslash
// once already and embedded a literal NUL byte in this file, which makes the whole source read as
// BINARY to grep, ripgrep and every review tool. Keep the source plain text.
const UNCATEGORISED = String.fromCharCode(0) + 'uncategorised'

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// ── Back closes the sheet ────────────────────────────────────────────────────────────────────────
// A phone's Back gesture with a sheet open used to leave the menu altogether (measured: the URL
// changed to the previous page). Opening a sheet pushes one history entry; Back pops it and closes
// the TOPMOST sheet only; closing with a control takes the entry off again. One module-level stack,
// because the choice sheet opens on top of the order sheet ("Edit choices"). The removal is deferred
// a tick so React StrictMode's mount-unmount-mount in development does not pop the entry it re-adds.
const sheetStack = []
function hasGuard() {
  try { return !!window.history.state?.guestSheet } catch { return false }
}
function pushGuard() {
  try { window.history.pushState({ ...(window.history.state || {}), guestSheet: true }, '') } catch { /* history unavailable */ }
}
function onGuestPopState() {
  const top = sheetStack[sheetStack.length - 1]
  if (!top) return
  top.onCloseRef.current()
  // A sheet is still open underneath: give Back something to close it with too.
  if (sheetStack.length > 1) pushGuard()
}
function useBackToClose(open, onClose, enabled = true) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    if (!open || !enabled) return undefined
    const entry = { onCloseRef }
    sheetStack.push(entry)
    if (sheetStack.length === 1) window.addEventListener('popstate', onGuestPopState)
    if (!hasGuard()) pushGuard()
    return () => {
      const i = sheetStack.indexOf(entry)
      if (i !== -1) sheetStack.splice(i, 1)
      if (sheetStack.length === 0) window.removeEventListener('popstate', onGuestPopState)
      setTimeout(() => { if (sheetStack.length === 0 && hasGuard()) window.history.back() }, 0)
    }
  }, [open, enabled])
}

// Fully public, unauthenticated page — reached by a guest scanning a table's QR code (see
// PosTableManagement.jsx's "Print QR" action). Shows the live POS menu for that table's client;
// guest ordering comes with the POS module (S632) and is off only at a table marked inactive
// (S746), so guests can also add items to a cart and submit an order.
// A submitted order lands as a 'pending' pos_guest_order_requests row, NOT directly in
// pos_order_items — a staff member must review and Accept it in PosOrders.jsx before it becomes
// part of the real order. All data comes from get_guest_menu, which does its own authorization
// (table → client → pos_enabled check) since there's no logged-in session here to gate on.
export default function GuestMenu() {
  const { tableId } = useParams()
  const [rows, setRows] = useState(null) // null = loading, [] = loaded-but-empty
  const [error, setError] = useState(false)
  // Table-level kitchen status, for a guest with no order of their own on this phone (the badge).
  const [tableKot, setTableKot] = useState(null) // { kotStatus, remainingMinutes } | null

  const [cart, setCart] = useState(() => loadStoredCart(tableId)?.cart || {}) // lineKey -> { recipe_id, qty, option_ids }
  // Crest Customization (S758): { groups, options, attachments } from get_guest_menu_options. A failed
  // read keeps the menu and says so (optionsFailed); the server still refuses a dish that needed a choice.
  const [optionCatalog, setOptionCatalog] = useState({ groups: [], options: [], attachments: [] })
  const [optionsFailed, setOptionsFailed] = useState(false)
  // { item, dishGroups, editKey?, initialIds? } while the choice sheet is open.
  const [optionSheet, setOptionSheet] = useState(null)
  const [covers, setCovers] = useState(() => loadStoredCart(tableId)?.covers ?? 2)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [guestNote, setGuestNote] = useState(() => loadStoredCart(tableId)?.guestNote || '')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  // True when this page is rendered inside a frame, which in this product means Admin → Guest
  // Menu's preview. That preview is the real live page, so Place Order there used to send a
  // genuine order to the client's staff (S746, decided with Aashish). A guest's phone never frames
  // the page, so their view is unchanged. Reading window.top across origins throws; a foreign
  // frame counts as a preview too, which is the safe direction.
  const [inPreview] = useState(() => {
    try { return window.self !== window.top } catch { return true }
  })
  const [requestId, setRequestId] = useState(() => loadStoredRequest(tableId)?.requestId || null)
  // { items: [{name, qty}], lines: [{recipe_id, qty, option_ids}], covers } — kept alongside the
  // request id so the tracker can show what was ordered after the cart is cleared, survive a reload,
  // and put a refused order back in the cart.
  const [requestSnapshot, setRequestSnapshot] = useState(() => {
    const stored = loadStoredRequest(tableId)
    return stored ? { items: stored.items || [], lines: stored.lines || [], covers: stored.covers || 1 } : null
  })
  // What the server says about this guest's own order (get_guest_order_progress).
  const [progress, setProgress] = useState({ requestStatus: null, kotStatus: null, remainingMinutes: null, orderClosed: false })
  // The stage on screen. Never moves backwards (laterStage) and is reset for each new order.
  const [stage, setStage] = useState(null)
  const stageRef = useRef(null)
  const [statusStale, setStatusStale] = useState(false)
  // True for a few seconds right after this guest's own placeOrder() call succeeds — separate
  // from the stage-change chime below, which deliberately stays silent on mount/reload so a
  // returning guest isn't chimed at for an order they placed minutes ago.
  const [justPlaced, setJustPlaced] = useState(false)
  const statusCardRef = useRef(null)
  const [restoreNote, setRestoreNote] = useState('')

  const [activeCategory, setActiveCategory] = useState(null)
  const categoryRefs = useRef({}) // category name -> section DOM node, populated during render
  const chipRefs = useRef({})
  const chipBarRef = useRef(null)
  const navRef = useRef(null)
  const [navHeight, setNavHeight] = useState(0)
  // The page's own scrollport (guestMenu.css gives `.guest-menu` height:100dvh + overflow-y:auto).
  const scrollRootRef = useRef(null)
  // Set when a chip is tapped: that chip stays highlighted until the guest scrolls by hand. A
  // section near the end of the menu cannot scroll to the top of the screen, so a position-based
  // highlight used to light the section above the one just tapped.
  const tappedCategoryRef = useRef(null)

  // Veg-only + allergen-exclusion filters, and the dish search on a long menu.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [vegOnly, setVegOnly] = useState(false)
  const [excludedAllergens, setExcludedAllergens] = useState([])
  const [query, setQuery] = useState('')

  // requestId/requestSnapshot above are only seeded once, via a lazy useState initializer that
  // runs on mount — if tableId changes without a full remount (client-side back/forward between
  // two different tables' QR links in the same tab, or a shared kiosk device reused across guest
  // turns), they'd otherwise keep showing the PREVIOUS table's order status. Re-derive everything
  // per-table here instead, including clearing any half-filled cart from the previous table so it
  // can never accidentally get submitted against the wrong one.
  useEffect(() => {
    const stored = loadStoredRequest(tableId)
    setRequestId(stored?.requestId || null)
    setRequestSnapshot(stored ? { items: stored.items || [], lines: stored.lines || [], covers: stored.covers || 1 } : null)
    const storedCart = loadStoredCart(tableId)
    setCart(storedCart?.cart || {})
    setCovers(storedCart?.covers ?? 2)
    setGuestNote(storedCart?.guestNote || '')
    setSubmitError('')
    setReviewOpen(false)
    setQuery('')
  }, [tableId])

  // Persist the in-progress cart on every change so a phone lock, incoming call, or accidental
  // tab switch doesn't silently wipe it.
  useEffect(() => {
    try {
      sessionStorage.setItem(cartSessionKey(tableId), JSON.stringify({ cart, covers, guestNote }))
    } catch { /* private-browsing / quota — cart still works for this session, just won't survive a reload */ }
  }, [tableId, cart, covers, guestNote])

  // retryToken bumps on a manual Retry click, forcing the effect below to re-run against the
  // same tableId.
  const [retryToken, setRetryToken] = useState(0)
  const retryLoadMenu = () => { setRows(null); setError(false); setRetryToken(t => t + 1) }

  useEffect(() => {
    let cancelled = false
    supabase.rpc('get_guest_menu', { p_table_id: tableId }).then(({ data, error: err }) => {
      if (cancelled) return
      if (err) { setError(true); setRows([]); return }
      setRows(data || [])
    })
    loadOptions(() => cancelled)
    return () => { cancelled = true }
  }, [tableId, retryToken]) // eslint-disable-line react-hooks/exhaustive-deps

  function loadOptions(isCancelled = () => false) {
    return supabase.rpc('get_guest_menu_options', { p_table_id: tableId }).then(({ data, error: err }) => {
      if (isCancelled()) return null
      // PGRST202 is "no such function": the frontend deployed before migration 20260919140000. That
      // is every outlet's menu, not a failed read of one, so it reads as "no choices" rather than
      // putting a warning in front of every guest (the migration hot-path rule).
      if (err?.code === 'PGRST202') { setOptionsFailed(false); return null }
      if (err) { console.error('get_guest_menu_options failed', err); setOptionsFailed(true); return null }
      setOptionsFailed(false)
      // S760: build_your_own is absent before migration 20260920100000, which reads as "no dish is
      // build-your-own" — every dish keeps the one-screen sheet.
      const next = {
        groups: data?.groups || [], options: data?.options || [], attachments: data?.attachments || [],
        buildYourOwn: Array.isArray(data?.build_your_own) ? data.build_your_own : [],
      }
      setOptionCatalog(next)
      return next
    })
  }

  const optionMaps = useMemo(() => ({
    optionsById: Object.fromEntries(optionCatalog.options.map(o => [o.id, o])),
    groupsById: Object.fromEntries(optionCatalog.groups.map(g => [g.id, g])),
  }), [optionCatalog])
  const dishGroupsByRecipe = useMemo(() => {
    const out = {}
    for (const rid of new Set(optionCatalog.attachments.map(a => a.recipe_id))) {
      const dg = groupsForDish(rid, optionCatalog)
      if (dg.length) out[rid] = dg
    }
    return out
  }, [optionCatalog])

  // ── Polls ─────────────────────────────────────────────────────────────────────────────────────
  // Both polls run only while the page is visible (a phone with its screen off does not need a
  // status it cannot show) and poll once on becoming visible again. Two consecutive failures before
  // saying anything: one dropped request on a cafe's wifi is normal, and a banner that flickers on
  // every blip teaches the guest to ignore it. A failed read KEEPS the last known state — a stale but
  // true stage beats a confident wrong one (S604).
  //
  // With an order of their own on this phone, the guest's tracker reads get_guest_order_progress:
  // the bill that took THIS order, its tickets sent after the order was placed, and whether that bill
  // has closed (S767). Before that function existed the tracker read the TABLE's kitchen status, so a
  // second round showed the first round's "Ready", and a paid bill fell back to "heading to the
  // kitchen". A 404 on the function (frontend ahead of the migration) falls back to the old two reads,
  // with the backwards steps still refused by laterStage.
  useEffect(() => {
    let cancelled = false
    let failures = 0
    let id = null
    let legacy = false
    let sawOpenOrder = false

    const fail = () => { failures += 1; if (failures >= 2) setStatusStale(true) }
    const ok = () => { failures = 0; setStatusStale(false) }

    const pollTable = () => supabase.rpc('get_guest_table_status', { p_table_id: tableId })
    const pollOwn = async () => {
      if (!legacy) {
        const { data, error: err } = await supabase.rpc('get_guest_order_progress', { p_request_id: requestId })
        if (cancelled) return
        if (err?.code === 'PGRST202') { legacy = true }
        else if (err) { fail(); return }
        else {
          ok()
          const row = data?.[0]
          // No row: the request no longer exists (a restore, or POS switched off). Keep what we had.
          if (!row) return
          setProgress({ requestStatus: row.status, kotStatus: row.kot_status, remainingMinutes: row.remaining_minutes ?? null, orderClosed: !!row.order_closed })
          return
        }
      }
      const [{ data: req, error: reqErr }, { data: tbl, error: tblErr }] = await Promise.all([
        supabase.rpc('get_guest_order_request_status', { p_request_id: requestId }),
        pollTable(),
      ])
      if (cancelled) return
      if (reqErr || tblErr) { fail(); return }
      ok()
      const r = req?.[0]
      const t = tbl?.[0]
      if (t?.has_open_order) sawOpenOrder = true
      setProgress(prev => ({
        requestStatus: r?.status ?? prev.requestStatus,
        kotStatus: t?.has_open_order ? t.kot_status : null,
        remainingMinutes: t?.has_open_order ? (t.remaining_minutes ?? null) : null,
        orderClosed: (r?.status ?? prev.requestStatus) === 'accepted' && sawOpenOrder && !t?.has_open_order,
      }))
    }
    const pollBadge = async () => {
      const { data, error: err } = await pollTable()
      if (cancelled) return
      if (err) { fail(); return }
      ok()
      const t = data?.[0]
      setTableKot(t?.has_open_order && t.kot_status ? { kotStatus: t.kot_status, remainingMinutes: t.remaining_minutes ?? null } : null)
    }
    const poll = requestId ? pollOwn : pollBadge

    const start = () => { if (id === null) { poll(); id = setInterval(poll, 5000) } }
    const stop = () => { if (id !== null) { clearInterval(id); id = null } }
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop())
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [tableId, requestId])

  // A new order (or none) starts its tracker from nothing. `requestStatus: null` rather than a
  // presumed 'pending': the first REAL reading must be the one that seeds the stage, or a reload of
  // an order that is already ready would chime as though it had just become ready.
  useEffect(() => {
    stageRef.current = null
    setStage(null)
    setStatusStale(false)
    setProgress({ requestStatus: null, kotStatus: null, remainingMinutes: null, orderClosed: false })
  }, [requestId])

  // Advance the stage — only forwards — and chime once per real step. Silent on the first reading
  // after a mount or reload, so a returning guest isn't chimed at for an order placed minutes ago.
  useEffect(() => {
    if (!requestId || !progress.requestStatus) return
    const next = laterStage(stageRef.current, stageFromProgress(progress))
    if (stageRef.current !== null && next !== stageRef.current) playStageChangeChime()
    stageRef.current = next
    setStage(next)
  }, [requestId, progress])

  // Scroll the tracker into view and chime the instant an order is placed — the order sheet has
  // just closed, so without this the guest lands back on a menu list with no visible sign anything
  // happened. The glow fades after two cycles rather than looping on a page the guest may sit on.
  useEffect(() => {
    if (!justPlaced) return
    statusCardRef.current?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' })
    playStageChangeChime()
    const t = setTimeout(() => setJustPlaced(false), 2800)
    return () => clearTimeout(t)
  }, [justPlaced])

  // ── Menu derivations ──────────────────────────────────────────────────────────────────────────
  // Computed unconditionally (safe on the loading/error/empty renders too) so the hooks below have
  // something stable to key off of.
  const meta = rows?.[0] || null
  const displayName = (meta?.menu_name && meta.menu_name.trim()) || tidyName(meta?.outlet_name || '') || 'Menu'
  const logoUrl = meta?.logo_url || null
  const byRecipe = useMemo(() => Object.fromEntries((rows || []).map(r => [r.recipe_id, r])), [rows])

  const allAllergens = useMemo(() => Array.from(new Set((rows || []).flatMap(r => r.allergens || []))).sort(), [rows])
  const hasVegMarks = (rows || []).some(r => r.is_veg != null)
  const searchable = (rows || []).length > SEARCH_THRESHOLD
  const trimmedQuery = searchable ? query.trim() : ''

  const filteredRows = useMemo(() => (rows || []).filter(r =>
    (!vegOnly || r.is_veg) &&
    (excludedAllergens.length === 0 || !(r.allergens || []).some(a => excludedAllergens.includes(a))) &&
    matchesSearch({ name: tidyName(r.name), description: r.description, category: r.category }, trimmedQuery)
  ), [rows, vegOnly, excludedAllergens, trimmedQuery])
  const activeFilterCount = (vegOnly ? 1 : 0) + excludedAllergens.length

  const { categories, byCategory } = useMemo(() => {
    const present = []
    const groups = {}
    for (const r of filteredRows) {
      const cat = r.category || UNCATEGORISED
      if (!groups[cat]) { groups[cat] = []; present.push(cat) }
      groups[cat].push(r)
    }
    return { categories: orderCategories(present, meta?.category_order, DEFAULT_RECIPE_CATS, UNCATEGORISED), byCategory: groups }
  }, [filteredRows, meta])
  const categoryKey = categories.join('|')
  const categoryLabel = cat => (cat === UNCATEGORISED ? 'More' : tidyName(cat))

  // The tab, the address-bar colour and a saved home-screen shortcut belong to the restaurant, in
  // every state including loading and failure (guestDocument.js).
  useGuestDocumentIdentity(rows && rows.length > 0 ? `${displayName} — Menu` : 'Menu', rows && rows.length > 0 ? displayName : 'Menu', logoUrl)

  // The sticky bar's real height (it holds a search field on a long menu, and the chips are 44px on
  // a touch screen). A section jumped to lands BELOW it: the page used a fixed 52px while the bar
  // measured 65, so a tapped section's heading sat 13px under the bar.
  useEffect(() => {
    const el = navRef.current
    if (!el) { setNavHeight(0); return undefined }
    const measure = () => setNavHeight(Math.ceil(el.getBoundingClientRect().height))
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [categoryKey, searchable, rows])

  // Which section is in view. A scroll listener on the page's own scrollport rather than an
  // IntersectionObserver: the observer's banded margins could not light the first section again at
  // the very top, nor the last one at the very bottom (both measured). A tapped chip holds until the
  // guest scrolls by hand.
  useEffect(() => {
    const root = scrollRootRef.current
    if (!root || categories.length < 2) return undefined
    let frame = 0
    const compute = () => {
      frame = 0
      if (tappedCategoryRef.current) { setActiveCategory(tappedCategoryRef.current); return }
      const rootTop = root.getBoundingClientRect().top
      const line = rootTop + navHeight + 16
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 2) { setActiveCategory(categories[categories.length - 1]); return }
      let current = categories[0]
      for (const cat of categories) {
        const el = categoryRefs.current[cat]
        if (el && el.getBoundingClientRect().top <= line) current = cat
      }
      setActiveCategory(current)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(compute) }
    const release = () => { tappedCategoryRef.current = null }
    root.addEventListener('scroll', onScroll, { passive: true })
    root.addEventListener('wheel', release, { passive: true })
    root.addEventListener('touchstart', release, { passive: true })
    root.addEventListener('keydown', release)
    compute()
    return () => {
      root.removeEventListener('scroll', onScroll)
      root.removeEventListener('wheel', release)
      root.removeEventListener('touchstart', release)
      root.removeEventListener('keydown', release)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [categoryKey, navHeight]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the highlighted chip visible inside the bar. It used to highlight a chip scrolled far off
  // the right edge ("Desserts" at x=968 in a bar ending at 340). Scrolls the BAR only, never the page.
  useEffect(() => {
    const bar = chipBarRef.current
    const chip = chipRefs.current[activeCategory]
    if (!bar || !chip) return
    const left = chip.offsetLeft - bar.offsetLeft
    const right = left + chip.offsetWidth
    if (left < bar.scrollLeft + 8 || right > bar.scrollLeft + bar.clientWidth - 8) {
      bar.scrollTo({ left: Math.max(0, left - 16), behavior: reduceMotion() ? 'auto' : 'smooth' })
    }
  }, [activeCategory])

  function scrollToCategory(cat) {
    tappedCategoryRef.current = cat
    setActiveCategory(cat)
    categoryRefs.current[cat]?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' })
  }

  function toggleAllergen(a) {
    setExcludedAllergens(prev => prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a])
  }
  function clearFilters() {
    setVegOnly(false)
    setExcludedAllergens([])
  }

  useBackToClose(reviewOpen, () => setReviewOpen(false), !inPreview)
  useBackToClose(filtersOpen, () => setFiltersOpen(false), !inPreview)
  useBackToClose(!!optionSheet, () => setOptionSheet(null), !inPreview)

  // ── The three states before a menu ────────────────────────────────────────────────────────────
  // All three render inside the page's own shell and theme. They used to render outside it, in the
  // staff app's palette with a red button — the first thing a guest on a slow connection saw.
  if (rows === null) {
    return (
      <GuestShell>
        <div className="gm-page" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">Loading the menu…</span>
          <div aria-hidden="true">
            <div className="skeleton gm-skel-title" />
            <div className="skeleton gm-skel-meta" />
            <div className="gm-skel-chips">
              <div className="skeleton" /><div className="skeleton" /><div className="skeleton" />
            </div>
            {[0, 1, 2, 3, 4].map(i => (
              <div key={i} className="gm-skel-row">
                <div className="skeleton gm-skel-name" />
                <div className="skeleton gm-skel-price" />
              </div>
            ))}
          </div>
        </div>
      </GuestShell>
    )
  }
  if (error) {
    return (
      <GuestShell>
        <div className="gm-page gm-state">
          <h1 className="gm-state-title">We couldn’t load the menu</h1>
          <p className="gm-state-text">Check your internet connection, then try again.</p>
          <button type="button" className="btn btn-primary" onClick={retryLoadMenu}>Try again</button>
        </div>
      </GuestShell>
    )
  }
  if (rows.length === 0) {
    return (
      <GuestShell>
        <div className="gm-page gm-state">
          <h1 className="gm-state-title">This menu isn’t available</h1>
          <p className="gm-state-text">Please ask a member of staff for a menu.</p>
        </div>
      </GuestShell>
    )
  }

  const tableName = meta.table_name
  const nutritionEnabled = meta.nutrition_enabled
  const orderingEnabled = meta.guest_ordering_enabled
  // `?? true` matches the column default and every other JS caller, so a client whose RPC
  // predates migration 20260823100000 keeps today's behaviour instead of silently dropping VAT
  // off a registered outlet's menu.
  const vatRegistered = meta.is_vat_registered ?? true
  const vatApplies = vatRegistered && rows.some(r => (parseFloat(r.vat_rate) || 0) > 0)

  const cartLines = Object.entries(cart)
    .filter(([, l]) => l.qty > 0)
    .map(([key, l]) => {
      const item = byRecipe[l.recipe_id]
      if (!item) return null
      const dishGroups = dishGroupsByRecipe[l.recipe_id] || []
      const desc = l.option_ids?.length
        ? describeSelection(l.option_ids, { ...optionMaps, attachByGroup: Object.fromEntries(dishGroups.map(d => [d.group.id, d.attachment])) })
        : { delta: 0, summary: '', options: [] }
      const unit = Math.round(inclFromEx((parseFloat(item.selling_price) || 0) + desc.delta, vatRegistered ? (parseFloat(item.vat_rate) || 0) : 0))
      return { key, item, name: tidyName(item.name), qty: l.qty, option_ids: l.option_ids || [], summary: tidyName(desc.summary), unit }
    })
    .filter(Boolean)
  const cartCount = cartLines.reduce((s, l) => s + l.qty, 0)
  const cartTotal = cartLines.reduce((s, l) => s + l.unit * l.qty, 0)
  const qtyByRecipe = {}
  for (const l of cartLines) qtyByRecipe[l.item.recipe_id] = (qtyByRecipe[l.item.recipe_id] || 0) + l.qty

  function setQty(key, qty) {
    setCart(prev => {
      const line = prev[key]
      if (!line) return prev
      const next = { ...prev }
      const q = Math.max(0, Math.min(50, qty))
      if (q === 0) delete next[key]
      else next[key] = { ...line, qty: q }
      return next
    })
  }
  // A plain dish's row stepper: its one plain line.
  function setPlainQty(recipeId, qty) {
    setCart(prev => {
      const q = Math.max(0, Math.min(50, qty))
      const next = { ...prev }
      if (q === 0) delete next[recipeId]
      else next[recipeId] = { recipe_id: recipeId, qty: q, option_ids: [] }
      return next
    })
  }
  // From the choice sheet. The same choices again add to that line; `editKey` replaces the line
  // being edited (folding into an identical one if the new choices match it).
  function addCustom(item, optionIds, editKey) {
    const key = cartKey(item.recipe_id, optionIds)
    setCart(prev => {
      const next = { ...prev }
      const editing = editKey ? prev[editKey] : null
      if (editing) delete next[editKey]
      const addQty = editing ? editing.qty : 1
      const existing = next[key]
      next[key] = { recipe_id: item.recipe_id, qty: Math.min(50, (existing?.qty || 0) + addQty), option_ids: [...optionIds] }
      return next
    })
  }

  async function placeOrder() {
    if (submitting) return
    setSubmitting(true)
    setSubmitError('')
    // Force a false->true transition even if a previous order's pulse hasn't finished yet — React
    // bails out of the justPlaced effect on a same-value update.
    setJustPlaced(false)
    const payload = cartLines.map(l => ({ recipe_id: l.item.recipe_id, qty: l.qty, ...(l.option_ids.length ? { options: l.option_ids } : {}) }))
    const itemsSnapshot = cartLines.map(l => ({ name: l.summary ? `${l.name} (${l.summary})` : l.name, qty: l.qty }))
    const linesSnapshot = cartLines.map(l => ({ recipe_id: l.item.recipe_id, qty: l.qty, option_ids: l.option_ids }))
    let data, err
    try {
      ;({ data, error: err } = await withTimeout(
        supabase.rpc('submit_guest_order', { p_table_id: tableId, p_items: payload, p_notes: guestNote || null, p_covers: covers }),
        SUBMIT_TIMEOUT_MS, 'Sending your order',
      ))
    } catch (e) {
      err = e
    }
    setSubmitting(false)
    if (err) {
      // Never `err.message`. This is an anonymous member of the public on their own phone, and a
      // raw PostgREST/Postgres string tells them nothing they can act on while leaking schema
      // detail to an unauthenticated surface. S754: the server raises a stable code in `err.hint`
      // for every refusal, so each gets its own sentence (guestOrderRefusal.js).
      console.error('submit_guest_order failed', err)
      const refusal = guestOrderRefusal(err, displayName, { online: navigator.onLine !== false })
      setSubmitError(refusal.text)
      // The menu on screen offered a dish the server no longer has. Re-read it in place — not via
      // retryLoadMenu, which blanks the page to its loading state and would close the sheet the
      // guest needs to fix the order in. A failed re-read keeps the menu they have.
      if (refusal.refreshMenu) {
        Promise.all([supabase.rpc('get_guest_menu', { p_table_id: tableId }), loadOptions()]).then(([{ data: fresh, error: freshErr }, freshOptions]) => {
          if (freshErr || !Array.isArray(fresh)) return
          setRows(fresh)
          // A dish the fresh menu no longer carries would silently drop out of the order sheet
          // (cartLines filters on the menu), so take it off the cart and SAY it was taken off. Since
          // S758 the same goes for a dish whose choices no longer fit what it offers.
          const onMenu = new Set(fresh.map(r => r.recipe_id))
          const cat = freshOptions || optionCatalog
          const stillValid = l => {
            if (!onMenu.has(l.recipe_id)) return false
            const dg = groupsForDish(l.recipe_id, cat)
            if (dg.length === 0) return !(l.option_ids?.length)
            const offered = new Set(dg.flatMap(d => d.options.map(o => o.id)))
            return (l.option_ids || []).every(id => offered.has(id)) && selectionProblems(dg, l.option_ids).length === 0
          }
          const gone = Object.keys(cart).filter(k => !stillValid(cart[k]))
          if (gone.length > 0) {
            setCart(prev => Object.fromEntries(Object.entries(prev).filter(([, l]) => stillValid(l))))
            if (refusal.removedText) setSubmitError(refusal.removedText)
          }
        })
      }
      return
    }
    try {
      sessionStorage.setItem(sessionKey(tableId), JSON.stringify({ requestId: data, items: itemsSnapshot, lines: linesSnapshot, covers }))
    } catch { /* the tracker still works for this session */ }
    setRequestId(data)
    setRequestSnapshot({ items: itemsSnapshot, lines: linesSnapshot, covers })
    setCart({})
    setGuestNote('')
    // Covers are kept: a second round is the same table of people, and resetting to 2 recorded a
    // party of five as two on every later order (S767).
    setReviewOpen(false)
    setRestoreNote('')
    setJustPlaced(true)
  }

  function clearTracker() {
    try { sessionStorage.removeItem(sessionKey(tableId)) } catch { /* nothing stored */ }
    setRequestId(null)
    setRequestSnapshot(null)
  }

  // "Order again" after staff could not take an order puts that order back in the cart and opens it,
  // where it used to clear the card and leave the guest to build it again from memory. A dish that
  // has since left the menu cannot come back, and is named.
  function restoreRefusedOrder() {
    const lines = requestSnapshot?.lines || []
    const missing = []
    setCart(prev => {
      const next = { ...prev }
      lines.forEach((l, i) => {
        if (!byRecipe[l.recipe_id]) { missing.push(requestSnapshot.items?.[i]?.name || 'A dish'); return }
        const key = cartKey(l.recipe_id, l.option_ids || [])
        next[key] = { recipe_id: l.recipe_id, qty: Math.min(50, (next[key]?.qty || 0) + (Number(l.qty) || 1)), option_ids: [...(l.option_ids || [])] }
      })
      return next
    })
    setRestoreNote(missing.length ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} no longer on the menu.` : '')
    clearTracker()
    if (lines.length > missing.length) setReviewOpen(true)
  }

  const showNav = categories.length > 1 || searchable
  const firstCategory = categories[0]
  const showFilters = hasVegMarks || allAllergens.length > 0

  return (
    <GuestShell scrollRef={scrollRootRef} style={{ '--gm-nav-h': `${navHeight}px` }}>
      <div className="gm-page">
        <header className="gm-mast">
          {logoUrl && <GuestLogo src={logoUrl} name={displayName} />}
          <h1 className="gm-name">{displayName}</h1>
          <div className="gm-meta">
            <p className="gm-table">{tableName}</p>
            {showFilters && (
              <button type="button" className="btn btn-ghost btn-sm gm-filter-btn" onClick={() => setFiltersOpen(true)}>
                <SlidersHorizontal size={15} aria-hidden="true" />
                {activeFilterCount > 0 ? `Filters (${activeFilterCount})` : 'Filters'}
              </button>
            )}
          </div>
          {/* Shown ONLY for a VAT-registered outlet, and the asymmetry is deliberate. Plenty of
              restaurants here add 13% at the till, so a diner genuinely cannot tell whether a menu
              price is the final price — stating the inclusion removes a real doubt. The
              non-registered case has no such doubt to remove, and spelling it out would volunteer a
              client's tax status on the one page their customers see. Safe to state because there is
              no service charge anywhere in the product; if one is added, this line has to change. */}
          {vatApplies && <p className="gm-note">Prices include VAT.</p>}
          {/* get_guest_menu turns ordering off for a table marked inactive (S746). Without a line
              saying so, the only difference is the missing Add buttons, which reads as a broken page. */}
          {!orderingEnabled && (
            <p className="gm-note">Ordering from this table is off right now. Please order with a member of staff.</p>
          )}
          {orderingEnabled && optionsFailed && (
            <p role="status" className="gm-note gm-note--warn">
              Sizes and extras didn’t load. You can still order, and we’ll tell you if a dish needs a choice.
            </p>
          )}
        </header>

        {restoreNote && <p role="status" className="gm-note gm-note--warn">{restoreNote}</p>}

        {requestSnapshot && requestId ? (
          <div ref={statusCardRef} className={`gm-status-wrap${justPlaced ? ' guest-order-glow' : ''}`}>
            <OrderStatusCard
              stage={stage || 'placed'} progress={progress}
              items={requestSnapshot.items} covers={requestSnapshot.covers}
              tableName={tableName} statusStale={statusStale}
              onRestore={restoreRefusedOrder} onClear={clearTracker}
            />
          </div>
        ) : tableKot && (
          <p role="status" className="gm-table-kot">
            <span className={`badge badge-sentence ${KOT_STATUS_BADGE[tableKot.kotStatus] || 'badge-gray'}`}>
              {KOT_STATUS_LABEL[tableKot.kotStatus] || KOT_STATUS_LABEL.new}
              {tableKot.kotStatus === 'in_progress' && tableKot.remainingMinutes > 0 && ` · about ${tableKot.remainingMinutes} min`}
            </span>
          </p>
        )}

        {showNav && (
          <nav ref={navRef} className="gm-nav" aria-label="Menu sections">
            {searchable && (
              <div className="gm-search">
                <Search size={16} aria-hidden="true" className="gm-search-icon" />
                <input
                  type="search" className="form-input" enterKeyHint="search"
                  aria-label="Search the menu" placeholder="Search dishes"
                  value={query} onChange={e => setQuery(e.target.value)}
                  autoComplete="off" spellCheck="false"
                />
              </div>
            )}
            {categories.length > 1 && (
              <div ref={chipBarRef} className="tab-bar tab-bar--scroll gm-chips">
                {categories.map(cat => (
                  <button
                    key={cat} type="button"
                    ref={el => { chipRefs.current[cat] = el }}
                    className={`tab-btn${activeCategory === cat || (!activeCategory && cat === firstCategory) ? ' tab-btn--active' : ''}`}
                    aria-current={activeCategory === cat ? 'true' : undefined}
                    onClick={() => scrollToCategory(cat)}
                  >
                    {categoryLabel(cat)}
                  </button>
                ))}
              </div>
            )}
          </nav>
        )}

        {trimmedQuery && (
          <p role="status" className="gm-search-count">
            {filteredRows.length === 0 ? '' : `${filteredRows.length} ${filteredRows.length === 1 ? 'dish matches' : 'dishes match'} “${trimmedQuery}”`}
          </p>
        )}

        <main>
          {categories.length === 0 && (
            <div className="gm-empty">
              {trimmedQuery ? (
                <>
                  <p>No dish matches “{trimmedQuery}”.</p>
                  <button type="button" className="btn btn-ghost" onClick={() => setQuery('')}>Clear search</button>
                </>
              ) : activeFilterCount > 0 ? (
                <>
                  <p>No dish matches your filters.</p>
                  <button type="button" className="btn btn-ghost" onClick={clearFilters}>Clear filters</button>
                </>
              ) : null}
            </div>
          )}

          {categories.map(cat => (
            <section
              key={cat} ref={el => { categoryRefs.current[cat] = el }}
              className="gm-section" aria-label={cat === UNCATEGORISED && categories.length === 1 ? 'Menu' : undefined}
              aria-labelledby={cat === UNCATEGORISED && categories.length === 1 ? undefined : `gm-sec-${categories.indexOf(cat)}`}
            >
              {!(cat === UNCATEGORISED && categories.length === 1) && (
                <h2 id={`gm-sec-${categories.indexOf(cat)}`} className="gm-section-title">{categoryLabel(cat)}</h2>
              )}
              <ul className="gm-list">
                {byCategory[cat].map(item => (
                  <MenuItemRow
                    key={item.recipe_id} item={item} nutritionEnabled={nutritionEnabled}
                    orderingEnabled={orderingEnabled} vatRegistered={vatRegistered}
                    qty={qtyByRecipe[item.recipe_id] || 0}
                    onQtyChange={qty => setPlainQty(item.recipe_id, qty)}
                    dishGroups={dishGroupsByRecipe[item.recipe_id]}
                    onChoose={() => setOptionSheet({ item, dishGroups: dishGroupsByRecipe[item.recipe_id] })}
                  />
                ))}
              </ul>
            </section>
          ))}
        </main>
      </div>

      {/* The order total, announced. The bar's count changed on every add and a screen reader heard
          nothing, because the bar is a button whose name only changes. */}
      <p role="status" aria-live="polite" className="sr-only">
        {cartCount > 0 ? `${cartCount} ${cartCount === 1 ? 'item' : 'items'} in your order, ${fmtNpr(cartTotal)}` : ''}
      </p>

      {orderingEnabled && cartCount > 0 && (
        <div className="gm-cartbar no-print">
          <button type="button" className="gm-cartbar-btn" onClick={() => setReviewOpen(true)}>
            <span className="gm-cartbar-count">{cartCount} {cartCount === 1 ? 'item' : 'items'} · {fmtNpr(cartTotal)}</span>
            <span className="gm-cartbar-go">Review order <ChevronRight size={18} aria-hidden="true" /></span>
          </button>
        </div>
      )}

      {filtersOpen && (
        <Modal variant="sheet" title="Filter the menu" onClose={() => setFiltersOpen(false)}>
          <SheetHeader title="Filter the menu" onClose={() => setFiltersOpen(false)} />
          <div className="gm-filter-body">
            {hasVegMarks && (
              <label className="gm-check">
                <input type="checkbox" checked={vegOnly} onChange={e => setVegOnly(e.target.checked)} />
                <span>Vegetarian dishes only</span>
              </label>
            )}
            {allAllergens.length > 0 && (
              <div role="group" aria-labelledby="gm-allergen-label">
                <p id="gm-allergen-label" className="gm-filter-label">Hide dishes that contain:</p>
                <div className="gm-allergen-chips">
                  {allAllergens.map(a => (
                    <button
                      key={a} type="button" onClick={() => toggleAllergen(a)}
                      // A toggle must say whether it is on, not only by colour.
                      aria-pressed={excludedAllergens.includes(a)}
                      className="gm-chip gm-allergen"
                    >
                      {excludedAllergens.includes(a) && <X size={14} aria-hidden="true" />}
                      {a}
                    </button>
                  ))}
                </div>
                {/* Decision S767: allergens reach every restaurant's guests. What they are built from
                    is the ingredients the restaurant has recorded, and the page must not let a missing
                    record read as "free of it". */}
                <p className="gm-note">Based on the ingredients the restaurant has recorded. If you have a serious allergy, please ask a member of staff.</p>
              </div>
            )}
            <div className="gm-sheet-actions">
              <button type="button" className="btn btn-ghost" onClick={clearFilters}>Clear</button>
              <button type="button" className="btn btn-primary" onClick={() => setFiltersOpen(false)}>
                Show {filteredRows.length} {filteredRows.length === 1 ? 'dish' : 'dishes'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {reviewOpen && (
        <Modal variant="sheet" title="Your order" onClose={() => { if (!submitting) setReviewOpen(false) }}>
          <SheetHeader title="Your order" onClose={() => { if (!submitting) setReviewOpen(false) }} />
          {/* Emptying the cart from inside this sheet used to leave a single sentence and no way
              forward. */}
          {cartLines.length === 0 ? (
            <div className="gm-empty">
              <p>Nothing in your order yet.</p>
              <button type="button" className="btn btn-primary" onClick={() => setReviewOpen(false)}>Back to the menu</button>
            </div>
          ) : (
            // Locked while the order is sending: an edit made then was silently not sent.
            <fieldset className="gm-fieldset" disabled={submitting}>
              <legend className="sr-only">Your order</legend>
              <ul className="gm-review-lines">
                {cartLines.map(l => (
                  <li key={l.key} className="gm-review-line">
                    <div className="gm-review-line-name">
                      <span className="gm-dish-name">{l.name}</span>
                      {l.summary && <span className="gm-review-line-summary">{l.summary}</span>}
                      {/* Edit from the order, not "remove and start again": the thing a guest most
                          often wants to change is the choice they just made (S758). */}
                      {dishGroupsByRecipe[l.item.recipe_id] && (
                        <button
                          type="button" className="btn btn-ghost btn-sm gm-edit-choices"
                          aria-label={`Change choices for ${l.name}`}
                          onClick={() => setOptionSheet({ item: l.item, dishGroups: dishGroupsByRecipe[l.item.recipe_id], editKey: l.key, initialIds: l.option_ids })}
                        >Change choices</button>
                      )}
                    </div>
                    <Stepper qty={l.qty} label={l.name} onChange={qty => setQty(l.key, qty)} />
                    <span className="gm-review-line-total">{fmtNpr(l.unit * l.qty)}</span>
                  </li>
                ))}
              </ul>
              <div className="gm-review-total">
                <span>Total</span>
                <span>{fmtNpr(cartTotal)}</span>
              </div>
              <p className="gm-note">
                {vatApplies ? 'Includes VAT. ' : ''}Staff accept your order before the kitchen starts. You pay at the table.
              </p>
              <div className="gm-covers">
                <span>How many of you are eating?</span>
                <Stepper qty={covers} label="people eating" onChange={n => setCovers(Math.max(1, Math.min(50, n)))} />
              </div>
              {/* `.form-input` brings the 16px coarse-pointer floor, below which iOS Safari zooms
                  the viewport and never zooms back. */}
              <label htmlFor="guest-note" className="gm-filter-label">Note for the kitchen (optional)</label>
              <textarea
                id="guest-note" className="form-input gm-note-input"
                value={guestNote} onChange={e => setGuestNote(e.target.value)}
                placeholder="For example: no onion, less spicy"
                rows={2} maxLength={500}
              />
            </fieldset>
          )}
          {cartLines.length > 0 && (
            <div className="gm-place">
              {submitError && <p role="alert" className="gm-error">{submitError}</p>}
              {/* The last thing read before committing. A QR sticker that has been moved, or a guest
                  who scanned the code on the next table, is only catchable here. */}
              <p className="gm-sending-to">Sending to {tableName}</p>
              {inPreview ? (
                <>
                  <button type="button" className="btn btn-primary gm-place-btn" disabled>
                    Place order · {fmtNpr(cartTotal)}
                  </button>
                  <p role="note" className="gm-note">Ordering is off in the admin preview. Open the menu in a new tab to place a real order.</p>
                </>
              ) : (
                <button
                  type="button" className="btn btn-primary gm-place-btn"
                  aria-busy={submitting ? 'true' : undefined} onClick={placeOrder}
                >
                  {submitting ? 'Sending your order…' : `Place order · ${fmtNpr(cartTotal)}`}
                </button>
              )}
            </div>
          )}
        </Modal>
      )}

      {optionSheet && (
        <GuestOptionSheet
          item={optionSheet.item}
          dishGroups={optionSheet.dishGroups}
          catalog={optionMaps}
          vatRegistered={vatRegistered}
          initialIds={optionSheet.initialIds}
          editing={!!optionSheet.editKey}
          stepped={(optionCatalog.buildYourOwn || []).includes(optionSheet.item.recipe_id)}
          onClose={() => setOptionSheet(null)}
          onConfirm={ids => { addCustom(optionSheet.item, ids, optionSheet.editKey); setOptionSheet(null) }}
        />
      )}
    </GuestShell>
  )
}

// The page's own scrollport and theme scope, shared by the loading, error and menu states so none of
// them can render outside it.
function GuestShell({ children, scrollRef, style }) {
  return (
    <div className="guest-menu" ref={scrollRef} style={style}>
      {children}
    </div>
  )
}

// The restaurant's logo, if the owner set one. A logo that fails to load is simply absent — a broken
// image glyph above the restaurant's name is worse than no logo.
function GuestLogo({ src, name }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  if (failed) return null
  // Empty alt: the restaurant's name is the heading directly beneath, and "Bhatti Choila logo,
  // Bhatti Choila" is the same fact read twice.
  return <img className="gm-logo" src={src} alt="" data-name={name} onError={() => setFailed(true)} />
}

function SheetHeader({ title, onClose }) {
  return (
    <div className="gm-sheet-head">
      <h2 className="gm-sheet-title">{title}</h2>
      <button type="button" className="btn btn-ghost btn-icon gm-close" onClick={onClose} aria-label="Close" title="Close">
        <X size={20} aria-hidden="true" />
      </button>
    </div>
  )
}

function OrderStatusCard({ stage, progress, items, covers, tableName, statusStale, onRestore, onClear }) {
  const list = items?.length > 0 && (
    <ul className="gm-status-items">
      {items.map((it, i) => <li key={i}>{it.qty} × {tidyName(it.name)}</li>)}
      <li className="gm-status-sub">
        {covers > 0 ? `${covers} ${covers === 1 ? 'person' : 'people'} · ` : ''}{tableName}
      </li>
    </ul>
  )

  if (stage === 'dismissed') {
    return (
      <section className="gm-status gm-status--refused" aria-labelledby="gm-status-title">
        <h2 id="gm-status-title" className="gm-status-title">Staff couldn’t take this order</h2>
        <p className="gm-status-text">Please ask a member of staff. You can send it again from your order.</p>
        {list}
        <div className="gm-status-actions">
          <button type="button" className="btn btn-primary" onClick={onRestore}>Put it back in my order</button>
          <button type="button" className="btn btn-ghost" onClick={onClear}>Close</button>
        </div>
      </section>
    )
  }

  if (stage === 'done') {
    return (
      <section className="gm-status" aria-labelledby="gm-status-title">
        <h2 id="gm-status-title" className="gm-status-title">Your bill is closed. Thank you!</h2>
        <p className="gm-status-text">We hope you enjoyed your meal.</p>
        {list}
        <div className="gm-status-actions">
          <button type="button" className="btn btn-ghost" onClick={onClear}>Close</button>
        </div>
      </section>
    )
  }

  const stageIdx = Math.max(0, STAGES.indexOf(stage))
  // "About" rather than a bare countdown — this is the kitchen's own estimate, not a measured time.
  // Omitted once it's no longer positive rather than showing a negative number to a paying guest.
  const minutes = stage === 'preparing' && progress.kotStatus === 'in_progress' && progress.remainingMinutes > 0 ? progress.remainingMinutes : null

  return (
    <section className="gm-status" aria-labelledby="gm-status-title">
      <h2 id="gm-status-title" className="gm-status-title" aria-live="polite">
        {STAGE_LABEL[stage] || STAGE_LABEL.placed}
        {minutes != null && <span className="gm-status-minutes"> About {minutes} min.</span>}
      </h2>
      {/* A stalled poll is not a stage. Saying so keeps the tracker honest: the steps below are still
          the last stage we actually heard. */}
      {statusStale && (
        <p role="status" className="gm-note gm-note--warn">Lost touch with the restaurant. Showing the last update. Trying again…</p>
      )}
      {/* Five labelled steps. The dots used to carry no label, so only the sentence said where the
          order was. */}
      <ol className="gm-track" aria-label="Order progress">
        {STAGES.map((s, i) => (
          <li
            key={s}
            className={`gm-track-step${i < stageIdx ? ' is-done' : ''}${i === stageIdx ? ' is-current' : ''}`}
            aria-current={i === stageIdx ? 'step' : undefined}
          >
            <span className="gm-track-bar" aria-hidden="true" />
            <span className="gm-track-label">{STAGE_SHORT[s]}</span>
          </li>
        ))}
      </ol>
      {list}
    </section>
  )
}

// `label` names what is being counted, so a menu of N dishes does not render 2N buttons all
// announcing "Decrease quantity" (DESIGN.md's template-aria-label rule).
function Stepper({ qty, onChange, label, plusRef, minusRef }) {
  const what = label ? ` of ${label}` : ''
  return (
    <div className="gm-stepper">
      <button type="button" ref={minusRef} className="gm-step-btn" aria-label={`Decrease quantity${what}`} onClick={() => onChange(qty - 1)}>
        <Minus size={16} aria-hidden="true" />
      </button>
      <span className="gm-step-qty" aria-live="polite">{qty}</span>
      <button type="button" ref={plusRef} className="gm-step-btn" aria-label={`Increase quantity${what}`} onClick={() => onChange(qty + 1)}>
        <Plus size={16} aria-hidden="true" />
      </button>
    </div>
  )
}

// Veg / non-veg: the market's own labelling symbol — an outlined square with a filled dot, green or
// red. The dot stays round deliberately: this is a food-labelling mark whose shape IS its meaning,
// not an interface control, so the Modernist zero-radius rule does not reshape it (DESIGN.md).
function VegMark({ isVeg }) {
  return (
    <span role="img" aria-label={isVeg ? 'Vegetarian' : 'Non-vegetarian'} title={isVeg ? 'Veg' : 'Non-veg'}
      className={`gm-diet ${isVeg ? 'gm-diet--veg' : 'gm-diet--nonveg'}`}>
      <span aria-hidden="true" />
    </span>
  )
}

function MenuItemRow({ item, nutritionEnabled, orderingEnabled, vatRegistered, qty, onQtyChange, dishGroups, onChoose }) {
  const [imgFailed, setImgFailed] = useState(false)
  const plusRef = useRef(null)
  const addRef = useRef(null)
  const focusAfter = useRef(null) // 'plus' | 'add' — where focus goes once the control it needs exists
  const name = tidyName(item.name)
  const priceInc = priceIncVat(item, vatRegistered)
  // A dish with choices shows "From" its cheapest valid version (owner decision, S758).
  const fromPrice = dishGroups
    ? Math.round(inclFromEx(lowestDishPrice(item.selling_price, dishGroups), vatRegistered ? (parseFloat(item.vat_rate) || 0) : 0))
    : null
  const showFrom = fromPrice != null && fromPrice !== priceInc
  const hasImage = item.image_url && !imgFailed
  const allergens = item.allergens || []
  const showNutrition = nutritionEnabled && item.has_nutrition
  // A dish with nothing but a name and a price is one line: the printed-menu row. A card per dish
  // with the Add button on a row of its own made a 120-dish menu 24–31 phone screens long.
  const compact = !hasImage && !item.description && allergens.length === 0 && !showNutrition

  // Pressing "+ Add" replaces it with the stepper, and focus used to fall to the page. It moves to
  // the new "+"; taking the dish back to 0 returns it to "+ Add".
  useEffect(() => {
    if (focusAfter.current === 'plus' && qty > 0) plusRef.current?.focus()
    if (focusAfter.current === 'add' && qty === 0) addRef.current?.focus()
    focusAfter.current = null
  }, [qty])

  return (
    <li className={`gm-row${compact ? ' gm-row--compact' : ''}${hasImage ? ' gm-row--image' : ''}`}>
      {hasImage && (
        <img
          className="gm-thumb" src={item.image_url} alt={name} onError={() => setImgFailed(true)}
          loading="lazy" decoding="async"
        />
      )}
      <div className="gm-row-main">
        <p className="gm-name-line">
          {item.is_veg != null && <VegMark isVeg={item.is_veg} />}
          <span className="gm-dish-name">{name}</span>
        </p>
        {item.description && <p className="gm-desc">{item.description}</p>}
        {allergens.length > 0 && (
          <p className="gm-allergens">Contains: {allergens.join(', ')}</p>
        )}
        {showNutrition && (
          <p className="gm-nutrition">
            {NUTRIENTS.map(def => `${def.label} ${fmtNutrient(def, item[def.key])}`).join(' · ')}
          </p>
        )}
      </div>
      <div className="gm-row-side">
        <span className="gm-price">
          {showFrom ? <><span className="gm-from">From </span>{fmtNpr(fromPrice)}</> : fmtNpr(priceInc)}
        </span>
        {orderingEnabled && dishGroups && (
          <button
            type="button" className="btn btn-ghost btn-sm gm-add"
            aria-label={`Choose options and add ${name} to your order`}
            onClick={onChoose}
          >
            <Plus size={15} aria-hidden="true" />{qty > 0 ? `Add another (${qty})` : 'Add'}
          </button>
        )}
        {orderingEnabled && !dishGroups && (
          qty > 0 ? (
            <Stepper
              qty={qty} label={name} plusRef={plusRef}
              onChange={n => { if (n === 0) focusAfter.current = 'add'; onQtyChange(n) }}
            />
          ) : (
            <button
              type="button" ref={addRef} className="btn btn-ghost btn-sm gm-add"
              aria-label={`Add ${name} to your order`}
              onClick={() => { focusAfter.current = 'plus'; onQtyChange(1) }}
            >
              <Plus size={15} aria-hidden="true" />Add
            </button>
          )
        )}
      </div>
    </li>
  )
}
