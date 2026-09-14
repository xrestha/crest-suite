import { useState, useEffect, useRef } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useTheme } from '../../../context/ThemeContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { setIfChanged, rowsSignature, mapSignature } from '../../../shared/setIfChanged'
import { pointsValue, maxRedeemablePoints } from '../customers/loyaltyPoints'
import Tip from '../../../components/Tip'
import SupportContactLine from '../../../components/SupportContactLine'
import { contrastRatio } from '../../../utils/avatarColor'
import QRCode from 'qrcode'
import { getBsToday, getBsFiscalYear, bsDayBoundaryIso } from '../../../utils/bsCalendar'
import { FLOOR_STATUSES, isDue, tableIdsOf, stampFor, windowOf } from '../reservations/reservationStatus'
import { normalizeReservationSettings, DEFAULT_RESERVATION_SETTINGS } from '../reservations/reservationSettings'
import { computeRecipeCosts, explodeRecipeIngredients } from '../../../utils/recipeCost'
import { buildDynamicQr } from '../../../utils/emvQr'
import { randomUUID } from '../../../utils/uuid'
import Modal from '../../../components/Modal'
import { disabledStyle } from '../../../shared/inlineFieldState'
// The floor view's six window.alert()s are deliberately NOT converted (S616, re-affirmed S682):
// setMsg renders only inside the `view === 'order'` tree, so the floor has no banner of its own,
// and each of these is a refusal a waiter must not be able to walk past mid-service. The audit
// called them unstyled; being un-missable is the property that was chosen, and it still wins.
import { useConfirm } from '../../../shared/hooks/useConfirm'
import IssueCreditNoteModal from '../creditnotes/IssueCreditNoteModal'
import {
  cachePosMenu, getCachedPosMenu, cachePosTables, getCachedPosTables,
  cachePosSettings, getCachedPosSettings, cachePosOrderForTable, getCachedPosOrderForTable,
  clearCachedPosOrderForTable, enqueuePosOrder, getPosOrderQueue, getQueuedPosOrder, dequeuePosOrder,
} from '../../../utils/offlineQueue'
import { buildKotBotHtml, buildBillHtml, buildTenderSlipHtml, buildCompSlipHtml } from './posOrderPrintHtml'
import { nepalTime, nepalBs } from '../../../shared/nepalTime'
import { errorText } from '../../../shared/errorText'
import {
  vatOf, fmtNpr, toItemPayload, QR_PAY_METHODS, STATUS_BADGE, STATUS_LABEL, tableStripColor,
  summarizeTicketStages, ticketSummaryChip, kotTimerLabel,
  OPEN_ORDER_SELECT, cartLineFromStored, missingFromServer, mergeUnsentLines, menuDrift, withServerLineFields,
  storedLinesMatchPayload,
  PAYMENT_METHODS, VOID_REASONS, COMP_REASONS, DEFAULT_DISCOUNT_REASONS, KOT_PULL_REASONS, COPY_LABEL,
  btnSm, billInput, PREVIEW_DEBOUNCE_MS,
} from './posOrdersConstants'

// The pre-20260818150000 delete-then-insert fallback for save_pos_order_items is GONE (S754). Since
// migration 20260916100000 a browser INSERT into pos_order_items is refused (guard_pos_item_price)
// while a DELETE of an open order's lines is not — so that fallback, reached on any PGRST202, would
// have deleted the order's lines and then failed to put them back.
//
// The machine codes save_pos_order_items and the pos_orders guards put in HINT (PostgREST returns
// them as `hint`, supabase-js as `error.hint`). Read by code, never by message text.
const HINT = {
  stale:      'stale_order',       // another device saved this order since it was loaded here
  notOpen:    'order_not_open',    // the bill is already closed
  offMenu:    'line_not_on_menu',  // a NEW line is not on the till menu (or qty < 1 / no recipe)
  locked:     'bill_locked',       // a write to a closed bill
  rank:       'rank_required',     // the login's POS rank is too low for this write
}
// Postgres prefixes a RAISE message with the code word the function chose; the reader wants the
// sentence after it.
const stripCodeWord = (msg, word) => String(msg || '').replace(new RegExp(`^(pos_orders|pos_order_items|${word}):\\s*`), '')

export default function PosOrders() {
  const { clientId, profile, hasPosAccess, isAdmin, isOwner, imsEnabled, hasFeature } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpsert, scopedUpdate, scopedDelete } = useScopedDb()
  // Rendered in BOTH returns (this file has two — S578). One pending ask at a time, drawn by
  // whichever tree is live: the admin clear-all tool asks from the floor, and the discard-payments
  // and discard-unsaved-items asks (S754) come from the order screen.
  const { ask: askConfirm, confirmEl } = useConfirm()
  const { colors } = useTheme()
  // Solid-amber badges (offline-pending dot, pending-items count, writeoff button) were hardcoded
  // to black text — passes on Dark but computes to 4.18:1 (fails WCAG AA) on Light's
  // amber (#b45309), a genuinely dark burnt-orange. Same contrast-pick approach avatarColorFor()
  // already uses, so this stays correct if a future preset's amber ever needs white too.
  const amberBadgeText = contrastRatio(colors.amber, '#ffffff') >= contrastRatio(colors.amber, '#000000') ? '#ffffff' : '#000000'
  // Same reasoning for the red solid fill (the Void Order button), which was hardcoding white text
  // and failing WCAG AA on light pastel presets. The green equivalent is gone with the last two
  // green fills in the module: the Payment button is now the accent (this system's primary-action
  // colour — green is its "done" verdict, and the bill has not been paid yet), and the "✓ KOT"
  // sent chip is a quiet brass tint. See posSignals.js.
  const redBadgeText    = contrastRatio(colors.red, '#ffffff')   >= contrastRatio(colors.red, '#000000')   ? '#ffffff' : '#000000'

  // Upsell/Cross-sell suggestion chips (built S210).
  // These used to ladder off pos_plan (starter/growth/pro). Crest POS is sold as a yes/no module
  // with no tiers at all, so that ladder gated on a tier the product never sold — and since
  // ClientDrawer defaulted the column to 'starter', most POS clients silently got only the basic
  // category nudge. Buying POS now buys the whole suggestion engine.
  //
  // The IMS dependency is a real axis and stays: co-occurrence is sold as the IMS+POS combination,
  // and the Menu Engineering filter genuinely needs recipes.me_class, which only IMS's Menu
  // Engineering report ever populates. Admin bypasses, same convention as everywhere else.
  const imsAvailable      = isAdmin || imsEnabled
  const allowCoOccurrence = imsAvailable
  const allowMeFilter     = imsAvailable

  /* ── view ── */
  const [view, setView] = useState('floor')

  /* ── floor ── */
  const [tables,      setTables]      = useState([])
  const [tableOrders, setTableOrders] = useState({})
  const [secFilter,   setSecFilter]   = useState('All')
  const [floorLoad,   setFloorLoad]   = useState(true)
  // Open orders with no table (S754). loadFloor used to `continue` past them, and "+ Takeaway"
  // always starts a NEW order — so a saved takeaway could never be reopened, added to or billed.
  // [{ orderId, orderNo, itemCount, total, pending, offlinePending? }]
  const [takeawayOrders, setTakeawayOrders] = useState([])
  // A failed floor read, kept separate from the data so last-good tables/orders stay on screen
  // (S754). Before this a dropped error painted "No tables set up yet" and cached the empty list.
  const [floorLoadError, setFloorLoadError] = useState('')
  // Overlapping loadFloor calls (the 15 s poll, a save, a close) — only the newest may paint.
  const floorReqSeq = useRef(0)
  const lastFloorLoadAt = useRef(0)
  // table_id (or `takeaway:<orderId>`) -> { stage, ready, open } — summarizeTicketStages() over that
  // open order's pos_kot_log rows, so wait staff can see Sent/Started/N ready/Served without walking
  // to the kitchen.
  const [kotStatusByTable, setKotStatusByTable] = useState({})
  // pos_kot_log rows for the order currently open on screen (view === 'order') — powers the
  // per-line-item KOT/BOT timer shown on the menu tile and next to the cart row's "✓ KOT/BOT"
  // badge. Separate from kotStatusByTable above, which only tracks the floor view's per-table
  // summary (deliberately no ETA there — the floor grid stays to the plain Sent/Started/Ready badge).
  const [orderKotTickets, setOrderKotTickets] = useState([])
  const [kotNow, setKotNow] = useState(() => Date.now())
  // table_id -> array of pending pos_guest_order_requests rows ({ id, items, guest_notes, covers, created_at })
  // awaiting staff Accept/Dismiss — see submit_guest_order (Guest QR self-ordering, Pro-tier feature).
  const [pendingGuestOrders, setPendingGuestOrders] = useState({})
  // Request ids already seen by loadPendingGuestOrders, so the chime only fires for a genuinely
  // new arrival, not on every 5s re-poll of a request that's still sitting there pending.
  const seenGuestRequestIds = useRef(new Set())
  const guestOrdersLoadedOnce = useRef(false)
  // Request ids Accepted locally (items merged into orderItems) but not yet DB-marked accepted —
  // deferred until performSave() actually persists them, so navigating away before saving leaves
  // the request still 'pending' in the DB (accurate — nothing was really saved) instead of
  // permanently telling the guest "confirmed, heading to kitchen" for items that got dropped.
  const [pendingAcceptedGuestReqIds, setPendingAcceptedGuestReqIds] = useState(new Set())
  // Request ids currently mid-decision — guards a rapid double-tap on Accept/Dismiss from
  // double-merging the same items or firing the decision write twice.
  const [decidingGuestReqIds, setDecidingGuestReqIds] = useState(new Set())

  /* ── covers modal ── */
  const [coversModal,      setCoversModal]      = useState(false)
  const [pendingTable,     setPendingTable]      = useState(null)
  const [pendingCoversStr, setPendingCoversStr]  = useState('')

  /* ── reservations (S677) ── */
  // Today's live bookings (booked / confirmed / arrived), read with the floor and re-polled every
  // 60 s. DERIVED onto the tiles — pos_tables.status is never written by this feature, because
  // that stored column already drifts against open orders and a second writer would compound it.
  const [floorReservations, setFloorReservations] = useState([])
  const [requestCount,      setRequestCount]      = useState(0) // public booking requests awaiting Accept
  // The booking a tapped table is due for, offered as "Seat <name>" instead of the covers numpad.
  const [seatPrompt, setSeatPrompt] = useState(null)
  // The booking the order being opened belongs to. A ref rather than state: performSave reads it
  // synchronously right after the pos_orders insert returns — the same reason savingRef exists.
  const seatReservationRef = useRef(null)
  const [reservationSettings, setReservationSettings] = useState(DEFAULT_RESERVATION_SETTINGS)
  const location = useLocation()
  const navigate = useNavigate()

  /* ── order screen ── */
  const [activeTable, setActiveTable] = useState(null)
  const [orderId,     setOrderId]     = useState(null)
  const [orderNo,     setOrderNo]     = useState(null) // per-client sequential, assigned by DB trigger on insert
  // orderItems: { id?, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot }
  const [orderItems,  setOrderItems]  = useState([])
  const [covers,      setCovers]      = useState(1)
  const [menu,        setMenu]        = useState([])
  const [menuLoaded,  setMenuLoaded]  = useState(false)
  // Same S754 rule as floorLoadError: a failed menu read is not "No POS-enabled items".
  const [menuLoadError, setMenuLoadError] = useState('')
  // The cart as last loaded or saved — { recipe_id|name: 'qty|notes' } — so ← can tell an unsaved
  // edit from an untouched order (S754). A ref: only the back handler reads it.
  const savedItemsRef = useRef(new Map())
  // pos_orders.items_version of the order on screen, as last loaded or saved (S754). Sent with every
  // save as p_expected_version; null for an order not yet on the server (or created offline), which
  // saves without the check. A ref: performSave reads and advances it mid-call.
  const itemsVersionRef = useRef(null)
  // Another device saved this order first: the reloaded order is on screen, and these are the lines
  // this device had that it no longer carries — { where, missing: [line] } while the ask is open.
  const [staleRecovery, setStaleRecovery] = useState(null)
  // The bill on screen was closed on another device — the name to show while the notice is open.
  const [closedElsewhere, setClosedElsewhere] = useState(null)
  // "Served" on the order screen, in flight.
  const [servingTickets, setServingTickets] = useState(false)
  const [catTab,      setCatTab]      = useState('All')
  const [menuSearch,  setMenuSearch]  = useState('')
  const [saving,      setSaving]      = useState(false)
  const [msg,         setMsg]         = useState('')
  // categories that route to BOT — loaded from settings, default to ['Beverage']
  const [botCategories, setBotCategories] = useState(new Set(['Beverage']))
  const [outletName,    setOutletName]    = useState('')
  const [notePresets,   setNotePresets]   = useState([])
  const [noteFocusIdx,  setNoteFocusIdx]  = useState(null)
  // ME-driven suggestion chips
  const [suggestions,       setSuggestions]       = useState([])
  const [manualSuggestions, setManualSuggestions] = useState({}) // { recipeId: [suggestedRecipeId] }

  /* ── billing / invoice settings (loaded once per client) ── */
  const [billingSettings, setBillingSettings] = useState({
    is_vat_registered: true, invoice_prefix: '', vat_number: '', property_address: '', property_phone: '', payment_qr_data: '',
    delivery_partners: [],
  })

  /* ── Billing modal ── */
  const [billingOpen, setBillingOpen] = useState(false)
  const [billingTab,  setBillingTab]  = useState('pay') // 'pay' | 'void' | 'writeoff'
  const [payMethod,   setPayMethod]   = useState('Cash')
  const [tenderedStr, setTenderedStr] = useState('')
  // tenderedStr === '' means "not entered yet" (assume exact cash, i.e. fall back to the total).
  // `parseFloat(tenderedStr) || fallback` treated an explicit "0" the same as empty, since 0 is
  // falsy in JS — silently recording an exact-cash payment even when the cashier typed 0. This
  // only falls back when the parse genuinely fails (empty or non-numeric), never for a real 0.
  function resolveTendered(fallback) {
    const v = parseFloat(tenderedStr)
    return Number.isNaN(v) ? fallback : v
  }
  const [closeReason, setCloseReason] = useState('')
  const [buyerName,    setBuyerName]    = useState('')
  const [buyerAddress, setBuyerAddress] = useState('')
  const [buyerPan,     setBuyerPan]     = useState('')
  const [buyerPhone,   setBuyerPhone]   = useState('')
  // Set only via the Foodmandu/Pathao quick-select chips (Credit only, see render) — never
  // inferred from buyerName, which is free-text and could be edited/typo'd. The authoritative
  // "is this bill a delivery-partner order" flag; buyerName is just what displays alongside it.
  const [deliveryPartner, setDeliveryPartner] = useState('')
  const [billRemarks,  setBillRemarks]  = useState('')
  const [closing,     setClosing]     = useState(false)
  const [closeMsg,    setCloseMsg]    = useState('')
  const [compCostMap, setCompCostMap] = useState({}) // { recipeId: foodCostPerPortion } — fetched when Complimentary tab opens
  // Item-level comp (Pay tab, Supervisor+) — { [recipe_id]: qty comped }, excluded from this bill
  // and printed on a separate mini Complimentary Slip instead, while the rest (the remaining qty
  // on that same line, if any) bills normally. Distinct from the whole-order Complimentary tab.
  // Keyed by recipe_id, not the item row's own id — cart items freshly added this session (via
  // addItem()) never carry a real pos_order_items.id until re-fetched from the DB, so keying on
  // .id meant every item shared the same `undefined` key and toggling one ticked them all.
  // recipe_id is safe: addItem() always merges a re-tapped recipe into its existing line, so it's
  // unique per order regardless of whether the row has synced yet. A qty less than the line's
  // full qty is a partial comp — closeOrder splits that line's DB row in two (paid remainder +
  // a new comped row) rather than marking the whole thing comped.
  const [compQtyByRecipe, setCompQtyByRecipe] = useState({})
  const [itemCompReason, setItemCompReason] = useState('')
  const [itemsExpanded,  setItemsExpanded]  = useState(false) // collapsed by default — see render site
  // Buyer details used to always render 4 fields on every single Cash payment, on top of the
  // payment-method/discount/comp choices already on this tab — collapsed by default the same way
  // Items is, and force-expanded (no toggle) whenever requireBuyerId actually makes them mandatory.
  const [buyerExpanded, setBuyerExpanded] = useState(false)
  const [discountMode,    setDiscountMode]    = useState('amount') // 'amount' | 'percent'
  const [discountStr,     setDiscountStr]     = useState('')
  const [discountReason,  setDiscountReason]  = useState('')
  const [discountReasons, setDiscountReasons] = useState(DEFAULT_DISCOUNT_REASONS)
  // Pulling an already-fired line: the open prompt, the reason being typed into it, and the reason
  // that then rides along with the NEXT save. One reason covers one save rather than one line —
  // a save is one deliberate act, and asking twice for the same edit reads as a malfunction.
  const [pullPrompt, setPullPrompt] = useState(null)
  const [pullReason, setPullReason] = useState('')
  const [kotPullReason, setKotPullReason] = useState('')
  const [hscMap,      setHscMap]      = useState({}) // { recipeId: hscCode } — fetched once when Billing modal opens
  const [openShiftId, setOpenShiftId] = useState(null) // cached, not queried per-close — see loadOpenShift()
  const [billQrUrl,   setBillQrUrl]   = useState('')   // per-bill dynamic payment QR (data URL), regenerated as the total changes

  // Split payment — multiple tenders collected against one order/one invoice (not a split bill;
  // see [[Split Payment (multi-tender) for POS Charge]] plan). tenders: [{ method, amount, tenderedAmount }]
  const [splitMode,    setSplitMode]    = useState(false)
  const [tenders,       setTenders]     = useState([])
  const [tenderMethod, setTenderMethod] = useState('Cash')
  const [tenderAmtStr, setTenderAmtStr] = useState('')
  // { orderId } while a points redemption MAY be standing on that order (S754). Set BEFORE the redeem
  // call, not after it: a response lost after the server committed would otherwise leave points
  // debited with nothing here to hand them back. The server semantics this relies on (migration
  // 20260916100000): redeem_loyalty_points REPLACES an earlier redemption on the same bill, so a
  // retried Confirm redeems again without a double debit; and redeeming 0 CANCELS it (points back,
  // Loyalty leg removed), which is what undoing the tender, discarding the payment, or closing the
  // bill without the points tender does. Cancelling when nothing was redeemed is a harmless no-op.
  // Kept across backToFloor on purpose — it names its order, and a bill reopened later on this device
  // still has to hand the points back before it closes without them.
  const liveRedemptionRef = useRef(null)
  const undoingTenderRef = useRef(false)

  // The billing modal's two columns need a breakpoint, and an inline style cannot carry a media
  // query while PosOrders imports no stylesheet of its own (S754) — so the width is state. Below
  // 900px the fixed 418px preview column left a phone or portrait tablet a squeezed payment form.
  const [narrowBilling, setNarrowBilling] = useState(() => typeof window !== 'undefined' && window.innerWidth < 900)
  const [billPreviewOpen, setBillPreviewOpen] = useState(false)
  useEffect(() => {
    const onResize = () => setNarrowBilling(window.innerWidth < 900)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /* ── Recent Bills / Reprint ── */
  const [recentBillsOpen, setRecentBillsOpen] = useState(false)
  const [recentBills,     setRecentBills]     = useState([])
  const [recentBillsLoad, setRecentBillsLoad] = useState(false)
  // 'No bills closed yet today' and 'the list failed to load' are the same picture and opposite
  // facts: the first invites a staff member to re-bill a table they have already billed (S616).
  const [recentBillsError, setRecentBillsError] = useState(null)
  const [recentBillsSearch, setRecentBillsSearch] = useState('')
  const [ordersWithItemComp, setOrdersWithItemComp] = useState(() => new Set()) // pos_orders.id with any item-level comp — see loadRecentBills
  const [creditNoteOrder, setCreditNoteOrder] = useState(null) // order row currently in the Issue Credit Note modal

  /* ── offline mode (Order Taking only — Billing stays online-only, see closeOrder/openBilling gates) ── */
  const [isOnline,        setIsOnline]        = useState(() => navigator.onLine)
  const [pendingOrderIds, setPendingOrderIds] = useState(new Set()) // order ids currently queued, not yet synced
  const [syncingOffline,  setSyncingOffline]  = useState(false)
  const [conflictOrders,  setConflictOrders]  = useState([]) // queued orders whose server row was no longer 'open' at flush time
  // Mirror of conflictOrders' ids for loadFloor/openTable, which run inside flushPosOrderQueue's
  // closure where the state is stale (S754). A conflict entry is a bill closed elsewhere — it must
  // not be painted onto the floor as a live order.
  const conflictIdsRef = useRef(new Set())
  // S754 (owner decision): "Start new order with these" on a conflict entry. Holds that entry's
  // order_id while its items sit, unsent, on the order screen; the entry is discarded only once
  // that screen's order SAVES online (performSave), and the hold is dropped by backToFloor — so
  // backing out, or a failed save, leaves the conflict on the floor to try again.
  const conflictRecoveryRef = useRef(null)
  // S754 (owner decision): "Update Order" with unsent lines asks whether to send them now.
  // { units, lines, where } while the ask is open.
  const [sendPrompt, setSendPrompt] = useState(null)
  const [floorMsg,        setFloorMsg]        = useState('') // transient floor-view banner (e.g. blocked-table message)
  // Bills closed this session whose revenue/stock could not reach IMS (no matching open period).
  // Bumped so the floor banner appears immediately after the close that caused it, rather than
  // only after the next full refresh of unpostedCount below.
  const [imsPostWarning,  setImsPostWarning]  = useState(0)
  // Secondary writes that failed AFTER the thing they belong to was already committed —
  // a split-tender breakdown, a table release, a posted-stamp. None of these can be undone
  // by refusing the action (the bill is closed and has an invoice number), and none of them
  // should stop a cashier mid-service, so they surface here instead of being swallowed.
  // supabase-js RETURNS errors rather than throwing, so every one of these was previously
  // invisible: a try/catch around them catches nothing, and dropping the destructured
  // `error` discards the only evidence the write did not land.
  const [writeWarnings,   setWriteWarnings]   = useState([])
  // What the last closed bill earned, or why it didn't. Shown on the FLOOR view, not in the
  // billing modal — the modal closes the instant the bill does, so a message left there is
  // one nobody ever reads.
  const [loyaltyNote, setLoyaltyNote] = useState(null)
  // Redemption state, live only while the billing modal is open. balance is null until a
  // buyer phone has been entered and looked up — null and 0 are different facts here (not
  // checked yet vs checked and empty), and the panel renders nothing for the first.
  const [loyaltyBalance, setLoyaltyBalance] = useState(null)
  const [loyaltyPointValue, setLoyaltyPointValue] = useState(1)
  const [redeemStr, setRedeemStr] = useState('')
  const [loyaltyLookupMsg, setLoyaltyLookupMsg] = useState('')
  const [unpostedCount,   setUnpostedCount]   = useState(0)
  // Credit notes issued while no Inventory period was open for their month (S747) — the same
  // standing condition as unposted bills, recovered by the same Periods button.
  const [unpostedNotes,   setUnpostedNotes]   = useState(0)
  const flushRef = useRef(null)
  // Re-entry guard for closeOrder — a manual Charge tap and the QR auto-confirm poll both call
  // closeOrder('paid') and could otherwise land inside the same order concurrently. A ref (not
  // state) because the poll's setInterval closure needs the CURRENT value synchronously, not
  // whatever `closing` was when the interval callback was created.
  const closingRef = useRef(false)
  // Re-entry guard for performSave — saveOrder/sendTicket are only gated by the `saving` state,
  // which doesn't update synchronously, so a double-tap on Send Order before the re-render commits
  // can enter performSave twice with orderId still null and insert two pos_orders rows. A ref for
  // the same reason as closingRef above: it needs to be readable/settable synchronously mid-call.
  const savingRef = useRef(false)

  useEffect(() => {
    if (!clientId) return
    loadFloor()
    if (!navigator.onLine) {
      getCachedPosSettings(clientId).then(data => {
        if (!data) return
        const arr = data.pos_bot_categories
        if (arr?.length) setBotCategories(new Set(arr))
        setNotePresets(data.pos_note_presets || [])
        setDiscountReasons(data.pos_discount_reasons?.length ? data.pos_discount_reasons : DEFAULT_DISCOUNT_REASONS)
        setBillingSettings({
          is_vat_registered: data.is_vat_registered ?? true,
          invoice_prefix:    data.invoice_prefix || '',
          vat_number:        data.vat_number || '',
          property_address:  data.property_address || '',
          property_phone:    data.property_phone || '',
          payment_qr_data:   data.payment_qr_data || '',
          delivery_partners: data.pos_delivery_partners || [],
        })
        setOutletName(data.outlet_name || '')
      })
    } else {
      Promise.all([
        supabase.from('settings')
          .select('pos_bot_categories, pos_note_presets, pos_discount_reasons, is_vat_registered, invoice_prefix, vat_number, property_address, property_phone, payment_qr_data, pos_delivery_partners, pos_reservation_settings')
          .eq('client_id', clientId).maybeSingle(),
        supabase.from('clients').select('name').eq('id', clientId).single(),
      ]).then(([{ data }, { data: clientData }]) => {
        const arr = data?.pos_bot_categories
        if (arr?.length) setBotCategories(new Set(arr))
        setReservationSettings(normalizeReservationSettings(data?.pos_reservation_settings))
        setNotePresets(data?.pos_note_presets || [])
        setDiscountReasons(data?.pos_discount_reasons?.length ? data.pos_discount_reasons : DEFAULT_DISCOUNT_REASONS)
        setBillingSettings({
          is_vat_registered: data?.is_vat_registered ?? true,
          invoice_prefix:    data?.invoice_prefix || '',
          vat_number:        data?.vat_number || '',
          property_address:  data?.property_address || '',
          property_phone:    data?.property_phone || '',
          payment_qr_data:   data?.payment_qr_data || '',
          delivery_partners: data?.pos_delivery_partners || [],
        })
        setOutletName(clientData?.name || '')
        cachePosSettings(clientId, { ...data, outlet_name: clientData?.name || '' })
      })
    }
    if (navigator.onLine) flushRef.current?.()
  }, [clientId]) // eslint-disable-line

  // Keeps the floor-view Sent/Started/Ready badges live while a staff member is just looking at
  // the board (not tapping into a table, which is the only other time loadFloor/loadKotStatus run).
  useEffect(() => {
    if (view !== 'floor') return
    const poll = setInterval(() => loadKotStatus(), 5000)
    return () => clearInterval(poll)
  }, [view, tableOrders, takeawayOrders]) // eslint-disable-line

  // The floor itself used to refresh only after THIS device's own save or close, so a table
  // opened, billed or freed on another till stayed wrong here until someone tapped (S754). Quiet:
  // no "Loading tables…" flash, identical results do not re-render (setIfChanged inside loadFloor),
  // and a failed poll keeps the last good floor. Offline there is no server to ask — the queue
  // overlay is already current. Arriving back on the floor refreshes at once unless a load has
  // just run (closeOrder awaits its own loadFloor before backToFloor).
  const floorViewSeen = useRef(false)
  const loadFloorRef = useRef(null)
  useEffect(() => {
    if (view !== 'floor' || !clientId) return
    // Through a ref, not the closure: this interval lives for the whole floor visit, and a loadFloor
    // captured at mount would compute tile totals with the default VAT flag before settings load.
    if (floorViewSeen.current && navigator.onLine && Date.now() - lastFloorLoadAt.current > 2000) loadFloorRef.current?.({ quiet: true })
    floorViewSeen.current = true
    const poll = setInterval(() => { if (navigator.onLine) loadFloorRef.current?.({ quiet: true }) }, 15000)
    return () => clearInterval(poll)
  }, [view, clientId]) // eslint-disable-line

  // Keeps each cart line's KOT/BOT timer live while the order screen for a saved order is open.
  // A brand-new, not-yet-sent order (orderId still null) has no tickets to poll for.
  useEffect(() => {
    if (view !== 'order' || !orderId) { setOrderKotTickets([]); return }
    loadOrderKotTickets(orderId)
    const poll = setInterval(() => loadOrderKotTickets(orderId), 5000)
    return () => clearInterval(poll)
  }, [view, orderId]) // eslint-disable-line

  useEffect(() => {
    if (view !== 'order') return
    const tick = setInterval(() => setKotNow(Date.now()), 15000)
    return () => clearInterval(tick)
  }, [view])

  // Keeps pending guest-order requests live both on the floor grid (badge) and while a table is
  // open (Accept/Dismiss banner) — a guest can submit a new request at any point. clientId is in
  // the deps (not just view) so an admin "view as" client switch tears down and recreates this
  // interval with a fresh loadPendingGuestOrders closure bound to the new client — without it, the
  // running interval kept calling the OLD closure (and its OLD scopedFrom) until view happened to
  // change too, meaning the previous client's guest-order banner/chime could keep firing after
  // the switch.
  useEffect(() => {
    if (view !== 'floor' && view !== 'order') return
    const poll = setInterval(() => loadPendingGuestOrders(), 5000)
    return () => clearInterval(poll)
  }, [view, clientId]) // eslint-disable-line

  // Bookings change on the scale of minutes, not seconds — 60 s, not the 5 s the kitchen needs.
  // The once-a-minute clock tick beside it is what moves a tile's booking chip from quiet to
  // "due" as the booked time approaches, since the poll's setIfChanged suppresses re-renders
  // when nothing in the data moved.
  useEffect(() => {
    if (view !== 'floor') return
    const poll = setInterval(() => loadFloorReservations(), 60000)
    const tick = setInterval(() => setKotNow(Date.now()), 60000)
    return () => { clearInterval(poll); clearInterval(tick) }
  }, [view, clientId]) // eslint-disable-line

  // Handoff from the Reservations page: "Seat <name>" there picks a table and navigates here with
  // the booking and the FULL pos_tables row (table_name is snapshotted onto the order at first
  // save and prints on every KOT and bill). The history entry is cleared before the table opens
  // so a reload can never replay the seat.
  useEffect(() => {
    const handoff = location.state?.seatReservation
    if (!handoff?.reservation?.id || !handoff?.table?.id || !clientId) return
    seatReservationRef.current = handoff.reservation
    navigate(location.pathname, { replace: true, state: null })
    openTable(handoff.table)
  }, [location.state, clientId]) // eslint-disable-line

  useEffect(() => {
    const up   = () => { setIsOnline(true);  flushRef.current?.() }
    const down = () => setIsOnline(false)
    window.addEventListener('online',  up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  /* ── computed totals ── */
  // Non-VAT-registered clients print a plain PAN Bill with no VAT line (see buildBillHtml's
  // `vatReg` gate) — the live cart/payment totals must honor the same flag, or the amount
  // charged/tendered on screen drifts from the amount on the printed bill.
  const vatReg   = billingSettings.is_vat_registered
  const subEx    = orderItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
  const vatAmt   = vatReg ? orderItems.reduce((s, i) => s + i.qty * i.unit_price * (i.vat_rate ?? 0), 0) : 0
  const total    = Math.round(subEx + vatAmt) // rounded to the nearest rupee — matches the bill's Net Amount/Round Off line
  const compTotal = orderItems.reduce((s, i) => s + i.qty * (compCostMap[i.recipe_id] || 0), 0)

  // Item-level comp — only ever populated in the Pay tab, so `subEx`/`vatAmt`/`total`/`compTotal`
  // above (used by the Void and whole-order Complimentary tabs) stay exactly as they were: full
  // order, unaffected. The Pay tab's own totals are computed separately from the non-comped subset.
  // A line with a partial comp qty (less than its full qty) contributes to BOTH arrays below —
  // e.g. "3 x Veg Momo" with 1 comped becomes a comped row of qty 1 and a payable row of qty 2.
  const compedOrderItems = orderItems
    .filter(i => (compQtyByRecipe[i.recipe_id] || 0) > 0)
    .map(i => ({ ...i, qty: Math.min(compQtyByRecipe[i.recipe_id], i.qty) }))
  const payableOrderItems = orderItems
    .map(i => {
      const compQty = Math.min(compQtyByRecipe[i.recipe_id] || 0, i.qty)
      return compQty > 0 ? { ...i, qty: i.qty - compQty } : i
    })
    .filter(i => i.qty > 0)
  const itemCompFoodCost  = compedOrderItems.reduce((s, i) => s + i.qty * (compCostMap[i.recipe_id] || 0), 0)
  const itemCompCount     = compedOrderItems.length
  const hasItemComp       = itemCompCount > 0
  // Every item comped out — nothing left to actually bill. Confirm Payment gets blocked for this
  // (see closeOrder's guard) rather than issuing a real ₨0 Tax Invoice/PAN Bill with zero line
  // items, which would waste a sequential invoice number on an empty document — the
  // whole-order Complimentary tab already exists for exactly this case.
  const allItemsComped    = orderItems.length > 0 && payableOrderItems.length === 0
  const paySubEx     = payableOrderItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
  const payVatAmtRaw = vatReg ? payableOrderItems.reduce((s, i) => s + i.qty * i.unit_price * (i.vat_rate ?? 0), 0) : 0

  // Discount reduces the pre-VAT taxable base, then VAT is recalculated on the discounted amount
  // (same rule as purchase_entries.discount_amount in Purchases.js) — not a flat subtraction off total.
  // Non-admin/owner logins with a manager-set discount cap (`profile.pos_discount_limit`, a %,
  // null = unlimited) can never exceed it here regardless of whether they typed a flat ₨ amount or
  // a %, so the two entry modes stay consistent.
  const discountCapPct = (!isAdmin && !isOwner) ? profile?.pos_discount_limit : null
  const discountAmt = (() => {
    const v = parseFloat(discountStr) || 0
    if (v <= 0 || paySubEx <= 0) return 0
    const raw = discountMode === 'percent' ? Math.min(paySubEx, paySubEx * v / 100) : Math.min(paySubEx, v)
    if (discountCapPct == null) return raw
    return Math.min(raw, paySubEx * (discountCapPct / 100))
  })()
  const discountClamped = discountCapPct != null && paySubEx > 0 && (() => {
    const v = parseFloat(discountStr) || 0
    const effectivePct = discountMode === 'percent' ? v : (v / paySubEx * 100)
    return effectivePct > discountCapPct
  })()
  const discRatio = paySubEx > 0 ? discountAmt / paySubEx : 0
  const payVatAmt = payVatAmtRaw * (1 - discRatio)
  const payTotal  = Math.round(paySubEx - discountAmt + payVatAmt)
  // Buyer Name + Phone become compulsory (not just optional) whenever a discount is applied, or
  // when the bill is going on Credit — both cases need an identifiable, audited record.
  const requireBuyerId = discountAmt > 0 || payMethod === 'Credit'

  // Split payment — running total of tenders collected so far against payTotal, and what's left.
  const tendersTotal = tenders.reduce((s, t) => s + t.amount, 0)
  const remaining     = Math.max(0, payTotal - tendersTotal)
  // Tenders are recorded against the total AS IT WAS (S754). The discount box and the item-comp
  // controls are locked once one exists, but a total that still moved — or a redemption applied
  // on top of cash already taken — leaves more collected than the bill, which `remaining` clamps
  // to 0 and would have closed as "fully paid". Refused in closeOrder and on the button.
  const tendersOverpaid = tenders.length > 0 && tendersTotal > payTotal + 0.005
  // A redemption may cover what the OTHER tenders have not — capping it at the whole bill let
  // "Use max" on a half-paid bill take the collected total past the bill (S754).
  const redeemableTotal = Math.max(0, payTotal - tenders.filter(t => t.method !== 'Loyalty').reduce((s, t) => s + t.amount, 0))
  // Once a payment is recorded, what it was measured against is frozen (S754): the discount and
  // the item-comp picker lock, the same way "Single Payment" already did. Undo the tenders to edit.
  const tendersLocked = tenders.length > 0
  const tendersLockHint = 'Payments are already recorded against this total — undo them below to change the discount or comps.'

  // Single-payment Cash: a tender below the bill total is a short drawer with no cause recorded —
  // the change line clamps to 0, so without this nothing on screen even hints. Block Confirm
  // instead (split mode already guards via `remaining`). '' means "exact cash" (see
  // resolveTendered), so only a genuinely entered number can register a shortfall.
  const cashShortfall = (!splitMode && payMethod === 'Cash' && !Number.isNaN(parseFloat(tenderedStr)))
    ? Math.max(0, payTotal - resolveTendered(payTotal))
    : 0

  // Regenerate the dynamic payment QR as the payable amount changes (discount typed, items
  // edited) — the modal QR and print preview always encode the exact current amount. In split
  // mode this targets whatever the next tender's amount is (defaulting to the remaining balance),
  // not the full order total. makeBillQr is a hoisted function declaration, so calling it from
  // here is safe even though it appears later in the file.
  useEffect(() => {
    if (!billingOpen) { setBillQrUrl(''); return }
    const qrMethod = splitMode ? tenderMethod : payMethod
    const qrAmount = splitMode ? (parseFloat(tenderAmtStr) || remaining) : payTotal
    if (!QR_PAY_METHODS.includes(qrMethod) || !billingSettings.payment_qr_data || !(qrAmount > 0)) { setBillQrUrl(''); return }
    let cancelled = false
    makeBillQr(qrAmount, orderNo ? `CR${orderNo}` : null).then(url => { if (!cancelled) setBillQrUrl(url) })
    return () => { cancelled = true }
  }, [billingOpen, splitMode, payMethod, tenderMethod, tenderAmtStr, remaining, payTotal, orderNo, billingSettings.payment_qr_data]) // eslint-disable-line

  // Always the freshest closeOrder — a new function every render, closing over that render's
  // discountAmt/discountReason/buyerName/payableOrderItems/etc (closeOrder's 'paid' guards read
  // these directly, not via arguments). The poll effect below reads this ref instead of listing
  // all of those as its own dependencies, so a keystroke in an unrelated field (which changes
  // payableOrderItems's array identity on every render) no longer tears down and restarts the
  // setInterval before it ever fires — previously the poll effectively never survived a full 4s
  // tick while the modal was open and the cashier was still typing (discount, tender, etc).
  const closeOrderRef = useRef(null)
  closeOrderRef.current = closeOrder
  // payTotal changes on every discount/item edit too — same staleness risk as closeOrder above,
  // needed for the poll's amount-match check without also being a restart trigger.
  const payTotalRef = useRef(payTotal)
  payTotalRef.current = payTotal

  // Poll for an auto-confirmed QR payment while the Charge modal is showing one. The webhook
  // scaffold (supabase/functions/pos-payment-webhook) only ever produces a row once a
  // per-client pos_webhook_secret is set and a real provider is wired up to call it — until
  // then this simply never finds anything. Split payments are excluded; auto-closing one leg
  // of a partial tender is out of scope for v1 (see product-roadmap memory).
  useEffect(() => {
    if (!billingOpen || splitMode || !orderId || !QR_PAY_METHODS.includes(payMethod) || !billQrUrl) return
    let cancelled = false
    const poll = setInterval(async () => {
      const { data, error: confErr } = await scopedFrom('pos_payment_confirmations', 'id, provider, amount')
        .eq('matched_order_id', orderId).is('consumed_at', null)
        .order('received_at', { ascending: false }).limit(1)
      // A failed tick is indistinguishable from "the customer has not paid yet", which is the
      // safe reading — the cashier can still close the bill by hand. Logged, not surfaced: this
      // fires every 4s and a banner per tick would bury the screen.
      if (confErr) { console.error('payment confirmation poll failed:', confErr); return }
      const hit = data?.[0]
      if (!hit || cancelled) return
      if (hit.provider !== payMethod || Math.abs(hit.amount - payTotalRef.current) > 1) return
      // Consume the confirmation only once closeOrder actually finishes billing — not before.
      // Marking it consumed first (as this used to) would burn it on a close that aborts (e.g.
      // the comp-reason guard, or closingRef rejecting a concurrent manual tap), leaving no
      // unconsumed confirmation left for the next poll tick to retry against.
      const ok = await closeOrderRef.current('paid')
      if (ok && !cancelled) {
        // Logged rather than surfaced: the row is bound to this order by matched_order_id and
        // the order is now billed, so an unconsumed row cannot be picked up against anything
        // else. There is no action for a cashier to take, which is the test for whether a
        // failure belongs on the floor banner.
        const { error: consErr } = await scopedUpdate('pos_payment_confirmations', { consumed_at: new Date().toISOString() }).eq('id', hit.id)
        if (consErr) console.error('pos_payment_confirmations consume failed:', consErr)
      }
    }, 4000)
    return () => { cancelled = true; clearInterval(poll) }
    // Only what should actually restart the polling loop — !!billQrUrl (not the QR string
    // itself, which regenerates on every discount/amount keystroke) so re-rendering the same QR
    // for the same order doesn't reset the interval either.
  }, [billingOpen, splitMode, orderId, payMethod, !!billQrUrl]) // eslint-disable-line

  // Escape-to-close for this file's hand-rolled overlays (Billing/Covers/Recent Bills) — none of
  // them use the shared Modal.js component, so each needs the same listener Modal.js itself gets.
  // Only one of these is ever open at a time in practice; closing() guards the Billing modal the
  // same way its own backdrop-click handler already does, so Escape can't abandon an in-flight close.
  //
  // The Billing modal is deliberately NOT handled here any more (S754): it is on Modal, whose own
  // Escape goes through requestCloseBilling() and so through the "discard recorded payments?"
  // confirm. This document listener ignores Modal's stack, so leaving billing in it closed the
  // modal — tenders and all — on the very Escape that was meant to dismiss that confirm.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'Escape') return
      if (coversModal) { setCoversModal(false); setPendingTable(null) }
      else if (recentBillsOpen) setRecentBillsOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [coversModal, recentBillsOpen])

  // Look up the customer's points as soon as a phone is on the bill. Debounced because this
  // fires per keystroke on a field a cashier types ten digits into.
  //
  // fetchAllRows, not a bare select: a regular's ledger is one row per visit plus one per
  // redemption, and a truncated SUM would understate a balance the customer is about to spend —
  // the silent-wrong-number shape, on the one figure a diner will argue about.
  useEffect(() => {
    if (!billingOpen || !hasFeature('loyalty')) { setLoyaltyBalance(null); setLoyaltyLookupMsg(''); return }
    const phone = buyerPhone.trim()
    if (!phone) { setLoyaltyBalance(null); setLoyaltyLookupMsg(''); return }
    let cancelled = false
    const timer = setTimeout(async () => {
      const [custRes, setRes] = await Promise.all([
        scopedFrom('pos_customers', 'id, name').eq('phone', phone).maybeSingle(),
        supabase.from('settings').select('pos_loyalty_point_value').eq('client_id', clientId).maybeSingle(),
      ])
      if (cancelled) return
      setLoyaltyPointValue(Number(setRes?.data?.pos_loyalty_point_value) || 1)
      // A failed read is not 'no points' — that difference is the whole S594 rule, and here it
      // would have a cashier tell a regular to their face that they have nothing.
      if (custRes.error) { setLoyaltyBalance(null); setLoyaltyLookupMsg(`Couldn't check points — ${custRes.error.message}`); return }
      if (!custRes.data) { setLoyaltyBalance(null); setLoyaltyLookupMsg(''); return }
      const { data: rows, error: ledErr } = await fetchAllRows(() =>
        scopedFrom('pos_loyalty_ledger', 'points').eq('customer_id', custRes.data.id).order('id'))
      if (cancelled) return
      if (ledErr) { setLoyaltyBalance(null); setLoyaltyLookupMsg(`Couldn't check points — ${ledErr.message}`); return }
      setLoyaltyLookupMsg('')
      setLoyaltyBalance((rows || []).reduce((t, r) => t + (r.points || 0), 0))
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [billingOpen, buyerPhone, clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live bill/slip preview inside the Billing modal — built from the exact same functions used
  // for the real print, so what the cashier sees always matches what will actually print.
  //
  // It lives up here, far from the iframe that renders it, for one reason: the debounce below is a
  // hook, and this component's `hasPosAccess` early return sits between here and there.
  const previewDraftOrder = {
    invoice_no: null, invoice_fy: null,
    payment_method: splitMode && tenders.length > 0 ? 'Split' : payMethod,
    tendered_amount: !splitMode && payMethod === 'Cash' ? resolveTendered(payTotal) : null,
    buyer_name: buyerName, buyer_address: buyerAddress, buyer_pan: buyerPan, buyer_phone: buyerPhone,
    bill_remarks: billRemarks, close_reason: closeReason,
    discount_amount: discountAmt,
    table_name: activeTable?.name, order_no: orderNo, print_count: 0,
  }
  const previewHtml = !billingOpen ? null
    : billingTab === 'pay' ? buildBillHtml({
        order: previewDraftOrder, items: payableOrderItems, copyLabel: 'PREVIEW', qrUrl: billQrUrl, payments: tenders,
        qrAmount: splitMode ? (parseFloat(tenderAmtStr) || remaining) : payTotal,
        outletName, billingSettings, hscMap,
        tableName: activeTable?.name || 'Takeaway',
        cashierName: profile?.full_name || '',
      })
    : billingTab === 'writeoff' ? buildCompSlipHtml({
        order: previewDraftOrder, items: orderItems, costMap: compCostMap, copyLabel: 'PREVIEW',
        outletName,
        tableName: activeTable?.name || 'Takeaway',
        authorizedBy: profile?.full_name || '',
      })
    : null

  // What the iframe actually gets, on a trailing delay rather than on every render. Assigning
  // `srcDoc` replaces the whole document, so the browser re-parses and re-lays-out the bill from
  // scratch — measured at 17 ms median / 22 ms p90 in Chromium on a desktop for a 22-line bill,
  // and a till is usually a much slower tablet. Typing a buyer's name, a discount or a tendered
  // amount was paying that per character, on top of re-rendering this component.
  //
  // Nothing is armed when the bill has not changed: an unchanged render rebuilds a string that is
  // equal to the last one, so the effect's own dependency check sees no change. The delay is only
  // ever felt on a value still in flight.
  const [previewSrc, setPreviewSrc] = useState(null)
  const previewTabRef = useRef(billingTab)
  useEffect(() => {
    // Opening the modal, closing it, and switching tabs all paint immediately — the delay exists
    // for a field being typed into, and a pane showing the previous tab's document (or nothing at
    // all where the bill should be) reads as a fault rather than as latency.
    const tabChanged = previewTabRef.current !== billingTab
    previewTabRef.current = billingTab
    if (previewHtml == null || previewSrc == null || tabChanged) { setPreviewSrc(previewHtml); return }
    const t = setTimeout(() => setPreviewSrc(previewHtml), PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [previewHtml, billingTab]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  /* ── data loaders ── */

  // Turns a queued (not-yet-synced) offline order into the same shape as a live floor overlay
  // entry, so the floor grid renders identically whether the count comes from the server or the
  // local queue. Flagged `offlinePending` so the tile can show the "unsynced" dot.
  // Records a non-blocking write failure for the floor banner. Deduped, because a poll or a
  // retry can produce the same sentence repeatedly and a stack of identical warnings reads
  // as several separate problems. Each sentence names what did not save AND what is wrong
  // downstream because of it — a warning a cashier cannot act on is just noise.
  function warnWrite(sentence, err) {
    if (err) console.error('POS non-fatal write failed:', sentence, err)
    setWriteWarnings(w => (w.includes(sentence) ? w : [...w, sentence]))
  }

  function queuedOrderToOverlay(q) {
    return {
      orderId:   q.order_id,
      itemCount: q.items.reduce((s, i) => s + i.qty, 0),
      total:     q.items.reduce((s, i) => s + i.qty * i.unit_price * (1 + (vatReg ? (i.vat_rate ?? 0) : 0)), 0),
      covers:    q.covers,
      pending:   q.items.filter(i => !i.sent_to_kot).length,
      offlinePending: true,
    }
  }

  // What the floor draws, as signatures — a quiet poll that comes back identical must not
  // re-render the whole floor (setIfChanged). Every field a tile or takeaway card renders is here.
  const tablesSig    = list => rowsSignature(list, ['id', 'name', 'section', 'status', 'capacity'])
  const floorOrdSig  = m => mapSignature(m, o => [o.orderId, o.itemCount, o.total, o.covers, o.pending, o.offlinePending ? 1 : 0].join(':'))
  const takeawaysSig = list => rowsSignature(list, ['orderId', 'orderNo', 'itemCount', 'total', 'pending', 'offlinePending'])

  // A queued entry that was surfaced as a conflict belongs to a bill another device closed — never
  // an open order to paint or reopen (S754).
  const liveQueue = queue => queue.filter(q => !conflictIdsRef.current.has(q.order_id))

  async function loadFloor({ quiet = false } = {}) {
    const seq = ++floorReqSeq.current
    lastFloorLoadAt.current = Date.now()
    if (!quiet) setFloorLoad(true)

    if (!navigator.onLine) {
      const [cachedTables, rawQueue] = await Promise.all([getCachedPosTables(clientId), getPosOrderQueue()])
      if (seq !== floorReqSeq.current) return
      const queue = liveQueue(rawQueue)
      // No cached list is "never loaded on this device", not "no tables" — keep what is on screen.
      if (cachedTables) setIfChanged(setTables, cachedTables, tablesSig)
      const map = {}
      for (const q of queue) { if (q.table_id) map[q.table_id] = queuedOrderToOverlay(q) }
      setTableOrders(map)
      // Takeaways already on screen from the last online read stay; queued ones are layered on.
      const queuedTakeaways = queue.filter(q => !q.table_id).map(q => ({ ...queuedOrderToOverlay(q), orderNo: null }))
      setTakeawayOrders(prev => [
        ...prev.filter(t => !queuedTakeaways.some(q => q.orderId === t.orderId)),
        ...queuedTakeaways,
      ])
      setPendingOrderIds(new Set(rawQueue.map(q => q.order_id)))
      setKotStatusByTable({}) // pos_kot_log is server-only — no reliable status while offline
      setFloorLoad(false)
      return
    }

    if (!quiet) loadOpenShift()
    const [tblRes, ordRes, { count: unposted, error: unpostedErr }, { count: notesWaiting, error: notesErr }] = await Promise.all([
      scopedFrom('pos_tables')
        .order('sort_order').order('name'),
      scopedFrom('pos_orders', 'id, order_no, table_id, covers, pos_order_items(qty, unit_price, vat_rate, sent_to_kot)')
        .eq('status', 'open'),
      // head:true — a count, not rows, so the 1000-row cap cannot apply. Backed by the partial
      // index idx_pos_orders_unposted, so it stays cheap however large the table gets.
      scopedFrom('pos_orders', 'id', { count: 'exact', head: true })
        .eq('status', 'billed').is('ims_posted_at', null),
      // Same shape, backed by idx_pos_credit_notes_unposted.
      scopedFrom('pos_credit_notes', 'id', { count: 'exact', head: true })
        .is('ims_posted_at', null),
    ])
    if (seq !== floorReqSeq.current) return
    // A failed count keeps the last value (a failed poll must not blank live state, S654) — and a
    // bundle deployed ahead of the migration reads 42703 here, which must not paint a banner.
    if (!unpostedErr) setUnpostedCount(unposted || 0)
    if (!notesErr) setUnpostedNotes(notesWaiting || 0)

    // S754: both reads used to drop their error, so a failed read painted "No tables set up yet",
    // freed every tile, and wrote the EMPTY list into the offline cache the till falls back on.
    // Now a failure keeps last-good on screen, leaves the cache alone, and says so with a Retry.
    const readErr = tblRes.error || ordRes.error
    if (readErr) {
      console.error('loadFloor failed, keeping the last floor shown:', readErr)
      setFloorLoadError(readErr.message || 'the floor could not be read')
      setFloorLoad(false)
      return
    }
    setFloorLoadError('')
    const tbls = tblRes.data || []
    setIfChanged(setTables, tbls, tablesSig)
    cachePosTables(clientId, tbls)
    const map = {}
    const takeaways = []
    for (const o of (ordRes.data || [])) {
      const items = o.pos_order_items || []
      const overlay = {
        orderId:   o.id,
        itemCount: items.reduce((s, i) => s + i.qty, 0),
        total:     items.reduce((s, i) => s + i.qty * i.unit_price * (1 + (vatReg ? (i.vat_rate ?? 0) : 0)), 0),
        covers:    o.covers,
        pending:   items.filter(i => !i.sent_to_kot).length,
      }
      if (o.table_id) map[o.table_id] = overlay
      else takeaways.push({ ...overlay, orderNo: o.order_no || null })
    }
    // Layer any still-queued (not-yet-synced) local edits on top of server truth, so a table
    // doesn't briefly look wrong while a reconnect flush is still in flight.
    const rawQueue = await getPosOrderQueue()
    if (seq !== floorReqSeq.current) return
    const queue = liveQueue(rawQueue)
    for (const q of queue) {
      if (q.table_id) map[q.table_id] = queuedOrderToOverlay(q)
      else {
        const i = takeaways.findIndex(t => t.orderId === q.order_id)
        const ov = { ...queuedOrderToOverlay(q), orderNo: i >= 0 ? takeaways[i].orderNo : null }
        if (i >= 0) takeaways[i] = ov; else takeaways.push(ov)
      }
    }
    // Oldest first, so a takeaway keeps its place on the floor as new ones arrive.
    takeaways.sort((a, b) => (a.orderNo ?? Infinity) - (b.orderNo ?? Infinity))
    setIfChanged(setTableOrders, map, floorOrdSig)
    setIfChanged(setTakeawayOrders, takeaways, takeawaysSig)
    setIfChanged(setPendingOrderIds, new Set(rawQueue.map(q => q.order_id)), s => [...s].sort().join(','))
    setFloorLoad(false)
    if (quiet) return
    loadKotStatus(map, takeaways)
    loadPendingGuestOrders()
    loadFloorReservations()
  }

  // Today's live bookings for the floor tiles, plus the count of public requests awaiting an
  // Accept. Deliberately NOT part of loadFloor's Promise.all above — that batch destructures
  // `{ data }` only, and a dropped error here would blank every tile's booking chip.
  async function loadFloorReservations() {
    if (!navigator.onLine) return
    const today = nepalBs(new Date())
    if (!today) return
    const start = bsDayBoundaryIso(today.year, today.month, today.day, false)
    const endOfDay = bsDayBoundaryIso(today.year, today.month, today.day, true)
    // Six hours past the BS day's end: a 12:15 AM booking belongs to tomorrow's date but to
    // tonight's service, so it is on the board during the preceding evening.
    const end = new Date(new Date(endOfDay).getTime() + 6 * 3600000).toISOString()
    const [{ data, error }, { count, error: countErr }] = await Promise.all([
      scopedFrom('pos_reservations', 'id, customer_name, phone, party_size, reserved_for, duration_minutes, status, arrived_at, pos_reservation_tables(table_id)')
        .in('status', FLOOR_STATUSES)
        .gte('reserved_for', start).lte('reserved_for', end)
        .order('reserved_for'),
      scopedFrom('pos_reservations', 'id', { count: 'exact', head: true }).eq('status', 'requested'),
    ])
    // A failed poll keeps last-good — an emptied strip reads as "no bookings tonight".
    if (error) console.error('loadFloorReservations failed, keeping last known:', error)
    else {
      const rows = (data || []).map(r => ({ ...r, tables: tableIdsOf(r).sort().join(',') }))
      setIfChanged(setFloorReservations, rows, list => rowsSignature(list, ['id', 'status', 'reserved_for', 'party_size', 'customer_name', 'arrived_at', 'tables']))
    }
    if (countErr) console.error('reservation request count failed, keeping last known:', countErr)
    else setRequestCount(count || 0)
  }

  // Pending (not yet Accepted/Dismissed) guest self-order requests, grouped by table — see
  // submit_guest_order/pos_guest_order_requests (Guest QR self-ordering, Pro-tier feature).
  // Guest ordering only ever happens online, so (like loadKotStatus) this is skipped offline.
  async function loadPendingGuestOrders() {
    if (!navigator.onLine) return
    const { data, error } = await scopedFrom('pos_guest_order_requests', 'id, table_id, items, guest_notes, covers, created_at')
      .eq('status', 'pending')
    // A failed read here would empty the floor's guest-order banner AND clear seenGuestRequestIds,
    // so the next successful poll re-chimes for requests already seen. Keep both as they were.
    if (error) { console.error('loadPendingGuestOrders failed, keeping last known requests:', error); return }
    const rows = data || []

    // Chime once per genuinely new request — skipped on the very first load (that's just
    // whatever was already pending when this screen opened, not a fresh arrival).
    if (guestOrdersLoadedOnce.current && rows.some(r => !seenGuestRequestIds.current.has(r.id))) {
      playGuestOrderChime()
    }
    seenGuestRequestIds.current = new Set(rows.map(r => r.id))
    guestOrdersLoadedOnce.current = true

    const map = {}
    for (const r of rows) {
      if (!map[r.table_id]) map[r.table_id] = []
      map[r.table_id].push(r)
    }
    // Every 5 s, and the answer is almost always the same one. Without the bail-out this poll
    // alone re-rendered the whole order/floor screen twelve times a minute for the length of a
    // service. A request row is immutable once created — Accept/Dismiss changes its status, which
    // takes it out of this query entirely — so the set of ids is the whole state.
    setIfChanged(setPendingGuestOrders, map, m => mapSignature(m, list => (list || []).map(r => r.id).join(',')))
  }

  // Short two-tone beep synthesized via the Web Audio API — no audio asset to host/ship. Browsers
  // block audio before any user gesture on the page; staff have already interacted with the page
  // via PIN login by the time they reach the floor view, so this is a low-impact caveat in
  // practice rather than a real gap.
  function playGuestOrderChime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      const now = ctx.currentTime
      ;[880, 660].forEach((freq, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.0001, now + i * 0.18)
        gain.gain.exponentialRampToValueAtTime(0.3, now + i * 0.18 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16)
        osc.connect(gain); gain.connect(ctx.destination)
        osc.start(now + i * 0.18)
        osc.stop(now + i * 0.18 + 0.18)
      })
    } catch (_) { /* audio blocked or unsupported — visual banner still shows */ }
  }

  // Merges one guest-requested item into the local cart, same dedup-by-recipe_id logic as
  // addItem() — but at whatever qty the guest asked for (addItem always adds exactly 1), and
  // without triggering the upsell suggestion engine (this isn't a staff menu tap).
  function mergeGuestItem(it) {
    setOrderItems(prev => {
      const idx = prev.findIndex(i => i.recipe_id === it.recipe_id)
      if (idx >= 0) {
        // The cart holds one line per recipe_id, so a guest's note ("no onion — allergy") has
        // nowhere to go but onto the existing line. It used to be dropped here outright (S754),
        // i.e. the one order path where the diner typed the instruction themselves lost it.
        const guestNote = (it.note || '').trim()
        const current = prev[idx]
        const parts = (current.notes || '').split(',').map(s => s.trim()).filter(Boolean)
        const notes = guestNote && !parts.includes(guestNote) ? [...parts, guestNote].join(', ') : (current.notes || '')
        return prev.map((item, n) => n === idx
          ? {
              ...item,
              qty:         item.qty + it.qty,
              notes,
              sent_to_kot: false,
              sent_qty:    item.sent_to_kot ? item.qty : (item.sent_qty || 0),
            }
          : item)
      }
      return [...prev, {
        recipe_id:   it.recipe_id,
        name:        it.name,
        category:    it.category || 'Other',
        qty:         it.qty,
        unit_price:  parseFloat(it.unit_price) || 0,
        vat_rate:    vatReg ? (parseFloat(it.vat_rate) || 0) : 0,
        sent_to_kot: false,
        sent_qty:    0,
        notes:       it.note || '',
      }]
    })
  }

  // Accept merges the request's items into the staff's local cart (the same way tapping a menu
  // tile does) — the actual pos_order_items write still only ever happens through the existing
  // performSave(), never here. The request's own DB status write is deferred the same way: Accept
  // only marks it locally (pendingAcceptedGuestReqIds), and performSave() persists 'accepted' once
  // the merged items are actually saved — see the comment there. Dismiss makes no cart change and
  // writes immediately, since there's nothing to lose by navigating away afterward.
  async function decideGuestOrder(request, decision) {
    if (decidingGuestReqIds.has(request.id)) return
    setDecidingGuestReqIds(prev => new Set(prev).add(request.id))
    try {
      if (decision === 'accepted') {
        for (const it of (request.items || [])) mergeGuestItem(it)
        setPendingAcceptedGuestReqIds(prev => new Set(prev).add(request.id))
        // Hide it from the banner/floor badge now (it's already reflected in the cart) — restored
        // by loadPendingGuestOrders() if the staff navigates away before saving (backToFloor).
        setPendingGuestOrders(prev => {
          const next = { ...prev }
          const filtered = (next[request.table_id] || []).filter(r => r.id !== request.id)
          if (filtered.length > 0) next[request.table_id] = filtered
          else delete next[request.table_id]
          return next
        })
      } else {
        const { error: decErr } = await scopedUpdate('pos_guest_order_requests', {
          status: decision, decided_at: new Date().toISOString(), decided_by: profile?.id || null,
        }).eq('id', request.id)
        // loadPendingGuestOrders() below puts the request straight back on screen if this failed,
        // which looks like the button did nothing. Name it instead.
        if (decErr) setMsg('error:Could not dismiss that guest order — try again.')
        loadPendingGuestOrders()
      }
    } finally {
      setDecidingGuestReqIds(prev => { const next = new Set(prev); next.delete(request.id); return next })
    }
  }

  // Per table, a summary of the tickets sent for its currently open order (summarizeTicketStages in
  // posSignals.js): the least-advanced stage not yet served, and how many tickets are ready. A table
  // with a Ready starter and a New main says "1 ready" (owner decision, S754) — it used to say "Sent",
  // which hid the food sitting in the pass. Takes an optional fresh map (passed synchronously from
  // loadFloor right after setTableOrders) to avoid reading stale state before that setState lands.
  async function loadKotStatus(ordersMap = tableOrders, takeaways = takeawayOrders) {
    if (!navigator.onLine) return
    const orderIdToTable = {}
    for (const [tableId, ord] of Object.entries(ordersMap)) {
      if (ord?.orderId && !ord.offlinePending) orderIdToTable[ord.orderId] = tableId
    }
    // Takeaway cards share the badge (S754), keyed `takeaway:<orderId>` in the same map — a table
    // id is a uuid, so the prefix cannot collide with one.
    for (const t of takeaways) {
      if (t.orderId && !t.offlinePending) orderIdToTable[t.orderId] = `takeaway:${t.orderId}`
    }
    const orderIds = Object.keys(orderIdToTable)
    if (orderIds.length === 0) { setKotStatusByTable({}); return }
    // Cancelled tickets belong to a voided order; they used to fall through KOT_STATUS_RANK's `?? 0`
    // and read as "Sent". Served ones are kept — they are what turns a finished table to "Served".
    const { data, error } = await scopedFrom('pos_kot_log', 'order_id, status').in('order_id', orderIds).neq('status', 'cancelled')
    // Polled every few seconds. Returning here keeps the last known badges on screen; falling
    // through with a null `data` computes an EMPTY map and blanks every table's kitchen status,
    // which a waiter reads as "nothing has been started" rather than as a failed read.
    if (error) { console.error('loadKotStatus failed, keeping last known statuses:', error); return }
    const statusesByOrder = {}
    for (const row of (data || [])) (statusesByOrder[row.order_id] = statusesByOrder[row.order_id] || []).push(row.status)
    const map = {}
    for (const [oid, tableId] of Object.entries(orderIdToTable)) {
      const summary = summarizeTicketStages(statusesByOrder[oid])
      if (summary) map[tableId] = summary
    }
    // Every field a tile draws from the summary is in the signature (setIfChanged's own rule).
    setIfChanged(setKotStatusByTable, map, m => mapSignature(m, s => `${s.stage}:${s.ready}:${s.open}`))
  }

  // Ticket rows for the order currently open on screen — matched to a cart line by recipe_id (see
  // ticketForRecipe below) so each item can show its own Sent/Started/Ready timer, not just the
  // table-wide summary loadKotStatus computes for the floor view.
  async function loadOrderKotTickets(oid) {
    if (!oid || !navigator.onLine) { setOrderKotTickets([]); return }
    // Served tickets stay in this read (S754): a line whose ticket was served reads "Served" on the
    // cart rather than falling back to an older ticket's stage.
    const { data, error } = await scopedFrom('pos_kot_log', 'id, items, status, sent_at, started_at, ready_at, estimated_prep_minutes')
      .eq('order_id', oid)
      .neq('status', 'cancelled')
      .order('sent_at', { ascending: false })
    // Same rule as loadKotStatus: an empty result on a failed read would drop every per-item
    // Sent/Started/Ready timer off the cart, which is indistinguishable from the kitchen not
    // having touched the order.
    if (error) { console.error('loadOrderKotTickets failed, keeping last known tickets:', error); return }
    // Polled every 5 s while an order is open. `items` is deliberately not in the signature: a
    // pos_kot_log row's lines never change after it is written (a later send inserts a new row,
    // and a pulled line is recorded in pos_kot_removals), so a change to what a ticket contains
    // always shows up as a different set of ids.
    setIfChanged(setOrderKotTickets, data || [],
      rows => rowsSignature(rows, ['id', 'status', 'started_at', 'ready_at', 'estimated_prep_minutes']))
  }

  // Most-recently-sent ticket containing this recipe — if the same item was sent in two separate
  // KOT/BOT sends (e.g. reordered after the first batch was already Ready), the newer send is the
  // one still relevant to a waiter checking on it.
  function ticketForRecipe(recipeId) {
    if (!recipeId) return null
    return orderKotTickets.find(t => (t.items || []).some(i => i.recipe_id === recipeId)) || null
  }

  // "Served" on the order screen (S754, migration 20260916110000): every ticket of this order that is
  // Ready moves to Served, so the Kitchen Display drops it and the floor stops showing food waiting.
  // Conditional on 'ready' exactly as the KDS transitions are — a ticket the kitchen has not finished
  // is never marked served from here, and one the KDS already served is simply not matched.
  // `.select('id')` because a filter that matches nothing returns no error, only an empty result.
  async function markOrderServed() {
    if (!orderId || !navigator.onLine || servingTickets) return
    setServingTickets(true)
    const { data, error } = await scopedUpdate('pos_kot_log', {
      status: 'served', served_at: new Date().toISOString(), status_updated_by: profile?.id || null,
    }).eq('order_id', orderId).eq('status', 'ready').select('id')
    setServingTickets(false)
    if (error) setMsg(`error:Not marked as served — the kitchen still shows it ready. ${errorText(error, 'staff')}`)
    else if (!data?.length) setMsg('ok:Nothing was waiting — it was already marked served.')
    else setMsg(`ok:${data.length === 1 ? 'Ticket' : `${data.length} tickets`} marked served.`)
    loadOrderKotTickets(orderId)
  }

  // Replays every queued offline order against Supabase, one at a time (structurally identical to
  // Stock.js's flushQueue — swallow-and-retry-later on failure, never dequeue on error). Runs on
  // reconnect (window 'online' event, via flushRef below) and once on mount if already online.
  async function flushPosOrderQueue() {
    const queue = await getPosOrderQueue()
    if (queue.length === 0) return
    setSyncingOffline(true)
    for (const q of queue) {
      const oid = q.order_id
      // A replay the SERVER refused for a reason that will not change on retry goes to the conflict
      // list — retrying it on every flush would never land and would keep the order hidden (S754).
      // `reason` picks the notice's wording; the entry stays queued until recovered or discarded.
      const toConflict = reason => {
        conflictIdsRef.current.add(oid)
        setConflictOrders(prev => prev.some(c => c.order_id === oid) ? prev : [...prev, { ...q, reason }])
      }
      try {
        if (q.created_offline) {
          // Upsert, not insert: if a previous flush attempt got this far but died before
          // dequeuePosOrder ran (e.g. connectivity dropped mid-sync), created_offline is still
          // true and this same row id gets retried. A plain insert would hit the PK and fail
          // forever, stranding the order. onConflict: 'id' makes the retry a no-op on the order
          // row itself instead of a permanent dead end.
          const { error } = await scopedUpsert('pos_orders', {
            id: oid, table_id: q.table_id, table_name: q.table_name,
            status: 'open', covers: q.covers, opened_by: q.opened_by,
          }, { onConflict: 'id' })
          if (error) {
            // 23505 is pos_orders_one_open_per_table: another device opened this table while this
            // one was offline. bill_locked: a previous flush did create the row and it has since
            // been billed, so the upsert is a write to a closed bill.
            if (error.code === '23505') { toConflict('table_taken'); continue }
            if (error.hint === HINT.locked || error.hint === HINT.notOpen) { toConflict('closed'); continue }
            throw error
          }
          if (q.table_id) {
            const { error: tErr } = await scopedUpdate('pos_tables', { status: 'occupied' }).eq('id', q.table_id)
            if (tErr) console.error('offline sync: table occupy failed', tErr)
          }
        } else {
          // Safety check: don't blindly overwrite an order another device already closed while
          // this one was offline — a queued item replace on a billed/voided order would be wrong.
          const { data: current, error: curErr } = await scopedFrom('pos_orders', 'status').eq('id', oid).single()
          // This read IS the safety check, so dropping its error made the check pass vacuously:
          // a failed read left `current` null, the guard below false, and the queued replay went
          // straight over an order another device may have already billed or voided — the exact
          // outcome the guard exists to prevent. PGRST116 is the one error that is an answer
          // rather than a failure (the row is gone), and it is a conflict too: retrying it
          // forever would just replay against an id that no longer exists.
          if (curErr) {
            if (curErr.code === 'PGRST116') { toConflict('closed'); continue }
            throw curErr // left queued, retried on the next flush
          }
          if (current && current.status !== 'open') {
            toConflict('closed')
            continue // stays queued — surfaced for manual review, not auto-discarded
          }
          const { error: cvErr } = await scopedUpdate('pos_orders', { covers: q.covers }).eq('id', oid)
          if (cvErr) {
            // Billed between the status read and this write: the close guard now refuses any write
            // to a closed bill, which is the same conflict one round trip later.
            if (cvErr.hint === HINT.locked) { toConflict('closed'); continue }
            console.error('offline sync: covers update failed', cvErr)
          }
        }

        // Through the RPC, not delete-then-insert: this replay carries exactly the same two risks
        // the online path does. It must be atomic (S573 — a stall between the two writes leaves a
        // live order with zero lines), and it must record any already-fired line the offline edit
        // dropped, or going offline becomes the way to pull a fired item without leaving a trace.
        // The reason is null by construction — the prompt ran on a device that was offline hours
        // ago and its answer was never queued — so these rows read as "none given" on the Pulled
        // Items tab, which is the honest label for a removal nobody can now be asked about.
        //
        // p_expected_version (S754): the offline edits were made against the version this device last
        // saw, so an order another tablet saved in the meantime is refused ('stale_order') instead of
        // overwritten with this device's older lines — and goes to the conflict list, whose "Start new
        // order with these" puts back only what the server's order does not already carry. An order
        // created offline sends none: its row did not exist, and a retried flush after a save that
        // landed would otherwise refuse itself.
        const replayArgs = { p_order_id: oid, p_rows: (q.items || []).map(toItemPayload), p_removal_reason: null }
        if (!q.created_offline && Number.isInteger(q.items_version)) replayArgs.p_expected_version = q.items_version
        const { data: replayed, error: syncErr } = await supabase.rpc('save_pos_order_items', replayArgs)
        if (syncErr) {
          const reason = {
            [HINT.stale]: 'stale', [HINT.notOpen]: 'closed', [HINT.locked]: 'closed', [HINT.offMenu]: 'off_menu',
          }[syncErr.hint]
          if (reason) { toConflict(reason); continue }
          throw syncErr
        }

        // Best-effort, matching the online logKotSend — but read as a returned error, not a try/catch:
        // supabase-js resolves with { error } and the catch this replaces never fired (S654).
        for (const send of q.kot_sends || []) {
          const { error: sendErr } = await scopedInsert('pos_kot_log', { ...send, order_id: oid })
          if (sendErr) console.error('offline sync: queued KOT/BOT log insert failed (the ticket printed; KDS and KOT Register miss it):', sendErr)
        }

        await dequeuePosOrder(oid)
        setPendingOrderIds(prev => { const next = new Set(prev); next.delete(oid); return next })

        // If the order currently open on screen just got synced, backfill its real order number —
        // and its version: this replay just advanced it, and the screen's next save would otherwise
        // be refused as stale against the device's own sync.
        if (orderId === oid) {
          if (Number.isInteger(replayed?.items_version)) itemsVersionRef.current = replayed.items_version
          const { data: synced, error: syncedErr } = await scopedFrom('pos_orders', 'order_no').eq('id', oid).single()
          // Cosmetic only — the header keeps showing "#— (pending)" until the next refresh.
          if (syncedErr) console.error('order_no backfill read failed:', syncedErr)
          else if (synced) setOrderNo(synced.order_no)
        }
      } catch (err) {
        console.error('POS offline order sync failed, will retry:', err) // left queued, retried next flush
      }
    }
    setSyncingOffline(false)
    loadFloor()
  }
  flushRef.current = flushPosOrderQueue
  loadFloorRef.current = loadFloor

  // S754 (owner decision): a conflict's items back onto the floor as UNSENT lines — a new order on
  // that table (or a new takeaway), or, if the table already has an open order again, that order
  // with these added. Nothing is saved here: the waiter reviews the lines and presses Send/Update,
  // and the conflict entry is discarded only once that save lands (performSave). Online only —
  // offline there is no way to know what is already open on the table.
  async function startOrderFromConflict(c) {
    setFloorMsg('')
    if (!navigator.onLine) { setFloorMsg('error:Reconnect first — the table has to be checked for an open order before these items can go back on it.'); return }
    // Unsent by construction, whatever the queue said: the bill they were queued against is closed,
    // so nothing on it reached this order's station. The waiter decides what to send.
    const incoming = (c.items || []).map(i => ({ ...i, sent_to_kot: false, sent_qty: 0 }))
    if (incoming.length === 0) { setFloorMsg('error:That queued order has no items to put back.'); return }
    // A 'stale' or 'off_menu' conflict (S754) is an order that is STILL OPEN — another device saved it,
    // or a dish went off the menu — and the queue holds this device's whole cart, most of which that
    // order already carries. Put back only the difference, or every dish already on it doubles.
    const sameOrderStillOpen = c.reason === 'stale' || c.reason === 'off_menu'
    const toPutBack = serverLines => (sameOrderStillOpen ? missingFromServer(c.items, serverLines) : incoming)

    if (!c.table_id) {
      if (sameOrderStillOpen) {
        const { data: same, error: sameErr } = await scopedFrom('pos_orders', OPEN_ORDER_SELECT).eq('id', c.order_id).maybeSingle()
        if (sameErr) {
          window.alert(`Couldn't load that takeaway order: ${sameErr.message}\n\nNothing was changed — try again in a moment.`)
          return
        }
        if (same && same.status === 'open') {
          seatReservationRef.current = null
          const lines = showLoadedOrder(null, { id: same.id, orderNo: same.order_no, covers: same.covers, items: same.pos_order_items, itemsVersion: same.items_version })
          const back = toPutBack(same.pos_order_items)
          setOrderItems(mergeUnsentLines(lines, back))
          setMsg(back.length
            ? 'ok:The offline items that order did not already have were added to it, unsent — review them, then Update Order.'
            : 'ok:That order already carries everything from the offline copy — nothing needed adding.')
          conflictRecoveryRef.current = c.order_id
          return
        }
      }
      setActiveTable(null); setOrderId(null); setOrderNo(null); itemsVersionRef.current = null
      setCovers(Math.max(1, parseInt(c.covers, 10) || 1))
      setOrderItems(incoming); markCartSaved([])
      setMsg('ok:Items from the offline order are back on a new takeaway — review them, then Send Order.')
      setView('order'); loadMenu()
      conflictRecoveryRef.current = c.order_id
      return
    }

    const table = tables.find(t => t.id === c.table_id)
    if (!table) { setFloorMsg(`error:${c.table_name || 'That table'} is no longer on the floor plan — use a takeaway or another table for these items.`); return }
    if (table.status === 'inactive') { setFloorMsg(`error:${table.name} is inactive — use another table for these items.`); return }

    const { data: existing, error: existingErr } = await scopedFrom('pos_orders', OPEN_ORDER_SELECT)
      .eq('status', 'open')
      .eq('table_id', table.id)
      .maybeSingle()
    // Same refusal as openTable: guessing "empty" here starts a second order on a table that has one.
    if (existingErr) {
      window.alert(`Couldn't check whether ${table.name} already has an open order: ${existingErr.message}\n\nNothing was changed — try again in a moment.`)
      return
    }

    if (existing) {
      seatReservationRef.current = null
      const lines = showLoadedOrder(table, { id: existing.id, orderNo: existing.order_no, covers: existing.covers, items: existing.pos_order_items, itemsVersion: existing.items_version })
      // One line per recipe on an order (sent flags are matched by recipe_id), so a recipe already
      // on it gains the quantity as an unsent change; its sent count stays, so only the added part
      // goes to the station. Only the difference when it is the same order (see toPutBack).
      const back = existing.id === c.order_id ? toPutBack(existing.pos_order_items) : incoming
      setOrderItems(mergeUnsentLines(lines, back))
      setMsg(back.length === 0
        ? `ok:${table.name}'s order already carries everything from the offline copy — nothing needed adding.`
        : `ok:${table.name} already had an open order — the offline items were added to it, unsent. Review them, then Update Order.`)
    } else {
      seatReservationRef.current = null
      setActiveTable(table); setOrderId(null); setOrderNo(null); itemsVersionRef.current = null
      setCovers(Math.max(1, parseInt(c.covers, 10) || 1))
      setOrderItems(incoming); markCartSaved([])
      setMsg('ok:Items from the offline order are on a new order for this table — review them, then Send Order.')
      setView('order'); loadMenu()
    }
    conflictRecoveryRef.current = c.order_id
  }

  function discardConflictOrder(orderIdToDiscard) {
    conflictIdsRef.current.delete(orderIdToDiscard)
    dequeuePosOrder(orderIdToDiscard)
    setConflictOrders(prev => prev.filter(c => c.order_id !== orderIdToDiscard))
    setPendingOrderIds(prev => { const next = new Set(prev); next.delete(orderIdToDiscard); return next })
  }

  // Cached for the floor and for a void's shift stamp. Since S754 it is NO LONGER what gates
  // billing: closeOrder re-reads the open shift itself for Charge and Complimentary, because this
  // cache can be minutes stale and survives a failed read by design.
  async function loadOpenShift() {
    const { data, error } = await scopedFrom('pos_shifts', 'id')
      .eq('status', 'open').maybeSingle()
    // Keep the cached id rather than nulling it: this runs after every close, and writing null
    // on a failed read silently unlinks every subsequent bill from the open shift, so the
    // Z-report ends the night short with nothing anywhere saying why.
    if (error) { console.error('loadOpenShift failed, keeping cached shift id:', error); return }
    setOpenShiftId(data?.id || null)
  }

  // `force` re-reads a menu already loaded — after a save refused a dish that is no longer on it
  // (S754), the menu on screen is exactly what is out of date. `menuLoaded` in this closure may be
  // stale-true, which is why it is an argument rather than a state reset.
  async function loadMenu({ force = false } = {}) {
    if (!clientId || (menuLoaded && !force)) return

    if (!navigator.onLine) {
      const cached = await getCachedPosMenu(clientId)
      if (cached) {
        setMenu(cached.menu || [])
        setManualSuggestions(cached.manualSuggestions || {})
        setMenuLoaded(true)
      }
      return
    }

    const [{ data, error: menuErr }, { data: suggData, error: suggErr }] = await Promise.all([
      scopedFrom('recipes', 'id, name, category, recipe_code, selling_price, vat_rate, me_class')
        .eq('is_active', true)
        .eq('pos_enabled', true)
        // `.or(...)`, not `.neq('category','Sub-Recipe')` (S714). category is NULLABLE with no
        // default and a server-side .neq drops NULL rows too, so a dish with no category was
        // missing from the till's menu entirely — unorderable, with no error and nothing on screen
        // to say a row had been filtered out. Same fix as Menu Pricing's own read.
        .or('category.is.null,category.neq.Sub-Recipe')
        .order('name'),
      scopedFrom('recipe_suggestions', 'recipe_id, suggest_recipe_id'),
    ])
    // S754: a dropped error here rendered "No POS-enabled items" over a menu the client has, AND
    // cached that empty menu as the offline fallback. Keep last-good, leave menuLoaded false so a
    // Retry actually re-reads, and say it failed.
    if (menuErr) {
      console.error('loadMenu failed, keeping the last menu:', menuErr)
      setMenuLoadError(menuErr.message || 'the menu could not be read')
      return
    }
    setMenuLoadError('')
    setMenu(data || [])
    let suggMap = {}
    if (suggErr) console.error('recipe_suggestions read failed — pairings fall back to the other signals:', suggErr)
    else if (suggData) {
      suggData.forEach(s => {
        if (!suggMap[s.recipe_id]) suggMap[s.recipe_id] = []
        suggMap[s.recipe_id].push(s.suggest_recipe_id)
      })
      setManualSuggestions(suggMap)
    }
    setMenuLoaded(true)
    // Only a complete read is worth keeping as the offline copy.
    if (!suggErr) cachePosMenu(clientId, data || [], suggMap)
  }

  // table_id → the booking that matters on that tile NOW, plus the bookings holding no table at
  // all. Plain derivation: the list is a handful of rows.
  //
  // It used to be the EARLIEST live booking per table (rows arrive sorted from the start of the
  // day), so a lunch booking nobody closed out hid tonight's due party: the tile showed lunch and
  // a tap opened the covers numpad instead of Seat (S754). Per table now: a booking due right now
  // wins, then a party marked arrived (still waiting, whatever the clock says), then the next one
  // still to come. A booking whose window has ended and who never arrived is ignored.
  const reservationsByTable = {}
  const unassignedReservations = []
  {
    const nowMs = kotNow
    const rankOf = r => isDue(r, nowMs, reservationSettings.seat_window_minutes) ? 0
      : r.status === 'arrived' ? 1
      : windowOf(r).end > nowMs ? 2
      : null
    const bestRank = {}
    for (const r of floorReservations) {
      const ids = tableIdsOf(r)
      if (ids.length === 0) { unassignedReservations.push(r); continue }
      const rank = rankOf(r)
      if (rank == null) continue
      // Rows are in reserved_for order, so a strict < keeps the earliest within a rank.
      for (const id of ids) {
        if (bestRank[id] == null || rank < bestRank[id]) { bestRank[id] = rank; reservationsByTable[id] = r }
      }
    }
  }

  // The booking a host would seat if they tapped this table right now, or null.
  function dueReservationFor(tableId) {
    // Asked at tap time, so it looks across every booking on the table rather than trusting the
    // tile's pick from the last minute tick.
    const nowMs = Date.now()
    return floorReservations.find(r => tableIdsOf(r).includes(tableId) && isDue(r, nowMs, reservationSettings.seat_window_minutes)) || null
  }

  // The original tail of openTable for a table with no order on it: a pending guest QR request
  // supplies the covers, otherwise the numpad asks. Also the "Walk-in instead" answer to the
  // seat prompt below.
  function startFreshOrder(table) {
    const pendingGuestReq = pendingGuestOrders[table.id]?.[0]
    if (pendingGuestReq) {
      // The guest already gave a covers count when placing their order — skip the redundant
      // numpad and go straight to the order screen with it pre-filled. This does NOT merge the
      // request's items into the cart; that still only happens via an explicit Accept tap on
      // the banner below (decideGuestOrder), same as always.
      setActiveTable(table)
      setOrderId(null); setOrderNo(null); setOrderItems([]); markCartSaved([]); itemsVersionRef.current = null
      setCovers(pendingGuestReq.covers || 1)
      setMsg(''); setView('order'); loadMenu()
    } else {
      setPendingTable(table)
      setPendingCoversStr('')
      setCoversModal(true)
      loadMenu()
    }
  }

  // Seat a booked party: the booking supplies the covers (no numpad) and the buyer name/phone, so
  // the bill carries the guest and closeOrder's customer upsert builds the book for free. The
  // link back to the booking is written by performSave once the pos_orders row exists.
  function seatReservation(table, res) {
    seatReservationRef.current = res
    setSeatPrompt(null)
    setActiveTable(table)
    setOrderId(null); setOrderNo(null); setOrderItems([]); markCartSaved([]); itemsVersionRef.current = null
    setCovers(Math.max(1, parseInt(res.party_size, 10) || 1))
    setBuyerName(res.customer_name || '')
    setBuyerPhone(res.phone || '')
    setMsg(''); setView('order'); loadMenu()
  }

  // The cart as a comparable map, for the unsaved-changes check on ← (S754). Keyed by recipe_id
  // (one line per recipe), and only what a save would change — qty and note, never the sent flag.
  function cartKeyMap(items) {
    const m = new Map()
    for (const i of items || []) m.set(i.recipe_id || `name:${i.name}`, `${i.qty}|${(i.notes || '').trim()}`)
    return m
  }
  function markCartSaved(items) { savedItemsRef.current = cartKeyMap(items) }
  function unsavedChangeCount(items) {
    const cur = cartKeyMap(items)
    const saved = savedItemsRef.current
    let n = 0
    for (const [k, v] of cur) if (saved.get(k) !== v) n++
    for (const k of saved.keys()) if (!cur.has(k)) n++
    return n
  }

  // Puts a loaded order on the order screen. Shared by the table tile, the offline queue/snapshot
  // paths and the takeaway card (S754), so the three cannot drift on what "open an order" sets.
  // sent_qty comes from the stored/queued line (it used to be re-derived from sent_to_kot alone, which
  // lost a "2 of 3 sent" line's count on every reload); itemsVersion is what the next save expects.
  function showLoadedOrder(table, { id, orderNo: no, covers: cv, items, itemsVersion }) {
    const lines = (items || []).map(cartLineFromStored)
    itemsVersionRef.current = Number.isInteger(itemsVersion) ? itemsVersion : null
    setStaleRecovery(null)
    setActiveTable(table)
    setOrderId(id)
    setOrderNo(no || null)
    setCovers(cv || 1)
    setOrderItems(lines)
    markCartSaved(lines)
    setMsg(''); setView('order'); loadMenu()
    return lines
  }

  // A takeaway has no table to look it up by, so it opens by order id (S754).
  async function openOrderById(oid) {
    setFloorMsg('')
    seatReservationRef.current = null
    if (!navigator.onLine) {
      const queued = liveQueue(await getPosOrderQueue()).find(q => q.order_id === oid)
      if (queued) { showLoadedOrder(null, { id: queued.order_id, orderNo: null, covers: queued.covers, items: queued.items, itemsVersion: queued.items_version }); return }
      // Never loaded on this device: refuse rather than start an item replace that would delete
      // lines this till has never seen — the same rule as an occupied table offline.
      setFloorMsg('error:That takeaway order has not been loaded on this device yet — reconnect to open it.')
      return
    }
    const { data: existing, error } = await scopedFrom('pos_orders', OPEN_ORDER_SELECT)
      .eq('id', oid)
      .maybeSingle()
    if (error) {
      window.alert(`Couldn't load that takeaway order: ${error.message}\n\nTry again in a moment — don't ring it up as a new takeaway, or the kitchen will get it twice.`)
      return
    }
    if (!existing || existing.status !== 'open') {
      setFloorMsg('error:That takeaway order was already closed on another device.')
      loadFloor({ quiet: true })
      return
    }
    showLoadedOrder(null, { id: existing.id, orderNo: existing.order_no, covers: existing.covers, items: existing.pos_order_items, itemsVersion: existing.items_version })
  }

  async function openTable(table) {
    setFloorMsg('')

    if (!navigator.onLine) {
      // A table this device already touched offline is the source of truth — use the queue.
      const queue = liveQueue(await getPosOrderQueue())
      const queued = queue.find(q => q.table_id === table.id)
      if (queued) {
        showLoadedOrder(table, { id: queued.order_id, orderNo: null, covers: queued.covers, items: queued.items, itemsVersion: queued.items_version }) // real order_no assigned on sync
        return
      }
      // Otherwise fall back to the last-known-good snapshot from an earlier online visit — but
      // only while the table still reads as occupied (S754). The snapshot is keyed by TABLE, so
      // once that order closed it described a bill that no longer exists, and reopening it
      // offline put a paid order's lines back on the table.
      const cached = table.status === 'occupied' ? await getCachedPosOrderForTable(table.id) : null
      if (cached) {
        showLoadedOrder(table, { id: cached.orderId, orderNo: cached.orderNo, covers: cached.covers, items: cached.items, itemsVersion: cached.itemsVersion })
        return
      }
      // The table has an order per the last-synced table list, but this device never loaded its
      // items — block rather than risk a full item replace that silently deletes what's really there.
      if (table.status === 'occupied' || table.status === 'reserved') {
        setFloorMsg(`error:${table.name} has an order that hasn't been loaded on this device yet — reconnect to open it.`)
        return
      }
      // No known order on this table — safe to start fresh, same as the online empty-table path.
      setPendingTable(table)
      setPendingCoversStr('')
      setCoversModal(true)
      loadMenu()
      return
    }

    const { data: existing, error: existingErr } = await scopedFrom('pos_orders', OPEN_ORDER_SELECT)
      .eq('status', 'open')
      .eq('table_id', table.id)
      .maybeSingle()

    // A dropped error here is the worst swallow in this file: `existing` comes back null, the
    // table reads as EMPTY, and staff start a SECOND order on a table whose items are already
    // with the kitchen — re-firing every KOT and opening a second bill on one guest. Refuse to
    // guess. window.alert because the floor view has no message banner (setMsg renders only
    // inside the `view === 'order'` tree — CLAUDE.md's two-returns trap) and this cannot be
    // missable mid-service (S616).
    if (existingErr) {
      window.alert(`Couldn't check whether ${table.name} already has an open order: ${existingErr.message}\n\nDon't start a new order on this table until it loads — you may be re-ringing one that is already with the kitchen. Try again in a moment.`)
      return
    }

    if (existing) {
      // A booking handed off onto a table that already has an order must not attach to that
      // bill — it belongs to whoever is already sitting there.
      seatReservationRef.current = null
      const items = showLoadedOrder(table, { id: existing.id, orderNo: existing.order_no, covers: existing.covers, items: existing.pos_order_items, itemsVersion: existing.items_version })
      cachePosOrderForTable(table.id, { orderId: existing.id, orderNo: existing.order_no || null, covers: existing.covers || 1, items, itemsVersion: Number.isInteger(existing.items_version) ? existing.items_version : null })
    } else {
      // An explicit handoff from the Reservations page seats straight away; a table whose
      // booking is due offers the party by name before falling back to the numpad.
      const handoff = seatReservationRef.current
      if (handoff?.id) { seatReservation(table, handoff); return }
      const due = dueReservationFor(table.id)
      if (due) { setSeatPrompt({ table, reservation: due }); loadMenu(); return }
      startFreshOrder(table)
    }
  }

  function numpadPress(d) {
    setPendingCoversStr(prev => {
      const next = prev + d
      return parseInt(next) > 99 ? prev : next.replace(/^0+(\d)/, '$1')
    })
  }
  function numpadBackspace() { setPendingCoversStr(prev => prev.slice(0, -1)) }
  function numpadClear()     { setPendingCoversStr('') }

  function confirmCovers() {
    const n = Math.max(1, parseInt(pendingCoversStr) || 1)
    setActiveTable(pendingTable)
    setOrderId(null); setOrderNo(null); setOrderItems([]); markCartSaved([]); itemsVersionRef.current = null
    setCovers(n)
    setMsg(''); setCoversModal(false); setPendingTable(null)
    setView('order')
  }

  function openTakeaway() {
    setActiveTable(null); setOrderId(null); setOrderNo(null); setCovers(1); setOrderItems([]); markCartSaved([]); itemsVersionRef.current = null
    setMsg(''); setView('order'); loadMenu()
  }

  /* ── order item helpers ── */

  function addItem(recipe) {
    const vat = vatReg ? vatOf(recipe) : 0
    setOrderItems(prev => {
      const idx = prev.findIndex(i => i.recipe_id === recipe.id)
      if (idx >= 0) {
        return prev.map((item, n) => n === idx
          ? {
              ...item,
              qty:         item.qty + 1,
              sent_to_kot: false,
              // capture how many were already sent so we can show the +delta
              sent_qty: item.sent_to_kot ? item.qty : (item.sent_qty || 0),
            }
          : item)
      }
      return [...prev, {
        recipe_id:   recipe.id,
        name:        recipe.name,
        category:    recipe.category || 'Other',
        qty:         1,
        unit_price:  parseFloat(recipe.selling_price) || 0,
        vat_rate:    vat,
        sent_to_kot: false,
        sent_qty:    0,
        notes:       '',
      }]
    })
    setMsg('')
    computeSuggestions(recipe)
  }

  // Fallback for when there is nothing data-driven to rank on — a POS-only client (no IMS, so no
  // me_class and no co-occurrence) with no manual pairing on this item. rank() below filters to
  // _score > 0, so without this the panel would come back empty for them. Was previously reached
  // only via a pos_plan === 'starter' check, which gated it on a tier POS does not sell.
  // Nudges toward a category not yet in the order — one item per missing category, in menu order.
  function categoryNudgeSuggestions(recipe, currentIds) {
    const presentCats = new Set([recipe.category || 'Other', ...orderItems.map(i => i.category || 'Other')])
    const seenCats = new Set()
    const picks = []
    for (const r of menu) {
      if (currentIds.has(r.id)) continue
      const cat = r.category || 'Other'
      if (presentCats.has(cat) || seenCats.has(cat)) continue
      seenCats.add(cat)
      picks.push(r)
      if (picks.length >= 4) break
    }
    return picks
  }

  async function computeSuggestions(recipe) {
    const currentIds = new Set([...orderItems.map(i => i.recipe_id), recipe.id])

    const hasMeData   = allowMeFilter && menu.some(r => r.me_class)
    const isPlowhorse = allowMeFilter && recipe.me_class === 'plowhorse'
    const triggerCat  = recipe.category || 'Other'
    const manualIds   = new Set(manualSuggestions[recipe.id] || [])

    function calcScore(r, coMap = {}, maxCo = 0) {
      if (manualIds.has(r.id)) return 100
      let s = 0
      if (hasMeData) {
        s = r.me_class === 'star' ? 10 : r.me_class === 'puzzle' ? 6 : 2
        if (r.category !== triggerCat) s += 3
        if (isPlowhorse && r.category === triggerCat) s -= 4
      }
      if (allowCoOccurrence && coMap[r.id] && maxCo > 0) s += (coMap[r.id] / maxCo) * 5
      return s
    }

    function rank(coMap = {}, maxCo = 0) {
      return menu
        .filter(r => !currentIds.has(r.id) && (manualIds.has(r.id) || !allowMeFilter || r.me_class !== 'dog'))
        .map(r => ({ ...r, _score: calcScore(r, coMap, maxCo), _manual: manualIds.has(r.id) }))
        // Only genuinely-earned suggestions — without this, a tier with nothing to score on
        // (e.g. Growth without IMS, where every non-manual item ties at 0) would still pad out
        // to 4 arbitrary menu items instead of showing just its manual pairings (or nothing).
        .filter(r => r._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, 4)
    }

    // Manual pairings + ME filter: immediate suggestions from local data. An empty initial result
    // must NOT return early — where co-occurrence is the only scoring layer (IMS enabled but no
    // manual pairing on this item, or before Menu Engineering has ever run), every local score
    // ties at zero and the panel only fills once the RPC below responds. So fall back to the
    // category nudge only when co-occurrence isn't coming either.
    const ranked = rank()
    setSuggestions(ranked.length || allowCoOccurrence ? ranked : categoryNudgeSuggestions(recipe, currentIds))

    // Co-occurrence (async — re-ranks on arrival)
    if (!allowCoOccurrence || !clientId) return
    // Suggestions only — an empty list is a legitimate result, so a failed read degrades to
    // "no suggestions" rather than anything the cashier must act on.
    const { data: coData, error: coErr } = await supabase.rpc('get_cooccurrence', {
      p_client_id: clientId, p_recipe_id: recipe.id, p_days: 90,
    })
    if (coErr) console.error('get_cooccurrence failed, falling back to category nudges:', coErr)
    if (!coData?.length) {
      // No pairing history yet (a new client, or a dish never sold alongside anything). The
      // initial rank() above deliberately didn't fall back because co-occurrence was still
      // pending; now that it has come back empty, the nudge is all that's left.
      if (!ranked.length) setSuggestions(categoryNudgeSuggestions(recipe, currentIds))
      return
    }
    const coMap = Object.fromEntries(coData.map(r => [r.paired_recipe_id, Number(r.co_count)]))
    const maxCo = Math.max(...Object.values(coMap))
    const reranked = rank(coMap, maxCo)
    setSuggestions(reranked.length ? reranked : categoryNudgeSuggestions(recipe, currentIds))
  }

  // How much of this line the kitchen/bar has actually been sent. `sent_qty` carries the
  // previously-sent quantity once an edit clears `sent_to_kot` on the line, so the two together
  // are the only honest answer — reading `sent_to_kot` alone reports 0 the moment someone nudges
  // the qty, which is exactly the edit this needs to catch.
  const kitchenQtyOf = item => item?.sent_to_kot ? item.qty : (item?.sent_qty || 0)

  // Cutting a line below what the kitchen already has means food that exists is leaving the bill.
  // That is the classic till-shrinkage route (ring it, fire it, serve it, pull the line before
  // charging) and until S576 it took no permission, left no record and asked no question. The
  // record itself is written server-side inside save_pos_order_items — a browser check would be
  // advisory — so all this prompt owns is the reason, which the RPC has no way to invent.
  function setQty(idx, qty) {
    const item = orderItems[idx]
    const kitchenQty = kitchenQtyOf(item)
    if (kitchenQty > 0 && qty < kitchenQty) {
      setPullPrompt({ idx, qty, name: item.name, pulled: kitchenQty - Math.max(0, qty) })
      setPullReason('')
      return
    }
    applyQty(idx, qty)
  }

  function applyQty(idx, qty) {
    if (qty <= 0) {
      setOrderItems(prev => prev.filter((_, i) => i !== idx))
    } else {
      setOrderItems(prev => prev.map((item, i) => i === idx
        ? {
            ...item,
            qty,
            sent_to_kot: item.qty === qty ? item.sent_to_kot : false,
            sent_qty: (item.sent_to_kot && item.qty !== qty) ? item.qty : (item.sent_qty || 0),
          }
        : item))
    }
  }

  function updateItemNote(idx, notes) {
    setOrderItems(prev => prev.map((item, i) => i === idx
      ? {
          ...item, notes,
          sent_to_kot: item.notes === notes ? item.sent_to_kot : false,
          sent_qty: (item.sent_to_kot && item.notes !== notes) ? item.qty : (item.sent_qty || 0),
        }
      : item))
  }

  function addPresetToNote(idx, phrase) {
    const existing = (orderItems[idx].notes || '').split(',').map(s => s.trim()).filter(Boolean)
    if (existing.includes(phrase)) return
    updateItemNote(idx, [...existing, phrase].join(', '))
  }

  /* ── core save (shared by saveOrder and sendTicket) ── */

  // Returns { ok: true, oid, oNo, items } — `items` the server's priced lines (null offline) — or
  // { ok: false, handled, error }. `handled` means this function already put the refusal in front of
  // the waiter (a stale order reloaded, a bill closed elsewhere, a dish off the menu, a table opened
  // on another device), so the caller must not paint its own "Save failed" over it.
  //
  // `sendKeys` ('all', or a Set of line keys) marks those lines sent — sent_to_kot and sent_qty = qty —
  // IN THIS SAVE (S754). The flag used to be a separate UPDATE after the save; carrying it on the
  // atomic save keeps S654's rule (a ticket prints only once the server counts its lines as sent: the
  // callers print after this returns ok) while making the flag and the lines one write, so a flag
  // cannot land on some lines and not others, and it cannot land on a version of the order another
  // tablet saved in between (the expected version covers it).
  async function performSave({ sendKeys = null } = {}) {
    let oid = orderId
    let oNo = orderNo
    const isNewOrder = !oid

    const snapshot = orderItems
    const lineKey = i => i.recipe_id || `name:${i.name}`
    const isSent = sendKeys === 'all' ? () => true : sendKeys ? i => sendKeys.has(lineKey(i)) : () => false
    const savedLines = snapshot.map(i => (isSent(i) ? { ...i, sent_to_kot: true, sent_qty: i.qty } : i))
    const itemsPayload = savedLines.map(toItemPayload)

    if (!navigator.onLine) {
      let createdOffline = isNewOrder
      if (isNewOrder) {
        oid = randomUUID()
        setOrderId(oid)
        // oNo stays null — the real order_no is assigned by the server-side trigger on sync
      } else {
        const existingQueued = await getQueuedPosOrder(oid)
        createdOffline = existingQueued?.created_offline || false
      }
      await enqueuePosOrder(oid, {
        created_offline: createdOffline,
        table_id:   activeTable?.id   || null,
        table_name: activeTable?.name || 'Takeaway',
        covers,
        opened_by:  profile?.id || null,
        items: itemsPayload,
        // The version these offline edits build on; enqueuePosOrder keeps the first one queued.
        ...(Number.isInteger(itemsVersionRef.current) ? { items_version: itemsVersionRef.current } : {}),
      })
      markCartSaved(snapshot)
      // A party seated offline keeps its booking at 'arrived' — the link needs the server row
      // and is never written from the queue; the Reservations page's Done action covers it.
      seatReservationRef.current = null
      setPendingOrderIds(prev => new Set([...prev, oid]))
      if (isNewOrder && activeTable?.id) {
        setTables(prev => prev.map(t => t.id === activeTable.id ? { ...t, status: 'occupied' } : t))
      }
      loadFloor() // safe offline — reads from cache/queue, no network
      return { ok: true, oid, oNo: null, items: null }
    }

    if (isNewOrder) {
      const { data: newOrder, error } = await scopedInsert('pos_orders', {
        table_id:   activeTable?.id   || null,
        table_name: activeTable?.name || 'Takeaway',
        status:     'open',
        covers,
        opened_by:  profile?.id || null,
      }, { single: true })
      // 23505 is pos_orders_one_open_per_table (S754): another device opened this table between the
      // tap that showed it free and this insert. Put this cart onto THAT order, unsent.
      if (error?.code === '23505' && activeTable?.id) {
        seatReservationRef.current = null
        await adoptOpenOrderOnTable(activeTable, snapshot)
        return { ok: false, handled: true, error }
      }
      if (error || !newOrder) return { ok: false, handled: false, error }
      oid = newOrder.id
      oNo = newOrder.order_no || null
      itemsVersionRef.current = Number.isInteger(newOrder.items_version) ? newOrder.items_version : null
      setOrderId(oid)
      setOrderNo(oNo)
      // Link a seated booking to the order it just became. The status guard means a booking
      // decided elsewhere in the meantime (cancelled, seated on another device) is left alone.
      const seatRes = seatReservationRef.current
      seatReservationRef.current = null
      if (seatRes?.id) {
        const { error: linkErr } = await scopedUpdate('pos_reservations', { ...stampFor('seated'), order_id: oid })
          .eq('id', seatRes.id).in('status', ['booked', 'confirmed', 'arrived'])
        if (linkErr) warnWrite(`The booking for ${seatRes.customer_name} still shows as waiting in Reservations though its order was saved — mark it Seated there.`, linkErr)
        else loadFloorReservations()
      }
      if (activeTable?.id) {
        // A silent failure here is how a table gets seated twice: the order exists, but the
        // floor keeps showing the tile as free. The optimistic repaint is deliberately inside
        // the success branch — loadFloor() re-reads from the server moments later, so painting
        // it occupied on a failed write would only lie until the next refresh.
        const { error: occErr } = await scopedUpdate('pos_tables', { status: 'occupied' }).eq('id', activeTable.id)
        if (occErr) warnWrite(`${activeTable.name} still shows as free on the floor, though its order was saved — set its status by hand so it is not seated twice.`, occErr)
        else setTables(prev => prev.map(t => t.id === activeTable.id ? { ...t, status: 'occupied' } : t))
      }
    } else {
      // Covers is the Covers Report's whole input, so a dropped update quietly understates
      // guest counts for the day rather than failing anything visible.
      const { error: covErr } = await scopedUpdate('pos_orders', { covers }).eq('id', oid)
      if (covErr) warnWrite('The cover count for this order did not save — the Covers Report will be short for it.', covErr)
    }

    // Replace this order's lines atomically. This used to be a DELETE followed by a separate
    // INSERT: two HTTP requests with no transaction, so a failure or stall between them left the
    // live order with ZERO lines on the server — floor tile at NPR 0, and only this browser's
    // in-memory state able to recover it. Same shape that cost Sales Entry real data (S456).
    //
    // p_removal_reason is the ONLY part of the KOT-removal record the browser supplies. The RPC
    // computes the removal itself by diffing the stored sent quantities against these rows inside
    // the same transaction, so omitting the reason (an old bundle, or a hand-rolled request) loses
    // the reason and nothing else — the row is still written, still attributed, still timestamped.
    //
    // S754 (migration 20260916100000): p_expected_version is the version this screen loaded or last
    // saved; another tablet's save in between is refused, not overwritten. The prices, VAT, names and
    // categories in p_rows are not trusted — the server keeps an existing line's stored values and
    // prices a new line from the recipe, and returns the lines as stored.
    const saveArgs = { p_order_id: oid, p_rows: itemsPayload, p_removal_reason: kotPullReason || null }
    if (Number.isInteger(itemsVersionRef.current)) saveArgs.p_expected_version = itemsVersionRef.current
    let { data: saveData, error: rpcErr } = await supabase.rpc('save_pos_order_items', saveArgs)
    // A stale refusal is read against the order as it now stands. If its lines are exactly what this
    // save would store, the "other device" was THIS one: an earlier attempt landed and its response
    // was lost, so the version here never advanced. That retry is a success — treating it as a
    // conflict would leave lines the server holds as sent with no ticket ever printed for them.
    let staleRead = null
    if (rpcErr?.hint === HINT.stale) {
      staleRead = await scopedFrom('pos_orders', OPEN_ORDER_SELECT).eq('id', oid).maybeSingle()
      const cur = staleRead.data
      if (!staleRead.error && cur?.status === 'open' && storedLinesMatchPayload(cur.pos_order_items, itemsPayload)) {
        saveData = { items_version: cur.items_version, items: cur.pos_order_items }
        rpcErr = null
      }
    }
    if (rpcErr) return handleSaveRefusal(rpcErr, oid, snapshot, staleRead)
    if (Number.isInteger(saveData?.items_version)) itemsVersionRef.current = saveData.items_version
    const serverItems = Array.isArray(saveData?.items) ? saveData.items : null
    // What the screen shows is what was stored: a new line's price and VAT are the menu's as of this
    // save. Only those four fields move — a line tapped in while the save was in flight keeps its qty.
    if (serverItems) setOrderItems(prev => withServerLineFields(prev, serverItems))
    // Consumed by that save; a later edit asks again rather than silently reusing this one.
    if (kotPullReason) setKotPullReason('')
    // What was just stored — the pre-await snapshot, so a line tapped in while this save was in
    // flight still counts as unsaved (S754).
    markCartSaved(snapshot)
    if (activeTable?.id) {
      cachePosOrderForTable(activeTable.id, {
        orderId: oid, orderNo: oNo, covers, itemsVersion: itemsVersionRef.current,
        items: serverItems ? withServerLineFields(savedLines, serverItems) : savedLines,
      })
    }

    // Only now — the merged items are actually persisted — mark any Accepted-locally guest
    // requests as accepted in the DB too. Best-effort/non-blocking (matches the rest of this
    // file's guest-ordering writes); if it fails the request just stays 'pending' and can be
    // Accepted again next save. Not attempted in the offline branch above — an offline device
    // has no way to reach this table anyway, and the ids stay pending until a later online save.
    if (pendingAcceptedGuestReqIds.size > 0) {
      const ids = Array.from(pendingAcceptedGuestReqIds)
      setPendingAcceptedGuestReqIds(new Set())
      const { error: gErr } = await scopedUpdate('pos_guest_order_requests', {
        status: 'accepted', decided_at: new Date().toISOString(), decided_by: profile?.id || null,
      }).in('id', ids)
      // Non-fatal as described above — the request simply stays 'pending' and can be Accepted
      // again on the next save. Same correction as the two blocks above: the try/catch it
      // replaces never fired, so this failure had no trace at all.
      if (gErr) console.error('guest request accept failed (non-fatal):', gErr)
      loadPendingGuestOrders()
    }

    // S754: an order started from an offline-sync conflict has now genuinely saved, so the
    // conflict entry it came from can go. Online path only — a queued offline save has not reached
    // the server, so the conflict stays until one does.
    const recoveredConflict = conflictRecoveryRef.current
    if (recoveredConflict) { conflictRecoveryRef.current = null; discardConflictOrder(recoveredConflict) }

    loadFloor()
    return { ok: true, oid, oNo, items: serverItems }
  }

  // The order on screen, named the way the waiter knows it.
  function orderLabel() {
    return activeTable?.name || (orderNo ? `Takeaway #${orderNo}` : 'This takeaway')
  }

  // A save_pos_order_items refusal, by its HINT code (S754). Anything without a known code is returned
  // unhandled for the caller's own "Save failed" line.
  async function handleSaveRefusal(err, oid, snapshot, staleRead = null) {
    if (err?.hint === HINT.stale) {
      await reloadAfterStale(oid, snapshot, staleRead)
      return { ok: false, handled: true, error: err }
    }
    if (err?.hint === HINT.notOpen || err?.hint === HINT.locked) {
      showClosedElsewhere()
      return { ok: false, handled: true, error: err }
    }
    if (err?.hint === HINT.offMenu) {
      // The server's sentence names the dish ("Chicken Momo is not on the menu any more — remove it
      // from the order and save again"). Nothing was saved, and the menu on screen is what is out of
      // date, so it is re-read.
      const text = stripCodeWord(err.message, HINT.offMenu)
      setMsg(`error:Not saved — ${text || 'a dish on this order is not on the till menu any more'}. The menu has been reloaded.`)
      loadMenu({ force: true })
      return { ok: false, handled: true, error: err }
    }
    return { ok: false, handled: false, error: err }
  }

  // Another device saved this order after this screen loaded it. Reload the server's order — lines
  // and version — and never keep anything silently: whatever this device had that the reloaded order
  // does not carry is listed, with a one-tap "add them back as unsent".
  async function reloadAfterStale(oid, snapshot, alreadyRead = null) {
    const where = orderLabel()
    const { data: fresh, error } = alreadyRead || await scopedFrom('pos_orders', OPEN_ORDER_SELECT).eq('id', oid).maybeSingle()
    if (error) {
      setMsg(`error:${where} was changed on another device, and the latest version could not be loaded — nothing was saved. Go back to the floor and open it again.`)
      return
    }
    if (!fresh || fresh.status !== 'open') { showClosedElsewhere(); return }
    setKotPullReason('')
    const lines = showLoadedOrder(activeTable, {
      id: fresh.id, orderNo: fresh.order_no, covers: fresh.covers, items: fresh.pos_order_items, itemsVersion: fresh.items_version,
    })
    if (activeTable?.id) {
      cachePosOrderForTable(activeTable.id, { orderId: fresh.id, orderNo: fresh.order_no || null, covers: fresh.covers || 1, items: lines, itemsVersion: itemsVersionRef.current })
    }
    const missing = missingFromServer(snapshot, fresh.pos_order_items)
    if (missing.length > 0) setStaleRecovery({ where, missing })
    setMsg(`error:${where} was changed on another device — here is the latest.${missing.length > 0 ? ' Add your items again.' : ' Check it, then save again.'}`)
  }

  function addBackStaleItems() {
    const pending = staleRecovery
    setStaleRecovery(null)
    if (!pending?.missing?.length) return
    setOrderItems(prev => mergeUnsentLines(prev, pending.missing))
    setMsg('ok:Added back, unsent — review them, then Update Order.')
  }

  // The bill on screen was closed on another device. Nothing more can be saved to it; the notice
  // sends the waiter back to the floor, where the table shows its real state.
  function showClosedElsewhere() {
    if (activeTable?.id) clearCachedPosOrderForTable(activeTable.id).catch(e => console.error('order snapshot clear failed (non-fatal):', e))
    setBillingOpen(false)
    setStaleRecovery(null)
    setClosedElsewhere(orderLabel())
  }

  function acknowledgeClosedElsewhere() {
    setClosedElsewhere(null)
    backToFloor()
    loadFloor()
  }

  // The insert of a NEW order on a table was refused because another device has an open order on it
  // (23505, S754). Load that order and put this cart onto it as unsent lines — the same rule as the
  // offline-conflict recovery — so nothing typed here is lost and nothing is fired twice.
  async function adoptOpenOrderOnTable(table, snapshot) {
    const { data: existing, error } = await scopedFrom('pos_orders', OPEN_ORDER_SELECT)
      .eq('status', 'open').eq('table_id', table.id).maybeSingle()
    if (error || !existing) {
      setMsg(`error:${table.name} was just opened on another device, so this order was not saved${error ? ' — and that order could not be loaded' : ''}. Go back to the floor and open the table again; your items are still here.`)
      return
    }
    const lines = showLoadedOrder(table, {
      id: existing.id, orderNo: existing.order_no, covers: existing.covers, items: existing.pos_order_items, itemsVersion: existing.items_version,
    })
    setOrderItems(mergeUnsentLines(lines, snapshot.map(i => ({ ...i, sent_to_kot: false, sent_qty: 0 }))))
    setMsg(`ok:${table.name} was opened on another device first — your items were added to that order, unsent. Review them, then Update Order.`)
  }

  // S754 (owner decision): Update Order on an order that already exists, with lines not yet sent to
  // a station, asks first — "Send N new items to the kitchen/bar now?" with Send / Just save. An
  // order with nothing unsent saves exactly as before, and a NEW order still auto-sends on its first
  // save (commitSaveOrder). The ask renders in the ORDER-screen return, where this runs (S578).
  function saveOrder() {
    if (!clientId) return
    if (orderItems.length === 0) { setMsg('error:Add at least one item.'); return }
    if (savingRef.current) return
    if (orderId) {
      const unsent = orderItems.filter(i => !i.sent_to_kot)
      if (unsent.length > 0) {
        const isBot = i => botCategories.has(i.category || 'Other')
        const hasKot = unsent.some(i => !isBot(i))
        const hasBot = unsent.some(isBot)
        setSendPrompt({
          // What the station has not been told about yet — a line sent as 2 and now 3 is 1 new.
          units: unsent.reduce((n, i) => n + Math.max(0, (Number(i.qty) || 0) - (Number(i.sent_qty) || 0)), 0),
          lines: unsent.length,
          where: hasKot && hasBot ? 'kitchen and bar' : hasBot ? 'bar' : 'kitchen',
        })
        return
      }
    }
    commitSaveOrder()
  }

  // "Send" on that ask: one save, then every unsent line to its station — KOT/BOT routing by
  // category exactly as the KOT and BOT buttons route it, and the print gated on the sent flag
  // landing, never the other way round (S654: a printed ticket the server still counts as unsent is
  // how a dish gets cooked twice). The flag rides on the save itself (performSave's sendKeys, S754),
  // one write for both stations — not sendTicket twice: offline, a second enqueue built from the same
  // cart snapshot would put the first station's lines back to unsent in the queued payload.
  async function saveAndSendUnsent() {
    setSendPrompt(null)
    if (!clientId || orderItems.length === 0) return
    if (savingRef.current) return
    const unsentItems = orderItems.filter(i => !i.sent_to_kot)
    const kotItems = unsentItems.filter(i => !botCategories.has(i.category || 'Other'))
    const botItems = unsentItems.filter(i =>  botCategories.has(i.category || 'Other'))
    savingRef.current = true
    setSaving(true); setMsg('')
    const saved = await performSave({ sendKeys: new Set(unsentItems.map(i => i.recipe_id || `name:${i.name}`)) })
    if (!saved.ok) {
      savingRef.current = false; setSaving(false)
      // Nothing printed. Whether the save landed is not known on a dropped connection — pressing Send
      // again is safe either way: a save that did land is recognised and simply prints (performSave).
      if (!saved.handled) setMsg(`error:That did not go through — nothing printed. Press Update Order again. ${errorText(saved.error, 'staff')}`)
      return
    }
    const { oid, oNo } = saved

    markLinesSent(unsentItems)
    savingRef.current = false
    setSaving(false)
    const kotPrinted = kotItems.length > 0 ? printTicket('KOT', kotItems, oNo) : true
    const botPrinted = botItems.length > 0 ? printTicket('BOT', botItems, oNo) : true
    logKotSend('KOT', kotItems, oid, oNo)
    logKotSend('BOT', botItems, oid, oNo)
    setMsg(kotPrinted && botPrinted
      ? 'ok:Order updated and sent!'
      : 'error:Sent to the kitchen/bar, but the ticket did NOT print — allow pop-ups for this site, then press Reprint KOT/BOT.')
  }

  async function commitSaveOrder() {
    if (!clientId) return
    if (orderItems.length === 0) { setMsg('error:Add at least one item.'); return }
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true); setMsg('')

    const wasNew = !orderId
    // A NEW order auto-sends every line on its first save, so its lines are marked sent in that same
    // save (sendKeys 'all'). sent_to_kot/sent_qty are what make "already sent" true for every other
    // device, and for this one after a reload; the print below runs only once the save returned ok,
    // so a ticket can never print for lines the server still counts as unsent (S654).
    const saved = await performSave(wasNew ? { sendKeys: 'all' } : {})
    if (!saved.ok) {
      savingRef.current = false; setSaving(false)
      if (!saved.handled) setMsg(`error:That did not go through${wasNew ? ' — nothing printed' : ''}. Press ${wasNew ? 'Send Order' : 'Update Order'} again. ${errorText(saved.error, 'staff')}`)
      return
    }
    const { oid, oNo } = saved

    if (wasNew) {
      const kotItems = orderItems.filter(i => !botCategories.has(i.category || 'Other'))
      const botItems = orderItems.filter(i =>  botCategories.has(i.category || 'Other'))
      markLinesSent(orderItems)
      const kotPrinted = kotItems.length > 0 ? printTicket('KOT', kotItems, oNo) : true
      const botPrinted = botItems.length > 0 ? printTicket('BOT', botItems, oNo) : true
      logKotSend('KOT', kotItems, oid, oNo)
      logKotSend('BOT', botItems, oid, oNo)
      // A blocked pop-up used to be overwritten by "Order sent!" one line later (S754), so the
      // waiter walked away believing a ticket had printed. The send itself did land — the lines
      // are marked sent and the KDS has them — so the recovery is a reprint, never a re-send.
      setMsg(kotPrinted && botPrinted
        ? 'ok:Order sent!'
        : 'error:Sent to the kitchen/bar, but the ticket did NOT print — allow pop-ups for this site, then press Reprint KOT/BOT.')
    } else {
      setMsg('ok:Saved.')
    }

    savingRef.current = false
    setSaving(false)
  }

  /* ── KOT / BOT ── */

  async function sendTicket(station) {
    if (orderItems.length === 0) { setMsg('error:Add items first.'); return }

    const unsentItems = orderItems.filter(i => {
      if (i.sent_to_kot) return false
      return station === 'BOT'
        ? botCategories.has(i.category || 'Other')
        : !botCategories.has(i.category || 'Other')
    })

    if (unsentItems.length === 0) {
      setMsg(`error:No new ${station === 'BOT' ? 'bar' : 'kitchen'} items to send.`)
      return
    }

    if (savingRef.current) return
    savingRef.current = true
    setSaving(true); setMsg('')
    // This station's unsent lines are marked sent IN the save (matched by recipe — one line per recipe
    // on an order), so the print below is gated on the server holding them as sent, exactly as the
    // first-save auto-send is: a printed ticket the server does not consider sent is the shape that
    // gets a dish cooked twice. Online and offline alike — the queued payload is the same rows.
    const saved = await performSave({ sendKeys: new Set(unsentItems.map(i => i.recipe_id || `name:${i.name}`)) })
    if (!saved.ok) {
      savingRef.current = false; setSaving(false)
      if (!saved.handled) setMsg(`error:${station} did not go through — nothing printed. Press ${station} again. ${errorText(saved.error, 'staff')}`)
      return
    }
    const { oid, oNo } = saved

    // The on-screen cart is updated separately from what was saved, because lines may have been
    // tapped in while the save was awaiting.
    markLinesSent(unsentItems)

    savingRef.current = false
    setSaving(false)
    const printed = printTicket(station, unsentItems, oNo)
    logKotSend(station, unsentItems, oid, oNo)
    // Same as saveOrder: the send landed, only the paper did not (S754).
    setMsg(printed
      ? `ok:${station} sent!`
      : `error:${station} sent to the station, but the ticket did NOT print — allow pop-ups for this site, then press Reprint KOT/BOT.`)
  }

  // Flips the sent flag on exactly the lines that went out, matched by recipe AND the quantity and
  // note that were sent (S754). This used to be `setOrderItems(snapshot.map(...))` after the
  // awaits, so a dish tapped in while Send was in flight simply vanished from the cart. A line
  // that changed meanwhile stays unsent, carrying what the station already has as its baseline —
  // so its next ticket reads "+1" (or a change) rather than the whole quantity again.
  function markLinesSent(sentLines) {
    const keyOf = i => i.recipe_id || `name:${i.name}`
    const sentByKey = new Map(sentLines.map(i => [keyOf(i), i]))
    setOrderItems(prev => prev.map(i => {
      const s = sentByKey.get(keyOf(i))
      if (!s) return i
      if (i.qty === s.qty && (i.notes || '') === (s.notes || '')) return { ...i, sent_to_kot: true, sent_qty: i.qty }
      return { ...i, sent_to_kot: false, sent_qty: s.qty }
    }))
  }

  // Best-effort, non-blocking (matches writeSalesEntries' own error-swallow pattern) — logs
  // exactly what was printed on the ticket (delta-aware qty) so the KOT Register/Reconciliation
  // reports reflect the real kitchen/bar send history, not just the current live order state.
  async function logKotSend(station, items, oid, oNo) {
    if (items.length === 0) return
    const payload = {
      order_id: oid,
      order_no: oNo,
      table_name: activeTable?.name || 'Takeaway',
      station,
      items: items.map(i => ({
        recipe_id: i.recipe_id, name: i.name, category: i.category,
        // The printed KOT always carried the note ("no onion — allergy"); the logged ticket did
        // not, so the Kitchen Display never showed it (S754). items is jsonb — no migration. The
        // offline queue stores this same payload, so a replayed send carries it too.
        notes: i.notes || null,
        // Clamped at 0: a reduced-then-resent item must not log a negative delta, which would
        // cancel its earlier sends in the cumulative sum and un-flag it in KOT Reconciliation.
        qty: (i.sent_qty || 0) > 0 ? Math.max(0, i.qty - i.sent_qty) : i.qty,
      })).filter(i => i.qty > 0), // a pure reduction has nothing new to prepare — see below
      sent_by: profile?.id || null,
    }
    // A pure reduction (every item clamped to 0 above) has no work left for this station to log
    // as a KDS ticket — the printed slip (built from the un-clamped `items` separately, with its
    // own "↓N (now qty)" label) is still the record of the cut; there's just nothing to add here.
    if (payload.items.length === 0) return
    // Offline: queued alongside the order and replayed on sync — same best-effort contract as the
    // online path (a failed replay is silently retried later, never blocks/surfaces to the waiter).
    if (!navigator.onLine) {
      await enqueuePosOrder(oid, { kot_sends: [payload] })
      return
    }
    // Deliberately best-effort — a ticket-log problem must never block a waiter mid-service —
    // but written as a returned-error check rather than a try/catch, because supabase-js
    // RESOLVES with { error } instead of throwing. The catch this replaces could only ever
    // have fired on a bug in the argument-building above, so every real failure of the insert
    // reached neither the log nor anywhere else. Consequence when it does fail: KOT Register
    // and KOT Reconciliation are missing this send, and the KDS never shows the ticket.
    const { error: logErr } = await scopedInsert('pos_kot_log', payload)
    if (logErr) console.error('pos_kot_log insert failed:', logErr)
  }

  // Returns printHtml's answer — false when the pop-up was blocked and nothing printed (S754).
  function printTicket(station, items, ticketNo, { reprint = false } = {}) {
    const html = buildKotBotHtml({
      station, items, ticketNo, outletName,
      tableName: activeTable?.name || 'Takeaway',
      takenBy: profile?.full_name || '',
      covers, reprint,
    })
    return printHtml(html)
  }

  // Reprint the most recent KOT and/or BOT for the order on screen (S754), for a ticket that went
  // to the station but never came out of the printer (a blocked pop-up, a paper jam). Rebuilt from
  // pos_kot_log — exactly what was sent, delta quantities included — rather than from the cart,
  // which may have moved on. Writes nothing: no new log row (the KDS would show a second ticket
  // and KOT Reconciliation would count the food twice) and no change to any sent flag.
  async function reprintLastTickets() {
    if (!orderId || !navigator.onLine) return
    const { data, error } = await scopedFrom('pos_kot_log', 'id, station, items, order_no, sent_at, status')
      .eq('order_id', orderId)
      .neq('status', 'cancelled')
      .order('sent_at', { ascending: false })
      .order('id')
      .limit(50)
    if (error) { setMsg(`error:Could not load this order's tickets to reprint — ${error.message}`); return }
    const latest = {}
    for (const row of data || []) if (!latest[row.station]) latest[row.station] = row
    const rows = ['KOT', 'BOT'].map(st => latest[st]).filter(Boolean)
    if (rows.length === 0) { setMsg('error:Nothing has been sent to the kitchen or bar for this order yet.'); return }
    let allPrinted = true
    for (const row of rows) {
      // Logged quantities are already the delta that was fired, so each prints as a plain ×qty.
      const lines = (row.items || []).map(i => ({ name: i.name, qty: i.qty, notes: i.notes || '', sent_qty: 0 }))
      if (!printTicket(row.station, lines, row.order_no ?? orderNo, { reprint: true })) allPrinted = false
    }
    setMsg(allPrinted
      ? `ok:Reprinted the last ${rows.map(r => r.station).join(' and ')}.`
      : 'error:The reprint did not open — allow pop-ups for this site, then try again.')
  }

  function printHtml(html) {
    // noopener as a window.open feature makes the call return null (no way to then write/print/
    // close the popup) — sever window.opener manually instead, on the reference we keep, for the
    // same "can't reach back into the live app" protection without losing that reference.
    const w = window.open('', '_blank', 'width=340,height=480,left=200,top=100')
    if (!w) { setMsg('error:Allow pop-ups to print.'); return false }
    w.opener = null
    w.document.write(html)
    w.document.close()
    w.focus()
    setTimeout(() => { w.print(); w.close() }, 300)
    return true
  }

  // Adds the redemption as an ordinary TENDER in local state. It is not written anywhere yet —
  // closeOrder calls redeem_loyalty_points at Charge time, so an abandoned bill debits nothing.
  function applyRedemption() {
    const pts = Math.floor(Number(redeemStr) || 0)
    const cap = maxRedeemablePoints(loyaltyBalance, redeemableTotal, loyaltyPointValue)
    if (pts <= 0 || pts > cap) return
    setSplitMode(true)
    setTenders(prev => [...prev.filter(t => t.method !== 'Loyalty'),
      { method: 'Loyalty', amount: pointsValue(pts, loyaltyPointValue), points: pts }])
    setRedeemStr('')
  }

  /* ── Billing / Charge ── */

  async function openBilling() {
    setBillingTab('pay')
    setPayMethod('Cash')
    setTenderedStr('')
    setCloseReason('')
    setBuyerName(''); setBuyerAddress(''); setBuyerPan(''); setBuyerPhone(''); setBillRemarks('')
    setDeliveryPartner('')
    // A party seated from a booking already told us who they are. Prefill from the linked
    // reservation so the bill carries the guest and the customer book / loyalty see them — a
    // lookup rather than session state, because the table may be billed from another device or
    // after a reload. Best-effort: a failed read simply leaves the fields blank as before.
    if (orderId && navigator.onLine) {
      scopedFrom('pos_reservations', 'customer_name, phone').eq('order_id', orderId).eq('status', 'seated').limit(1)
        .then(({ data, error }) => {
          if (error || !data?.[0]) return
          setBuyerName(prev => prev || data[0].customer_name || '')
          setBuyerPhone(prev => prev || data[0].phone || '')
        })
    }
    setDiscountStr(''); setDiscountMode('amount'); setDiscountReason('')
    setCloseMsg('')
    setCompCostMap({})
    setCompQtyByRecipe({}); setItemCompReason(''); setItemsExpanded(false)
    setHscMap({})
    setSplitMode(false); setTenders([]); setTenderMethod('Cash'); setTenderAmtStr('')
    setLoyaltyBalance(null); setRedeemStr(''); setLoyaltyLookupMsg('')
    setBillPreviewOpen(false)
    setBillingOpen(true)
    const recipeIds = orderItems.map(i => i.recipe_id).filter(Boolean)
    if (recipeIds.length > 0) {
      const { data, error: hscErr } = await scopedFrom('recipes', 'id, hsc_code').in('id', recipeIds)
      // Not a blocker on opening the till drawer, but HSC codes print on the Tax Invoice, and an
      // empty map is indistinguishable from "no item has one" — so the bill goes out short with
      // nothing saying so.
      if (hscErr) warnWrite('HSC codes could not be loaded, so the next bill will print without them.', hscErr)
      setHscMap(Object.fromEntries((data || []).map(r => [r.id, r.hsc_code])))
      // Food-cost map, needed up front for item-level comp in the Pay tab (not just the
      // Complimentary tab, which used to be the only consumer — see openCompTab).
      const costMap = await computeRecipeCosts(supabase, recipeIds)
      setCompCostMap(costMap)
    }
  }

  async function openCompTab() {
    setBillingTab('writeoff'); setCloseMsg('')
    const recipeIds = orderItems.map(i => i.recipe_id).filter(Boolean)
    const map = await computeRecipeCosts(supabase, recipeIds)
    setCompCostMap(map)
  }

  // Split payment — adds one tender against the running `remaining` balance. Non-cash methods are
  // capped at remaining (no electronic overpay/change); Cash can exceed it, producing change, but
  // only the portion up to `remaining` is ever recorded as applied to the bill.
  function addTender() {
    const amt = parseFloat(tenderAmtStr)
    if (!amt || amt <= 0 || remaining <= 0) return
    setTenders(t => [...t, {
      method: tenderMethod,
      amount: Math.min(amt, remaining),
      tenderedAmount: tenderMethod === 'Cash' ? amt : null,
    }])
    setTenderAmtStr('')
  }

  // Only the most recent tender can be undone — correcting an earlier one means voiding and
  // re-ringing the whole order, same as any other billing mistake. See split-payment plan.
  //
  // Undoing the Loyalty tender after a close attempt that got as far as redeeming (S754) hands the
  // points back first — redeem_loyalty_points(order, 0) — and keeps the tender on screen if that
  // fails, so the screen never shows "no points used" while the customer's balance is still debited.
  async function undoLastTender() {
    if (undoingTenderRef.current) return
    const last = tenders[tenders.length - 1]
    if (last?.method === 'Loyalty' && liveRedemptionRef.current?.orderId === orderId) {
      undoingTenderRef.current = true
      setCloseMsg('')
      const res = await cancelLiveRedemption()
      undoingTenderRef.current = false
      if (!res.ok) {
        setCloseMsg(`error:The points could not be handed back yet, so they stay on this bill — try Undo again. ${res.text}`)
        return
      }
    }
    setTenders(t => t.slice(0, -1))
  }

  // Hands back a redemption that may be standing on `liveRedemptionRef`'s order: redeeming 0 cancels
  // the bill's redemption server-side (points returned, Loyalty leg removed), and is a no-op when
  // nothing was redeemed. Returns { ok, text } — text a sentence for the cashier when it failed.
  async function cancelLiveRedemption() {
    const live = liveRedemptionRef.current
    if (!live?.orderId) return { ok: true, text: '' }
    const { error } = await supabase.rpc('redeem_loyalty_points', { p_order_id: live.orderId, p_points: 0 })
    if (error) {
      console.error('loyalty redemption cancel failed:', error)
      // A bill that is already closed can never be un-redeemed from the till, so there is nothing
      // left to retry — the ref is dropped and the caller says who can fix the balance.
      if (error.hint === HINT.notOpen) {
        if (liveRedemptionRef.current === live) liveRedemptionRef.current = null
        return { ok: false, closed: true, text: 'The bill is already closed, so any points redeemed on it can no longer be handed back from the till — ask the Owner to check the customer’s balance.' }
      }
      return { ok: false, text: error.hint === HINT.rank ? 'Handing points back needs a POS Supervisor login or above.' : errorText(error, 'staff') }
    }
    if (liveRedemptionRef.current === live) liveRedemptionRef.current = null
    return { ok: true, text: '' }
  }

  // A save refused while the billing modal was open (another device changed or closed the order, a
  // dish went off the menu): the order screen carries the explanation, so the modal closes — and a
  // redemption an earlier attempt left standing is handed back rather than left debiting a customer
  // for a bill this screen is no longer closing.
  function dismissBillingAfterRefusal() {
    setBillingOpen(false)
    if (liveRedemptionRef.current?.orderId !== orderId) return
    const where = orderLabel()
    cancelLiveRedemption().then(res => {
      if (res.ok) return
      warnWrite(res.closed
        ? `${where} was closed on another till after a points redemption was attempted on it here. ${res.text}`
        : `Loyalty points redeemed on a payment attempt for ${where} are still held against that bill — they are handed back when it is next charged without them. ${res.text}`)
    })
  }

  // Cancel, the backdrop and Escape all come here (S754). They used to close the modal outright,
  // and openBilling resets `tenders` — so a Cancel after taking NPR 500 cash and 300 on eSewa threw
  // away the only record of both, with the money already in the drawer and the eSewa app.
  function requestCloseBilling() {
    if (closing) return
    // No tenders on screen: close at once (handing back any redemption a failed attempt left standing).
    if (tenders.length === 0) { dismissBillingAfterRefusal(); return }
    const n = tenders.length
    askConfirm({
      title: `Discard ${n} recorded payment${n === 1 ? '' : 's'}?`,
      confirmLabel: 'Discard payments', danger: true,
      cancelLabel: 'Keep billing',
      // Above the billing modal (1100) inside the order screen's own stacking context.
      zIndex: 1200,
      body: (
        <p style={{ margin: 0 }}>
          {tenders.map(t => `${t.method} ${fmtNpr(t.amount)}`).join(' · ')} {n === 1 ? 'has' : 'have'} been
          taken on this bill but nothing is saved until it is confirmed. Closing now forgets {n === 1 ? 'it' : 'them'} —
          any money already collected would have to be entered again.
          {liveRedemptionRef.current?.orderId === orderId
            ? ' The points already redeemed on this bill are handed back to the customer.'
            : tenders.some(t => t.method === 'Loyalty') ? ' No points have been deducted yet.' : ''}
        </p>
      ),
      // A redemption a failed close left standing is cancelled before the modal goes (S754). If that
      // fails the modal stays, with the tenders, so the points are never debited behind a closed screen.
      run: async () => {
        if (liveRedemptionRef.current?.orderId === orderId) {
          const res = await cancelLiveRedemption()
          if (!res.ok) {
            setCloseMsg(`error:The points redeemed on this bill could not be handed back, so the payment screen stayed open — try Cancel again. ${res.text}`)
            return
          }
        }
        setBillingOpen(false)
      },
    })
  }

  // Returns true when the bill's revenue and stock depletion actually reached IMS. The two early
  // returns below used to be silent: the bill closed, printed and took an invoice number while
  // Inventory never saw it, so POS Sales Report and IMS MonthlySummary disagreed by an unbounded
  // amount with nothing on either page saying so. The bill must still close — refusing a sale
  // mid-service is not acceptable — but the caller now stamps ims_posted_at only on success, and
  // the floor view surfaces whatever didn't post so it can be backfilled from Periods.
  async function writeSalesEntries(closeType, compQtyMap = compQtyByRecipe) {
    const { data: periods, error: perErr } = await scopedFrom('monthly_periods')
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    // Returning false is correct either way — the bill still closes and gets chased by the
    // unposted banner. But the banner's sentence blames a missing open period, so say when the
    // real cause was a failed read instead: the period may be open and fine.
    if (perErr) {
      warnWrite('Could not check which Inventory period is open, so the bill just closed was not posted to Inventory. Backfill it from Periods once the connection is back.', perErr)
      return false
    }
    const open = (periods || []).find(p => p.status === 'open')
    if (!open) return false
    const today = getBsToday()
    if (today.year !== open.bs_year || today.month !== open.bs_month) return false

    const soldItems = orderItems.filter(i => i.recipe_id)
    // Split each line's qty into its sold and comped portions — a whole-order Complimentary
    // close (closeType==='writeoff') comps the entire qty; an otherwise-paid order only comps
    // whatever the Pay tab's item-level comp picker recorded (compQtyMap, keyed by recipe_id).
    const qtySplit = soldItems.map(i => {
      const compQty = closeType === 'writeoff' ? i.qty : Math.min(compQtyMap[i.recipe_id] || 0, i.qty)
      return { ...i, compQty, saleQty: i.qty - compQty }
    })
    // Recorded under separate sources (not both as 'pos') so revenue-facing IMS reports
    // (MonthlySummary, PeriodComparison, AnnualSummary, MenuRepricing, MenuEngineering,
    // Overheads, BestSellers, Sales.js) can exclude 'pos_comp' — a comped dish was never paid
    // for — while consumption-facing reports (Variance, TheoreticalVariance, ShrinkageReport,
    // ReorderReport, StockReport, Recipes.js's per-cover overhead) keep summing every source
    // unfiltered, since that food was still prepared and consumed regardless of who paid for it.
    // unit_price/vat_rate snapshot the actual price charged on THIS bill (not just the recipe's
    // current default, which could differ later — or already did, via a per-order override) —
    // every IMS revenue report used to join the recipe's CURRENT selling_price instead, so a past
    // period's revenue/Food Cost % silently shifted whenever a menu price changed after the fact.
    // A bill-level discount (Pay tab only) reduces the taxable base proportionally across every
    // payable line (discRatio, computed above alongside payVatAmt) — 'pos' rows must snapshot
    // that discounted price too, or every revenue-based IMS report (incl. Owner Dashboard's Food
    // Cost %/Net Margin %) overstates revenue by the discount actually granted at the till.
    // 'pos_comp' rows stay at full price: comps are already zero-revenue (excluded by source),
    // and Variance/consumption reports only ever read qty_sold, never unit_price, from them.
    const saleDiscRatio = closeType === 'paid' ? discRatio : 0
    const rows = []
    qtySplit.forEach(({ recipe_id, saleQty, compQty, unit_price, vat_rate }) => {
      // pos_order_id mirrors stock_movements.ref_id: without it, "has this bill's revenue already
      // posted?" is unanswerable, and a bad post can't be undone by order (S573).
      if (saleQty > 0) rows.push({ period_id: open.id, recipe_id, bs_day: today.day, qty_sold: saleQty, source: 'pos', unit_price: unit_price * (1 - saleDiscRatio), vat_rate, pos_order_id: orderId })
      if (compQty > 0) rows.push({ period_id: open.id, recipe_id, bs_day: today.day, qty_sold: compQty, source: 'pos_comp', unit_price, vat_rate, pos_order_id: orderId })
    })
    if (rows.length > 0) {
      // S754: this dropped its error and fell through to `return true`, so closeOrder stamped
      // ims_posted_at on a bill whose revenue never landed — the one stamp that tells the unposted
      // banner and the Periods backfill to leave it alone. Returning false leaves it unstamped, so
      // both still chase it. Returning BEFORE the depletion is deliberate: the backfill posts
      // revenue and stock together, and movements written here would then be written twice.
      const { error: salesErr } = await supabase.from('sales_entries').insert(rows)
      if (salesErr) { console.error('sales_entries insert failed — bill left unposted for backfill:', salesErr); return false }
    }

    // Best-effort stock depletion — never blocks or fails the close. An item
    // individually comped within an otherwise-paid order posts as 'pos_comp' just like a
    // whole-order Complimentary close does — food cost was still lost even though this specific
    // line collected no revenue. A partially-comped line (e.g. 1 of 3) splits its ingredient
    // usage proportionally between the two buckets, since only part of that line was comped.
    try {
      const recipeIds = [...new Set(soldItems.map(i => i.recipe_id))]
      if (recipeIds.length > 0) {
        const breakdown = await explodeRecipeIngredients(supabase, recipeIds)
        const aggBySource = { pos_sale: {}, pos_comp: {} }
        qtySplit.forEach(({ recipe_id, saleQty, compQty }) => {
          ;(breakdown[recipe_id] || []).forEach(({ item_id, qty }) => {
            if (saleQty > 0) aggBySource.pos_sale[item_id] = (aggBySource.pos_sale[item_id] || 0) + qty * saleQty
            if (compQty > 0) aggBySource.pos_comp[item_id] = (aggBySource.pos_comp[item_id] || 0) + qty * compQty
          })
        })
        const movementRows = Object.entries(aggBySource).flatMap(([source, agg]) =>
          Object.entries(agg).map(([item_id, qty]) => ({
            item_id, period_id: open.id, bs_day: today.day, qty: -qty, source, ref_id: orderId,
          }))
        )
        if (movementRows.length > 0) {
          const { error: moveErr } = await scopedInsert('stock_movements', movementRows)
          if (moveErr) console.error('stock_movements write failed:', moveErr)
        }
      }
    } catch (err) {
      console.error('stock_movements write failed:', err)
    }
    return true
  }

  async function closeOrder(closeType) {
    if (!orderId || !clientId) return false
    if ((closeType === 'void' || closeType === 'writeoff') && !closeReason) {
      setCloseMsg('error:Select a reason.'); return false
    }
    if (closeType === 'paid' && discountAmt > 0 && !discountReason) {
      setCloseMsg('error:Select a discount reason.'); return false
    }
    if (closeType === 'paid' && requireBuyerId && (!buyerName.trim() || !buyerPhone.trim())) {
      setCloseMsg('error:Buyer Name + Phone are required for a discount or Credit sale.'); return false
    }
    if (closeType === 'paid' && splitMode && (remaining > 0 || tenders.length === 0)) {
      setCloseMsg('error:Split payment is not fully collected yet.'); return false
    }
    if (closeType === 'paid' && tendersOverpaid) {
      setCloseMsg(`error:The payments recorded (${fmtNpr(tendersTotal)}) are more than this bill now comes to (${fmtNpr(payTotal)}) — the total changed after they were taken. Undo the payments and take them again against the new total.`); return false
    }
    // redeem_loyalty_points debits the account on the phone stored on the ORDER (S754), so a
    // redemption with the phone since cleared would fail at the RPC with a message about the bill.
    if (closeType === 'paid' && tenders.some(t => t.method === 'Loyalty') && !buyerPhone.trim()) {
      setCloseMsg("error:Enter the customer's phone — points are redeemed from the account on that number."); return false
    }
    if (closeType === 'paid' && cashShortfall > 0) {
      setCloseMsg(`error:Tendered ${fmtNpr(resolveTendered(payTotal))} is ${fmtNpr(cashShortfall)} short of the bill total ${fmtNpr(payTotal)} — collect the difference, or put the bill on Credit if the customer will pay later.`); return false
    }
    if (closeType === 'paid' && hasItemComp && !itemCompReason) {
      setCloseMsg('error:Select a reason for the complimentary item(s).'); return false
    }
    if (closeType === 'paid' && orderItems.length > 0 && payableOrderItems.length === 0) {
      setCloseMsg('error:Every item is comped — use the Complimentary tab instead of issuing a ₨0 bill.'); return false
    }
    // Guards a manual Charge tap and the QR auto-confirm poll from racing each other — the poll
    // calls closeOrder directly, bypassing the Confirm Payment button's own disabled={closing}.
    // Returns a boolean (false on any abort/failure, true only once the order is actually
    // billed) so the poll can tell whether it's safe to consume the payment confirmation it
    // matched — see the effect above, which no longer marks consumed_at until this resolves true.
    if (closingRef.current) return false
    closingRef.current = true
    setClosing(true); setCloseMsg('')

    try {
      // S754 (owner decision): a bill that takes money — Charge (Cash, QR, Split AND Credit, which
      // are all close type 'paid') or Complimentary — needs an open shift, so every bill lands on a
      // drawer count and a Z-report. Void takes no money and is not gated. A FRESH read, not the
      // cached openShiftId: that cache is refreshed only after a close and deliberately survives a
      // failed read, so it can say "open" about a shift another device closed minutes ago. A failed
      // read refuses (fails closed). Runs before performSave, so a refusal here has written nothing.
      let billShiftId = openShiftId
      if (closeType === 'paid' || closeType === 'writeoff') {
        const { data: shiftRow, error: shiftErr } = await scopedFrom('pos_shifts', 'id').eq('status', 'open').maybeSingle()
        if (shiftErr) {
          setCloseMsg(`error:Couldn't check whether a shift is open, so this bill was not charged — try again. ${errorText(shiftErr, 'staff')}`)
          return false
        }
        if (!shiftRow) {
          setOpenShiftId(null)
          setCloseMsg('error:Open a shift first (POS → Shifts). A bill can only be charged while a shift is open, so its takings land on a drawer count.')
          return false
        }
        billShiftId = shiftRow.id
        setOpenShiftId(shiftRow.id)
      }

      // Persist the cart before billing it. Two reasons, and the second one predates the first:
      //
      //   1. The server-side discount cap (migration 20260819120000) measures the cap against the
      //      order's STORED lines, because those are the only ones a trigger can trust. A bill can
      //      legitimately be charged straight after an edit — the Payment button gates on
      //      saving/orderId/isOnline, never on a dirty cart — so without this an at-the-cap
      //      discount could be rejected for a subtotal the server cannot see.
      //   2. writeSalesEntries posts revenue from the in-memory cart. An unsaved line was already
      //      reaching IMS revenue and the printed bill while never existing in pos_order_items —
      //      the bill and its own lines disagreeing, quietly, with nothing on either side saying so.
      //
      // Runs before apply_pos_item_comps, not after: save_pos_order_items replaces the lines
      // wholesale, so persisting afterwards would erase the comp rows it had just written.
      //
      // Every close type, not just 'paid' (S754): a Complimentary slip and a void read their lines
      // back from the same stored rows (Recent Bills reprints, KOT Reconciliation, the credit-note
      // and exception reports), and writeSalesEntries posts a write-off's consumption from this
      // in-memory cart — so an unsaved line on a comp slip reached IMS and the paper while never
      // existing on the order. performSave only persists lines, covers and guest-request accepts;
      // it never fires a ticket (that is saveOrder/sendTicket), so it is safe for all three.
      if (orderItems.length > 0) {
        const persisted = await performSave()
        if (!persisted.ok) {
          // A stale order, a bill closed elsewhere, a dish off the menu: the order screen already says
          // which, so the payment modal gets out of its way (and hands back any standing redemption).
          if (persisted.handled) { dismissBillingAfterRefusal(); return false }
          setCloseMsg(`error:Could not save the order before billing it, so nothing was charged — try again. ${errorText(persisted.error, 'staff')}`)
          return false
        }
        // S754: the server priced the lines. A new line takes the menu's price and VAT as of THIS save,
        // which can differ from what the cart showed if the menu changed since it loaded. The cart now
        // carries the server's values (performSave), but this close was computed from the old ones — so
        // stop and let the cashier see the real total rather than bill a different amount from the one
        // on screen, or print a bill that disagrees with its stored lines.
        const drift = menuDrift(orderItems, persisted.items)
        if (drift) {
          setCloseMsg(drift === 'price'
            ? 'error:Prices were updated from the menu — check the bill total and confirm again.'
            : 'error:Item names were updated from the menu — check the bill and confirm again.')
          return false
        }
      }

      const isSplit = closeType === 'paid' && splitMode && tenders.length > 0
      const today = getBsToday()

      // Item-level comp is applied BEFORE the order is marked billed, via one atomic RPC
      // (apply_pos_item_comps, see migration 20260706170000) that reserves the shared NC-series
      // number and writes every comped/split row in a single transaction — closing the race the
      // previous get_next_pos_comp_slip_no-then-write-separately dance couldn't (the advisory
      // lock released the instant that RPC returned, before this component's writes landed). If
      // it fails, abort here: nothing has been billed yet, so the cashier just sees an error and
      // retries, instead of the order going out paid while its comped items silently never got
      // marked (the old "best-effort" behavior).
      let compNo = null
      let compedItemRows = []
      if (closeType === 'paid' && hasItemComp) {
        const compFy = getBsFiscalYear(today.year, today.month)
        const fullCompRecipeIds = []
        const partialComps = []
        for (const i of orderItems) {
          const compQty = Math.min(compQtyByRecipe[i.recipe_id] || 0, i.qty)
          if (compQty <= 0) continue
          if (compQty === i.qty) fullCompRecipeIds.push(i.recipe_id)
          else partialComps.push({
            recipe_id: i.recipe_id, comp_qty: compQty, name: i.name, category: i.category,
            unit_price: i.unit_price, vat_rate: i.vat_rate, sent_to_kot: i.sent_to_kot,
          })
        }
        // p_comped_by is IGNORED by the server as of migration 20260819140000 — it derives
        // comped_by from auth.uid() instead, because that column is what the Sales Exception Report
        // ranks staff by and a caller able to choose it could comp under a colleague's name. It
        // stays in the call only so the argument list keeps matching the function's signature for
        // any device still on an older bundle; do not start relying on it again.
        const { data: newCompNo, error: compErr } = await supabase.rpc('apply_pos_item_comps', {
          p_order_id: orderId, p_client_id: clientId, p_fy: compFy,
          p_comp_reason: itemCompReason, p_comped_by: profile?.id || null,
          p_full_recipe_ids: fullCompRecipeIds, p_partial: partialComps,
        })
        if (compErr) {
          setCloseMsg('error:Could not apply the complimentary item(s) — ' + compErr.message)
          return false
        }
        compNo = newCompNo
        const { data, error: compRowsErr } = await scopedFrom('pos_order_items', '*').eq('order_id', orderId).eq('comp_no', compNo)
        // The comps are already applied by the RPC above, so this cannot abort the close. But an
        // empty read prints a Complimentary Slip with no lines on it, and a blank NC document is
        // worse than none — the number is assigned, so it can be reprinted from Recent Bills.
        if (compRowsErr) {
          warnWrite(`Complimentary slip NC-${compNo} was not printed — its items could not be read back. Reprint it from Recent Bills.`, compRowsErr)
          compedItemRows = null
        } else compedItemRows = data || []
      }

      // Loyalty redemption, applied BEFORE the order is marked billed — the same ordering the
      // item-comp RPC uses (S286) and for the same reason: a failure here must abort the Charge
      // cleanly rather than bill a customer whose points were never debited. The RPC writes the
      // ledger row AND the 'Loyalty' tender in one transaction, which is exactly why that tender
      // is filtered out of the local pos_order_payments insert further down — writing it twice
      // would double the collected total on the Z-report.
      //
      // S754: this could never succeed. The RPC reads buyer_phone from the STORED order and finds
      // the customer by that exact phone, but buyer_name/buyer_phone were only written by the close
      // payload further down — after this call — so every redemption raised "This bill has no
      // customer phone". The buyer goes onto the open order first (a plain column write that
      // guard_pos_order_close does not fire on), then the customer row the RPC resolves is upserted
      // and awaited — the same dependency award_loyalty_points has on it below.
      //
      // S754 (migration 20260916100000): a redemption REPLACES an earlier one on the same bill, so a
      // retried Confirm simply redeems again — the double-debit guard that skipped the call on a retry
      // is gone, and it was wrong for a changed point count anyway. A close with no points tender (or a
      // void / Complimentary) hands back whatever an earlier attempt left standing first.
      // Only a Charge redeems — a tender list left over from the Pay tab must not redeem on a void.
      const loyaltyTender = closeType === 'paid' ? tenders.find(t => t.method === 'Loyalty') : null
      const custRow = buyerName.trim() && buyerPhone.trim()
        ? {
            name: buyerName.trim(), phone: buyerPhone.trim(), updated_at: new Date().toISOString(),
            ...(buyerAddress.trim() ? { address: buyerAddress.trim() } : {}),
            ...(buyerPan.trim() ? { pan: buyerPan.trim() } : {}),
          }
        : null
      let custUpsertDone = false
      if (!loyaltyTender && liveRedemptionRef.current?.orderId === orderId) {
        const res = await cancelLiveRedemption()
        if (!res.ok) {
          setCloseMsg(`error:Points redeemed on an earlier attempt at this bill could not be handed back, so it was not closed and nothing was charged — try again. ${res.text}`)
          return false
        }
      }
      if (loyaltyTender) {
        const { error: buyerErr } = await scopedUpdate('pos_orders', {
          buyer_name: buyerName.trim() || null, buyer_phone: buyerPhone.trim() || null,
        }).eq('id', orderId)
        if (buyerErr) {
          setCloseMsg("error:Could not attach the customer's phone to this bill, so the points were NOT redeemed and nothing was charged — try again, or undo the points and take another payment.")
          console.error('buyer write before redemption failed:', buyerErr)
          return false
        }
        if (custRow) {
          const { error: custErr } = await scopedUpsert('pos_customers', custRow, { onConflict: 'client_id,phone' })
          // Not a refusal on its own: the balance shown was read from this customer's existing row,
          // so the RPC can still find it. If it truly is missing the RPC refuses, and says so.
          if (custErr) console.error('pos_customers upsert before redemption failed:', custErr)
          else custUpsertDone = true
        }
        // Marked BEFORE the call: a response lost after the server committed must still leave this
        // screen able to hand the points back (undo, Cancel, or a close without them).
        liveRedemptionRef.current = { orderId }
        const { error: redErr } = await supabase.rpc('redeem_loyalty_points', {
          p_order_id: orderId, p_points: loyaltyTender.points,
        })
        if (redErr) {
          setCloseMsg(redErr.hint === HINT.rank
            ? 'error:Redeeming points needs a POS Supervisor login or above — nothing was charged.'
            : `error:Could not redeem the points, so nothing was charged — ${redErr.message}`)
          return false
        }
      }

      const payload = {
        status:           closeType === 'void' ? 'voided' : 'billed',
        close_type:       closeType,
        payment_method:   closeType === 'paid' ? (isSplit ? 'Split' : payMethod) : null,
        paid_amount:      closeType === 'paid' ? payTotal : (closeType === 'writeoff' ? 0 : null),
        tendered_amount:  closeType === 'paid' && !isSplit && payMethod === 'Cash' ? resolveTendered(payTotal) : null,
        // Commission is deliberately NOT computed here — Foodmandu/Pathao don't pay at the
        // counter (they remit later, minus commission), so this is a receivable, not an instant
        // payment. commission_amount gets set at settlement time instead (Customers →
        // Outstanding Credit → Settle), against the platform's actual remittance, not a
        // Charge-time estimate.
        delivery_partner: closeType === 'paid' && payMethod === 'Credit' ? (deliveryPartner || null) : null,
        close_reason:     closeType === 'paid' ? null : closeReason,
        discount_amount:  closeType === 'paid' ? discountAmt : null,
        discount_reason:  closeType === 'paid' ? (discountReason || null) : null,
        buyer_name:       buyerName.trim() || null,
        buyer_address:    buyerAddress.trim() || null,
        buyer_pan:        buyerPan.trim() || null,
        buyer_phone:      buyerPhone.trim() || null,
        bill_remarks:     billRemarks.trim() || null,
        // closed_by, closed_at and invoice_no are NOT sent (S754): guard_pos_order_close stamps closed_by
        // from the session and closed_at from the server clock (a tablet clock could backdate a bill
        // into a closed month), and clears any invoice_no a request carries so the numbering trigger
        // always assigns it. All three come back on the row `.select('*')` returns, which is what the
        // printed bill reads.
        // Both Pay and Complimentary get their own sequential number (TI/PB for Pay, NC for
        // Complimentary) — the DB trigger partitions the counter by close_type so the two
        // sequences never share numbers. Void never gets one (order was never fulfilled).
        ...(closeType !== 'void' ? { invoice_fy: getBsFiscalYear(today.year, today.month) } : {}),
        // The shift open at the moment of the bill. For Charge and Complimentary this is the fresh
        // read above, which refused the close when there was none (S754) — so an order left open
        // across a shift close is stamped with the NEXT shift when it is finally billed, which is
        // what PosShifts' close warning tells the supervisor. A void stays on the cached id.
        shift_id: billShiftId,
      }

      const { data: updated, error } = await scopedUpdate('pos_orders', payload).eq('id', orderId)
        .select('*').single()
      if (error) {
        // Closed on another device between the save above and this write: the close guard now refuses
        // any write to a closed bill (S754).
        if (error.hint === HINT.locked) { showClosedElsewhere(); return false }
        // Closing is Supervisor work and the server now says so for every close type (S754) — the
        // Payment button is already hidden below that rank, so this is a login whose rank changed.
        if (error.hint === HINT.rank) {
          setCloseMsg('error:This login cannot close bills — it needs POS Supervisor access or above. Nothing was charged; ask a supervisor to take the payment.')
          return false
        }
        // guard_pos_order_close() (migration 20260819120000) refuses an over-cap discount or a void
        // from an account without Allow Void, and phrases the refusal for the person holding the
        // till. Its messages are prefixed with the table name the way every Postgres error is;
        // strip that so the cashier reads the sentence, not the schema.
        setCloseMsg('error:' + stripCodeWord(error.message, 'pos_orders'))
        return false
      }
      // The bill is closed and numbered. Nothing an earlier attempt redeemed is "standing" any more —
      // it is this bill's tender now.
      liveRedemptionRef.current = null
      const where = activeTable?.name || (orderNo ? `Takeaway #${orderNo}` : 'this takeaway')

      // Split legs FIRST, straight after the close: the server admits them only from the login that
      // closed the bill, within 10 minutes of its server-stamped closed_at (S754) — nothing else may
      // run in between that could push them past that window or out of this session.
      if (isSplit) {
        // The Loyalty leg is deliberately absent: redeem_loyalty_points already wrote it, in the
        // same transaction as the ledger debit, so inserting it again here would show the bill as
        // collecting the redemption twice — and the server refuses a Loyalty leg from the browser.
        const cashTenders = tenders.filter(t => t.method !== 'Loyalty')
        if (cashTenders.length > 0) {
          // The bill is already billed and numbered by this point, so this cannot be undone by
          // refusing the close. But these rows ARE the record of how the bill was paid: without
          // them the shift's Z-report reconciles a drawer against a payment mix missing this
          // bill's legs, which reads as a cash variance nobody can explain.
          const legRows = cashTenders.map(t => ({
            order_id: orderId,
            payment_method: t.method, amount: t.amount, tendered_amount: t.tenderedAmount,
            recorded_by: profile?.id || null,
          }))
          let { error: payErr } = await scopedInsert('pos_order_payments', legRows)
          if (payErr) {
            // A dropped response can hide an insert that landed, and a blind retry of a landed one is
            // refused anyway (the server will not let the legs exceed the bill). So look first: legs
            // already there means it landed; none there means one retry, still inside the window.
            const { data: legs, error: legsErr } = await scopedFrom('pos_order_payments', 'amount')
              .eq('order_id', orderId).neq('payment_method', 'Loyalty')
            const want = cashTenders.reduce((s, t) => s + t.amount, 0)
            const found = legs || []
            const have = found.reduce((s, l) => s + (Number(l.amount) || 0), 0)
            if (!legsErr && found.length === cashTenders.length && Math.abs(have - want) < 0.01) {
              payErr = null
            } else if (!legsErr && found.length === 0) {
              const retry = await scopedInsert('pos_order_payments', legRows)
              payErr = retry.error
            }
          }
          if (payErr) {
            warnWrite(`How ${where} was paid (${cashTenders.map(t => `${t.method} ${fmtNpr(t.amount)}`).join(' + ')}) did not save. The bill is closed and correct, but the shift report will not show these payments — give the amounts to whoever closes the drawer. They cannot be added to the bill afterwards.`, payErr)
          }
        }
      }

      if (closeType === 'void') {
        // Best-effort — a KDS ticket for a voided order should disappear from the board rather
        // than sit accumulating "late" alerts forever with no signal the order no longer exists.
        // Comps (writeoff) don't cancel here: the food was actually prepared/served, so its
        // ticket keeps its normal lifecycle.
        // Best-effort by design; the try/catch this replaces caught nothing, since the call
        // resolves with { error } rather than throwing. Failure leaves a cancelled order's
        // ticket on the kitchen board accruing "late" alerts, which is worth a console line.
        const { error: kotCancelErr } = await scopedUpdate('pos_kot_log', { status: 'cancelled' }).eq('order_id', orderId)
        if (kotCancelErr) console.error('KDS ticket cancel failed (non-fatal):', kotCancelErr)
      }

      // The two writes below are STARTED here and awaited further down, rather than each taking
      // its own turn in the queue. Both depend only on the order already being billed — neither
      // reads anything the IMS post produces — so they travel alongside it instead of adding two
      // more round trips to a cashier who is holding up the counter. Each carries its own .catch
      // so a network throw cannot surface as an unhandled rejection in the gap before it is
      // awaited; both have always swallowed their failures, and still do.

      // Freeing the table. Awaited before loadFloor() reads the floor back, so a tile can never
      // repaint as still occupied.
      const tableFree = activeTable?.id
        ? Promise.resolve(scopedUpdate('pos_tables', { status: 'available' }).eq('id', activeTable.id))
            .catch(e => { console.error('pos_tables release failed (non-fatal):', e) })
        : null

      // A booking seated from the floor completes when its bill closes — every close type, since
      // the visit is over as far as the book is concerned (the bill's own outcome is read through
      // order_id). Zero rows matched is the ordinary walk-in case, not a failure.
      const reservationDone = Promise.resolve(
        scopedUpdate('pos_reservations', stampFor('completed')).eq('order_id', orderId).eq('status', 'seated')
      ).then(({ error }) => {
        if (error) warnWrite('The booking linked to this bill still shows as Seated in Reservations — mark it Completed there.', error)
      }).catch(e => { console.error('pos_reservations completion failed (non-fatal):', e) })

      // Auto-build the customer book: any bill with buyer Name + Phone (required for discounts and
      // Credit sales) adds/updates a pos_customers row keyed by phone. Non-fatal — never blocks billing.
      // Already written before a redemption (above), in which case it is not sent twice.
      let custUpsert = null
      if (custRow && !custUpsertDone) {
        custUpsert = Promise.resolve(scopedUpsert('pos_customers', custRow, { onConflict: 'client_id,phone' }))
          .catch(e => { console.error('pos_customers upsert failed (non-fatal):', e) })
      }

      // Stamp only on a confirmed post. A void has nothing to post, so it is marked done rather
      // than left looking like a failure the floor banner should chase.
      if (closeType !== 'void') {
        const posted = await writeSalesEntries(closeType)
        if (posted) {
          // The stamp is the only thing separating "posted" from "needs backfilling". If it
          // fails the revenue IS in IMS, so the floor banner will chase a bill that is fine.
          // Not a double-post risk: the Periods backfill re-checks sales_entries.pos_order_id
          // before posting anything and re-stamps what it finds — but say so rather than let
          // someone hunt a phantom.
          const { error: stampErr } = await scopedUpdate('pos_orders', { ims_posted_at: new Date().toISOString() }).eq('id', orderId)
          if (stampErr) warnWrite('The bill just closed did reach Inventory, but saving its "posted" mark failed — it will keep showing as not posted until a backfill from Periods clears it.', stampErr)
        } else setImsPostWarning(w => w + 1)
      } else {
        const { error: stampErr } = await scopedUpdate('pos_orders', { ims_posted_at: new Date().toISOString() }).eq('id', orderId)
        if (stampErr) warnWrite('The voided bill could not be marked as settled with Inventory — it will show as not posted until a backfill from Periods clears it.', stampErr)
      }

      // Settled before the loyalty award below, and that ordering is load-bearing rather than
      // incidental: award_loyalty_points matches the customer on pos_orders.buyer_phone against
      // pos_customers, and returns 0 if there is no row — so a first-time customer would earn
      // nothing if the two ran together.
      if (custUpsert) await custUpsert

      // Loyalty earn, immediately after the customer row exists — award_loyalty_points()
      // resolves the customer from the order's buyer_phone, so the upsert above has to have
      // landed first.
      //
      // Best-effort in the same shape writeSalesEntries established: a points problem must
      // never stop a bill closing. But deliberately NOT silent — an earn that fails without a
      // word is how a regular discovers at the till next month that none of it counted. The
      // RPC computes from the order's own stored lines, so nothing here can influence the
      // number; this call only asks.
      //
      // S754: the server now awards only to the login that closed the bill, within 10 minutes of the
      // close, and a till cannot retry it later — so a failure here is final for staff, and the note
      // says who can still add the points rather than inviting a retry that will be refused.
      setLoyaltyNote(null)
      if (hasFeature('loyalty') && closeType === 'paid' && buyerPhone.trim()) {
        const who = buyerName.trim() || buyerPhone.trim()
        const awardFailed = detail => setLoyaltyNote({
          ok: false,
          text: `Points were not added for ${who} — ${detail} They can only be added from the till as the bill closes, so ask the Owner to add them.`,
        })
        try {
          const { data: earned, error: loyErr } = await supabase.rpc('award_loyalty_points', { p_order_id: orderId })
          // The award's own refusals (not the closer, past the 10-minute window) already say "ask the Owner".
          if (loyErr && (loyErr.hint === HINT.rank || loyErr.hint === 'award_window_closed')) {
            setLoyaltyNote({ ok: false, text: `Points were not added for ${who} — ${loyErr.message}` })
          } else if (loyErr) awardFailed(errorText(loyErr, 'staff'))
          else if (earned > 0) setLoyaltyNote({ ok: true, text: `+${earned} point${earned === 1 ? '' : 's'} for ${who}` })
        } catch (e) {
          awardFailed(String(e?.message || e))
        }
      }

      if (tableFree) await tableFree
      await reservationDone
      // The per-table snapshot described the order that just closed (S754) — left behind, an
      // offline open of this table reloaded a paid bill's lines. Best-effort: the offline path now
      // also refuses a snapshot unless the table reads occupied.
      if (activeTable?.id) clearCachedPosOrderForTable(activeTable.id).catch(e => console.error('order snapshot clear failed (non-fatal):', e))

      // A blocked pop-up used to set an order-screen message that backToFloor wiped a moment later,
      // on a floor with no message line — so the bill closed and nothing printed, silently (S754).
      // The close cannot be undone for it; the floor banner names the recovery.
      const printed = []
      if (closeType === 'paid') printed.push(await printBill(updated, payableOrderItems))
      if (closeType === 'writeoff') printed.push(await printCompSlip(updated, orderItems))
      // compedItemRows is null only when the read above failed — skip rather than print a slip
      // with no lines; the operator has already been told to reprint it.
      if (closeType === 'paid' && compNo != null && compedItemRows) printed.push(await printItemCompSlip(updated, compedItemRows))
      if (printed.some(p => p !== true)) {
        warnWrite(`The bill for ${where} was closed but did not print — allow pop-ups for this site, then reprint it from Recent Bills.`)
      }

      setBillingOpen(false)
      await loadFloor()
      backToFloor()
      return true
    } finally {
      closingRef.current = false
      setClosing(false)
    }
  }

  // Pure HTML builder — no side effects, no DB calls. Shared by the actual print (printBill)
  // and the live in-modal preview, so the preview can never drift out of sync with what prints.
  // Per-bill dynamic payment QR: the merchant's static QR payload (Settings → Payment QR) with
  // this bill's exact amount injected (EMVCo tag 54) and the checksum recomputed — customer
  // scans and the amount arrives pre-filled/locked in their banking app. Pure string work, no
  // provider API. Returns a data-URL image, or '' if not configured / payload invalid.
  async function makeBillQr(amount, reference) {
    if (!billingSettings.payment_qr_data || !(amount > 0)) return ''
    const payload = buildDynamicQr(billingSettings.payment_qr_data, amount, reference)
    if (!payload) return ''
    try { return await QRCode.toDataURL(payload, { margin: 1, width: 200 }) } catch { return '' }
  }

  async function printBill(order, items) {
    // Split tenders are read BEFORE print_count is incremented. A dropped error here fell
    // through to `payments = []` and printed a Split bill with no payment breakdown at all —
    // a wrong document under a real invoice number — and aborting after the increment would
    // have mislabelled the next reprint's ORIGINAL/SECOND-COPY line too (S616).
    let payments
    if (order.payment_method === 'Split') {
      const { data, error } = await scopedFrom('pos_order_payments', 'payment_method, amount').eq('order_id', order.id).order('recorded_at')
      if (error) {
        window.alert(`Couldn't load this bill's split payment lines: ${error.message}\n\nNothing was printed — try again, so the bill doesn't go out without its payment breakdown.`)
        return null // not printed, and already said so — distinct from false (a blocked pop-up)
      }
      payments = (data || []).map(p => ({ method: p.payment_method, amount: p.amount }))
    }
    const newCount = (order.print_count || 0) + 1
    // Not blocking: withholding a customer's bill because a counter did not move is worse than
    // the counter being stale. But the label printed on this copy comes from `newCount` while
    // the stored one does not move, so the NEXT reprint repeats this same copy number — which
    // is exactly what the ORIGINAL/COPY sequence exists to make distinguishable.
    const { error: pcErr } = await scopedUpdate('pos_orders', { print_count: newCount }).eq('id', order.id)
    if (pcErr) warnWrite('A reprint count did not save — the next reprint of that bill will carry the same copy number as this one.', pcErr)
    const qrUrl = QR_PAY_METHODS.includes(order.payment_method)
      ? await makeBillQr(order.paid_amount, order.order_no ? `CR${order.order_no}` : null) : ''
    // Returned so a caller can tell a blocked pop-up from a printed bill (S754).
    return printHtml(buildBillHtml({
      order, items, copyLabel: COPY_LABEL(newCount), qrUrl, payments,
      outletName, billingSettings, hscMap,
      tableName: activeTable?.name || order.table_name || 'Takeaway',
      cashierName: profile?.full_name || '',
    }))
  }

  // Complimentary items were never sold — this is an internal cost-tracking slip, not a Tax
  // Invoice or PAN Bill: no VAT/PAN, own NC-prefixed sequence (separate from TI/PB), and line
  // amounts are valued at food cost (not menu price) so the P&L impact isn't distorted by
  // retail pricing. Standard practice per restaurant accounting for comps.
  async function printCompSlip(order, items) {
    const newCount = (order.print_count || 0) + 1
    // Not blocking: withholding a customer's bill because a counter did not move is worse than
    // the counter being stale. But the label printed on this copy comes from `newCount` while
    // the stored one does not move, so the NEXT reprint repeats this same copy number — which
    // is exactly what the ORIGINAL/COPY sequence exists to make distinguishable.
    const { error: pcErr } = await scopedUpdate('pos_orders', { print_count: newCount }).eq('id', order.id)
    if (pcErr) warnWrite('A reprint count did not save — the next reprint of that bill will carry the same copy number as this one.', pcErr)
    const recipeIds = items.map(i => i.recipe_id).filter(Boolean)
    const costMap = await computeRecipeCosts(supabase, recipeIds)
    return printHtml(buildCompSlipHtml({
      order, items, costMap, copyLabel: COPY_LABEL(newCount),
      outletName,
      tableName: activeTable?.name || order.table_name || 'Takeaway',
      authorizedBy: profile?.full_name || '',
    }))
  }

  // One item-level Complimentary Slip per Charge action, covering every item comped in that
  // action (not one per line) — shares the whole-order Complimentary Slip's NC-series (see the
  // get_next_pos_comp_slip_no migration), so `order.invoice_no` (this order's Tax Invoice/PAN
  // Bill number) is swapped out for the comp-specific number the comped rows just got assigned.
  // Uses its own `comp_print_count` counter (not the main bill's `print_count`) so reprinting
  // one document never mislabels the other's copy number — see reprintItemCompSlip.
  async function printItemCompSlip(order, compedItems) {
    const newCount = (order.comp_print_count || 0) + 1
    const { error: pcErr } = await scopedUpdate('pos_orders', { comp_print_count: newCount }).eq('id', order.id)
    if (pcErr) warnWrite('A complimentary-slip reprint count did not save — the next reprint will carry the same copy number as this one.', pcErr)
    const recipeIds = compedItems.map(i => i.recipe_id).filter(Boolean)
    const costMap = await computeRecipeCosts(supabase, recipeIds)
    return printHtml(buildCompSlipHtml({
      order: { ...order, invoice_no: compedItems[0]?.comp_no ?? null, close_reason: compedItems[0]?.comp_reason || itemCompReason, bill_remarks: '' },
      items: compedItems, costMap, copyLabel: COPY_LABEL(newCount),
      outletName,
      tableName: activeTable?.name || order.table_name || 'Takeaway',
      authorizedBy: profile?.full_name || '',
    }))
  }

  // Reprint just the item-comp slip for an order from Recent Bills — the main Tax Invoice/Bill's
  // own Reprint button (below) only ever re-sends the non-comped items, so a bill with any
  // comped items needs this separate action to get a duplicate of that slip.
  async function reprintItemCompSlip(orderRow) {
    if (!hasPosAccess('supervisor')) return // S754: Recent Bills is Supervisor+ — see loadRecentBills
    // Together, not one after the other — the second read filters on orderRow.id like the first,
    // not on anything the first returns, so serialising them just made the counter wait twice.
    const [{ data: order }, { data: items }] = await Promise.all([
      scopedFrom('pos_orders').eq('id', orderRow.id).single(),
      scopedFrom('pos_order_items', '*').eq('order_id', orderRow.id).eq('comped', true),
    ])
    if (!order || !items || items.length === 0) return
    if ((await printItemCompSlip(order, items)) === false) alertPopupBlocked()
  }

  // Recent Bills is on the FLOOR, which has no message line — printHtml's own setMsg renders only
  // on the order screen, so a blocked reprint did nothing visible (S754). window.alert for the
  // same reason the floor's other refusals use it (see the import note at the top).
  function alertPopupBlocked() {
    window.alert('Nothing printed — this browser blocked the print window. Allow pop-ups for this site, then press Reprint again.')
  }

  async function loadRecentBills() {
    // S754 (owner decision): Recent Bills — the day's bills, reprints and the Credit Note entry — is
    // for POS Supervisor and above. The button is hidden for Staff rank and the modal will not render
    // for them; these handler checks are the third layer, so no path reads or reprints for a Staff
    // session even if the state is set some other way.
    if (!hasPosAccess('supervisor')) return
    setRecentBillsLoad(true)
    setRecentBillsError(null)
    // S754: this read the newest 30 bills and filtered them to "today" in JS with adToBs on the
    // VIEWER's clock — so on a busy day every bill past the 30th was missing from the list staff
    // reprint from (and check before re-billing), and an operator abroad saw the wrong day. Today
    // is now Nepal's BS day, bounded on the server with +05:45 edges and paged.
    const today = nepalBs(new Date())
    const dayStart = today && bsDayBoundaryIso(today.year, today.month, today.day, false)
    const dayEnd   = today && bsDayBoundaryIso(today.year, today.month, today.day, true)
    if (!dayStart || !dayEnd) {
      setRecentBillsError("today's date is outside the calendar table")
      setRecentBills([])
      setRecentBillsLoad(false)
      return
    }
    const { data, error } = await fetchAllRows(() =>
      scopedFrom('pos_orders', 'id, table_name, invoice_no, invoice_fy, close_type, paid_amount, closed_at, order_no, credit_note_id, buyer_name, buyer_address, buyer_pan, buyer_phone, discount_amount, print_count')
        .in('status', ['billed', 'voided'])
        .gte('closed_at', dayStart).lte('closed_at', dayEnd)
        .order('closed_at', { ascending: false })
        .order('id'))
    if (error) {
      setRecentBillsError(error.message)
      setRecentBills([])
      setRecentBillsLoad(false)
      return
    }
    const todays = data || []
    setRecentBills(todays)

    // Which of today's paid bills have any item-level comp — most don't, so the "Comp Slip"
    // reprint action only shows up where there's actually something to reprint. Chunked: a
    // whole day's paid ids is now an unbounded list, and an .in() list is a URL (S629).
    const paidIds = todays.filter(o => o.close_type === 'paid').map(o => o.id)
    const { data: compedRows, error: compedErr } = await fetchAllRowsChunked(paidIds, ids =>
      scopedFrom('pos_order_items', 'id, order_id').eq('comped', true).in('order_id', ids).order('id'))
    // Failure hides the "Comp Slip" reprint button on bills that have one — the bill itself
    // still reprints, so this is a missing shortcut rather than missing money.
    if (compedErr) console.error('item-comp lookup for Recent Bills failed:', compedErr)
    setOrdersWithItemComp(new Set((compedRows || []).map(r => r.order_id)))

    setRecentBillsLoad(false)
  }

  async function reprintBill(orderRow) {
    if (!hasPosAccess('supervisor')) return // S754: Recent Bills is Supervisor+ — see loadRecentBills
    // Same reason as reprintItemCompSlip above: independent reads, so one round trip rather than
    // two with a customer standing at the counter.
    const [{ data: order, error: orderErr }, { data: items, error: itemsErr }] = await Promise.all([
      scopedFrom('pos_orders').eq('id', orderRow.id).single(),
      scopedFrom('pos_order_items').eq('order_id', orderRow.id),
    ])
    // `if (!order) return` alone let a failed ITEMS read straight through: items came back null,
    // `|| []` turned it into an empty array, and the reprint went out as a Tax Invoice carrying
    // a real invoice number and not one line item (S616).
    if (orderErr || itemsErr || !order || !items) {
      window.alert(`Couldn't load bill ${orderRow.invoice_no || orderRow.order_no || ''} to reprint: ${(orderErr || itemsErr)?.message || 'the bill could not be found'}\n\nNothing was printed — try again.`)
      return
    }
    let printed
    if (order.close_type === 'writeoff') {
      printed = await printCompSlip(order, items || [])
    } else {
      // Exclude any individually-comped lines from the reprinted Tax Invoice/PAN Bill — they
      // were never on the original bill either (see closeOrder's payableOrderItems).
      printed = await printBill(order, (items || []).filter(i => !i.comped))
    }
    // false = blocked window; null = printBill already alerted about its own failed read.
    if (printed === false) alertPopupBlocked()
    setRecentBills(prev => prev.map(o => o.id === orderRow.id ? { ...o, print_count: (o.print_count || 0) + 1 } : o))
  }

  // The ← button (S754). It called backToFloor directly, which empties the cart — so lines tapped
  // in and never sent were thrown away by the one control a waiter presses to check another table.
  // Asks only when something would actually be lost; an untouched order goes straight back.
  function requestBackToFloor() {
    const n = unsavedChangeCount(orderItems)
    if (n === 0) { backToFloor(); return }
    askConfirm({
      title: `Discard ${n} unsaved item${n === 1 ? '' : 's'}?`,
      confirmLabel: 'Discard changes', danger: true,
      cancelLabel: 'Keep editing',
      // Inside the order screen's own stacking context (position: fixed at 1000).
      zIndex: 1200,
      body: (
        <p style={{ margin: 0 }}>
          {n === 1 ? 'One line on this order has' : `${n} lines on this order have`} changed since it was last saved.
          Going back now drops {n === 1 ? 'that change' : 'those changes'} — nothing reaches the kitchen, the bar or the bill.
          Press <strong>{orderId ? 'Update Order' : 'Send Order'}</strong> first to keep {n === 1 ? 'it' : 'them'}.
        </p>
      ),
      run: () => backToFloor(),
    })
  }

  function clearAllOccupiedTables() {
    if (!isAdmin || !clientId) return
    // The most destructive action on the floor, and it is reached mid-service; the ask names what
    // goes rather than fitting into an OS box (S682; was window.confirm).
    const occupied = tables.filter(t => t.status === 'occupied').length
    askConfirm({
      title: 'Clear every occupied table?',
      confirmLabel: 'Delete Open Orders', danger: true, busyLabel: 'Clearing…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            Every open order for this client is <strong>permanently deleted</strong> along with its items —
            {occupied > 0 ? ` ${occupied} table${occupied === 1 ? '' : 's'} currently occupied` : ' no tables are occupied right now'}.
            Nothing is billed, so no revenue, KOT or stock movement is recorded for what those orders held.
          </p>
          <p style={{ margin: 0 }}>This is a testing tool. If a single table is stuck, open it and void the order instead.</p>
        </>
      ),
      run: () => clearAllOccupiedTablesNow(),
    })
  }

  async function clearAllOccupiedTablesNow() {
    setFloorLoad(true)
    const { data: openOrders, error: openErr } = await scopedFrom('pos_orders', 'id').eq('status', 'open')
    // A dropped error gave ids = [], skipped both deletes, and then still flipped every occupied
    // table to 'available' — freeing the floor while every open order survived underneath it.
    if (openErr) {
      window.alert(`Couldn't read the open orders: ${openErr.message}\n\nNothing was cleared — the tables were left as they are rather than freed with their orders still open.`)
      setFloorLoad(false)
      return
    }
    const ids = (openOrders || []).map(o => o.id)
    if (ids.length > 0) {
      // The guard above protects the READ; these are the writes it was protecting, and they had
      // the identical hole one layer down — a failed delete followed by a successful table
      // release frees the whole floor with every open order still sitting underneath it.
      const { error: delItemsErr } = await scopedDelete('pos_order_items').in('order_id', ids)
      const { error: delOrdersErr } = delItemsErr ? { error: null }
        : await scopedDelete('pos_orders').in('id', ids)
      if (delItemsErr || delOrdersErr) {
        window.alert(`Couldn't delete the open orders: ${(delItemsErr || delOrdersErr).message}

The tables were left occupied rather than freed with their orders still open.`)
        setFloorLoad(false)
        await loadFloor()
        return
      }
    }
    const { error: freeErr } = await scopedUpdate('pos_tables', { status: 'available' }).eq('status', 'occupied')
    if (freeErr) window.alert(`The orders were deleted, but the tables could not be freed: ${freeErr.message}`)
    await loadFloor()
  }

  function backToFloor() {
    setView('floor'); setActiveTable(null); setOrderId(null); setOrderNo(null); setOrderItems([]); markCartSaved([]); setMsg('')
    setSuggestions([])
    setMenuLoaded(false)
    setMenuLoadError('')
    // A seat abandoned before the first save must not leak onto the next table opened.
    seatReservationRef.current = null
    // Same for a conflict recovery abandoned before its save (S754): the conflict stays listed.
    conflictRecoveryRef.current = null
    // liveRedemptionRef is deliberately NOT cleared — it names its own order (see its declaration).
    itemsVersionRef.current = null
    setStaleRecovery(null)
    // Any guest request Accepted-locally-but-not-yet-saved is abandoned along with orderItems
    // above — it was never written to the DB (see performSave), so it's still genuinely
    // 'pending' there. Clear the local flag and re-poll to bring it back into the banner/badge
    // instead of leaving it permanently hidden.
    if (pendingAcceptedGuestReqIds.size > 0) {
      setPendingAcceptedGuestReqIds(new Set())
      loadPendingGuestOrders()
    }
  }

  const kotCount = orderItems.filter(i => !i.sent_to_kot && !botCategories.has(i.category || 'Other')).length
  const botCount = orderItems.filter(i => !i.sent_to_kot && botCategories.has(i.category || 'Other')).length

  const pendingTables    = Object.values(tableOrders).filter(o => o.pending > 0)
  const pendingTableCount = pendingTables.length
  const pendingItemCount  = pendingTables.reduce((s, o) => s + o.pending, 0)

  const sections  = ['All', ...Array.from(new Set(tables.map(t => t.section).filter(Boolean)))]
  const visTables = secFilter === 'All' ? tables : tables.filter(t => t.section === secFilter)
  const menuCats  = ['All', ...Array.from(new Set(menu.map(r => r.category))).sort()]
  const menuQuery = menuSearch.trim().toLowerCase()
  const visMenu   = (catTab === 'All' ? menu : menu.filter(r => r.category === catTab))
    // Match on name OR Product Code so staff can ring an item by its code (e.g. "MOM-03").
    .filter(r => r.name.toLowerCase().includes(menuQuery) || (r.recipe_code || '').toLowerCase().includes(menuQuery))

  // Recent Bills' number search (S754). A day's bills — cheap to filter per keystroke.
  const recentBillsQuery = recentBillsSearch.trim().replace(/^#/, '').toLowerCase()
  const visibleRecentBills = !recentBillsQuery ? recentBills : recentBills.filter(o =>
    String(o.invoice_no ?? '').toLowerCase().includes(recentBillsQuery) || String(o.order_no ?? '').toLowerCase().includes(recentBillsQuery))

  // The billing modal's preview pane, built once and placed by layout: beside the form on a wide
  // screen, inside the form's scroller behind "Show bill" on a narrow one (S754). Every property
  // that differs between the two is chosen here in full — no half-overridden inline style.
  const billPreviewPane = !billingOpen ? null : (
    <div style={narrowBilling
      ? { background: 'var(--theme-sidebar)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '12px', marginBottom: 16 }
      : { width: 418, flexShrink: 0, background: 'var(--theme-sidebar)', borderRight: '1px solid var(--theme-border)', padding: '24px 20px', overflowY: 'auto' }}>
      <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 10px' }}>
        {billingTab === 'writeoff' ? 'Complimentary slip preview' : 'Bill preview'} <Tip text="Live preview built from the same layout that actually prints — updates as you fill in the fields. The invoice/NC number shown here is a placeholder; the real one is assigned when you confirm.">(live)</Tip>
      </p>
      {previewSrc ? (
        <iframe
          title="bill-preview"
          srcDoc={previewSrc}
          scrolling="no"
          style={{ width: narrowBilling ? '100%' : 378, maxWidth: 378, height: 820, border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', background: '#fff', display: 'block', overflow: 'hidden' }}
        />
      ) : billingTab === 'void' && (
        <p style={{ fontSize: 12, color: 'var(--theme-text3)', fontStyle: 'italic', margin: 0 }}>
          No document prints for a Void — the order is treated as if it never happened.
        </p>
      )}
    </div>
  )

  /* ══════════════════════════════════════════ ORDER SCREEN */

  if (view === 'order') return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'var(--theme-bg)',
      display: 'flex', flexDirection: 'column',
    }}>

      {/* ── Top bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 16px', height: 52, flexShrink: 0,
        background: 'var(--theme-card)', borderBottom: '1px solid var(--theme-border)',
      }}>
        <button onClick={requestBackToFloor} style={{
          background: 'none', border: '1px solid var(--theme-border)',
          borderRadius: 'var(--radius-sm)', padding: '6px 14px',
          color: 'var(--theme-text2)', cursor: 'pointer', fontSize: 14,
        }}>
          ← {activeTable ? activeTable.name : 'Takeaway'}
        </button>

        {activeTable?.section && (
          <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{activeTable.section}</span>
        )}

        {orderNo && (
          <Tip text="Order number — printed on every KOT/BOT ticket so the kitchen, bar and bill all reference the same order">
            <span style={{
              fontSize: 12, fontWeight: 700, color: 'var(--theme-accent-ink)',
              border: '1px solid var(--theme-accent)', borderRadius: 'var(--radius-sm)',
              padding: '2px 7px', cursor: 'default',
            }}>#{orderNo}</span>
          </Tip>
        )}

        {!orderNo && orderId && (
          <Tip text="This order was saved offline — it will get a real order number once this device reconnects and syncs">
            <span style={{
              fontSize: 12, fontWeight: 700, color: 'var(--theme-amber-text)',
              border: '1px solid var(--theme-amber)', borderRadius: 'var(--radius-sm)',
              padding: '2px 7px', cursor: 'default',
            }}>#— (pending)</span>
          </Tip>
        )}

        {!isOnline && (
          <Tip text="Offline — this order is saved on this device and will sync when you reconnect">
            <span style={{
              fontSize: 12, fontWeight: 700, color: 'var(--theme-amber-text)',
              background: 'color-mix(in srgb, var(--theme-amber) 12%, transparent)', borderRadius: 'var(--radius-sm)',
              padding: '2px 7px', cursor: 'default',
            }}>📵 Offline</span>
          </Tip>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 8 }}>
          <Tip text="Number of guests at this table — used for cover count reporting">
            <span style={{ fontSize: 12, color: 'var(--theme-text3)', cursor: 'default' }}>Covers</span>
          </Tip>
          <button onClick={() => setCovers(c => Math.max(1, c - 1))} style={btnSm} aria-label="One fewer cover">−</button>
          <span style={{ fontWeight: 700, color: 'var(--theme-text1)', minWidth: 22, textAlign: 'center', fontSize: 14 }}>{covers}</span>
          <button onClick={() => setCovers(c => c + 1)} style={btnSm} aria-label="One more cover">+</button>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {msg && (
            <span role="alert" style={{ fontSize: 12, color: msg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
              {msg.replace(/^(error|ok):/, '')}
            </span>
          )}
          {orderId && isOnline && orderKotTickets.some(t => t.status === 'ready') && (() => {
            const readyCount = orderKotTickets.filter(t => t.status === 'ready').length
            return (
              <Tip text="The kitchen or bar has marked food for this order Ready. Tap once it is at the table — the ticket leaves the Kitchen Display and the floor stops showing food waiting. Only Ready tickets are marked; anything still cooking is left alone.">
                <button type="button" className="btn btn-primary btn-sm" onClick={markOrderServed} disabled={servingTickets}>
                  {servingTickets ? 'Marking…' : `✓ Served${readyCount > 1 ? ` (${readyCount} ready)` : ''}`}
                </button>
              </Tip>
            )
          })()}
          {orderId && (
            <Tip text={isOnline
              ? "Prints the last kitchen and/or bar ticket again, marked REPRINT — for a ticket that was sent but never came out of the printer. It does not send anything to the kitchen again."
              : 'Reprinting reads the ticket history from the server — reconnect first.'}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={reprintLastTickets} disabled={!isOnline || saving}>
                ⎙ Reprint KOT/BOT
              </button>
            </Tip>
          )}
        </div>
      </div>

      {activeTable && (pendingGuestOrders[activeTable.id]?.length > 0) && (
        <div style={{
          flexShrink: 0, padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8,
          background: 'color-mix(in srgb, var(--theme-accent) 10%, transparent)', borderBottom: '1px solid var(--theme-border)',
        }}>
          {pendingGuestOrders[activeTable.id].map(req => (
            <div key={req.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>
                🔔 Guest ordered: {(req.items || []).map(it => `${it.qty}× ${it.name}`).join(', ')}
                {req.guest_notes && <span style={{ color: 'var(--theme-text3)' }}> — "{req.guest_notes}"</span>}
              </span>
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                <button className="btn btn-primary" style={{ fontSize: 12, padding: '4px 12px' }}
                  disabled={decidingGuestReqIds.has(req.id)}
                  onClick={() => decideGuestOrder(req, 'accepted')}>Accept</button>
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 12px' }}
                  disabled={decidingGuestReqIds.has(req.id)}
                  onClick={() => decideGuestOrder(req, 'dismissed')}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Two-panel body ── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* LEFT: Menu browser */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--theme-border)', minWidth: 0,
        }}>
          <div style={{
            flexShrink: 0, padding: '8px 12px',
            borderBottom: '1px solid var(--theme-border)',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', scrollbarWidth: 'none' }}>
              {menuCats.map(c => (
                <button key={c} className={`tab-btn${catTab === c ? ' tab-btn--active' : ''}`}
                  onClick={() => setCatTab(c)} style={{ flexShrink: 0 }}>{c}</button>
              ))}
            </div>
            <input
              type="text"
              aria-label="Search menu by name or code"
              placeholder="🔍 Search name or code…"
              value={menuSearch}
              onChange={e => setMenuSearch(e.target.value)}
              style={{
                marginLeft: 'auto', flexShrink: 0, width: 160,
                background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
                borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 12,
                color: 'var(--theme-text1)', outline: 'none',
              }}
            />
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {menuLoadError && (
              <p role="alert" style={{ color: 'var(--theme-red-text)', margin: '0 0 12px', fontSize: 13 }}>
                Couldn't load the menu — {menuLoadError}.{menu.length > 0 ? ' Showing the last menu loaded.' : ' This is a failed read, not an empty menu.'}{' '}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadMenu()}>Retry</button>
              </p>
            )}
            {!menuLoaded && !(menuLoadError && menu.length > 0) ? (
              menuLoadError ? null : <p style={{ color: 'var(--theme-text3)', margin: 0 }}>Loading menu…</p>
            ) : visMenu.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', margin: 0 }}>
                {menu.length === 0
                  ? 'No POS-enabled items. Toggle items On POS in Menu Pricing first.'
                  : menuSearch.trim()
                    ? `No items match "${menuSearch.trim()}".`
                    : 'No items in this category.'}
              </p>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                gap: 10,
              }}>
                {visMenu.map(r => {
                  const vat   = vatReg ? vatOf(r) : 0
                  const price = Math.round((parseFloat(r.selling_price) || 0) * (1 + vat))
                  const inOrd = orderItems.find(i => i.recipe_id === r.id)
                  const kotTimer = inOrd?.sent_to_kot ? kotTimerLabel(ticketForRecipe(r.id), kotNow) : null
                  return (
                    <button key={r.id} onClick={() => addItem(r)} style={{
                      background: inOrd
                        ? 'color-mix(in srgb, var(--theme-accent) 12%, var(--theme-card))'
                        : 'var(--theme-card)',
                      border: `1px solid ${inOrd ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                      borderRadius: 'var(--radius-md)', padding: '12px 10px',
                      cursor: 'pointer', textAlign: 'left',
                      display: 'flex', flexDirection: 'column', gap: 6,
                      position: 'relative', transition: 'border-color 0.12s',
                    }}>
                      {inOrd && (
                        <span style={{
                          position: 'absolute', top: 6, right: 8,
                          background: 'var(--theme-accent)', color: 'var(--theme-accent-text)',
                          borderRadius: 'var(--radius-full)', fontSize: 11, fontWeight: 700, padding: '1px 7px',
                        }}>{inOrd.qty}</span>
                      )}
                      <span style={{
                        fontWeight: 600, fontSize: 13, color: 'var(--theme-text1)',
                        lineHeight: 1.3, paddingRight: inOrd ? 28 : 0,
                      }}>{r.name}</span>
                      <span style={{ fontSize: 12, color: 'var(--theme-accent-ink)', fontWeight: 600 }}>
                        NPR {price}
                      </span>
                      {kotTimer && (
                        <span style={{ fontSize: 10, fontWeight: 600, color: kotTimer.color }}>
                          {kotTimer.text}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: Order panel */}
        <div style={{
          width: 320, flexShrink: 0,
          display: 'flex', flexDirection: 'column',
          background: 'var(--theme-card)',
        }}>

          {/* Order items list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 14px' }}>
            {orderItems.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13, textAlign: 'center', paddingTop: 48, margin: 0 }}>
                Tap items on the left to add them
              </p>
            ) : orderItems.map((item, idx) => {
              const lineTotal = item.qty * item.unit_price * (1 + (vatReg ? (item.vat_rate ?? 0) : 0))
              const kotTimer = item.sent_to_kot ? kotTimerLabel(ticketForRecipe(item.recipe_id), kotNow) : null
              return (
                <div key={idx} style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  borderBottom: '1px solid var(--theme-border)', padding: '9px 0',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, color: 'var(--theme-text1)', lineHeight: 1.3 }}>
                        {item.name}
                      </span>
                      {item.sent_to_kot && (
                        <Tip text="Ticket already sent to the station — press KOT/BOT again only if you add more of this item">
                          <span style={{
                            fontSize: 9, fontWeight: 700, flexShrink: 0,
                            background: 'color-mix(in srgb, var(--theme-accent) 18%, transparent)',
                            color: 'var(--theme-accent-ink)',
                            borderRadius: 0, padding: '1px 5px', cursor: 'default',
                          }}>
                            ✓ {botCategories.has(item.category || 'Other') ? 'BOT' : 'KOT'}
                          </span>
                        </Tip>
                      )}
                      {kotTimer && (
                        <Tip text="Live kitchen/bar status for this item's ticket — Sent (not yet started) / a countdown once Started, using the kitchen's own estimate / Ready once done">
                          <span style={{ fontSize: 9, fontWeight: 600, flexShrink: 0, color: kotTimer.color }}>
                            {kotTimer.text}
                          </span>
                        </Tip>
                      )}
                      {!item.sent_to_kot && (item.sent_qty || 0) > 0 && item.qty > item.sent_qty && (
                        <Tip text={`${item.qty - item.sent_qty} extra added since last ticket — press KOT or BOT to send the addition to the station`}>
                          <span style={{
                            fontSize: 9, fontWeight: 700, flexShrink: 0,
                            background: 'var(--theme-amber)', color: amberBadgeText,
                            borderRadius: 0, padding: '1px 5px', cursor: 'default',
                          }}>
                            +{item.qty - item.sent_qty}
                          </span>
                        </Tip>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                    <button onClick={() => setQty(idx, item.qty - 1)} style={btnSm} aria-label={`One fewer ${item.name}`}>−</button>
                    <span style={{ minWidth: 22, textAlign: 'center', fontWeight: 700, color: 'var(--theme-text1)', fontSize: 13 }}>
                      {item.qty}
                    </span>
                    <button onClick={() => setQty(idx, item.qty + 1)} style={btnSm} aria-label={`One more ${item.name}`}>+</button>
                  </div>
                  <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600, minWidth: 68, textAlign: 'right', flexShrink: 0 }}>
                    NPR {Math.round(lineTotal)}
                  </span>
                  <button
                    onClick={() => setQty(idx, 0)}
                    title="Remove"
                    style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: 1, flexShrink: 0 }}
                  >×</button>
                  </div>
                  <input
                    type="text"
                    aria-label={`Note for ${item.name}`}
                    value={item.notes || ''}
                    onChange={e => updateItemNote(idx, e.target.value)}
                    onFocus={() => setNoteFocusIdx(idx)}
                    onBlur={() => setNoteFocusIdx(null)}
                    placeholder="+ Add note (e.g. no onion)"
                    style={{
                      background: 'none', border: 'none', outline: 'none',
                      fontSize: 11, fontStyle: 'italic', color: 'var(--theme-text3)',
                      padding: '0 0 0 2px', width: '100%',
                    }}
                  />
                  {noteFocusIdx === idx && notePresets.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 0 0 2px' }}>
                      {notePresets.map(p => (
                        <button
                          key={p}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => addPresetToNote(idx, p)}
                          style={{
                            fontSize: 10, padding: '2px 8px', borderRadius: 'var(--radius-full)',
                            border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)',
                            color: 'var(--theme-text2)', cursor: 'pointer',
                          }}
                        >{p}</button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── ME suggestion chips ── */}
          {suggestions.length > 0 && (
            <div style={{
              borderTop: '1px solid var(--theme-border)', flexShrink: 0,
              padding: '8px 14px',
              background: 'color-mix(in srgb, var(--theme-accent) 5%, var(--theme-card))',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-text3)' }}>Pair with</span>
                <button
                  onClick={() => setSuggestions([])}
                  style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, padding: 0, marginLeft: 'auto', lineHeight: 1 }}
                >✕</button>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {suggestions.map(r => {
                  const price        = Math.round((parseFloat(r.selling_price) || 0) * (1 + (vatReg ? vatOf(r) : 0)))
                  const isChefsPick  = allowMeFilter && r.me_class === 'puzzle' && !r._manual
                  return (
                    <button
                      key={r.id}
                      onClick={() => addItem(r)}
                      style={{
                        background: 'var(--theme-card)',
                        // A Chef's pick is a CATEGORY (menu-engineering "puzzle"), not a verdict, so it
                        // takes brass at half strength — never amber, which on this same screen already
                        // means "unfired lines" and "a guest order waiting" (One Signal Meaning Rule).
                        border: `1px solid ${r._manual ? 'var(--theme-accent)' : isChefsPick ? 'color-mix(in srgb, var(--theme-accent) 55%, transparent)' : 'var(--theme-border)'}`,
                        borderRadius: 'var(--radius-md)', padding: '5px 10px', fontSize: 12, cursor: 'pointer',
                        color: 'var(--theme-text1)', display: 'flex', flexDirection: 'column', gap: 1, textAlign: 'left',
                      }}
                    >
                      {r._manual && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--theme-accent-ink)', letterSpacing: 0.5 }}>PAIRED</span>
                      )}
                      {isChefsPick && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--theme-amber-text)', letterSpacing: 0.5 }}>CHEF'S PICK</span>
                      )}
                      <span>{r.name}</span>
                      <span style={{ fontSize: 10, color: 'var(--theme-accent-ink)' }}>+NPR {price}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Totals + action buttons */}
          <div style={{ borderTop: '2px solid var(--theme-border)', padding: '12px 14px', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--theme-text2)', marginBottom: 4 }}>
              <span>Subtotal (ex-VAT)</span><span>{fmtNpr(subEx)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--theme-text2)', marginBottom: 10 }}>
              <span>VAT</span><span>{fmtNpr(vatAmt)}</span>
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)',
              paddingTop: 10, borderTop: '1px solid var(--theme-border)', marginBottom: 14,
            }}>
              <span>TOTAL</span>
              <span style={{ color: 'var(--theme-accent-ink)' }}>{fmtNpr(total)}</span>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button
                className="btn btn-primary"
                style={{ flex: 1, minWidth: 0, padding: '12px 0', fontSize: 16, justifyContent: 'center', display: 'flex' }}
                onClick={saveOrder}
                disabled={saving || orderItems.length === 0}
              >
                {saving ? 'Sending…' : orderId ? 'Update Order' : 'Send Order'}
              </button>

              {hasPosAccess('supervisor') && (() => {
                const payDisabled = saving || !orderId || !isOnline
                return (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Tip text={!isOnline
                      ? 'Reconnect to close this bill — billing needs a live connection for the sequential invoice number and stock/sales posting.'
                      : 'Close this table — collect payment, or void/write-off if unpaid. Order must be saved first. Supervisor role or above.'}
                    style={{ display: 'inline-block', width: '100%', borderBottom: 'none' }}>
                    <button
                      className="btn"
                      style={{
                        width: '100%', padding: '12px 0', fontSize: 16, justifyContent: 'center', display: 'flex',
                        background: 'var(--theme-accent)', color: 'var(--theme-accent-text)', fontWeight: 700, border: 'none',
                        // Same disabled treatment as the KOT/BOT ticket-btn class (opacity 0.5) — this
                        // button uses inline styles instead of that class, so it needs its own dimming.
                        opacity: payDisabled ? 0.5 : 1,
                        cursor: payDisabled ? 'default' : 'pointer',
                      }}
                      onClick={openBilling}
                      disabled={payDisabled}>
                      Payment
                    </button>
                  </Tip>
                </div>
                )
              })()}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Tip text="Kitchen Order Ticket — sends unsent food items to the kitchen printer. Bold + badge show how many items are waiting."
                  style={{ display: 'inline-block', width: '100%', borderBottom: 'none' }}>
                  <button
                    className={`ticket-btn${kotCount > 0 ? ' ticket-btn--pending' : ''}`}
                    style={{ width: '100%', padding: '12px 0', fontSize: 16 }}
                    onClick={() => sendTicket('KOT')}
                    disabled={saving || kotCount === 0}
                  >
                    KOT
                    {kotCount > 0 && (
                      <span style={{
                        position: 'absolute', top: -6, right: -4,
                        background: 'var(--theme-amber)', color: amberBadgeText,
                        borderRadius: 'var(--radius-full)', fontSize: 10, fontWeight: 700,
                        padding: '1px 5px', lineHeight: 1.4, pointerEvents: 'none',
                      }}>{kotCount}</span>
                    )}
                  </button>
                </Tip>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Tip text="Bar Order Ticket — sends unsent bar/beverage items to the bar printer. Bold + badge show how many items are waiting."
                  style={{ display: 'inline-block', width: '100%', borderBottom: 'none' }}>
                  <button
                    className={`ticket-btn${botCount > 0 ? ' ticket-btn--pending' : ''}`}
                    style={{ width: '100%', padding: '12px 0', fontSize: 16 }}
                    onClick={() => sendTicket('BOT')}
                    disabled={saving || botCount === 0}
                  >
                    BOT
                    {botCount > 0 && (
                      <span style={{
                        position: 'absolute', top: -6, right: -4,
                        background: 'var(--theme-amber)', color: amberBadgeText,
                        borderRadius: 'var(--radius-full)', fontSize: 10, fontWeight: 700,
                        padding: '1px 5px', lineHeight: 1.4, pointerEvents: 'none',
                      }}>{botCount}</span>
                    )}
                  </button>
                </Tip>
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* ── Billing modal ── */}
      {billingOpen && (
        <Modal
          title={billingTab === 'writeoff' ? 'Complimentary slip' : billingTab === 'void' ? 'Void this bill' : 'Take payment'}
          onClose={requestCloseBilling}
          zIndex={1100}
          unstyled
          panelStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-lg)', width: 'min(1060px, 96vw)', maxHeight: '92vh', boxShadow: '0 16px 48px rgba(0,0,0,0.4)', display: 'flex', overflow: 'hidden' }}
        >
          {/* The preview pane. Beside the form on a wide screen; on a narrow one (S754) it moves
              INSIDE the form's scroller behind a "Show bill" toggle, because a fixed 418px column
              left a phone or portrait tablet a payment form squeezed to nothing. Every property
              that differs between the two is chosen here in full — no half-overridden inline style. */}
          {!narrowBilling && billPreviewPane}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: narrowBilling ? '16px 16px' : '24px 28px' }}>
            {narrowBilling && (
              <>
                <button type="button" className="btn btn-ghost btn-sm" aria-expanded={billPreviewOpen}
                  onClick={() => setBillPreviewOpen(v => !v)} style={{ marginBottom: 12 }}>
                  {billPreviewOpen ? '▾ Hide bill' : '▸ Show bill'}
                </button>
                {billPreviewOpen && billPreviewPane}
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 18, color: 'var(--theme-text1)' }}>
                {activeTable ? activeTable.name : 'Takeaway'}
              </h3>
              <p style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--theme-accent-ink)', textAlign: 'right' }}>
                {fmtNpr(billingTab === 'writeoff' ? compTotal : billingTab === 'pay' ? payTotal : total)}
                {billingTab === 'writeoff' && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginLeft: 8 }}>(food cost, not menu price)</span>}
                {billingTab === 'pay' && discountAmt > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginLeft: 8 }}>
                    ({fmtNpr(total)} − {fmtNpr(discountAmt)} discount)
                  </span>
                )}
              </p>
            </div>

            {(kotCount + botCount) > 0 && (
              <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-amber-text)', background: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                ⚠ {kotCount + botCount} item{kotCount + botCount !== 1 ? 's' : ''} not yet sent to the kitchen/bar.
              </p>
            )}

            <div className="tab-bar" style={{ marginBottom: 16 }}>
              <button className={`tab-btn${billingTab === 'pay' ? ' tab-btn--active' : ''}`} onClick={() => { setBillingTab('pay'); setCloseMsg('') }}>Pay</button>
              {(isAdmin || isOwner || profile?.pos_allow_void) && (
                <button className={`tab-btn${billingTab === 'void' ? ' tab-btn--active' : ''}`} onClick={() => { setBillingTab('void'); setCloseMsg('') }}>Void</button>
              )}
              {hasPosAccess('supervisor') && (
                <button className={`tab-btn${billingTab === 'writeoff' ? ' tab-btn--active' : ''}`} onClick={openCompTab}>Complimentary</button>
              )}
            </div>

            {billingTab === 'pay' && (
              <div style={{ marginBottom: 16 }}>
                {requireBuyerId ? (
                  <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                    Buyer details <span style={{ color: 'var(--theme-red-text)', textTransform: 'none', letterSpacing: 'normal' }}>
                      <Tip text="Name and Phone are required whenever a discount is applied or the bill goes on Credit, so there's an identifiable record.">
                        {payMethod === 'Credit' ? '(Name + Phone required for Credit)' : '(Name + Phone required for this discount)'}
                      </Tip>
                    </span>
                  </p>
                ) : (
                  // Collapsed by default — same disclosure treatment as Items below. Buyer details
                  // are only mandatory for a discount/Credit bill; a plain Cash sale doesn't need 4
                  // fields surfaced before the payment-method choice a cashier actually taps every time.
                  <button type="button" onClick={() => setBuyerExpanded(v => !v)} style={{
                    display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none',
                    padding: 0, marginBottom: buyerExpanded ? 8 : 0, cursor: 'pointer', textAlign: 'left',
                  }}>
                    <span style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                      {buyerExpanded ? '▾' : '▸'} Buyer details <Tip text="Optional for transactions ≤ NPR 10,000 (IRD abbreviated-invoice exemption). Fill in if the customer requests a full invoice with their own PAN.">(optional)</Tip>
                    </span>
                  </button>
                )}
                {(requireBuyerId || buyerExpanded) && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                      {/* Placeholder text is not a label (it vanishes on the first keystroke), and a
                          red border is reinforcement, not the message — so each field carries its
                          name and the two mandatory ones carry aria-invalid (S682). */}
                      <input placeholder="Name" aria-label="Buyer name" aria-invalid={requireBuyerId && !buyerName.trim() ? true : undefined} value={buyerName} onChange={e => setBuyerName(e.target.value)}
                        style={{ ...billInput, borderColor: requireBuyerId && !buyerName.trim() ? 'var(--theme-red)' : 'var(--theme-border)' }} />
                      <input placeholder="PAN No." aria-label="Buyer PAN number" value={buyerPan} onChange={e => setBuyerPan(e.target.value)} style={billInput} />
                      <input placeholder="Address" aria-label="Buyer address" value={buyerAddress} onChange={e => setBuyerAddress(e.target.value)} style={billInput} />
                      <input placeholder="Phone" aria-label="Buyer phone" aria-invalid={requireBuyerId && !buyerPhone.trim() ? true : undefined} value={buyerPhone} onChange={e => setBuyerPhone(e.target.value)}
                        style={{ ...billInput, borderColor: requireBuyerId && !buyerPhone.trim() ? 'var(--theme-red)' : 'var(--theme-border)' }} />
                    </div>
                    <input placeholder="Remarks" aria-label="Bill remarks" value={billRemarks} onChange={e => setBillRemarks(e.target.value)} style={{ ...billInput, width: '100%' }} />
                  </>
                )}
              </div>
            )}

            {/* Loyalty redemption. Rendered inside the ORDER-screen return, beside the item-comp
                panel — PosOrders has two returns and a control placed in the floor tree sets state
                that nothing renders (S578).

                Deliberately NOT gated on Supervisor rank, unlike comp above it: comping is
                discretionary and giving away stock, whereas redeeming is a customer spending
                something they already own. The real control is server-side — redeem_loyalty_points
                re-checks the balance and will refuse. */}
            {billingTab === 'pay' && hasFeature('loyalty') && (loyaltyBalance !== null || loyaltyLookupMsg) && (() => {
              const applied = tenders.find(t => t.method === 'Loyalty')
              const cap = maxRedeemablePoints(loyaltyBalance, redeemableTotal, loyaltyPointValue)
              return (
                <div style={{
                  marginBottom: 16, padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                  background: 'color-mix(in srgb, var(--theme-purple) 7%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--theme-purple) 25%, transparent)',
                }}>
                  {loyaltyLookupMsg ? (
                    <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--theme-amber-text)' }}>{loyaltyLookupMsg}</p>
                  ) : (<>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                        <Tip text="Points this customer has earned on past bills. Redeeming settles part of this bill like a gift card — it is not a discount, so the VAT on the bill does not change." width={300}>Loyalty points</Tip>
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-purple-text)' }}>
                        {loyaltyBalance} pt{loyaltyBalance === 1 ? '' : 's'} · {fmtNpr(pointsValue(loyaltyBalance, loyaltyPointValue))}
                      </span>
                    </div>
                    {applied ? (
                      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--theme-purple-text)' }}>
                        {applied.points} pt{applied.points === 1 ? '' : 's'} applied ({fmtNpr(applied.amount)}) — undo it in the tender list below to change it.
                      </p>
                    ) : cap > 0 ? (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
                        <input
                          type="number" min="1" max={cap} value={redeemStr}
                          onChange={e => setRedeemStr(e.target.value)}
                          className="form-input form-input--auto" style={{ width: 110 }}
                          placeholder={`max ${cap}`}
                          aria-label="Points to redeem"
                        />
                        <button className="btn btn-ghost btn-sm" onClick={applyRedemption}
                          disabled={!(Math.floor(Number(redeemStr) || 0) > 0 && Math.floor(Number(redeemStr) || 0) <= cap)}>
                          Apply
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setRedeemStr(String(cap))}>Use max</button>
                      </div>
                    ) : (
                      <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--theme-text3)' }}>
                        {loyaltyBalance > 0 ? 'Not enough to cover any of this bill yet.' : 'No points yet — this bill will earn some.'}
                      </p>
                    )}
                  </>)}
                </div>
              )
            })()}

            {billingTab === 'pay' && hasPosAccess('supervisor') && orderItems.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                {/* Collapsed by default — a comp checkbox on every item, visible on every single
                    payment, reads as a standing suggestion to comp something. Folding it behind a
                    deliberate tap keeps it available without pushing it in front of every cashier
                    on every bill. */}
                <button type="button" onClick={() => setItemsExpanded(v => !v)} style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%', background: 'none', border: 'none',
                  padding: 0, marginBottom: itemsExpanded ? 8 : 0, cursor: 'pointer', textAlign: 'left',
                }}>
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    {itemsExpanded ? '▾' : '▸'} Items <Tip text="Comp an individual item — including just part of its quantity, e.g. 1 of 3 — it's removed from this bill and printed on its own internal Complimentary Slip instead, while the rest of the table (and the rest of that line's qty, if any) bills normally. Supervisor+ only.">(tap to comp)</Tip>
                  </span>
                  {hasItemComp && (
                    <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', fontWeight: 600 }}>
                      · {itemCompCount} comped
                    </span>
                  )}
                </button>
                {allItemsComped && (
                  <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--theme-amber-text)', background: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                    ⚠ Every item is comped — nothing left to bill. Switch to the Complimentary tab to close this table instead of issuing a ₨0 Tax Invoice/PAN Bill.
                  </p>
                )}
                {itemsExpanded && (
                <>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: hasItemComp ? 10 : 0 }}>
                  {orderItems.map(i => {
                    const compQty = Math.min(compQtyByRecipe[i.recipe_id] || 0, i.qty)
                    const comped = compQty > 0
                    const setQty = next => setCompQtyByRecipe(prev => ({ ...prev, [i.recipe_id]: Math.max(0, Math.min(i.qty, next)) }))
                    return (
                      <div key={i.recipe_id} style={{
                        display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '5px 8px', borderRadius: 'var(--radius-sm)',
                        background: comped ? 'var(--theme-input-bg)' : 'transparent',
                        color: comped ? 'var(--theme-amber-text)' : 'var(--theme-text2)',
                        fontWeight: comped ? 600 : 400,
                      }}>
                        <span style={{ flex: 1 }}>{i.qty} x {i.name}</span>
                        <span>{fmtNpr(i.qty * i.unit_price)}</span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <button type="button" onClick={() => setQty(compQty - 1)} disabled={compQty <= 0 || tendersLocked}
                            aria-label={`Comp one fewer ${i.name}`}
                            title={tendersLocked ? tendersLockHint : undefined}
                            style={{ width: 20, height: 20, lineHeight: '18px', padding: 0, borderRadius: 0, border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)', color: 'var(--theme-text2)', cursor: compQty <= 0 || tendersLocked ? 'not-allowed' : 'pointer', opacity: compQty <= 0 || tendersLocked ? 0.4 : 1 }}>−</button>
                          <span style={{ minWidth: 14, textAlign: 'center' }}>{compQty}</span>
                          <button type="button" onClick={() => setQty(compQty + 1)} disabled={compQty >= i.qty || tendersLocked}
                            aria-label={`Comp one more ${i.name}`}
                            title={tendersLocked ? tendersLockHint : undefined}
                            style={{ width: 20, height: 20, lineHeight: '18px', padding: 0, borderRadius: 0, border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)', color: 'var(--theme-text2)', cursor: compQty >= i.qty || tendersLocked ? 'not-allowed' : 'pointer', opacity: compQty >= i.qty || tendersLocked ? 0.4 : 1 }}>+</button>
                          <span style={{ fontSize: 10, minWidth: 44 }}>{comped ? `/${i.qty} comped` : 'comped'}</span>
                        </div>
                      </div>
                    )
                  })}
                </div>
                {hasItemComp && (
                  <div>
                    <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 8px' }}>
                      {fmtNpr(itemCompFoodCost)} in food cost across {itemCompCount} comped item{itemCompCount !== 1 ? 's' : ''} — printed on a separate Complimentary Slip, not this bill.
                    </p>
                    <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-orders-comp-reason">Comp Reason</label>
                    <select id="pos-orders-comp-reason" className="form-select" style={{ width: '100%' }} value={itemCompReason} onChange={e => setItemCompReason(e.target.value)}>
                      <option value="">— Select —</option>
                      {COMP_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                )}
                </>
                )}
              </div>
            )}

            {billingTab === 'pay' && (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <Tip text={tenders.length > 0 ? 'Undo all tenders below first to switch back.' : 'Collect this bill with one payment method.'}>
                    <button onClick={() => setSplitMode(false)} disabled={tenders.length > 0}
                      className={`pay-method-btn${!splitMode ? ' pay-method-btn--selected' : ''}`}
                      style={{ opacity: tenders.length > 0 ? 0.5 : 1, cursor: tenders.length > 0 ? 'not-allowed' : 'pointer' }}>
                      Single Payment
                    </button>
                  </Tip>
                  <Tip text="Collect this bill using more than one payment method — e.g. part eSewa, part cash. Not available with Credit.">
                    <button onClick={() => { setSplitMode(true); setPayMethod('Cash'); setTenderMethod('Cash'); setTenderAmtStr(''); setDeliveryPartner('') }}
                      className={`pay-method-btn${splitMode ? ' pay-method-btn--selected' : ''}`}>
                      Split Payment
                    </button>
                  </Tip>
                </div>

                {!splitMode && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                    {PAYMENT_METHODS.map(m => (
                      <button key={m} onClick={() => { setPayMethod(m); setDeliveryPartner('') }}
                        className={`pay-method-btn${payMethod === m ? ' pay-method-btn--selected' : ''}`}>
                        {m}
                      </button>
                    ))}
                    {hasPosAccess('supervisor') && (
                      <Tip text="Bill closes normally (counts as a sale, consumes an invoice number) but no payment is collected now — the customer owes this amount. Supervisor+ only. Collect it later from Customers → Outstanding Credit.">
                        <button onClick={() => setPayMethod('Credit')}
                          className={`pay-method-btn pay-method-btn--credit${payMethod === 'Credit' ? ' pay-method-btn--selected' : ''}`}>
                          Credit
                        </button>
                      </Tip>
                    )}
                  </div>
                )}

                {!splitMode && payMethod === 'Credit' && billingSettings.delivery_partners.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 6px' }}>
                      <Tip text="Optional — delivery-aggregator orders don't pay at the counter, they remit later minus commission, so they close as Credit like any other unpaid balance. This just marks the buyer as the platform so Outstanding Credit and the Delivery Partners report can track it separately; the actual commission is entered when you settle it later, not now." width={300}>Delivery Partner (optional)</Tip>
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {billingSettings.delivery_partners.map(dp => (
                        <button key={dp.name} type="button"
                          onClick={() => { setDeliveryPartner(dp.name); setBuyerName(dp.name); setBuyerPhone(dp.phone || '') }}
                          className={`pay-method-btn${deliveryPartner === dp.name ? ' pay-method-btn--selected' : ''}`}>
                          {dp.name}
                        </button>
                      ))}
                      {deliveryPartner && (
                        <button type="button" onClick={() => { setDeliveryPartner(''); setBuyerName(''); setBuyerPhone('') }}
                          className="pay-method-btn">✕ Clear</button>
                      )}
                    </div>
                  </div>
                )}

                {/* A visual break between the core payment choice above (method/tender — what a
                    cashier taps on every single bill) and the adjustment fields below (discount —
                    only relevant on some bills), so the fast path doesn't visually run together
                    with the exception-handling path. */}
                <div style={{ borderTop: '1px solid var(--theme-border-lt)', paddingTop: 14, marginTop: 2 }}>
                <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                  Discount <Tip text="Reduces the pre-VAT taxable amount — VAT is recalculated on the discounted base, matching standard invoice practice. Leave at 0 for no discount.">(optional)</Tip>
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <button onClick={() => setDiscountMode('amount')} disabled={tendersLocked} style={{
                    padding: '7px 12px', borderRadius: 'var(--radius-sm)', fontSize: 13, cursor: tendersLocked ? 'not-allowed' : 'pointer', opacity: tendersLocked ? 0.5 : 1,
                    fontWeight: discountMode === 'amount' ? 700 : 400,
                    background: discountMode === 'amount' ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                    color: discountMode === 'amount' ? 'var(--theme-accent-text)' : 'var(--theme-text2)',
                    border: `1px solid ${discountMode === 'amount' ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                  }}>₨</button>
                  <button onClick={() => setDiscountMode('percent')} disabled={tendersLocked} style={{
                    padding: '7px 12px', borderRadius: 'var(--radius-sm)', fontSize: 13, cursor: tendersLocked ? 'not-allowed' : 'pointer', opacity: tendersLocked ? 0.5 : 1,
                    fontWeight: discountMode === 'percent' ? 700 : 400,
                    background: discountMode === 'percent' ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                    color: discountMode === 'percent' ? 'var(--theme-accent-text)' : 'var(--theme-text2)',
                    border: `1px solid ${discountMode === 'percent' ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                  }}>%</button>
                  <input type="number" min="0" step="any" max={discountMode === 'percent' ? 100 : undefined}
                    aria-label={discountMode === 'percent' ? 'Discount percent' : 'Discount amount in rupees'}
                    placeholder="0" value={discountStr} onChange={e => setDiscountStr(e.target.value)}
                    disabled={tendersLocked} title={tendersLocked ? tendersLockHint : undefined}
                    style={disabledStyle({ ...billInput, flex: 1 }, tendersLocked)} />
                  {discountMode === 'percent' && discountAmt > 0 && (
                    <span style={{ fontSize: 12, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>≈ {fmtNpr(discountAmt)}</span>
                  )}
                </div>
                {tendersLocked && (
                  <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '2px 0 8px' }}>{tendersLockHint}</p>
                )}
                {discountClamped && (
                  <p style={{ fontSize: 11, color: 'var(--theme-amber-text)', margin: '2px 0 8px' }}>
                    Capped at your {discountCapPct}% discount limit ({fmtNpr(discountAmt)}).
                  </p>
                )}
                {discountAmt > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-orders-discount-reason">Discount Reason</label>
                    <select id="pos-orders-discount-reason" className="form-select" style={{ width: '100%' }} value={discountReason} onChange={e => setDiscountReason(e.target.value)}>
                      <option value="">— Select —</option>
                      {discountReasons.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                )}
                </div>

                {!splitMode ? (
                  <>
                    {payMethod === 'Cash' && (
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-orders-tender">Tender</label>
                          <input id="pos-orders-tender" type="number" min="0" step="any" placeholder={payTotal.toFixed(0)}
                            value={tenderedStr} onChange={e => setTenderedStr(e.target.value)} style={{ ...billInput, width: '100%' }} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <span style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>
                            {cashShortfall > 0 ? 'Short by' : 'Change'}
                          </span>
                          <div role={cashShortfall > 0 ? 'alert' : undefined}
                            style={{ fontSize: 15, fontWeight: 700, color: cashShortfall > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
                            {cashShortfall > 0 ? fmtNpr(cashShortfall) : fmtNpr(Math.max(0, resolveTendered(payTotal) - payTotal))}
                          </div>
                        </div>
                      </div>
                    )}
                    {QR_PAY_METHODS.includes(payMethod) && billQrUrl && (
                      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14, padding: '10px 12px', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)' }}>
                        <img src={billQrUrl} alt="Scan to pay" style={{ width: 110, height: 110, background: '#fff', borderRadius: 'var(--radius-sm)', padding: 4, flexShrink: 0 }} />
                        <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.6 }}>
                          Customer scans to pay <strong>{fmtNpr(payTotal)}</strong> — the amount arrives pre-filled and locked
                          in their app, so it can't be mistyped. Confirm once you see the payment land on your merchant app.
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                        <span style={{ color: 'var(--theme-text2)' }}>Remaining</span>
                        <span style={{ fontWeight: 700, color: remaining > 0 ? 'var(--theme-amber-text)' : 'var(--theme-green-text)' }}>{fmtNpr(remaining)}</span>
                      </div>
                      {tendersOverpaid && (
                        <p role="alert" style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-red-text)' }}>
                          ▲ {fmtNpr(tendersTotal)} recorded against a bill that now comes to {fmtNpr(payTotal)}. Undo the payments below and take them again.
                        </p>
                      )}
                      {tenders.map((t, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '5px 0 0', marginTop: 5, borderTop: '1px solid var(--theme-border-lt)' }}>
                          <span style={{ color: 'var(--theme-text2)' }}>{t.method}</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{fmtNpr(t.amount)}</span>
                            <Tip text="Prints a small courtesy slip for this payment only — not the Tax Invoice/PAN Bill, which still prints once at the end.">
                              <button onClick={() => printHtml(buildTenderSlipHtml({
                                  tender: t, remainingAfter: payTotal - tenders.slice(0, i + 1).reduce((s, x) => s + x.amount, 0),
                                  outletName, tableName: activeTable?.name || 'Takeaway',
                                }))}
                                style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 11, padding: 0 }}>
                                🖨
                              </button>
                            </Tip>
                            {i === tenders.length - 1 && (
                              <button onClick={undoLastTender} style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}>
                                ↩ Undo
                              </button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>

                    {remaining > 0 && (
                      <>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                          {PAYMENT_METHODS.map(m => (
                            <button key={m} onClick={() => setTenderMethod(m)}
                              className={`pay-method-btn${tenderMethod === m ? ' pay-method-btn--selected' : ''}`}>
                              {m}
                            </button>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 6 }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-orders-amount">Amount</label>
                            <input id="pos-orders-amount" type="number" min="0" step="any" placeholder={remaining.toFixed(0)}
                              value={tenderAmtStr} onChange={e => setTenderAmtStr(e.target.value)}
                              onKeyDown={e => e.key === 'Enter' && addTender()} style={{ ...billInput, width: '100%' }} />
                          </div>
                          <button className="btn btn-ghost" onClick={addTender} disabled={!(parseFloat(tenderAmtStr) > 0)}>
                            + Add Tender
                          </button>
                        </div>
                        {tenderMethod === 'Cash' && parseFloat(tenderAmtStr) > remaining && (
                          <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 10px' }}>
                            Change due: <strong>{fmtNpr(parseFloat(tenderAmtStr) - remaining)}</strong>
                          </p>
                        )}
                        {QR_PAY_METHODS.includes(tenderMethod) && billQrUrl && (
                          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14, padding: '10px 12px', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)' }}>
                            <img src={billQrUrl} alt="Scan to pay" style={{ width: 100, height: 100, background: '#fff', borderRadius: 'var(--radius-sm)', padding: 4, flexShrink: 0 }} />
                            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.6 }}>
                              Customer scans to pay <strong>{fmtNpr(parseFloat(tenderAmtStr) || remaining)}</strong> for this portion.
                            </p>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            )}

            {billingTab === 'void' && (
              <>
                <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-orders-reason">Reason</label>
                <select id="pos-orders-reason" className="form-select" style={{ width: '100%', marginBottom: 12 }} value={closeReason} onChange={e => setCloseReason(e.target.value)}>
                  <option value="">— Select —</option>
                  {VOID_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                {orderItems.some(i => i.sent_to_kot) && (
                  <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
                    ⚠ Some items were already sent to the kitchen/bar — consider Complimentary instead so food cost isn't lost.
                  </p>
                )}
              </>
            )}

            {billingTab === 'writeoff' && (
              <>
                <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-orders-reason-2">Reason</label>
                <select id="pos-orders-reason-2" className="form-select" style={{ width: '100%', marginBottom: 12 }} value={closeReason} onChange={e => setCloseReason(e.target.value)}>
                  <option value="">— Select —</option>
                  {COMP_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <input placeholder="Remarks (optional)" aria-label="Complimentary slip remarks" value={billRemarks} onChange={e => setBillRemarks(e.target.value)} style={{ ...billInput, width: '100%', marginBottom: 12 }} />
                <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text3)' }}>
                  ₨0 is collected, but this still counts against food-cost/inventory reporting. Prints an internal
                  Complimentary Slip valued at food cost — not a Tax Invoice or PAN Bill, no outlet name shown.
                </p>
              </>
            )}
          </div>

          {/* Sticky footer — primary action + Cancel always reachable, independent of how tall the
              scrollable content above gets (e.g. a long list of split-payment tenders). */}
          <div style={{ flexShrink: 0, padding: narrowBilling ? '12px 16px 16px' : '14px 28px 20px', borderTop: '1px solid var(--theme-border)' }}>
            {closeMsg && <p role="alert" style={{ margin: '0 0 10px', fontSize: 12, color: closeMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>{closeMsg.replace(/^(error|ok):/, '')}</p>}
            {billingTab === 'pay' && (
              <button className="btn btn-primary" style={{ width: '100%', padding: '11px 0', justifyContent: 'center' }}
                onClick={() => closeOrder('paid')}
                disabled={closing || cashShortfall > 0 || tendersOverpaid || (splitMode && (remaining > 0 || tenders.length === 0)) || (discountAmt > 0 && !discountReason) || (requireBuyerId && (!buyerName.trim() || !buyerPhone.trim())) || (hasItemComp && !itemCompReason) || allItemsComped}>
                {closing ? 'Processing…'
                  : tendersOverpaid ? `Payments exceed the bill by ${fmtNpr(tendersTotal - payTotal)} — undo and re-take`
                  : splitMode ? (remaining > 0 ? `Remaining ${fmtNpr(remaining)}` : `Complete Order — ${fmtNpr(payTotal)}`)
                  : cashShortfall > 0 ? `Short by ${fmtNpr(cashShortfall)} — collect ${fmtNpr(payTotal)}`
                  : `Confirm Payment — ${fmtNpr(payTotal)}`}
              </button>
            )}
            {billingTab === 'void' && (
              <button className="btn" style={{ width: '100%', padding: '11px 0', justifyContent: 'center', background: 'var(--theme-red)', color: redBadgeText, borderColor: 'var(--theme-red)' }}
                onClick={() => closeOrder('void')} disabled={closing || !closeReason}>
                {closing ? 'Processing…' : 'Void Order'}
              </button>
            )}
            {billingTab === 'writeoff' && (
              <button className="btn" style={{ width: '100%', padding: '11px 0', justifyContent: 'center', background: 'var(--theme-amber)', color: amberBadgeText, borderColor: 'var(--theme-amber)' }}
                onClick={() => closeOrder('writeoff')} disabled={closing || !closeReason}>
                {closing ? 'Processing…' : 'Mark Complimentary (₨0 collected)'}
              </button>
            )}
            <button className="btn btn-ghost" style={{ width: '100%', padding: '9px 0', justifyContent: 'center', marginTop: 8, fontSize: 13 }}
              onClick={requestCloseBilling} disabled={closing}>
              Cancel
            </button>
          </div>
          </div>
        </Modal>
      )}

      {/* Pulling an already-fired line. Not a ConfirmModal: this asks for an input, and the input
          is the entire point — a yes/no dialog would add friction and record nothing. */}
      {pullPrompt && (
        <Modal onClose={() => setPullPrompt(null)} title="Remove an item the kitchen already has" maxWidth={440}>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 14px', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--theme-text1)' }}>{pullPrompt.pulled} × {pullPrompt.name}</strong>{' '}
            {pullPrompt.pulled === 1 ? 'has' : 'have'} already been sent to the kitchen or bar. Taking{' '}
            {pullPrompt.pulled === 1 ? 'it' : 'them'} off this bill is recorded against your login with the
            reason you give here, and shows on POS Reports → KOT Log → Pulled Items.
          </p>
          <div className="form-field" style={{ marginBottom: 12 }}>
            <label htmlFor="kot-pull-reason">Reason</label>
            <select id="kot-pull-reason" className="form-select" value={pullReason}
              onChange={e => setPullReason(e.target.value)}>
              <option value="">— Select —</option>
              {KOT_PULL_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setPullPrompt(null)}>Keep the item</button>
            <button
              className="btn btn-primary"
              disabled={!pullReason}
              onClick={() => {
                setKotPullReason(pullReason)
                applyQty(pullPrompt.idx, pullPrompt.qty)
                setPullPrompt(null)
                setMsg('ok:Removed — save the order to record it.')
              }}
            >
              Remove it
            </button>
          </div>
        </Modal>
      )}
      {/* S754: Update Order's "send the new lines?" ask. In THIS return because saveOrder runs on
          the order screen (S578); zIndex above the order screen's own fixed layer at 1000. */}
      {sendPrompt && (
        <Modal
          title={sendPrompt.units > 0
            ? `Send ${sendPrompt.units} new item${sendPrompt.units === 1 ? '' : 's'} to the ${sendPrompt.where} now?`
            : `Send ${sendPrompt.lines} change${sendPrompt.lines === 1 ? '' : 's'} to the ${sendPrompt.where} now?`}
          onClose={() => setSendPrompt(null)}
          maxWidth={440}
          zIndex={1200}
        >
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            {sendPrompt.lines === 1 ? 'One line on this order has' : `${sendPrompt.lines} lines on this order have`} not gone to the {sendPrompt.where} yet.
            <strong> Send</strong> saves the order, prints the ticket and puts it on the Kitchen Display.
            <strong> Just save</strong> keeps {sendPrompt.lines === 1 ? 'it' : 'them'} on the order unsent — press KOT or BOT later to send.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
            <button type="button" className="btn btn-ghost" onClick={() => { setSendPrompt(null); commitSaveOrder() }}>Just save</button>
            <button type="button" className="btn btn-primary" onClick={saveAndSendUnsent}>Send</button>
          </div>
        </Modal>
      )}
      {/* S754: another device saved this order first. The reloaded order is already on screen; this
          lists what this device had that it does not carry. In THIS return — performSave runs from the
          order screen (S578) — above the order screen's own fixed layer. */}
      {staleRecovery && (
        <Modal
          title={`${staleRecovery.where} was changed on another device`}
          onClose={() => setStaleRecovery(null)}
          maxWidth={460}
          zIndex={1200}
        >
          <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            Here is the latest order. Nothing from this screen was saved — add your items again.
            {staleRecovery.missing.length === 1 ? ' This item was' : ' These items were'} on your screen but not on it:
          </p>
          <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 14, color: 'var(--theme-text1)' }}>
            {staleRecovery.missing.map(m => (
              <li key={m.recipe_id || m.name}>{m.qty} × {m.name}{m.notes ? <span style={{ color: 'var(--theme-text3)' }}> — {m.notes}</span> : null}</li>
            ))}
          </ul>
          <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-text3)', lineHeight: 1.5 }}>
            Added back, they go on as unsent lines — nothing reaches the kitchen or bar until you send it.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setStaleRecovery(null)}>Leave them off</button>
            <button type="button" className="btn btn-primary" onClick={addBackStaleItems}>Add them back as unsent</button>
          </div>
        </Modal>
      )}
      {/* S754: the bill on screen was closed on another device — one way out, back to the floor. */}
      {closedElsewhere && (
        <Modal title="This bill was already closed on another device" onClose={acknowledgeClosedElsewhere} maxWidth={420} zIndex={1300}>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            {closedElsewhere} was billed or voided on another till, so nothing more can be added to it and nothing
            on this screen was saved to it. The floor shows the table as it is now — open it again to start a new order.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" onClick={acknowledgeClosedElsewhere}>Back to the floor</button>
          </div>
        </Modal>
      )}
      {/* The order-screen asks (discard recorded payments, discard unsaved items — S754). Rendered
          here, not only in the floor return: their handlers run on this screen (S578). */}
      {confirmEl}
    </div>
  )

  /* ══════════════════════════════════════════ FLOOR VIEW */

  return (
    <>
    {/* ── Covers modal ── */}
    {coversModal && pendingTable && (
      <Modal
        title={pendingTable.name}
        onClose={() => { setCoversModal(false); setPendingTable(null) }}
        maxWidth={320}
      >
        <div style={{ textAlign: 'center' }}>
          {pendingTable.section && (
            <p style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--theme-text3)' }}>{pendingTable.section}</p>
          )}
          <p style={{ margin: '0 0 24px', fontSize: 12, color: 'var(--theme-text3)' }}>
            {pendingTable.capacity} seat{pendingTable.capacity !== 1 ? 's' : ''}
          </p>

          <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'var(--theme-text2)' }}>How many covers?</p>

          <div style={{ fontSize: 48, fontWeight: 700, color: pendingCoversStr ? 'var(--theme-text1)' : 'var(--theme-text3)', letterSpacing: 4, marginBottom: 16, minHeight: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {pendingCoversStr || '—'}
          </div>

          {(() => {
            const pad = { width: 72, height: 52, borderRadius: 'var(--radius-md)', border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)', color: 'var(--theme-text1)', fontSize: 20, fontWeight: 600, cursor: 'pointer' }
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 20 }}>
                {[1,2,3,4,5,6,7,8,9].map(d => (
                  <button key={d} onClick={() => numpadPress(String(d))} style={pad}>{d}</button>
                ))}
                <button onClick={numpadClear} aria-label="Clear" style={{ ...pad, color: 'var(--theme-red-text)', fontSize: 14, fontWeight: 700 }}>CLR</button>
                <button onClick={() => numpadPress('0')} style={pad}>0</button>
                <button onClick={numpadBackspace} aria-label="Backspace" style={{ ...pad, fontSize: 18 }}>⌫</button>
              </div>
            )
          })()}

          <button
            className="btn btn-primary"
            style={{ width: '100%', padding: '12px 0', fontSize: 15, marginBottom: 10, justifyContent: 'center' }}
            onClick={confirmCovers}
          >
            Open Order
          </button>
          <button
            className="btn btn-danger"
            style={{ width: '100%', padding: '12px 0', fontSize: 15, justifyContent: 'center' }}
            onClick={() => { setCoversModal(false); setPendingTable(null) }}
          >
            Cancel
          </button>
        </div>
      </Modal>
    )}

    {/* ── Seat prompt: a tapped table has a booking due (S677). Lives in the FLOOR return, the
           same tree as openTable's callers — see the two-returns note in pos-billing.md. ── */}
    {seatPrompt && (
      <Modal
        title={seatPrompt.table.name}
        onClose={() => setSeatPrompt(null)}
        maxWidth={360}
      >
        <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--theme-text3)' }}>Booked for this table</p>
        <p style={{ margin: '0 0 18px', fontSize: 17, fontWeight: 700, color: 'var(--theme-text1)' }}>
          {seatPrompt.reservation.customer_name} ×{seatPrompt.reservation.party_size}
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--theme-text3)', marginLeft: 8 }}>{nepalTime(seatPrompt.reservation.reserved_for)}</span>
        </p>
        <button
          className="btn btn-primary"
          style={{ width: '100%', padding: '12px 0', fontSize: 15, marginBottom: 10, justifyContent: 'center' }}
          onClick={() => seatReservation(seatPrompt.table, seatPrompt.reservation)}
        >
          Seat {seatPrompt.reservation.customer_name} ×{seatPrompt.reservation.party_size}
        </button>
        <button
          className="btn btn-ghost"
          style={{ width: '100%', padding: '12px 0', fontSize: 15, justifyContent: 'center' }}
          onClick={() => { const t = seatPrompt.table; setSeatPrompt(null); startFreshOrder(t) }}
        >
          Walk-in instead
        </button>
      </Modal>
    )}

    <div>

      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Order Taking</h1>
          <p className="page-subtitle">
            Tap a table to open or view its order. Occupied tables show the running total.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {isAdmin && (
              <Tip text="Testing utility — deletes every open order/item and frees all occupied tables for this client. Admin only.">
                <button
                  onClick={clearAllOccupiedTables}
                  className="btn btn-ghost"
                  style={{ fontSize: 13, flexShrink: 0, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-red) 7%, transparent)' }}
                >⚠ Clear Occupied</button>
              </Tip>
            )}
            {/* S754: Supervisor and above only — a Staff-rank till does not see or open Recent Bills. */}
            {hasPosAccess('supervisor') && (
              <Tip text="Today's closed bills — reprint a duplicate/triplicate copy if a customer needs one again.">
                <button
                  onClick={() => { setRecentBillsOpen(true); setRecentBillsSearch(''); loadRecentBills() }}
                  className="btn btn-ghost"
                  style={{ fontSize: 13, flexShrink: 0 }}
                >📄 Recent Bills</button>
              </Tip>
            )}
            <button className="btn btn-ghost" onClick={openTakeaway} style={{ fontSize: 13, flexShrink: 0 }}>
              + Takeaway
            </button>
          </div>
          {pendingTableCount > 0 && (
            <Tip text="Tables with items added but not yet sent to the kitchen/bar — tap the table to review and send">
              <span style={{
                fontSize: 12, fontWeight: 700, color: amberBadgeText,
                background: 'var(--theme-amber)', borderRadius: 0,
                padding: '4px 10px', cursor: 'default', whiteSpace: 'nowrap',
              }}>
                ⚠ {pendingTableCount} table{pendingTableCount !== 1 ? 's' : ''} · {pendingItemCount} item{pendingItemCount !== 1 ? 's' : ''} pending
              </span>
            </Tip>
          )}
        </div>
      </div>

      {/* Today's bookings — a quiet strip, not an alarm: brass/grey chips, amber only for a party
          that has arrived and is waiting (loudness tracks demand for action, posSignals.js). */}
      {(floorReservations.length > 0 || requestCount > 0) && (
        <div className="card" style={{ padding: '10px 14px', marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--theme-text2)' }}>
          <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>🕗 Today's bookings</span>
          {floorReservations.map(r => {
            const names = tableIdsOf(r).map(id => tables.find(t => t.id === id)?.name).filter(Boolean)
            return (
              <Tip key={r.id} text={r.status === 'arrived' ? `${r.customer_name} has arrived and is waiting for a table.` : `${r.customer_name}, party of ${r.party_size}, booked for ${nepalTime(r.reserved_for)}${names.length ? ` at ${names.join(', ')}` : ' — no table held yet'}.`} width={240}>
                <span className={`badge ${r.status === 'arrived' ? 'badge-amber' : 'badge-gray'}`} style={{ cursor: 'default' }}>
                  {nepalTime(r.reserved_for)} {r.customer_name} ×{r.party_size}{names.length ? ` (${names.join(', ')})` : ''}
                </span>
              </Tip>
            )
          })}
          {requestCount > 0 && (
            <Tip text="Booking requests sent from the outlet's booking link, waiting for a staff Accept on the Reservations page." width={240}>
              <span className="badge badge-amber" style={{ cursor: 'default' }}>🔔 {requestCount} booking request{requestCount === 1 ? '' : 's'}</span>
            </Tip>
          )}
          <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => navigate('/pos/reservations')}>Reservations →</button>
        </div>
      )}

      {Object.keys(pendingGuestOrders).length > 0 && (() => {
        const total = Object.values(pendingGuestOrders).reduce((s, arr) => s + arr.length, 0)
        const tableNames = Object.keys(pendingGuestOrders).map(tid => tables.find(t => t.id === tid)?.name || '?')
        const firstTable = tables.find(t => t.id === Object.keys(pendingGuestOrders)[0])
        return (
          <div
            className="guest-order-banner"
            onClick={() => firstTable && openTable(firstTable)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
              background: 'color-mix(in srgb, var(--theme-accent) 16%, transparent)', border: '1px solid var(--theme-accent)',
              borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13.5, fontWeight: 700,
              color: 'var(--theme-accent-ink)',
            }}
          >
            <span style={{ fontSize: 18 }}>🔔</span>
            <span>{total} new guest order{total !== 1 ? 's' : ''} — {tableNames.join(', ')}</span>
            <span style={{ marginLeft: 'auto', fontWeight: 600 }}>Tap to review →</span>
          </div>
        )
      })()}

      {!isOnline && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--theme-amber-text)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>📵</span>
            <span><strong>Offline</strong> — orders are saved on this device and will sync when you reconnect. Billing stays disabled until then.</span>
            {pendingOrderIds.size > 0 && (
              <span style={{ marginLeft: 'auto', background: 'color-mix(in srgb, var(--theme-amber) 15%, transparent)', borderRadius: 'var(--radius-full)', padding: '2px 10px', fontWeight: 600, flexShrink: 0 }}>
                {pendingOrderIds.size} pending
              </span>
            )}
          </div>
          {/* S673: this is the screen "outlet is down" happens on — a broken app needs a phone
              number, not just a network. */}
          <SupportContactLine variant="inline" />
        </div>
      )}
      {syncingOffline && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-green) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-green-text)' }}>
          ⟳ Syncing {pendingOrderIds.size} {pendingOrderIds.size === 1 ? 'order' : 'orders'}…
        </div>
      )}
      {floorMsg && (
        <div style={{
          background: floorMsg.startsWith('error:') ? 'color-mix(in srgb, var(--theme-red) 8%, transparent)' : 'color-mix(in srgb, var(--theme-green) 8%, transparent)',
          border: `1px solid ${floorMsg.startsWith('error:') ? 'color-mix(in srgb, var(--theme-red) 25%, transparent)' : 'color-mix(in srgb, var(--theme-green) 25%, transparent)'}`,
          borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13,
          color: floorMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)',
        }}>
          {floorMsg.replace(/^(error|ok):/, '')}
        </div>
      )}
      {writeWarnings.length > 0 && (
        <div role="alert" style={{
          background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
          border: '1px solid color-mix(in srgb, var(--theme-amber) 28%, transparent)',
          borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13,
          color: 'var(--theme-text2)', display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ color: 'var(--theme-amber-text)' }}>
              ⚠ {writeWarnings.length === 1 ? 'Something did not save' : `${writeWarnings.length} things did not save`}
            </strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {writeWarnings.map(w => <li key={w} style={{ marginTop: 2 }}>{w}</li>)}
            </ul>
          </div>
          <button className="btn btn-ghost" style={{ fontSize: 12, flexShrink: 0 }}
            onClick={() => setWriteWarnings([])}>Dismiss</button>
        </div>
      )}
      {/* Bills whose revenue and stock never reached Inventory, because no BS period was open
          for their date. The sale itself is fine and the bill is valid — but IMS has no record of
          it, so MonthlySummary, Variance and stock levels are all short until it is backfilled.
          Silently correct-looking was the worst available option here. */}
      {/* What the bill just closed earned. Dismissible and transient: it is feedback on one
          action, not a standing condition like the unposted-bills warning below it. A failure
          uses the same amber treatment rather than red — nothing is wrong with the BILL, which
          closed and printed correctly; only the points did not land. */}
      {loyaltyNote && (
        <div
          role="status"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
            background: loyaltyNote.ok
              ? 'color-mix(in srgb, var(--theme-green) 8%, transparent)'
              : 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
            border: `1px solid color-mix(in srgb, var(--theme-${loyaltyNote.ok ? 'green' : 'amber'}) 28%, transparent)`,
            borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 16, fontSize: 13,
            color: loyaltyNote.ok ? 'var(--theme-green-text)' : 'var(--theme-amber-text)',
          }}
        >
          <span style={{ fontWeight: 600 }}>{loyaltyNote.ok ? '★ ' : '⚠ '}{loyaltyNote.text}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setLoyaltyNote(null)} aria-label="Dismiss">×</button>
        </div>
      )}

      {(unpostedCount > 0 || imsPostWarning > 0) && (
        <div role="alert" style={{
          background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
          border: '1px solid color-mix(in srgb, var(--theme-amber) 28%, transparent)',
          borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13,
          color: 'var(--theme-text2)',
        }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>
            ⚠ {Math.max(unpostedCount, imsPostWarning)} bill{Math.max(unpostedCount, imsPostWarning) === 1 ? '' : 's'} not posted to Inventory
          </strong>
          <div style={{ marginTop: 4 }}>
            These bills closed normally and are valid, but there was no open Inventory period for
            their date — so their revenue and ingredient usage are missing from Inventory reports.
            Open the matching period in <strong>Periods</strong>, then use <strong>Post POS bills to Inventory</strong> there to backfill them.
          </div>
        </div>
      )}
      {unpostedNotes > 0 && (
        <div role="alert" style={{
          background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
          border: '1px solid color-mix(in srgb, var(--theme-amber) 28%, transparent)',
          borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13,
          color: 'var(--theme-text2)',
        }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>
            ⚠ {unpostedNotes} credit note{unpostedNotes === 1 ? '' : 's'} not yet taken off Inventory sales
          </strong>
          <div style={{ marginTop: 4 }}>
            {unpostedNotes === 1 ? 'It is' : 'They are'} valid and printed, but no Inventory period was open for the
            month {unpostedNotes === 1 ? 'it was' : 'they were'} issued in — so Inventory still counts that revenue.
            Open the month in <strong>Periods</strong>, then use <strong>Post POS bills to Inventory</strong> there.
          </div>
        </div>
      )}
      {conflictOrders.map(c => (
        <div key={c.order_id} style={{ background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 30%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red-text)' }}>
          <span>⚠</span>
          <span>
            {/* Why the server refused the replay (S754) — each needs different words, the same recovery. */}
            {c.reason === 'stale' ? (
              <><strong>{c.table_name}</strong>'s order was changed on another device while you were offline — </>
            ) : c.reason === 'table_taken' ? (
              <><strong>{c.table_name}</strong> was opened on another device while you were offline — </>
            ) : c.reason === 'off_menu' ? (
              <><strong>{c.table_name}</strong>: a dish in your offline order is no longer on the till menu — </>
            ) : (
              <><strong>{c.table_name}</strong>'s bill was closed on another device while you were offline — </>
            )}
            your queued changes ({c.items.length} item{c.items.length !== 1 ? 's' : ''}) were NOT applied.
          </span>
          {/* S754: recover the lines rather than only throw them away. */}
          <Tip text="Puts these items back as unsent lines: onto the order this table (or takeaway) has open now — only what that order does not already carry — or onto a new order if it has none. This notice goes away once that order is saved.">
            <button className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 12, flexShrink: 0 }}
              disabled={!isOnline}
              onClick={() => startOrderFromConflict(c)}>Start new order with these</button>
          </Tip>
          <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-red-text)', flexShrink: 0 }}
            onClick={() => discardConflictOrder(c.order_id)}>Discard</button>
        </div>
      ))}

      {sections.length > 1 && (
        <div className="tab-bar" style={{ marginBottom: 20 }}>
          {sections.map(s => (
            <button key={s} className={`tab-btn${secFilter === s ? ' tab-btn--active' : ''}`}
              onClick={() => setSecFilter(s)}>{s}</button>
          ))}
        </div>
      )}

      {/* S754: a failed floor read keeps the last good floor below and says so here. It is a line,
          not a window.alert: the 15 s poll would re-raise an alert every time the network blinked. */}
      {floorLoadError && (
        <p role="alert" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-red-text)' }}>
          Couldn't refresh the floor — {floorLoadError}.{tables.length > 0 ? ' Tables below are as last loaded and may be out of date.' : ''}{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadFloor()}>Retry</button>
        </p>
      )}

      {/* Open takeaway orders (S754) — they have no table tile, so without these a saved takeaway
          could not be reopened, added to or billed from this screen at all. */}
      {!floorLoad && takeawayOrders.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
            Open takeaways
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
            {takeawayOrders.map(t => {
              const kot = kotStatusByTable[`takeaway:${t.orderId}`]
              const kotChip = ticketSummaryChip(kot)
              const label = t.orderNo ? `Takeaway #${t.orderNo}` : 'Takeaway (not synced)'
              return (
                <div
                  key={t.orderId}
                  className="card"
                  role="button"
                  tabIndex={0}
                  aria-label={`${label}, ${t.itemCount} item${t.itemCount !== 1 ? 's' : ''}, ${fmtNpr(t.total)}`}
                  onClick={() => openOrderById(t.orderId)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openOrderById(t.orderId) } }}
                  style={{ padding: '16px 18px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden', borderColor: 'var(--theme-accent)' }}
                >
                  <div style={{
                    margin: '-16px -18px 2px', height: 6, flexShrink: 0,
                    background: tableStripColor({ status: 'occupied', order: t, kotStatus: kot, guestPending: false }),
                  }} />
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--theme-text1)' }}>{label}</span>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                      {kotChip && (
                        <span className={kotChip.className} style={{ fontSize: 9 }}>{kotChip.label}</span>
                      )}
                      {t.offlinePending && (
                        <Tip text="Not yet synced to the server — will upload automatically once this device reconnects">
                          <span style={{ fontSize: 9, fontWeight: 700, color: amberBadgeText, background: 'var(--theme-amber)', borderRadius: 0, width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}>📵</span>
                        </Tip>
                      )}
                      {t.pending > 0 && (
                        <Tip text="Items added but not sent to the kitchen/bar yet — tap to open and send">
                          <span style={{ fontSize: 9, fontWeight: 700, color: amberBadgeText, background: 'var(--theme-amber)', borderRadius: 0, padding: '1px 6px', cursor: 'default', whiteSpace: 'nowrap' }}>⚠ {t.pending}</span>
                        </Tip>
                      )}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                      {t.itemCount} item{t.itemCount !== 1 ? 's' : ''}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-accent-ink)', marginTop: 3 }}>
                      {fmtNpr(t.total)}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {floorLoad ? (
        <p style={{ color: 'var(--theme-text3)' }}>Loading tables…</p>
      ) : tables.length === 0 && floorLoadError ? null : tables.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text3)' }}>
          No tables set up yet.{' '}
          <a href="/pos/tables" style={{ color: 'var(--theme-accent-ink)' }}>Go to Table Management →</a>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
          {visTables.map(t => {
            const ord      = tableOrders[t.id]
            const inactive = t.status === 'inactive'
            const hasPendingGuest = pendingGuestOrders[t.id]?.length > 0
            return (
              <div
                key={t.id}
                className={`card${hasPendingGuest ? ' guest-order-glow' : ''}`}
                onClick={() => !inactive && openTable(t)}
                style={{
                  padding: '16px 18px',
                  cursor: inactive ? 'default' : 'pointer',
                  opacity: inactive ? 0.4 : 1,
                  display: 'flex', flexDirection: 'column', gap: 8,
                  overflow: 'hidden',
                  ...(ord ? { borderColor: 'var(--theme-accent)' } : {}),
                }}
                {...(!inactive ? {
                  role: 'button',
                  tabIndex: 0,
                  onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTable(t) } },
                } : {})}
              >
                {/* Glanceable ATTENTION strip — readable across the room, and deliberately not a
                    status strip: a waiter crossing the floor can already see which tables are
                    occupied, so the 6px band carries what they cannot see (food ready, items
                    unfired, a guest order waiting, an order unsynced). Status keeps its labelled
                    badge below. See posSignals.js. */}
                <div style={{
                  margin: '-16px -18px 2px', height: 6, flexShrink: 0,
                  background: tableStripColor({
                    status: t.status, order: ord, kotStatus: kotStatusByTable[t.id], guestPending: hasPendingGuest,
                  }),
                }} />
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--theme-text1)' }}>{t.name}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                    <span className={STATUS_BADGE[t.status] || 'badge-gray'} style={{ fontSize: 10 }}>
                      {STATUS_LABEL[t.status] || t.status}
                    </span>
                    {ord && ticketSummaryChip(kotStatusByTable[t.id]) && (() => {
                      const chip = ticketSummaryChip(kotStatusByTable[t.id])
                      return (
                        <Tip text="Kitchen/bar status of items sent for this order — Sent (not yet started) / Started (being prepared) / Ready or “N ready” (food waiting to be taken to the table) / Served. Open the table to see per-item prep timers and mark Ready food as served.">
                          <span className={chip.className} style={{ fontSize: 9 }}>{chip.label}</span>
                        </Tip>
                      )
                    })()}
                    {pendingGuestOrders[t.id]?.length > 0 && (
                      <Tip text="A guest submitted an order from the QR menu on this table — open it to Accept or Dismiss">
                        <span className="badge-amber" style={{ fontSize: 9 }}>
                          🔔 Guest order{pendingGuestOrders[t.id].length > 1 ? ` (${pendingGuestOrders[t.id].length})` : ''}
                        </span>
                      </Tip>
                    )}
                    {ord?.offlinePending && (
                      <Tip text="Not yet synced to the server — will upload automatically once this device reconnects">
                        <span style={{
                          fontSize: 9, fontWeight: 700, color: amberBadgeText,
                          background: 'var(--theme-amber)', borderRadius: 0,
                          width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'default',
                        }}>
                          📵
                        </span>
                      </Tip>
                    )}
                    {ord?.pending > 0 && (
                      <Tip text="Items added but not sent to the kitchen/bar yet — tap to open and send">
                        <span style={{
                          fontSize: 9, fontWeight: 700, color: amberBadgeText,
                          background: 'var(--theme-amber)', borderRadius: 0,
                          padding: '1px 6px', cursor: 'default', whiteSpace: 'nowrap',
                        }}>
                          ⚠ {ord.pending}
                        </span>
                      </Tip>
                    )}
                  </div>
                </div>

                {t.section && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{t.section}</div>
                )}

                {/* The booking due on this table. Quiet by default; brass when due within the seat
                    window (tap to seat); amber ONLY when the party has arrived and the table is
                    still occupied — the one state here that is waiting on a person. */}
                {reservationsByTable[t.id] && (() => {
                  const r = reservationsByTable[t.id]
                  const waiting = r.status === 'arrived' && !!ord
                  const due = !waiting && isDue(r, kotNow, reservationSettings.seat_window_minutes)
                  const cls = waiting ? 'badge-amber' : due ? 'badge-yellow' : 'badge-gray'
                  return (
                    <Tip text={waiting
                      ? `${r.customer_name} (party of ${r.party_size}) has arrived — this table is still occupied.`
                      : `Booked ${nepalTime(r.reserved_for)} for ${r.customer_name}, party of ${r.party_size}. Tap the table when they sit down: the order opens with the covers filled in.`} width={240}>
                      <span className={`badge ${cls}`} style={{ fontSize: 10, alignSelf: 'flex-start', cursor: 'default' }}>
                        🕗 {nepalTime(r.reserved_for)} · {r.customer_name} ×{r.party_size}
                      </span>
                    </Tip>
                  )
                })()}

                {ord ? (
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                      {ord.itemCount} item{ord.itemCount !== 1 ? 's' : ''} · {ord.covers} cover{ord.covers !== 1 ? 's' : ''}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-accent-ink)', marginTop: 3 }}>
                      {fmtNpr(ord.total)}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>👥 {t.capacity} seats</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>

    {/* ── Recent Bills / Reprint modal ── */}
    {recentBillsOpen && hasPosAccess('supervisor') && (
      <Modal title="Recent Bills — Today" onClose={() => setRecentBillsOpen(false)} maxWidth={480}>
          <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--theme-text3)' }}>Reprint a bill closed earlier today.</p>
          {/* S754: the list is now the whole day, not the newest 30, so a customer's bill number needs a
              way in. Matches the invoice number or the order number as printed on the slip. */}
          <input
            type="search"
            className="form-input"
            aria-label="Find a bill by invoice or order number"
            placeholder="Find by bill or order no."
            value={recentBillsSearch}
            onChange={e => setRecentBillsSearch(e.target.value)}
            style={{ marginBottom: 10 }}
          />
          <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
            {recentBillsLoad ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
            ) : recentBillsError ? (
              <p role="alert" style={{ color: 'var(--theme-red-text)', fontSize: 13 }}>
                Couldn't load today's bills — {recentBillsError}. This is a failed read, not an empty day: do not re-bill a table from this list.
              </p>
            ) : recentBills.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>No bills closed yet today.</p>
            ) : visibleRecentBills.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>No bill today matches "{recentBillsSearch.trim()}" — {recentBills.length} bill{recentBills.length === 1 ? '' : 's'} closed so far.</p>
            ) : visibleRecentBills.map(o => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--theme-border)' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>
                    {o.table_name || 'Takeaway'} {o.close_type === 'void' && <span style={{ color: 'var(--theme-red-text)', fontSize: 11 }}>(Void)</span>}
                    {o.close_type === 'writeoff' && <span style={{ color: 'var(--theme-accent-ink)', fontSize: 11 }}>(Complimentary)</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                    {o.invoice_no ? `Inv #${o.invoice_no}` : `Order #${o.order_no}`} · {nepalTime(o.closed_at)}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {o.paid_amount != null && <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{fmtNpr(o.paid_amount)}</span>}
                  {o.close_type !== 'void' && (
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => reprintBill(o)}>Reprint</button>
                  )}
                  {o.close_type === 'paid' && ordersWithItemComp.has(o.id) && (
                    <Tip text="Reprint the mini Complimentary Slip for the item(s) comped on this bill — separate from the Tax Invoice/Bill above, which only ever covers the non-comped items.">
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => reprintItemCompSlip(o)}>Comp Slip</button>
                    </Tip>
                  )}
                  {o.close_type === 'paid' && !o.credit_note_id && hasPosAccess('manager') && (
                    <Tip text="Issue a formal Credit Note against this bill — corrects revenue for a billing/price/tax error. Does not affect stock.">
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setCreditNoteOrder(o)}>Credit Note</button>
                    </Tip>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button className="btn btn-ghost" style={{ width: '100%', padding: '9px 0', justifyContent: 'center', marginTop: 14, fontSize: 13 }}
            onClick={() => setRecentBillsOpen(false)}>
            Close
          </button>
      </Modal>
    )}


    {creditNoteOrder && (
      <IssueCreditNoteModal
        order={creditNoteOrder}
        onClose={() => setCreditNoteOrder(null)}
        onIssued={created => {
          setRecentBills(prev => prev.map(o => o.id === creditNoteOrder.id ? { ...o, credit_note_id: created.id } : o))
          setCreditNoteOrder(null)
        }}
      />
    )}
    {/* The floor return's copy, for the admin clear-all tool above it. The order screen renders
        the same element for its own asks — only one tree is ever mounted (S578). */}
    {confirmEl}
    </>
  )
}
