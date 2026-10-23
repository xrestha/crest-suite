import { useState, useEffect, useRef, useMemo } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useTheme } from '../../../context/ThemeContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { setIfChanged, rowsSignature, mapSignature } from '../../../shared/setIfChanged'
import { pointsValue, maxRedeemablePoints, isDeliveryPartnerPhone, redeemedAmountDiffers, spendablePoints, earnPreview, pointsOnOtherBills, pointsOnOtherBillText } from '../customers/loyaltyPoints'
import { phoneForRecord, customerPhoneKey } from '../../../utils/phone'
import Tip from '../../../components/Tip'
import SupportContactLine from '../../../components/SupportContactLine'
import { contrastRatio } from '../../../utils/avatarColor'
import QRCode from 'qrcode'
import { getBsToday, getBsFiscalYear, bsDayBoundaryIso, formatAdAsBs } from '../../../utils/bsCalendar'
import { memberStatus, isMembershipReason, creditLimitWarning, normalizeCardNo, todayNepalIso, pctText } from './memberDiscount'
import { creditPartyKey } from '../customers/creditLedger'
import { FLOOR_STATUSES, isDue, tableIdsOf, stampFor, windowOf, bookingToSeatOnTap, carryOverFrom, stillInPlay } from '../reservations/reservationStatus'
import { normalizeReservationSettings, DEFAULT_RESERVATION_SETTINGS } from '../reservations/reservationSettings'
import { posLineCosts, buildYourOwnAmong, LINE_CHOICE_STOCK, LINE_CHOICE_BILL } from './posRecipeBook'
import { readHscMap, staffNameFor } from './billReprintData'
import { noteImsMiss, pruneImsMisses, outletHasIms, countPhrase } from './posImsWaiting'
import { buildDynamicQr } from '../../../utils/emvQr'
import { randomUUID } from '../../../utils/uuid'
import Modal from '../../../components/Modal'
import ActionError from '../../../components/ActionError'
import { disabledStyle } from '../../../shared/inlineFieldState'
// The floor's refusals a waiter must not be able to walk past mid-service (a table that may already
// have an order, a bill reprinted without its lines, a clear-all that half ran) are a TILL NOTICE
// (`showTillNotice`, TillNotice.jsx): a red bar at the top that stays until ✕, above any dialog. They
// were window.alert()s until the 2026-10-15 audit (S616, S682, S809 4l chose un-missable); the owner
// replaced the pop-up because it froze the page, the guest-order chime and the polls until OK. A
// message a waiter may glance past still goes in the floor banner (`floorMsg`). Never window.alert here.
import TillNotice from './TillNotice'
import { useBillQr } from './useBillQr'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import IssueCreditNoteModal from '../creditnotes/IssueCreditNoteModal'
import OptionPickerModal from '../../customization/OptionPickerModal'
import ComboPickerModal from '../../customization/ComboPickerModal'
import { ComboTiles, ComboCartBlock } from './ComboTill'
import MenuGrid, { filterMenu } from './MenuGrid'
import {
  COMBO_TAB, COMBO_TAB_LABEL, loadComboCatalog, comboAddsInOneTap, defaultComboPicks, buildComboLines, comboDishLine,
  comboIdOf, comboGroupOf, groupComboBlocks, cartRows, addComboLinesToCart, setComboQtyIn, comboUnitsPulled,
  swapComboDish, picksOfCombo, collapseCombosForMove, expandComboPicks, guestLineOf, guestRequestText, swapShareOf, comboAsSold,
} from './comboCart'
import { computeOrderAmounts, discountableSubtotal, isComboItem } from '../../../utils/posBillingMath'
import { openBillTotal } from '../dashboard/posDashboardMath'
import { loadOptionCatalog } from '../../customization/customizationData'
import { groupsForDish, describeSelection, defaultSelection, selectionProblems } from '../../../shared/optionPricing'
import { lineChoiceTrouble, choiceRefusalText, savedLineGoneNote, sentDishWayOut, customizationSwitchedText } from './choiceRefusal'
import {
  cachePosMenu, getCachedPosMenu, cachePosTables, getCachedPosTables,
  cachePosSettings, getCachedPosSettings, cachePosOrderForTable, getCachedPosOrderForTable,
  clearCachedPosOrderForTable, enqueuePosOrder, getPosOrderQueue, getQueuedPosOrder, dequeuePosOrder,
  settlePosOrderUpload, markQueuedSendsLogged, queuedSendKey, enqueuePosTickets,
} from '../../../utils/offlineQueue'
import { buildBillHtml, buildTenderSlipHtml, buildCompSlipHtml, buildShareSlipsHtml, withChoices } from './posOrderPrintHtml'
import { kotBotDoc, voidSlipDoc, moveSlipDoc } from '../printing/ticketDoc'
import { useStationPrinting } from '../printing/useStationPrinting'
import StationPrintAlerts from '../printing/StationPrintAlerts'
import BillingStation from './BillingStation'
import MoveTableModal from './MoveTableModal'
import MoveDishesModal from './MoveDishesModal'
import RowMenu from '../../../components/RowMenu'
import WaitlistPanel from '../waitlist/WaitlistPanel'
import { loadOrderDeposit, applyDeposit, depositErrorInfo } from '../deposits/depositApi'
import { useWaitlist } from '../waitlist/useWaitlist'
import { mainTableOfJoin, joinedTablesOf, moveSlipItems, movedSentByKey, moveNoticeItems, partBillLabel } from './tableMoves'
import { equalShares, MIN_SHARES, MAX_SHARES } from './shareSplit'
import PosImsPostingBanner from './PosImsPostingBanner'
import {
  TILL_SETTINGS_READ_MS, TILL_SETTINGS_RETRY_MS, tillSettingsReadOutcome, cacheCarriesRouting, tillSettingsNotice,
  tillSettingsBlockText, tillSettingsReprintText, closeStartRefusal, fullInvoiceRequired, fullInvoiceRefusal,
  optionalBuyerTip, FULL_INVOICE_TIP, ABBREVIATED_INVOICE_LIMIT,
} from './tillBillChecks'
import { nepalTime, nepalBs } from '../../../shared/nepalTime'
import { playChime } from '../posChime'
import { barCategoriesOf } from '../ticketRouting'
import { publishTillGuestView, clearTillGuestView, useGuestAlertMute } from '../../../shared/guestAlertBridge'
import { errorText, isNetworkError } from '../../../shared/errorText'
import { withTimeout, isTimeout } from '../../../utils/withTimeout'
import { keepLockedCart, takeLockedCart, lockedCartWhere, POS_BEFORE_LOCK_EVENT } from '../posLockedCart'
import { useReleaseReload } from '../../../shared/releaseWatch'
import { KOT_CHANGE_ITEMS, sendsChangeLine, joinNote, guestDishNote } from '../kitchenNotes'
import {
  trackCloseWrite, openReadIsFinal, paymentDifferenceNote, describeStoredPayment, storedLinesMatchPaid,
  storedDiscountRatio, legsToRecord, customerRowFromBill, latestCompRows,
} from './closeAttempt'
import { keepOwnCloseAttempts, dropKeptCloseAttempt, restoreCloseAttempts, foreignCloseText } from './closeAttemptStore'
import { isStaleGuestOrder } from '../../../shared/guestOrderStale'
import { waitingRequests } from '../../../shared/reservationSeen'
import {
  SEND_STEP_MS, SEND_READ_MS, noAnswer, newSendAttempt, stopWaiting, sendLinesOf, firesTickets, stationsOf,
  judgeSendAttempts, judgesById, recentSaveOf, unknownSendText,
} from './sendAttempt'
import {
  LINK_DOWN_MS, UPLOAD_RETRY_MS, LINK_PROBE_MS, UPLOAD_TROUBLE_TRIES, uploadTroubleText, LINK_DOWN_BILL_TEXT, queuedHasLines, queuedOrderId, ownQueuedEntry, conflictPrintedNote,
  recoveredPrintedNote, queuedSendText, queuedRows, replayRows, QUEUED_BILL_TEXT, CONFLICT_HOLDS_TEXT,
  printedBackAsSent, recoveredSentNote, judgeQueuedReadBack, SENT_ELSEWHERE_TEXT,
} from './offlineUpload'
import {
  vatOf, fmtNpr, toItemPayload, QR_PAY_METHODS, STATUS_BADGE, STATUS_LABEL, tableStripColor,
  summarizeTicketStages, ticketSummaryChip, kotTimerLabel,
  OPEN_ORDER_SELECT, cartLineFromStored, foldCompedSplits, missingFromServer, mergeUnsentLines, menuDrift, withServerLineFields,
  storedLinesMatchPayload, lineKeyOf, lineOptionIds, selectionKeyOf, sentQtyAfterQtyChange, ticketForLine, inactiveTableText, seatRefusedText,
  isComboLine, comboFieldsOf, comboSuffixOf,
  PAYMENT_METHODS, VOID_REASONS, COMP_REASONS, DEFAULT_DISCOUNT_REASONS, KOT_PULL_REASONS, COPY_LABEL,
  btnSm, billInput, PREVIEW_DEBOUNCE_MS, printedStaffName,
  keptLinesToRestore, mergeRecoveredLines, menuReadMode, placeCustomLine, customChangeOf,
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
  // Crest Customization (S758): an option switched off, a pick the dish no longer allows, or the
  // module switched off since the till loaded its menu. All three mean the menu on screen is stale.
  optionOff:  'option_not_on_menu',
  optionCount:'option_count',
  optionsOff: 'order_options_off',
  // S809 4h (CUSTOMIZATION-6): a new line whose choices would price it below zero.
  optionBelowZero: 'option_price_below_zero',
  // Combos (S839, docs/pos-combos.md): a combo not whole on the save; a dish its pick no longer offers,
  // or the combo off the menu (the last two mean the combos on screen are stale).
  comboIncomplete: 'combo_incomplete',
  comboDishOff:    'combo_dish_not_offered',
  comboOff:        'combo_unavailable',
  rank:       'rank_required',     // the login's POS rank is too low for this write
}
// Postgres prefixes a RAISE message with the code word the function chose; the reader wants the
// sentence after it.
const stripCodeWord = (msg, word) => String(msg || '').replace(new RegExp(`^(pos_orders|pos_order_items|${word}):\\s*`), '')

// Every wait on the bill-close path is bounded (S776). A supabase call can hang with no error at all
// (withTimeout.js says where), and a cashier holding a guest on "Processing…" had no way out — Cancel
// is disabled while a close is in flight, for good reason. withTimeout REJECTS; `bounded` resolves the
// same `{ error }` a supabase call does, so each step keeps its one error branch. A timed-out write may
// still land: the close write itself is read back (settleUnknownClose), never assumed failed.
const CLOSE_STEP_MS = 20000
const bounded = (call, label, ms = CLOSE_STEP_MS) =>
  withTimeout(call, ms, label).catch(error => ({ data: null, error }))

// Added to a refusal once the menu it made the till read again has landed (S809 4h).
const MENU_RELOADED_TEXT = 'The menu has been reloaded.'

// S841: opening a table, and reading the menu, wait this long for the server (owner decision
// 2026-10-15), then take no answer as the internet being down, by S809 3f's rule: the table opens
// from this till's own copy, the menu from the copy saved on the tablet. 5 s went "offline" too
// often on mobile data; 20 s kept a waiter standing at the table.
const OPEN_READ_MS = 10000
const noReply = err => !!err && (isTimeout(err) || isNetworkError(err))
// The whole value as a signature (setIfChanged), for a menu re-read whose every field is drawn.
const sameJson = v => JSON.stringify(v)

// S842: how long after a cart line is removed the cart's − and × ignore a press. Removing a line moves
// the lines below it up under the finger, so the second tap of a double tap landed on the next dish.
const CART_REMOVE_GUARD_MS = 400

// The fade of a disabled inline-styled till control: `.btn:disabled`'s 0.55 (Layout.css), so a till-hit
// button that is off reads exactly like a `.btn` that is off.
const DISABLED_FADE = 0.55

// S809 ORDER-FLOW-7 (3f): the offline upload running on this page, whichever order screen started it.
// Module-level, not a ref: the screen remounts (Orders ↔ Billing) while an upload runs, the unmounted
// screen's upload carries on, and a second one started beside it logged every queued ticket twice.
const posUpload = { run: null }

// How long an idle floor waits, untouched, before it reloads for a new release (S809 1b).
const RELEASE_IDLE_MS = 60 * 1000

// A takeaway card's name, or (S834) an order whose table is gone from the floor plan, named after it,
// or (S836) a part bill waiting for its payment, named after its table.
const takeawayCardLabel = t => (t.partOf
  ? partBillLabel(t.partTableName, t.orderNo)
  : t.removedTable
    ? `${t.removedTable} (table removed)${t.orderNo ? ` #${t.orderNo}` : ''}`
    : t.orderNo ? `Takeaway #${t.orderNo}` : 'Takeaway (not synced)')
// What a kept cart's lines were "not sent before": a lock, a reload for a new release, or (S833) a
// sign-in that ended by itself.
const keptBefore = kept => (kept?.reason === 'update' ? 'the till updated'
  : kept?.reason === 'outlet' ? 'the till stopped for the outlet change'
  : kept?.reason === 'ended' ? 'the sign-in ended' : 'the till locked')
// The dishes a kept cart had not saved, as a waiter reads them: "1× Masala Tea, 2× Veg Momo" (S809 3g).
const keptLinesText = kept => keptLinesToRestore(kept?.items, []).map(l => `${l.qty}× ${l.name}`).join(', ')
// A touch screen (a till tablet, a waiter's phone): where a tap focuses a button and a tip on it
// would cover what is above it. Read per render, so a tablet with a mouse plugged in counts as one.
const coarsePointer = () => { try { return window.matchMedia('(pointer: coarse)').matches } catch (_) { return false } }

// `billingStation` is the /pos/billing route (S762) — the SAME component, entered on a third view
// that lists the open bills instead of the floor plan. Deliberately not a separate page: billing is
// ~1,500 lines of interlocked state in this file (tenders, splits, comps, discount caps, loyalty,
// the print pipeline), and a second copy of any of it is exactly the failure CLAUDE.md warns about.
export default function PosOrders({ billingStation = false } = {}) {
  const { clientId, profile, hasPosAccess, isAdmin, isOwner, imsEnabled, clientModules, clientModulesKnown, hasFeature, customizationEnabled, outlets, refreshProfile } = useAuth()
  // Who the floor's Inventory-posting banner is for (S776): since S809 3j it posts the open month itself
  // (Post to Inventory); a closed month stays the Owner's, in Periods. hasPosAccess resolves admin and
  // Owner to manager already.
  // Whether this outlet's bills go to Inventory at all (S809 4e, IMS-HANDOFF-9; owner decisions D6, D7).
  // An outlet without Crest IMS posts nothing, counts nothing and shows no banner, and its bills are
  // left unmarked. Since S831 (5f-3, Q31 a, reversing D6/D7) switching Inventory on later starts that
  // day (clientModules.imsSince), so those bills never go and never count as waiting. The operator
  // follows the outlet's own module, not its always-true route flag (outletHasIms, S814).
  const tillPostsToIms = outletHasIms({ isAdmin, imsEnabled, clientModules })
  const canSeeImsPosting = tillPostsToIms && (isAdmin || isOwner || hasPosAccess('manager'))
  const { scopedFrom, scopedInsert, scopedUpsert, scopedUpdate, scopedDelete } = useScopedDb()
  // Rendered in BOTH returns (this file has two — S578). One pending ask at a time, drawn by
  // whichever tree is live: the admin clear-all tool asks from the floor, and the discard-payments
  // and discard-unsaved-items asks (S754) come from the order screen.
  const { ask: askConfirm, confirmEl } = useConfirm()
  const { colors } = useTheme()
  // Solid-amber badges (offline-pending dot, pending-items count) were hardcoded to black text —
  // passes on Dark but computes to 4.18:1 (fails WCAG AA) on Light's amber (#b45309), a genuinely
  // dark burnt-orange. Same contrast-pick approach avatarColorFor() already uses, so this stays
  // correct if a future preset's amber ever needs white too. The solid red Void and solid amber
  // Complimentary buttons that also needed a picked foreground are tints now (S776, DESIGN.md's
  // danger-is-a-tint rule: `btn-danger btn-danger--strong` and `amber-action-btn`).
  const amberBadgeText = contrastRatio(colors.amber, '#ffffff') >= contrastRatio(colors.amber, '#000000') ? '#ffffff' : '#000000'

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
  // 'floor' | 'bills' | 'order'. 'bills' exists only on the /pos/billing route; from it, tapping a
  // bill goes through the normal open-an-order path and lands on 'order' with the payment window
  // already up, and ← comes back here rather than to the floor plan.
  const [view, setView] = useState(billingStation ? 'bills' : 'floor')

  /* ── floor ── */
  const [tables,      setTables]      = useState([])
  const [tableOrders, setTableOrders] = useState({})
  const [secFilter,   setSecFilter]   = useState('All')
  const [floorLoad,   setFloorLoad]   = useState(true)
  // Open orders with no table (S754). loadFloor used to `continue` past them, and "+ Takeaway"
  // always starts a NEW order — so a saved takeaway could never be reopened, added to or billed.
  // [{ orderId, orderNo, itemCount, total, pending, offlinePending? }]
  const [takeawayOrders, setTakeawayOrders] = useState([])
  // S836: tables joined to another table's open bill (pos_table_joins), joined table id → that bill's
  // id. A joined tile reads "with T3" and opens T3's bill; it has no bill of its own.
  const [tableJoins, setTableJoins] = useState({})
  // S836: the bill on the order screen as STORED — its table (it may have been moved since this screen
  // opened it) and, for a part bill, the bill it was split off. Set by showLoadedOrder only.
  const [screenOrder, setScreenOrder] = useState(null)
  // S836: the Table menu's dialogs ('move' | 'dishes' | 'part'), the stored lines the dish dialogs pick
  // from (read when they open), and the one action in flight.
  const [tableDialog, setTableDialog] = useState(null)
  const [tableDialogLines, setTableDialogLines] = useState([])
  const [tableBusy, setTableBusy] = useState(false)
  // S836: the payment window's equal share slips — how many guests, or null while closed.
  const [shareCount, setShareCount] = useState(null)
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
  // S809 3b. The 5 s poll runs the loadPendingGuestOrders of the render its interval started in, so it
  // reads this screen's accepted ids through a ref (ORDER-FLOW-11). What each accepted request put in
  // the cart, so a reload from another device can tell whether its dishes survived (ORDER-FLOW-18).
  // And requests whose dishes are saved on a bill but whose "accepted" mark has not landed yet: id →
  // that bill (GUEST-3). Those stay off the banner, where Accept would add the dishes a second time,
  // and are marked again from the poll (markGuestAccepts).
  const acceptedGuestReqIdsRef = useRef(pendingAcceptedGuestReqIds)
  acceptedGuestReqIdsRef.current = pendingAcceptedGuestReqIds
  const acceptedGuestItemsRef = useRef(new Map())
  const unmarkedGuestAcceptsRef = useRef(new Map())
  const markingGuestAcceptsRef = useRef(null)
  // Requests whose dishes a reload from another device left off, held off the banner while the
  // "changed on another device" box is open (ORDER-FLOW-18).
  const staleGuestReqIdsRef = useRef(new Set())

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
  // S854: the walk-in waitlist on the floor. Its panel, and the list itself, polled only while the
  // floor (or the open panel) is on screen. A party handed to Seat rides seatReservationRef as
  // { kind: 'waitlist', ... }, so every refusal a booking's seat meets applies to it unchanged.
  const [waitlistOpen, setWaitlistOpen] = useState(false)
  const waitlist = useWaitlist({ enabled: !billingStation && (view === 'floor' || waitlistOpen) })
  const [reservationSettings, setReservationSettings] = useState(DEFAULT_RESERVATION_SETTINGS)
  const location = useLocation()
  const navigate = useNavigate()

  /* ── order screen ── */
  const [activeTable, setActiveTable] = useState(null)
  // S836: the table the order screen names — the tile it was opened from, else the bill's stored table
  // (a part bill, or a bill whose table left the floor plan). Every ticket, slip and message uses it.
  const screenTableName = activeTable?.name || screenOrder?.tableName || 'Takeaway'
  const [orderId,     setOrderId]     = useState(null)
  const [orderNo,     setOrderNo]     = useState(null) // per-client sequential, assigned by DB trigger on insert
  // orderItems: { id?, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot }
  const [orderItems,  setOrderItems]  = useState([])
  const [covers,      setCovers]      = useState(1)
  const [menu,        setMenu]        = useState([])
  const [menuLoaded,  setMenuLoaded]  = useState(false)
  // Same S754 rule as floorLoadError: a failed menu read is not "No POS-enabled items".
  const [menuLoadError, setMenuLoadError] = useState('')
  // S841: the menu on screen came from the copy saved on this tablet, not from the server just now.
  const menuFromSavedRef = useRef(false)
  // S847: when the server last answered a menu read (0: never), and the read in flight, if any. The
  // menu stays on screen between tables and is re-read behind it (MENU_FRESH_MS), so a table opens
  // straight onto its dishes; one read at a time, or a tap during the floor's early read sent a second.
  const menuReadAtRef = useRef(0)
  const menuInFlightRef = useRef(null)
  // Whether Customization was on for that read: a menu read before an operator's client switches
  // loaded is not fresh once they have. And the latest loadMenu, for the floor's early read, which
  // runs from a loadFloor closure that can be as old as the mount.
  const menuReadCustomRef = useRef(null)
  const loadMenuRef = useRef(null)
  // S862 TILL-GUEST-1: the Customization switch as the latest render has it, so a menu read started
  // under the other setting, landing after the switch moved, is dropped rather than written.
  const customizationNowRef = useRef(customizationEnabled)
  customizationNowRef.current = customizationEnabled
  // Crest Customization (S758): the option groups, options and dish attachments, read with the menu
  // and cached with it for offline. Empty for a client without the module.
  const [optionCatalog, setOptionCatalog] = useState({ groups: [], options: [], attachments: [] })
  // { recipe, dishGroups, replaceKey?, initialIds? } while the choice window is open; replaceKey is the
  // line key of the cart line Change opened on (S862 TILL-GUEST-3: by key, as the cart can move meanwhile).
  const [optionPicker, setOptionPicker] = useState(null)
  // Combos (S839): { combo } while a combo's picks are being chosen, or { combo, swap: { lineId,
  // groupId }, initialPicks } while one dish of a combo on the cart is being swapped.
  const [comboPicker, setComboPicker] = useState(null)
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
  // S833: who closed it, when it was another login's earlier try on this tablet rather than another till.
  const [closedElsewhereBy, setClosedElsewhereBy] = useState(null)
  // "Served" on the order screen, in flight.
  const [servingTickets, setServingTickets] = useState(false)
  const [catTab,      setCatTab]      = useState('All')
  const [menuSearch,  setMenuSearch]  = useState('')
  const [saving,      setSaving]      = useState(false)
  const [msg,         setMsg]         = useState('')
  // categories that route to BOT — loaded from settings, default to ['Beverage']
  const [botCategories, setBotCategories] = useState(new Set(['Beverage']))
  // S835: whether the screen may SHOW routing yet (the BOT button, a sent line's station). Until the
  // settings read or the offline copy lands, the default above would flash a BOT on a no-bar till.
  // Sending still routes by whatever is known, the built-in default included (S809 3m).
  const [routingShown, setRoutingShown] = useState(false)
  const [outletName,    setOutletName]    = useState('')
  const [notePresets,   setNotePresets]   = useState([])
  const [noteFocusIdx,  setNoteFocusIdx]  = useState(null)
  // S854: the cart line whose "+ Note" was tapped, by line key, until its box is left empty.
  const [noteOpenKey,   setNoteOpenKey]   = useState(null)
  // ME-driven suggestion chips
  const [suggestions,       setSuggestions]       = useState([])
  const [manualSuggestions, setManualSuggestions] = useState({}) // { recipeId: [suggestedRecipeId] }

  /* ── billing / invoice settings (loaded once per client) ── */
  const [billingSettings, setBillingSettings] = useState({
    is_vat_registered: true, invoice_prefix: '', vat_number: '', property_address: '', property_phone: '', payment_qr_data: '',
    delivery_partners: [],
  })
  // S809 2a (ORDER-FLOW-1 / CHECKOUT-9): whether the settings above came from a read that ANSWERED in
  // this visit. Charge, Complimentary, the Billing station's Bill and a Recent Bills reprint wait for it
  // (closeStartRefusal in tillBillChecks.js says why a cached copy does not count). `settingsFailure`
  // is `{ cachedRouting }` once a read has failed or stalled, and drives the notice on the floor and
  // the order screen; the till keeps asking until a read lands (the retry effect below).
  const [billingSettingsLoaded, setBillingSettingsLoaded] = useState(false)
  const [settingsFailure, setSettingsFailure] = useState(null)
  const [settingsReading, setSettingsReading] = useState(false)
  const settingsReqSeq = useRef(0)
  const settingsInFlightRef = useRef(null)
  const cacheAppliedForRef = useRef(null)
  const loadTillSettingsRef = useRef(null)

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
  // { costOf(line) → food cost per plate, choices included; unsaved(line) } from loadCompCosts, read when
  // the payment window opens; null until then (posLineCosts).
  const [compCosting, setCompCosting] = useState(null)
  const [compCostFailed, setCompCostFailed] = useState(false) // S834: that read failed, so no comp figure is shown
  // Item-level comp (Pay tab, Supervisor+) — { [recipe_id]: qty comped }, excluded from this bill
  // and printed on a separate mini Complimentary Slip instead, while the rest (the remaining qty
  // on that same line, if any) bills normally. Distinct from the whole-order Complimentary tab.
  // Keyed by lineKeyOf (recipe id, plus the customization when there is one), not the item row's
  // own id — cart items freshly added this session (via addItem()) never carry a real
  // pos_order_items.id until re-fetched from the DB, so keying on .id meant every item shared the
  // same `undefined` key and toggling one ticked them all. The line key is safe: addItem() always
  // merges a re-tapped line into its existing row, so it's unique per order regardless of whether
  // the row has synced yet. A qty less than the line's full qty is a partial comp — closeOrder
  // splits that line's DB row in two (paid remainder + a new comped row) rather than marking the
  // whole thing comped.
  const [compQtyByLine, setCompQtyByLine] = useState({})
  const [itemCompReason, setItemCompReason] = useState('')
  const [itemsExpanded,  setItemsExpanded]  = useState(false) // collapsed by default — see render site
  // S846: "Adjust this bill" — member card, buyer details, discount, points, comps and share slips
  // behind one fold, so the payment method is the first thing under the amount. Folded on every new
  // bill (openBilling); opened by pressClose when Confirm needs a field inside it, and by a card
  // number that finds a member. Buyer details that a bill REQUIRES render outside it, open.
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [discountMode,    setDiscountMode]    = useState('amount') // 'amount' | 'percent'
  const [discountStr,     setDiscountStr]     = useState('')
  const [discountReason,  setDiscountReason]  = useState('')
  const [discountReasons, setDiscountReasons] = useState(DEFAULT_DISCOUNT_REASONS)
  // S843: the customer the bill's phone (or a member card number) finds, with their card type — for
  // the member discount and the credit-limit warning (memberDiscount.js). `memberDismissedFor` is the
  // customer whose member discount the cashier took off, so it is not filled in again on this bill.
  const [billCustomer,       setBillCustomer]       = useState(null)
  const [billCustomerMsg,    setBillCustomerMsg]    = useState('')
  const [memberCardStr,      setMemberCardStr]      = useState('')
  const [memberDismissedFor, setMemberDismissedFor] = useState(null)
  const [outletHasCards,     setOutletHasCards]     = useState(false)
  const [creditOwedBefore,   setCreditOwedBefore]   = useState(null) // what the customer already owes on Credit
  const [creditOwedMsg,      setCreditOwedMsg]      = useState('')
  // Pulling an already-fired line: the open prompt, the reason being typed into it, and the reason
  // that then rides along with the NEXT save. One reason covers one save rather than one line —
  // a save is one deliberate act, and asking twice for the same edit reads as a malfunction.
  const [pullPrompt, setPullPrompt] = useState(null)
  const [pullReason, setPullReason] = useState('')
  const [kotPullReason, setKotPullReason] = useState('')
  const [hscMap,      setHscMap]      = useState({}) // { recipeId: hscCode } — fetched once when Billing modal opens
  const [openShiftId, setOpenShiftId] = useState(null) // cached, not queried per-close — see loadOpenShift()
  // The per-bill dynamic payment QR is `billQrUrl`, from useBillQr below the payable figures it encodes.

  // Split payment — multiple tenders collected against one order/one invoice (not a split bill;
  // see [[Split Payment (multi-tender) for POS Charge]] plan). tenders: [{ method, amount, tenderedAmount }]
  const [splitMode,    setSplitMode]    = useState(false)
  const [tenders,       setTenders]     = useState([])
  // S854: the booking deposit the bill in the payment window may use (loadOrderDeposit: the one of the
  // booking seated on it, with its balance), and whether that read failed. Its Deposit line is written
  // on the open bill by apply_booking_deposit at Charge time, as points are redeemed, so an abandoned
  // bill holds nothing; liveDepositRef names the order while such a line MAY stand, set before the call.
  const [orderDeposit, setOrderDeposit] = useState(null)
  const [depositReadFailed, setDepositReadFailed] = useState(false)
  const liveDepositRef = useRef(null)
  const depositReadForRef = useRef(null)
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
  // { orderId, tenders }: the payments on screen when the save before a Charge was refused (S809
  // CHECKOUT-15) — another tablet changed the order, or a dish went off the menu. The refusal closes the
  // payment window and openBilling starts blank, so the cashier had to remember every amount already
  // taken. The next openBilling of the SAME order brings them back (and uses them up); another order or
  // a close forgets them. A Loyalty tender is never kept: the refusal hands its points back, and Charge
  // redeems them again once the cashier re-adds them.
  const refusedTendersRef = useRef(null)

  // The billing modal's two columns need a breakpoint, and an inline style cannot carry a media
  // query while PosOrders imports no stylesheet of its own (S754) — so the width is state. Below
  // 900px the fixed 418px preview column left a phone or portrait tablet a squeezed payment form.
  const [narrowBilling, setNarrowBilling] = useState(() => typeof window !== 'undefined' && window.innerWidth < 900)
  const [billPreviewOpen, setBillPreviewOpen] = useState(false)
  // The order screen's own breakpoint (S776), state for the same reason. Below 700px the fixed 320px
  // cart left a 70px menu column at 390px wide, with the cart overlapping the tiles and a tap on a
  // tile's centre landing on the cart. There the menu takes the width and the cart is a sheet at the
  // bottom: total and actions always showing, the lines one tap away.
  const [narrowTill, setNarrowTill] = useState(() => typeof window !== 'undefined' && window.innerWidth < 700)
  const [cartOpen, setCartOpen] = useState(false)
  useEffect(() => {
    const onResize = () => setNarrowTill(window.innerWidth < 700)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
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
  // S809 3f (ORDER-FLOW-6, owner decision Q16): the Wi-Fi can be up with no internet behind it, and the
  // browser then still says online. A send, an upload or a floor read that got no answer at all marks the
  // internet down for LINK_DOWN_MS (offlineUpload.js): until then a send goes straight to the offline
  // queue and prints, and a table opens from this till's own copy, as when the browser says offline.
  // Any answer from the server clears it; the upload retry and the floor poll are what ask again.
  const linkDownUntilRef = useRef(0)
  const [linkDown, setLinkDown] = useState(false)
  const noteLinkDown = () => { linkDownUntilRef.current = Date.now() + LINK_DOWN_MS; setLinkDown(true) }
  const noteLinkUp = () => { linkDownUntilRef.current = 0; setLinkDown(false) }
  const tillOffline = () => !navigator.onLine || Date.now() < linkDownUntilRef.current
  // S841 (owner decision 2026-10-15): one table or takeaway opens from a tap at a time. The id being
  // opened; a tap while it is set is ignored and that tile says "Opening…". Before this, a second tap
  // (or a tap on another table) raced the first, and whichever answer landed last took the screen: a
  // slow read for T3 could replace T5's open order and the dishes just added to it.
  // S842: the latest addItem, for the memoised menu grid (MenuGrid.jsx): its tiles call through this
  // ref, so the grid never holds a stale closure and never sees a new function on a keystroke.
  const addItemRef = useRef(null)
  addItemRef.current = addItem
  const openingRef = useRef(null)
  const [openingId, setOpeningId] = useState(null)
  const openOnce = async (id, run) => {
    if (openingRef.current) return
    openingRef.current = id
    setOpeningId(id)
    try { return await run() } finally { openingRef.current = null; setOpeningId(null) }
  }
  // S837, kitchen and bar printers: a station slip goes to that station's print device when one is
  // online (docs/kitchen-printers.md), and through this till's print window otherwise, as before.
  const stationPrint = useStationPrinting({ clientId, isOffline: tillOffline, printHtml })
  // S833: and while it is marked down, a small read every LINK_PROBE_MS asks whether it is back, rather
  // than every send waiting out the whole LINK_DOWN_MS. Any answer ends it and uploads what waits.
  useEffect(() => {
    if (!linkDown) return
    let busy = false
    const probe = setInterval(async () => {
      if (busy || !navigator.onLine) return
      busy = true
      try {
        const res = await bounded(scopedFrom('pos_tables', 'id').limit(1), 'Checking the internet', LINK_PROBE_MS - 500)
        if (!noAnswer(res)) { noteLinkUp(); void flushRef.current?.() }
      } finally { busy = false }
    }, LINK_PROBE_MS)
    return () => clearInterval(probe)
  }, [linkDown]) // eslint-disable-line react-hooks/exhaustive-deps
  // S833 (POS_TODO B3): an entry the upload keeps for a reason other than the connection (a refused read,
  // a failure on this device) used to say "kept on this till" for ever, the reason only in the console.
  // After UPLOAD_TROUBLE_TRIES in a row the floor names it; it goes once the entry uploads or is settled.
  const uploadTriesRef = useRef(new Map())
  const keptErrorRef = useRef(null)
  const [uploadTrouble, setUploadTrouble] = useState([])
  const noteUploadTrouble = (q, err) => {
    const oid = queuedOrderId(q)
    if (!err) {
      if (uploadTriesRef.current.delete(oid)) setUploadTrouble(prev => prev.filter(t => t.orderId !== oid))
      return
    }
    const tries = (uploadTriesRef.current.get(oid) || 0) + 1
    uploadTriesRef.current.set(oid, tries)
    if (tries < UPLOAD_TROUBLE_TRIES) return
    const item = { orderId: oid, where: q.table_name || 'A takeaway', text: errorText(err, 'staff') }
    setUploadTrouble(prev => [...prev.filter(t => t.orderId !== oid), item])
  }
  // What this till's queue holds for this outlet and is still to upload (conflicts excluded), and how many
  // entries it holds for another outlet, which an upload leaves alone (ORDER-FLOW-15). applyQueueCounts.
  const [waitingUploads, setWaitingUploads] = useState(0)
  const [foreignQueued,  setForeignQueued]  = useState(0)
  // The order whose cart on screen came from this till's queued copy, or was saved into it. Only that
  // screen takes the version an upload of the order leaves: a cart read from the server lacks what was
  // waiting, and saved at the new version it would delete those dishes (review of 3f).
  const screenQueueRef = useRef(null)
  // Mirror of conflictOrders' ids for loadFloor/openTable, which run inside flushPosOrderQueue's
  // closure where the state is stale (S754). A conflict entry is a bill closed elsewhere — it must
  // not be painted onto the floor as a live order.
  const conflictIdsRef = useRef(new Set())
  // S754 (owner decision): "Start new order with these" on a conflict entry. Holds that entry's
  // order_id while its items sit, unsent, on the order screen; the entry is discarded only once
  // that screen's order SAVES online (performSave), and the hold is dropped by backToFloor — so
  // backing out, or a failed save, leaves the conflict on the floor to try again.
  const conflictRecoveryRef = useRef(null)
  // S854: the ← ask when the cart has unsaved changes, { n } while open (requestBackToFloor).
  const [leavePrompt, setLeavePrompt] = useState(null)
  const [floorMsg,        setFloorMsg]        = useState('') // transient floor-view banner (e.g. blocked-table message)
  // The floor notices behind their one summary line (two or more at once, after an outage): shown or not.
  const [floorNoticesOpen, setFloorNoticesOpen] = useState(false)
  // The till notice (TillNotice.jsx, 2026-10-15 audit): a refusal that stands until ✕, in every view and
  // above any dialog. `id` moves with each notice, so the same words raised again are announced again,
  // and a newer notice replaces the older one.
  const [tillNotice,      setTillNotice]      = useState(null)
  const showTillNotice = text => setTillNotice(prev => ({ id: (prev?.id || 0) + 1, text }))
  // Bills closed on this till whose sales did not reach Inventory, as [{ orderId, at }] (noteImsMiss), so
  // the floor banner shows them at once rather than after the next floor load. A floor load whose count
  // answers prunes every miss noted before that count started (pruneImsMisses, S809 4e): the database's
  // count is the truth for those. It used to be a counter only Post to Inventory reset.
  const [imsMisses,       setImsMisses]       = useState([])
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
  // S815 4g (Q19 c): the part of the balance earned on unpaid Credit bills, spendable once each is
  // settled; and the customer's scheme (null when in none), so the window can say what this bill earns.
  const [loyaltyHeld, setLoyaltyHeld] = useState(0)
  // S835: points this customer has put on another bill that is still open ([{ points, orderNo,
  // tableName }]). They are already out of the balance, so the window names where they are.
  const [loyaltyOnOtherBills, setLoyaltyOnOtherBills] = useState([])
  const [loyaltyScheme, setLoyaltyScheme] = useState(null)
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
  // Close attempts whose write went out and whose answer never came back (S776), by order id: set just
  // before the close write and cleared once the outcome is KNOWN. While one names the bill on screen,
  // "already closed" may be this till's own write, so the bill is read back (settleUnknownClose) before
  // another till is blamed or the payment is taken again. A ref for closingRef's reason.
  // Since S809 CHECKOUT-7 each attempt also keeps what it sent (`sent`, see newCloseAttempt) and how many
  // of its writes are still travelling, and it outlives Cancel and the order screen: until a read settles
  // it either way, its payment controls stay locked and the floor marks its table (unsettledCloses).
  // Since S833 they are kept on the tablet too (closeAttemptStore.js), so a reload, leaving Orders or a PIN
  // lock no longer forgets them. Another login's kept try (owner decision, 2026-10-13) sits apart in
  // foreignCloseRef: it locks that bill's payment, names who pressed, and is only ever read, never finished.
  const closeAttemptRef = useRef(new Map())
  const foreignCloseRef = useRef(new Map())
  const [unsettledCloses, setUnsettledCloses] = useState([])
  const closeAttemptFor = oid => (oid && closeAttemptRef.current.get(oid)) || null
  const foreignCloseFor = oid => (oid && foreignCloseRef.current.get(oid)) || null
  const showUnsettledCloses = () => setUnsettledCloses([...closeAttemptRef.current.values(), ...foreignCloseRef.current.values()])
  const keepCloseAttempts = () => keepOwnCloseAttempts({
    profileId: profile?.id, profileName: profile?.full_name || '', clientId, attempts: [...closeAttemptRef.current.values()],
  })
  const setCloseAttempt = (oid, attempt) => {
    if (attempt) closeAttemptRef.current.set(oid, attempt)
    else closeAttemptRef.current.delete(oid)
    keepCloseAttempts()
    showUnsettledCloses()
  }
  const dropForeignClose = (mark, { forEveryone = false } = {}) => {
    foreignCloseRef.current.delete(mark.orderId)
    if (forEveryone) dropKeptCloseAttempt({ profileId: mark.profileId, clientId, orderId: mark.orderId })
    showUnsettledCloses()
  }
  // The tries this tablet kept, read back once the login and outlet are known: this login's own carry on
  // as marks; another login's lock their bill until read. The 15 s poll below settles both.
  useEffect(() => {
    if (!clientId || !profile?.id) return
    const { own, foreign } = restoreCloseAttempts({ profileId: profile.id, clientId, writeLimitMs: CLOSE_STEP_MS })
    for (const a of own) if (!closeAttemptRef.current.has(a.orderId)) closeAttemptRef.current.set(a.orderId, a)
    foreignCloseRef.current = new Map(foreign.filter(f => !closeAttemptRef.current.has(f.orderId)).map(f => [f.orderId, f]))
    showUnsettledCloses()
  }, [clientId, profile?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // Every 15 s while any attempt is unsettled, it is read again (pollUnsettledCloses), wherever the till
  // is. Through a ref, so the interval always runs the current render's closure.
  const closePollRef = useRef(null)
  closePollRef.current = pollUnsettledCloses
  const closePollBusyRef = useRef(false)
  useEffect(() => {
    if (unsettledCloses.length === 0) return
    const poll = setInterval(() => closePollRef.current?.(), 15000)
    return () => clearInterval(poll)
  }, [unsettledCloses.length])
  // What a close is doing right now, for the Confirm button's label ("Printing…") — a close is several
  // round trips, and "Processing…" for all of them said nothing about which one was slow.
  const [closeStep, setCloseStep] = useState('')
  // Re-entry guard for performSave — the send paths are only gated by the `saving` state,
  // which doesn't update synchronously, so a double-tap on Send Order before the re-render commits
  // can enter performSave twice with orderId still null and insert two pos_orders rows. A ref for
  // the same reason as closingRef above: it needs to be readable/settable synchronously mid-call.
  const savingRef = useRef(false)
  // S833: the cart as it stood when the save in flight was pressed (cartKeyMap), so ← can tell what that
  // save already carries — it lands and prints whether or not the waiter stays — from what changed after.
  const sendingCartRef = useRef(null)
  // S862 TILL-GUEST-3: the line keys the save in flight sends to a station (none for a hold), so a
  // Change answered meanwhile on one of them adds a dish of its own instead of replacing the one sent.
  const sendingKeysRef = useRef(null)
  // S809 ORDER-FLOW-3, -4 (3e): saves of an order whose answer has not come back, by order id, oldest
  // first (sendAttempt.js). Each save is marked just before it goes out and the mark is dropped once its
  // answer is known, so a stale refusal, a reopened order and the 15 s poll below can tell this till's
  // own landed save from another device's change. Memory only, like closeAttemptRef: a lock or a reload
  // forgets them. The count is of saves that got no answer, so the poll runs only while one is waiting.
  const sendAttemptRef = useRef(new Map())
  const [unsettledSendCount, setUnsettledSendCount] = useState(0)
  const sendAttemptsFor = oid => (oid && sendAttemptRef.current.get(oid)) || []
  const putSendAttempts = (oid, list) => {
    if (list.length > 0) sendAttemptRef.current.set(oid, list)
    else sendAttemptRef.current.delete(oid)
    setUnsettledSendCount([...sendAttemptRef.current.values()].flat().filter(a => a.finalAfter != null).length)
  }
  const sendSettlingRef = useRef(new Set())
  const sendPollBusyRef = useRef(false)
  const sendPollRef = useRef(null)
  sendPollRef.current = pollUnsettledSends
  useEffect(() => {
    if (unsettledSendCount === 0) return
    const poll = setInterval(() => sendPollRef.current?.(), 15000)
    return () => clearInterval(poll)
  }, [unsettledSendCount])
  // ORDER-FLOW-5 (3e): moves on every return to the floor, so a save that answers after the waiter left
  // its order leaves the screen now showing alone (watchScreen); and the order the order screen showed at
  // the last render, for a settle that ends later.
  const screenTokenRef = useRef(0)
  const screenOrderRef = useRef(null)
  screenOrderRef.current = view === 'order' ? orderId : null
  // ORDER-FLOW-14 (3e): the cover count as last loaded or saved, and for which order.
  const coversSavedRef = useRef({ orderId: null, covers: null })
  // Billing station handoff (S762). billOnOpenRef is armed by billOrder() and consumed inside
  // showLoadedOrder — the ONE funnel every "put an existing order on screen" path goes through, so
  // no branch of openTable/openOrderById can arm it by accident. It is a ref (read/written
  // synchronously mid-call) that hands off to a state flag, because openBilling() reads orderItems
  // and that state has not committed yet at the moment showLoadedOrder runs; the effect below fires
  // once it has.
  const billOnOpenRef = useRef(false)
  const [billOnLoad, setBillOnLoad] = useState(false)

  useEffect(() => {
    if (!clientId) return
    loadFloor()
    // S809 2a: another client's settings (an admin's "view as" switch) are not this one's.
    setBillingSettingsLoaded(false); setSettingsFailure(null); setRoutingShown(false)
    cacheAppliedForRef.current = null
    loadTillSettings()
    if (navigator.onLine) flushRef.current?.()
  }, [clientId]) // eslint-disable-line

  // Puts one settings row on the till: a read that answered, or the offline copy. A routing list that
  // was never set is the built-in default (Beverage to the bar), as at first load, and an empty one
  // means no bar (S809 3m, Q15) — so a fresh read after the offline copy cannot leave the copy's
  // routing standing.
  function applyTillSettings(data, outlet) {
    setBotCategories(new Set(barCategoriesOf(data?.pos_bot_categories)))
    setRoutingShown(true)
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
    setOutletName(outlet || '')
  }

  // The offline copy, applied once per client: it carries ticket routing and the screen's totals
  // while no read has answered. Never Payment (billingSettingsLoaded stays false). Returns whether
  // the copy carries the outlet's routing, for the notice's wording.
  async function applyCachedTillSettings(forClient, seq) {
    const cached = await getCachedPosSettings(forClient).catch(() => null)
    if (!cached || seq !== settingsReqSeq.current) return false
    if (cacheAppliedForRef.current !== forClient) {
      cacheAppliedForRef.current = forClient
      applyTillSettings(cached, cached.outlet_name)
    }
    return cacheCarriesRouting(cached)
  }

  // S809 2a (ORDER-FLOW-1 / CHECKOUT-9). Both errors are read and both reads are bounded. Only a
  // read that answered is applied as fresh and cached; a failed or stalled one leaves the offline
  // copy in use, raises the notice and keeps Payment refused, and the retry effect asks again.
  // Offline is not a failure: billing is refused offline anyway, and the Offline banner says so.
  async function loadTillSettings() {
    const forClient = clientId
    if (!forClient || settingsInFlightRef.current === forClient) return
    const seq = ++settingsReqSeq.current
    settingsInFlightRef.current = forClient
    try {
      if (!navigator.onLine) { await applyCachedTillSettings(forClient, seq); return }
      setSettingsReading(true)
      const [settingsRes, clientRes] = await Promise.all([
        bounded(supabase.from('settings')
          .select('pos_bot_categories, pos_note_presets, pos_discount_reasons, is_vat_registered, invoice_prefix, vat_number, property_address, property_phone, payment_qr_data, pos_delivery_partners, pos_reservation_settings')
          .eq('client_id', forClient).maybeSingle(), 'Loading the till settings', TILL_SETTINGS_READ_MS),
        bounded(supabase.from('clients').select('name').eq('id', forClient).single(), 'Loading the outlet name', TILL_SETTINGS_READ_MS),
      ])
      if (seq !== settingsReqSeq.current) return
      const read = tillSettingsReadOutcome(settingsRes, clientRes)
      if (!read.ok) {
        console.error('POS till settings read failed:', read.error)
        const cachedRouting = await applyCachedTillSettings(forClient, seq)
        if (seq !== settingsReqSeq.current) return
        // The same failure again keeps the same object, so each 15 s retry does not rebuild the notice.
        setSettingsFailure(prev => (prev?.cachedRouting === cachedRouting ? prev : { cachedRouting }))
        return
      }
      applyTillSettings(read.settings, read.outletName)
      setBillingSettingsLoaded(true)
      setSettingsFailure(null)
      // A refusal this state put on screen (Payment, the Billing station's Bill) is no longer true.
      const stale = [true, false].map(f => `error:${tillSettingsBlockText(f)}`)
      setMsg(m => (stale.includes(m) ? '' : m))
      setFloorMsg(m => (stale.includes(m) ? '' : m))
      cachePosSettings(forClient, { ...read.settings, outlet_name: read.outletName })
        .catch(err => console.error('POS settings offline copy not saved:', err))
    } finally {
      // S835: answered or not, the till now routes by what it has (no copy: the built-in default).
      if (seq === settingsReqSeq.current) { settingsInFlightRef.current = null; setSettingsReading(false); setRoutingShown(true) }
    }
  }
  loadTillSettingsRef.current = loadTillSettings

  // Until a settings read lands, the till keeps asking: every 15 s on any screen, on arriving at
  // another screen, and the moment the connection comes back. Through the ref, as the floor poll is.
  useEffect(() => {
    if (billingSettingsLoaded || !clientId) return
    const retry = () => { if (navigator.onLine) loadTillSettingsRef.current?.() }
    if (settingsFailure) retry()
    const poll = setInterval(retry, TILL_SETTINGS_RETRY_MS)
    window.addEventListener('online', retry)
    return () => { clearInterval(poll); window.removeEventListener('online', retry) }
  }, [billingSettingsLoaded, clientId, view]) // eslint-disable-line

  // S842: the three 5-second checks (the floor's kitchen badges, the open order's tickets, guest orders).
  // None runs while the link is down (tillOffline(): the Wi-Fi can be up with no internet behind it),
  // each read is bounded (SEND_READ_MS), and one still waiting is not started again. During an outage
  // they stacked two or three hung requests every 5 s, and an older answer landing last could turn a
  // table's Ready back to Started.
  const pollBusyRef = useRef({})
  const pollOnce = (key, run) => {
    if (tillOffline() || pollBusyRef.current[key]) return
    pollBusyRef.current[key] = true
    void Promise.resolve().then(run).catch(err => console.error(`${key} check failed:`, err))
      .finally(() => { pollBusyRef.current[key] = false })
  }
  // The order whose tickets are on screen (S842): a ticket read that answers after another order
  // opened is dropped rather than drawn on it.
  const ticketsOrderRef = useRef(null)

  // Keeps the floor-view Sent/Started/Ready badges live while a staff member is just looking at
  // the board (not tapping into a table, which is the only other time loadFloor/loadKotStatus run).
  useEffect(() => {
    if (view !== 'floor') return
    const poll = setInterval(() => pollOnce('kitchen badges', () => loadKotStatus()), 5000)
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
    if ((view !== 'floor' && view !== 'bills') || !clientId) return
    // Through a ref, not the closure: this interval lives for the whole floor visit, and a loadFloor
    // captured at mount would compute tile totals with the default VAT flag before settings load.
    if (floorViewSeen.current && navigator.onLine && Date.now() - lastFloorLoadAt.current > 2000) loadFloorRef.current?.({ quiet: true })
    floorViewSeen.current = true
    const poll = setInterval(() => { if (navigator.onLine) loadFloorRef.current?.({ quiet: true }) }, 15000)
    return () => clearInterval(poll)
  }, [view, clientId]) // eslint-disable-line

  // "open 18 min" on the Billing list has to move on its own — the floor poll's setIfChanged
  // suppresses a re-render when nothing in the DATA changed, and the clock is not in the data.
  useEffect(() => {
    if (view !== 'bills') return
    const tick = setInterval(() => setKotNow(Date.now()), 30000)
    return () => clearInterval(tick)
  }, [view])

  // The second half of the Billing station handoff: the order is on screen and its items have
  // committed, so the payment window can open on the real cart (openBilling reads orderItems for
  // the HSC codes that print on the Tax Invoice — called a tick earlier it would read an empty one
  // and the bill would go out short with nothing saying so).
  useEffect(() => {
    if (!billOnLoad) return
    if (view !== 'order' || !orderId) return
    setBillOnLoad(false)
    openBilling()
  }, [billOnLoad, view, orderId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keeps each cart line's KOT/BOT timer live while the order screen for a saved order is open.
  // A brand-new, not-yet-sent order (orderId still null) has no tickets to poll for.
  useEffect(() => {
    ticketsOrderRef.current = view === 'order' ? orderId : null
    // Another order's tickets never stay on this one's lines, online or not (S842).
    setOrderKotTickets(prev => (prev.length ? [] : prev))
    if (view !== 'order' || !orderId) return
    loadOrderKotTickets(orderId)
    const poll = setInterval(() => pollOnce('order tickets', () => loadOrderKotTickets(orderId)), 5000)
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
    const poll = setInterval(() => pollOnce('guest orders', () => loadPendingGuestOrders()), 5000)
    return () => clearInterval(poll)
  }, [view, clientId]) // eslint-disable-line

  // S809 3c (FLOOR-KITCHEN-1, S809.4): the app-wide guest-order alert hears from this screen which
  // view is up and which waiting guest orders this till holds (accepted into the cart, saved but not
  // marked yet, or held while the "changed on another device" box is open). Some of those live in
  // refs, so this runs after every render; a publish that changes nothing notifies nobody.
  useEffect(() => {
    publishTillGuestView({
      view,
      openTableId: view === 'order' ? activeTable?.id : null,
      heldIds: [...acceptedGuestReqIdsRef.current, ...unmarkedGuestAcceptsRef.current.keys(), ...staleGuestReqIdsRef.current],
    })
  })
  useEffect(() => clearTillGuestView, [])
  // The floor's banner carries the alert's Mute, since the shell's banner stands aside there.
  const guestAlertMute = useGuestAlertMute()

  // ORDER-FLOW-18 (S809 3b): once the "changed on another device" box is answered (or abandoned), a
  // guest order whose dishes were left off goes back on the banner for an Accept or a Dismiss.
  useEffect(() => {
    if (staleRecovery || staleGuestReqIdsRef.current.size === 0) return
    staleGuestReqIdsRef.current = new Set()
    loadPendingGuestOrders()
  }, [staleRecovery]) // eslint-disable-line react-hooks/exhaustive-deps

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

  // S809 3f (Q16): the browser never fires 'online' when only the internet came back, so whatever waits
  // in the queue is tried again every UPLOAD_RETRY_MS, wherever the till is (one upload at a time).
  useEffect(() => {
    if (waitingUploads === 0) return
    const retry = setInterval(() => { if (navigator.onLine) flushRef.current?.() }, UPLOAD_RETRY_MS)
    return () => clearInterval(retry)
  }, [waitingUploads])

  /* ── computed totals ── */
  // Non-VAT-registered clients print a plain PAN Bill with no VAT line (see buildBillHtml's
  // `vatReg` gate) — the live cart/payment totals must honor the same flag, or the amount
  // charged/tendered on screen drifts from the amount on the printed bill.
  const vatReg   = billingSettings.is_vat_registered
  const subEx    = orderItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
  const vatAmt   = vatReg ? orderItems.reduce((s, i) => s + i.qty * i.unit_price * (i.vat_rate ?? 0), 0) : 0
  const total    = Math.round(subEx + vatAmt) // rounded to the nearest rupee — matches the bill's Net Amount/Round Off line
  const compPlateCost = i => (compCosting ? compCosting.costOf(i) : 0)
  const compTotal = orderItems.reduce((s, i) => s + i.qty * compPlateCost(i), 0)
  // A dish whose choices were picked after the last save: their stock lines are written by the server
  // when it saves the line, so they are not in the figure on screen. The close saves first, and the
  // slip is costed from the stored lines, so the printed figure has them.
  const compChoicesUnsaved = !!compCosting && orderItems.some(i => compCosting.unsaved(i))

  // Item-level comp — only ever populated in the Pay tab, so `subEx`/`vatAmt`/`total`/`compTotal`
  // above (used by the Void and whole-order Complimentary tabs) stay exactly as they were: full
  // order, unaffected. The Pay tab's own totals are computed separately from the non-comped subset.
  // A line with a partial comp qty (less than its full qty) contributes to BOTH arrays below —
  // e.g. "3 x Veg Momo" with 1 comped becomes a comped row of qty 1 and a payable row of qty 2.
  const compedOrderItems = orderItems
    .filter(i => (compQtyByLine[lineKeyOf(i)] || 0) > 0)
    .map(i => ({ ...i, qty: Math.min(compQtyByLine[lineKeyOf(i)], i.qty) }))
  const payableOrderItems = orderItems
    .map(i => {
      const compQty = Math.min(compQtyByLine[lineKeyOf(i)] || 0, i.qty)
      return compQty > 0 ? { ...i, qty: i.qty - compQty } : i
    })
    .filter(i => i.qty > 0)
  const itemCompFoodCost  = compedOrderItems.reduce((s, i) => s + i.qty * compPlateCost(i), 0)
  const itemCompChoicesUnsaved = !!compCosting && compedOrderItems.some(i => compCosting.unsaved(i))
  // A comped combo counts once, however many dishes it has (S839).
  const itemCompCount     = cartRows(compedOrderItems).length
  const hasItemComp       = itemCompCount > 0
  // Every item comped out — nothing left to actually bill. Confirm Payment gets blocked for this
  // (see closeOrder's guard) rather than issuing a real ₨0 Tax Invoice/PAN Bill with zero line
  // items, which would waste a sequential invoice number on an empty document — the
  // whole-order Complimentary tab already exists for exactly this case.
  const allItemsComped    = orderItems.length > 0 && payableOrderItems.length === 0
  const paySubEx     = payableOrderItems.reduce((s, i) => s + i.qty * i.unit_price, 0)

  // Discount reduces the pre-VAT taxable base, then VAT is recalculated on the discounted amount
  // (same rule as purchase_entries.discount_amount in Purchases.js) — not a flat subtraction off total.
  // Non-admin/owner logins with a manager-set discount cap (`profile.pos_discount_limit`, a %,
  // null = unlimited) can never exceed it here regardless of whether they typed a flat ₨ amount or
  // a %, so the two entry modes stay consistent.
  //
  // S839 (owner decision): a bill discount never touches a combo, which is already a deal. The percent,
  // the amount cap and the cashier's limit are all of the DISCOUNTABLE subtotal (the payable lines less
  // combo dishes) — the base guard_pos_order_close measures the cap against, and refuses a discount above
  // (discount_on_combo). On a bill with no combo it is paySubEx, exactly as before.
  const discountCapPct = (!isAdmin && !isOwner) ? profile?.pos_discount_limit : null
  const discountBase = discountableSubtotal(payableOrderItems)
  const comboOnlyBill = paySubEx > 0 && discountBase <= 0 && payableOrderItems.some(isComboItem)
  const discountAmt = (() => {
    const v = parseFloat(discountStr) || 0
    if (v <= 0 || discountBase <= 0) return 0
    const raw = discountMode === 'percent' ? Math.min(discountBase, discountBase * v / 100) : Math.min(discountBase, v)
    if (discountCapPct == null) return raw
    return Math.min(raw, discountBase * (discountCapPct / 100))
  })()
  const discountClamped = discountCapPct != null && discountBase > 0 && (() => {
    const v = parseFloat(discountStr) || 0
    const effectivePct = discountMode === 'percent' ? v : (v / discountBase * 100)
    return effectivePct > discountCapPct
  })()
  // The bill's figures through the one bill-math primitive (S580), so the paid_amount stored here is
  // computeOrderAmounts' net — what the printed bill, the credit-note guard and every report compute.
  // With no combo it is the same arithmetic this screen always ran (subtotal − discount + VAT on the
  // discounted base, to the rupee); with one, each line keeps its own share of the discount (0 for a combo dish).
  const payTotal  = computeOrderAmounts({ discount_amount: discountAmt }, payableOrderItems, vatReg).net
  // The same lines before the discount (S854): the heading's "667 − 67 off" adds up, because a discount
  // also lowers the VAT, and dishes made free in this window are out of both figures.
  const payGross  = computeOrderAmounts({ discount_amount: 0 }, payableOrderItems, vatReg).net
  // Buyer Name + Phone become compulsory (not just optional) whenever a discount is applied, or
  // when the bill is going on Credit — both cases need an identifiable, audited record.
  const requireBuyerId = discountAmt > 0 || payMethod === 'Credit'
  // S809 2a (CHECKOUT-5, owner Q9 a): a VAT bill above the abbreviated-invoice limit names its buyer.
  const requireFullInvoice = fullInvoiceRequired({ vatReg, payTotal })

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
  // the item-comp picker lock, the same way "Single Payment" already did. Remove the tenders to edit.
  // S809 CHECKOUT-7: so is everything a close try sent while that try is unsettled — it can still land,
  // and a bill it closes is finished as it was sent. The method and tender controls lock with them.
  const closeLocked = !!orderId && unsettledCloses.some(a => a.orderId === orderId)
  const foreignClose = foreignCloseFor(orderId)
  const closeLockText = foreignClose ? foreignCloseText(foreignClose)
    : billingTab === 'pay'
      ? 'The first payment try may still go through — confirm again with the same payment, or wait for it.'
      : 'The first try may still go through — press again as it is, or wait for it.'
  const tendersLocked = tenders.length > 0 || closeLocked
  const tendersLockHint = closeLocked ? 'Locked until the till knows whether the first payment try went through.'
    : 'Payments are already recorded against this total — undo them below to change the discount or comps.'

  // S843 (owner decisions): a member's card discount fills in by itself as an ordinary bill discount
  // the cashier can take off, and the cashier's own discount limit still applies (the clamp above,
  // and guard_pos_order_close on the server — no exemption). A discount the cashier chose stays
  // theirs; one filled in for a guest no longer on the bill comes off. Nothing moves while the
  // payment is locked (tenders taken, or a close try still unsettled).
  const memberNow = memberStatus(billCustomer, todayNepalIso())
  useEffect(() => {
    if (!billingOpen || tendersLocked) return
    if (memberNow.kind !== 'active') {
      if (isMembershipReason(discountReason)) { setDiscountStr(''); setDiscountReason('') }
      return
    }
    if (memberDismissedFor && memberDismissedFor === billCustomer?.id) return
    const pctStr = pctText(memberNow.pct)
    if (discountReason === memberNow.reason && discountMode === 'percent' && discountStr === pctStr) return
    if ((parseFloat(discountStr) || 0) > 0 && !isMembershipReason(discountReason)) return
    setDiscountMode('percent'); setDiscountStr(pctStr); setDiscountReason(memberNow.reason)
  }, [billingOpen, billCustomer?.id, memberNow.kind, memberNow.reason, memberDismissedFor]) // eslint-disable-line react-hooks/exhaustive-deps

  function removeMemberDiscount() {
    if (tendersLocked) return
    setMemberDismissedFor(billCustomer?.id || null)
    if (isMembershipReason(discountReason)) { setDiscountStr(''); setDiscountReason('') }
  }
  function reapplyMemberDiscount() {
    if (tendersLocked || memberNow.kind !== 'active') return
    setMemberDismissedFor(null)
    setDiscountMode('percent'); setDiscountStr(pctText(memberNow.pct)); setDiscountReason(memberNow.reason)
  }

  // S843: a credit limit only warns (owner decision). What the customer already owes is read when a
  // bill for someone with a limit is about to go on Credit; a failed read says it could not check,
  // never that they owe nothing.
  // S852: the read waits the till's own OPEN_READ_MS and no longer. Unbounded, a hung read meant the
  // over-limit warning silently never showed. No answer is "not known": the line says the limit was
  // not checked, and the bill can still go on Credit, as it can over a limit.
  const creditLimit = billCustomer?.credit_limit
  useEffect(() => {
    if (!billingOpen || splitMode || payMethod !== 'Credit' || deliveryPartner || creditLimit == null || !billCustomer) {
      setCreditOwedBefore(null); setCreditOwedMsg(''); return
    }
    let cancelled = false
    const key = creditPartyKey({ delivery_partner: null, buyer_phone: billCustomer.phone || buyerPhone, buyer_name: billCustomer.name || buyerName })
    bounded(supabase.rpc('pos_credit_open_bills', { p_party_key: key, p_client_id: clientId }), 'Checking what this guest already owes', OPEN_READ_MS).then(({ data, error }) => {
      if (cancelled) return
      if (error) {
        const who = billCustomer.name || 'this guest'
        setCreditOwedBefore(null)
        setCreditOwedMsg(`Credit limit not checked: what ${who} already owes could not be read, so it is not known whether this bill takes them past their ${fmtNpr(creditLimit)} limit. ${isTimeout(error) ? 'The server did not answer in time.' : errorText(error, 'staff')} You can still put it on Credit.`)
        return
      }
      setCreditOwedMsg('')
      setCreditOwedBefore((data || []).reduce((s, b) => s + (Number(b.owed) || 0), 0))
    })
    return () => { cancelled = true }
  }, [billingOpen, splitMode, payMethod, deliveryPartner, billCustomer?.id, creditLimit]) // eslint-disable-line react-hooks/exhaustive-deps
  const creditWarning = creditOwedBefore == null ? null
    : creditLimitWarning({ limit: creditLimit, owed: creditOwedBefore, billTotal: payTotal })

  // Single-payment Cash: a tender below the bill total is a short drawer with no cause recorded —
  // the change line clamps to 0, so without this nothing on screen even hints. Block Confirm
  // instead (split mode already guards via `remaining`). '' means "exact cash" (see
  // resolveTendered), so only a genuinely entered number can register a shortfall.
  const cashShortfall = (!splitMode && payMethod === 'Cash' && !Number.isNaN(parseFloat(tenderedStr)))
    ? Math.max(0, payTotal - resolveTendered(payTotal))
    : 0

  // Regenerate the dynamic payment QR as the payable amount changes (discount typed, items
  // edited) — the modal QR and print preview encode the current amount once the hand pauses
  // (useBillQr: the first QR paints at once, a changed amount waits PREVIEW_DEBOUNCE_MS). In split
  // mode this targets whatever the next tender's amount is (defaulting to the remaining balance),
  // not the full order total. makeBillQr is a hoisted function declaration, so handing it over
  // here is safe even though it appears later in the file.
  const qrMethod = splitMode ? tenderMethod : payMethod
  const qrAmount = splitMode ? (parseFloat(tenderAmtStr) || remaining) : payTotal
  const billQrUrl = useBillQr({
    active: billingOpen && QR_PAY_METHODS.includes(qrMethod) && !!billingSettings.payment_qr_data && qrAmount > 0,
    amount: qrAmount,
    reference: orderNo ? `CR${orderNo}` : null,
    source: billingSettings.payment_qr_data || '',
    make: makeBillQr,
  })

  // Always the freshest closeOrder — a new function every render, closing over that render's
  // discountAmt/discountReason/buyerName/payableOrderItems/etc (closeOrder's 'paid' guards read
  // these directly, not via arguments). The poll effect below reads this ref instead of listing
  // all of those as its own dependencies, so a keystroke in an unrelated field (which changes
  // payableOrderItems's array identity on every render) no longer tears down and restarts the
  // setInterval before it ever fires — previously the poll effectively never survived a full 4s
  // tick while the modal was open and the cashier was still typing (discount, tender, etc).
  const closeOrderRef = useRef(null)
  closeOrderRef.current = closeOrder

  // ── What a till lock keeps (S776, owner decision; posLockedCart.js) ──
  // Layout fires POS_BEFORE_LOCK_EVENT just before a PIN session signs out, idle or Lock POS. This
  // screen holds the cart, so it is what keeps the lines not yet saved — for this login only — and
  // hands back a points redemption an unfinished close left standing, which nobody would be left here
  // to undo. Read through a ref for closeOrderRef's reason: the listener is registered once.
  // `reason` is 'update' when a new release reloads the till (S809 1b), so the restored lines say so.
  const beforeLockRef = useRef(null)
  beforeLockRef.current = (waitUntil, reason = 'lock') => {
    // S809 2g: not while a payment try at that bill is unsettled (landing after the handback, it would
    // close the bill paid partly in points the guest got back), nor once the login has moved outlet
    // (the server refuses it there). Left standing, the points go back when the bill next closes any
    // way but a Split charge with points (guard_pos_order_close), or the next Split charge replaces them.
    const standing = liveRedemptionRef.current?.orderId
    // S833: nor once the sign-in has ended by itself ('ended'): with no session the server refuses the
    // handback, and the close returns the points anyway.
    if (standing && reason !== 'outlet' && reason !== 'ended' && !closeAttemptFor(standing)) waitUntil(cancelLiveRedemption())
    if (view !== 'order' || !profile?.id || !clientId) return
    // Units beyond what is saved on the server. A note edit or a lowered quantity alone keeps nothing:
    // there is no line to bring back, and the saved order already holds the rest. Only the lines with
    // unsaved units are kept, each saying how many, so a restore never brings back a saved dish
    // (S809 ORDER-FLOW-10: a bill closed during the lock came back whole, as "not sent").
    const saved = savedItemsRef.current
    const items = orderItems.map(i => {
      const savedQty = parseInt(String(saved.get(lineKeyOf(i)) || '0|').split('|')[0], 10) || 0
      return { ...i, unsaved_qty: Math.max(0, (Number(i.qty) || 0) - savedQty) }
    }).filter(i => i.unsaved_qty > 0)
    const unsentUnits = items.reduce((n, i) => n + i.unsaved_qty, 0)
    // The guest QR orders accepted into this cart and not saved yet go with it (S809.4, 3c): after
    // sign-in their dishes are back in the cart, and the banner must not offer Accept for them again.
    const guestReqs = [...acceptedGuestReqIdsRef.current].map(id => ({ id, items: acceptedGuestItemsRef.current.get(id) || [] }))
    keepLockedCart({
      profileId: profile.id, profileName: profile.full_name || '', clientId,
      tableId: activeTable?.id || null, tableName: activeTable?.name || null,
      orderId: orderId || null, orderNo: orderNo || null, covers, items, unsentUnits, reason, guestReqs,
    })
  }
  useEffect(() => {
    // The reason rides along ('outlet' when the login moved and the till stopped, S809), so the lines
    // say why they were kept when they come back.
    const onBeforeLock = e => beforeLockRef.current?.(e.detail?.waitUntil || (() => {}), e.detail?.reason)
    window.addEventListener(POS_BEFORE_LOCK_EVENT, onBeforeLock)
    return () => window.removeEventListener(POS_BEFORE_LOCK_EVENT, onBeforeLock)
  }, [])

  // ── A new release (S809 1b, releaseWatch.js) ──
  // The till reloads itself on an idle floor: no dialog, nothing saving, closing or syncing, and a
  // minute untouched. When the database refuses this page as too old it reloads within seconds from
  // wherever it is, keeping the unsent cart the way a lock does; nothing was written, so nothing is
  // lost but the reload. The lines come back on this screen's next mount (takeLockedCart below).
  // Nor while a close is unsettled (S809 CHECKOUT-7): since S833 the attempt survives a reload on the
  // tablet, but a reload mid-check still cuts off the read that would settle it.
  const releaseSafe = (view === 'floor' || view === 'bills') && !saving && !closing && !billingOpen &&
    !syncingOffline && !coversModal && !recentBillsOpen && !billPreviewOpen && unsettledCloses.length === 0
  useReleaseReload(releaseSafe, RELEASE_IDLE_MS, async () => {
    const pending = []
    beforeLockRef.current?.(p => pending.push(Promise.resolve(p)), 'update')
    if (pending.length === 0) return
    await withTimeout(Promise.allSettled(pending), 5000, 'Handing work back before the update').catch(e => {
      console.error('before-update work did not finish; reloading anyway:', e)
    })
  })

  // The covers numpad answers the keyboard too (S776): digits, Backspace and Enter. It was click-only,
  // on a till that often has a keyboard. Escape stays the Modal's own; a focused button keeps its
  // own Enter, so "Open Order" is never pressed twice. The dialog opens with focus on its × button,
  // so a typed digit moves focus to Open Order — otherwise "4, Enter" closed the dialog.
  const coversConfirmRef = useRef(null)
  useEffect(() => {
    if (!coversModal) return
    const onKey = e => {
      if (e.target instanceof HTMLElement && e.target.matches('input, textarea, select')) return
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); numpadPress(e.key); coversConfirmRef.current?.focus() }
      else if (e.key === 'Backspace') { e.preventDefault(); numpadBackspace() }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLElement && e.target.matches('button'))) { e.preventDefault(); confirmCovers() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [coversModal, pendingCoversStr, pendingTable]) // eslint-disable-line react-hooks/exhaustive-deps

  // Armed by restoreLockedCart, consumed by showLoadedOrder / startFreshOrder (applyLockedCart).
  const lockedCartRef = useRef(null)
  // Once per mount, for the login now signed in. Not on the Billing station: a waiter's cart belongs
  // on the order screen, and it stays kept until they next open /pos/orders.
  const lockedCartCheckedRef = useRef(false)
  useEffect(() => {
    if (lockedCartCheckedRef.current || !clientId || !profile?.id || billingStation) return
    lockedCartCheckedRef.current = true
    const kept = takeLockedCart(profile.id, clientId)
    if (kept) restoreLockedCart(kept)
  }, [clientId, profile?.id]) // eslint-disable-line react-hooks/exhaustive-deps
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

  // No document Escape listener here (2026-10-15 audit). Billing, Covers and Recent Bills are all on
  // Modal now, whose own Escape answers only the topmost dialog. The listener this file kept from its
  // hand-rolled overlays ignored that stack, so one Escape on the Credit Note dialog also closed Recent
  // Bills beneath it (S754 had already taken Billing out of it for the same reason).

  // Look up the customer's points as soon as a phone is on the bill. Debounced because this
  // fires per keystroke on a field a cashier types ten digits into.
  //
  // S815 4g: the balance and its held part come from pos_loyalty_balances, the one place the server
  // works them out (redeem_loyalty_points asks it too), in one round trip; until then the till summed
  // the raw ledger itself. The customer's scheme comes with the customer, for the earn line.
  useEffect(() => {
    if (!billingOpen || !hasFeature('loyalty')) { setLoyaltyBalance(null); setLoyaltyLookupMsg(''); return }
    const phone = buyerPhone.trim()
    if (!phone) { setLoyaltyBalance(null); setLoyaltyLookupMsg(''); return }
    let cancelled = false
    setLoyaltyOnOtherBills([])
    // S809 3k (CUSTOMERS-PARKING-4): found by the number, however it is typed, as the server finds it.
    const key = customerPhoneKey(phone)
    const timer = setTimeout(async () => {
      const [custRes, setRes] = await Promise.all([
        scopedFrom('pos_customers', 'id, name, pos_loyalty_schemes(name, points_per_100, min_spend_to_earn, is_active)').eq(key.column, key.value).maybeSingle(),
        supabase.from('settings').select('pos_loyalty_point_value').eq('client_id', clientId).maybeSingle(),
      ])
      if (cancelled) return
      // S809 2g (CUSTOMERS-PARKING-3): an unread point value is not NPR 1 a point. At NPR 10 the screen
      // offered a tenth of what the server then charged the guest. Only a value that is not set reads
      // as 1, as the server reads it (the column default).
      if (setRes.error) { setLoyaltyBalance(null); setLoyaltyLookupMsg(`Couldn't check points. ${errorText(setRes.error, 'staff')}`); return }
      setLoyaltyPointValue(Number(setRes.data?.pos_loyalty_point_value) || 1)
      // A failed read is not 'no points' — that difference is the whole S594 rule, and here it
      // would have a cashier tell a regular to their face that they have nothing.
      if (custRes.error) { setLoyaltyBalance(null); setLoyaltyLookupMsg(`Couldn't check points. ${errorText(custRes.error, 'staff')}`); return }
      if (!custRes.data) { setLoyaltyBalance(null); setLoyaltyLookupMsg(''); return }
      const { data: rows, error: ledErr } = await supabase.rpc('pos_loyalty_balances', { p_client_id: clientId, p_customer_id: custRes.data.id })
      if (cancelled) return
      if (ledErr) { setLoyaltyBalance(null); setLoyaltyLookupMsg(`Couldn't check points. ${errorText(ledErr, 'staff')}`); return }
      setLoyaltyLookupMsg('')
      // No row: no points history yet, a balance of 0.
      setLoyaltyBalance(Number(rows?.[0]?.balance) || 0)
      setLoyaltyHeld(Number(rows?.[0]?.held) || 0)
      setLoyaltyScheme(custRes.data.pos_loyalty_schemes || null)
      // S835 (S809.4, 2g): points spent on another bill still open (an earlier try, or another till)
      // are out of the balance until that bill closes or hands them back. Named, so the cashier can
      // tell the guest where they are. Supplementary: a failed read says nothing and is logged.
      let held = scopedFrom('pos_loyalty_ledger', 'points, order_id, pos_orders!inner(order_no, table_name, status)')
        .eq('customer_id', custRes.data.id).eq('kind', 'redeem').eq('pos_orders.status', 'open')
      if (orderId) held = held.neq('order_id', orderId)
      const { data: heldRows, error: heldErr } = await held
      if (cancelled) return
      if (heldErr) { console.error('POS loyalty: points on other open bills not read:', heldErr); return }
      setLoyaltyOnOtherBills(pointsOnOtherBills(heldRows))
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [billingOpen, buyerPhone, clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── S843: members and credit limits ─────────────────────────────────────────────────────────────
  // Does this outlet give out member cards at all? Read once per billing window, so the Card no. box
  // shows only where it means something. A failed read leaves the box hidden and is logged: the
  // phone still finds a member.
  useEffect(() => {
    if (!billingOpen) return
    let cancelled = false
    scopedFrom('pos_membership_types', 'id').eq('is_active', true).limit(1).then(({ data, error }) => {
      if (cancelled) return
      if (error) { console.error('POS membership: card types not read:', error); return }
      setOutletHasCards((data || []).length > 0)
    })
    return () => { cancelled = true }
  }, [billingOpen, clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // The customer the bill's phone finds, with their card and credit limit. Debounced like the points
  // lookup above, and found by the number however it is typed. Never for a delivery partner: the
  // partner owes the bill, and is no member. A failed read says so — it is not "not a member", which
  // would have a cashier tell a regular their card does not count.
  const BILL_CUSTOMER_COLS = 'id, name, phone, membership_type_id, card_no, card_expires_on, credit_limit, pos_membership_types(name, discount_pct, is_active)'
  useEffect(() => {
    const key = customerPhoneKey(buyerPhone)
    if (!billingOpen || !key || deliveryPartner || isDeliveryPartnerPhone(buyerPhone, billingSettings.delivery_partners)) {
      setBillCustomer(null); setBillCustomerMsg(''); return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      const { data, error } = await scopedFrom('pos_customers', BILL_CUSTOMER_COLS).eq(key.column, key.value).maybeSingle()
      if (cancelled) return
      if (error) { setBillCustomer(null); setBillCustomerMsg(`Couldn't check whether this guest is a member. ${errorText(error, 'staff')}`); return }
      setBillCustomerMsg('')
      setBillCustomer(data || null)
    }, 400)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [billingOpen, buyerPhone, deliveryPartner, clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // A member card number typed at payment: the card names the guest, so its holder's phone goes on
  // the bill (the phone lookup above then confirms the same customer) and their name where none was
  // typed. Card numbers are stored trimmed and upper-cased, and looked up the same way.
  useEffect(() => {
    const card = normalizeCardNo(memberCardStr)
    if (!billingOpen || !card) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const { data, error } = await scopedFrom('pos_customers', BILL_CUSTOMER_COLS).eq('card_no', card).maybeSingle()
      if (cancelled) return
      if (error) { setBillCustomerMsg(`Couldn't look up card ${card}. ${errorText(error, 'staff')}`); return }
      if (!data) { setBillCustomerMsg(`No customer holds card ${card}. Check the number, or find the guest by phone.`); return }
      setBillCustomerMsg('')
      setBillCustomer(data)
      setAdjustOpen(true)
      setBuyerName(prev => (prev.trim() ? prev : (data.name || '')))
      if (data.phone) setBuyerPhone(data.phone)
    }, 500)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [billingOpen, memberCardStr, clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Live bill/slip preview inside the Billing modal — built from the exact same functions used
  // for the real print, so what the cashier sees always matches what will actually print.
  //
  // It lives up here, far from the iframe that renders it, for one reason: the debounce below is a
  // hook, and this component's `hasPosAccess` early return sits between here and there.
  const previewDraftOrder = {
    invoice_no: null, invoice_fy: null,
    payment_method: splitMode && tenders.length > 0 ? 'Split' : payMethod,
    tendered_amount: !splitMode && payMethod === 'Cash' ? resolveTendered(payTotal) : null,
    buyer_name: buyerName, buyer_address: buyerAddress, buyer_pan: buyerPan, buyer_phone: phoneForRecord(buyerPhone),
    bill_remarks: billRemarks, close_reason: closeReason,
    discount_amount: discountAmt,
    table_name: screenTableName, order_no: orderNo, print_count: 0,
    // The bill prints "Covers:" from the stored order; the preview showed it blank (S856, found live).
    covers,
  }
  const previewHtml = !billingOpen ? null
    : billingTab === 'pay' ? buildBillHtml({
        order: previewDraftOrder, items: payableOrderItems, copyLabel: 'PREVIEW', qrUrl: billQrUrl, payments: tenders,
        qrAmount: splitMode ? (parseFloat(tenderAmtStr) || remaining) : payTotal,
        outletName, billingSettings, hscMap,
        tableName: screenTableName,
        cashierName: printedStaffName(profile, isAdmin),
      })
    : billingTab === 'writeoff' ? buildCompSlipHtml({
        order: previewDraftOrder, items: orderItems, plateCostOf: compPlateCost, copyLabel: 'PREVIEW',
        outletName,
        tableName: screenTableName,
        authorizedBy: printedStaffName(profile, isAdmin),
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
  // Recipe id → the option ids it was last added with on this till (S759, "Same as last").
  const lastPicksRef = useRef({})
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

  // Crest Customization lookups, rebuilt only when the catalog changes (not per keystroke).
  const optionMaps = useMemo(() => ({
    optionsById: Object.fromEntries(optionCatalog.options.map(o => [o.id, o])),
    groupsById:  Object.fromEntries(optionCatalog.groups.map(g => [g.id, g])),
  }), [optionCatalog])
  const dishGroupsByRecipe = useMemo(() => {
    const out = {}
    if (!customizationEnabled) return out
    for (const rid of new Set(optionCatalog.attachments.map(a => a.recipe_id))) {
      const dg = groupsForDish(rid, optionCatalog)
      if (dg.length) out[rid] = dg
    }
    return out
  }, [optionCatalog, customizationEnabled])

  // Combos (S839, docs/pos-combos.md): the outlet's active combos, and the recipe row of each dish they
  // offer (read with them, since a combo dish need not be On POS); the till menu fills any gap.
  const combos = customizationEnabled ? (optionCatalog.combos || []) : []
  const comboRecipeOf = useMemo(() => {
    const own = optionCatalog.comboRecipes || {}
    const onMenu = new Map(menu.map(r => [r.id, r]))
    return id => own[id] || onMenu.get(id)
  }, [optionCatalog, menu])
  // A dish's choices, priced and described as the choice window does (S758).
  const describeDishChoices = (recipeId, ids) => {
    const dg = dishGroupsByRecipe[recipeId] || []
    return describeSelection(ids, { ...optionMaps, attachByGroup: Object.fromEntries(dg.map(d => [d.group.id, d.attachment])) })
  }
  // A combo dish that cannot go on with its defaults: a build-your-own dish, or a required group with no default.
  const comboDishNeedsChoice = recipeId => {
    const dg = dishGroupsByRecipe[recipeId]
    if (!dg) return false
    if ((optionCatalog?.buildYourOwn || []).includes(recipeId)) return true
    return selectionProblems(dg, defaultSelection(dg)).length > 0
  }

  // S862 TILL-GUEST-1: Customization switched on or off for this outlet while this till is open (or,
  // since S862, lapsed 7 days past its paid-up date) reaches the till at its next login read: a screen
  // wake, a PIN sign-in, or a refusal below (handleSaveRefusal). A menu read under the other setting is
  // then read again at once, since its choices and combos are the old setting's. `customSwitchCheck`
  // is such a refusal, set once the login has been read again: { shown, wasOn }, its message and the
  // switch the till had when the save was refused.
  const [customSwitchCheck, setCustomSwitchCheck] = useState(null)
  useEffect(() => {
    const check = customSwitchCheck
    if (check) setCustomSwitchCheck(null)
    // Stale: the menu on screen, or the read on its way (a first read too, which readMenu drops when it
    // lands), is the other setting's.
    const cur = menuInFlightRef.current
    const stale = (menuReadAtRef.current > 0 && menuReadCustomRef.current !== customizationEnabled)
      || (!!cur && cur.custom !== customizationEnabled)
    if (!check && !stale) return
    // The login came back with the same switch: the refusal was the menu, as for any other.
    if (check && check.wasOn === customizationEnabled) { reloadMenuThenSay(check.shown, MENU_RELOADED_TEXT); return }
    const said = check ? customizationSwitchedText(customizationEnabled) : null
    const say = () => { if (said) setMsg(m => (m === check.shown ? `${check.shown} ${said}` : m)) }
    // A read under this switch already on its way (a full one, or the replacement a dropped read
    // started) answers for this one too: one read per switch.
    const mine = cur && cur.custom === customizationEnabled ? cur : null
    if (!stale && !mine) { say(); return } // the menu was already read again on the switch
    const read = mine && (mine.mode === 'full' || !stale) ? mine.promise : loadMenu({ force: true })
    void read.then(ok => { if (ok) say() }, e => console.error('menu re-read after a Customization switch failed:', e))
  }, [customizationEnabled, customSwitchCheck]) // eslint-disable-line react-hooks/exhaustive-deps

  // A reload or a closed tab ends this screen without a word (S809.4): ← asks before it drops unsaved
  // lines, and Cancel before it drops recorded payments, but the browser asked nothing. While either is
  // on screen the browser asks first. Tenders count only while the payment window is up, because they
  // stay in state after it closes until the next bill is opened.
  const unsavedOnLeave = (view === 'order' && unsavedChangeCount(orderItems) > 0) || (billingOpen && tenders.length > 0)
  useEffect(() => {
    if (!unsavedOnLeave) return
    const onBeforeUnload = e => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [unsavedOnLeave])

  // S841: focus follows the screen. The floor and the order screen are separate trees, so the tile or
  // Bill button that opened an order unmounts with the floor and focus fell to the page body, from
  // where Tab walked the hidden shell. Opening an order puts focus on ← Table, its first control (not
  // the menu search, which on a tablet raises the on-screen keyboard over the menu); leaving it puts
  // focus back on that table's tile or Bill button. Only when focus is lost: a dialog that opened on
  // top (the payment window on Billing) keeps it.
  const backBtnRef = useRef(null)
  const returnFocusRef = useRef(null)
  const prevViewRef = useRef(view)
  useEffect(() => {
    if (view === 'order') returnFocusRef.current = activeTable?.id || orderId || null
  }, [view, activeTable, orderId])
  useEffect(() => {
    const prev = prevViewRef.current
    prevViewRef.current = view
    if (prev === view) return
    const focusLost = !document.activeElement || document.activeElement === document.body
    if (!focusLost) return
    if (view === 'order') { backBtnRef.current?.focus(); return }
    if (prev !== 'order') return
    const id = returnFocusRef.current
    const host = id && document.querySelector(`[data-table-tile="${id}"], [data-takeaway-tile="${id}"], [data-bill-for="${id}"]`)
    // A floor tile is a card since S846; the control to land on is its one button inside.
    const target = host && (host.querySelector('.floor-tile__open') || host)
    ;(target || document.getElementById('main-content'))?.focus()
  }, [view])

  // S842: a cart line removed by its own − or × took the focused button with it, and focus fell to the
  // page body. Once the cart has redrawn, focus goes to the line that took its place (else the one above
  // it, else ← Table), and only when focus was lost. Lines are keyed by dish now, so it no longer slides
  // to the next dish's button by itself either.
  const cartFocusAfterRef = useRef(null)
  const cartRemovedAtRef = useRef(0)
  useEffect(() => {
    const idx = cartFocusAfterRef.current
    if (idx == null) return
    cartFocusAfterRef.current = null
    if (document.activeElement && document.activeElement !== document.body) return
    const lines = document.querySelectorAll('#pos-order-lines [data-cart-line]')
    const line = lines[Math.min(idx, lines.length - 1)]
    ;(line?.querySelector('button') || backBtnRef.current)?.focus()
  }, [orderItems])

  // S854 (owner decision): Alt+S sends and Alt+P opens Payment on a till with a keyboard. Only on the
  // order screen, never while a dialog is open over it, and by key position (e.code), because a Mac's
  // Option key turns the letter into another character. The handlers are read through a ref, set
  // each render below, so the listener is attached once per visit to the order screen.
  const tillKeysRef = useRef(null)
  useEffect(() => {
    if (view !== 'order') return undefined
    const onKey = e => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return
      if (e.code !== 'KeyS' && e.code !== 'KeyP') return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      e.preventDefault()
      if (e.code === 'KeyS') tillKeysRef.current?.send()
      else tillKeysRef.current?.pay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />
  // The Floor → Billing nav item is Supervisor+; a nav item is not a guard and /pos/billing is a
  // plain URL, so the page says no itself. Back to Orders rather than /pos: a staff PIN that got
  // here by typing (or an old bookmark) still has somewhere legitimate to be.
  if (billingStation && !hasPosAccess('supervisor')) return <Navigate to="/pos/orders" replace />

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
      // A queued save's lines are the cart's, and a cart line is never comped (foldCompedSplits).
      total:     openBillTotal(q.items, vatReg),
      covers:    q.covers,
      pending:   q.items.filter(i => !i.sent_to_kot).length,
      offlinePending: true,
    }
  }

  // What the floor draws, as signatures — a quiet poll that comes back identical must not
  // re-render the whole floor (setIfChanged). Every field a tile or takeaway card renders is here.
  const tablesSig    = list => rowsSignature(list, ['id', 'name', 'section', 'status', 'capacity'])
  const floorOrdSig  = m => mapSignature(m, o => [o.orderId, o.itemCount, o.total, o.covers, o.pending, o.openedAt || '', o.offlinePending ? 1 : 0].join(':'))
  const takeawaysSig = list => rowsSignature(list, ['orderId', 'orderNo', 'itemCount', 'total', 'pending', 'openedAt', 'offlinePending', 'removedTable', 'partOf', 'partTableName'])
  const joinsSig     = m => mapSignature(m, id => id)

  // A queued entry that was surfaced as a conflict belongs to a bill another device closed — never
  // an open order to paint or reopen (S754). S809 3f: nor is one taken for another outlet
  // (ORDER-FLOW-15), or one that holds only tickets still to log (its order is on the server).
  const liveQueue = queue => queue.filter(q => !conflictIdsRef.current.has(q.order_id)
    && ownQueuedEntry(q, clientId) && queuedHasLines(q))

  // S809 3f: the floor's counts of what this till's queue holds — this outlet's orders still queued (the
  // tiles' "unsynced" mark and pullIsSaved), how many entries wait to upload, and how many belong to
  // another outlet and are left alone (ORDER-FLOW-15).
  function applyQueueCounts(rawQueue) {
    const mine = rawQueue.filter(q => ownQueuedEntry(q, clientId))
    setIfChanged(setPendingOrderIds, new Set(mine.filter(queuedHasLines).map(q => q.order_id)), s => [...s].sort().join(','))
    setWaitingUploads(mine.filter(q => !conflictIdsRef.current.has(q.order_id)).length)
    setForeignQueued(rawQueue.length - mine.length)
  }
  const refreshQueueCounts = () => getPosOrderQueue().then(applyQueueCounts)
    .catch(err => console.error('offline queue count failed (non-fatal):', err))

  async function loadFloor({ quiet = false } = {}) {
    const seq = ++floorReqSeq.current
    lastFloorLoadAt.current = Date.now()
    if (!quiet) setFloorLoad(true)

    if (tillOffline()) {
      const [cachedTables, rawQueue] = await Promise.all([getCachedPosTables(clientId), getPosOrderQueue()])
      if (seq !== floorReqSeq.current) return
      const queue = liveQueue(rawQueue)
      // No cached list is "never loaded on this device", not "no tables" — keep what is on screen.
      if (cachedTables) setIfChanged(setTables, cachedTables, tablesSig)
      const map = {}
      // S834: an order whose table is gone from the floor plan shows as a card of its own (removedTable).
      const onFloor = q => q.table_id && (!cachedTables || cachedTables.some(t => t.id === q.table_id))
      for (const q of queue) { if (onFloor(q)) map[q.table_id] = queuedOrderToOverlay(q) }
      // This branch runs on every poll while the link is down, so each setter keeps what is on screen
      // when nothing moved (2026-10-15 audit): a new map, array or {} re-rendered the whole floor every tick.
      setIfChanged(setTableOrders, map, floorOrdSig)
      // Takeaways already on screen from the last online read stay; queued ones are layered on.
      const queuedTakeaways = queue.filter(q => !onFloor(q))
        .map(q => ({ ...queuedOrderToOverlay(q), orderNo: null, removedTable: q.table_id ? (q.table_name || 'A removed table') : null }))
      setTakeawayOrders(prev => {
        const next = [
          ...prev.filter(t => !queuedTakeaways.some(q => q.orderId === t.orderId)),
          ...queuedTakeaways,
        ]
        return takeawaysSig(next) === takeawaysSig(prev) ? prev : next
      })
      applyQueueCounts(rawQueue)
      // pos_kot_log is server-only — no reliable status while offline.
      setKotStatusByTable(prev => (Object.keys(prev).length ? {} : prev))
      setFloorLoad(false)
      return
    }

    if (!quiet) {
      loadOpenShift()
      // S847: guest orders and today's bookings read nothing of the floor's, so they go with it rather
      // than a round trip after it. Each keeps its own last-good on a failure.
      loadPendingGuestOrders()
      loadFloorReservations()
    }
    // An outlet without Inventory (S809 4e, D6) asks for neither count: nothing of its waits for a post.
    const noCount = Promise.resolve({ count: 0, error: null })
    // Taken before the count is asked, so a miss noted while it is in flight is not pruned by it.
    const countStartedAt = Date.now()
    // A bill closed before the outlet's Inventory began, and a note on one, never go to Inventory, so
    // neither waits (S831 5f-3, Q31 a). No stamp (Inventory from the start): the counts as before.
    const imsSinceIso = clientModules?.imsSince ? new Date(clientModules.imsSince).toISOString() : null
    const [tblRes, ordRes, joinRes, { count: unposted, error: unpostedErr }, { count: notesWaiting, error: notesErr }] = await Promise.all([
      scopedFrom('pos_tables')
        .order('sort_order').order('name'),
      scopedFrom('pos_orders', 'id, order_no, table_id, table_name, covers, opened_at, part_of_order_id, pos_order_items(qty, unit_price, vat_rate, sent_to_kot, comped)')
        .eq('status', 'open'),
      // S836: tables joined to another table's bill. A handful of rows, one per joined table.
      scopedFrom('pos_table_joins', 'table_id, order_id'),
      // head:true — a count, not rows, so the 1000-row cap cannot apply. Backed by the partial
      // index idx_pos_orders_unposted, so it stays cheap however large the table gets.
      !tillPostsToIms ? noCount
        : imsSinceIso
          ? scopedFrom('pos_orders', 'id', { count: 'exact', head: true }).eq('status', 'billed').is('ims_posted_at', null).gte('closed_at', imsSinceIso)
          : scopedFrom('pos_orders', 'id', { count: 'exact', head: true }).eq('status', 'billed').is('ims_posted_at', null),
      // Same shape, backed by idx_pos_credit_notes_unposted. With a stamp, the note's bill must have
      // closed since it (an inner join on the hinted embed: pos_orders also points back at the note).
      !tillPostsToIms ? noCount
        : imsSinceIso
          ? scopedFrom('pos_credit_notes', 'id, pos_orders!pos_credit_notes_order_id_fkey!inner(closed_at)', { count: 'exact', head: true })
              .is('ims_posted_at', null).gte('pos_orders.closed_at', imsSinceIso)
          : scopedFrom('pos_credit_notes', 'id', { count: 'exact', head: true }).is('ims_posted_at', null),
    ])
    if (seq !== floorReqSeq.current) return
    // A failed count keeps the last value (a failed poll must not blank live state, S654) — and a
    // bundle deployed ahead of the migration reads 42703 here, which must not paint a banner. A count
    // that answered is the truth for every miss this till noted before it was asked (S809 4e).
    if (!unpostedErr) {
      setUnpostedCount(unposted || 0)
      setImsMisses(list => pruneImsMisses(list, countStartedAt))
    }
    if (!notesErr) setUnpostedNotes(notesWaiting || 0)

    // S754: both reads used to drop their error, so a failed read painted "No tables set up yet",
    // freed every tile, and wrote the EMPTY list into the offline cache the till falls back on.
    // Now a failure keeps last-good on screen, leaves the cache alone, and says so with a Retry.
    const readErr = tblRes.error || ordRes.error || joinRes.error
    if (readErr) {
      if (isNetworkError(readErr)) noteLinkDown() // S809 3f: the floor poll is also what notices the internet is down
      console.error('loadFloor failed, keeping the last floor shown:', readErr)
      setFloorLoadError(errorText(readErr, 'staff'))
      setFloorLoad(false)
      return
    }
    setFloorLoadError('')
    noteLinkUp()
    const tbls = tblRes.data || []
    setIfChanged(setTables, tbls, tablesSig)
    cachePosTables(clientId, tbls)
    const map = {}
    const takeaways = []
    const tableIds = new Set(tbls.map(t => t.id))
    for (const o of (ordRes.data || [])) {
      const items = o.pos_order_items || []
      const overlay = {
        orderId:   o.id,
        openedAt:  o.opened_at || null,
        itemCount: items.reduce((s, i) => s + i.qty, 0),
        // What the guest will pay (owner decision): VAT included, before any discount. The POS
        // Dashboard's Open bills figure is the same sum (openBillTotal). A comp is written only as a
        // bill closes, so a comped row here is a close in flight, or one a cancelled close left; it
        // counts (S854), because the order screen folds it back into its line and charges it.
        total:     openBillTotal(items, vatReg),
        covers:    o.covers,
        pending:   items.filter(i => !i.sent_to_kot).length,
      }
      // S834 (S809.4, 4k): an open order whose table was deleted (a till held it offline while the table
      // was removed; pos_orders.table_id has no foreign key) was drawn on no tile and on no Billing row,
      // so it could be neither billed nor found. It shows as a card of its own, named after the old table.
      if (o.table_id && tableIds.has(o.table_id)) map[o.table_id] = overlay
      // S836: a part bill (pay part now) has no table of its own; its card is named after the table's.
      else if (o.part_of_order_id) takeaways.push({ ...overlay, orderNo: o.order_no || null, removedTable: null, partOf: o.part_of_order_id, partTableName: o.table_name || null })
      else takeaways.push({ ...overlay, orderNo: o.order_no || null, removedTable: o.table_id ? (o.table_name || 'A removed table') : null })
    }
    const joins = {}
    for (const j of (joinRes.data || [])) if (tableIds.has(j.table_id)) joins[j.table_id] = j.order_id
    setIfChanged(setTableJoins, joins, joinsSig)
    // Layer any still-queued (not-yet-synced) local edits on top of server truth, so a table
    // doesn't briefly look wrong while a reconnect flush is still in flight.
    const rawQueue = await getPosOrderQueue()
    if (seq !== floorReqSeq.current) return
    const queue = liveQueue(rawQueue)
    for (const q of queue) {
      if (q.table_id && tableIds.has(q.table_id)) map[q.table_id] = queuedOrderToOverlay(q)
      else {
        const i = takeaways.findIndex(t => t.orderId === q.order_id)
        const ov = {
          ...queuedOrderToOverlay(q), orderNo: i >= 0 ? takeaways[i].orderNo : null,
          removedTable: q.table_id ? (q.table_name || 'A removed table') : null,
          // S836: a part bill keeps its name while an edit of it waits to upload.
          ...(i >= 0 && takeaways[i].partOf ? { partOf: takeaways[i].partOf, partTableName: takeaways[i].partTableName } : {}),
        }
        if (i >= 0) takeaways[i] = ov; else takeaways.push(ov)
      }
    }
    // Oldest first, so a takeaway keeps its place on the floor as new ones arrive.
    takeaways.sort((a, b) => (a.orderNo ?? Infinity) - (b.orderNo ?? Infinity))
    setIfChanged(setTableOrders, map, floorOrdSig)
    setIfChanged(setTakeawayOrders, takeaways, takeawaysSig)
    applyQueueCounts(rawQueue)
    setFloorLoad(false)
    if (quiet) return
    // Needs this read's orders, so it is the one read that waits for the floor.
    loadKotStatus(map, takeaways)
    // S847: the menu is read now, behind the floor, so the first table tapped opens onto its dishes.
    // Through the ref: this closure can be the mount's, older than the till's switches.
    void loadMenuRef.current?.({ background: true })
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
    // And back into the evening before (S818, RESERVATIONS-8, D24): an 11:30 PM party still waiting
    // for its table at 12:10 AM stays on the board until its booked window ends. It used to vanish
    // at midnight, and a tap on its table gave the covers numpad.
    const [{ data, error }, { count, error: countErr }] = await Promise.all([
      scopedFrom('pos_reservations', 'id, customer_name, phone, party_size, reserved_for, duration_minutes, status, arrived_at, pos_reservation_tables(table_id)')
        .in('status', FLOOR_STATUSES)
        .gte('reserved_for', carryOverFrom(start)).lte('reserved_for', end)
        .order('reserved_for'),
      // S834: a request whose time has passed is not counted (reservationSeen.js, as the nav chip).
      waitingRequests(scopedFrom('pos_reservations', 'id', { count: 'exact', head: true })),
    ])
    // A failed poll keeps last-good — an emptied strip reads as "no bookings tonight".
    if (error) console.error('loadFloorReservations failed, keeping last known:', error)
    else {
      const dayStartMs = new Date(start).getTime()
      const rows = (data || []).filter(r => stillInPlay(r, dayStartMs, Date.now())).map(r => ({ ...r, tables: tableIdsOf(r).sort().join(',') }))
      setIfChanged(setFloorReservations, rows, list => rowsSignature(list, ['id', 'status', 'reserved_for', 'party_size', 'customer_name', 'arrived_at', 'tables']))
    }
    if (countErr) console.error('reservation request count failed, keeping last known:', countErr)
    else setRequestCount(count || 0)
  }

  // Pending (not yet Accepted/Dismissed) guest self-order requests, grouped by table — see
  // submit_guest_order/pos_guest_order_requests (Guest QR self-ordering, Pro-tier feature).
  // Guest ordering only ever happens online, so (like loadKotStatus) this is skipped offline.
  async function loadPendingGuestOrders() {
    if (tillOffline()) return
    const { data, error } = await bounded(scopedFrom('pos_guest_order_requests', 'id, table_id, items, guest_notes, covers, created_at')
      .eq('status', 'pending'), 'Checking guest orders', SEND_READ_MS)
    // A failed read here would empty the floor's guest-order banner AND clear seenGuestRequestIds,
    // so the next successful poll re-chimes for requests already seen. Keep both as they were.
    if (error) { console.error('loadPendingGuestOrders failed, keeping last known requests:', error); return }
    // S834 (D34): one nobody answered for 30 minutes is turned away; until the server has, it is left
    // out here and this till asks for it.
    const rows = (data || []).filter(r => !isStaleGuestOrder(r.created_at))
    if (rows.length < (data || []).length) {
      void supabase.rpc('turn_away_stale_guest_orders').then(
        ({ error: turnErr }) => { if (turnErr) console.error('turning away guest orders past 30 minutes failed:', turnErr) },
        err => console.error('turning away guest orders past 30 minutes failed:', err))
    }

    // Chime once per genuinely new request — skipped on the very first load (that's just
    // whatever was already pending when this screen opened, not a fresh arrival).
    if (guestOrdersLoadedOnce.current && rows.some(r => !seenGuestRequestIds.current.has(r.id))) {
      playGuestOrderChime()
    }
    seenGuestRequestIds.current = new Set(rows.map(r => r.id))
    guestOrdersLoadedOnce.current = true

    // ORDER-FLOW-11 (S809 3b): a request this screen accepted is already in the cart, so it stays off
    // the banner, the floor chip and the covers shortcut. The poll used to put it back within 5 s with
    // Accept live, and a second tap doubled the dishes. One whose dishes are saved but whose mark has
    // not landed is marked again from here.
    if (unmarkedGuestAcceptsRef.current.size > 0) void markGuestAccepts()
    const hidden = id => acceptedGuestReqIdsRef.current.has(id) || unmarkedGuestAcceptsRef.current.has(id) || staleGuestReqIdsRef.current.has(id)
    const map = {}
    for (const r of rows) {
      if (hidden(r.id)) continue
      if (!map[r.table_id]) map[r.table_id] = []
      map[r.table_id].push(r)
    }
    // Every 5 s, and the answer is almost always the same one. Without the bail-out this poll
    // alone re-rendered the whole order/floor screen twelve times a minute for the length of a
    // service. A request row is immutable once created — Accept/Dismiss changes its status, which
    // takes it out of this query entirely — so the set of ids is the whole state. The database holds
    // it to that since S809 3b (guard_pos_guest_order_request).
    setIfChanged(setPendingGuestOrders, map, m => mapSignature(m, list => (list || []).map(r => r.id).join(',')))
  }

  // The shared chime (S763), not the inline copy this file used to carry. That copy built a new
  // AudioContext per guest order and never closed one, and Chrome caps a document at about six —
  // so a floor screen left open through a service went silent from the seventh guest order of the
  // night, with nothing to say so. Identical tones and timing; the only change is the context.
  function playGuestOrderChime() { playChime() }

  // Merges one guest-requested item into the local cart, same dedup-by-line-key logic as
  // addItem() — but at whatever qty the guest asked for (addItem always adds exactly 1), and
  // without triggering the upsell suggestion engine (this isn't a staff menu tap).
  //
  // GUEST-1 (S809 3a, owner decision Q11 a): the guest's order-wide note (`orderNote`) goes onto each
  // of their dishes beside the dish's own note, so it prints under every dish on the KOT/BOT and shows
  // on the Kitchen Display. Accept used to drop it: it reached nobody but the waiter's banner.
  //
  // S839: a request's combo dish (it carries `combo`) comes in as a combo dish of the request's own
  // line_id, so the dishes of that combo stay one combo on the cart and on the save.
  function mergeGuestItem(requested, orderNote) {
    const it = guestLineOf(requested)
    setOrderItems(prev => {
      const key = lineKeyOf(it)
      const idx = prev.findIndex(i => lineKeyOf(i) === key)
      if (idx >= 0) {
        // The cart holds one line per line key, so the guest's words have nowhere to go but onto the
        // existing line (they used to be dropped here outright, S754). That line already holds the
        // table's own food, so the note names the guest's plates ("Guest ×2: …"): it does not claim
        // food ordered earlier, and the line's own note stays as it was (kitchenNotes.js).
        const current = prev[idx]
        const notes = joinNote(current.notes, guestDishNote({ dishNote: it.note, orderNote, qty: it.qty, shared: true }))
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
        notes:       guestDishNote({ dishNote: it.note, orderNote, qty: it.qty }),
        // A guest's customized dish (S758 stage 6) keeps its choices; the server re-prices it from
        // the option ids on save, so the snapshot's price is display only.
        ...(it.selection_key ? {
          selection_key: it.selection_key, option_ids: lineOptionIds(it),
          base_unit_price: it.base_unit_price, options_delta: it.options_delta,
          option_summary: it.option_summary, options: it.options,
        } : {}),
        ...(isComboLine(it) ? comboFieldsOf(it) : {}),
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
    // ORDER-FLOW-11 (S809 3b): its dishes are already in this cart (or saved on a bill).
    if (decision === 'accepted' && (acceptedGuestReqIdsRef.current.has(request.id) || unmarkedGuestAcceptsRef.current.has(request.id))) return
    setDecidingGuestReqIds(prev => new Set(prev).add(request.id))
    try {
      if (decision === 'accepted') {
        for (const it of (request.items || [])) mergeGuestItem(it, request.guest_notes)
        if ((request.guest_notes || '').trim()) setMsg('ok:The guest\'s note is on each of their dishes and prints on the kitchen ticket when you send.')
        rememberAcceptedGuestReq(request)
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
        // GUEST-3 (S809 3b): only a request still waiting is turned away (the database refuses a second
        // answer anyway). If another till answered first, nothing changes and the waiter is told, rather
        // than the guest being told "not taken" for food that is on its way.
        const { data: answered, error: decErr } = await bounded(scopedUpdate('pos_guest_order_requests', {
          status: decision, decided_at: new Date().toISOString(), decided_by: profile?.id || null,
        }).eq('id', request.id).eq('status', 'pending').select('id'), 'Dismissing the guest order')
        // loadPendingGuestOrders() below puts the request straight back on screen if this failed,
        // which looks like the button did nothing. Name it instead.
        if (decErr) setMsg(`error:Could not dismiss that guest order. ${errorText(decErr, 'staff')}`)
        else if (!answered?.length) setMsg('error:That guest order was already answered — on another till, or by an earlier tap that did go through — so nothing was changed. Check this table\'s order before you send anything.')
        forgetAcceptedGuestReqs([request.id])
        loadPendingGuestOrders()
      }
    } finally {
      setDecidingGuestReqIds(prev => { const next = new Set(prev); next.delete(request.id); return next })
    }
  }

  // ORDER-FLOW-11 / -18 (S809 3b): the guest requests this screen has accepted into its cart, with
  // the dishes each put there. The ref moves at once, so a poll landing before the next render already
  // leaves the request off the banner.
  function rememberAcceptedGuestReq(request) {
    // backToFloor empties the set without this map; what it left behind goes here.
    for (const id of acceptedGuestItemsRef.current.keys()) if (!acceptedGuestReqIdsRef.current.has(id)) acceptedGuestItemsRef.current.delete(id)
    acceptedGuestReqIdsRef.current = new Set(acceptedGuestReqIdsRef.current).add(request.id)
    acceptedGuestItemsRef.current.set(request.id, request.items || [])
    setPendingAcceptedGuestReqIds(prev => new Set(prev).add(request.id))
  }
  function forgetAcceptedGuestReqs(ids) {
    if (!ids.length) return
    const drop = new Set(ids)
    acceptedGuestReqIdsRef.current = new Set([...acceptedGuestReqIdsRef.current].filter(id => !drop.has(id)))
    for (const id of ids) acceptedGuestItemsRef.current.delete(id)
    setPendingAcceptedGuestReqIds(prev => (ids.some(id => prev.has(id)) ? new Set([...prev].filter(id => !drop.has(id))) : prev))
  }

  // GUEST-3 (S809 3b): marks guest requests accepted once their dishes are saved on a bill — only a
  // request still waiting (the database refuses a second answer anyway). One that comes back unmarked
  // is read once to say why: this till's own earlier try landed (a lost reply), another till accepted
  // it, or another till turned it away while this one had it — its dishes are on this bill now, so the
  // waiter is told. A failed write keeps it for the next poll; its dishes are saved, so it never goes
  // back on the banner, where Accept would add them a second time.
  // S835: returns the run in flight, so a bill close can wait for it rather than for nothing.
  function markGuestAccepts() {
    if (markingGuestAcceptsRef.current) return markingGuestAcceptsRef.current
    if (unmarkedGuestAcceptsRef.current.size === 0) return Promise.resolve()
    const run = markGuestAcceptsNow().finally(() => { markingGuestAcceptsRef.current = null })
    markingGuestAcceptsRef.current = run
    return run
  }
  async function markGuestAcceptsNow() {
    const byBill = new Map()
    for (const [id, oid] of unmarkedGuestAcceptsRef.current) byBill.set(oid, [...(byBill.get(oid) || []), id])
    for (const [oid, ids] of byBill) {
      const { data: marked, error } = await bounded(scopedUpdate('pos_guest_order_requests', {
        status: 'accepted', decided_at: new Date().toISOString(), decided_by: profile?.id || null, order_id: oid,
      }).in('id', ids).eq('status', 'pending').select('id'), 'Marking the guest order accepted')
      if (error) { console.error('guest request accept failed — kept for the next poll (its dishes are saved):', error); continue }
      for (const r of marked || []) unmarkedGuestAcceptsRef.current.delete(r.id)
      const rest = ids.filter(id => !(marked || []).some(r => r.id === id))
      if (rest.length === 0) continue
      const { data: current, error: readErr } = await bounded(scopedFrom('pos_guest_order_requests', 'id, status, order_id').in('id', rest), 'Reading the guest order')
      if (readErr) { console.error('guest request read failed — kept for the next poll:', readErr); continue }
      // A request that is no longer there (a restore, a clear) needs nothing more.
      for (const id of rest) unmarkedGuestAcceptsRef.current.delete(id)
      for (const r of current || []) {
        if (r.status === 'accepted' && r.order_id === oid) continue
        if (r.status === 'dismissed') setMsg('error:Another till turned this guest\'s QR order away while you had it, but its dishes are saved on this order. Tell the guest their food is coming — their phone says it was not taken — or take the dishes off.')
        else if (r.status === 'accepted') setMsg('error:Another till had already accepted this guest\'s QR order. Check this order does not have their dishes twice.')
        // Still waiting means the write was refused for another reason: try again at the next poll.
        else unmarkedGuestAcceptsRef.current.set(r.id, oid)
      }
    }
  }

  // ORDER-FLOW-18 (S809 3b): the accepted guest requests whose dishes are among the lines a reload from
  // another device left off.
  function guestReqsLeftOff(missing) {
    const keys = new Set((missing || []).map(lineKeyOf))
    return [...acceptedGuestItemsRef.current]
      .filter(([id, items]) => acceptedGuestReqIdsRef.current.has(id) && items.some(it => keys.has(lineKeyOf(it))))
      .map(([id, items]) => ({ id, items }))
  }

  // Per table, a summary of the tickets sent for its currently open order (summarizeTicketStages in
  // posSignals.js): the least-advanced stage not yet served, and how many tickets are ready. A table
  // with a Ready starter and a New main says "1 ready" (owner decision, S754) — it used to say "Sent",
  // which hid the food sitting in the pass. Takes an optional fresh map (passed synchronously from
  // loadFloor right after setTableOrders) to avoid reading stale state before that setState lands.
  async function loadKotStatus(ordersMap = tableOrders, takeaways = takeawayOrders) {
    if (tillOffline()) return
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
    if (orderIds.length === 0) { setKotStatusByTable(prev => (Object.keys(prev).length ? {} : prev)); return }
    // Cancelled tickets belong to a voided order; they used to fall through KOT_STATUS_RANK's `?? 0`
    // and read as "Sent". Served ones are kept — they are what turns a finished table to "Served".
    // A CHANGE ticket (S809 3a, kitchenNotes.js) is nothing to cook, so it never makes a table read "Sent".
    const { data, error } = await bounded(scopedFrom('pos_kot_log', 'order_id, status').in('order_id', orderIds).neq('status', 'cancelled')
      .not('items', 'cs', KOT_CHANGE_ITEMS), 'Checking the kitchen', SEND_READ_MS)
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

  // Ticket rows for the order currently open on screen — matched to a cart line by its line key
  // (ticketForLine, S817 4i) and to a menu tile by recipe (MenuGrid.jsx, S842), so each item can
  // show its own Sent/Started/Ready timer, not just the table-wide summary loadKotStatus computes.
  async function loadOrderKotTickets(oid) {
    // Offline or with the link down the last tickets read for this order stay (S842); the effect that
    // opens an order clears the previous order's.
    if (!oid || tillOffline()) return
    // Served tickets stay in this read (S754): a line whose ticket was served reads "Served" on the
    // cart rather than falling back to an older ticket's stage.
    const { data, error } = await bounded(scopedFrom('pos_kot_log', 'id, items, status, sent_at, started_at, ready_at, estimated_prep_minutes')
      .eq('order_id', oid)
      .neq('status', 'cancelled')
      .not('items', 'cs', KOT_CHANGE_ITEMS) // a CHANGE ticket (S809 3a) is no dish's cooking stage
      .order('sent_at', { ascending: false }), 'Checking this order\'s tickets', SEND_READ_MS)
    if (ticketsOrderRef.current !== oid) return
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

  // "Served" on the order screen (S754, migration 20260916110000): every ticket of this order that is
  // Ready moves to Served, so the Kitchen Display drops it and the floor stops showing food waiting.
  // Conditional on 'ready' exactly as the KDS transitions are — a ticket the kitchen has not finished
  // is never marked served from here, and one the KDS already served is simply not matched.
  // `.select('id')` because a filter that matches nothing returns no error, only an empty result.
  async function markOrderServed() {
    if (!orderId || !navigator.onLine || servingTickets) return
    setServingTickets(true)
    // S809 3d (FLOOR-KITCHEN-6): bounded, so a stalled request cannot leave ✓ Served stuck on
    // "Marking…" and refusing every table on this till. served_at is the server's since 3d.
    const servedRes = await bounded(scopedUpdate('pos_kot_log', {
      status: 'served', served_at: new Date().toISOString(), status_updated_by: profile?.id || null,
    }).eq('order_id', orderId).eq('status', 'ready').select('id'), 'Marking served', 15000)
    const { data, error } = servedRes
    setServingTickets(false)
    // S833: a dropped connection or a gateway 5xx is no answer too, not a refusal.
    if (noAnswer(servedRes)) setMsg('error:No answer came back, so it may or may not be marked served. Check your signal, then look at the order again in a moment.')
    else if (error) setMsg(`error:Not marked as served — the kitchen still shows it ready. ${errorText(error, 'staff')}`)
    else if (!data?.length) setMsg('ok:Nothing was waiting — it was already marked served.')
    else setMsg(`ok:${data.length === 1 ? 'Ticket' : `${data.length} tickets`} marked served.`)
    loadOrderKotTickets(orderId)
  }

  // Uploads what this till queued — offline, or (S809 3f, owner decision Q16) because a send got no answer —
  // one order at a time. Runs on reconnect (window 'online'), once on mount, every UPLOAD_RETRY_MS while
  // anything waits, and before a send of an order that is still queued (performSave). S809 3f
  // (ORDER-FLOW-7): one upload at a time on this page (posUpload); each queued ticket is logged under the id
  // it was queued with, so a second run is a no-op; the loop stops at the first request that gets no
  // answer; and a ticket whose log insert did not land stays queued instead of being dropped with its
  // order. Only this outlet's entries are uploaded (ORDER-FLOW-15). Never rejects.
  function flushPosOrderQueue() {
    if (!posUpload.run) posUpload.run = uploadPosOrderQueue().finally(() => { posUpload.run = null })
    return posUpload.run
  }

  async function uploadPosOrderQueue() {
    if (!clientId) return
    let queue
    try {
      queue = await getPosOrderQueue()
    } catch (err) {
      console.error('POS offline queue could not be read, nothing uploaded:', err)
      return
    }
    applyQueueCounts(queue)
    // A conflict waits for the waiter's Start new order / Discard on the floor; after a reload it is
    // tried once more, and comes back as the same conflict.
    const mine = queue.filter(q => ownQueuedEntry(q, clientId) && !conflictIdsRef.current.has(q.order_id))
    // An entry gone from the queue (uploaded elsewhere on this page, or discarded) takes its line with it.
    const stillThere = new Set(mine.map(queuedOrderId))
    for (const oid of [...uploadTriesRef.current.keys()]) if (!stillThere.has(oid)) uploadTriesRef.current.delete(oid)
    setUploadTrouble(prev => (prev.every(t => stillThere.has(t.orderId)) ? prev : prev.filter(t => stillThere.has(t.orderId))))
    if (mine.length === 0) return
    setSyncingOffline(true)
    let moved = false
    try {
      for (const q of mine) {
        let outcome
        keptErrorRef.current = null
        try {
          outcome = await uploadQueuedOrder(q)
        } catch (err) {
          console.error('POS offline order upload failed, will retry:', err) // left queued
          keptErrorRef.current = err
          outcome = 'kept'
        }
        if (outcome === 'no_answer') { noteLinkDown(); break } // the connection: the rest waits for the next try
        if (outcome !== 'kept') { noteLinkUp(); moved = true; noteUploadTrouble(q, null) }
        // A lapsed sign-in keeps its entry with no reason recorded: it is asked again, and is no one's to fix.
        else if (keptErrorRef.current) noteUploadTrouble(q, keptErrorRef.current)
      }
    } finally {
      setSyncingOffline(false)
    }
    // A retry that only found the internet still down repaints quietly — every 15 s, it must not flash.
    loadFloor(moved ? {} : { quiet: true })
  }

  // One queued entry: the order row when it was created offline, its lines (version-checked), then the
  // tickets it printed. Returns 'done', 'conflict', 'no_answer' (stop: the connection) or 'kept'. A
  // ticket-only entry is keyed apart from its order (posTicketsKey): `key` is the entry, `oid` the order.
  async function uploadQueuedOrder(q) {
    const key = q.order_id
    const oid = queuedOrderId(q)
    // A sign-in token that lapsed mid-upload is asked again next time — never filed as the server's refusal.
    const authLapse = r => Number(r?.status) === 401 || /jwt/i.test(r?.error?.message || '')
    // A replay the SERVER refused for a reason that will not change on retry goes to the conflict list —
    // retrying it would never land and would keep the order hidden (S754). `reason` picks the notice's
    // wording; the entry stays queued until recovered or discarded. S809 ORDER-FLOW-8: the tickets it
    // printed are logged first, against the order they were printed for, so KOT Reconciliation shows
    // food that went to the kitchen or bar and is on no bill, whatever the waiter does next. Not for
    // 'table_taken': that order never reached the server, so there is nothing to log them against.
    const serveTickets = async ids => {
      if (ids.length === 0) return
      const { error } = await bounded(scopedUpdate('pos_kot_log', { status: 'served' }).in('id', ids).eq('status', 'new'), 'Clearing old tickets', SEND_READ_MS)
      if (error) console.error('offline sync: tickets of a closed bill left on the Kitchen Display:', error)
    }
    // `log` false: the order may not be on the server (one created here and refused), so its tickets wait.
    const toConflict = async (reason, refusal = null, log = reason !== 'table_taken') => {
      if (log) {
        const logged = await logQueuedSends(q, oid)
        if (logged.keys.length > 0) {
          await markQueuedSendsLogged(oid, logged.keys)
            .catch(err => console.error('offline queue: could not mark tickets logged (a retry finds them logged):', err))
        }
        // Shown once its tickets are on the log: the next try finds the same conflict.
        if (logged.noAnswer) return 'no_answer'
        // A closed bill's party has gone: its tickets are history for the reports, not work for the
        // Kitchen Display, so they go to served rather than appear there as new orders. So do the tickets
        // of dishes another tablet had sent as well (S840): the order already holds them, on that tablet's
        // ticket, and a second one new on the Display is how they get made twice.
        if (reason === 'closed' || reason === 'sent_elsewhere') await serveTickets((q.kot_sends || []).map(s => s.id).filter(Boolean))
      }
      conflictIdsRef.current.add(oid)
      setConflictOrders(prev => prev.some(c => c.order_id === oid) ? prev : [...prev, { ...q, reason, refusal }])
      return 'conflict'
    }

    let version = null
    // S840: the id these lines are on the server under, for an edit queued while this upload ran (settledEntry).
    let landedId = null
    if (queuedHasLines(q)) {
      if (q.created_offline) {
        // Upsert, not insert: if a previous upload got this far but died before the entry was settled
        // (e.g. connectivity dropped mid-sync), created_offline is still true and this same row id gets
        // retried. A plain insert would hit the PK and fail forever, stranding the order. onConflict:
        // 'id' makes the retry a no-op on the order row itself. Since S809 3f a send whose new order got
        // no answer is queued the same way, under the id it was sent with.
        const up = await bounded(scopedUpsert('pos_orders', {
          id: oid, table_id: q.table_id, table_name: q.table_name,
          status: 'open', covers: q.covers, opened_by: q.opened_by,
        }, { onConflict: 'id' }), 'Uploading an order', SEND_STEP_MS)
        if (noAnswer(up)) return 'no_answer'
        if (up.error && authLapse(up)) return 'kept'
        if (up.error) {
          // 23505 is pos_orders_one_open_per_table: another device opened this table while this
          // one was offline. bill_locked: a previous upload did create the row and it has since
          // been billed, so the upsert is a write to a closed bill.
          if (up.error.code === '23505') return toConflict('table_taken')
          if (up.error.hint === HINT.locked || up.error.hint === HINT.notOpen) return toConflict('closed')
          return toConflict('refused', errorText(up.error, 'staff'), false)
        }
        if (q.table_id) {
          // S817 4i (D19): never over a table taken out of service; only a POS manager brings one back.
          const { error: tErr } = await bounded(scopedUpdate('pos_tables', { status: 'occupied' }).eq('id', q.table_id).neq('status', 'inactive'), 'Marking the table occupied', SEND_READ_MS)
          if (tErr) console.error('offline sync: table occupy failed', tErr)
        }
      } else {
        // Safety check: don't overwrite an order another device closed while this one was offline. This
        // read IS the check, so it fails closed (S654): no answer stops the upload, and a row that is
        // gone is a conflict rather than a retry against a dead id for ever.
        const cur = await bounded(scopedFrom('pos_orders', 'status').eq('id', oid).maybeSingle(), 'Checking an order', SEND_READ_MS)
        if (noAnswer(cur)) return 'no_answer'
        if (cur.error) { console.error('offline sync: status read refused, will retry:', cur.error); keptErrorRef.current = cur.error; return 'kept' }
        if (cur.data?.status !== 'open') return toConflict('closed') // stays queued — surfaced for review, not discarded
        // Only a count changed on this till (`covers_set`, ORDER-FLOW-14); an entry from before it says
        // nothing, and is written as it always was.
        const cv = q.covers_set === false ? { error: null }
          : await bounded(scopedUpdate('pos_orders', { covers: q.covers }).eq('id', oid), 'Uploading the cover count', SEND_READ_MS)
        if (noAnswer(cv)) return 'no_answer'
        if (cv.error) {
          // Billed between the status read and this write: the close guard now refuses any write to a
          // closed bill, which is the same conflict one round trip later.
          if (cv.error.hint === HINT.locked) return toConflict('closed')
          console.error('offline sync: covers update failed', cv.error)
        }
      }

      // Through the RPC, not delete-then-insert: this replay carries exactly the same two risks the online
      // path does. It must be atomic (S573 — a stall between the two writes leaves a live order with zero
      // lines), and it must record any already-fired line the offline edit dropped, or going offline
      // becomes the way to pull a fired item without leaving a trace. The reason is the one the waiter gave
      // on this till when the entry kept it (S809 3f); otherwise these rows read "none given" on the
      // Pulled Items tab, the honest label for a removal nobody can now be asked about.
      //
      // p_expected_version (S754): the offline edits were made against the version this device last saw,
      // so an order another tablet saved in the meantime is refused ('stale_order') instead of
      // overwritten. An order created offline sends none: its row did not exist.
      //
      // S809 3f: the rows go as they were queued — they are the save's payload already. Mapping them
      // through toItemPayload a second time dropped a customized dish's choices (it reads `option_ids` or
      // a selection key, and a payload carries `options`).
      // S840: under the id the entry's latest save was queued with (an entry queued before ids has none), so
      // a retry of a save that landed is answered as one (`duplicate`), never saved twice or refused.
      const replay = async expected => {
        const args = { p_order_id: oid, p_rows: replayRows(q.items), p_removal_reason: q.removal_reason || null }
        if (Number.isInteger(expected)) args.p_expected_version = expected
        if (q.save_id) args.p_save_id = q.save_id
        const abort = new AbortController()
        const out = await bounded(supabase.rpc('save_pos_order_items', args).abortSignal(abort.signal), 'Uploading an order', SEND_STEP_MS)
        if (noAnswer(out)) abort.abort()
        return out
      }
      // An order created here expects version 0 (the column's default): since S809 3f its insert may have
      // landed with the answer lost, and another tablet may have added to it since — refused, not
      // overwritten (review of 3f). A retry after this replay landed is read back below.
      let res = await replay(q.created_offline ? 0 : q.items_version)
      if (noAnswer(res)) return 'no_answer'
      let landed = false
      if (!res.error && res.data?.duplicate) {
        // S840: this save had landed already — an earlier try whose answer was lost — so the server did not
        // save it again and answered with the order as it stands. Its lines landed at the version that save
        // left, which the order lists; the answer's version may carry another tablet's save on top.
        landed = true
        landedId = q.save_id || null
        version = res.data.items_version
        const own = await bounded(scopedFrom('pos_orders', 'items_version, recent_saves').eq('id', oid).maybeSingle(), 'Checking an order', SEND_READ_MS)
        if (noAnswer(own)) return 'no_answer'
        const listed = own.error ? null : recentSaveOf(own.data?.recent_saves, q.save_id)
        if (own.error) console.error('offline sync: could not read which version this save left, using the order\'s:', own.error)
        if (listed && Number.isInteger(listed.v)) version = listed.v
      } else if (res.error?.hint === HINT.stale) {
        // ORDER-FLOW-7, Q16: what this entry holds may be on the order already — an upload that ran
        // twice, or a send whose answer was lost and which landed after all. S840: the order lists the
        // saves that landed by id, so this entry's own save, or its FIRST (the rest built on it), is found
        // by its id; lines that match with neither listed are another tablet's, and staff are asked to check
        // (judgeQueuedReadBack). An entry queued before ids is judged by its lines, as before.
        const back = await bounded(scopedFrom('pos_orders', OPEN_ORDER_SELECT).eq('id', oid).maybeSingle(), 'Checking an order', SEND_READ_MS)
        if (noAnswer(back)) return 'no_answer'
        if (back.error) { console.error('offline sync: read-back refused, will retry:', back.error); keptErrorRef.current = back.error; return 'kept' }
        if (back.data?.status !== 'open') return toConflict('closed')
        const judged = judgeQueuedReadBack(q, back.data)
        if (judged.verdict === 'landed') {
          landed = true
          landedId = judged.saveId
          version = judged.version
        } else if (judged.verdict === 'replay') {
          res = await replay(judged.version)
          if (noAnswer(res)) return 'no_answer'
        } else {
          return toConflict(judged.verdict)
        }
      }
      if (!landed) {
        if (res.error && authLapse(res)) return 'kept'
        if (res.error) {
          const reason = {
            [HINT.stale]: 'stale', [HINT.notOpen]: 'closed', [HINT.locked]: 'closed', [HINT.offMenu]: 'off_menu',
            [HINT.optionOff]: 'off_menu', [HINT.optionCount]: 'off_menu', [HINT.optionsOff]: 'off_menu',
            [HINT.comboDishOff]: 'off_menu', [HINT.comboOff]: 'off_menu',
          }[res.error.hint]
          // Any other refusal is the server's answer too, and no retry changes it (S731): a conflict with
          // its sentence, rather than an entry tried every 15 s for ever.
          return reason ? toConflict(reason) : toConflict('refused', errorText(res.error, 'staff'))
        }
        version = res.data?.items_version
        landedId = q.save_id || null
      }
    }

    // ORDER-FLOW-16: the order screen showing THIS order now — not the one shown when the upload started —
    // takes the version the upload left, before anything else can save it (its next save would otherwise
    // be refused as changed on another device), and, for an order created here, its real number.
    const onScreen = () => queuedHasLines(q) && screenOrderRef.current === oid && screenQueueRef.current === oid
    if (onScreen() && Number.isInteger(version)) itemsVersionRef.current = version

    // The tickets it printed, now that their order holds these lines (a ticket-only entry's order already
    // did). A ticket whose insert got no answer stays queued under its id and is tried again.
    const logged = await logQueuedSends(q, oid)
    // A ticket-only entry uploads after its order: a bill closed meanwhile has gone, so its tickets are
    // history, not work for the Kitchen Display (review of 3f).
    if (!queuedHasLines(q) && logged.ids.length > 0) {
      const st = await bounded(scopedFrom('pos_orders', 'status').eq('id', oid).maybeSingle(), 'Checking an order', SEND_READ_MS)
      if (!st.error && st.data?.status !== 'open') await serveTickets(logged.ids)
    }
    const left = await settlePosOrderUpload(key, {
      orderId: oid, rev: q.rev, items: q.items, lines: queuedHasLines(q), version: Number.isInteger(version) ? version : null,
      saveId: landedId, doneKeys: logged.keys,
    }).catch(err => { console.error('offline queue: an uploaded order could not be settled (the next try finds it landed):', err); return q })
    if (!queuedHasLines(left)) setPendingOrderIds(prev => { const next = new Set(prev); next.delete(oid); return next })

    if (onScreen() && q.created_offline) {
      const { data: synced, error: syncedErr } = await bounded(scopedFrom('pos_orders', 'order_no').eq('id', oid).maybeSingle(), 'Reading the order number', SEND_READ_MS)
      // Cosmetic only — the header keeps showing "#— (pending)" until the order is opened again.
      if (syncedErr) console.error('order_no backfill read failed:', syncedErr)
      else if (synced && onScreen()) setOrderNo(synced.order_no)
    }
    return logged.noAnswer ? 'no_answer' : 'done'
  }

  // A queued entry's tickets into pos_kot_log, under the ids they were queued with: a duplicate key means
  // an earlier try landed (ORDER-FLOW-7). Stops at the first insert that gets no answer. A refusal is the
  // server's answer and no retry changes it, so it is said once and not tried again. Returns the `keys`
  // settled, the `ids` now on the log, and whether it stopped for no answer.
  async function logQueuedSends(q, oid) {
    const out = { keys: [], ids: [], noAnswer: false }
    const already = new Set(q.logged_ids || [])
    const toLog = (q.kot_sends || []).filter(send => !already.has(queuedSendKey(send)))
    // S833: a ticket printed for an order created on this till carries no number (the server gives it at
    // upload), so the Kitchen Display and KOT Log showed it with none. The order holds it by now; a read
    // that fails logs the ticket without one, as before.
    let orderNo = null
    if (toLog.some(send => send.order_no == null)) {
      const no = await bounded(scopedFrom('pos_orders', 'order_no').eq('id', oid).maybeSingle(), 'Reading the order number', SEND_READ_MS)
      if (noAnswer(no)) { out.noAnswer = true; return out }
      if (no.error) console.error('offline sync: order number read failed, tickets logged without it:', no.error)
      else orderNo = no.data?.order_no ?? null
    }
    for (const send of toLog) {
      const res = await bounded(scopedInsert('pos_kot_log', { ...send, order_no: send.order_no ?? orderNo, order_id: oid }), 'Logging a ticket', SEND_READ_MS)
      if (noAnswer(res)) { out.noAnswer = true; break }
      if (res.error && (Number(res.status) === 401 || /jwt/i.test(res.error.message || ''))) break // asked again next time
      // No such order on the server: one created here that has yet to upload keeps its tickets for then
      // (review of 3f). A ticket-only entry's order was there, so for it the order is gone for good.
      if (res.error?.code === '23503' && queuedHasLines(q)) break
      out.keys.push(queuedSendKey(send))
      if (!res.error || res.error.code === '23505') { if (send.id) out.ids.push(send.id); continue }
      warnWrite(`A ${send.station === 'BOT' ? 'BOT' : 'KOT'} for ${send.table_name || 'an order'} printed while the internet was down, but it could not be added to the Kitchen Display or the KOT reports — make sure the ${send.station === 'BOT' ? 'bar' : 'kitchen'} has the paper ticket.`, res.error)
    }
    return out
  }
  flushRef.current = flushPosOrderQueue
  loadFloorRef.current = loadFloor
  loadMenuRef.current = loadMenu

  // S754 (owner decision): a conflict's items back onto the floor as UNSENT lines — a new order on
  // that table (or a new takeaway), or, if the table already has an open order again, that order
  // with these added. Nothing is saved here: the waiter reviews the lines and presses Send/Update,
  // and the conflict entry is discarded only once that save lands (performSave). Online only —
  // offline there is no way to know what is already open on the table.
  async function startOrderFromConflict(c) {
    setFloorMsg('')
    if (tillOffline()) { setFloorMsg('error:Reconnect first — the table has to be checked for an open order before these items can go back on it.'); return }
    // Unsent by construction, whatever the queue said (S754, owner decision): the waiter decides what to
    // send. S809 ORDER-FLOW-8: what this till already printed of them is named in the message, because
    // Send prints it again.
    const queuedLines = (c.items || []).map(cartLineFromStored) // its choices kept (review of 3f)
    const incoming = queuedLines.map(i => ({ ...i, sent_to_kot: false, sent_qty: 0 }))
    const printed = lines => recoveredPrintedNote(c, lines)
    if (incoming.length === 0) { setFloorMsg('error:That queued order has no items to put back.'); return }
    // A 'stale' or 'off_menu' conflict (S754) is an order that is STILL OPEN — another device saved it,
    // or a dish went off the menu — and the queue holds this device's whole cart, most of which that
    // order already carries. Put back only the difference, or every dish already on it doubles.
    const sameOrderStillOpen = c.reason === 'stale' || c.reason === 'off_menu' || c.reason === 'refused' || c.reason === 'sent_elsewhere'
    const toPutBack = serverLines => (sameOrderStillOpen ? missingFromServer(queuedLines, serverLines) : incoming)

    if (!c.table_id) {
      if (sameOrderStillOpen) {
        const { data: same, error: sameErr } = await scopedFrom('pos_orders', OPEN_ORDER_SELECT).eq('id', c.order_id).maybeSingle()
        if (sameErr) {
          showTillNotice(`Couldn't load that takeaway order. ${errorText(sameErr, 'staff')}\n\nNothing was changed — try again in a moment.`)
          return
        }
        if (same && same.status === 'open') {
          seatReservationRef.current = null
          const lines = showLoadedOrder(null, { id: same.id, orderNo: same.order_no, covers: same.covers, items: same.pos_order_items, itemsVersion: same.items_version, stored: same })
          // The same order (owner Q2): what this till already printed comes back as sent.
          const back = printedBackAsSent(c, toPutBack(same.pos_order_items))
          setOrderItems(mergeRecoveredLines(lines, back))
          setMsg(back.length
            ? `ok:The offline items that order did not already have were added to it — review them, then Update Order.${recoveredSentNote(back)}`
            : 'ok:That order already carries everything from the offline copy — nothing needed adding.')
          conflictRecoveryRef.current = c.order_id
          return
        }
      }
      setActiveTable(null); setOrderId(null); setOrderNo(null); itemsVersionRef.current = null
      setCovers(Math.max(1, parseInt(c.covers, 10) || 1))
      setOrderItems(incoming); markCartSaved([])
      setMsg(`ok:Items from the offline order are back on a new takeaway — review them, then Send Order.${printed(incoming)}`)
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
      showTillNotice(`Couldn't check whether ${table.name} already has an open order. ${errorText(existingErr, 'staff')}\n\nNothing was changed — try again in a moment.`)
      return
    }

    if (existing) {
      seatReservationRef.current = null
      // The table's order may itself wait to upload from this till: put the lines back onto its queued
      // copy, as openTable opens it, or the next save is refused for a screen missing those dishes and the
      // recovery can never finish (review of 3f, N2).
      const heldTarget = existing.id !== c.order_id ? await heldEntry(existing.id) : null
      const lines = heldTarget
        ? showLoadedOrder(table, { ...queuedOnScreen(heldTarget), orderNo: existing.order_no ?? null })
        : showLoadedOrder(table, { id: existing.id, orderNo: existing.order_no, covers: existing.covers, items: existing.pos_order_items, itemsVersion: existing.items_version, stored: existing })
      // One line per recipe on an order (sent flags are matched by recipe_id), so a recipe already
      // on it gains the quantity as an unsent change; its sent count stays, so only the added part
      // goes to the station. Only the difference when it is the same order (see toPutBack).
      // The same order (owner Q2, 2026-10-10): what this till already printed comes back as sent, so the
      // next send does not print it again. Another order on the table keeps them unsent (a new party).
      const sameOrder = existing.id === c.order_id
      const back = sameOrder ? printedBackAsSent(c, toPutBack(existing.pos_order_items)) : incoming
      setOrderItems(sameOrder ? mergeRecoveredLines(lines, back) : mergeUnsentLines(lines, back))
      setMsg(back.length === 0
        ? `ok:${table.name}'s order already carries everything from the offline copy — nothing needed adding.`
        : sameOrder
          ? `ok:The offline items ${table.name}'s order did not already have were added to it — review them, then Update Order.${recoveredSentNote(back)}`
          : `ok:${table.name} already had an open order — the offline items were added to it, unsent. Review them, then Update Order.${printed(back)}`)
    } else {
      seatReservationRef.current = null
      setActiveTable(table); setOrderId(null); setOrderNo(null); itemsVersionRef.current = null
      setCovers(Math.max(1, parseInt(c.covers, 10) || 1))
      setOrderItems(incoming); markCartSaved([])
      setMsg(`ok:Items from the offline order are on a new order for this table — review them, then Send Order.${printed(incoming)}`)
      setView('order'); loadMenu()
    }
    conflictRecoveryRef.current = c.order_id
  }

  function discardConflictOrder(orderIdToDiscard) {
    conflictIdsRef.current.delete(orderIdToDiscard)
    dequeuePosOrder(orderIdToDiscard).catch(err => console.error('offline queue: discard failed, the entry comes back on the next upload:', err))
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
  // Resolves true only when the menu was read from the server just now (S809 4h): a caller that
  // says "the menu has been reloaded" says it after this, and only on true.
  //
  // S847: the menu stays on screen between tables (it was re-read, with "Loading menu…", on every
  // table opened, behind the order read), and `background` is the floor's early read, before any
  // table is tapped. menuReadMode decides: a menu the server gave within MENU_FRESH_MS stands; one
  // on screen is re-read QUIETLY behind it; none on screen, a forced re-read or a saved copy to
  // replace (S841) reads by the full rules. Prices are safe either way: the server prices every new
  // line and a close stops on menuDrift.
  async function loadMenu({ force = false, background = false } = {}) {
    if (!clientId) return false
    // An operator's view of a client whose switches have not loaded yet would read it with
    // Customization off; the table opened next reads it with them.
    if (background && isAdmin && !clientModulesKnown) return false
    // One read at a time: one in flight answers for this call too. Except the floor's early read
    // that did not land for a screen with no menu: the table opened now reads by the full rules,
    // so the waiter is told, or handed the saved copy.
    const inFlight = menuInFlightRef.current
    if (inFlight && !force) {
      const landed = await inFlight.promise
      if (landed || background || inFlight.hadMenu || inFlight.mode === 'full') return landed
    }
    // S841: a menu taken from the saved copy is read from the server again the next time the order
    // screen opens with the link up, so a menu changed during an outage is not kept all day.
    const refreshSaved = menuFromSavedRef.current && !tillOffline()
    const hasMenu = menuLoaded || menuReadAtRef.current > 0
    const readAt = menuReadCustomRef.current === customizationEnabled ? menuReadAtRef.current : 0
    const mode = menuReadMode({ hasMenu, savedToReplace: refreshSaved, readAt, now: Date.now(), force, background })
    if (mode === 'none') return false
    const entry = { promise: readMenu(mode, refreshSaved), mode, hadMenu: hasMenu, custom: customizationEnabled }
    menuInFlightRef.current = entry
    try { return await entry.promise } finally { if (menuInFlightRef.current === entry) menuInFlightRef.current = null }
  }

  async function readMenu(mode, refreshSaved) {
    // The copy of the menu saved on this tablet at its last complete online read. False when this
    // device has none: it has never loaded the menu online.
    const takeSavedMenu = async () => {
      const cached = await getCachedPosMenu(clientId).catch(err => { console.error('saved menu read failed:', err); return null })
      if (!cached) return false
      setMenu(cached.menu || [])
      setManualSuggestions(cached.manualSuggestions || {})
      // Offline customized orders are allowed (owner decision): the till uses its saved copy of the
      // options, and the server prices them when the order syncs.
      if (cached.optionCatalog) setOptionCatalog(cached.optionCatalog)
      setMenuLoaded(true)
      setMenuLoadError('')
      menuFromSavedRef.current = true
      return true
    }

    // S841 (P0): the till's own link test, not navigator.onLine. That flag is true on a restaurant
    // wifi whose internet is down, so a till reloaded in that outage asked the server, heard
    // nothing, never looked at its saved menu, and had no menu and no way to take an order.
    // A quiet read keeps what is on screen (S847).
    if (tillOffline()) { if (mode === 'full') await takeSavedMenu(); return false }

    const [{ data, error: menuErr }, { data: suggData, error: suggErr }, catalog, comboCatalog, { data: eggData, error: eggErr }] = await Promise.all([
      // is_veg is the dish's food mark on the tile (S846); it dates from July, so naming it is safe.
      bounded(scopedFrom('recipes', 'id, name, category, recipe_code, selling_price, vat_rate, me_class, is_veg')
        .eq('is_active', true)
        .eq('pos_enabled', true)
        // `.or(...)`, not `.neq('category','Sub-Recipe')` (S714). category is NULLABLE with no
        // default and a server-side .neq drops NULL rows too, so a dish with no category was
        // missing from the till's menu entirely — unorderable, with no error and nothing on screen
        // to say a row had been filtered out. Same fix as Menu Pricing's own read.
        .or('category.is.null,category.neq.Sub-Recipe')
        // S809 2h: a dish with no price above zero is left off, as the guest menu does. The till
        // billed it at NPR 0; save_pos_order_items now refuses it as a new line (line_not_on_menu).
        .gt('selling_price', 0)
        .order('name'), 'Loading the menu', OPEN_READ_MS),
      bounded(scopedFrom('recipe_suggestions', 'recipe_id, suggest_recipe_id'), 'Loading dish pairings', OPEN_READ_MS),
      customizationEnabled
        ? bounded(loadOptionCatalog(scopedFrom), 'Loading dish choices', OPEN_READ_MS)
        : Promise.resolve({ error: null, groups: [], options: [], attachments: [], buildYourOwn: [] }),
      // Combos (S839): the outlet's active combos, their picks and dishes, and every combo dish's recipe
      // (a side sold only in combos is not On POS, so the menu read above does not have it).
      customizationEnabled
        ? bounded(loadComboCatalog(scopedFrom), 'Loading combos', OPEN_READ_MS)
        : Promise.resolve({ error: null, combos: [], recipes: {} }),
      // S846: which dishes are Egg. Its own read because the till never names a new recipe column
      // in its menu query (the S760 rule): on a database without is_egg this one fails, is ignored,
      // and the tiles show veg / non-veg as before. Never a menu failure.
      bounded(scopedFrom('recipes', 'id').eq('is_egg', true).eq('is_active', true).eq('pos_enabled', true),
        'Loading egg marks', OPEN_READ_MS),
    ])
    // S862 TILL-GUEST-1: read under a Customization switch that has moved since: its choices and
    // combos are the old setting's, so it is dropped, and never without a read under the new switch
    // on its way: the effect on the switch may have started one; if not, it starts here, through the
    // latest loadMenu (set in the same render as the switch), or a first read would stay loading.
    if (customizationNowRef.current !== customizationEnabled) {
      const next = menuInFlightRef.current
      if (!(next && next.custom === customizationNowRef.current)) {
        void Promise.resolve(loadMenuRef.current?.({ force: true }))
          .catch(e => console.error('menu re-read after a Customization switch failed:', e))
      }
      return false
    }
    // S847: a quiet read that failed, or heard nothing, keeps the menu on screen (or none, for the
    // floor's early read) and says nothing. It never marks the internet down: a background read on a
    // slow link is not the waiter's table failing to open. The next order screen asks again.
    const menuReadErr = menuErr || catalog.error || comboCatalog.error
    if (mode === 'quiet' && menuReadErr) {
      console.error('menu re-read failed, keeping the menu on screen:', menuReadErr)
      return false
    }
    // S841: no answer is the internet, not the menu (S809 3f's rule for orders). A menu already on
    // screen stays; a screen with none takes the saved copy, and says so only when there is none.
    if ([menuErr, catalog.error, comboCatalog.error].some(noReply)) {
      noteLinkDown()
      if (menuLoaded || menuFromSavedRef.current || await takeSavedMenu()) return false
      setMenuLoadError("This till can't reach the server and has no saved menu yet, so no dish can be added. Check the internet connection, then press Retry.")
      return false
    }
    // A refresh of the saved copy that the server refused keeps the saved copy: it is still a menu
    // the till can take orders from, and the next order screen tries again.
    if (refreshSaved && (menuErr || catalog.error || comboCatalog.error)) {
      console.error('menu refresh failed, keeping the saved menu:', menuErr || catalog.error || comboCatalog.error)
      return false
    }
    // S754: a dropped error here rendered "No POS-enabled items" over a menu the client has, AND
    // cached that empty menu as the offline fallback. Keep last-good, leave menuLoaded false so a
    // Retry actually re-reads, and say it failed.
    if (menuErr) {
      console.error('loadMenu failed, keeping the last menu:', menuErr)
      setMenuLoadError(errorText(menuErr, 'staff'))
      return false
    }
    // A failed options read is a failed menu read: without it a dish that must have a size could be
    // added plain. Same keep-last-good rule.
    if (catalog.error) {
      console.error('option catalog read failed, keeping the last menu:', catalog.error)
      setMenuLoadError(`The dish choices could not be read, so a dish that needs a size or choice cannot be added yet. (${catalog.error})`)
      return false
    }
    // A failed combo read is a failed menu read too: the Combos tab would otherwise read as none.
    if (comboCatalog.error) {
      console.error('combo read failed, keeping the last menu:', comboCatalog.error)
      setMenuLoadError(`The combos could not be read, so a combo cannot be added yet. ${errorText(comboCatalog.error, 'staff')}`)
      return false
    }
    setMenuLoadError('')
    // The combos ride in the option catalog, so the offline copy of the menu carries them too.
    const nextCatalog = {
      groups: catalog.groups, options: catalog.options, attachments: catalog.attachments, buildYourOwn: catalog.buildYourOwn || [],
      combos: comboCatalog.combos || [], comboRecipes: comboCatalog.recipes || {},
    }
    // S847: a re-read that changed nothing keeps the objects on screen, so the tiles do not redraw
    // under a waiter's finger once a minute. The whole value is the signature: every field drawn is in it.
    setIfChanged(setOptionCatalog, nextCatalog, sameJson)
    if (eggErr) console.error('egg-dish read failed, tiles show veg / non-veg only:', eggErr)
    const eggIds = new Set(eggErr ? [] : (eggData || []).map(r => r.id))
    const menuRows = (data || []).map(r => (eggIds.has(r.id) ? { ...r, is_egg: true } : r))
    setIfChanged(setMenu, menuRows, sameJson)
    let suggMap = {}
    if (suggErr) console.error('recipe_suggestions read failed — pairings fall back to the other signals:', suggErr)
    else if (suggData) {
      suggData.forEach(s => {
        if (!suggMap[s.recipe_id]) suggMap[s.recipe_id] = []
        suggMap[s.recipe_id].push(s.suggest_recipe_id)
      })
      setIfChanged(setManualSuggestions, suggMap, sameJson)
    }
    setMenuLoaded(true)
    menuReadAtRef.current = Date.now()
    menuReadCustomRef.current = customizationEnabled
    menuFromSavedRef.current = false
    // Only a complete read is worth keeping as the offline copy.
    if (!suggErr) cachePosMenu(clientId, menuRows, suggMap, nextCatalog)
    return true
  }

  // A refusal that means the menu on screen is stale: say it now, re-read the menu, and add "The
  // menu has been reloaded." only once a reload has landed (S809 4h). It used to be said before the
  // reload ran, and when the reload failed.
  function refuseAndReloadMenu(text) {
    const shown = `error:${text}`
    setMsg(shown)
    reloadMenuThenSay(shown, MENU_RELOADED_TEXT)
  }
  // The re-read itself: `more` is added to `shown` once it lands, if nothing has replaced the message.
  function reloadMenuThenSay(shown, more) {
    void loadMenu({ force: true }).then(
      ok => { if (ok) setMsg(m => (m === shown ? `${shown} ${more}` : m)) },
      e => console.error('menu reload after a refusal failed:', e),
    )
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
    // tile's pick from the last minute tick. In the tile's own order (reservationsByTable above): due
    // now, then a party marked arrived whatever the clock says (S809 RESERVATIONS-2).
    return bookingToSeatOnTap(floorReservations, tableId, Date.now(), reservationSettings.seat_window_minutes)
  }

  // S835: the lines a till lock kept, but only for the place they were rung on: their table, or their
  // takeaway by its order id. The restore opens that place itself; a table tapped while its reads run
  // used to take them. A kept new takeaway is put back only by the restore's own direct call.
  function keptCartFor(table, loadedOrderId) {
    const kept = lockedCartRef.current
    if (!kept) return null
    if (kept.tableId) return table?.id === kept.tableId ? kept : null
    if (kept.orderId) return !table && loadedOrderId === kept.orderId ? kept : null
    return null
  }

  // The original tail of openTable for a table with no order on it: a pending guest QR request
  // supplies the covers, otherwise the numpad asks. Also the "Walk-in instead" answer to the
  // seat prompt below.
  function startFreshOrder(table) {
    // Lines a till lock kept for this login, for a table whose order was never saved or has since
    // closed (S776): straight onto a new order with the covers they had, no numpad to re-answer.
    const kept = keptCartFor(table, null)
    setScreenOrder(null)
    if (kept) {
      setActiveTable(table)
      setOrderId(null); setOrderNo(null); setOrderItems([]); markCartSaved([]); itemsVersionRef.current = null
      setCovers(kept.covers || 1)
      setMsg(''); setView('order'); loadMenu()
      applyLockedCart([], null)
      return
    }
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
    setScreenOrder(null)
    setActiveTable(table)
    setOrderId(null); setOrderNo(null); setOrderItems([]); markCartSaved([]); itemsVersionRef.current = null
    setCovers(Math.max(1, parseInt(res.party_size, 10) || 1))
    setBuyerName(res.customer_name || '')
    setBuyerPhone(res.phone || '')
    setMsg(''); setView('order'); loadMenu()
  }

  // The cart as a comparable map, for the unsaved-changes check on ← (S754). Keyed by line
  // (recipe plus customization), and only what a save would change — qty and note, never the sent flag.
  function cartKeyMap(items) {
    const m = new Map()
    for (const i of items || []) m.set(lineKeyOf(i), `${i.qty}|${(i.notes || '').trim()}`)
    return m
  }
  function markCartSaved(items) { savedItemsRef.current = cartKeyMap(items) }
  function unsavedChangeCount(items) { return changedSince(savedItemsRef.current, items) }
  // Lines of `items` whose qty or note differ from `base` (a cartKeyMap), counting lines gone from it.
  function changedSince(base, items) {
    const cur = cartKeyMap(items)
    let n = 0
    for (const [k, v] of cur) if (base.get(k) !== v) n++
    for (const k of base.keys()) if (!cur.has(k)) n++
    return n
  }

  // S836: the floor's row for a bill's STORED table, so a screen follows a bill another till moved.
  // `synthetic` stands in a row the floor list does not hold yet (a table added since the last poll);
  // a bill whose table left the floor plan (S834) otherwise opens on no table, as it always has.
  function tableOfStored(o, fallback = null, { synthetic = true } = {}) {
    if (!o?.table_id) return null
    const row = tables.find(t => t.id === o.table_id) || (fallback?.id === o.table_id ? fallback : null)
    return row || (synthetic ? { id: o.table_id, name: o.table_name || 'Table' } : null)
  }

  // S836: a bill that is gone rather than closed went somewhere: a join took it into another table's
  // bill, or a part bill went back onto its table's. The record says where (pos_table_moves), and the
  // screen opens that bill, offering back anything this till had not saved. False when not found.
  async function openWhereBillWent(oNo, where, snapshot = []) {
    if (!oNo) return false
    const { data, error } = await bounded(scopedFrom('pos_table_moves', 'kind, to_order_id, to_table_name')
      .in('kind', ['join', 'part_back']).eq('from_order_no', oNo)
      .order('moved_at', { ascending: false }).limit(1), 'Finding the bill', SEND_READ_MS)
    const row = !error && data?.[0]
    if (!row?.to_order_id) return false
    setStaleRecovery(null)
    const lines = await openOrderById(row.to_order_id)
    if (!Array.isArray(lines)) return true // openOrderById said why on the floor
    const missing = missingFromServer(snapshot, lines)
    if (missing.length > 0) setStaleRecovery({ where, missing, guestReqs: [] })
    setMsg(`error:${where} was ${row.kind === 'join' ? 'joined into' : 'put back on'} ${row.to_table_name || 'another table'}'s bill on another device — this is that bill now.${missing.length > 0 ? ' Add your items again.' : ' Check it before you send or take payment.'}`)
    return true
  }

  // ── S836: move, join and split a table (owner decisions 2026-10-14) ──
  // The server moves what is STORED, in one transaction, and bumps the version of every bill it
  // touches, so a till holding the old view is refused its next save or close and reloads. These only
  // ask it, then put the result on screen and tell the kitchen.

  // What stops a table action before it starts: the bill must be on the server as this screen shows it.
  function tableActionRefusal() {
    if (tillOffline()) return 'Moving, joining or splitting needs a connection — the server moves the bill.'
    if (!orderId || !orderNo) return 'Send or save the order first — a bill not on the server yet cannot be moved.'
    if (screenQueueRef.current === orderId) return 'This order is still waiting on this till to upload. Try again once it has.'
    if (saving) return 'Wait for the save to finish, then try again.'
    if (unsavedChangeCount(orderItems) > 0) return 'Send or save the new items first (or take them off), then try again.'
    if (sendAttemptsFor(orderId).length > 0) return 'This till is still checking whether its last send landed. Try again in a moment.'
    if (closeAttemptFor(orderId)) return 'A payment try on this bill has not settled yet. Try again once it has.'
    return null
  }

  // Re-reads the bill on screen and puts it back, on its stored table (it may have moved).
  async function reopenScreenBill(oid = orderId) {
    const { data: fresh, error } = await bounded(scopedFrom('pos_orders', OPEN_ORDER_SELECT).eq('id', oid).maybeSingle(), 'Loading the bill', SEND_READ_MS)
    if (error || !fresh || fresh.status !== 'open') return { error, gone: !error && !fresh, closed: fresh && fresh.status !== 'open' }
    const table = tableOfStored(fresh, activeTable)
    const lines = showLoadedOrder(table, { id: fresh.id, orderNo: fresh.order_no, covers: fresh.covers, items: fresh.pos_order_items, itemsVersion: fresh.items_version, stored: fresh })
    if (table?.id) cachePosOrderForTable(table.id, { orderId: fresh.id, orderNo: fresh.order_no || null, covers: fresh.covers || 1, items: lines, itemsVersion: itemsVersionRef.current })
    return { fresh, table }
  }

  // A refused or unanswered table action. Nothing moved on a refusal (each is one transaction); with no
  // answer it may have, so the bill is read back and shown as it now stands.
  async function tableActionFailed(res, what) {
    setTableDialog(null)
    const err = res.error
    if (noAnswer(res)) {
      const back = await reopenScreenBill()
      loadFloor({ quiet: true })
      setMsg(`error:No answer from the server, so it is not known whether the ${what} went through. ${back.fresh ? 'The bill as it stands now is on screen — check it before trying again.' : 'Go back to the floor and check the table.'}`)
      return
    }
    if (err?.hint === 'stale_order') { await reloadAfterStale(orderId, orderItems); return }
    if (err?.hint === 'pos_move_order_missing') {
      if (await openWhereBillWent(orderNo, orderLabel(), orderItems)) return
      showClosedElsewhere(); return
    }
    if (err?.hint === 'order_not_open') { showClosedElsewhere(); return }
    loadFloor({ quiet: true }) // the tables have changed under this till: the next dialog shows them as they are
    setMsg(`error:Nothing moved — ${errorText(err, 'staff')}`)
  }

  // The kitchen's half of a move (owner decision: a slip AND the screen). Each station still making food
  // for the bill gets a printed move slip, and a CHANGE ticket on the Kitchen Display under the table the
  // food now goes to (Seen clears it; no count of tickets includes it, kitchenNotes.js). Best-effort like
  // every ticket log: the move has landed, so a failure is said, never undone. Returns the sentence.
  async function sendMoveNotice({ ticketOrderId, onlyKeys = null, noticeOrderId, noticeOrderNo, toName, fromName }) {
    const { data, error } = await bounded(scopedFrom('pos_kot_log', 'station, items, status')
      .eq('order_id', ticketOrderId).in('status', ['new', 'in_progress', 'ready'])
      .order('sent_at').order('id'), 'Reading the kitchen tickets', SEND_READ_MS)
    if (error) return ` The kitchen tickets could not be read, so no move slip printed — tell the kitchen and bar the food now goes to ${toName}.`
    const byStation = moveSlipItems(data || [], onlyKeys)
    const stations = Object.keys(byStation)
    if (stations.length === 0) return ''
    const movedAt = new Date().toISOString()
    const movedBy = printedStaffName(profile, isAdmin)
    let printed = true
    for (const st of stations) {
      const doc = moveSlipDoc({ station: st, outletName, fromTable: fromName, toTable: toName, orderNo: noticeOrderNo, items: byStation[st], movedBy, movedAt })
      const res = stationPrint.deliver({ station: st, kind: 'move', doc, label: `Moved to ${toName}${noticeOrderNo != null ? ` · #${noticeOrderNo}` : ''}` })
      if (!(res.via === 'device' || res.printed)) printed = false
    }
    const sends = stations.map(st => ({
      id: randomUUID(), order_id: noticeOrderId, order_no: noticeOrderNo, table_name: toName, station: st,
      items: moveNoticeItems(byStation[st], fromName), sent_by: profile?.id || null,
    }))
    const res = await bounded(scopedInsert('pos_kot_log', sends), 'Telling the kitchen', SEND_STEP_MS)
    const shown = !res.error || res.error.code === '23505'
    if (!shown) console.error('move notice for the Kitchen Display failed:', res.error)
    const where = stations.map(st => (st === 'BOT' ? 'bar' : 'kitchen')).join(' and ')
    if (!printed && !shown) return ` Tell the ${where} the food now goes to ${toName}: the move slip did not print (allow pop-ups) and the Kitchen Display could not be told.`
    if (!printed) return ` The move slip did not print (allow pop-ups for this site); the Kitchen Display shows the move.`
    if (!shown) return ` The ${where} got a move slip; the Kitchen Display could not be told.`
    return ` The ${where} got a move slip.`
  }

  // Opens a Table menu dialog. The dish dialogs pick from the bill AS STORED: its line ids are what the
  // server moves, so it is read fresh, and a bill another device changed is reloaded instead.
  async function openTableDialog(kind) {
    const why = tableActionRefusal()
    if (why) { setMsg(`error:${why}`); return }
    if (kind === 'move') { loadFloor({ quiet: true }); setTableDialog('move'); return }
    if (kind === 'part' && !billingSettingsLoaded) { setMsg(`error:${tillSettingsBlockText(!!settingsFailure)}`); loadTillSettings(); return }
    setTableBusy(true)
    const { data, error } = await bounded(scopedFrom('pos_orders', OPEN_ORDER_SELECT).eq('id', orderId).maybeSingle(), 'Reading the bill', SEND_READ_MS)
    setTableBusy(false)
    if (error) { setMsg(`error:Could not read this bill to pick dishes from. ${errorText(error, 'staff')}`); return }
    if (!data) { if (!(await openWhereBillWent(orderNo, orderLabel(), orderItems))) showClosedElsewhere(); return }
    if (data.status !== 'open') { showClosedElsewhere(); return }
    if (data.items_version !== itemsVersionRef.current) { await reloadAfterStale(orderId, orderItems, { data, error: null }); return }
    // S839: a combo is offered as one row, so it can only move (or be paid for) whole.
    setTableDialogLines(collapseCombosForMove((data.pos_order_items || []).map(cartLineFromStored)))
    if (kind === 'dishes') loadFloor({ quiet: true })
    setTableDialog(kind)
  }

  async function moveBillToTable(t) {
    const why = tableActionRefusal()
    if (why) { setTableDialog(null); setMsg(`error:${why}`); return }
    const fromName = screenTableName
    const fromId = activeTable?.id || null
    setTableBusy(true)
    const res = await bounded(supabase.rpc('move_pos_order_table', {
      p_order_id: orderId, p_to_table_id: t.id, p_expected_version: itemsVersionRef.current,
    }), 'Moving the bill', SEND_STEP_MS)
    setTableBusy(false)
    // Another till sat a party there first: the join is the answer, asked as one.
    if (res.error?.hint === 'pos_move_table_busy') { setTableDialog(null); loadFloor({ quiet: true }); askJoinBill(t); return }
    if (res.error) { await tableActionFailed(res, 'move'); return }
    setTableDialog(null)
    if (fromId) clearCachedPosOrderForTable(fromId).catch(e => console.error('order snapshot clear failed (non-fatal):', e))
    const oid = orderId
    const oNo = orderNo
    await reopenScreenBill(oid)
    loadFloor({ quiet: true })
    const slip = await sendMoveNotice({ ticketOrderId: oid, noticeOrderId: oid, noticeOrderNo: oNo, toName: t.name, fromName })
    const released = (res.data?.released_table_ids || []).length
    const booking = res.data?.warning === 'booking_table_kept' ? ' The booking still shows the old table in Reservations.' : ''
    setMsg(`ok:Moved to ${t.name}.${released ? ` ${released === 1 ? 'Its extra table is' : 'Its extra tables are'} free again — join ${released === 1 ? 'it' : 'them'} here if the group still needs ${released === 1 ? 'it' : 'them'}.` : ''}${slip}${booking}`)
  }

  // A table with a bill of its own joins only after a yes: its bill goes into this one for good.
  function askJoinBill(t) {
    askConfirm({
      title: `Join ${t.name}'s bill into this one?`,
      confirmLabel: 'Join the bills',
      cancelLabel: 'Keep them apart',
      zIndex: 1200,
      body: (
        <p style={{ margin: 0 }}>
          {t.name}&rsquo;s dishes, guests and kitchen tickets come onto this bill, and its own bill number goes.
          Both tables stay taken until this bill is paid. If the same dish is on both at different prices,
          the lower price is kept.
        </p>
      ),
      run: () => joinTableToBill(t),
    })
  }

  async function joinTableToBill(t) {
    const why = tableActionRefusal()
    if (why) { setTableDialog(null); setMsg(`error:${why}`); return }
    setTableBusy(true)
    // The other bill is taken as it stands (no version of it is held here): a till with it open is
    // refused its next save and lands on this bill (openWhereBillWent).
    const res = await bounded(supabase.rpc('join_pos_tables', {
      p_order_id: orderId, p_table_id: t.id, p_expected_version: itemsVersionRef.current, p_other_expected_version: null,
    }), 'Joining the table', SEND_STEP_MS)
    setTableBusy(false)
    if (res.error) { await tableActionFailed(res, 'join'); return }
    setTableDialog(null)
    clearCachedPosOrderForTable(t.id).catch(e => console.error('order snapshot clear failed (non-fatal):', e))
    const d = res.data || {}
    await reopenScreenBill()
    loadFloor({ quiet: true })
    const n = (d.lines || []).reduce((s, l) => s + (Number(l.qty) || 0), 0)
    setMsg(`ok:${t.name} is on this bill now${d.absorbed_order_no ? `, with its ${n} item${n === 1 ? '' : 's'} (bill #${d.absorbed_order_no})` : ''}. Both tables stay taken until it is paid.`)
  }

  async function releaseJoinedTable(t) {
    if (tillOffline()) { setMsg('error:Releasing a table needs a connection.'); return }
    setTableBusy(true)
    const res = await bounded(supabase.rpc('release_joined_table', { p_table_id: t.id }), 'Releasing the table', SEND_STEP_MS)
    setTableBusy(false)
    loadFloor({ quiet: true })
    if (res.error) {
      setMsg(`error:${noAnswer(res) ? `No answer from the server — check the floor to see whether ${t.name} was released.` : errorText(res.error, 'staff')}`)
      return
    }
    setTableJoins(prev => { const next = { ...prev }; delete next[t.id]; return next })
    setMsg(`ok:${t.name} is free again. Nothing came off this bill.`)
  }

  async function moveDishesToTable({ picks, tableId, covers: guests }) {
    const why = tableActionRefusal()
    if (why) { setTableDialog(null); setMsg(`error:${why}`); return }
    const t = tables.find(x => x.id === tableId)
    if (!t) return
    const fromName = screenTableName
    const srcId = orderId
    setTableBusy(true)
    const res = await bounded(supabase.rpc('move_pos_order_lines', {
      p_from_order_id: orderId, p_to_table_id: tableId, p_lines: picks,
      p_expected_version: itemsVersionRef.current, p_to_expected_version: null, p_covers: guests,
    }), 'Moving the dishes', SEND_STEP_MS)
    setTableBusy(false)
    if (res.error) { await tableActionFailed(res, 'move'); return }
    setTableDialog(null)
    const d = res.data || {}
    clearCachedPosOrderForTable(tableId).catch(e => console.error('order snapshot clear failed (non-fatal):', e))
    await reopenScreenBill(srcId)
    loadFloor({ quiet: true })
    // The tickets that carried the food are this bill's; the notice goes on the bill that has it now.
    const slip = await sendMoveNotice({ ticketOrderId: srcId, onlyKeys: movedSentByKey(d.lines), noticeOrderId: d.to_order_id, noticeOrderNo: d.to_order_no, toName: t.name, fromName })
    const n = picks.reduce((s, p) => s + p.qty, 0)
    const onto = d.new_bill ? ` — a new bill #${d.to_order_no} is open there`
      : d.to_bill_table_name && d.to_bill_table_name !== t.name ? ` (onto ${d.to_bill_table_name}'s bill)` : ''
    setMsg(`ok:${n} item${n === 1 ? '' : 's'} moved to ${t.name}${onto}.${slip}`)
  }

  async function makePartBill({ picks, covers: guests }) {
    const why = tableActionRefusal()
    if (why) { setTableDialog(null); setMsg(`error:${why}`); return }
    setTableBusy(true)
    const res = await bounded(supabase.rpc('split_pos_part_bill', {
      p_from_order_id: orderId, p_lines: picks, p_expected_version: itemsVersionRef.current, p_covers: guests,
    }), 'Making the part bill', SEND_STEP_MS)
    setTableBusy(false)
    if (res.error) { await tableActionFailed(res, 'split'); return }
    setTableDialog(null)
    const d = res.data || {}
    if (activeTable?.id) clearCachedPosOrderForTable(activeTable.id).catch(e => console.error('order snapshot clear failed (non-fatal):', e))
    loadFloor({ quiet: true })
    // Straight into Payment, through the one funnel that bills an opened order (billOnOpenRef →
    // showLoadedOrder), as the Billing station does.
    billOnOpenRef.current = true
    try { await openOrderById(d.part_order_id) } finally { billOnOpenRef.current = false }
    setMsg(`ok:Part bill #${d.part_order_no} is open for payment. The rest stays on ${d.table_name || 'the table'}.`)
  }

  // A part bill whose payment was cancelled goes back on its table's bill if the waiter says so;
  // otherwise it waits as its own card on the floor and the Billing list, to be paid later or put back
  // from the Table menu.
  function offerPutBackPart() {
    if (!screenOrder?.partOf || !orderId) return
    const where = screenTableName
    askConfirm({
      title: `Put these dishes back on ${where}?`,
      confirmLabel: `Put back on ${where}`,
      cancelLabel: 'Keep the part bill',
      zIndex: 1200,
      body: (
        <p style={{ margin: 0 }}>
          No payment was taken. Putting the dishes back moves them onto {where}&rsquo;s bill again, and this part
          bill goes. Keep it to take the payment later: it waits on the floor as its own bill.
        </p>
      ),
      run: putBackPartBill,
    })
  }

  async function putBackPartBill() {
    if (tillOffline()) { setMsg('error:Putting a part bill back needs a connection.'); return }
    if (closeAttemptFor(orderId)) { setMsg('error:A payment try on this part bill has not settled yet — check Recent Bills before putting it back.'); return }
    if (unsavedChangeCount(orderItems) > 0) { setMsg('error:Send or save the new items first (or take them off), then put the part bill back.'); return }
    const partNo = orderNo
    setTableBusy(true)
    const res = await bounded(supabase.rpc('put_back_part_bill', {
      p_part_order_id: orderId, p_expected_version: itemsVersionRef.current, p_parent_expected_version: null,
    }), 'Putting the dishes back', SEND_STEP_MS)
    setTableBusy(false)
    if (res.error) { await tableActionFailed(res, 'put-back'); return }
    const d = res.data || {}
    const table = d.table_id ? (tables.find(t => t.id === d.table_id) || { id: d.table_id, name: d.table_name || 'Table' }) : null
    if (table) await openTable(table)
    else await openOrderById(d.order_id)
    loadFloor({ quiet: true })
    setMsg(`ok:Part bill #${partNo} is back on ${d.table_name || 'the table'}'s bill.`)
  }

  // Puts a loaded order on the order screen. Shared by the table tile, the offline queue/snapshot
  // paths and the takeaway card (S754), so the three cannot drift on what "open an order" sets.
  // sent_qty comes from the stored/queued line (it used to be re-derived from sent_to_kot alone, which
  // lost a "2 of 3 sent" line's count on every reload); itemsVersion is what the next save expects.
  function showLoadedOrder(table, { id, orderNo: no, covers: cv, items, itemsVersion, fromQueue = false, stored = null }) {
    screenQueueRef.current = fromQueue ? id : null // S809 3f: whether this cart is this till's queued copy
    // S836: the bill as stored (a server read passes its row). A queued copy keeps what the screen knew.
    setScreenOrder(prev => (stored
      ? { id, tableId: stored.table_id || null, tableName: stored.table_name || null, partOf: stored.part_of_order_id || null }
      : prev?.id === id ? prev : { id, tableId: table?.id || null, tableName: table?.name || null, partOf: null }))
    // S809 2b (CHECKOUT-10): a comp a cancelled close left behind folds back into its line.
    const lines = foldCompedSplits(items).map(cartLineFromStored)
    itemsVersionRef.current = Number.isInteger(itemsVersion) ? itemsVersion : null
    setStaleRecovery(null)
    setActiveTable(table)
    setOrderId(id)
    setOrderNo(no || null)
    setCovers(cv || 1)
    coversSavedRef.current = { orderId: id, covers: cv || 1 }
    setOrderItems(lines)
    markCartSaved(lines)
    setMsg(''); setView('order'); loadMenu()
    // Armed by billOrder() only, and only ever consumed here — the one place an EXISTING order
    // reaches the screen. A path that never gets here (a fresh table, a refused read) therefore
    // cannot leave the flag armed for whatever order is opened next.
    if (billOnOpenRef.current) { billOnOpenRef.current = false; setBillOnLoad(true) }
    // The same funnel brings back what a till lock kept for this login (S776), measured against the
    // order AS IT NOW STANDS — anything another device saved meanwhile is not added twice.
    if (keptCartFor(table, id)) applyLockedCart(items, id)
    // S809 ORDER-FLOW-3 (3e): a save of this order the till never heard back from is settled now — a
    // send that landed prints the ticket the kitchen never got.
    if (sendAttemptsFor(id).length > 0) void settleSendAttempts(id)
    return lines
  }

  // Puts the lines a till lock kept (posLockedCart.js) back as UNSENT: only what the order on screen
  // does not already carry, by the same rule a stale save uses (missingFromServer), and never more than
  // the till had not saved (keptLinesToRestore). Consumes the ref, so the lines come back once.
  function applyLockedCart(serverItems, loadedOrderId) {
    const kept = lockedCartRef.current
    lockedCartRef.current = null
    if (!kept) return
    const moved = kept.orderId && kept.orderId !== loadedOrderId
    // S809 ORDER-FLOW-10: the order these lines were rung on has closed, and the table carries another
    // order now (most likely the next party's, who would be billed for them). Never added to it: named,
    // for the waiter to add by hand if this party wants them.
    if (moved && loadedOrderId) {
      const what = keptLinesText(kept)
      const one = (Number(kept.unsentUnits) || 0) === 1
      if (what) setMsg(`error:Not added to this order: ${what}, not sent before ${keptBefore(kept)}. ${one ? 'It was' : 'They were'} rung on ${kept.tableName || 'this table'}'s order${kept.orderNo ? ` #${kept.orderNo}` : ''}, which has since closed, and this is a different order. If this party wants ${one ? 'it' : 'them'}, add ${one ? 'it' : 'them'} by hand.`)
      return
    }
    // Only what the till had not saved, measured against the order as it now stands (ORDER-FLOW-10).
    const missing = keptLinesToRestore(kept.items, serverItems)
    // Guest QR orders accepted into the kept cart (S809.4, 3c). Back with their dishes, they stay
    // accepted on this screen: off the banner, marked by the next save. If nothing came back onto the
    // same order, the save they rode on landed though the till never heard: marked onto it now.
    const guestReqs = Array.isArray(kept.guestReqs) ? kept.guestReqs.filter(g => g?.id) : []
    if (missing.length === 0) {
      if (guestReqs.length > 0 && loadedOrderId && kept.orderId === loadedOrderId) {
        for (const g of guestReqs) unmarkedGuestAcceptsRef.current.set(g.id, loadedOrderId)
        void markGuestAccepts()
      }
      return
    }
    for (const g of guestReqs) rememberAcceptedGuestReq(g)
    if (guestReqs.length > 0) loadPendingGuestOrders()
    const units = missing.reduce((n, m) => n + (Number(m.qty) || 0), 0)
    setOrderItems(prev => mergeUnsentLines(prev, missing))
    setMsg(`ok:${units} item${units === 1 ? '' : 's'} not sent before ${keptBefore(kept)} ${units === 1 ? 'is' : 'are'} back${moved ? ' — the order they were on has closed, so this is a new one' : ''}. Check, then send or save.`)
  }

  // After a PIN sign-in: the order this login left when the till locked, reopened (S776). Its lines
  // land through showLoadedOrder or startFreshOrder above. When the order cannot be looked up, the
  // cart is kept again rather than lost, and the floor says how to get it back.
  async function restoreLockedCart(kept) {
    const where = lockedCartWhere(kept)
    const units = Number(kept.unsentUnits) || 0
    // `unread`: the order could not be read. Otherwise something else on the way stopped the restore
    // (a refusal, or a booking's Seat prompt the host has not answered yet), so no connection is blamed.
    const keepAgain = (unread = true) => {
      lockedCartRef.current = null
      keepLockedCart(kept)
      const how = kept.reason === 'update' ? 'reload the page' : kept.reason === 'outlet' ? 'open Orders again' : 'lock the till and sign in again'
      setFloorMsg(unread
        ? `error:${units} item${units === 1 ? '' : 's'} not sent for ${where} before ${keptBefore(kept)} could not be put back — the order could not be read. They are still kept: ${how} once the connection is back.`
        : `error:${units} item${units === 1 ? '' : 's'} not sent for ${where} before ${keptBefore(kept)} ${units === 1 ? 'was' : 'were'} not put back yet. They are still kept: ${how} to bring them back.`)
    }
    lockedCartRef.current = kept
    try {
      if (kept.tableId) {
        const { data: table, error } = await bounded(scopedFrom('pos_tables', '*').eq('id', kept.tableId).maybeSingle(), 'Reading the table')
        if (error) { keepAgain(); return }
        // S817 4i (FLOOR-KITCHEN-7): a table taken out of service while its bill is still open takes the
        // lines back onto that bill; only one with no open bill (or gone from the floor plan) cannot.
        let retired = !table
        if (table?.status === 'inactive') {
          const { data: openBill, error: openErr } = await bounded(scopedFrom('pos_orders', 'id')
            .eq('status', 'open').eq('table_id', table.id).limit(1), 'Reading the table')
          if (openErr) { keepAgain(); return }
          retired = !openBill?.length
        }
        if (retired) {
          lockedCartRef.current = null
          const what = keptLinesText(kept)
          setFloorMsg(`error:${units} item${units === 1 ? '' : 's'} not sent for ${where} before ${keptBefore(kept)} could not be put back — that table is no longer in use. Ring ${units === 1 ? 'it' : 'them'} on another table or a takeaway${what ? `: ${what}` : ''}.`)
          return
        }
        await openTable(table)
      } else if (kept.orderId) {
        const { data: order, error } = await bounded(scopedFrom('pos_orders', 'id, status').eq('id', kept.orderId).maybeSingle(), 'Reading the takeaway')
        if (error) { keepAgain(); return }
        // S835: closed between this read and the next, it goes onto a new takeaway like one closed before.
        if (order?.status !== 'open' || (await openOrderById(kept.orderId)) === 'closed') { setFloorMsg(''); openTakeaway(); applyLockedCart([], null) }
      } else {
        openTakeaway()
        applyLockedCart([], null)
      }
    } finally {
      // A refusal inside openTable/openOrderById (a till notice, a table or takeaway this device never
      // loaded offline) never consumed it. It must not attach itself to whatever order is opened next,
      // and it is kept again rather than lost, with the floor saying so (S809 ORDER-FLOW-12: only a
      // failure of the first read used to keep it).
      if (lockedCartRef.current === kept) keepAgain(false)
      lockedCartRef.current = null
    }
  }

  // A takeaway has no table to look it up by, so it opens by order id (S754).
  async function openOrderById(oid) {
    setFloorMsg('')
    seatReservationRef.current = null
    if (tillOffline()) {
      const queued = liveQueue(await getPosOrderQueue()).find(q => q.order_id === oid)
      if (queued) { showLoadedOrder(null, queuedOnScreen(queued)); return }
      // Never loaded on this device: refuse rather than start an item replace that would delete
      // lines this till has never seen — the same rule as an occupied table offline.
      setFloorMsg('error:That takeaway order has not been loaded on this device yet — reconnect to open it.')
      return
    }
    const { data: existing, error } = await bounded(scopedFrom('pos_orders', OPEN_ORDER_SELECT)
      .eq('id', oid)
      .maybeSingle(), 'Opening the order', OPEN_READ_MS)
    // S809 3f (Q16): no answer at all is the internet, not the order — it opens as offline, from this till's
    // copy. Not for billing: a bill takes its number from the server. S841: a timed-out read is no answer.
    if (noReply(error)) {
      noteLinkDown()
      if (billOnOpenRef.current) { setFloorMsg(LINK_DOWN_BILL_TEXT); return }
      return openOrderById(oid)
    }
    if (error) {
      showTillNotice(`Couldn't load that takeaway order. ${errorText(error, 'staff')}\n\nTry again in a moment — don't ring it up as a new takeaway, or the kitchen will get it twice.`)
      return
    }
    // S809 3f: an order this till still holds in its queue opens from the queue, as offline: the server's
    // copy lacks what waits to upload, and a send or a bill from it would delete those dishes.
    const held = await heldEntry(oid)
    if (held && (existing ? existing.status === 'open' : held.created_offline)) {
      if (billOnOpenRef.current) { setFloorMsg(QUEUED_BILL_TEXT); return }
      showLoadedOrder(null, { ...queuedOnScreen(held), orderNo: existing?.order_no ?? null })
      return
    }
    if (!existing || existing.status !== 'open') {
      setFloorMsg('error:That takeaway order was already closed on another device.')
      loadFloor({ quiet: true })
      return 'closed'
    }
    // S836: a bill that is on a table of the floor (opened by id after a join or a put-back) opens on
    // it; the lines it shows come back for a caller that compares against them.
    return showLoadedOrder(tableOfStored(existing, null, { synthetic: false }), { id: existing.id, orderNo: existing.order_no, covers: existing.covers, items: existing.pos_order_items, itemsVersion: existing.items_version, stored: existing })
  }

  async function openTable(table, { existingOnly = false } = {}) {
    setFloorMsg('')
    // S818 RESERVATIONS-10 (D25): a seat handed over from Reservations. Every path below that does not
    // seat it drops it and says so. Left armed after a refusal, the next free table anyone tapped
    // silently became that booking; opened onto another party's bill, the host rang on their bill.
    const handoff = seatReservationRef.current
    const refuseSeat = why => {
      seatReservationRef.current = null
      setFloorMsg(`error:${seatRefusedText(table.name, handoff, why)}`)
    }

    // S836: a table joined to another table's bill has none of its own; it opens that bill. The server
    // refuses a new bill on it too (pos_table_joined).
    const joinedTo = tableJoins[table.id]
    if (joinedTo) {
      const mainId = mainTableOfJoin(joinedTo, tableOrders)
      const main = mainId ? tables.find(t => t.id === mainId) : null
      if (handoff?.id) { refuseSeat(`is joined to ${main?.name || 'another table'}'s bill`); return }
      if (main) return openTable(main, { existingOnly })
      if (!tillOffline()) { await openOrderById(joinedTo); return }
      setFloorMsg(`error:${table.name} is joined to another table's bill, which has not been loaded on this device — reconnect to open it.`)
      return
    }

    if (tillOffline()) {
      // The booking's link to its order is written on the server, so a seat needs a connection.
      if (handoff?.id) { refuseSeat('cannot take a booking while this till is offline'); return }
      // A table this device already touched offline is the source of truth — use the queue.
      const queue = liveQueue(await getPosOrderQueue())
      const queued = queue.find(q => q.table_id === table.id)
      if (queued) {
        showLoadedOrder(table, queuedOnScreen(queued)) // real order_no assigned on sync
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
      if (existingOnly) {
        setFloorMsg(`error:${table.name}'s bill has not been loaded on this device — reconnect to bill it.`)
        return
      }
      if (table.status === 'inactive') { setFloorMsg(`error:${inactiveTableText(table.name)}`); return } // S817 4i
      // S835: kept lines for this table go onto the new order, as online; the numpad used to open
      // over the floor's "not put back" line instead.
      if (keptCartFor(table, null)) { startFreshOrder(table); return }
      // No known order on this table — safe to start fresh, same as the online empty-table path.
      setPendingTable(table)
      setPendingCoversStr('')
      setCoversModal(true)
      loadMenu()
      return
    }

    const { data: existing, error: existingErr } = await bounded(scopedFrom('pos_orders', OPEN_ORDER_SELECT)
      .eq('status', 'open')
      .eq('table_id', table.id)
      .maybeSingle(), `Opening ${table.name}`, OPEN_READ_MS)

    // A dropped error here is the worst swallow in this file: `existing` comes back null, the
    // table reads as EMPTY, and staff start a SECOND order on a table whose items are already
    // with the kitchen — re-firing every KOT and opening a second bill on one guest. Refuse to
    // guess. A till notice rather than the floor's `floorMsg` banner because this cannot be
    // missable mid-service (S616; see the note at the imports). S809 3f (Q16): no answer at all is the internet, not the table — it opens
    // as offline, by the offline rules (this till's copy, and never a table it has not loaded). S841: so
    // is an answer that has not come within OPEN_READ_MS.
    if (noReply(existingErr)) {
      noteLinkDown()
      if (existingOnly) { setFloorMsg(LINK_DOWN_BILL_TEXT); return }
      return openTable(table)
    }
    if (existingErr) {
      showTillNotice(`Couldn't check whether ${table.name} already has an open order. ${errorText(existingErr, 'staff')}\n\nDon't start a new order on this table until it loads — you may be re-ringing one that is already with the kitchen. Try again in a moment.`)
      return
    }
    // S809 3f: the order this till still holds in its queue for this table opens from the queue, as offline:
    // the server's copy lacks what waits to upload, and a send or a bill from it would delete those dishes.
    // One created here may not be on the server yet; one that is not open there any more is a new party.
    const held = liveQueue(await getPosOrderQueue().catch(() => []))
      .find(q => q.table_id === table.id && (existing ? q.order_id === existing.id : q.created_offline))
    if (held) {
      if (existingOnly) { setFloorMsg(QUEUED_BILL_TEXT); return }
      if (handoff?.id) { refuseSeat('has an order on this till waiting to upload'); return }
      seatReservationRef.current = null
      showLoadedOrder(table, { ...queuedOnScreen(held), orderNo: existing?.order_no ?? null })
      return
    }

    if (existing) {
      // A booking handed off onto a table that already has an order must not attach to that
      // bill — it belongs to whoever is already sitting there. Nor is that bill opened (S818): the
      // Seat dialog showed the table free, so the host would ring the booked party onto it.
      if (handoff?.id) { refuseSeat('already has an open order'); loadFloor({ quiet: true }); return }
      seatReservationRef.current = null
      const items = showLoadedOrder(table, { id: existing.id, orderNo: existing.order_no, covers: existing.covers, items: existing.pos_order_items, itemsVersion: existing.items_version, stored: existing })
      cachePosOrderForTable(table.id, { orderId: existing.id, orderNo: existing.order_no || null, covers: existing.covers || 1, items, itemsVersion: Number.isInteger(existing.items_version) ? existing.items_version : null })
    } else if (existingOnly) {
      // Came from the Billing list, where this table was listed as having an open bill. It does
      // not any more — another till closed it. Never fall through to starting a fresh order: the
      // cashier asked to BILL, and the covers numpad would be a baffling answer.
      setFloorMsg('error:That bill was already closed on another device.')
      loadFloor({ quiet: true })
    } else {
      // S817 4i (FLOOR-KITCHEN-7, D19): a table out of service takes no new order, whether it was
      // tapped, opened from a guest-order banner or a booking. Its bill, while one is still open, opens
      // above as it always did; only a POS manager brings the table back.
      if (table.status === 'inactive') {
        if (handoff?.id) { refuseSeat('is out of service'); return }
        setFloorMsg(`error:${inactiveTableText(table.name)}`); return
      }
      // Lines a till lock kept for this login go straight onto a new order (S776), before a booking
      // prompt can ask about a party that is not the one these items were rung for.
      const keptHere = keptCartFor(table, null)
      // S835 (owner, 2026-10-14): a booking handed over from Reservations is seated, and the kept lines,
      // rung for another party, are named instead of going onto the booking's bill.
      if (keptHere && handoff?.id) {
        lockedCartRef.current = null
        seatReservation(table, handoff)
        const what = keptLinesText(keptHere)
        if (what) setMsg(`error:Not added to ${handoff.customer_name || 'this booking'}'s order: ${what}, not sent before ${keptBefore(keptHere)}. They were rung for another party at this table. If this party wants them, add them by hand.`)
        return
      }
      if (keptHere) { startFreshOrder(table); return }
      // An explicit handoff from the Reservations page seats straight away; a table whose
      // booking is due offers the party by name before falling back to the numpad.
      if (handoff?.id) { seatReservation(table, handoff); return }
      const due = dueReservationFor(table.id)
      if (due) { setSeatPrompt({ table, reservation: due }); loadMenu(); return }
      startFreshOrder(table)
    }
  }

  // Billing station: open a listed bill and go straight to the payment window. Everything about
  // WHICH order and what is on it comes from the paths the floor already uses (openTable /
  // openOrderById), including their refusals — this only arms the flag and lets them run.
  async function billOrder(row) {
    setFloorMsg('')
    if (tillOffline()) {
      setFloorMsg('error:Billing needs a connection — a bill takes its invoice number from the server. Orders can still be taken offline from the Orders screen.')
      return
    }
    if (row.offlinePending) {
      setFloorMsg('error:That order has not uploaded yet — it has no invoice number to bill against. It will sync on its own; try again in a moment.')
      return
    }
    // S809 2a (ORDER-FLOW-1): the bill prints from the till's settings, so no read, no bill.
    if (!billingSettingsLoaded) {
      setFloorMsg(`error:${tillSettingsBlockText(!!settingsFailure)}`)
      loadTillSettings()
      return
    }
    billOnOpenRef.current = true
    try {
      if (row.kind === 'table') {
        const table = tables.find(t => t.id === row.tableId)
        if (!table) {
          setFloorMsg('error:That table is no longer on the floor plan — open the order from the Orders screen instead.')
          return
        }
        await openTable(table, { existingOnly: true })
      } else {
        await openOrderById(row.orderId)
      }
    } finally {
      // showLoadedOrder disarms it the moment an order actually lands on screen; this covers every
      // path that refused instead, so a later tap on Orders never opens the till drawer by itself.
      billOnOpenRef.current = false
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
    setScreenOrder(null)
    setMsg(''); setView('order'); loadMenu()
  }

  /* ── order item helpers ── */


  function addItem(recipe) {
    // A dish with option groups (S758, revised S759 — owner decision): when its defaults already
    // satisfy every group's rule, one tap adds the default line and the cart's Choices button is
    // where it gets customized; the choice window opens only when a required group has no default.
    // S760: a build-your-own dish always opens the window — building it IS the order, so a one-tap
    // default bowl would be the wrong dish nine times in ten.
    const dishGroups = dishGroupsByRecipe[recipe.id]
    if (dishGroups) {
      const ids = defaultSelection(dishGroups)
      const buildYourOwn = (optionCatalog?.buildYourOwn || []).includes(recipe.id)
      if (!buildYourOwn && selectionProblems(dishGroups, ids).length === 0) { addCustomLine(recipe, ids); return }
      setOptionPicker({ recipe, dishGroups })
      return
    }
    const vat = vatReg ? vatOf(recipe) : 0
    setOrderItems(prev => {
      // A plain tap is the un-customized line of this recipe — it never merges into a customized one.
      const idx = prev.findIndex(i => lineKeyOf(i) === recipe.id)
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

  // A dish with its choices, from the choice window or a one-tap default. The same choices tapped
  // again add to the same line; different choices are a new line. `replaceKey` is the Change button
  // on an unsent line, by the key the line had when Change opened (S862 TILL-GUEST-3): that line is
  // replaced (or folded into an identical one already on the order, placeCustomLine).
  // `qty` is the choice window's stepper — how many to add, or the replaced line's new quantity.
  function addCustomLine(recipe, optionIds, replaceKey = null, qty = null) {
    const vat = vatReg ? vatOf(recipe) : 0
    const dishGroups = dishGroupsByRecipe[recipe.id] || []
    const attachByGroup = Object.fromEntries(dishGroups.map(d => [d.group.id, d.attachment]))
    const desc = describeSelection(optionIds, { ...optionMaps, attachByGroup })
    const selection_key = selectionKeyOf(optionIds)
    const base = parseFloat(recipe.selling_price) || 0
    const custom = selection_key ? {
      selection_key, option_ids: [...optionIds].map(String).sort(),
      base_unit_price: base, options_delta: desc.delta, option_summary: desc.summary, options: desc.options,
    } : {}
    // Remembered per recipe so the choice window can offer "Same as last" on the next tap.
    if (selection_key) lastPicksRef.current[recipe.id] = [...optionIds].map(String)
    const line = {
      recipe_id: recipe.id, name: recipe.name, category: recipe.category || 'Other',
      unit_price: base + desc.delta, vat_rate: vat, sent_to_kot: false, sent_qty: 0, ...custom,
    }
    // S862 TILL-GUEST-3: the line Change opened on, as the cart holds it now. One the kitchen or bar
    // has had since (sent units, or carried by the send in flight) is never edited in place: the new
    // choices go on as their own dish, with its note, and the waiter is told.
    let opts = { replaceKey, qty }
    let said = ''
    if (replaceKey != null) {
      const { kind, line: before } = customChangeOf(orderItems, replaceKey, lineKeyOf(line), sendingKeysRef.current)
      if (kind === 'gone') {
        setMsg('error:That dish changed on the order while you were choosing, so nothing was changed. Check the order, then tap Change again.')
        return
      }
      const station = botCategories.has(before.category || 'Other') ? 'bar' : 'kitchen'
      // The same choices on a dish already sent: adding would only add plates, so nothing changes.
      if (kind === 'unchanged') {
        setMsg(`error:${before.name} went to the ${station} while you were choosing, with the same choices, so nothing was changed. Use + or − on it to change how many.`)
        return
      }
      if (kind === 'own') {
        opts = { replaceKey: null, qty, note: before.notes || '' }
        said = `error:${before.name} went to the ${station} while you were choosing. The new one is added as its own dish; take the first off if it is not wanted.`
      }
    }
    // S862 TILL-GUEST-6: two notes on one line are both kept, and the waiter is told to check them.
    const { joined } = placeCustomLine(orderItems, line, opts)
    if (!said && joined) said = `ok:The two ${recipe.name}${desc.summary ? ` · ${desc.summary}` : ''} lines were joined; check the note.`
    setOrderItems(prev => placeCustomLine(prev, line, opts).items)
    setMsg(said)
    if (replaceKey == null) computeSuggestions(recipe)
  }

  /* ── combos (S839, docs/pos-combos.md) ── */

  // A combo tile: a set meal whose dishes need no choice goes on in one tap; anything else asks its picks.
  function tapCombo(combo) {
    if (comboAddsInOneTap(combo, comboDishNeedsChoice)) {
      addComboToCart(combo, defaultComboPicks(combo, rid => (dishGroupsByRecipe[rid] ? defaultSelection(dishGroupsByRecipe[rid]) : [])), 1)
      return
    }
    setComboPicker({ combo })
  }

  // One cart line per pick, a new combo_line_id, the same quantity on each — or more of an identical
  // combo not sent yet. The prices are the display twin until the save answers (withServerLineFields).
  function addComboToCart(combo, picks, qty) {
    const lines = buildComboLines({
      combo, picks, recipeOf: comboRecipeOf, vatReg, qty: Math.max(1, Number(qty) || 1),
      lineId: randomUUID().toLowerCase(), describe: describeDishChoices,
    })
    if (!lines) { setMsg(`error:${combo.name} could not be put together — a pick has no dish on the menu now. Ask a manager to check the combo.`); return }
    setOrderItems(prev => addComboLinesToCart(prev, lines))
    setMsg('')
  }

  // One quantity for every dish of a combo. Cutting below what the kitchen already has asks for the
  // reason first, exactly as a plain line does (setQty): the save records the pull.
  function setComboQty(lineId, qty) {
    const pulled = comboUnitsPulled(orderItems, lineId, qty)
    if (pulled > 0) {
      const name = orderItems.find(i => comboIdOf(i) === lineId)?.combo_name || 'This combo'
      setPullPrompt({ combo: { lineId, qty }, name, pulled })
      setPullReason('')
      return
    }
    applyComboQty(lineId, qty)
  }
  function applyComboQty(lineId, qty) {
    setOrderItems(prev => setComboQtyIn(prev, lineId, qty, pullIsSaved))
  }

  // Swap (or change the choices of) one dish of a combo on the cart: the picker for that pick alone.
  function openComboSwap(lineId, item) {
    const combo = combos.find(c => c.id === item.combo_id)
    if (!combo) { setMsg(`error:${item.combo_name || 'This combo'} is not on the till menu any more, so its dishes cannot be changed. Remove the combo, or keep it as it is.`); return }
    const groupId = item.combo_group_id || comboGroupOf(item)
    if (!combo.groups.some(g => String(g.id).toLowerCase() === String(groupId).toLowerCase())) {
      setMsg(`error:${item.combo_name || 'This combo'} no longer has that pick, so ${item.name} cannot be changed. Remove the combo to change it.`)
      return
    }
    // S862 COMBOS-1: the window prices the combo as it was sold, as the swap will (comboAsSold).
    setComboPicker({ combo: comboAsSold(combo, item), swap: { lineId, groupId }, initialPicks: picksOfCombo(orderItems, lineId) })
  }

  // The swap's answer: the new dish takes the old one's place in the same combo and pick. A dish the
  // kitchen already has is pulled with a reason (the save records it) and the new one goes on the next ticket.
  function confirmComboSwap(combo, swap, picks) {
    const pick = picks.find(p => String(p.group_id).toLowerCase() === String(swap.groupId).toLowerCase())
    const group = combo.groups.find(g => g.id === pick?.group_id)
    const item = group?.items.find(i => i.recipe_id === pick.recipe_id)
    const recipe = item && comboRecipeOf(item.recipe_id)
    const old = orderItems.find(i => comboIdOf(i) === swap.lineId && comboGroupOf(i) === String(swap.groupId).toLowerCase())
    if (!recipe || !old) return
    // S862 COMBOS-1 (owner CU2 a): priced from the replaced dish's own share, as the server prices it, so
    // the combo keeps the price it was ordered at and a Pay straight after is not stopped by menuDrift.
    const share = swapShareOf(old, combo, group.id, comboRecipeOf, vatReg)
    const newLine = comboDishLine({
      combo, group, item, recipe, vatReg, share, qty: old.qty, lineId: swap.lineId, optionIds: pick.option_ids, describe: describeDishChoices,
    })
    if (lineKeyOf(newLine) === lineKeyOf(old)) return
    // S862 TILL-GUEST-3: a dish the send in flight carries reaches the kitchen whatever happens, so
    // swapping it is a pull like any sent dish's, with its reason.
    const inFlight = sendingKeysRef.current?.has(lineKeyOf(old)) ? Number(old.qty) || 0 : 0
    const kitchenQty = Math.max(inFlight, Math.min(kitchenQtyOf(old), Number(old.qty) || 0))
    if (kitchenQty > 0) {
      setPullPrompt({ swap: { lineId: swap.lineId, groupId: swap.groupId, newLine }, name: old.name, pulled: kitchenQty })
      setPullReason('')
      return
    }
    setOrderItems(prev => swapComboDish(prev, swap.lineId, swap.groupId, newLine))
    setMsg('')
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

  // What a station needs to know about a line's choices (S758): the kitchen's own name when the
  // owner set one, and whether it takes something off. Prices never go to the kitchen.
  // A line's full selection key as the server stores it — its choices, then a combo dish's
  // '@<combo_line_id>/<pick>' tail (S839) — for a ticket item; '' for a plain line.
  const ticketKeyOf = item => item.selection_key
    || ((Array.isArray(item.option_ids) ? selectionKeyOf(item.option_ids) : '') + comboSuffixOf(item))

  const ticketOptions = item => (item.options || []).map(o => ({
    kitchen: o.kitchen_name || o.option_name, is_removal: !!o.is_removal, group_kind: o.group_kind || '',
  }))

  // Cutting a line below what the kitchen already has means food that exists is leaving the bill.
  // That is the classic till-shrinkage route (ring it, fire it, serve it, pull the line before
  // charging) and until S576 it took no permission, left no record and asked no question. The
  // record itself is written server-side inside save_pos_order_items — a browser check would be
  // advisory — so all this prompt owns is the reason, which the RPC has no way to invent.
  function setQty(idx, qty) {
    const item = orderItems[idx]
    // S833: never more than the line now holds. After a saved take-off (3 sent, 3 → 2) the line still
    // remembers 3 sent, so a second (2 → 1) asked about "2 × already sent" where the server records 1.
    const kitchenQty = Math.min(kitchenQtyOf(item), Number(item?.qty) || 0)
    if (kitchenQty > 0 && qty < kitchenQty) {
      setPullPrompt({ idx, qty, name: item.name, pulled: kitchenQty - Math.max(0, qty) })
      setPullReason('')
      return
    }
    applyQty(idx, qty)
  }

  // The cart's − and × (S842): ignored for CART_REMOVE_GUARD_MS after a line was removed, so a double
  // tap does not take the dish that slid up into its place. + is never held back.
  function pressLineLess(idx, qty) {
    if (Date.now() - cartRemovedAtRef.current < CART_REMOVE_GUARD_MS) return
    setQty(idx, qty)
  }

  // ORDER-FLOW-13 (S809 3e): the line as it stands is what the server holds — saved online, not waiting
  // in the offline queue — so a pull on it is already recorded there (sentQtyAfterQtyChange).
  const pullIsSaved = item => !pendingOrderIds.has(orderId)
    && savedItemsRef.current.get(lineKeyOf(item)) === `${item.qty}|${(item.notes || '').trim()}`

  function applyQty(idx, qty) {
    if (qty <= 0) {
      cartRemovedAtRef.current = Date.now()
      cartFocusAfterRef.current = idx
      setOrderItems(prev => prev.filter((_, i) => i !== idx))
    } else {
      setOrderItems(prev => prev.map((item, i) => i === idx
        ? {
            ...item,
            qty,
            sent_to_kot: item.qty === qty ? item.sent_to_kot : false,
            sent_qty: sentQtyAfterQtyChange(item, qty, pullIsSaved(item)),
          }
        : item))
    }
  }

  function updateItemNote(idx, notes) {
    setOrderItems(prev => prev.map((item, i) => {
      if (i !== idx) return item
      // S833 (owner decision, 2026-10-13): remember what the station was sent, so a note changed on a line
      // part of which it already has (2 sent, now 3) sends a change for those 2 beside the "+1"
      // (changedOnSentUnits). In memory only: the server keeps no sent note, so a reload forgets it.
      const atSend = kitchenQtyOf(item) > 0 ? (item.note_at_send ?? item.notes ?? '') : null
      return {
        ...item, notes,
        sent_to_kot: item.notes === notes ? item.sent_to_kot : false,
        sent_qty: (item.sent_to_kot && item.notes !== notes) ? item.qty : (item.sent_qty || 0),
        note_at_send: atSend,
        note_changed: atSend !== null && (notes || '').trim() !== (atSend || '').trim(),
      }
    }))
  }

  function addPresetToNote(idx, phrase) {
    const existing = (orderItems[idx].notes || '').split(',').map(s => s.trim()).filter(Boolean)
    if (existing.includes(phrase)) return
    updateItemNote(idx, [...existing, phrase].join(', '))
  }

  /* ── core save (shared by the send paths and the hold) ── */

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
  //
  // `queue` is a send's (S809 3f, owner decision Q16): a save the till gets no answer for at all, or one
  // made while the internet is known to be down, is kept in the offline queue and prints, exactly as an
  // offline send does — { ok: true, queued: true, keptOnTill } — and the upload saves it and logs its
  // tickets later. A bill close passes none: it needs the server.
  async function performSave({ sendKeys = null, queue = false } = {}) {
    let oid = orderId
    let oNo = orderNo
    const isNewOrder = !oid

    const snapshot = orderItems
    const isSent = sendKeys === 'all' ? () => true : sendKeys ? i => sendKeys.has(lineKeyOf(i)) : () => false
    const savedLines = snapshot.map(i => (isSent(i) ? { ...i, sent_to_kot: true, sent_qty: i.qty, note_at_send: null, note_changed: false } : i))
    const itemsPayload = savedLines.map(toItemPayload)
    // S840 (ORDER-FLOW-4's residual): this save's own id, sent as p_save_id. The order lists the saves that
    // landed by it (recent_saves), so a lost answer is settled by asking whether THIS save landed, never by
    // whether the order holds its dishes — another tablet on the same login can store exactly these. A save
    // kept in the queue keeps it, so an upload of a save that did land is answered as one, not saved twice.
    const saveId = randomUUID().toLowerCase()
    // ORDER-FLOW-5 (S809 3e): every wait below is bounded, and a save that answers after the waiter went
    // back to the floor finishes for its own order — its tickets print and log from this call's own
    // values — but leaves the screen now showing alone (watchScreen).
    const { here } = watchScreen()

    // S809 3f (ORDER-FLOW-6, -8): a send's save goes to the offline queue when the browser says offline or
    // the internet is known to be down. An order this till still holds in the queue is saved through it
    // too: saved online on top of the queued copy, the upload would be refused as changed on another
    // device and the tickets it printed never logged. A send joins the queued copy, which then uploads; a
    // bill close never queues — it waits for one upload first, and is refused while the order still waits.
    let viaQueue = queue && tillOffline()
    const held = !isNewOrder && await heldInQueue(oid)
    // A cart that is not this till's queued copy of a held order lacks what waits to upload: saved through
    // the queue, or over the copy once it uploads, those dishes would go (review of 3f). The open paths
    // load the queued copy (screenQueueRef), so this is the backstop, for sends and bills alike.
    if (held && screenQueueRef.current !== oid) {
      if (here()) setMsg('error:This order has dishes kept on this till that have not uploaded yet, and this screen does not show them — go back to the floor and open the order again.')
      return { ok: false, handled: true, error: null }
    }
    // This order's earlier offline copy is a notice on the floor (dishes printed here, on no bill). A save
    // that would go to the queue would replace that copy, so it waits until the notice is settled; an
    // online save leaves the copy alone (review of 3f, N1).
    const conflictOpen = !isNewOrder && conflictIdsRef.current.has(oid) && conflictRecoveryRef.current !== oid
    if (viaQueue && conflictOpen) {
      if (here()) setMsg(CONFLICT_HOLDS_TEXT)
      return { ok: false, handled: true, error: null }
    }
    if (!viaQueue && held) {
      if (queue) {
        viaQueue = true
      } else {
        await withTimeout(flushPosOrderQueue(), SEND_STEP_MS, 'Uploading the waiting orders').catch(() => {})
        if (await heldInQueue(oid)) {
          if (here()) setMsg('error:This order is still waiting to upload from this till, so it cannot be billed yet — a bill is closed on the server. It uploads by itself as soon as the internet lets it; try again then.')
          return { ok: false, handled: true, error: null }
        }
      }
    }
    if (viaQueue) {
      const kept = await queueOrderSave({
        oid: isNewOrder ? randomUUID() : oid, oNo, isNewOrder, itemsPayload, snapshot, version: itemsVersionRef.current, here, saveId,
      })
      if (navigator.onLine) void flushPosOrderQueue()
      return kept
    }

    // The version this save expects is read once, here: the ref belongs to whatever order is on screen
    // when an answer comes back.
    let expectedVersion = itemsVersionRef.current
    // S809 3f (Q16): a send that gets no answer at all is kept in the queue and prints. Its 3e marks go
    // once it is kept (S809.4): if the lost save did land, the poll would print the same dishes a second
    // time; the upload finds it landed instead (S840: by the same save id) and logs the tickets once. The
    // poll leaves the order alone meanwhile (savingRef). A bill close still hears "not known".
    const keepUnanswered = async (stage, error, queuedOid, created) => {
      // A conflict's order keeps 3e's unknown-send handling (its marks stay, the poll settles it), so the
      // conflict's copy is not replaced (N1 above).
      if (!queue || (!created && conflictOpen)) return { ok: false, unknown: true, stage, error }
      noteLinkDown()
      try {
        const kept = await queueOrderSave({
          oid: queuedOid, oNo: created ? null : oNo, isNewOrder: created, itemsPayload, snapshot,
          version: created ? null : expectedVersion, here, saveId,
        })
        // S840: only now. Dropped before the queue write, a local store that failed left `unknown` with no
        // mark, so nothing ever settled the send: if it landed, its ticket never printed.
        if (kept?.queued) putSendAttempts(queuedOid, [])
        return kept
      } catch (err) {
        // The marks stay: the poll and the next press settle the send from the order, as 3e does.
        console.error('A send with no answer could not be kept on this till either:', err)
        return { ok: false, unknown: true, stage, error }
      }
    }

    if (isNewOrder) {
      // S809 3f: the id is minted here, as offline, so a new order whose answer is lost is queued under
      // the same id and the upload finds it if it landed — never a second, empty order on the table.
      const newId = randomUUID()
      const insertRes = await bounded(scopedInsert('pos_orders', {
        id:         newId,
        table_id:   activeTable?.id   || null,
        table_name: activeTable?.name || 'Takeaway',
        status:     'open',
        covers,
        opened_by:  profile?.id || null,
      }, { single: true }), 'Opening the order', SEND_STEP_MS)
      const { data: newOrder, error } = insertRes
      // 23505 is pos_orders_one_open_per_table (S754): another device opened this table between the
      // tap that showed it free and this insert. Put this cart onto THAT order, unsent.
      if (error?.code === '23505' && activeTable?.id) {
        seatReservationRef.current = null
        if (here()) await adoptOpenOrderOnTable(activeTable, snapshot)
        return { ok: false, handled: true, error }
      }
      // No answer: the order row may exist, but no line was saved, so nothing went to a station.
      if (noAnswer(insertRes)) return keepUnanswered('order', error, newId, true)
      if (error || !newOrder) return { ok: false, handled: false, error }
      oid = newOrder.id
      oNo = newOrder.order_no || null
      expectedVersion = Number.isInteger(newOrder.items_version) ? newOrder.items_version : null
      coversSavedRef.current = { orderId: oid, covers }
      if (here()) {
        itemsVersionRef.current = expectedVersion
        setOrderId(oid)
        setOrderNo(oNo)
      }
      // Link a seated booking to the order it just became. The status guard means a booking
      // decided elsewhere in the meantime (cancelled, seated on another device) is left alone.
      const seatRes = seatReservationRef.current
      seatReservationRef.current = null
      if (seatRes?.id && seatRes.kind === 'waitlist') {
        // S854: a waitlist party the same way; a party taken off the list on another device meanwhile
        // (count 0) is left as it is there.
        const res = await waitlist.markSeated(seatRes.id, oid, { timeoutMs: SEND_READ_MS })
        if (res?.error) warnWrite(`${seatRes.customer_name} still shows on the waitlist though the order was saved. Take them off with ⋯ → Cancel entry on the Waitlist.`, res.error)
      } else if (seatRes?.id) {
        const { error: linkErr } = await bounded(scopedUpdate('pos_reservations', { ...stampFor('seated'), order_id: oid })
          .eq('id', seatRes.id).in('status', ['booked', 'confirmed', 'arrived']), 'Linking the booking', SEND_READ_MS)
        if (linkErr) warnWrite(`The booking for ${seatRes.customer_name} still shows as waiting in Reservations though its order was saved, and closing this bill will not complete it. In Reservations, use ⋯ → Mark done on it.`, linkErr)
        else loadFloorReservations()
      }
      if (activeTable?.id) {
        // A silent failure here is how a table gets seated twice: the order exists, but the
        // floor keeps showing the tile as free. The optimistic repaint is deliberately inside
        // the success branch — loadFloor() re-reads from the server moments later, so painting
        // it occupied on a failed write would only lie until the next refresh.
        // S817 4i (FLOOR-KITCHEN-7, D19): never over a table taken out of service — only a POS manager
        // brings one back, and the floor opens an inactive table's bill as it is. `.select` so the floor
        // repaints only a table this write actually seated.
        const { data: occRows, error: occErr } = await bounded(scopedUpdate('pos_tables', { status: 'occupied' })
          .eq('id', activeTable.id).neq('status', 'inactive').select('id'), 'Marking the table occupied', SEND_READ_MS)
        if (occErr) warnWrite(`${activeTable.name} still shows as free on the floor, though its order was saved — set its status by hand so it is not seated twice.`, occErr)
        else if (occRows?.length) setTables(prev => prev.map(t => t.id === activeTable.id ? { ...t, status: 'occupied' } : t))
      }
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
    //
    // S809 ORDER-FLOW-3, -4 (3e): the save is marked until its answer is known (sendAttempt.js). The
    // lines it marks sent are routed the way the KOT and BOT buttons route them, so a landed save found
    // later prints exactly the tickets its own answer would have.
    const sendLines = snapshot.filter(isSent)
    const toBar = i => botCategories.has(i.category || 'Other')
    const attempt = newSendAttempt({
      orderId: oid, orderNo: oNo, where: activeTable?.name || (screenOrder?.partOf ? partBillLabel(screenOrder.tableName, oNo) : oNo ? `Takeaway #${oNo}` : 'This takeaway'),
      tableName: screenTableName, covers, expectedVersion, payload: itemsPayload, snapshot,
      kot: sendLines.filter(i => !toBar(i)), bot: sendLines.filter(toBar),
      guestReqIds: Array.from(pendingAcceptedGuestReqIds), knownTicketIds: orderKotTickets.map(t => t.id),
      screenToken: screenTokenRef.current, saveId,
    })
    putSendAttempts(oid, [...sendAttemptsFor(oid), attempt])
    const saveArgs = { p_order_id: oid, p_rows: itemsPayload, p_removal_reason: kotPullReason || null, p_save_id: saveId }
    if (Number.isInteger(expectedVersion)) saveArgs.p_expected_version = expectedVersion
    // Cancelled when the till stops waiting, so nothing more of it is sent (the close write's rule).
    const saveAbort = new AbortController()
    const saveRes = await bounded(supabase.rpc('save_pos_order_items', saveArgs).abortSignal(saveAbort.signal), 'Saving the order', SEND_STEP_MS)
    let { data: saveData, error: rpcErr } = saveRes
    const unanswered = noAnswer(saveRes)
    if (unanswered) {
      saveAbort.abort()
      stopWaiting(attempt, Date.now())
      putSendAttempts(oid, sendAttemptsFor(oid))
    } else {
      putSendAttempts(oid, sendAttemptsFor(oid).filter(a => a !== attempt))
      noteLinkUp() // S809 3f: an answer, so the internet is there
    }
    // The order is read back after a send that got no answer, and after a stale refusal while this till
    // still holds an unanswered save of it — and only those marks can make what is stored this till's
    // own. A stale refusal with none is another device's change, even one that stored exactly these
    // lines: two tablets firing the same unsent dishes (ORDER-FLOW-4). It reloads, and nothing prints.
    let staleRead = null
    if (unanswered ? sendLines.length > 0 : (rpcErr?.hint === HINT.stale && sendAttemptsFor(oid).length > 0)) {
      staleRead = await bounded(scopedFrom('pos_orders', OPEN_ORDER_SELECT).eq('id', oid).maybeSingle(), 'Checking the order', SEND_READ_MS)
      const cur = staleRead.error ? null : staleRead.data
      const judged = staleRead.error ? null : await judgeOrderRead(oid, cur)
      const settled = judged && judged.verdict !== 'pending' && judged.verdict !== 'none'
      if (settled) putSendAttempts(oid, [])
      if (settled && judged.verdict === 'landed' && judged.exact && storedLinesMatchPayload(cur.pos_order_items, itemsPayload)) {
        // What is stored is exactly this save: it, or an identical earlier try, landed and the answer
        // was lost. A success — the caller prints, once. (Read rows carry their choices as an embed.)
        saveData = { items_version: cur.items_version, items: (cur.pos_order_items || []).map(cartLineFromStored) }
        rpcErr = null
      } else if (settled && judged.verdict === 'landed') {
        // An earlier save of this order landed: its tickets print now, and this press is not sent on
        // top of it. The screen shows what landed; the waiter presses again for anything still unsent.
        finishLandedSend(judged.attempt, cur, judged.exact, { fromPress: true })
        return { ok: false, handled: true, error: rpcErr }
      } else if (settled) {
        // Lost, fired from another till, or the bill closed: none of this till's tries landed, and
        // none can any more. The screen shows the order as it stands.
        if (here()) {
          if (judged.verdict === 'closed') showClosedElsewhere()
          else await reloadAfterStale(oid, snapshot, staleRead)
        }
        tellSendSettled(judged, { fromPress: here() })
        return { ok: false, handled: true, error: rpcErr }
      }
    }
    // No answer, and nothing yet says whether it landed: a send is kept in the queue and prints (S809 3f,
    // Q16); a bill close says "not known yet", the poll keeps reading the order, and the next press reads
    // it first.
    if (rpcErr && unanswered) return keepUnanswered('lines', rpcErr, oid, false)
    // Once the waiter has left the order, its refusal is said on the floor by the caller (watchScreen).
    if (rpcErr) return here() ? handleSaveRefusal(rpcErr, oid, snapshot, staleRead) : { ok: false, handled: false, error: rpcErr }
    // This save landed at the version it expected, so no earlier save of this order made here at that
    // version can land any more.
    if (expectedVersion !== null) putSendAttempts(oid, sendAttemptsFor(oid).filter(a => a.expectedVersion !== expectedVersion))
    const moved = !here()
    const savedVersion = Number.isInteger(saveData?.items_version) ? saveData.items_version : null
    if (!moved && savedVersion !== null) itemsVersionRef.current = savedVersion
    const serverItems = Array.isArray(saveData?.items) ? saveData.items : null
    // What the screen shows is what was stored: a new line's price and VAT are the menu's as of this
    // save. Only those four fields move — a line tapped in while the save was in flight keeps its qty.
    if (serverItems && !moved) setOrderItems(prev => withServerLineFields(prev, serverItems))
    // Consumed by that save; a later edit asks again rather than silently reusing this one.
    if (kotPullReason && !moved) setKotPullReason('')
    // What was just stored — the pre-await snapshot, so a line tapped in while this save was in
    // flight still counts as unsaved (S754).
    if (!moved) markCartSaved(snapshot)
    if (activeTable?.id) {
      cachePosOrderForTable(activeTable.id, {
        orderId: oid, orderNo: oNo, covers, itemsVersion: savedVersion,
        items: serverItems ? withServerLineFields(savedLines, serverItems) : savedLines,
      })
    }
    // ORDER-FLOW-14 (S809 3e): the cover count is written only when it changed on this screen, and only
    // after the version-checked line save landed. It used to go first on every save, outside that check,
    // so a tablet holding an old count put it back over another tablet's correction. Covers is the
    // Covers Report's whole input, so a write that fails still says so — unless the bill closed
    // meanwhile, which then carries its own count. Awaited: a bill close writes right after this.
    if (!isNewOrder && !(coversSavedRef.current.orderId === oid && coversSavedRef.current.covers === covers)) {
      const { error: covErr } = await bounded(scopedUpdate('pos_orders', { covers }).eq('id', oid), 'Saving the cover count', SEND_READ_MS)
      if (!covErr) coversSavedRef.current = { orderId: oid, covers }
      else if (covErr.hint !== HINT.notOpen && covErr.hint !== HINT.locked) warnWrite('The cover count for this order did not save — the Covers Report will be short for it.', covErr)
    }

    // Only now — the merged items are actually persisted — mark any Accepted-locally guest
    // requests as accepted in the DB too. Not attempted in the offline branch above — an offline
    // device has no way to reach this table anyway, and the ids stay pending until a later online save.
    // S767: `order_id` is the bill this guest order went onto — the guest's own tracker reads it
    // (get_guest_order_progress) so it can follow THIS order rather than the table's, and end when
    // this bill closes. GUEST-3 (S809 3b): the ids are the ones this save's cart carried (the closure's,
    // like `snapshot`), so a request accepted while the save was in flight waits for the next save.
    // markGuestAccepts writes only while a request still waits, and a failed write is retried from the
    // poll instead of putting the request back on the banner, where Accept would double its dishes.
    // Not awaited: the save has landed, and a bill close waits on this function with a time limit.
    if (pendingAcceptedGuestReqIds.size > 0) {
      const ids = Array.from(pendingAcceptedGuestReqIds)
      for (const id of ids) unmarkedGuestAcceptsRef.current.set(id, oid)
      forgetAcceptedGuestReqs(ids)
      void markGuestAccepts()
      loadPendingGuestOrders()
    }

    // S754: an order started from an offline-sync conflict has now genuinely saved, so the
    // conflict entry it came from can go. Online path only — a queued offline save has not reached
    // the server, so the conflict stays until one does.
    const recoveredConflict = conflictRecoveryRef.current
    if (recoveredConflict) { conflictRecoveryRef.current = null; discardConflictOrder(recoveredConflict) }

    loadFloor()
    return { ok: true, oid, oNo, items: serverItems, version: savedVersion }
  }

  // S809 3f: whether this order waits in this till's offline queue with lines still to upload. A conflict
  // is the floor's to settle, and an entry of tickets only holds no lines. A store that cannot be read
  // holds nothing — the save then goes online, as before the queue existed.
  async function heldEntry(oid) {
    if (!oid || conflictIdsRef.current.has(oid)) return null
    const q = await getQueuedPosOrder(oid).catch(() => null)
    return queuedHasLines(q) && ownQueuedEntry(q, clientId) ? q : null
  }
  async function heldInQueue(oid) { return !!(await heldEntry(oid)) }
  // A queued entry as the order screen opens it: its lines as cart lines (a customized dish keeps its
  // choices), the version its edits build on, and marked as the queue's (screenQueueRef).
  // An order created on this till is at version 0 until its upload saves it, so a save that races the
  // upload is still checked rather than sent with no version (review of 3f, N3).
  const queuedOnScreen = q => ({
    id: q.order_id, orderNo: null, covers: q.covers, items: (q.items || []).map(cartLineFromStored),
    itemsVersion: q.created_offline ? 0 : q.items_version, fromQueue: true,
  })

  // A save into the offline queue: offline, and since S809 3f (Q16) a send the till got no answer for, or
  // made while the internet is known to be down. The tickets print as for any send; the upload
  // (uploadPosOrderQueue) saves the lines and logs the tickets later. `version` is the one these edits
  // build on (enqueuePosOrder keeps the first one queued); `here` says whether the screen the save was
  // pressed on still shows it; `saveId` the id the upload sends it under (S840). Throws when the local
  // store does.
  async function queueOrderSave({ oid, oNo = null, isNewOrder, itemsPayload, snapshot, version, here, saveId = null }) {
    // A conflict's own order saved here again by its RECOVERY starts a fresh entry at the version this
    // screen holds. Merged into the conflict's copy it kept that copy's stale base and was skipped by every
    // upload (review of 3f). The conflict's printed tickets were logged when it was found. Any other save of
    // that order never replaces the conflict's copy: those printed dishes are on no bill until the floor
    // notice is settled (review of 3f, N1). performSave refuses first; this is the backstop.
    if (!isNewOrder && conflictIdsRef.current.has(oid)) {
      if (conflictRecoveryRef.current !== oid) {
        if (here()) setMsg(CONFLICT_HOLDS_TEXT)
        return { ok: false, handled: true, error: null }
      }
      await dequeuePosOrder(oid)
      conflictIdsRef.current.delete(oid)
      setConflictOrders(prev => prev.filter(c => c.order_id !== oid))
      if (conflictRecoveryRef.current === oid) conflictRecoveryRef.current = null
    }
    const queued = isNewOrder ? null : await getQueuedPosOrder(oid)
    const createdOffline = isNewOrder || queued?.created_offline || false
    // ORDER-FLOW-14 (3e) on the queue too: the upload writes the cover count only when it changed here,
    // so a tablet holding an old count does not put it back over another tablet's correction.
    const coversSet = isNewOrder || !!queued?.covers_set
      || !(coversSavedRef.current.orderId === oid && coversSavedRef.current.covers === covers)
    await enqueuePosOrder(oid, {
      created_offline: createdOffline,
      client_id:  clientId, // ORDER-FLOW-15: the outlet it was taken for
      table_id:   activeTable?.id   || null,
      table_name: screenTableName,
      covers,
      covers_set: coversSet,
      opened_by:  profile?.id || null,
      items: queuedRows(itemsPayload, snapshot), // a customized dish keeps its choices for the screen
      save_id: saveId || randomUUID().toLowerCase(), // S840: the upload's p_save_id for these lines
      // The reason the waiter gave for taking off a dish already sent, for the upload's pulled-item record.
      ...(kotPullReason ? { removal_reason: kotPullReason } : {}),
      ...(Number.isInteger(version) ? { items_version: version } : {}),
    })
    if (here()) {
      // oNo stays null for a new order — the real order_no is assigned by the server-side trigger on upload
      if (isNewOrder) setOrderId(oid)
      markCartSaved(snapshot)
      if (kotPullReason) setKotPullReason('')
      coversSavedRef.current = { orderId: oid, covers }
      screenQueueRef.current = oid
    }
    // A party seated offline keeps its booking at 'arrived' — the link needs the server row
    // and is never written from the queue; the Reservations page's Done action covers it.
    seatReservationRef.current = null
    setPendingOrderIds(prev => new Set([...prev, oid]))
    if (isNewOrder && activeTable?.id) {
      setTables(prev => prev.map(t => t.id === activeTable.id ? { ...t, status: 'occupied' } : t))
    }
    loadFloor() // offline or with the internet down this reads the cache and the queue, no network
    return { ok: true, oid, oNo: isNewOrder ? null : oNo, items: null, queued: true, keptOnTill: navigator.onLine }
  }

  // The order on screen, named the way the waiter knows it.
  function orderLabel() {
    if (activeTable?.name) return activeTable.name
    if (screenOrder?.partOf) return partBillLabel(screenOrder.tableName, orderNo) // S836
    return orderNo ? `Takeaway #${orderNo}` : 'This takeaway'
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
    if (err?.hint === HINT.optionOff || err?.hint === HINT.optionCount || err?.hint === HINT.optionsOff
        || err?.hint === HINT.optionBelowZero) {
      // Nothing was saved. The options on screen are what is out of date (an option hidden, a group
      // re-ruled, a price changed, the module switched off), so the menu and its options are re-read.
      // S809 3o (CUSTOMIZATION-2): the sentence names the dish the server named, and once the menu is
      // back the cart marks the line to fix, with a Change that works even when no choice is left.
      const lines = snapshot || orderItems
      // S862 TILL-GUEST-2 (owner CU5 a): a named dish already made (sent, not on the saved order) has
      // no Change, so the sentence gives its way out instead.
      const sentWayOut = dish => {
        const line = lines.find(i => i.name === dish && (i.sent_to_kot || (i.sent_qty || 0) > 0)
          && !savedItemsRef.current.has(lineKeyOf(i)))
        if (!line) return null
        const t = lineChoiceTrouble(line, dishGroupsByRecipe[line.recipe_id], optionMaps.optionsById, { sent: true, dish })
        const way = t ? t.text : sentDishWayOut(dish)
        return isComboLine(line) ? comboWayOut(way, line) : way
      }
      const text = choiceRefusalText(err, { sentWayOut }) || `Not saved — ${errorText(err, 'staff')}`
      // S862 TILL-GUEST-1: Customization switched on or off for the outlet (or lapsed) after this till
      // read its login. Options refused as off, or a count refused on an order where no dish has
      // choices on this till, is that: the login is read again, and the effect on the switch re-reads
      // the menu and says so. Never loadMenu straight after the read: this closure has the old switch.
      const maySwitch = err?.hint === HINT.optionsOff
        || (err?.hint === HINT.optionCount && !lines.some(i => dishGroupsByRecipe[i.recipe_id]))
      if (maySwitch && refreshProfile) {
        const shown = `error:${text}`
        setMsg(shown)
        const wasOn = customizationEnabled
        void withTimeout(Promise.resolve(refreshProfile()), SEND_READ_MS, 'Reading the login again').then(
          () => setCustomSwitchCheck({ shown, wasOn }),
          e => { console.error('login re-read after a choices refusal failed:', e); reloadMenuThenSay(shown, MENU_RELOADED_TEXT) },
        )
        return { ok: false, handled: true, error: err }
      }
      refuseAndReloadMenu(text)
      return { ok: false, handled: true, error: err }
    }
    if (err?.hint === HINT.comboDishOff || err?.hint === HINT.comboOff || err?.hint === HINT.comboIncomplete) {
      // S839: a combo or one of its dishes is off the menu since the till read it. Nothing was saved; the
      // menu and its combos are re-read, as for a dish off the menu. S862 COMBOS-4: a combo missing a
      // dish is most often one whose picks the owner changed since this till read the menu, so it is
      // re-read too, and a combo removed and added again then comes from the menu as it is now.
      refuseAndReloadMenu(`Not saved — ${errorText(err, 'staff')}`)
      return { ok: false, handled: true, error: err }
    }
    if (err?.hint === HINT.offMenu) {
      // The server's sentence names the dish ("Chicken Momo is not on the menu any more — remove it
      // from the order and save again"). Nothing was saved, and the menu on screen is what is out of
      // date, so it is re-read.
      const text = stripCodeWord(err.message, HINT.offMenu)
      refuseAndReloadMenu(`Not saved — ${text || 'a dish on this order is not on the till menu any more'}.`)
      return { ok: false, handled: true, error: err }
    }
    return { ok: false, handled: false, error: err }
  }

  // Another device saved this order after this screen loaded it. Reload the server's order — lines
  // and version — and never keep anything silently: whatever this device had that the reloaded order
  // does not carry is listed, with a one-tap "add them back as unsent". `duringClose` (S823 5c): the
  // change was found by the bill close, after this press's own save had landed, so the words are about
  // the payment ("nothing was charged"), never "nothing was saved".
  async function reloadAfterStale(oid, snapshot, alreadyRead = null, { duringClose = false } = {}) {
    const where = orderLabel()
    const { data: fresh, error } = alreadyRead || await bounded(scopedFrom('pos_orders', OPEN_ORDER_SELECT).eq('id', oid).maybeSingle(), 'Loading the latest order', SEND_READ_MS)
    if (error) {
      setMsg(duringClose
        ? `error:${where} was changed on another device while it was being charged, so nothing was charged, and the latest version could not be loaded. Go back to the floor and open it again.`
        : `error:${where} was changed on another device, and the latest version could not be loaded — nothing was saved. Go back to the floor and open it again.`)
      return
    }
    if (!fresh) {
      // S836: gone, not closed: a join took it into another table's bill, or a part bill went back.
      if (await openWhereBillWent(orderNo, where, snapshot)) return
      showClosedElsewhere(); return
    }
    if (fresh.status !== 'open') { showClosedElsewhere(); return }
    setKotPullReason('')
    // S836: another till may have moved the bill to another table; the screen follows it there.
    const freshTable = tableOfStored(fresh, activeTable)
    if (activeTable?.id && freshTable?.id !== activeTable.id) clearCachedPosOrderForTable(activeTable.id).catch(e => console.error('order snapshot clear failed (non-fatal):', e))
    const lines = showLoadedOrder(freshTable, {
      id: fresh.id, orderNo: fresh.order_no, covers: fresh.covers, items: fresh.pos_order_items, itemsVersion: fresh.items_version, stored: fresh,
    })
    if (freshTable?.id) {
      cachePosOrderForTable(freshTable.id, { orderId: fresh.id, orderNo: fresh.order_no || null, covers: fresh.covers || 1, items: lines, itemsVersion: itemsVersionRef.current })
    }
    const missing = missingFromServer(snapshot, fresh.pos_order_items)
    // ORDER-FLOW-18 (S809 3b): an accepted guest order whose dishes the reload left off is no longer
    // in this cart, so the next save must not mark it accepted. "Add them back" accepts it again with
    // its dishes; otherwise it goes back on the banner once the box is answered.
    const leftOff = guestReqsLeftOff(missing)
    if (leftOff.length > 0) {
      staleGuestReqIdsRef.current = new Set([...staleGuestReqIdsRef.current, ...leftOff.map(r => r.id)])
      forgetAcceptedGuestReqs(leftOff.map(r => r.id))
    }
    if (missing.length > 0) setStaleRecovery({ where, missing, guestReqs: leftOff })
    setMsg(duringClose
      ? `error:${where} was changed on another device while it was being charged, so nothing was charged — here is the latest.${missing.length > 0 ? ' Add your items again, then take the payment.' : ' Check the total, then take the payment again.'}`
      : `error:${where} was changed on another device — here is the latest.${missing.length > 0 ? ' Add your items again.' : ' Check it, then save again.'}`)
  }

  function addBackStaleItems() {
    const pending = staleRecovery
    // ORDER-FLOW-18 (S809 3b): the guest's dishes come back, so their order is accepted again.
    for (const r of pending?.guestReqs || []) {
      staleGuestReqIdsRef.current.delete(r.id)
      rememberAcceptedGuestReq(r)
    }
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
    setClosedElsewhereBy(null)
    backToFloor()
    loadFloor()
  }

  // The insert of a NEW order on a table was refused because another device has an open order on it
  // (23505, S754). Load that order and put this cart onto it as unsent lines — the same rule as the
  // offline-conflict recovery — so nothing typed here is lost and nothing is fired twice.
  async function adoptOpenOrderOnTable(table, snapshot) {
    const { data: existing, error } = await bounded(scopedFrom('pos_orders', OPEN_ORDER_SELECT)
      .eq('status', 'open').eq('table_id', table.id).maybeSingle(), 'Loading that order', SEND_READ_MS)
    if (error || !existing) {
      setMsg(`error:${table.name} was just opened on another device, so this order was not saved${error ? ' — and that order could not be loaded' : ''}. Go back to the floor and open the table again; your items are still here.`)
      return
    }
    const lines = showLoadedOrder(table, {
      id: existing.id, orderNo: existing.order_no, covers: existing.covers, items: existing.pos_order_items, itemsVersion: existing.items_version, stored: existing,
    })
    setOrderItems(mergeUnsentLines(lines, snapshot.map(i => ({ ...i, sent_to_kot: false, sent_qty: 0 }))))
    setMsg(`ok:${table.name} was opened on another device first — your items were added to that order, unsent. Review them, then Update Order.`)
  }

  // ── A save whose answer was lost (S809 ORDER-FLOW-3, -4, -5, slice 3e) ──

  // The order screen a send was pressed on (ORDER-FLOW-5). `here()` stays true until the waiter goes back
  // to the floor (backToFloor moves the token); `say` puts a sentence on that screen, or — once the
  // waiter has moved on — on the floor, with the order's name in front.
  function watchScreen() {
    const token = screenTokenRef.current
    const where = orderLabel()
    const here = () => screenTokenRef.current === token
    return { here, say: text => (here() ? setMsg(text) : setFloorMsg(text.replace(/^(ok|error):/, `$1:${where}: `))) }
  }

  // What the order as read says about this till's unanswered saves of it (judgeSendAttempts). Its tickets
  // are read too when a landed send could have been another till's. Null when a read failed.
  async function judgeOrderRead(oid, cur) {
    const attempts = sendAttemptsFor(oid)
    let tickets = []
    // S840: an order that lists its saves by id settles them without the tickets.
    if (cur?.status === 'open' && !judgesById(attempts, cur) && attempts.some(a => firesTickets(a) && a.expectedVersion !== cur.items_version)) {
      const { data, error } = await bounded(scopedFrom('pos_kot_log', 'id, items, sent_by')
        .eq('order_id', oid).neq('status', 'cancelled').not('items', 'cs', KOT_CHANGE_ITEMS), 'Checking the tickets', SEND_READ_MS)
      if (error) return null
      tickets = data || []
    }
    return judgeSendAttempts(attempts, cur, { tickets, profileId: profile?.id || null, now: Date.now() })
  }

  // A save of this order the till never heard back from turned out to have landed: what its answer would
  // have done, from its own record. Its tickets print and are logged under its own table and number,
  // whatever the screen shows now, so the kitchen gets the order it never heard of. The screen takes what
  // landed only if it is still the screen the save was pressed on, holding that order as it was then; a
  // screen opened since already shows the order as stored.
  function finishLandedSend(attempt, cur, exact, { fromPress = false } = {}) {
    const oNo = cur?.order_no ?? attempt.orderNo
    const onIt = screenOrderRef.current === attempt.orderId
    const asSent = attempt.screenToken === screenTokenRef.current && itemsVersionRef.current === attempt.expectedVersion
    // Another device saved on top of it since, or a press on a screen opened later was refused for it:
    // the order as it stands, with what this screen had and it lacks offered back.
    const reload = !(asSent && exact) && (asSent || (fromPress && onIt))
    if (asSent && exact) {
      itemsVersionRef.current = Number.isInteger(cur.items_version) ? cur.items_version : null
      setOrderItems(prev => withServerLineFields(prev, (cur.pos_order_items || []).map(cartLineFromStored)))
      markCartSaved(attempt.snapshot)
      markLinesSent(sendLinesOf(attempt))
    } else if (reload) {
      void reloadAfterStale(attempt.orderId, orderItems, { data: cur, error: null })
    }
    // Its accepted guest orders are on the bill (GUEST-3's mark). On a reload, ORDER-FLOW-18's own check
    // decides instead, from whether their dishes survived.
    if (attempt.guestReqIds.length > 0 && (exact || !asSent)) {
      for (const id of attempt.guestReqIds) unmarkedGuestAcceptsRef.current.set(id, attempt.orderId)
      if (asSent) forgetAcceptedGuestReqs(attempt.guestReqIds)
      void markGuestAccepts()
      loadPendingGuestOrders()
    }
    const ticket = { tableName: attempt.tableName, covers: attempt.covers }
    const kotPrinted = attempt.kot.length > 0 ? printTicket('KOT', attempt.kot, oNo, ticket) : true
    const botPrinted = attempt.bot.length > 0 ? printTicket('BOT', attempt.bot, oNo, ticket) : true
    logKotSend('KOT', attempt.kot, attempt.orderId, oNo, attempt.tableName)
    logKotSend('BOT', attempt.bot, attempt.orderId, oNo, attempt.tableName)
    loadFloor()
    const what = stationsOf(attempt)
    const both = attempt.kot.length > 0 && attempt.bot.length > 0
    const after = `${reload ? ' The order is shown as it stands now.' : ''}${fromPress ? ' Check the order, then press again for anything still unsent.' : ''}`
    const text = !what ? `ok:The earlier save did go through.${after}`
      : kotPrinted && botPrinted ? `ok:The earlier ${what} did go through — ${both ? 'their tickets have' : 'its ticket has'} printed now.${after}`
      : `error:The earlier ${what} did go through, but the ticket did NOT print — allow pop-ups for this site, then press Reprint KOT/BOT.${after}`
    if (onIt) setMsg(text)
    else setFloorMsg(text.replace(/^(ok|error):/, `$1:${attempt.where}: `))
  }

  // What the waiter hears when this till's unanswered saves of an order are settled without landing.
  // From a press, "lost" says nothing more: the press's own reload already shows the order as it stands.
  function tellSendSettled({ verdict, attempt }, { fromPress = false } = {}) {
    if (!attempt) return
    const what = stationsOf(attempt)
    const station = attempt.kot.length > 0 && attempt.bot.length > 0 ? 'kitchen or bar' : attempt.bot.length > 0 ? 'bar' : 'kitchen'
    const say = text => (screenOrderRef.current === attempt.orderId ? setMsg(text) : setFloorMsg(text.replace(/^(ok|error):/, `$1:${attempt.where}: `)))
    if (verdict === 'elsewhere') {
      say(`ok:These dishes were already sent from another till, so no second ${what} printed. If the ${station} has no ticket for them, press Reprint KOT/BOT.`)
    } else if (verdict === 'closed' && what) {
      warnWrite(`${attempt.where}'s bill was closed before this till heard whether its last ${what} went through — check with the ${station} that everything on that bill was made.`)
    } else if (verdict === 'lost' && !fromPress) {
      say(what
        ? `error:The ${what} did not go through — nothing reached the ${station}. Check the order and send what is missing.`
        : 'error:Your last changes did not save. Check the order, then press Update Order again.')
    }
  }

  // Reads an order this till holds unanswered saves of, and settles them: a save that landed finishes as
  // its answer would have; one that did not, and no longer can, is forgotten and the waiter told; one that
  // may still land is kept. One order at a time, and never while a send is in flight (that send reads the
  // order itself, with its own press in mind).
  async function settleSendAttempts(oid) {
    const attempts = sendAttemptsFor(oid)
    if (attempts.length === 0 || sendSettlingRef.current.has(oid) || savingRef.current || !navigator.onLine) return
    sendSettlingRef.current.add(oid)
    try {
      const { data: cur, error } = await bounded(scopedFrom('pos_orders', OPEN_ORDER_SELECT).eq('id', oid).maybeSingle(), 'Checking the order', SEND_READ_MS)
      if (error) return
      const judged = await judgeOrderRead(oid, cur)
      // A press may have settled them, or added one, while the reads were out.
      if (!judged || savingRef.current || sendAttemptsFor(oid) !== attempts) return
      if (judged.verdict === 'pending' || judged.verdict === 'none') return
      putSendAttempts(oid, [])
      if (judged.verdict === 'landed') finishLandedSend(judged.attempt, cur, judged.exact)
      else tellSendSettled(judged)
    } finally {
      sendSettlingRef.current.delete(oid)
    }
  }

  // Every 15 s while a save of this till has no answer, its order is read again, wherever the till is —
  // so a send that landed while the Wi-Fi was down still reaches the kitchen once it is back.
  async function pollUnsettledSends() {
    if (sendPollBusyRef.current || savingRef.current || !navigator.onLine) return
    sendPollBusyRef.current = true
    try {
      for (const oid of [...sendAttemptRef.current.keys()]) await settleSendAttempts(oid)
    } finally {
      sendPollBusyRef.current = false
    }
  }

  // S854 (owner decision): ONE Send. A new order sends every line on its first save (commitSaveOrder);
  // an order that already exists sends every line not yet sent, food to the kitchen and drinks to the
  // bar by Ticket Routing, in one save (saveAndSendUnsent); with nothing unsent it only saves. Keeping
  // a course back is "Save, do not send yet" in the menu beside Send (holdOrder), a choice the waiter
  // makes, never a question asked on every press: S754's Send / Just save ask and the separate KOT and
  // BOT buttons are gone. Held lines show on the floor as unsent, as they always did.
  function saveOrder() {
    if (!clientId) return
    if (orderItems.length === 0) { setMsg('error:Add at least one item.'); return }
    if (savingRef.current) return
    if (orderId && orderItems.some(i => !i.sent_to_kot)) return saveAndSendUnsent()
    return commitSaveOrder()
  }

  function holdOrder() { commitSaveOrder({ hold: true }) }

  // Send on an existing order: one save, then every unsent line to its station — KOT/BOT routing by
  // category, and the print gated on the sent flag landing, never the other way round (S654: a
  // printed ticket the server still counts as unsent is how a dish gets cooked twice). The flag rides
  // on the save itself (performSave's sendKeys, S754), one write for both stations — never two sends:
  // offline, a second enqueue built from the same cart snapshot would put the first station's lines
  // back to unsent in the queued payload.
  async function saveAndSendUnsent() {
    if (!clientId || orderItems.length === 0) return
    if (savingRef.current) return
    const unsentItems = orderItems.filter(i => !i.sent_to_kot)
    const kotItems = unsentItems.filter(i => !botCategories.has(i.category || 'Other'))
    const botItems = unsentItems.filter(i =>  botCategories.has(i.category || 'Other'))
    savingRef.current = true
    sendingCartRef.current = cartKeyMap(orderItems)
    const sendKeys = new Set(unsentItems.map(lineKeyOf))
    sendingKeysRef.current = sendKeys
    setSaving(true); setMsg('')
    const screen = watchScreen()
    try {
      const saved = await performSave({ sendKeys, queue: true })
      // No answer (S809 ORDER-FLOW-3, -5) is kept on this till and prints (3f, Q16); `unknown` is left only
      // when this till could not keep it either (its local store failed): not known whether it landed, so
      // nothing prints yet — the till finds out (the poll, or the next press reads the order first).
      if (saved.unknown) { screen.say(unknownSendText({ stage: saved.stage, what: 'the new items', press: 'Send' })); return }
      if (!saved.ok) {
        // A refusal is an answer: nothing landed, so nothing printed.
        if (!saved.handled) screen.say(`error:That did not go through — nothing printed. Press Send again. ${errorText(saved.error, 'staff')}`)
        return
      }
      const { oid, oNo } = saved

      if (screen.here()) markLinesSent(unsentItems)
      const kotPrinted = kotItems.length > 0 ? printTicket('KOT', kotItems, oNo, { local: saved.keptOnTill }) : true
      const botPrinted = botItems.length > 0 ? printTicket('BOT', botItems, oNo, { local: saved.keptOnTill }) : true
      logKotSend('KOT', kotItems, oid, oNo)
      logKotSend('BOT', botItems, oid, oNo)
      // The answer is returned too, for "Send and go back" (S854), which leaves only on an ok.
      const said = saved.keptOnTill ? queuedSendText({ printed: kotPrinted && botPrinted }) : kotPrinted && botPrinted
        ? 'ok:Order updated and sent!'
        : 'error:Sent to the kitchen/bar, but the ticket did NOT print — allow pop-ups for this site, then press Reprint KOT/BOT.'
      screen.say(said)
      return said
    } finally {
      // ORDER-FLOW-5: whatever happened, this till can send and take payment again.
      savingRef.current = false
      sendingCartRef.current = null
      sendingKeysRef.current = null
      setSaving(false)
    }
  }

  // `hold` (S854) saves without sending anything, a new order included: "Save, do not send yet".
  async function commitSaveOrder({ hold = false } = {}) {
    if (!clientId) return
    if (orderItems.length === 0) { setMsg('error:Add at least one item.'); return }
    if (savingRef.current) return
    savingRef.current = true
    sendingCartRef.current = cartKeyMap(orderItems)
    setSaving(true); setMsg('')
    const screen = watchScreen()

    const wasNew = !orderId
    const fires = wasNew && !hold
    sendingKeysRef.current = fires ? new Set(orderItems.map(lineKeyOf)) : null
    const press = hold ? 'Save, do not send yet (beside Send)' : wasNew ? 'Send Order' : 'Update Order'
    try {
      // A NEW order auto-sends every line on its first save, so its lines are marked sent in that same
      // save (sendKeys 'all'). sent_to_kot/sent_qty are what make "already sent" true for every other
      // device, and for this one after a reload; the print below runs only once the save returned ok,
      // so a ticket can never print for lines the server still counts as unsent (S654).
      const saved = await performSave(fires ? { sendKeys: 'all', queue: true } : { queue: true })
      // No answer (S809 ORDER-FLOW-3, -5) is kept on this till and prints (3f, Q16); `unknown` is left only
      // when this till could not keep it either. Once the new order itself exists, its button reads Send.
      if (saved.unknown) {
        screen.say(unknownSendText({ stage: saved.stage, what: wasNew ? 'the order' : 'your changes', press: fires && saved.stage === 'order' ? 'Send Order' : press, fires }))
        return
      }
      if (!saved.ok) {
        if (!saved.handled) screen.say(`error:That did not go through${fires ? ' — nothing printed' : ''}. Press ${press} again. ${errorText(saved.error, 'staff')}`)
        return
      }
      const { oid, oNo } = saved

      if (fires) {
        const kotItems = orderItems.filter(i => !botCategories.has(i.category || 'Other'))
        const botItems = orderItems.filter(i =>  botCategories.has(i.category || 'Other'))
        if (screen.here()) markLinesSent(orderItems)
        const kotPrinted = kotItems.length > 0 ? printTicket('KOT', kotItems, oNo, { local: saved.keptOnTill }) : true
        const botPrinted = botItems.length > 0 ? printTicket('BOT', botItems, oNo, { local: saved.keptOnTill }) : true
        logKotSend('KOT', kotItems, oid, oNo)
        logKotSend('BOT', botItems, oid, oNo)
        // A blocked pop-up used to be overwritten by "Order sent!" one line later (S754), so the
        // waiter walked away believing a ticket had printed. The send itself did land — the lines
        // are marked sent and the KDS has them — so the recovery is a reprint, never a re-send.
        const said = saved.keptOnTill ? queuedSendText({ printed: kotPrinted && botPrinted }) : kotPrinted && botPrinted
          ? 'ok:Order sent!'
          : 'error:Sent to the kitchen/bar, but the ticket did NOT print — allow pop-ups for this site, then press Reprint KOT/BOT.'
        screen.say(said)
        return said
      }
      const said = saved.keptOnTill ? queuedSendText({ fires: false })
        : hold ? 'ok:Saved. Nothing went to the kitchen or bar; press Send when it should.' : 'ok:Saved.'
      screen.say(said)
      return said
    } finally {
      // ORDER-FLOW-5: whatever happened, this till can send and take payment again.
      savingRef.current = false
      sendingCartRef.current = null
      sendingKeysRef.current = null
      setSaving(false)
    }
  }

  // Flips the sent flag on exactly the lines that went out, matched by line key AND the quantity and
  // note that were sent (S754). This used to be `setOrderItems(snapshot.map(...))` after the
  // awaits, so a dish tapped in while Send was in flight simply vanished from the cart. A line
  // that changed meanwhile stays unsent, carrying what the station already has as its baseline —
  // so its next ticket reads "+1" (or a change) rather than the whole quantity again.
  function markLinesSent(sentLines) {
    const sentByKey = new Map(sentLines.map(i => [lineKeyOf(i), i]))
    setOrderItems(prev => prev.map(i => {
      const s = sentByKey.get(lineKeyOf(i))
      if (!s) return i
      if (i.qty === s.qty && (i.notes || '') === (s.notes || '')) return { ...i, sent_to_kot: true, sent_qty: i.qty, note_at_send: null, note_changed: false }
      // The station now has what was sent, with the note it was sent with (S833).
      const changed = (i.notes || '').trim() !== (s.notes || '').trim()
      return { ...i, sent_to_kot: false, sent_qty: s.qty, note_at_send: changed ? (s.notes || '') : null, note_changed: changed }
    }))
  }

  // Best-effort, non-blocking (a ticket log never stops a send) — logs
  // exactly what was printed on the ticket (delta-aware qty) so the KOT Register/Reconciliation
  // reports reflect the real kitchen/bar send history, not just the current live order state.
  // `tableName` is given when the ticket is for an order the screen no longer shows (S809 3e).
  async function logKotSend(station, items, oid, oNo, tableName = screenTableName) {
    if (items.length === 0) return
    const payload = {
      order_id: oid,
      order_no: oNo,
      table_name: tableName,
      station,
      items: items.map(i => ({
        recipe_id: i.recipe_id, name: i.name, category: i.category,
        // A customized line (S758) carries its choices, so the Kitchen Display shows what to make.
        ...(ticketKeyOf(i) ? { selection_key: ticketKeyOf(i), options: ticketOptions(i) } : {}),
        // S839: a combo's dish names its combo ("↳ Momo Combo" on the ticket and the Kitchen Display);
        // its key above keeps the combo's '@' tail, which the Clear rule and the KDS pull match on.
        ...(isComboLine(i) ? { combo_name: i.combo_name ?? i.combo?.name ?? null } : {}),
        // The printed KOT always carried the note ("no onion — allergy"); the logged ticket did
        // not, so the Kitchen Display never showed it (S754). items is jsonb — no migration. The
        // offline queue stores this same payload, so a replayed send carries it too.
        notes: i.notes || null,
        // Clamped at 0: a reduced-then-resent item must not log a negative delta, which would
        // cancel its earlier sends in the cumulative sum and un-flag it in KOT Reconciliation.
        qty: (i.sent_qty || 0) > 0 ? Math.max(0, i.qty - i.sent_qty) : i.qty,
      })),
      sent_by: profile?.id || null,
    }
    // A pure reduction (every item clamped to 0 above) has no work left for this station to log
    // as a KDS ticket — the printed slip (built from the un-clamped `items` separately, with its
    // own "↓N (now qty)" label) is still the record of the cut; there's just nothing to add here.
    // ORDER-FLOW-9 (S809 3a): a line the paper prints as "CHANGE ONLY" (its instruction changed after
    // it was sent) is logged as its own CHANGE ticket beside the food, in the same insert, so the
    // Kitchen Display shows it ("Seen" clears it) and no ticket count includes it (kitchenNotes.js).
    const sends = [
      { ...payload, items: payload.items.filter(i => i.qty > 0) },
      // S833: so is a note changed on the units already sent of a line now growing (sendsChangeLine).
      { ...payload, items: payload.items.filter((_, n) => sendsChangeLine(items[n])).map(l => ({ ...l, qty: 0, change: true })) },
    ].filter(s => s.items.length > 0)
      // S809 3f (ORDER-FLOW-7, S809.4): each ticket carries the id it is logged under, minted here, so a
      // retry logs it once — a duplicate key then means the earlier try landed.
      .map(s => ({ ...s, id: randomUUID() }))
    if (sends.length === 0) return
    // Offline, with the internet known to be down, or for an order still waiting in the queue (S809 3f):
    // kept on this till and logged by the upload — with the order's lines when those still wait, else on
    // their own (enqueuePosTickets decides, in one transaction).
    const keepTickets = () => enqueuePosTickets(oid, { client_id: clientId, table_name: tableName, kot_sends: sends },
      { ontoOrder: !conflictIdsRef.current.has(oid) })
    if (tillOffline() || await heldInQueue(oid)) {
      try {
        await keepTickets()
        void refreshQueueCounts()
      } catch (err) {
        warnWrite(`The ${station} for ${tableName} printed, but this till could not keep it for the Kitchen Display and the KOT reports — make sure the ${station === 'BOT' ? 'bar' : 'kitchen'} has the paper ticket.`, err)
      }
      return
    }
    // Deliberately best-effort — a ticket-log problem must never block a waiter mid-service —
    // but written as a returned-error check rather than a try/catch, because supabase-js
    // RESOLVES with { error } instead of throwing. The catch this replaces could only ever
    // have fired on a bug in the argument-building above, so every real failure of the insert
    // reached neither the log nor anywhere else. Consequence when it does fail: KOT Register
    // and KOT Reconciliation are missing this send, and the KDS never shows the ticket.
    const res = await bounded(scopedInsert('pos_kot_log', sends), 'Logging the ticket', SEND_STEP_MS)
    if (!res.error || res.error.code === '23505') return
    // S809.4 (3e): no answer is not a lost ticket. It is kept on this till under the same ids, in the
    // order's ticket-only entry, and the upload tries it again; a duplicate key then means it had landed.
    const lapsed = Number(res.status) === 401 || /jwt/i.test(res.error.message || '') // a sign-in token mid-refresh
    if (noAnswer(res) || lapsed) {
      if (!lapsed) noteLinkDown()
      try {
        await keepTickets()
        void refreshQueueCounts()
      } catch (err) {
        console.error('pos_kot_log insert got no answer, and the ticket could not be kept on this till:', err)
      }
      return
    }
    // A refusal is the server's answer, and no retry changes it: the paper printed, so say so once.
    warnWrite(`The ${station} for ${tableName} printed, but it could not be added to the Kitchen Display or the KOT reports — make sure the ${station === 'BOT' ? 'bar' : 'kitchen'} has the paper ticket.`, res.error)
  }

  // True when the ticket went to the station's print device or printed here; false when this till's
  // pop-up was blocked and nothing printed (S754). Since S837 a station whose print device is online
  // gets the ticket there (useStationPrinting); `local` keeps it on this till, for a send kept on the
  // till. `tableName` and `covers` are given for an order the screen no longer shows (S809 3e).
  function printTicket(station, items, ticketNo, { reprint = false, tableName = screenTableName, covers: ticketCovers = covers, local = false } = {}) {
    const doc = kotBotDoc({
      station, items, ticketNo, outletName,
      tableName,
      takenBy: printedStaffName(profile, isAdmin),
      covers: ticketCovers, reprint,
    })
    const res = stationPrint.deliver({
      station, kind: reprint ? 'reprint' : 'ticket', doc, local,
      label: `${reprint ? 'Reprint · ' : ''}${tableName}${ticketNo ? ` · #${ticketNo}` : ''}`,
    })
    return res.via === 'device' || res.printed
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
    if (error) { setMsg(`error:Could not load this order's tickets to reprint. ${errorText(error, 'staff')}`); return }
    const latest = {}
    // A send that changed an instruction logged it as a CHANGE ticket in the same insert as its food,
    // so at the same sent_at (S809 3a): the paper carried both, and so does the reprint.
    for (const row of data || []) {
      if (!latest[row.station]) latest[row.station] = { ...row }
      else if (latest[row.station].sent_at === row.sent_at) latest[row.station].items = [...(latest[row.station].items || []), ...(row.items || [])]
    }
    const rows = ['KOT', 'BOT'].map(st => latest[st]).filter(Boolean)
    if (rows.length === 0) { setMsg('error:Nothing has been sent to the kitchen or bar for this order yet.'); return }
    let allPrinted = true
    for (const row of rows) {
      // Logged quantities are already the delta that was fired, so each prints as a plain ×qty.
      const lines = (row.items || []).map(i => ({ name: i.name, qty: i.qty, notes: i.notes || '', sent_qty: 0, options: i.options || null, change: i.change === true }))
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
    const cap = maxRedeemablePoints(spendablePoints(loyaltyBalance, loyaltyHeld), redeemableTotal, loyaltyPointValue)
    if (pts <= 0 || pts > cap) return
    setSplitMode(true)
    setTenders(prev => [...prev.filter(t => t.method !== 'Loyalty'),
      { method: 'Loyalty', amount: pointsValue(pts, loyaltyPointValue), points: pts }])
    setRedeemStr('')
  }

  /* ── Billing / Charge ── */

  // S836: the share slips' line beside the guest count ("3 × NPR 1,180" or "2 × NPR 1,181 · 1 × NPR 1,180").
  function shareSummary(shares) {
    const groups = []
    for (const v of shares) {
      const g = groups.find(x => x.v === v)
      if (g) g.n += 1; else groups.push({ v, n: 1 })
    }
    return groups.map(g => `${g.n} × ${fmtNpr(g.v)}`).join(' · ')
  }

  function printShareSlips() {
    const shares = equalShares(payTotal, shareCount)
    if (shares.length === 0) return
    const html = buildShareSlipsHtml({
      outletName, tableName: screenOrder?.partOf ? partBillLabel(screenTableName, null) : screenTableName,
      orderNo, total: payTotal, shares, printedAt: new Date().toISOString(),
    })
    if (!printHtml(html)) setCloseMsg('error:The share slips did not print — allow pop-ups for this site, then try again.')
  }

  async function openBilling() {
    setBillingTab('pay')
    setPayMethod('Cash')
    setShareCount(null) // S836
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
    setBillCustomer(null); setBillCustomerMsg(''); setMemberCardStr(''); setMemberDismissedFor(null)
    setCreditOwedBefore(null); setCreditOwedMsg('')
    setCloseMsg('')
    setCompCosting(null); setCompCostFailed(false)
    setCompQtyByLine({}); setItemCompReason(''); setItemsExpanded(false); setAdjustOpen(false)
    setHscMap({})
    setSplitMode(false); setTenders([]); setTenderMethod('Cash'); setTenderAmtStr('')
    setLoyaltyBalance(null); setLoyaltyHeld(0); setLoyaltyOnOtherBills([]); setLoyaltyScheme(null); setRedeemStr(''); setLoyaltyLookupMsg('')
    setBillPreviewOpen(false)
    setOrderDeposit(null); setDepositReadFailed(false)
    if (orderId) loadBillDeposit(orderId)
    // A try at this bill is still unsettled (S809 CHECKOUT-7): the window opens on what that try sent,
    // locked, rather than on a blank payment the cashier could change before it lands.
    const kept = closeAttemptFor(orderId)?.sent
    if (kept) restoreSentPayment(kept)
    const refused = refusedTendersRef.current
    refusedTendersRef.current = null
    if (!kept && orderId && refused?.orderId === orderId) {
      setSplitMode(true); setTenders(refused.tenders)
      setCloseMsg('warn:Payments kept from the refused try — check the new total.')
    }
    setBillingOpen(true)
    const recipeIds = orderItems.map(i => i.recipe_id).filter(Boolean)
    if (recipeIds.length > 0) {
      const { data, error: hscErr } = await scopedFrom('recipes', 'id, hsc_code').in('id', recipeIds)
      // Not a blocker on opening the till drawer, but HSC codes print on the Tax Invoice, and an
      // empty map is indistinguishable from "no item has one" — so the bill goes out short with
      // nothing saying so.
      if (hscErr) warnWrite('HSC codes could not be loaded, so the next bill will print without them.', hscErr)
      setHscMap(Object.fromEntries((data || []).map(r => [r.id, r.hsc_code])))
      // Food costs, needed up front for item-level comp in the Pay tab (not just the
      // Complimentary tab, which used to be the only consumer — see openCompTab). Through the till's
      // own read (S809 IMS-HANDOFF-3): a PIN login cannot read `items`, so its rates came back 0.
      await loadCompCosts()
    }
  }

  // S854: the booking deposit this bill may use. A failed read offers none and says so beside a Retry;
  // the deposit is then refunded from Reservations as any unused one is. A Deposit line already on the
  // bill (an earlier try, another till) is marked live, so Cancel or a charge without it hands it back.
  async function loadBillDeposit(oid) {
    depositReadForRef.current = oid
    setDepositReadFailed(false)
    const res = await loadOrderDeposit(oid, clientId)
    if (depositReadForRef.current !== oid) return
    if (res.error) {
      console.error('booking deposit read failed:', res.error)
      setDepositReadFailed(true)
      return
    }
    setOrderDeposit(res.data)
    if (res.data?.onThisBill) liveDepositRef.current = { orderId: oid }
  }

  // "Use" on the deposit line: a Split payment line for what the deposit can pay of what is still to
  // take. A tender like any other until Charge, when apply_booking_deposit writes it.
  function addDepositTender() {
    if (!orderDeposit || tenders.some(t => t.method === 'Deposit')) return
    const left = Math.max(0, payTotal - tenders.reduce((n, t) => n + t.amount, 0))
    const amount = Math.min(orderDeposit.balance, left)
    if (amount <= 0) return
    if (!splitMode) { setSplitMode(true); setPayMethod('Cash'); setTenderMethod('Cash'); setTenderAmtStr(''); setDeliveryPartner('') }
    setTenders(prev => [...prev, { method: 'Deposit', amount }])
  }

  // Takes a Deposit line off the bill it may stand on (apply_booking_deposit with 0). Returns
  // { ok, text } like cancelLiveRedemption; nothing standing is a no-op.
  async function handBackDeposit() {
    const live = liveDepositRef.current
    if (!live?.orderId) return { ok: true, text: '' }
    const res = await applyDeposit(live.orderId, 0)
    if (res.error) return { ok: false, text: res.noAnswer ? 'The till did not hear back.' : depositErrorInfo(res.error, 'staff').text }
    if (liveDepositRef.current === live) liveDepositRef.current = null
    return { ok: true, text: '' }
  }

  async function openCompTab() {
    setBillingTab('writeoff'); setCloseMsg('')
    await loadCompCosts()
  }

  // How the till costs a comp (posLineCosts): with its choices where the outlet has Crest IMS, and a
  // build-your-own dish by its build while Customization is on. The mark is read with the lines, not
  // taken from the menu's option catalog: a reprint from Recent Bills can run before any menu load.
  function compCostOpts(lines) {
    return {
      inventory: tillPostsToIms,
      buildYourOwn: tillPostsToIms && customizationEnabled ? buildYourOwnAmong(scopedFrom, lines.map(i => i.recipe_id)) : [],
    }
  }

  // S834 (S809.4, 2f): a failed food-cost read left every comp figure at NPR 0 with nothing saying so
  // (the read threw past both callers). Bounded; a failure shows "—" and a line where the figure goes,
  // never a made-up zero. The Complimentary Slip reads its own costs (slipCosts) and refuses to print.
  async function loadCompCosts() {
    try {
      const costing = await withTimeout(readCompCosting(orderId, orderItems), CLOSE_STEP_MS, 'Reading food costs')
      setCompCosting(costing)
      setCompCostFailed(false)
    } catch (e) {
      console.error('food cost read failed, so no comp figure is shown:', e)
      setCompCosting(null)
      setCompCostFailed(true)
    }
  }

  // The cart's lines costed from the bill as STORED: a dish's choices' stock lines are the server's
  // snapshot of the line, which a line added on this screen does not carry even once saved (the save
  // moves only its price fields back). A cart line is matched to its stored line by lineKeyOf, which is
  // unique on an open bill; a line not saved yet is costed from the cart, and unsaved() names it.
  async function readCompCosting(oid, cart) {
    const { data, error } = oid
      ? await scopedFrom('pos_order_items', `recipe_id, selection_key, ${LINE_CHOICE_STOCK}`).eq('order_id', oid)
      : { data: [], error: null }
    if (error) throw error
    const stored = new Map((data || []).map(r => [lineKeyOf(r), r]))
    const lines = [...stored.values(), ...cart.filter(i => !stored.has(lineKeyOf(i)))]
    const costing = await posLineCosts(supabase, clientId, lines, compCostOpts(lines))
    return {
      costOf: line => costing.costOf(stored.get(lineKeyOf(line)) || line),
      unsaved: line => tillPostsToIms && lineOptionIds(line).length > 0 && !stored.has(lineKeyOf(line)),
    }
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

  // Remove takes any one tender off (S854, owner decision; it was the last one only): tenders are screen
  // state until the close, each recorded against the balance left when it was added, so taking one out
  // only raises what is still to take, and the others keep their amounts and change. Closing the payment
  // window ("Discard N recorded payments?") drops them all. That is how a mis-keyed payment is fixed,
  // never by voiding and re-ringing the bill, which books a void and re-sends the food (S809 DOCS-2).
  //
  // Removing the Loyalty tender after a close attempt that got as far as redeeming (S754) hands the
  // points back first — redeem_loyalty_points(order, 0) — and keeps the tender on screen if that
  // fails, so the screen never shows "no points used" while the customer's balance is still debited.
  async function removeTender(index) {
    if (undoingTenderRef.current) return
    const target = tenders[index]
    if (!target) return
    if (target.method === 'Loyalty' && liveRedemptionRef.current?.orderId === orderId) {
      undoingTenderRef.current = true
      setCloseMsg('')
      const res = await cancelLiveRedemption()
      undoingTenderRef.current = false
      if (!res.ok) {
        setCloseMsg(`error:The points could not be handed back yet, so they stay on this bill — try Remove again. ${res.text}`)
        return
      }
    }
    if (target.method === 'Deposit' && liveDepositRef.current?.orderId === orderId) {
      undoingTenderRef.current = true
      setCloseMsg('')
      const res = await handBackDeposit()
      undoingTenderRef.current = false
      if (!res.ok) {
        setCloseMsg(`error:The deposit line could not be taken off this bill yet, so it stays — try Remove again. ${res.text}`)
        return
      }
    }
    // By identity, not position: the list cannot have moved under an await, but a second tap can.
    setTenders(t => t.filter(x => x !== target))
  }

  // Hands back a redemption that may be standing on `liveRedemptionRef`'s order: redeeming 0 cancels
  // the bill's redemption server-side (points returned, Loyalty leg removed), and is a no-op when
  // nothing was redeemed. Returns { ok, text } — text a sentence for the cashier when it failed.
  async function cancelLiveRedemption() {
    const live = liveRedemptionRef.current
    if (!live?.orderId) return { ok: true, text: '' }
    const { error } = await bounded(supabase.rpc('redeem_loyalty_points', { p_order_id: live.orderId, p_points: 0 }), 'Handing the points back')
    if (error) {
      console.error('loyalty redemption cancel failed:', error)
      // A bill that is already closed can never be un-redeemed from the till, so there is nothing
      // left to retry — the ref is dropped and the caller says who can fix the balance.
      if (error.hint === HINT.notOpen) {
        if (liveRedemptionRef.current === live) liveRedemptionRef.current = null
        return { ok: false, closed: true, text: 'The bill is already closed, so any points redeemed on it can no longer be handed back from the till — the Owner or a POS manager can check the customer’s points and correct them in Customers → Loyalty.' }
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
    // S854: a Deposit line an earlier try left on this bill is taken off the same way, so the deposit
    // can still be refunded if the bill is never charged with it.
    if (liveDepositRef.current?.orderId === orderId && !closeAttemptFor(orderId)) {
      const where = orderLabel()
      void handBackDeposit().then(res => {
        if (!res.ok) warnWrite(`The booking deposit tried on ${where} is still on that bill, so it cannot be refunded until the bill is charged or the deposit is removed in its payment window. ${res.text}`)
      }, e => console.error('deposit hand-back failed:', e))
    }
    // While a try at this bill is unsettled its points stay with it (S809 CHECKOUT-7): handed back now,
    // a late landing would close a bill paid partly in points nobody spent. The poll hands them back
    // if that try turns out not to have landed.
    if (liveRedemptionRef.current?.orderId !== orderId || closeAttemptFor(orderId)) return
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
  async function requestCloseBilling() {
    if (closing || closingRef.current) return
    // A Confirm on this bill went out and never heard back (S776). Leaving without checking could walk
    // away from a bill that DID close — unprinted, and a payment taken twice on the next attempt — so
    // the bill is read first. Closed by this login: it is finished and printed here. Unknown: the modal
    // still closes (a cashier must never be trapped on a dead connection), and the order screen keeps
    // the warning.
    if (closeAttemptFor(orderId)) {
      closingRef.current = true
      setClosing(true); setCloseMsg('')
      let settled
      try { settled = await settleUnknownClose() } finally { closingRef.current = false; setClosing(false); setCloseStep('') }
      if (settled === 'finished' || settled === 'elsewhere') return
      // Still not known (S809 CHECKOUT-7): the read failed, or the bill is open while the first try can
      // still land. Cancel used to forget the try here, so a late landing closed and numbered the bill
      // with nothing printed and nothing on screen. Now nothing is discarded or handed back — the try's
      // payments and points stay with it, a reopened window shows them again (locked), and the floor
      // marks the table until a read settles it either way.
      if (closeAttemptFor(orderId)) {
        setMsg(`error:Payment not yet known for ${orderLabel()} — the first try may still go through. Check Recent Bills before taking the payment again; the till keeps checking and finishes the bill if it did.`)
        setBillingOpen(false)
        return
      }
    }
    // No tenders on screen: close at once (handing back any redemption a failed attempt left standing).
    // A part bill (S836) then asks whether its dishes go back on the table's bill.
    if (tenders.length === 0) { dismissBillingAfterRefusal(); offerPutBackPart(); return }
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
          {tenders.some(t => t.method === 'Deposit') && ' The booking deposit stays with the booking, to use or refund later.'}
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
        if (liveDepositRef.current?.orderId === orderId) {
          const res = await handBackDeposit()
          if (!res.ok) {
            setCloseMsg(`error:The deposit line on this bill could not be taken off, so the payment screen stayed open — try Cancel again. ${res.text}`)
            return
          }
        }
        setBillingOpen(false)
        offerPutBackPart() // S836
      },
    })
  }

  // Whether the bill this till just closed is in Inventory (S830 5f-2). The database posts it inside the
  // close itself (pos_orders_post_to_inventory, 5f-1), from the stored bill, dated by the day it closed in
  // Nepal, sales and stock lines together, whoever closed it. The close's own answer is the row as the
  // close wrote it, before that post marked it, so the mark is read back. A bill the server could not
  // post (its month not open in Inventory, or a failed post) is left unmarked and counted on the floor
  // banner, which posts the open month's (Post to Inventory). A failed read counts as waiting: the
  // floor's next count is the truth either way.
  async function billReachedInventory(bill) {
    const { data, error } = await bounded(scopedFrom('pos_orders', 'ims_posted_at').eq('id', bill.id).maybeSingle(), 'Checking Inventory')
    if (error) {
      console.error('could not read back whether the closed bill reached Inventory:', error)
      return false
    }
    return !!data?.ims_posted_at
  }

  // What stops a close before anything is written — or null when nothing does (S776). One list, read by
  // closeOrder's own refusal AND by the close buttons, so a button can never look ready while the press
  // behind it refuses. `text` is the sentence closeOrder shows; `label` is what the button says instead
  // of "Confirm Payment" (null where the button's own label already names it — Short by, Remaining,
  // payments exceed); `field` is the control the cashier is taken to.
  function closeBlocker(closeType) {
    const block = (text, label, field = null) => ({ text, label, field })
    // S833 (owner decision, 2026-10-13): another login pressed a close on this bill on this tablet and its
    // answer was lost. Until a read settles it, nobody else charges, comps or voids it: it may yet close.
    const foreign = foreignCloseFor(orderId)
    if (foreign) return block(foreignCloseText(foreign), 'Wait — checking an earlier payment try')
    // S809 2a: no Charge or Complimentary before the till's settings have answered (ORDER-FLOW-1),
    // or on an emptied cart (CHECKOUT-1, owner Q8 a). Void is not held back by either.
    const start = closeStartRefusal({
      closeType, settingsLoaded: billingSettingsLoaded, settingsFailed: !!settingsFailure,
      itemCount: orderItems.length, canVoid: isAdmin || isOwner || !!profile?.pos_allow_void,
    })
    if (start) return block(start.text, start.label)
    if ((closeType === 'void' || closeType === 'writeoff') && !closeReason) {
      return block('Select a reason.', 'Choose a reason first', closeType === 'void' ? 'pos-orders-reason' : 'pos-orders-reason-2')
    }
    if (closeType !== 'paid') return null
    if (discountAmt > 0 && !discountReason) return block('Select a discount reason.', 'Choose a discount reason first', 'pos-orders-discount-reason')
    if (requireBuyerId && (!buyerName.trim() || !buyerPhone.trim())) {
      return block('Buyer Name + Phone are required for a discount or Credit sale.', "Enter the buyer's name and phone first",
        !buyerName.trim() ? 'pos-orders-buyer-name' : 'pos-orders-buyer-phone')
    }
    // S809 2a (CHECKOUT-5, owner Q9 a): above the IRD abbreviated-invoice limit a VAT bill names its buyer.
    const fullInvoice = fullInvoiceRefusal({ vatReg, payTotal, buyerName, buyerAddress })
    if (fullInvoice) return block(fullInvoice.text, fullInvoice.label, fullInvoice.field)
    if (splitMode && (remaining > 0 || tenders.length === 0)) return block('Split payment is not fully collected yet.', null, 'pos-orders-amount')
    if (tendersOverpaid) {
      return block(`The payments recorded (${fmtNpr(tendersTotal)}) are more than this bill now comes to (${fmtNpr(payTotal)}) — the total changed after they were taken. Remove the payments and take them again against the new total.`, null)
    }
    // redeem_loyalty_points debits the account on the phone stored on the ORDER (S754), so a
    // redemption with the phone since cleared would fail at the RPC with a message about the bill.
    if (tenders.some(t => t.method === 'Loyalty') && !buyerPhone.trim()) {
      return block("Enter the customer's phone — points are redeemed from the account on that number.", "Enter the customer's phone first", 'pos-orders-buyer-phone')
    }
    if (cashShortfall > 0) {
      return block(`Tendered ${fmtNpr(resolveTendered(payTotal))} is ${fmtNpr(cashShortfall)} short of the bill total ${fmtNpr(payTotal)} — collect the difference, or put the bill on Credit if the customer will pay later.`, null, 'pos-orders-tender')
    }
    if (hasItemComp && !itemCompReason) return block('Select a reason for the complimentary item(s).', 'Choose a reason for the comped items', 'pos-orders-comp-reason')
    if (orderItems.length > 0 && payableOrderItems.length === 0) {
      return block('Every item is comped — close it with Complimentary, under Other ways to close, instead of issuing a ₨0 bill.', 'Every item is comped — use Complimentary')
    }
    return null
  }

  // The close buttons stay pressable while something is missing (S776, the S759 aria-disabled pattern).
  // A `disabled` button explained nothing: "Confirm Payment — NPR 3,425" read as ready while the tap did
  // nothing, with a guest waiting. A press now runs closeOrder, whose refusal names what is missing in
  // the alert line above the button, and moves the cashier to the field — opening Items or Buyer
  // details first when that field is folded away inside them.
  function pressClose(closeType) {
    const blocker = closeBlocker(closeType)
    if (blocker?.field) {
      if (blocker.field === 'pos-orders-comp-reason') setItemsExpanded(true)
      // S846: every field Confirm can send the cashier to, except the tender itself, is in the fold.
      if (blocker.field === 'pos-orders-comp-reason' || blocker.field === 'pos-orders-discount-reason' ||
          blocker.field.startsWith('pos-orders-buyer-')) setAdjustOpen(true)
      setTimeout(() => {
        const el = document.getElementById(blocker.field)
        if (!el) return
        el.scrollIntoView?.({ block: 'nearest' })
        el.focus()
      }, 0)
    }
    if (closeType === 'void' && !blocker && !closeAttemptFor(orderId)) { confirmVoid(); return }
    closeOrder(closeType)
  }

  // A void is the one close with nothing to show for it afterwards — no bill, no number, no revenue —
  // and it sat one tap from Pay with no confirmation (S776). The ask names what is lost.
  function confirmVoid() {
    const where = orderLabel()
    const sent = orderItems.filter(i => i.sent_to_kot).length
    askConfirm({
      title: `Void ${where}?`,
      confirmLabel: 'Void order', danger: true,
      cancelLabel: 'Keep the order',
      // Above the billing modal (1100) inside the order screen's own stacking context.
      zIndex: 1200,
      body: (
        <p style={{ margin: 0 }}>
          The order is cancelled with no bill issued and no revenue recorded, for the reason “{closeReason}”. It cannot be reopened.
          {sent > 0 && ` ${sent === 1 ? 'One line was' : `${sent} lines were`} already sent to the kitchen or bar — if that food was made, Complimentary keeps its cost on the books; a void does not.`}
        </p>
      ),
      // Not awaited: the dialog closes at once, and the Void button carries the close's progress.
      run: () => { void closeOrder('void') },
    })
  }

  // Auto-build the customer book: any bill with buyer Name + Phone (required for discounts and Credit
  // sales) adds/updates a pos_customers row keyed by phone. Null when the bill names no customer.
  function buyerCustomerRow() {
    if (!buyerName.trim() || !buyerPhone.trim()) return null
    return {
      name: buyerName.trim(), phone: phoneForRecord(buyerPhone), updated_at: new Date().toISOString(),
      ...(buyerAddress.trim() ? { address: buyerAddress.trim() } : {}),
      ...(buyerPan.trim() ? { pan: buyerPan.trim() } : {}),
    }
  }

  // What a close try sends from the payment window (S809 CHECKOUT-7). Kept with its attempt, so a
  // reopened window shows that payment again (locked) and a settled close records that try's own
  // Split legs — never tenders changed after it went out.
  function sentPayment() {
    return {
      billingTab, payMethod, tenderedStr, splitMode, tenders, tenderMethod, deliveryPartner,
      discountMode, discountStr, discountReason, compQtyByLine, itemCompReason, closeReason,
      buyerName, buyerAddress, buyerPan, buyerPhone, billRemarks,
    }
  }
  function restoreSentPayment(s) {
    setBillingTab(s.billingTab); setPayMethod(s.payMethod); setTenderedStr(s.tenderedStr)
    setSplitMode(s.splitMode); setTenders(s.tenders); setTenderMethod(s.tenderMethod); setDeliveryPartner(s.deliveryPartner)
    setDiscountMode(s.discountMode); setDiscountStr(s.discountStr); setDiscountReason(s.discountReason)
    setCompQtyByLine(s.compQtyByLine); setItemCompReason(s.itemCompReason); setCloseReason(s.closeReason)
    setBuyerName(s.buyerName); setBuyerAddress(s.buyerAddress); setBuyerPan(s.buyerPan); setBuyerPhone(s.buyerPhone)
    setBillRemarks(s.billRemarks)
  }
  // The mark set before a close write (S776), with what it sends and where its bill sits on the floor.
  function newCloseAttempt(closeType) {
    return {
      orderId, closeType, tableId: activeTable?.id || null, where: orderLabel(), sent: sentPayment(),
      writesInFlight: 0, finalAfter: null,
    }
  }

  // Where a bill stands after a close write whose answer never arrived (S776). Read, never guessed.
  // 'mine' is THIS login's close of the kind that attempt asked for — closed_by is stamped by the server
  // from the session (S754), so no request can put another login's name there. `oid` is the bill on
  // screen unless the poll asks about one the till has moved away from (S809 CHECKOUT-7).
  async function readCloseOutcome(closeType, oid = orderId) {
    const { data, error } = await bounded(scopedFrom('pos_orders', '*').eq('id', oid).maybeSingle(), 'Checking the bill')
    if (error) return { state: 'unknown' }
    if (!data) return { state: 'elsewhere' }
    if (data.status === 'open') return { state: 'open' }
    if (data.closed_by && data.closed_by === profile?.id && data.close_type === closeType) return { state: 'mine', row: data }
    return { state: 'elsewhere' }
  }

  // Settles a close attempt on this bill that reached the close write and never heard back (S776).
  // Returns 'none' (no such attempt), 'open', 'unknown', 'elsewhere' or 'finished'.
  //
  // Before this, a lost answer went two wrong ways at once: "Processing…" could hang with Cancel
  // disabled, and a second press re-ran the save, which the server refused because the first write had
  // in fact closed the bill — so the cashier was told it was "billed or voided on another till", and the
  // bill that really was closed never printed. A bill this login closed is finished here instead:
  // Split legs, the print, and everything after, exactly as the lost answer would have run them.
  //
  // `justTried` is the read straight after the write gave up. Open then is not final — the write can
  // still land — so the mark stays and the next press (or Cancel) reads again before writing anything.
  // A later open read clears the mark only once nothing of that try can still land (S809 CHECKOUT-7,
  // openReadIsFinal); until then the press goes on as an ordinary close, with the same locked payment.
  async function settleUnknownClose({ justTried = false } = {}) {
    const pending = closeAttemptFor(orderId)
    if (!pending) return 'none'
    const where = orderLabel()
    setCloseStep('Checking whether the bill closed…')
    const readAt = Date.now()
    const outcome = await readCloseOutcome(pending.closeType)
    if (outcome.state === 'open') {
      if (justTried) {
        setCloseMsg(`error:${where} has not closed — the connection is too slow. Press again once the signal is back. If the first try lands in the meantime, the till picks it up and prints it; it is not charged twice.`)
      } else if (openReadIsFinal(pending, readAt)) setCloseAttempt(orderId, null)
      return 'open'
    }
    if (outcome.state === 'unknown') {
      setCloseMsg(`error:It is not known whether ${where} closed — the connection dropped before the till heard back. Do not take the payment again: press again once the signal is back, and the till checks first.`)
      return 'unknown'
    }
    setCloseAttempt(orderId, null)
    if (outcome.state === 'elsewhere') { showClosedElsewhere(); return 'elsewhere' }
    await finishSettledClose(pending, outcome.row)
    return 'finished'
  }

  // A close this login sent, found closed by a read after its answer was lost (S776), finished from the
  // bill as STORED (S809 CHECKOUT-7) — its lines, its legs and its payment. It used to finish from the
  // screen: a cashier who switched Cash to Card and comped a dessert before pressing again got a bill
  // stored as Cash NPR 3,400 with no comp, printed without the dessert at NPR 3,150, and Inventory
  // posting the dessert as a comp. On screen it prints and returns to the floor like any close, and
  // says so when the stored payment is not the one on screen; in the background (the till has moved
  // on) it runs only what is safe unprompted — see finishClosedBill.
  async function finishSettledClose(pending, row, { background = false } = {}) {
    const stored = await readStoredBill(row)
    const note = [
      background || pending.closeType !== 'paid' ? null : paymentDifferenceNote(pending.where, row,
        { method: splitMode && tenders.length > 0 ? 'Split' : payMethod, amount: payTotal }),
      storedLinesMatchPaid(row, stored.items, vatReg) ? null
        : `${pending.where}'s stored items do not add up to the ${describeStoredPayment(row)} it was paid — the order was saved again while the first try was still on its way. Tell a manager: the bill may need a credit note.`,
    ].filter(Boolean).join(' ') || null
    const { compNo, rows: compedItemRows } = pending.closeType === 'paid' && stored.items ? latestCompRows(stored.items) : { compNo: null, rows: [] }
    return finishClosedBill(pending.closeType, row, {
      compNo, compedItemRows, custRow: customerRowFromBill(row, new Date().toISOString()),
      stored, attempt: pending, background, note,
    })
  }

  // The closed bill's lines (and, on a Split bill, its legs) as the server holds them. `items` or `legs`
  // is null when its read failed — never the cart in its place.
  async function readStoredBill(row) {
    const [itemsRes, legsRes] = await Promise.all([
      // With each line's choices' stock lines, which a Complimentary Slip is costed from, and their
      // names and prices, which the bill prints (S862 TILL-GUEST-5).
      bounded(scopedFrom('pos_order_items', `*, ${LINE_CHOICE_BILL}`).eq('order_id', row.id), 'Reading the bill'),
      row.payment_method === 'Split'
        ? bounded(scopedFrom('pos_order_payments', 'payment_method, amount').eq('order_id', row.id), 'Reading the payments')
        : Promise.resolve({ data: [], error: null }),
    ])
    if (itemsRes.error) console.error('closed bill lines could not be read back:', itemsRes.error)
    if (legsRes.error) console.error('closed bill payments could not be read back:', legsRes.error)
    const items = itemsRes.error ? null : (itemsRes.data || [])
    return { items, legs: legsRes.error ? null : (legsRes.data || []), discRatio: storedDiscountRatio(items, row.discount_amount) }
  }

  // Every 15 s while a close is unsettled (S809 CHECKOUT-7), each one is read again — the bill on screen
  // and any the till has moved away from. Closed by this login: finished (on screen as a press would;
  // otherwise in the background). Closed some other way: forgotten. Open: forgotten only once nothing of
  // that try can still land. Never while a close is running on this till; one pass at a time.
  async function pollUnsettledCloses() {
    if (closePollBusyRef.current || closingRef.current || !navigator.onLine) return
    closePollBusyRef.current = true
    try {
      for (const attempt of [...closeAttemptRef.current.values()]) {
        if (closingRef.current) return
        const onScreen = view === 'order' && attempt.orderId === orderId
        const readAt = Date.now()
        const outcome = await readCloseOutcome(attempt.closeType, attempt.orderId)
        // A press may have started, or settled this attempt, while the read was out.
        if (closingRef.current || closeAttemptRef.current.get(attempt.orderId) !== attempt) continue
        if (outcome.state === 'unknown') continue
        if (outcome.state === 'open') {
          if (!openReadIsFinal(attempt, readAt)) continue
          setCloseAttempt(attempt.orderId, null)
          if (onScreen && billingOpen) setCloseMsg('ok:The first try did not go through — nothing was charged. Take the payment again; the payment can be changed now.')
          else if (onScreen) setMsg(`ok:The first payment try for ${attempt.where} did not go through — nothing was charged. Take the payment again.`)
          // Cancel kept a redemption that try made (requestCloseBilling); with the bill still open and no
          // window on it, it goes back to the customer the way Cancel would have handed it back.
          if (!(onScreen && billingOpen) && liveRedemptionRef.current?.orderId === attempt.orderId) {
            void cancelLiveRedemption().then(res => {
              if (!res.ok) warnWrite(`Loyalty points redeemed on a payment try for ${attempt.where} are still held against that bill — they are handed back when it is next charged without them. ${res.text}`)
            })
          }
          continue
        }
        setCloseAttempt(attempt.orderId, null)
        if (outcome.state === 'elsewhere') { if (onScreen) showClosedElsewhere(); continue }
        if (!onScreen) { await finishSettledClose(attempt, outcome.row, { background: true }); continue }
        closingRef.current = true
        setClosing(true)
        try { await finishSettledClose(attempt, outcome.row) } finally { closingRef.current = false; setClosing(false); setCloseStep('') }
        return
      }
      // S833: another login's kept try is only read. Still open once nothing of it can land: it never
      // closed, so it is forgotten for everyone. Closed: no longer this login's lock, but kept on the tablet
      // for the login that pressed, whose till still owes the bill its Split legs and points.
      for (const mark of [...foreignCloseRef.current.values()]) {
        if (closingRef.current) return
        const readAt = Date.now()
        const outcome = await readCloseOutcome(mark.closeType, mark.orderId)
        if (foreignCloseRef.current.get(mark.orderId) !== mark || outcome.state === 'unknown') continue
        const onScreen = view === 'order' && mark.orderId === orderId
        if (outcome.state === 'open') {
          if (!openReadIsFinal(mark, readAt)) continue
          dropForeignClose(mark, { forEveryone: true })
          const text = `ok:${mark.by}'s earlier try on ${mark.where} did not go through — nothing was charged. It can be taken now.`
          if (onScreen && billingOpen) setCloseMsg(text)
          else if (onScreen) setMsg(text)
          continue
        }
        dropForeignClose(mark)
        if (onScreen) { showClosedElsewhere(); setClosedElsewhereBy(mark.by) }
      }
    } finally {
      closePollBusyRef.current = false
    }
  }

  // A step before the close write refused because the bill is no longer open, after an earlier press
  // that never heard back (S809 CHECKOUT-7): that press may be what closed it, so the bill is read before
  // anything says "not charged". Returns 'finished' or 'elsewhere' when that settles the press, 'unknown'
  // when the read failed (its own message stands: do not take the payment again), and null when the
  // step's own refusal stands.
  async function settleIfEarlierClosed(earlier, err) {
    if (!earlier || ![HINT.notOpen, HINT.locked].includes(err?.hint)) return null
    setCloseAttempt(orderId, earlier)
    const settled = await settleUnknownClose()
    return ['finished', 'elsewhere', 'unknown'].includes(settled) ? settled : null
  }

  async function closeOrder(closeType) {
    if (!orderId || !clientId) return false
    // An earlier press on this bill reached the close write and never heard back (S776). Nothing is
    // refused before that is settled — this press may be what finishes a bill that already closed.
    const earlier = closeAttemptFor(orderId)
    if (!earlier) {
      const blocker = closeBlocker(closeType)
      if (blocker) {
        setCloseMsg(`error:${blocker.text}`)
        if (foreignCloseFor(orderId)) void closePollRef.current?.() // S833: check it now, not at the next tick
        return false
      }
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
      if (earlier) {
        const settled = await settleUnknownClose()
        if (settled !== 'open') return settled === 'finished'
        // Still open on a later press: that write never landed, so this is an ordinary close again.
        const blocker = closeBlocker(closeType)
        if (blocker) { setCloseMsg(`error:${blocker.text}`); return false }
      }

      // S754 (owner decision): a bill that takes money — Charge (Cash, QR, Split AND Credit, which
      // are all close type 'paid') or Complimentary — needs an open shift, so every bill lands on a
      // drawer count and a Z-report. Void takes no money and is not gated. A FRESH read, not the
      // cached openShiftId: that cache is refreshed only after a close and deliberately survives a
      // failed read, so it can say "open" about a shift another device closed minutes ago. A failed
      // read refuses (fails closed). Runs before performSave, so a refusal here has written nothing.
      // A Void reads nothing (S823 5c): guard_pos_order_close files it on the shift open at that
      // instant, or on none, and never refuses it for want of one. The till's own read (S809
      // SHIFTS-6) kept a cached id when it failed, which could name a shift already closed.
      let billShiftId = openShiftId
      if (closeType === 'paid' || closeType === 'writeoff') {
        setCloseStep('Checking the shift…')
        const { data: shiftRow, error: shiftErr } = await bounded(
          scopedFrom('pos_shifts', 'id').eq('status', 'open').maybeSingle(), 'Checking the shift')
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
      //   2. The printed bill is built from the in-memory cart, and until S809 4e so was the post to
      //      IMS. An unsaved line was reaching IMS revenue and the paper while never existing in
      //      pos_order_items — the bill and its own lines disagreeing, quietly, with nothing on either
      //      side saying so. (Since S830 5f-1 the database posts the stored bill in the close itself.)
      //
      // Runs before apply_pos_item_comps, not after: save_pos_order_items replaces the lines
      // wholesale, so persisting afterwards would erase the comp rows it had just written.
      //
      // Every close type, not just 'paid' (S754): a Complimentary slip and a void read their lines
      // back from the same stored rows (Recent Bills reprints, KOT Reconciliation, the credit-note
      // and exception reports), and the comp slip prints from this in-memory cart — so an unsaved
      // line on a comp slip reached the paper (and, until S809 4e, IMS) while never existing on the
      // order. performSave only persists lines, covers and guest-request accepts;
      // it never fires a ticket (that is the send paths'), so it is safe for all three.
      //
      // Bounded like every step here (S776). A save that timed out may still land, and a retry is safe:
      // performSave reads a stale refusal back and counts its own landed lines as saved.
      //
      // S823 5c: the close carries the items_version of the lines this total is worked out from, the one
      // this save stored (or, with nothing to save, the one on screen). guard_pos_order_close refuses
      // a Charge or Complimentary whose stored version has moved since (pos_bill_lines_changed): another
      // till's save, or a later press of this one, landed in between. No version known sends none.
      let pricedVersion = Number.isInteger(itemsVersionRef.current) ? itemsVersionRef.current : null
      if (orderItems.length > 0) {
        setCloseStep('Saving the order…')
        const persisted = await withTimeout(performSave(), CLOSE_STEP_MS + 10000, 'Saving the order')
          .catch(error => ({ ok: false, handled: false, error }))
        if (!persisted.ok) {
          // The earlier press's close landed between the read above and this save (S776): "already
          // closed" is this till's own bill, so it is read once more before another till is blamed.
          if (earlier && persisted.handled && [HINT.notOpen, HINT.locked].includes(persisted.error?.hint)) {
            setCloseAttempt(orderId, earlier)
            if (await settleUnknownClose() === 'finished') { setClosedElsewhere(null); return true }
          }
          // A stale order, a bill closed elsewhere, a dish off the menu: the order screen already says
          // which, so the payment modal gets out of its way (and hands back any standing redemption).
          if (persisted.handled) {
            const keep = tenders.filter(t => t.method !== 'Loyalty')
            refusedTendersRef.current = keep.length > 0 ? { orderId, tenders: keep } : null
            dismissBillingAfterRefusal()
            return false
          }
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
        pricedVersion = Number.isInteger(persisted.version) ? persisted.version : null
      }

      const isSplit = closeType === 'paid' && splitMode && tenders.length > 0
      // S809 2b (CHECKOUT-4): the database now sets the invoice year and the comp year itself, from
      // Nepal's date, and ignores what is sent. Sent from Nepal's date too (not the tablet's clock and
      // time zone) so nothing on this screen disagrees with it; the print reads the stored year back.
      // Outside the BS table nepalBs is null, and the database refuses the close there anyway.
      const today = nepalBs(new Date()) || getBsToday()

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
        setCloseStep('Applying the complimentary items…')
        const compFy = getBsFiscalYear(today.year, today.month)
        // A plain line is comped by recipe, exactly as before; a customized one (S758) by recipe AND
        // selection, so comping "Momo, extra cheese" never comps the plain Momo beside it.
        // p_full_lines is only sent when there is one, so a plain comp keeps the 7-key call shape.
        const fullCompRecipeIds = []
        const fullCompLines = []
        const partialComps = []
        for (const i of orderItems) {
          const compQty = Math.min(compQtyByLine[lineKeyOf(i)] || 0, i.qty)
          if (compQty <= 0) continue
          if (compQty === i.qty) {
            if (i.selection_key) fullCompLines.push({ recipe_id: i.recipe_id, selection_key: i.selection_key })
            else fullCompRecipeIds.push(i.recipe_id)
          } else partialComps.push({
            recipe_id: i.recipe_id, comp_qty: compQty, name: i.name, category: i.category,
            unit_price: i.unit_price, vat_rate: i.vat_rate, sent_to_kot: i.sent_to_kot,
            ...(i.selection_key ? { selection_key: i.selection_key } : {}),
          })
        }
        // p_comped_by is IGNORED by the server as of migration 20260819140000 — it derives
        // comped_by from auth.uid() instead, because that column is what the Sales Exception Report
        // ranks staff by and a caller able to choose it could comp under a colleague's name. It
        // stays in the call only so the argument list keeps matching the function's signature for
        // any device still on an older bundle; do not start relying on it again.
        const { data: newCompNo, error: compErr } = await bounded(supabase.rpc('apply_pos_item_comps', {
          p_order_id: orderId, p_client_id: clientId, p_fy: compFy,
          p_comp_reason: itemCompReason, p_comped_by: profile?.id || null,
          p_full_recipe_ids: fullCompRecipeIds, p_partial: partialComps,
          ...(fullCompLines.length ? { p_full_lines: fullCompLines } : {}),
        }), 'Applying the comps')
        if (compErr) {
          // "Already closed" after an unanswered press may be that press's own bill (S809 CHECKOUT-7).
          const byEarlier = await settleIfEarlierClosed(earlier, compErr)
          if (byEarlier) return byEarlier === 'finished'
          setCloseMsg(`error:Could not apply the complimentary item(s), so the bill was not charged — ${errorText(compErr, 'staff')}`)
          return false
        }
        compNo = newCompNo
        const { data, error: compRowsErr } = await bounded(
          scopedFrom('pos_order_items', `*, ${LINE_CHOICE_STOCK}`).eq('order_id', orderId).eq('comp_no', compNo), 'Reading the comped items')
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
      const custRow = buyerCustomerRow()
      let custUpsertDone = false
      // S809 2g (CUSTOMERS-PARKING-2): a Split charge without points first hands back any redemption
      // standing on this bill that this screen does not know of (another till's, or one from before a
      // reload or a lock); redeeming 0 does nothing when none stands. Its payment lines would be refused
      // after the close otherwise. Every other close has it handed back by guard_pos_order_close itself.
      if (!loyaltyTender && isSplit && hasFeature('loyalty') && liveRedemptionRef.current?.orderId !== orderId) {
        const { error: backErr } = await bounded(supabase.rpc('redeem_loyalty_points', { p_order_id: orderId, p_points: 0 }), 'Checking the bill for points')
        if (backErr) {
          const byEarlier = await settleIfEarlierClosed(earlier, backErr)
          if (byEarlier) return byEarlier === 'finished'
          setCloseMsg(`error:Could not check this bill for points left from an earlier try, so it was not charged — try again. ${errorText(backErr, 'staff')}`)
          return false
        }
      }
      if (!loyaltyTender && liveRedemptionRef.current?.orderId === orderId) {
        const res = await cancelLiveRedemption()
        if (!res.ok) {
          const byEarlier = await settleIfEarlierClosed(earlier, res.closed ? { hint: HINT.notOpen } : null)
          if (byEarlier) return byEarlier === 'finished'
          setCloseMsg(`error:Points redeemed on an earlier attempt at this bill could not be handed back, so it was not closed and nothing was charged — try again. ${res.text}`)
          return false
        }
      }
      if (loyaltyTender) {
        setCloseStep('Redeeming points…')
        const { error: buyerErr } = await bounded(scopedUpdate('pos_orders', {
          buyer_name: buyerName.trim() || null, buyer_phone: phoneForRecord(buyerPhone) || null,
        }).eq('id', orderId), 'Attaching the customer')
        if (buyerErr) {
          const byEarlier = await settleIfEarlierClosed(earlier, buyerErr)
          if (byEarlier) return byEarlier === 'finished'
          setCloseMsg("error:Could not attach the customer's phone to this bill, so the points were NOT redeemed and nothing was charged — try again, or undo the points and take another payment.")
          console.error('buyer write before redemption failed:', buyerErr)
          return false
        }
        if (custRow) {
          const { error: custErr } = await bounded(scopedUpsert('pos_customers', custRow, { onConflict: 'client_id,phone' }), 'Saving the customer')
          // Not a refusal on its own: the balance shown was read from this customer's existing row,
          // so the RPC can still find it. If it truly is missing the RPC refuses, and says so.
          if (custErr) console.error('pos_customers upsert before redemption failed:', custErr)
          else custUpsertDone = true
        }
        // Marked BEFORE the call: a response lost after the server committed must still leave this
        // screen able to hand the points back (undo, Cancel, or a close without them).
        liveRedemptionRef.current = { orderId }
        const { data: redeemed, error: redErr } = await bounded(supabase.rpc('redeem_loyalty_points', {
          p_order_id: orderId, p_points: loyaltyTender.points,
        }), 'Redeeming the points')
        // S809 2g (CUSTOMERS-PARKING-3): the points are worth what the server charged for them (the
        // outlet's point value now, which a manager may have changed since the phone was entered). The
        // points line takes that amount and the cashier checks the rest before confirming again; the
        // redemption stands, and the next Confirm replaces it (Remove or Cancel hands it back).
        if (!redErr && redeemedAmountDiffers(redeemed, loyaltyTender.amount)) {
          const worth = Number(redeemed)
          setLoyaltyPointValue(worth / loyaltyTender.points)
          setTenders(prev => prev.map(t => (t.method === 'Loyalty' ? { ...t, amount: worth } : t)))
          setCloseMsg(`error:${loyaltyTender.points} points are worth ${fmtNpr(worth)} at today's point value, not ${fmtNpr(loyaltyTender.amount)}, so the bill was not charged. The points line now shows ${fmtNpr(worth)} — check the rest of the payment, then confirm again.`)
          return false
        }
        if (redErr) {
          const byEarlier = await settleIfEarlierClosed(earlier, redErr)
          if (byEarlier) return byEarlier === 'finished'
          setCloseMsg(redErr.hint === HINT.rank
            ? 'error:Redeeming points needs a POS Supervisor login or above — nothing was charged.'
            : `error:Could not redeem the points, so the bill was not charged — ${errorText(redErr, 'staff')}`)
          return false
        }
      }

      // S854: a booking deposit pays as its own Split line, written on the open bill by
      // apply_booking_deposit just before the close, as points are; the amount replaces any earlier
      // line, so a retried Confirm never uses it twice. A Split charge without it first takes off a line
      // an earlier try left; any other close has it handed back by guard_pos_order_close itself.
      const depositTender = closeType === 'paid' && isSplit ? tenders.find(t => t.method === 'Deposit') : null
      if (!depositTender && isSplit && liveDepositRef.current?.orderId === orderId) {
        const back = await handBackDeposit()
        if (!back.ok) {
          setCloseMsg(`error:The deposit line an earlier try left on this bill could not be taken off, so it was not charged — try again. ${back.text}`)
          return false
        }
      }
      if (depositTender) {
        setCloseStep('Using the deposit…')
        // Marked BEFORE the call, as a redemption is: a lost answer may still have landed.
        liveDepositRef.current = { orderId }
        const used = await applyDeposit(orderId, depositTender.amount, { ms: CLOSE_STEP_MS })
        if (used.error) {
          const byEarlier = await settleIfEarlierClosed(earlier, used.error)
          if (byEarlier) return byEarlier === 'finished'
          setCloseMsg(used.noAnswer
            ? 'error:The till did not hear back about the deposit, so the bill was not charged. Press Confirm again: the deposit line is replaced, never used twice.'
            : `error:${depositErrorInfo(used.error, 'staff').text}`)
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
        // S862 COMBOS-8: a reason only with a discount, so a combos-only bill with a member card on
        // it is not stored as a member discount of NPR 0.
        discount_reason:  closeType === 'paid' && discountAmt > 0 ? (discountReason || null) : null,
        buyer_name:       buyerName.trim() || null,
        buyer_address:    buyerAddress.trim() || null,
        buyer_pan:        buyerPan.trim() || null,
        buyer_phone:      phoneForRecord(buyerPhone) || null,
        bill_remarks:     billRemarks.trim() || null,
        // S809 2c: the tax status this total was worked out under. guard_pos_order_close stamps the bill's
        // own from settings, and refuses a Charge that assumed the other one (pos_vat_status_changed).
        vat_registered:   vatReg,
        // closed_by, closed_at and invoice_no are NOT sent (S754): guard_pos_order_close stamps closed_by
        // from the session and closed_at from the server clock (a tablet clock could backdate a bill
        // into a closed month), and clears any invoice_no a request carries so the numbering trigger
        // always assigns it. All three come back on the row `.select('*')` returns, which is what the
        // printed bill reads.
        // Both Pay and Complimentary get their own sequential number (TI/PB for Pay, NC for
        // Complimentary) — the DB trigger partitions the counter by close_type so the two
        // sequences never share numbers. Void never gets one (order was never fulfilled).
        ...(closeType !== 'void' ? { invoice_fy: getBsFiscalYear(today.year, today.month) } : {}),
        // The shift open at the moment of the bill, from the fresh read above. For Charge and
        // Complimentary that read refused the close when there was none (S754) — so an order left open
        // across a shift close is stamped with the NEXT shift when it is finally billed, which is
        // what PosShifts' close warning tells the supervisor; guard_pos_order_close re-stamps those
        // two from the shift it locks (S809 2b) anyway. A Void sends the cached id, unread: the guard
        // files it on the shift open at that instant, or on none (S823 5c).
        shift_id: billShiftId,
        // S823 5c: the lines this total was worked out from (see pricedVersion above). A void prices
        // nothing, and the guard neither checks nor keeps a version it sends.
        ...(closeType !== 'void' && pricedVersion !== null ? { items_version: pricedVersion } : {}),
      }

      // S835 (S809.4, 4i; owner 2026-10-14): a guest QR order whose dishes are on this bill but whose
      // "accepted" mark has not saved would be turned away by the close itself
      // (pos_orders_close_turns_away_guest_orders), and the guest's phone would say it was not taken. One
      // more bounded try first; if it still waits, the bill closes anyway and the waiter is told.
      const guestMarkWaits = () => [...unmarkedGuestAcceptsRef.current.values()].includes(orderId)
      let guestMarkMissed = false
      if (closeType !== 'void' && guestMarkWaits()) {
        setCloseStep('Saving the guest order…')
        // A run already in flight may have started before this bill's ids were added: then once more.
        await withTimeout(markGuestAccepts().then(() => (guestMarkWaits() ? markGuestAccepts() : null)), SEND_READ_MS, 'Marking the guest order accepted')
          .catch(e => console.error('guest order mark before the close did not finish:', e))
        guestMarkMissed = guestMarkWaits()
      }

      setCloseStep('Closing the bill…')
      // Marked BEFORE the write (S776): if its answer is lost, this is what tells the next press — or
      // Cancel — that "already closed" may be this till's own write rather than another till's.
      // An attempt an earlier press left unsettled is carried on (S809 CHECKOUT-7): it still counts that
      // press's write as travelling and keeps what that press sent.
      const attempt = closeAttemptFor(orderId) || newCloseAttempt(closeType)
      setCloseAttempt(orderId, attempt)
      // Cancelled when the till stops waiting (S809), so nothing more of it can be sent; only what the
      // server already received can still land, and that is finished within CLOSE_LAND_GRACE_MS.
      const closeAbort = new AbortController()
      const closeWrite = trackCloseWrite(attempt,
        scopedUpdate('pos_orders', payload).eq('id', orderId).select('*').abortSignal(closeAbort.signal).single())
      keepCloseAttempts() // S833: when this write went out is on the tablet before its answer can be lost
      const closeRes = await bounded(closeWrite, 'Closing the bill')
      keepCloseAttempts()
      const { data: updated, error } = closeRes
      // No answer — a timeout, a dropped connection, or a gateway 5xx while the database may still be
      // working (S833: a 5xx was told to the cashier as a refusal). The write may have landed, so the
      // bill is read back rather than the close reported as failed.
      if (noAnswer(closeRes)) {
        closeAbort.abort()
        return await settleUnknownClose({ justTried: true }) === 'finished'
      }
      if (error) {
        // A refusal is an answer. The mark stays only while an earlier press's write is still travelling.
        if (!attempt.writesInFlight) setCloseAttempt(orderId, null)
        // S809.4 follow-up: guard_pos_order_close found no shift open (a Close Shift landed between the read
        // above and this write). The cache must not go on saying one is; the server's sentence below
        // tells the cashier to open one.
        if (error.hint === 'no_open_shift') setOpenShiftId(null)
        // Closed on another device between the save above and this write: the close guard now refuses
        // any write to a closed bill (S754). After an earlier press that never heard back, it may be
        // that press's write instead (S776), so it is read before another till is blamed.
        if (error.hint === HINT.locked) {
          if (earlier) {
            setCloseAttempt(orderId, earlier)
            return await settleUnknownClose() === 'finished'
          }
          showClosedElsewhere()
          return false
        }
        // Closing is Supervisor work and the server now says so for every close type (S754) — the
        // Payment button is already hidden below that rank, so this is a login whose rank changed.
        if (error.hint === HINT.rank) {
          setCloseMsg('error:This login cannot close bills — it needs POS Supervisor access or above. Nothing was charged; ask a supervisor to take the payment.')
          return false
        }
        // S809 2c: the Owner switched the outlet's VAT registration after this till read its settings,
        // so the total on screen assumed the other one. Nothing was charged. Payment waits while the
        // settings are read again; the server's sentence below tells the cashier to charge the new total.
        if (error.hint === 'pos_vat_status_changed') {
          setBillingSettingsLoaded(false)
          loadTillSettings()
        }
        // S823 5c: the stored lines moved after this press saved and priced them (another till saved
        // the order in between). Nothing was charged. The order screen loads the latest lines, offers
        // back anything of this cart they lack, and the payment modal steps aside, as for a stale save.
        if (error.hint === 'pos_bill_lines_changed') {
          const keep = tenders.filter(t => t.method !== 'Loyalty')
          refusedTendersRef.current = keep.length > 0 ? { orderId, tenders: keep } : null
          dismissBillingAfterRefusal()
          await reloadAfterStale(orderId, orderItems, null, { duringClose: true })
          return false
        }
        // S839: a discount above what the bill's non-combo dishes come to (the bill changed under the
        // payment window, or an older screen). Nothing was charged.
        if (error.hint === 'discount_on_combo') {
          setCloseMsg(`error:${errorText(error, 'staff')}`)
          return false
        }
        // guard_pos_order_close() (migration 20260819120000) refuses an over-cap discount or a void
        // from an account without Allow Void, and phrases the refusal for the person holding the
        // till. Its messages are prefixed with the table name the way every Postgres error is;
        // strip that so the cashier reads the sentence, not the schema.
        setCloseMsg('error:' + stripCodeWord(error.message, 'pos_orders'))
        return false
      }
      setCloseAttempt(orderId, null)
      if (guestMarkMissed) {
        const guestWhere = activeTable?.name || (updated.order_no ? `Takeaway #${updated.order_no}` : 'this takeaway')
        warnWrite(`A guest's QR order is on the bill for ${guestWhere}, but it was not marked as taken before the bill closed, so their phone may say it was turned away. Let the guest know their food was on this bill.`)
      }
      return await finishClosedBill(closeType, updated, { compNo, compedItemRows, custRow, custUpsertDone })
    } finally {
      closingRef.current = false
      setClosing(false)
      setCloseStep('')
    }
  }

  // Everything after the bill is closed and numbered. The close cannot be undone from here, so nothing
  // below refuses: each failure is a warnWrite naming its consequence. Shared by an ordinary close and
  // by a close whose answer was lost and read back (settleUnknownClose, S776).
  //
  // The ORDER is an owner decision (S776): the Split legs, then the PRINT, then everything else. The
  // legs come first because the server admits them only within 10 minutes of the close and the printed
  // bill reads them back; Inventory posting, the customer book and loyalty used to run before the print,
  // so a guest waited on bookkeeping for their bill — and on a slow connection, waited indefinitely.
  //
  // A close settled after its answer was lost (finishSettledClose, S809 CHECKOUT-7) passes `stored` (the
  // bill's lines and legs as the server holds them), `attempt` (what that try sent) and `note` (what the
  // floor must be told). It prints and records legs from those, never from the screen; the database posted
  // the bill to Inventory in the close itself (S830 5f-1), and this only reads whether it did. With
  // `background` the till has moved on to other work: the bill is not printed (nobody may be at the
  // printer, and the guest may have gone — the floor says to reprint it), and nothing on screen is
  // touched. What is time-bound still runs: the Split legs and the points, each
  // admitted by the server only within 10 minutes of the close, then the customer, booking and table.
  async function finishClosedBill(closeType, updated, { compNo = null, compedItemRows = [], custRow = null, custUpsertDone = false, stored = null, attempt = null, background = false, note = null } = {}) {
    // The bill is closed and numbered. Nothing an earlier attempt redeemed is "standing" any more —
    // it is this bill's tender now. (A redemption standing on another bill stays tracked.)
    if (liveRedemptionRef.current?.orderId === updated.id) liveRedemptionRef.current = null
    if (liveDepositRef.current?.orderId === updated.id) liveDepositRef.current = null
    if (refusedTendersRef.current?.orderId === updated.id) refusedTendersRef.current = null
    const where = (background && attempt?.where) || orderLabel()
    const step = background ? () => {} : setCloseStep

    // Split legs FIRST, straight after the close: the server admits them only from the login that
    // closed the bill, within 10 minutes of its server-stamped closed_at (S754) — nothing else may
    // run in between that could push them past that window or out of this session.
    if (updated.payment_method === 'Split') {
      step('Recording the payments…')
      // The Loyalty leg is deliberately absent: redeem_loyalty_points already wrote it, in the
      // same transaction as the ledger debit, so inserting it again here would show the bill as
      // collecting the redemption twice — and the server refuses a Loyalty leg from the browser.
      // A settled close records its own try's tenders, and none once any leg is on the bill (S809).
      const cashTenders = legsToRecord(attempt ? attempt.sent.tenders : tenders, stored ? stored.legs : null)
      if (cashTenders.length > 0) {
        // The bill is already billed and numbered by this point, so this cannot be undone by
        // refusing the close. But these rows ARE the record of how the bill was paid: without
        // them the shift's Z-report reconciles a drawer against a payment mix missing this
        // bill's legs, which reads as a cash variance nobody can explain.
        const legRows = cashTenders.map(t => ({
          order_id: updated.id,
          payment_method: t.method, amount: t.amount, tendered_amount: t.tenderedAmount,
          recorded_by: profile?.id || null,
        }))
        let { error: payErr } = await bounded(scopedInsert('pos_order_payments', legRows), 'Recording the payments')
        if (payErr) {
          // A dropped response can hide an insert that landed, and a blind retry of a landed one is
          // refused anyway (the server will not let the legs exceed the bill). So look first: legs
          // already there means it landed; none there means one retry, still inside the window.
          const { data: legs, error: legsErr } = await bounded(scopedFrom('pos_order_payments', 'amount')
            .eq('order_id', updated.id).not('payment_method', 'in', '(Loyalty,Deposit)'), 'Checking the payments')
          const want = cashTenders.reduce((s, t) => s + t.amount, 0)
          const found = legs || []
          const have = found.reduce((s, l) => s + (Number(l.amount) || 0), 0)
          if (!legsErr && found.length === cashTenders.length && Math.abs(have - want) < 0.01) {
            payErr = null
          } else if (!legsErr && found.length === 0) {
            const retry = await bounded(scopedInsert('pos_order_payments', legRows), 'Recording the payments')
            payErr = retry.error
          }
        }
        if (payErr) {
          warnWrite(`How ${where} was paid (${cashTenders.map(t => `${t.method} ${fmtNpr(t.amount)}`).join(' + ')}) did not save. The bill is closed and correct, but the shift report will not show these payments — give the amounts to whoever closes the drawer. They cannot be added to the bill afterwards.`, payErr)
        }
      }
    }

    // The paper, before any bookkeeping (see above). A blocked pop-up used to set an order-screen
    // message that backToFloor wiped a moment later, on a floor with no message line — so the bill
    // closed and nothing printed, silently (S754). The close cannot be undone for it; the floor
    // banner names the recovery.
    step('Printing…')
    const printed = []
    // A settled close prints the bill as STORED (S809), and nothing at all when its lines could not
    // be read back — never the cart in their place. In the background it does not print (see above).
    const canPrint = !background && !(stored && !stored.items)
    if (canPrint && closeType === 'paid') printed.push(await printBill(updated, stored ? stored.items.filter(i => !i.comped).map(withChoices) : payableOrderItems))
    // A Complimentary Slip prints the bill's STORED lines: a dish's choices' stock lines, which its food
    // cost includes, are the server's snapshot and never the cart's. Read back here on an ordinary close;
    // a failed read prints nothing rather than a slip costed without them.
    if (canPrint && closeType === 'writeoff') {
      const lines = stored ? stored.items : (await readStoredBill(updated)).items
      if (lines) printed.push(await printCompSlip(updated, lines))
      else warnWrite(`The Complimentary Slip for ${where} was not printed — its items could not be read back. Reprint it from Recent Bills.`)
    }
    // compedItemRows is null only when the read above failed — skip rather than print a slip
    // with no lines; the operator has already been told to reprint it.
    if (canPrint && closeType === 'paid' && compNo != null && compedItemRows) printed.push(await printItemCompSlip(updated, compedItemRows))
    if (!background && !canPrint && closeType !== 'void') {
      warnWrite(`The bill for ${where} closed, but its items could not be read back, so it did not print — reprint it from Recent Bills.`)
    }
    // false is a blocked pop-up; null is a print that already said why it stopped (a failed read).
    if (printed.some(p => p === false)) {
      warnWrite(`The bill for ${where} was closed but did not print — allow pop-ups for this site, then reprint it from Recent Bills.`)
    }

    step('Finishing up…')
    if (closeType === 'void') {
      // S817 4i (FLOOR-KITCHEN-4, D18): the database cancels this order's tickets still being made in
      // the void's own transaction (pos_orders_void_cancels_tickets), whichever way the bill was
      // voided, so nothing is written here any more; the Kitchen Display shows them as "VOIDED — stop"
      // for a few minutes. What the till adds is the paper: a VOID slip for each station whose ticket
      // the void stopped, read back from the tickets themselves (stamped at the void's own instant, so
      // a ticket the kitchen cleared earlier is not printed again). A Served ticket is left alone, and
      // a comp (writeoff) cancels nothing: that food was made. S835: the VOID slip prints in the
      // background too (a void whose answer was lost and was confirmed later), whatever the till is on,
      // because the kitchen must stop cooking either way; a blocked print says so on the floor.
      step('Telling the kitchen…')
      let stopRead = scopedFrom('pos_kot_log', 'station, items')
        .eq('order_id', updated.id).eq('status', 'cancelled').not('cancelled_at', 'is', null)
      if (updated.closed_at) stopRead = stopRead.gte('cancelled_at', updated.closed_at)
      const { data: stopped, error: stopErr } = await bounded(stopRead.order('sent_at').order('id'), 'Checking the kitchen tickets')
      if (stopErr) {
        warnWrite(`The bill for ${where} was voided, but its kitchen tickets could not be read back, so no VOID slip printed. Tell the kitchen and bar to stop ${where}'s order.`, stopErr)
      } else {
        const byStation = {}
        for (const r of stopped || []) (byStation[r.station] ||= []).push(...(r.items || []))
        const voidTable = updated.table_name || (background ? null : activeTable?.name) || 'Takeaway'
        const voidNo = updated.order_no ?? (background ? null : orderNo)
        const voidPrinted = ['KOT', 'BOT'].filter(st => byStation[st]?.length).map(st => {
          const res = stationPrint.deliver({
            station: st, kind: 'void', label: `VOID · ${voidTable}${voidNo ? ` · #${voidNo}` : ''}`,
            doc: voidSlipDoc({
              station: st, items: byStation[st], ticketNo: voidNo, outletName,
              tableName: voidTable, voidedBy: printedStaffName(profile, isAdmin), voidedAt: updated.closed_at,
            }),
          })
          return res.via === 'device' || res.printed
        })
        if (voidPrinted.some(p => p === false)) {
          warnWrite(`The bill for ${where} was voided, but the VOID slip did not print — allow pop-ups for this site, and tell the kitchen and bar to stop ${where}'s order.`)
        }
      }
    }

    // The three writes below are STARTED here and awaited further down, rather than each taking
    // its own turn in the queue. All depend only on the order already being billed — none reads
    // anything the IMS post produces — so they travel alongside it instead of adding more round
    // trips. Each is bounded and resolves `{ error }`, so none can surface as an unhandled rejection
    // in the gap before it is awaited.

    // The table is freed by the database in the close's own transaction (S836,
    // pos_orders_release_tables): the bill's STORED table and its joined tables, Occupied → Available
    // only, and only while no other open bill holds them. The till used to free the table on its
    // screen, which after a move made on another till was another party's.
    const tableId = updated.table_id || (background ? attempt?.tableId : activeTable?.id) || null

    // A booking seated from the floor completes when its bill closes — every close type, since
    // the visit is over as far as the book is concerned (the bill's own outcome is read through
    // order_id). Zero rows matched is the ordinary walk-in case, not a failure.
    const reservationDone = bounded(
      scopedUpdate('pos_reservations', stampFor('completed')).eq('order_id', updated.id).eq('status', 'seated'), 'Completing the booking'
    ).then(({ error }) => {
      if (error) warnWrite('The booking linked to this bill still shows as Seated in Reservations. In Reservations, use ⋯ → Mark done on it.', error)
    })

    // The customer book (buyerCustomerRow). Non-fatal — never blocks billing. Already written before
    // a redemption, in which case it is not sent twice.
    const custUpsert = custRow && !custUpsertDone
      ? bounded(scopedUpsert('pos_customers', custRow, { onConflict: 'client_id,phone' }), 'Saving the customer')
          .then(({ error }) => { if (error) console.error('pos_customers upsert failed (non-fatal):', error) })
      : null

    // The database posted the bill in the close (S830 5f-1) and marks it, a bill with no dish included.
    // A bill it could not post waits, unmarked, for Post to Inventory; it is noted here so the floor
    // banner counts it at once. A void has nothing to post, so it is marked done rather than left looking
    // like a failure the floor banner should chase.
    if (closeType !== 'void' && !tillPostsToIms) {
      // An outlet without Inventory (S809 4e, owner decision D6): nothing is posted and nothing counted,
      // and the bill is deliberately NOT marked, so switching Inventory on later still finds it waiting.
    } else if (closeType !== 'void') {
      const inInventory = await withTimeout(billReachedInventory(updated), CLOSE_STEP_MS + 5000, 'Checking Inventory')
        .catch(e => { console.error('could not check whether the closed bill reached Inventory:', e); return false })
      if (!inInventory) {
        const missedId = updated.id
        setImsMisses(list => noteImsMiss(list, missedId, Date.now()))
      }
    } else {
      const { error: stampErr } = await bounded(scopedUpdate('pos_orders', { ims_posted_at: new Date().toISOString() }).eq('id', updated.id), 'Marking the bill settled')
      // No screen counts a voided bill as not posted (each counts billed bills only), so this is logged.
      if (stampErr) console.error('ims_posted_at mark on a voided bill failed (nothing counts it):', stampErr)
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
    // Best-effort, as every step after the close is: a points problem must
    // never stop a bill closing. But deliberately NOT silent — an earn that fails without a
    // word is how a regular discovers at the till next month that none of it counted. The
    // RPC computes from the order's own stored lines, so nothing here can influence the
    // number; this call only asks.
    //
    // S754: the server now awards only to the login that closed the bill, within 10 minutes of the
    // close, and a till cannot retry it later — so a failure here is final for staff, and the note
    // says who can still add the points rather than inviting a retry that will be refused.
    setLoyaltyNote(null)
    // A settled close names the customer the bill stored (S809), never the screen's.
    const phone = updated.buyer_phone || (attempt ? '' : buyerPhone.trim())
    if (hasFeature('loyalty') && closeType === 'paid' && phone) {
      const who = updated.buyer_name || (attempt ? '' : buyerName.trim()) || phone
      const awardRes = await bounded(supabase.rpc('award_loyalty_points', { p_order_id: updated.id }), 'Adding the points')
      const { data: earned, error: loyErr } = awardRes
      // The award's own refusals (not the closer, past the 10-minute window) already say where points
      // are added later (S815 4g: the customer's History in Customers → Loyalty, by the Owner or a POS
      // manager, in one tap).
      if (loyErr && (loyErr.hint === HINT.rank || loyErr.hint === 'award_window_closed')) {
        setLoyaltyNote({ ok: false, text: `Points were not added for ${who} — ${loyErr.message}` })
      } else if (noAnswer(awardRes)) {
        // The award may have landed with its answer lost, so this must not invite adding them by hand.
        setLoyaltyNote({ ok: false, text: `It is not known whether points were added for ${who} — the connection dropped. The Owner or a POS manager can check the customer's History in Customers → Loyalty, and add this bill's points there if they are missing.` })
      } else if (loyErr) {
        setLoyaltyNote({ ok: false, text: `Points were not added for ${who} — ${errorText(loyErr, 'staff')} They can only be added from the till as the bill closes; the Owner or a POS manager can add them from the customer's History in Customers → Loyalty.` })
      } else if (earned > 0) {
        // S815 4g (Q19 c): a Credit bill's points wait for the bill to be paid.
        const onTab = updated.payment_method === 'Credit'
        setLoyaltyNote({ ok: true, text: `+${earned} point${earned === 1 ? '' : 's'} for ${who}${onTab ? ' — usable once this Credit bill is settled' : ''}` })
      }
    }

    await reservationDone
    // The per-table snapshot described the order that just closed (S754) — left behind, an
    // offline open of this table reloaded a paid bill's lines. Best-effort: the offline path now
    // also refuses a snapshot unless the table reads occupied.
    if (tableId) clearCachedPosOrderForTable(tableId).catch(e => console.error('order snapshot clear failed (non-fatal):', e))

    // In the background nothing on screen is touched (S809): the floor banner says the bill closed after
    // all, what did not run and why, and the recovery for each.
    if (background) {
      warnWrite(closeType === 'void'
        ? `The first try to void ${where} went through after all — no bill was issued.`
        : `The first payment try for ${where} went through after all: ${closedStatement(closeType, updated, where).replace(/\.$/, '')}. It was not printed, because the till had moved on — reprint it from Recent Bills.${tillPostsToIms ? ' It is not in Inventory yet: a POS manager posts it with Post to Inventory on the floor.' : ''}${note ? ` ${note}` : ''}`)
      void withTimeout(loadFloor({ quiet: true }), CLOSE_STEP_MS, 'Reloading the floor')
        .catch(e => console.error('floor reload after a late close did not finish (non-fatal):', e))
      return true
    }
    setBillingOpen(false)
    setFloorMsg(note ? `error:${note} ${closedStatement(closeType, updated, where)}` : `ok:${closedStatement(closeType, updated, where)}`)
    await withTimeout(loadFloor(), CLOSE_STEP_MS, 'Reloading the floor')
      .catch(e => console.error('floor reload after a close did not finish (non-fatal):', e))
    backToFloor()
    return true
  }

  // The sentence a close ends on (S776): the number on the paper, the amount, and the change to hand
  // back — so the cashier can confirm the bill closed without reading the print. The payment modal
  // used to close onto the floor with nothing said at all.
  function closedStatement(closeType, row, where) {
    if (closeType === 'void') return `${where} voided — no bill was issued.`
    if (closeType === 'writeoff') return `Complimentary slip NC-${String(row.invoice_no ?? '').padStart(2, '0')} closed for ${where}.`
    const parts = [`${vatReg ? 'TI' : 'PB'}${row.invoice_no ?? ''} closed`, where, fmtNpr(Number(row.paid_amount) || 0)]
    if (row.payment_method === 'Credit') parts.push(row.delivery_partner ? `on credit to ${row.delivery_partner}` : 'on credit')
    else if (row.payment_method === 'Split') parts.push('split payment')
    else if (row.payment_method && row.payment_method !== 'Cash') parts.push(row.payment_method)
    const change = row.tendered_amount != null ? Number(row.tendered_amount) - Number(row.paid_amount) : 0
    if (change > 0) parts.push(`change ${fmtNpr(change)}`)
    return parts.join(' · ')
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

  // `reprint` (S809 CHECKOUT-11) carries what a reprint read from the bill itself: the HSC codes of
  // its own lines and the name of the login that closed it. Without it this is the live close, whose
  // codes openBilling just read and whose cashier is the login pressing Confirm.
  async function printBill(order, items, reprint = null) {
    // Split tenders are read BEFORE print_count is incremented. A dropped error here fell
    // through to `payments = []` and printed a Split bill with no payment breakdown at all —
    // a wrong document under a real invoice number — and aborting after the increment would
    // have mislabelled the next reprint's ORIGINAL/SECOND-COPY line too (S616).
    let payments
    if (order.payment_method === 'Split') {
      const { data, error } = await bounded(scopedFrom('pos_order_payments', 'payment_method, amount').eq('order_id', order.id).order('recorded_at'), 'Reading the payments')
      if (error) {
        showTillNotice(`Couldn't load this bill's split payment lines — ${errorText(error, 'staff')}\n\nNothing was printed. Reprint it from Recent Bills, so the bill doesn't go out without its payment breakdown.`)
        return null // not printed, and already said so — distinct from false (a blocked pop-up)
      }
      payments = (data || []).map(p => ({ method: p.payment_method, amount: p.amount }))
    }
    const newCount = (order.print_count || 0) + 1
    // Not blocking: withholding a customer's bill because a counter did not move is worse than
    // the counter being stale. But the label printed on this copy comes from `newCount` while
    // the stored one does not move, so the NEXT reprint repeats this same copy number — which
    // is exactly what the ORIGINAL/COPY sequence exists to make distinguishable.
    // Not awaited (S776): the paper does not wait on a counter.
    void bounded(scopedUpdate('pos_orders', { print_count: newCount }).eq('id', order.id), 'Counting the print').then(({ error: pcErr }) => {
      if (pcErr) warnWrite('A reprint count did not save — the next reprint of that bill will carry the same copy number as this one.', pcErr)
    })
    const qrUrl = QR_PAY_METHODS.includes(order.payment_method)
      ? await makeBillQr(order.paid_amount, order.order_no ? `CR${order.order_no}` : null) : ''
    // Returned so a caller can tell a blocked pop-up from a printed bill (S754).
    return printHtml(buildBillHtml({
      order, items, copyLabel: COPY_LABEL(newCount), qrUrl, payments,
      outletName, billingSettings, hscMap: reprint ? reprint.hscMap : hscMap,
      tableName: order.table_name || activeTable?.name || 'Takeaway', // S836: stored first
      cashierName: reprint ? reprint.staffName : printedStaffName(profile, isAdmin),
    }))
  }

  // A Complimentary Slip is valued at food cost, so a slip printed without its costs would be a wrong
  // document, not a partial one. Bounded (S776); null means not printed, and the floor banner says so.
  // `lines` are the bill's STORED lines (with LINE_CHOICE_STOCK), so each dish is costed with its choices.
  async function slipCosts(lines) {
    try {
      return await withTimeout(posLineCosts(supabase, clientId, lines, compCostOpts(lines)), CLOSE_STEP_MS, 'Reading food costs')
    } catch (e) {
      warnWrite('A Complimentary Slip was not printed — its food cost could not be read in time. Reprint it from Recent Bills.', e)
      return null
    }
  }

  // Complimentary items were never sold — this is an internal cost-tracking slip, not a Tax
  // Invoice or PAN Bill: no VAT/PAN, own NC-prefixed sequence (separate from TI/PB), and line
  // amounts are valued at food cost (not menu price) so the P&L impact isn't distorted by
  // retail pricing. Standard practice per restaurant accounting for comps.
  async function printCompSlip(order, items, reprint = null) {
    const newCount = (order.print_count || 0) + 1
    // Not blocking: withholding a customer's bill because a counter did not move is worse than
    // the counter being stale. But the label printed on this copy comes from `newCount` while
    // the stored one does not move, so the NEXT reprint repeats this same copy number — which
    // is exactly what the ORIGINAL/COPY sequence exists to make distinguishable.
    // Not awaited (S776): the paper does not wait on a counter.
    void bounded(scopedUpdate('pos_orders', { print_count: newCount }).eq('id', order.id), 'Counting the print').then(({ error: pcErr }) => {
      if (pcErr) warnWrite('A reprint count did not save — the next reprint of that bill will carry the same copy number as this one.', pcErr)
    })
    const costing = await slipCosts(items)
    if (!costing) return null
    return printHtml(buildCompSlipHtml({
      order, items, plateCostOf: costing.costOf, copyLabel: COPY_LABEL(newCount),
      outletName,
      tableName: order.table_name || activeTable?.name || 'Takeaway', // S836: stored first
      // A reprint names who comped the bill, not who reprinted it (S809 CHECKOUT-11).
      authorizedBy: reprint ? reprint.staffName : printedStaffName(profile, isAdmin),
    }))
  }

  // One item-level Complimentary Slip per Charge action, covering every item comped in that
  // action (not one per line) — shares the whole-order Complimentary Slip's NC-series
  // (`apply_pos_item_comps` takes the number under that series' lock), so `order.invoice_no` (this order's Tax Invoice/PAN
  // Bill number) is swapped out for the comp-specific number the comped rows just got assigned.
  // Uses its own `comp_print_count` counter (not the main bill's `print_count`) so reprinting
  // one document never mislabels the other's copy number — see reprintItemCompSlip.
  async function printItemCompSlip(order, compedItems, reprint = null) {
    const newCount = (order.comp_print_count || 0) + 1
    // Not awaited (S776): the paper does not wait on a counter.
    void bounded(scopedUpdate('pos_orders', { comp_print_count: newCount }).eq('id', order.id), 'Counting the print').then(({ error: pcErr }) => {
      if (pcErr) warnWrite('A complimentary-slip reprint count did not save — the next reprint will carry the same copy number as this one.', pcErr)
    })
    const costing = await slipCosts(compedItems)
    if (!costing) return null
    return printHtml(buildCompSlipHtml({
      order: { ...order, invoice_no: compedItems[0]?.comp_no ?? null, close_reason: compedItems[0]?.comp_reason || itemCompReason, bill_remarks: '' },
      items: compedItems, plateCostOf: costing.costOf, copyLabel: COPY_LABEL(newCount),
      outletName,
      tableName: order.table_name || activeTable?.name || 'Takeaway', // S836: stored first
      authorizedBy: reprint ? reprint.staffName : printedStaffName(profile, isAdmin),
    }))
  }

  // Reprint just the item-comp slip for an order from Recent Bills — the main Tax Invoice/Bill's
  // own Reprint button (below) only ever re-sends the non-comped items, so a bill with any
  // comped items needs this separate action to get a duplicate of that slip.
  async function reprintItemCompSlip(orderRow) {
    if (!hasPosAccess('supervisor')) return // S754: Recent Bills is Supervisor+ — see loadRecentBills
    // Together, not one after the other — the second read filters on orderRow.id like the first,
    // not on anything the first returns, so serialising them just made the counter wait twice.
    const [{ data: order, error: orderErr }, { data: items, error: itemsErr }] = await Promise.all([
      bounded(scopedFrom('pos_orders').eq('id', orderRow.id).single(), 'Reading the bill'),
      bounded(scopedFrom('pos_order_items', `*, ${LINE_CHOICE_STOCK}`).eq('order_id', orderRow.id).eq('comped', true), 'Reading the bill lines'),
    ])
    // Both errors used to be dropped, so a failed read printed nothing and said nothing (S809.4).
    if (orderErr || itemsErr || !order || !items || items.length === 0) {
      showTillNotice(`Couldn't load the Complimentary Slip of bill ${orderRow.invoice_no || orderRow.order_no || ''} to reprint. ${(orderErr || itemsErr) ? errorText(orderErr || itemsErr, 'staff') : 'No comped line was found on it.'}\n\nNothing was printed — try again.`)
      return
    }
    // "Authorized by" is whoever comped these lines, not the reprinter (S809 CHECKOUT-11).
    const { name: staffName, error: staffErr } = await staffNameFor(supabase, clientId, items[0]?.comped_by)
    if (staffErr) {
      showTillNotice(`Couldn't read who comped bill ${orderRow.invoice_no || orderRow.order_no || ''}. ${errorText(staffErr, 'staff')}\n\nNothing was printed — try again.`)
      return
    }
    if ((await printItemCompSlip(order, items, { staffName })) === false) noticePopupBlocked()
  }

  // Recent Bills opens over the FLOOR, which has no message line — printHtml's own setMsg renders only
  // on the order screen, so a blocked reprint did nothing visible (S754). A till notice for the same
  // reason the floor's other refusals use one (see the import note at the top): it shows above the
  // Recent Bills dialog, on the floor and on the Billing station alike, where the floorMsg banner
  // would sit hidden behind that dialog.
  function noticePopupBlocked() {
    showTillNotice('Nothing printed — this browser blocked the print window. Allow pop-ups for this site, then press Reprint again.')
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
      setRecentBillsError("Today's date is outside the calendar table.")
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
      setRecentBillsError(errorText(error, 'staff'))
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
    // S809 2a (CHECKOUT-9): a reprint takes its heading, VAT/PAN number and address from the settings.
    if (!billingSettingsLoaded) { showTillNotice(tillSettingsReprintText(!!settingsFailure)); loadTillSettings(); return }
    // Same reason as reprintItemCompSlip above: independent reads, so one round trip rather than
    // two with a customer standing at the counter.
    const [{ data: order, error: orderErr }, { data: items, error: itemsErr }] = await Promise.all([
      bounded(scopedFrom('pos_orders').eq('id', orderRow.id).single(), 'Reading the bill'),
      bounded(scopedFrom('pos_order_items', `*, ${LINE_CHOICE_BILL}`).eq('order_id', orderRow.id), 'Reading the bill lines'),
    ])
    // `if (!order) return` alone let a failed ITEMS read straight through: items came back null,
    // `|| []` turned it into an empty array, and the reprint went out as a Tax Invoice carrying
    // a real invoice number and not one line item (S616).
    if (orderErr || itemsErr || !order || !items) {
      showTillNotice(`Couldn't load bill ${orderRow.invoice_no || orderRow.order_no || ''} to reprint. ${(orderErr || itemsErr) ? errorText(orderErr || itemsErr, 'staff') : 'The bill could not be found.'}\n\nNothing was printed — try again.`)
      return
    }
    // A copy of the original (S809 CHECKOUT-11): the HSC codes of THIS bill's lines, and the login
    // that closed it as Cashier / "Authorized by". Read together; either failing prints nothing, as a
    // failed items read does above, since a copy with blank codes or the reprinter's name is wrong.
    const writeoff = order.close_type === 'writeoff'
    // Exclude any individually-comped lines from the reprinted Tax Invoice/PAN Bill — they
    // were never on the original bill either (see closeOrder's payableOrderItems).
    const lines = writeoff ? items : items.filter(i => !i.comped)
    const [hsc, staff] = await Promise.all([
      writeoff ? { map: {}, error: null } : readHscMap(scopedFrom, lines.map(i => i.recipe_id)),
      staffNameFor(supabase, clientId, order.closed_by),
    ])
    if (hsc.error || staff.error) {
      showTillNotice(`Couldn't read ${hsc.error ? 'the HSC codes of' : 'who closed'} bill ${orderRow.invoice_no || orderRow.order_no || ''}. ${errorText(hsc.error || staff.error, 'staff')}\n\nNothing was printed — try again.`)
      return
    }
    const reprint = { hscMap: hsc.map, staffName: staff.name }
    const printed = writeoff
      ? await printCompSlip(order, lines, reprint)
      : await printBill(order, lines.map(withChoices), reprint) // S862 TILL-GUEST-5: choices with their prices
    // false = blocked window; null = printBill already raised a notice about its own failed read.
    if (printed === false) noticePopupBlocked()
    setRecentBills(prev => prev.map(o => o.id === orderRow.id ? { ...o, print_count: (o.print_count || 0) + 1 } : o))
  }

  // The ← button (S754). It called backToFloor directly, which empties the cart — so lines tapped
  // in and never sent were thrown away by the one control a waiter presses to check another table.
  // Asks only when something would actually be lost; an untouched order goes straight back.
  function requestBackToFloor() {
    // S833: during a send, the lines it carries are not lost by going back: the save still lands and its
    // tickets still print (the floor says so, watchScreen). Only what changed after the press is dropped.
    const sending = sendingCartRef.current
    if (sending) {
      const late = changedSince(sending, orderItems)
      askConfirm({
        title: 'Go back while this order is saving?',
        confirmLabel: late > 0 ? 'Go back and drop them' : 'Go back', danger: late > 0,
        cancelLabel: 'Stay', zIndex: 1200,
        body: (
          <p style={{ margin: 0 }}>
            What you pressed is still on its way. It reaches the bill whether or not you stay, anything it sends
            to the kitchen or bar still prints, and the floor says when it lands.
            {late > 0 && ` ${late === 1 ? 'One line was' : `${late} lines were`} changed after you pressed it — going back drops ${late === 1 ? 'that change' : 'those changes'}.`}
          </p>
        ),
        run: () => backToFloor(),
      })
      return
    }
    const n = unsavedChangeCount(orderItems)
    if (n === 0) { backToFloor(); return }
    // S854 (owner decision): three answers, Send and go back first. useConfirm has two buttons, so
    // this is its own small dialog (leavePrompt), rendered in the order-screen return.
    setLeavePrompt({ n })
  }

  // "Send and go back": the Send button's own press, then the floor only once it answered ok, so a
  // refusal, a missed print or a removal reason it still needs stays on this screen where it is said.
  async function sendAndGoBack() {
    setLeavePrompt(null)
    const where = orderLabel()
    const token = screenTokenRef.current
    const said = await saveOrder()
    if (typeof said !== 'string' || !said.startsWith('ok:') || screenTokenRef.current !== token) return
    backToFloor()
    setFloorMsg(said.replace(/^ok:/, `ok:${where}: `))
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
            Nothing is billed, so no revenue or stock movement is recorded for what those orders held, and their
            tickets leave the Kitchen Display. Food already sent to the kitchen or bar is recorded under
            KOT Log → Pulled Items as “Table cleared”. A party seated from a booking goes back to Arrived on the
            Reservations page, waiting for a table.
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
      showTillNotice(`Couldn't read the open orders. ${errorText(openErr, 'staff')}\n\nNothing was cleared — the tables were left as they are rather than freed with their orders still open.`)
      setFloorLoad(false)
      return
    }
    const ids = (openOrders || []).map(o => o.id)
    if (ids.length > 0) {
      // S818 RESERVATIONS-6 (D22): a booking seated on one of these orders goes back to Arrived,
      // unlinked, BEFORE anything is deleted. The link is ON DELETE SET NULL and a Seated booking must
      // have an order (pos_reservations_seated_has_order), so the order delete was refused for the
      // whole floor after every order's lines had already gone. This write is the one that can fail
      // cleanly: nothing has been deleted yet.
      const { error: unseatErr } = await scopedUpdate('pos_reservations', { status: 'arrived', order_id: null, seated_at: null })
        .in('order_id', ids).eq('status', 'seated')
      if (unseatErr) {
        showTillNotice(`Couldn't take the booked parties off these orders. ${errorText(unseatErr, 'staff')}\n\nNothing was cleared — every order and table is as it was.`)
        setFloorLoad(false)
        return
      }
      // The guard above protects the READ; these are the writes it was protecting, and they had
      // the identical hole one layer down — a failed delete followed by a successful table
      // release frees the whole floor with every open order still sitting underneath it.
      const { error: delItemsErr } = await scopedDelete('pos_order_items').in('order_id', ids)
      const { error: delOrdersErr } = delItemsErr ? { error: null }
        : await scopedDelete('pos_orders').in('id', ids)
      if (delItemsErr || delOrdersErr) {
        // Two statements, not one: when the second fails the first has landed, and the orders
        // are still open with nothing on them.
        showTillNotice(delItemsErr
          ? `Couldn't delete the open orders. ${errorText(delItemsErr, 'staff')}

Nothing was deleted, and the tables were left occupied rather than freed with their orders still open. Any party seated from a booking is already back to Arrived on the Reservations page.`
          : `The dishes were taken off every open order, but the orders themselves could not be deleted. ${errorText(delOrdersErr, 'staff')}

Every occupied table now holds an EMPTY open order. Press Clear again, or open each table and void it.`)
        setFloorLoad(false)
        await loadFloor()
        return
      }
    }
    const { error: freeErr } = await scopedUpdate('pos_tables', { status: 'available' }).eq('status', 'occupied')
    if (freeErr) showTillNotice(`The orders were deleted, but the tables could not be freed — they still show as occupied. ${errorText(freeErr, 'staff')}`)
    await loadFloor()
  }

  function backToFloor() {
    // On /pos/billing the cashier never saw the floor plan — dropping them onto it would be a
    // different screen than the one they left.
    setBillOnLoad(false)
    // S809 ORDER-FLOW-5 (3e): a send still in flight finishes for its own order and leaves the next one alone.
    screenTokenRef.current += 1
    setView(billingStation ? 'bills' : 'floor'); setActiveTable(null); setOrderId(null); setOrderNo(null); setOrderItems([]); markCartSaved([]); setMsg('')
    setScreenOrder(null); setTableDialog(null); setShareCount(null) // S836
    setCartOpen(false)
    setSuggestions([])
    // The menu stays loaded (S847): the next table opens onto it, and loadMenu re-reads it behind
    // the screen once it is over MENU_FRESH_MS old. Resetting it here (since July, to freshen
    // me_class) made every table wait for the whole menu after its own order read.
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

  // S854: what Send would send. A line sent as 2 and now 3 is 1 new; a changed note on a sent line is a
  // change with no new units.
  const unsentLines = orderItems.filter(i => !i.sent_to_kot)
  const unsentUnits = unsentLines.reduce((n, i) => n + Math.max(0, (Number(i.qty) || 0) - (Number(i.sent_qty) || 0)), 0)
  const sendLabel = !orderId ? 'Send Order'
    : unsentLines.length === 0 ? 'Update Order'
    : unsentUnits > 0 ? `Send ${unsentUnits} new` : 'Send change'
  const sendWhere = (() => {
    const bar = unsentLines.some(i => botCategories.has(i.category || 'Other'))
    const kitchen = unsentLines.some(i => !botCategories.has(i.category || 'Other'))
    return bar && kitchen ? 'the kitchen and the bar' : bar ? 'the bar' : 'the kitchen'
  })()
  const sendTip = unsentLines.length === 0
    ? 'Saves the order. Everything on it has already gone to the kitchen or bar. Alt+S on a keyboard.'
    : `Saves the order and sends what is new to ${sendWhere}: food prints at the kitchen and drinks at the bar (POS Setup, Ticket Routing). To keep a course back, use Save, do not send yet in the menu beside it. Alt+S on a keyboard.`
  // S836: the tables joined to the bill on screen, the guest QR orders waiting at any of its tables, and
  // the Table menu (a part bill's is only "put back").
  const joinedHere = orderId ? joinedTablesOf(orderId, tableJoins, tables) : []
  const screenGuestReqs = activeTable ? [activeTable.id, ...joinedHere.map(t => t.id)].flatMap(id => pendingGuestOrders[id] || []) : []
  const tableMenuItems = !orderId ? [] : screenOrder?.partOf
    ? [{ key: 'putback', label: `Put back on ${screenTableName}`, onSelect: offerPutBackPart }]
    : [
        { key: 'move', label: 'Move or join…', onSelect: () => openTableDialog('move') },
        { key: 'dishes', label: 'Move dishes…', onSelect: () => openTableDialog('dishes') },
        { key: 'part', label: 'Pay part now…', onSelect: () => openTableDialog('part'),
          disabled: !hasPosAccess('supervisor'), hint: 'Taking a payment needs a POS Supervisor login or above.' },
        joinedHere.length > 0 && '-',
        ...joinedHere.map(t => ({ key: `release:${t.id}`, label: `Release ${t.name}`, onSelect: () => releaseJoinedTable(t) })),
      ]

  const pendingTables    = Object.values(tableOrders).filter(o => o.pending > 0)
  const pendingTableCount = pendingTables.length
  const pendingItemCount  = pendingTables.reduce((s, o) => s + o.pending, 0)

  const sections  = ['All', ...Array.from(new Set(tables.map(t => t.section).filter(Boolean)))]
  const visTables = secFilter === 'All' ? tables : tables.filter(t => t.section === secFilter)
  const menuCats  = ['All', ...Array.from(new Set(menu.map(r => r.category))).sort()]
  const menuQuery = menuSearch.trim().toLowerCase()
  // S839: the Combos tab (first, when the outlet has any). With none left it shows the whole menu.
  const onCombosTab = catTab === COMBO_TAB && combos.length > 0
  const menuTab   = catTab === COMBO_TAB ? 'All' : catTab
  const visCombos = onCombosTab ? combos.filter(c => c.name.toLowerCase().includes(menuQuery)) : []
  const cartCombos = groupComboBlocks(orderItems)
  // S842: a cart line's React key is its line key (numbered when two lines share one), never its
  // position: keyed by index, removing a line handed its DOM node, and keyboard focus, to the next dish.
  const cartRowKeys = (() => {
    const seen = new Map()
    return orderItems.map(i => { const k = lineKeyOf(i); const n = seen.get(k) || 0; seen.set(k, n + 1); return n ? `${k}~${n}` : k })
  })()
  const comboCountOf = comboId => [...cartCombos.values()].reduce((n, b) => n + (b.combo_id === comboId ? b.qty : 0), 0)
  const visMenu   = filterMenu(menu, menuTab, menuQuery)

  // S854 (owner decision): Enter in the menu search adds the first dish the grid shows (the first combo
  // on the Combos tab), exactly as a tap on it would, then clears the search for the next dish.
  function onMenuSearchKey(e) {
    if (e.key !== 'Enter' || e.nativeEvent?.isComposing) return
    e.preventDefault()
    const gridShown = menuLoaded || (menuLoadError && menu.length > 0)
    if (!menuQuery || !gridShown) return
    const top = onCombosTab ? visCombos[0] : visMenu[0]
    if (!top) return
    if (onCombosTab) tapCombo(top)
    else addItemRef.current(top)
    setMenuSearch('')
  }

  // S776: the reason used to live only in the Tip, and a tablet has no hover — so on an order not yet
  // sent the Payment button simply did nothing. It stays pressable and says why.
  const payBlocker = !orderId
    ? 'Send or save the order first — a bill is charged against a saved order.'
    : !isOnline ? 'Reconnect to take payment — the bill number comes from the server.'
    : !billingSettingsLoaded ? tillSettingsBlockText(!!settingsFailure) : null
  function pressPayment() {
    if (payBlocker) {
      // S809 2a: unread settings — the press asks again, and a failed read's notice already
      // sits above this button, so it is not said twice.
      if (orderId && isOnline && !billingSettingsLoaded) { loadTillSettings(); if (settingsFailure) return }
      setMsg(`error:${payBlocker}`); return
    }
    openBilling()
  }

  // The Alt+S / Alt+P handlers for this render (the listener sits above the access checks).
  tillKeysRef.current = {
    send: () => { if (!saving && orderItems.length > 0) saveOrder() },
    pay: () => { if (hasPosAccess('supervisor') && !saving) pressPayment() },
  }

  // A cart line's marks (sent to which station, the kitchen's timer, the +N added since), its kitchen
  // note with the presets, and its amount: one definition for a plain line and a combo's dish (S839).
  const cartLineTotal = item => item.qty * item.unit_price * (1 + (vatReg ? (item.vat_rate ?? 0) : 0))
  const cartLineMarks = item => {
    const kotTimer = item.sent_to_kot ? kotTimerLabel(ticketForLine(orderKotTickets, item), kotNow) : null
    return (<>
      {item.sent_to_kot && (
        <Tip text="Ticket already sent to the station. Send sends it again only if you add more of this dish or change its note.">
          <span style={{
            fontSize: 10, fontWeight: 700, flexShrink: 0,
            // S846: a sent line is a plain state, so it reads as the grey badge does; only an unsent
            // line (amber) asks for anything.
            background: 'color-mix(in srgb, var(--theme-text2) 10%, transparent)',
            color: 'var(--theme-text2)',
            borderRadius: 0, padding: '1px 5px', cursor: 'default',
          }}>
            ✓ {!routingShown ? 'Sent' : botCategories.has(item.category || 'Other') ? 'BOT' : 'KOT'}
          </span>
        </Tip>
      )}
      {kotTimer && (
        <Tip text="Live kitchen/bar status for this item's ticket — Sent (not yet started) / a countdown once Started, using the kitchen's own estimate / Ready once done">
          <span style={{ fontSize: 10, fontWeight: 600, flexShrink: 0, color: kotTimer.color }}>
            {kotTimer.text}
          </span>
        </Tip>
      )}
      {!item.sent_to_kot && (item.sent_qty || 0) > 0 && item.qty > item.sent_qty && (
        <Tip text={`${item.qty - item.sent_qty} extra added since the last ticket. Press Send to send the addition to the station.`}>
          <span style={{
            fontSize: 10, fontWeight: 700, flexShrink: 0,
            background: 'var(--theme-amber)', color: amberBadgeText,
            borderRadius: 0, padding: '1px 5px', cursor: 'default',
          }}>
            +{item.qty - item.sent_qty}
          </span>
        </Tip>
      )}
    </>)
  }
  // S854 (owner decision): the note box opens only on a tap of "+ Note", or when the line already has a
  // note, so a cart of ten dishes is not ten empty boxes. It closes again when left empty.
  const cartNoteEditor = (item, idx) => !(item.notes || noteOpenKey === lineKeyOf(item) || noteFocusIdx === idx)
    ? (
      <button type="button" className="till-hit--row cart-note-open"
        aria-label={`Add a kitchen note for ${item.name}`}
        onClick={() => { setNoteOpenKey(lineKeyOf(item)); setNoteFocusIdx(idx) }}>
        + Note
      </button>
    )
    : (<>
      <input
        type="text"
        aria-label={`Note for ${item.name}`}
        value={item.notes || ''}
        // Opened by "+ Note": the box takes the focus the button had.
        autoFocus={noteOpenKey === lineKeyOf(item) && !item.notes}
        onChange={e => updateItemNote(idx, e.target.value)}
        onFocus={() => setNoteFocusIdx(idx)}
        // Keep the presets while focus moves INTO them (S776): Tab from the note used to blur
        // it, hide the presets and move focus to whatever came after them.
        onBlur={e => {
          if (e.currentTarget.closest('[data-cart-line]')?.contains(e.relatedTarget)) return
          setNoteFocusIdx(null)
          if (noteOpenKey === lineKeyOf(item)) setNoteOpenKey(null)
        }}
        placeholder="Kitchen note (e.g. serve after starters)"
        className="till-hit--row"
        // S833: a written note is an instruction (often an allergy), so it reads in the body ink;
        // only the empty box's prompt stays quiet. Every note was grey italic before.
        style={{
          background: 'none', border: 'none', outline: 'none',
          fontSize: item.notes ? 12 : 11, fontStyle: item.notes ? 'normal' : 'italic',
          fontWeight: item.notes ? 600 : 400, color: item.notes ? 'var(--theme-text1)' : 'var(--theme-text3)',
          padding: '0 0 0 2px', width: '100%',
        }}
      />
      {noteFocusIdx === idx && notePresets.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 0 0 2px' }}>
          {notePresets.map(p => (
            <button
              key={p}
              onMouseDown={e => e.preventDefault()}
              onBlur={e => {
                if (e.currentTarget.closest('[data-cart-line]')?.contains(e.relatedTarget)) return
                setNoteFocusIdx(null)
                if (noteOpenKey === lineKeyOf(item)) setNoteOpenKey(null)
              }}
              onClick={() => addPresetToNote(idx, p)}
              className="till-hit--row"
              style={{
                fontSize: 12, padding: '2px 10px', borderRadius: 'var(--radius-full)',
                border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)',
                color: 'var(--theme-text2)', cursor: 'pointer',
              }}
            >{p}</button>
          ))}
        </div>
      )}
  </>)
  // A combo dish's change control: Swap when its pick offers another dish, Change when the dish has
  // choices of its own and nothing to swap to, else none.
  const comboSwapLabel = item => {
    const combo = combos.find(c => c.id === item.combo_id)
    const group = combo?.groups.find(g => String(g.id).toLowerCase() === comboGroupOf(item))
    if (!group) return null
    if (group.items.length > 1) return 'Swap'
    return dishGroupsByRecipe[item.recipe_id] ? 'Change' : null
  }
  // S809 3o for a combo's dish: choices the next save would refuse, on a dish not yet on the saved order.
  // S862 TILL-GUEST-2: a sent one too, with the way out for a dish already made (a combo goes whole).
  const comboDishTrouble = item => {
    if (!menuLoaded || savedItemsRef.current.has(lineKeyOf(item))) return null
    const sent = !!item.sent_to_kot || (item.sent_qty || 0) > 0
    const t = lineChoiceTrouble(item, dishGroupsByRecipe[item.recipe_id], optionMaps.optionsById, { sent })
    if (!t) return null
    if (sent) return comboWayOut(t.text, item)
    return t.text.replace(/Tap (Change|Choices)/, `Tap ${comboSwapLabel(item) || 'Swap'}`)
  }
  // A dish already made inside a combo is not taken off alone (combo_incomplete): it is swapped, or the combo goes.
  const comboWayOut = (text, item) => {
    const way = comboSwapLabel(item) === 'Swap' ? 'swap it, or take the combo off' : 'take the combo off'
    return text.replace(/(t)ake the dish off/i, (_, c) => (c === 'T' ? way[0].toUpperCase() + way.slice(1) : way))
  }

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

  /* ══════════════════════════════════════════ BILLING STATION (S762)

     The /pos/billing landing view. Rows are built from the same floor data the Orders screen
     draws — tableOrders keyed by table, plus the table-less open orders in takeawayOrders — so
     "open bill" means exactly here what it means there, and the 15 s floor poll keeps both live.
     Tapping Bill leaves this view for `order` with the payment window already up (billOrder). */

  // Bills whose payment was sent and is not yet known (S809 CHECKOUT-7). The Orders floor marks their
  // table tile or takeaway card; the Billing station has no tiles, so it says so above its list.
  const unsettledCloseBanner = unsettledCloses.length > 0 && (
    <div role="status" style={{
      background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
      border: '1px solid color-mix(in srgb, var(--theme-amber) 28%, transparent)',
      borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-text2)',
    }}>
      <strong style={{ color: 'var(--theme-amber-text)' }}>⚠ Payment not yet known</strong>
      {' '}for {unsettledCloses.map(a => a.where).join(', ')} — the first try may still go through. Check Recent Bills
      (at the top of this screen) before taking the payment again; the till keeps checking and finishes the bill if it did.
    </div>
  )
  // Plain text since S846: it sits on a floor tile, and a tile's chips are words read with its one
  // button, never a Tip trigger of their own (see .floor-tile in Layout.css). Help explains it.
  const unsettledCloseChip = (
    <span className="badge-amber" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>Payment not yet known</span>
  )
  // The "did not save" notes (S754). Drawn on the Billing station too since S809: a close the till
  // found after it stopped waiting reports here, and the station is where most bills are closed.
  const writeWarningsBanner = writeWarnings.length > 0 && (
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
  )

  // What the bill just closed earned. Dismissible and transient: it is feedback on one
  // action, not a standing condition like the unposted-bills warning below it. A failure
  // uses the same amber treatment rather than red — nothing is wrong with the BILL, which
  // closed and printed correctly; only the points did not land.
  // Drawn on the Billing station too (S809.4): most bills close there, so the note has to as well.
  const loyaltyNoteBanner = loyaltyNote && (
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
  )
  // Recent Bills — today's bills, reprints and the Credit Note entry (S754: Supervisor and above) — and
  // the credit note it opens. One element rendered by BOTH the floor and the Billing station (S809.4):
  // many of the till's messages say "reprint it from Recent Bills", and the Billing station, where most
  // bills close, had no way there. A modal in only one return is a button that does nothing in the
  // other (S578).
  const openRecentBills = () => { setRecentBillsOpen(true); setRecentBillsSearch(''); loadRecentBills() }
  const recentBillsModal = (
    <>
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
                  Couldn't load today's bills. {recentBillsError} This is a failed read, not an empty day: do not re-bill a table from this list.
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
                      {o.close_type === 'writeoff' && <span style={{ color: 'var(--theme-text2)', fontSize: 11 }}>(Complimentary)</span>}
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
                      <Tip text={'Issue a formal Credit Note that cancels this WHOLE bill, never one line — e.g. the wrong customer, a duplicate, or a tax correction. To fix one wrong line, credit the bill, answer No to "Was the food on this bill served?" (asked where Inventory is on, so its food goes back into Inventory), and ring the order again correctly.'}>
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
    </>
  )

  // S837: the "hasn't printed" banner for a kitchen or bar slip its print device has not put on paper.
  // Rendered in all three views (S578): a slip sent from the order screen can still be waiting when
  // the waiter is back on the floor or at the Billing station.
  const printAlertsEl = (
    <StationPrintAlerts alerts={stationPrint.alerts} notice={stationPrint.notice} busyId={stationPrint.busyId}
      onPrintHere={id => { void stationPrint.printHere(id) }} onDismiss={stationPrint.dismiss} />
  )
  // The till notice, in all three views for the same reason (S578): a refusal raised on one screen —
  // the split-payment read of a bill closed on the order screen, a reprint from Recent Bills on the
  // floor or the Billing station — must still be standing on whichever screen is up.
  const tillNoticeEl = <TillNotice notice={tillNotice} onDismiss={() => setTillNotice(null)} />


  if (view === 'bills') {
    const billRows = [
      ...tables
        .filter(t => tableOrders[t.id])
        .map(t => {
          const o = tableOrders[t.id]
          return {
            key: `table:${t.id}`, kind: 'table', tableId: t.id, orderId: o.orderId,
            // S836: a bill with joined tables is listed under all of them ("T3 + T5").
            label: [t.name, ...joinedTablesOf(o.orderId, tableJoins, tables).map(x => x.name)].join(' + '), section: t.section || '',
            covers: o.covers || 1, itemCount: o.itemCount, total: o.total,
            pending: o.pending, openedAt: o.openedAt || null, offlinePending: !!o.offlinePending,
          }
        }),
      ...takeawayOrders.map(t => ({
        key: `takeaway:${t.orderId}`, kind: 'takeaway', tableId: null, orderId: t.orderId,
        label: takeawayCardLabel(t), section: '',
        covers: t.covers || 1, itemCount: t.itemCount, total: t.total,
        pending: t.pending, openedAt: t.openedAt || null, offlinePending: !!t.offlinePending,
      })),
    ]
    // Longest-open first: the table that has been sitting an hour is the one about to ask for the
    // bill. An order with no opened_at (queued offline, never synced) sorts last — it cannot be
    // billed yet anyway.
    billRows.sort((a, b) => (a.openedAt ? new Date(a.openedAt).getTime() : Infinity) - (b.openedAt ? new Date(b.openedAt).getTime() : Infinity))
    return (
      <>
        {floorMsg && (
          <div role={floorMsg.startsWith('error:') ? 'alert' : 'status'} style={{
            background: floorMsg.startsWith('error:') ? 'color-mix(in srgb, var(--theme-red) 8%, transparent)' : 'color-mix(in srgb, var(--theme-green) 8%, transparent)',
            border: `1px solid ${floorMsg.startsWith('error:') ? 'color-mix(in srgb, var(--theme-red) 25%, transparent)' : 'color-mix(in srgb, var(--theme-green) 25%, transparent)'}`,
            borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13,
            color: floorMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)',
          }}>
            {floorMsg.replace(/^(error|ok):/, '')}
          </div>
        )}
        {unsettledCloseBanner}
        {writeWarningsBanner}
        {loyaltyNoteBanner}
        <BillingStation
          rows={billRows}
          loading={floorLoad}
          loadError={floorLoadError}
          onRetry={() => loadFloor()}
          onBill={row => openOnce(row.kind === 'table' ? row.tableId : row.orderId, () => billOrder(row))}
          openingId={openingId}
          isOnline={isOnline && !linkDown}
          now={kotNow}
          canVoid={isAdmin || isOwner || !!profile?.pos_allow_void}
          // The floor's own rank check for the same button (S754): Supervisor and above.
          onRecentBills={hasPosAccess('supervisor') ? openRecentBills : null}
        />
        {recentBillsModal}
        {confirmEl}
        {printAlertsEl}
        {tillNoticeEl}
      </>
    )
  }

  /* ══════════════════════════════════════════ ORDER SCREEN */

  if (view === 'order') return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'var(--theme-bg)',
      display: 'flex', flexDirection: 'column',
      // An installed iPhone draws under its home bar (index.html's viewport-fit=cover); env() is 0 in
      // a browser tab (S797). The top inset is the top bar's own padding, below, so its fill runs
      // under the status bar instead of leaving a strip of page ground there.
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
    }}>
      {/* S842: two always-mounted spoken lines. A status line that mounts already holding its words is
          often not read out (TalkBack especially), so "Order sent!" and losing the internet were heard by
          nobody; these regions exist before any text does and only their words change. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {msg && !msg.startsWith('error:') ? msg.replace(/^ok:/, '') : ''}
      </div>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {!isOnline ? 'Offline. This order is saved on this device and will sync when you reconnect.'
          : linkDown ? 'No internet. Orders are kept on this till and their tickets print as usual.' : ''}
      </div>

      {/* ── Top bar ── */}
      {/* S809 3c (FLOOR-KITCHEN-10): the guest-order banner is fixed above this layer and publishes its
          measured height; the bar starts below it, or the banner covers ← Table, the order number and
          the covers. The banner covers the status bar itself, and its height includes that inset, so
          the bar takes the larger of the two rather than both (the KDS header and S797's shell bars). */}
      <div style={{
        display: 'flex', alignItems: 'center', columnGap: narrowTill ? 8 : 12, rowGap: 6, flexWrap: 'wrap',
        padding: narrowTill
          ? 'calc(6px + max(env(safe-area-inset-top, 0px), var(--arrival-alert-h, 0px))) 12px 6px'
          : 'max(env(safe-area-inset-top, 0px), var(--arrival-alert-h, 0px)) 16px 0',
        minHeight: 'calc(52px + max(env(safe-area-inset-top, 0px), var(--arrival-alert-h, 0px)))', flexShrink: 0,
        background: 'var(--theme-card)', borderBottom: '1px solid var(--theme-border)',
      }}>
        <button ref={backBtnRef} type="button" onClick={requestBackToFloor} className="till-hit--row" style={{
          background: 'none', border: '1px solid var(--theme-border)',
          borderRadius: 'var(--radius-sm)', padding: '6px 14px',
          color: 'var(--theme-text2)', cursor: 'pointer', fontSize: 14,
        }}>
          ← {screenOrder?.partOf ? partBillLabel(screenTableName, null) : screenTableName}
        </button>

        {activeTable?.section && !narrowTill && (
          <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{activeTable.section}</span>
        )}

        {/* S836: the tables joined to this bill, and a part bill's mark. */}
        {joinedHere.length > 0 && (
          <Tip text="Tables joined to this bill. They stay taken until it is paid. Release one from the Table menu once nobody sits there.">
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', cursor: 'default' }}>
              + {joinedHere.map(t => t.name).join(', ')}
            </span>
          </Tip>
        )}
        {screenOrder?.partOf && (
          <Tip text="A part bill: dishes split off this table's bill so a guest can pay for them on their own, with their own invoice number. Cancel its payment to put them back.">
            <span className="badge badge-gray" style={{ fontSize: 11, cursor: 'default' }}>Part bill</span>
          </Tip>
        )}

        {/* This layer covers the top bar that names the outlet, so in a group it says it here (S809
            GAP-OUTLETS-1): a bill rung on this screen takes this outlet's name and invoice number. */}
        {outlets.length > 1 && outletName && (
          <Tip text="The outlet this order belongs to. Its bill prints this outlet's name and takes this outlet's next invoice number.">
            <span style={{
              fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', cursor: 'default',
              maxWidth: narrowTill ? 120 : 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{outletName}</span>
          </Tip>
        )}

        {orderNo && (
          <Tip text="Order number — printed on every KOT/BOT ticket so the kitchen, bar and bill all reference the same order">
            <span style={{
              fontSize: 12, fontWeight: 700, color: 'var(--theme-text1)', fontVariantNumeric: 'tabular-nums',
              border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)',
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

        {(!isOnline || linkDown) && (
          <Tip text={!isOnline
            ? 'Offline — this order is saved on this device and will sync when you reconnect'
            : 'No internet — the Wi-Fi is on, but the till cannot reach the server. Orders are kept on this till and their tickets print as usual; they upload by themselves once the internet is back.'}>
            <span style={{
              fontSize: 12, fontWeight: 700, color: 'var(--theme-amber-text)',
              background: 'color-mix(in srgb, var(--theme-amber) 12%, transparent)', borderRadius: 'var(--radius-sm)',
              padding: '2px 7px', cursor: 'default',
            }}>{!isOnline ? '📵 Offline' : '📵 No internet'}</span>
          </Tip>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 8 }}>
          <Tip text="Number of guests at this table — used for cover count reporting">
            <span style={{ fontSize: 12, color: 'var(--theme-text3)', cursor: 'default' }}>Covers</span>
          </Tip>
          <button onClick={() => setCovers(c => Math.max(1, c - 1))} className="till-hit" style={btnSm} aria-label="One fewer cover">−</button>
          <span style={{ fontWeight: 700, color: 'var(--theme-text1)', minWidth: 22, textAlign: 'center', fontSize: 14 }}>{covers}</span>
          <button onClick={() => setCovers(c => c + 1)} className="till-hit" style={btnSm} aria-label="One more cover">+</button>
        </div>

        {/* The order screen's message line moved from here to directly above Send (S776): at 12px in the
            top bar's far corner, a failed send was the one thing on the screen nobody looked at. */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* S836: move, join and split. Above the order screen's own layer (1000). */}
          {orderId && (
            <RowMenu label="Table: move, join or split this bill" triggerLabel={narrowTill ? '⇄ Table' : '⇄ Table…'}
              items={tableMenuItems} zIndex={1100} busy={tableBusy} disabled={tableBusy} className="till-hit--row" />
          )}
          {orderId && isOnline && orderKotTickets.some(t => t.status === 'ready') && (() => {
            const readyCount = orderKotTickets.filter(t => t.status === 'ready').length
            return (
              <Tip text="The kitchen or bar has marked food for this order Ready. Tap once it is at the table — the ticket leaves the Kitchen Display and the floor stops showing food waiting. Only Ready tickets are marked; anything still cooking is left alone.">
                <button type="button" className="btn btn-primary btn-sm till-hit--row" onClick={markOrderServed} disabled={servingTickets}>
                  {servingTickets ? 'Marking…' : `✓ Served${readyCount > 1 ? ` (${readyCount} ready)` : ''}`}
                </button>
              </Tip>
            )
          })()}
          {orderId && (
            <Tip text={isOnline
              ? "Prints the last kitchen and/or bar ticket again, marked REPRINT — for a ticket that was sent but never came out of the printer. It does not send anything to the kitchen again."
              : 'Reprinting reads the ticket history from the server — reconnect first.'}>
              <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={reprintLastTickets} disabled={!isOnline || saving}>
                {narrowTill ? '⎙ Reprint' : '⎙ Reprint KOT/BOT'}
              </button>
            </Tip>
          )}
        </div>
      </div>

      {/* S842: amber, as a waiting guest order is everywhere else in POS (posSignals.js); it was brass here. */}
      {screenGuestReqs.length > 0 && (
        <div style={{
          flexShrink: 0, padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8,
          background: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)',
        }}>
          {screenGuestReqs.map(req => (
            <div key={req.id} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>
                {/* S839: a combo's dishes are named under the combo. */}
                🔔 Guest ordered: {guestRequestText(req.items)}
                {/* GUEST-1 (S809 3a): at full contrast, and it says where Accept puts it. */}
                {req.guest_notes && <span style={{ color: 'var(--theme-text1)', fontWeight: 600 }}> — Note for the kitchen: "{req.guest_notes}" (goes on each of their dishes)</span>}
              </span>
              <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                {/* S846: the class's own size — a 12px Accept was the smallest control on the screen
                    for the decision a guest is waiting on. */}
                <button className="btn btn-primary"
                  disabled={decidingGuestReqIds.has(req.id)}
                  onClick={() => decideGuestOrder(req, 'accepted')}>Accept</button>
                <button className="btn btn-ghost"
                  disabled={decidingGuestReqIds.has(req.id)}
                  onClick={() => decideGuestOrder(req, 'dismissed')}>Dismiss</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Two-panel body ── */}
      {/* Below 700px (narrowTill) a column: the menu over a cart sheet; with the sheet open the menu
          steps aside, so the lines get the whole height (S776). */}
      <div style={{ display: 'flex', flexDirection: narrowTill ? 'column' : 'row', flex: 1, minHeight: 0 }}>

        {/* LEFT: Menu browser */}
        <div style={{
          flex: 1, display: narrowTill && cartOpen ? 'none' : 'flex', flexDirection: 'column',
          borderRight: narrowTill ? 'none' : '1px solid var(--theme-border)', minWidth: 0, minHeight: 0,
        }}>
          <div style={{
            flexShrink: 0, padding: '8px 12px',
            borderBottom: '1px solid var(--theme-border)',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            {/* S841: which category is showing was carried by colour alone; aria-pressed says it. */}
            <div role="group" aria-label="Menu category" style={{ display: 'flex', gap: 6, overflowX: 'auto', scrollbarWidth: 'thin' }}>
              {combos.length > 0 && (
                <button key={COMBO_TAB} type="button" aria-pressed={catTab === COMBO_TAB} className={`tab-btn till-hit${catTab === COMBO_TAB ? ' tab-btn--active' : ''}`}
                  onClick={() => setCatTab(COMBO_TAB)} style={{ flexShrink: 0 }}>{COMBO_TAB_LABEL}</button>
              )}
              {menuCats.map(c => (
                <button key={c} type="button" aria-pressed={!onCombosTab && menuTab === c} className={`tab-btn till-hit${!onCombosTab && menuTab === c ? ' tab-btn--active' : ''}`}
                  onClick={() => setCatTab(c)} style={{ flexShrink: 0 }}>{c}</button>
              ))}
            </div>
            {/* It grows into the room the chips leave and never shrinks below its basis (the chips
                scroll instead): a 128px sliver on a phone was too short for a dish name. On a phone
                it is 16px, so iOS does not zoom the till on focus. */}
            <input
              type="text"
              aria-label="Search the menu by dish name or code"
              className="till-hit--row"
              placeholder="Search dishes or code…"
              value={menuSearch}
              onChange={e => setMenuSearch(e.target.value)}
              onKeyDown={onMenuSearchKey}
              enterKeyHint="enter"
              style={{
                marginLeft: 'auto', flex: `1 0 ${narrowTill ? 180 : 160}px`, maxWidth: narrowTill ? 'none' : 240,
                background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
                borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: narrowTill ? 16 : 12,
                color: 'var(--theme-text1)', outline: 'none',
              }}
            />
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {menuLoadError && (
              <p role="alert" style={{ color: 'var(--theme-red-text)', margin: '0 0 12px', fontSize: 13 }}>
                Couldn't load the menu. {menuLoadError}{menu.length > 0 ? ' Showing the last menu loaded.' : ' This is a failed read, not an empty menu.'}{' '}
                {/* force: a menu read within the minute would otherwise answer "fresh" and Retry do nothing. */}
                <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => loadMenu({ force: true })}>Retry</button>
              </p>
            )}
            {!menuLoaded && !(menuLoadError && menu.length > 0) ? (
              menuLoadError ? null : <p style={{ color: 'var(--theme-text3)', margin: 0 }}>Loading menu…</p>
            ) : onCombosTab ? (
              visCombos.length === 0
                ? <p style={{ color: 'var(--theme-text3)', margin: 0 }}>{`No combos match "${menuSearch.trim()}".`}</p>
                : <ComboTiles combos={visCombos} countOf={comboCountOf} onPick={tapCombo} />
            ) : visMenu.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', margin: 0 }}>
                {menu.length === 0
                  ? 'No POS-enabled items. Toggle items On POS in Menu Pricing first.'
                  : menuSearch.trim()
                    ? `No items match "${menuSearch.trim()}".`
                    : 'No items in this category.'}
              </p>
            ) : (
              <MenuGrid menu={menu} menuTab={menuTab} menuQuery={menuQuery} orderItems={orderItems} vatReg={vatReg}
                dishGroupsByRecipe={dishGroupsByRecipe} orderKotTickets={orderKotTickets} kotNow={kotNow} addRef={addItemRef} />
            )}
          </div>
        </div>

        {/* RIGHT: Order panel — a bottom sheet below 700px (S776) */}
        <div style={{
          width: narrowTill ? '100%' : 320, flexShrink: 0,
          // Longhands only: React warns when a re-render swaps the `flex` shorthand against flexShrink.
          flexGrow: narrowTill && cartOpen ? 1 : 0, minHeight: narrowTill && cartOpen ? 0 : undefined,
          display: 'flex', flexDirection: 'column',
          background: 'var(--theme-card)',
          ...(narrowTill ? { borderTop: '1px solid var(--theme-border)', boxShadow: '0 -6px 18px rgba(0,0,0,0.18)' } : {}),
        }}>

          {narrowTill && (() => {
            const units = orderItems.reduce((n, i) => n + (Number(i.qty) || 0), 0)
            return (
              <button type="button" className="btn btn-ghost" aria-expanded={cartOpen} aria-controls="pos-order-lines"
                onClick={() => setCartOpen(o => !o)}
                style={{ width: '100%', justifyContent: 'space-between', border: 'none', borderBottom: '1px solid var(--theme-border)', borderRadius: 0, padding: '10px 14px', fontSize: 14 }}>
                <span>{cartOpen ? '▾ Back to the menu' : `▴ Order · ${units} item${units === 1 ? '' : 's'}`}</span>
                {!cartOpen && orderItems.some(i => !i.sent_to_kot) && (
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-amber-text)' }}>not sent yet</span>
                )}
              </button>
            )
          })()}

          {/* Order items list */}
          {(!narrowTill || cartOpen) && (
          <div id="pos-order-lines" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '6px 14px' }}>
            {orderItems.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13, textAlign: 'center', paddingTop: 48, margin: 0 }}>
                {narrowTill ? 'Nothing on this order yet — tap a dish on the menu to add it' : 'Tap items on the left to add them'}
              </p>
            ) : orderItems.map((item, idx) => {
              // S839: a combo's dishes are one block, drawn where its first dish sits.
              if (isComboLine(item) && comboIdOf(item)) {
                const block = cartCombos.get(comboIdOf(item))
                if (!block || block.firstIdx !== idx) return null
                return (
                  <ComboCartBlock key={`combo:${block.id}`} block={block}
                    lineTotalOf={cartLineTotal} renderMarks={cartLineMarks} renderNote={cartNoteEditor}
                    // S862 TILL-GUEST-3: no Swap while a save is on its way; it may be sending that dish.
                    swapLabelOf={saving ? () => null : comboSwapLabel} troubleOf={comboDishTrouble}
                    onQty={setComboQty} onRemove={id => setComboQty(id, 0)} onSwap={openComboSwap} />
                )
              }
              const lineTotal = cartLineTotal(item)
              return (
                <div key={cartRowKeys[idx]} data-cart-line style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  borderBottom: '1px solid var(--theme-border)', padding: '9px 0',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, color: 'var(--theme-text1)', lineHeight: 1.3 }}>
                        {item.name}
                      </span>
                      {cartLineMarks(item)}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                    <button type="button" onClick={() => pressLineLess(idx, item.qty - 1)} className="till-hit" style={btnSm} aria-label={`One fewer ${item.name}`}>−</button>
                    <span style={{ minWidth: 22, textAlign: 'center', fontWeight: 700, color: 'var(--theme-text1)', fontSize: 13 }}>
                      {item.qty}
                    </span>
                    <button type="button" onClick={() => setQty(idx, item.qty + 1)} className="till-hit" style={btnSm} aria-label={`One more ${item.name}`}>+</button>
                  </div>
                  <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600, minWidth: 68, textAlign: 'right', flexShrink: 0 }}>
                    {fmtNpr(lineTotal)}
                  </span>
                  <button
                    type="button"
                    onClick={() => pressLineLess(idx, 0)}
                    title="Remove"
                    aria-label={`Remove ${item.name}`}
                    className="till-hit"
                    style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: 1, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >×</button>
                  </div>
                  {/* Choices line (S759): the summary and the Choices/Change button sit together under
                      the name row, for ANY unsent line whose dish has option groups — a one-tap default
                      line must still be customizable from the cart. */}
                  {(() => {
                    const lineGroups = dishGroupsByRecipe[item.recipe_id]
                    const unsent = !item.sent_to_kot && !(item.sent_qty > 0)
                    // S809 3o (CUSTOMIZATION-2): a line the next save will check (its key is not on the
                    // saved order) whose choices the menu no longer offers, or no longer fit, is marked,
                    // and keeps its Change even when the dish has no choice left to offer.
                    // S862 TILL-GUEST-2 (owner CU5 a): a SENT one too (a dish this till printed offline,
                    // put back as sent): no Change, and the mark says how to bill it as made or take it off.
                    const saved = savedItemsRef.current.has(lineKeyOf(item))
                    const trouble = menuLoaded && !saved
                      ? lineChoiceTrouble(item, lineGroups, optionMaps.optionsById, { sent: !unsent }) : null
                    // S809 4h (owner, Q3 b): a SAVED line not yet sent keeps its exemption, so a
                    // choice hidden since is a grey note that blocks nothing, not a red mark.
                    const goneNote = unsent && menuLoaded && saved
                      ? savedLineGoneNote(item, lineGroups, optionMaps.optionsById) : null
                    if (!lineGroups && !item.option_summary && !trouble && !goneNote) return null
                    const canChange = (!!lineGroups || !!trouble) && unsent
                    return (<>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.35 }}>
                          {item.option_summary || 'No choices picked'}
                        </span>
                        {canChange && (
                          <Tip text="Change this dish's choices. Once it has gone to the kitchen it can't be changed — remove it and add it again.">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm till-hit--row"
                              aria-label={`Change choices for ${item.name}`}
                              // S862 TILL-GUEST-3: not while a save is on its way; it may be sending this dish.
                              disabled={saving}
                              onClick={() => {
                                const recipe = menu.find(m => m.id === item.recipe_id)
                                if (!recipe) { setMsg('error:This dish is not on the till menu any more.'); return }
                                const initialIds = item.option_ids
                                  || (item.selection_key ? lineOptionIds(item) : defaultSelection(lineGroups))
                                setOptionPicker({ recipe, dishGroups: lineGroups || [], replaceKey: lineKeyOf(item), initialIds, lineOptions: item.options || null })
                              }}
                            >{lineOptionIds(item).length ? 'Change' : 'Choices'}</button>
                          </Tip>
                        )}
                      </div>
                      {trouble && (
                        <span style={{ fontSize: 11, color: 'var(--theme-red-text)', lineHeight: 1.35 }}>{trouble.text}</span>
                      )}
                      {goneNote && (
                        <span style={{ fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.35 }}>{goneNote}</span>
                      )}
                    </>)
                  })()}
                  {cartNoteEditor(item, idx)}
                </div>
              )
            })}
          </div>
          )}

          {/* ── ME suggestion chips ── */}
          {suggestions.length > 0 && (!narrowTill || cartOpen) && (
            <div style={{
              borderTop: '1px solid var(--theme-border)', flexShrink: 0,
              padding: '8px 14px',
              background: 'var(--theme-card)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-text2)' }}>Pair with</span>
                <button
                  onClick={() => setSuggestions([])}
                  aria-label="Hide pairing suggestions"
                  className="till-hit"
                  style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, padding: '6px 8px', marginLeft: 'auto', lineHeight: 1 }}
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
                      // S846: the touch floor and the focus pair, which these chips were the one control
                      // on the order screen without.
                      className="till-hit--row"
                      style={{
                        background: 'var(--theme-card)',
                        // PAIRED and CHEF'S PICK are categories, not verdicts: since S846 they are said by
                        // their word in ink, with a firmer border, never by the accent — and never amber,
                        // which on this screen means "unfired lines" and "a guest order waiting".
                        border: `1px solid ${r._manual || isChefsPick ? 'var(--theme-text2)' : 'var(--theme-border)'}`,
                        borderRadius: 'var(--radius-md)', padding: '5px 10px', fontSize: 12, cursor: 'pointer',
                        color: 'var(--theme-text1)', display: 'flex', flexDirection: 'column', gap: 1, textAlign: 'left',
                      }}
                    >
                      {r._manual && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-text2)', letterSpacing: 0.5 }}>PAIRED</span>
                      )}
                      {isChefsPick && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-text2)', letterSpacing: 0.5 }}>CHEF'S PICK</span>
                      )}
                      <span>{r.name}</span>
                      <span style={{ fontSize: 10, color: 'var(--theme-text1)', fontVariantNumeric: 'tabular-nums' }}>+{fmtNpr(price)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Totals + action buttons */}
          <div style={{ borderTop: narrowTill ? 'none' : '2px solid var(--theme-border)', padding: narrowTill ? '8px 14px 12px' : '12px 14px', flexShrink: 0 }}>
            {/* A folded sheet keeps only the TOTAL: the two lines above it cost a phone the menu's height. */}
            {(!narrowTill || cartOpen) && (<>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--theme-text2)', marginBottom: 4 }}>
                <span>Subtotal (ex-VAT)</span><span>{fmtNpr(subEx)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--theme-text2)', marginBottom: 10 }}>
                <span>VAT</span><span>{fmtNpr(vatAmt)}</span>
              </div>
            </>)}
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)',
              paddingTop: narrowTill && !cartOpen ? 0 : 10, borderTop: narrowTill && !cartOpen ? 'none' : '1px solid var(--theme-border)',
              marginBottom: narrowTill ? 10 : 14,
            }}>
              <span>TOTAL</span>
              {/* S846: a figure is ink; Send below is the one lit thing in this pane. */}
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNpr(total)}</span>
            </div>

            {/* S809 2a (ORDER-FLOW-1): a standing condition, not a message — it stays until a read lands. */}
            {settingsFailure && (
              <p role="alert" style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.45, color: 'var(--theme-red-text)' }}>
                {tillSettingsNotice(settingsFailure)}{' '}
                <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => loadTillSettings()} disabled={settingsReading}>
                  {settingsReading ? 'Trying…' : 'Retry'}
                </button>
              </p>
            )}

            {/* The order screen's message, directly above the button that caused it (S776). A failure is an
                ActionError; a confirmation ("Order sent!") a status line. */}
            {msg && (msg.startsWith('error:')
              ? <ActionError error={msg.slice('error:'.length)} className="action-error--till" />
              : <p style={{ margin: '0 0 10px', fontSize: 13, lineHeight: 1.45, color: 'var(--theme-green-text)' }}>{msg.replace(/^ok:/, '')}</p>)}

            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              {/* S854 (owner decision): ONE Send. Food goes to the kitchen and drinks to the bar by Ticket
                  Routing; the label says how much is new. Holding a course back is the menu beside it. */}
              {(() => {
                const sendButton = (
                  <button
                    className="btn btn-primary"
                    style={{ width: '100%', padding: '12px 0', fontSize: 16, justifyContent: 'center', display: 'flex' }}
                    onClick={saveOrder}
                    disabled={saving || orderItems.length === 0}
                    aria-keyshortcuts="Alt+S"
                  >
                    {saving ? 'Sending…' : sendLabel}
                  </button>
                )
                // On a touch screen a tap focuses Send and its tip then sat over the message line above
                // it, hiding what the send had just said (S856, found on a phone). The label already
                // says what it does there; the tip is for a mouse or keyboard.
                return coarsePointer()
                  ? <div style={{ flex: 1, minWidth: 0 }}>{sendButton}</div>
                  : <Tip text={sendTip} style={{ display: 'inline-block', flex: 1, minWidth: 0, borderBottom: 'none' }}>{sendButton}</Tip>
              })()}
              <RowMenu label="More ways to save this order" zIndex={1100} className="till-hit--row"
                disabled={saving}
                items={[unsentLines.length > 0 && {
                  key: 'hold', label: 'Save, do not send yet', onSelect: holdOrder,
                  hint: 'Keeps the new dishes on the order without a ticket, to send later with Send.',
                }]} />

              {hasPosAccess('supervisor') && (() => {
                const payDisabled = saving || !!payBlocker
                return (
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Tip text={!isOnline
                      ? 'Reconnect to close this bill — billing needs a live connection for the sequential invoice number and stock/sales posting.'
                      : 'Close this table — collect payment, or void/write-off if unpaid. Order must be saved first. Supervisor role or above.'}
                    style={{ display: 'inline-block', width: '100%', borderBottom: 'none' }}>
                    {/* Outlined, not filled (S776): Send Order and Payment were identical accent fills side
                        by side, so the eye could not tell the kitchen action from the money one. Send
                        stays the fill — it is the action every order needs; Payment is the one a
                        supervisor comes to. Since S846 the outline is plain ink too: an accent border and
                        accent text beside Send's fill was the accent spent twice in one pane. */}
                    <button
                      className="btn btn-ghost"
                      style={{
                        width: '100%', padding: '12px 0', fontSize: 16, justifyContent: 'center', display: 'flex',
                        fontWeight: 700, borderColor: 'var(--theme-text2)',
                        // The fade is the class's: `.btn:disabled` while saving, `.btn[aria-disabled]` while blocked.
                        cursor: payDisabled ? 'default' : 'pointer',
                      }}
                      onClick={pressPayment}
                      disabled={saving} aria-disabled={payBlocker ? true : undefined} aria-keyshortcuts="Alt+P">
                      Payment
                    </button>
                  </Tip>
                </div>
                )
              })()}
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
          // S842: never taller than the overlay's padded box, and `margin: auto` rather than the overlay's
          // centring, so on a landscape phone or under the guest-order bar (which pads the overlay by
          // --arrival-alert-h) the panel can no longer run off the top where no scroll reaches it.
          panelStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-lg)', width: 'min(1060px, 96vw)', maxHeight: 'min(92vh, calc(100dvh - 32px - var(--arrival-alert-h, 0px)))', margin: 'auto 0', boxShadow: '0 16px 48px rgba(0,0,0,0.4)', display: 'flex', overflow: 'hidden' }}
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
                <button type="button" className="btn btn-ghost btn-sm till-hit--row" aria-expanded={billPreviewOpen}
                  onClick={() => setBillPreviewOpen(v => !v)} style={{ marginBottom: 12 }}>
                  {billPreviewOpen ? '▾ Hide bill' : '▸ Show bill'}
                </button>
                {billPreviewOpen && billPreviewPane}
              </>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 14 }}>
              <h3 style={{ margin: 0, fontSize: 18, color: 'var(--theme-text1)' }}>
                {screenOrder?.partOf ? partBillLabel(screenTableName, null) : screenTableName}
              </h3>
              <p style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                {billingTab === 'writeoff' && compCostFailed ? '—' : fmtNpr(billingTab === 'writeoff' ? compTotal : billingTab === 'pay' ? payTotal : total)}
                {billingTab === 'writeoff' && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginLeft: 8 }}>{compCostFailed ? '(food cost could not be read — open the tab again to retry)' : compChoicesUnsaved ? '(food cost, not menu price; the slip adds the choices of a dish not saved yet)' : '(food cost, not menu price)'}</span>}
                {/* S854: one discount figure that includes the VAT it takes off, so the two numbers add up to
                    the total. The printed bill keeps its Discount line before VAT, as the tax rules want. */}
                {billingTab === 'pay' && discountAmt > 0 && (
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginLeft: 8 }}>
                    ({fmtNpr(payGross)} − {fmtNpr(payGross - payTotal)} {vatReg ? 'off, VAT included' : 'discount'})
                  </span>
                )}
              </p>
            </div>

            {unsentLines.length > 0 && (
              <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-amber-text)', background: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                ⚠ {unsentLines.length} item{unsentLines.length !== 1 ? 's' : ''} not yet sent to the kitchen/bar.
              </p>
            )}
            {/* S817 4i (S809.4 follow-up, D21): closing or voiding this bill turns away a guest QR order
                still waiting for the table (pos_orders_close_turns_away_guest_orders), so it can never
                ring on into the next party's sitting. Said here, before the press. The list already
                leaves out an order accepted into this cart: the save marks it before the close. */}
            {screenGuestReqs.length > 0 && (
              <p role="status" style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-amber-text)', background: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                ⚠ A guest QR order for this table is still waiting. Closing the bill turns it away — if they still want it, close this window and Accept it onto the bill first.
              </p>
            )}

            {/* S846: Void and Complimentary left the top of this window. They were three tabs above every
                bill, so the two rarest closes sat before the method a cashier taps on every one; they are
                now a quiet "Other ways to close" row at the foot of the payment, and their own screens
                lead back here. The close BUTTONS keep their colours (Void red, Complimentary amber). */}
            {billingTab !== 'pay' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
                <button type="button" className="btn btn-ghost btn-sm till-hit--row"
                  onClick={() => { setBillingTab('pay'); setCloseMsg('') }} disabled={closeLocked}>
                  ← Back to payment
                </button>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>
                  {billingTab === 'void' ? 'Void this bill' : 'Complimentary — the whole table, ₨0 collected'}
                </span>
              </div>
            )}

            {billingTab === 'pay' && (() => {
              const buyerRequired = requireBuyerId || requireFullInvoice
              const canVoid = isAdmin || isOwner || !!profile?.pos_allow_void
              const canComp = hasPosAccess('supervisor')
              const showLoyalty = hasFeature('loyalty') && (loyaltyBalance !== null || loyaltyLookupMsg) &&
                !deliveryPartner && !isDeliveryPartnerPhone(buyerPhone, billingSettings.delivery_partners)
              const appliedPoints = tenders.find(t => t.method === 'Loyalty')
              const spendableNow = showLoyalty && !loyaltyLookupMsg ? spendablePoints(loyaltyBalance, loyaltyHeld) : 0
              const showComp = canComp && orderItems.length > 0

              // What "Adjust this bill" already holds, said on its folded line, so nothing applied to the
              // bill is ever out of sight. When nothing is, the line names what is inside instead.
              const applied = [
                discountAmt > 0 && `Discount −${fmtNpr(discountAmt)}`,
                memberNow.kind === 'active' && `★ ${memberNow.typeName} member`,
                !buyerRequired && (buyerName.trim() || buyerPhone.trim()) && `Buyer: ${buyerName.trim() || buyerPhone.trim()}`,
                appliedPoints ? `${appliedPoints.points} pts used` : spendableNow > 0 && `${spendableNow} pts to spend`,
                hasItemComp && `${itemCompCount} comped`,
                shareCount != null && `Share slips: ${shareCount}`,
              ].filter(Boolean)
              const inside = [
                'Discount',
                outletHasCards && !deliveryPartner ? 'member card' : null,
                !buyerRequired ? 'buyer details' : null,
                showLoyalty ? 'points' : null,
                showComp ? 'comp items' : null,
                'share slips',
              ].filter(Boolean).join(', ')

              const sectionLabel = { fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }

              const buyerBlock = (
                <div style={{ marginBottom: 16 }}>
                  {buyerRequired ? (
                    <p style={sectionLabel}>
                      Buyer details <span style={{ color: 'var(--theme-red-text)', textTransform: 'none', letterSpacing: 'normal' }}>
                        <Tip text={!requireBuyerId ? FULL_INVOICE_TIP
                          : `Name and Phone are required whenever a discount is applied or the bill goes on Credit, so there's an identifiable record.${requireFullInvoice ? ` ${FULL_INVOICE_TIP}` : ''}`}>
                          {requireBuyerId && requireFullInvoice ? '(Name, Phone + Address required)'
                            : requireFullInvoice ? `(Name + Address required above ${fmtNpr(ABBREVIATED_INVOICE_LIMIT)})`
                            : payMethod === 'Credit' ? '(Name + Phone required for Credit)' : '(Name + Phone required for this discount)'}
                        </Tip>
                      </span>
                    </p>
                  ) : (
                    <p style={sectionLabel}>
                      Buyer details <Tip text={optionalBuyerTip(vatReg)}>(optional)</Tip>
                    </p>
                  )}
                  {/* S843: shown only where the outlet gives out member cards. First, because the card
                      fills the guest's phone and their member discount in. */}
                  {outletHasCards && !deliveryPartner && (
                    <div style={{ marginBottom: 8 }}>
                      <Tip text="Type a member's card number to find them: their phone goes on the bill and their card discount fills in below. Their phone number finds them too.">
                        <label htmlFor="pos-orders-member-card" style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'inline-block', marginBottom: 4 }}>Member card no.</label>
                      </Tip>
                      <input id="pos-orders-member-card" placeholder="Card no." autoComplete="off" value={memberCardStr}
                        onChange={e => setMemberCardStr(e.target.value)} disabled={tendersLocked}
                        style={disabledStyle({ ...billInput, width: '100%' }, tendersLocked)} />
                    </div>
                  )}
                  {/* S854: a class with a phone step, never an inline `1fr 1fr` (page-layout.md). A `1fr` track
                      cannot shrink below its input's own width, so at 390px PAN and Phone ran off the window. */}
                  <div className="buyer-grid">
                    {/* Placeholder text is not a label (it vanishes on the first keystroke), and a
                        red border is reinforcement, not the message — so each field carries its
                        name and the mandatory ones carry aria-invalid (S682). */}
                    <input id="pos-orders-buyer-name" placeholder="Name" aria-label="Buyer name" aria-invalid={buyerRequired && !buyerName.trim() ? true : undefined} value={buyerName} onChange={e => setBuyerName(e.target.value)}
                      style={{ ...billInput, width: '100%', borderColor: buyerRequired && !buyerName.trim() ? 'var(--theme-red)' : 'var(--theme-border)' }} />
                    <input placeholder="PAN No." aria-label="Buyer PAN number" value={buyerPan} onChange={e => setBuyerPan(e.target.value)} style={{ ...billInput, width: '100%' }} />
                    <input id="pos-orders-buyer-address" placeholder="Address" aria-label="Buyer address" aria-invalid={requireFullInvoice && !buyerAddress.trim() ? true : undefined} value={buyerAddress} onChange={e => setBuyerAddress(e.target.value)}
                      style={{ ...billInput, width: '100%', borderColor: requireFullInvoice && !buyerAddress.trim() ? 'var(--theme-red)' : 'var(--theme-border)' }} />
                    <input id="pos-orders-buyer-phone" placeholder="Phone" aria-label="Buyer phone" aria-invalid={requireBuyerId && !buyerPhone.trim() ? true : undefined} value={buyerPhone} onChange={e => setBuyerPhone(e.target.value)}
                      style={{ ...billInput, width: '100%', borderColor: requireBuyerId && !buyerPhone.trim() ? 'var(--theme-red)' : 'var(--theme-border)' }} />
                  </div>
                  <input placeholder="Remarks" aria-label="Bill remarks" value={billRemarks} onChange={e => setBillRemarks(e.target.value)} style={{ ...billInput, width: '100%' }} />
                </div>
              )

              return (<>
                {allItemsComped && (
                  <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-amber-text)', background: 'color-mix(in srgb, var(--theme-amber) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 30%, transparent)', borderRadius: 'var(--radius-sm)', padding: '8px 10px' }}>
                    ⚠ Every item is comped — nothing left to bill. Close the table with Complimentary, under Other ways to close below, instead of issuing a ₨0 Tax Invoice/PAN Bill.
                  </p>
                )}

                {/* ── 1. How the guest pays, and what they hand over. The cashier's every-bill path:
                    amount (above) → method → cash received or the QR → Confirm (the footer). One
                    `disabled` locks every method and tender control while a try at this bill is
                    unsettled (S809 CHECKOUT-7); the footer says why. */}
                <fieldset className="pay-lock" disabled={closeLocked}>
                {/* S854: a deposit the party paid at booking, offered as a Split line. VAT stays on the
                    whole bill: the deposit is a payment, never a discount. */}
                {orderDeposit && orderDeposit.balance > 0 && (() => {
                  const onBill = tenders.find(t => t.method === 'Deposit')
                  const rest = orderDeposit.balance - (onBill?.amount || 0)
                  return (
                    <div className="note-banner deposit-banner">
                      <span>
                        Deposit paid at booking: <strong>{fmtNpr(orderDeposit.balance)}</strong> ({orderDeposit.label}).
                        {onBill
                          ? ` On this bill as ${fmtNpr(onBill.amount)}.${rest > 0 ? ` The other ${fmtNpr(rest)} is refunded from Reservations after the bill.` : ''}`
                          : ' It pays part of this bill as its own payment line; VAT stays on the whole bill.'}
                      </span>
                      {!onBill && (
                        <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={addDepositTender}
                          disabled={remaining <= 0}>
                          Use {fmtNpr(Math.min(orderDeposit.balance, remaining))}
                        </button>
                      )}
                    </div>
                  )
                })()}
                {depositReadFailed && (
                  <p role="status" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text2)' }}>
                    Could not check this bill for a booking deposit, so none is offered.{' '}
                    <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => loadBillDeposit(orderId)}>Retry</button>
                  </p>
                )}
                <div className="pay-method-head">
                  <span style={{ ...sectionLabel, margin: 0 }}>{splitMode ? 'Split between methods' : 'Payment method'}</span>
                  {splitMode ? (
                    <Tip text={tenders.length > 0 ? 'Remove all the payments below first to go back to one method.' : 'Collect this bill with one payment method.'}>
                      <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => setSplitMode(false)} disabled={tenders.length > 0}>
                        Back to one method
                      </button>
                    </Tip>
                  ) : (
                    <Tip text="Collect this bill using more than one payment method — e.g. part eSewa, part cash. Not available with Credit.">
                      <button type="button" className="btn btn-ghost btn-sm till-hit--row"
                        onClick={() => { setSplitMode(true); setPayMethod('Cash'); setTenderMethod('Cash'); setTenderAmtStr(''); setDeliveryPartner('') }}>
                        Split between methods
                      </button>
                    </Tip>
                  )}
                </div>

                {!splitMode && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                    {PAYMENT_METHODS.map(m => (
                      <button key={m} onClick={() => { setPayMethod(m); setDeliveryPartner('') }}
                        aria-pressed={payMethod === m}
                        className={`pay-method-btn${payMethod === m ? ' pay-method-btn--selected' : ''}`}>
                        {m}
                      </button>
                    ))}
                    {canComp && (
                      <Tip text="Bill closes normally (counts as a sale, consumes an invoice number) but no payment is collected now — the customer owes this amount. Supervisor+ only. Collect it later, whole or in part, from Customers → Credit.">
                        <button onClick={() => setPayMethod('Credit')}
                          aria-pressed={payMethod === 'Credit'}
                          className={`pay-method-btn pay-method-btn--credit${payMethod === 'Credit' ? ' pay-method-btn--selected' : ''}`}>
                          Credit
                        </button>
                      </Tip>
                    )}
                  </div>
                )}

                {/* S843: a credit limit warns and never blocks (owner decision). */}
                {!splitMode && payMethod === 'Credit' && !deliveryPartner && (creditWarning || creditOwedMsg) && (
                  <p role="status" style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '0 0 12px', lineHeight: 1.5 }}>
                    <span aria-hidden="true">△ </span>
                    {creditWarning
                      ? `Over credit limit: ${billCustomer?.name || 'this guest'} already owes ${fmtNpr(creditWarning.before)}; this bill takes it to ${fmtNpr(creditWarning.after)}, ${fmtNpr(creditWarning.over)} over their ${fmtNpr(creditWarning.limit)} limit. You can still put it on Credit.`
                      : creditOwedMsg}
                  </p>
                )}
                {!splitMode && payMethod === 'Credit' && billingSettings.delivery_partners.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <p style={sectionLabel}>
                      <Tip text="Optional — delivery-aggregator orders don't pay at the counter, they remit later minus commission, so they close as Credit like any other unpaid balance. This just marks the buyer as the platform so Customers → Credit and the Delivery Partners report can track it separately; the actual commission is entered when the platform's payment is taken in Customers → Credit, not now." width={300}>Delivery Partner (optional)</Tip>
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {billingSettings.delivery_partners.map(dp => (
                        <button key={dp.name} type="button"
                          onClick={() => { setDeliveryPartner(dp.name); setBuyerName(dp.name); setBuyerPhone(dp.phone || '') }}
                          aria-pressed={deliveryPartner === dp.name}
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

                {!splitMode ? (
                  <>
                    {payMethod === 'Cash' && (
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-orders-tender">Cash received</label>
                          <input id="pos-orders-tender" type="number" min="0" step="any" placeholder={payTotal.toFixed(0)}
                            value={tenderedStr} onChange={e => setTenderedStr(e.target.value)} style={disabledStyle({ ...billInput, width: '100%' }, closeLocked)}
                            onKeyDown={e => { if (e.key === 'Enter' && !closing) { e.preventDefault(); pressClose('paid') } }} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <span style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>
                            {cashShortfall > 0 ? 'Short by' : 'Change'}
                          </span>
                          <div role={cashShortfall > 0 ? 'alert' : undefined}
                            style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: cashShortfall > 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
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
                        {/* S852: a shape beside the hue (the One Signal Meaning Rule): △ still to take, ✓ all taken.
                            Overpaid is neither; its ▲ line below says so, so the figure stays plain ink. */}
                        <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: remaining > 0 ? 'var(--theme-amber-text)' : tendersOverpaid ? 'var(--theme-text1)' : 'var(--theme-green-text)' }}>
                          {remaining > 0 ? <span aria-hidden="true">△ </span> : !tendersOverpaid && <span aria-hidden="true">✓ </span>}{fmtNpr(remaining)}
                        </span>
                      </div>
                      {tendersOverpaid && (
                        <p role="alert" style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--theme-red-text)' }}>
                          ▲ {fmtNpr(tendersTotal)} recorded against a bill that now comes to {fmtNpr(payTotal)}. Remove the payments below and take them again.
                        </p>
                      )}
                      {tenders.map((t, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, fontSize: 12, padding: '5px 0 0', marginTop: 5, borderTop: '1px solid var(--theme-border-lt)' }}>
                          <span style={{ color: 'var(--theme-text2)' }}>{t.method}</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: 'var(--theme-text1)' }}>{fmtNpr(t.amount)}</span>
                            <Tip text="Prints a small courtesy slip for this payment only — not the Tax Invoice/PAN Bill, which still prints once at the end.">
                              {/* S842: named, and the 44px touch floor; it was an unnamed 11px glyph about 14px wide. */}
                              <button type="button" onClick={() => printHtml(buildTenderSlipHtml({
                                  tender: t, remainingAfter: payTotal - tenders.slice(0, i + 1).reduce((s, x) => s + x.amount, 0),
                                  outletName, tableName: screenTableName,
                                }))}
                                className="btn btn-ghost btn-sm btn-icon till-hit"
                                aria-label={`Print a slip for this ${t.method} payment of ${fmtNpr(t.amount)}`}>
                                <span aria-hidden="true">🖨</span>
                              </button>
                            </Tip>
                            {/* S846: the one control that takes money back off a bill was the smallest and
                                faintest on the screen (11px underlined text, no touch floor, no focus ring).
                                S854: on every payment, not only the last. */}
                            <button type="button" onClick={() => removeTender(i)} className="btn btn-ghost btn-sm till-hit--row"
                              aria-label={`Remove the ${t.method} payment of ${fmtNpr(t.amount)}`}>
                              ✕ Remove
                            </button>
                          </span>
                        </div>
                      ))}
                    </div>

                    {remaining > 0 && (
                      <>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                          {PAYMENT_METHODS.map(m => (
                            <button key={m} onClick={() => setTenderMethod(m)}
                              aria-pressed={tenderMethod === m}
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
                              onKeyDown={e => e.key === 'Enter' && addTender()} style={disabledStyle({ ...billInput, width: '100%' }, closeLocked)} />
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
                </fieldset>

                {/* A bill that must name its buyer (a discount, Credit, or a VAT bill above the abbreviated
                    limit) shows the fields right here, open, rather than inside the fold below. */}
                {buyerRequired && buyerBlock}

                {/* ── 2. Adjust this bill (S846). Everything that changes a bill only sometimes — member
                    card, buyer, discount, points, comps, share slips — behind one fold whose folded
                    line names what is already applied. It opens itself when Confirm needs a field
                    inside it (pressClose) and when a card number finds a member. */}
                <div className="pay-adjust">
                  <button type="button" className="pay-adjust__toggle till-hit--row" aria-expanded={adjustOpen}
                    aria-controls="pos-orders-adjust" onClick={() => setAdjustOpen(v => !v)}>
                    <span className="pay-adjust__title">{adjustOpen ? '▾' : '▸'} Adjust this bill</span>
                    <span className={applied.length ? 'pay-adjust__summary' : 'pay-adjust__summary pay-adjust__summary--empty'}>
                      {applied.length ? applied.join(' · ') : inside}
                    </span>
                  </button>
                  {adjustOpen && (
                    <div id="pos-orders-adjust" className="pay-adjust__body">
                      {/* S843: what the guest's member card does on this bill, said in one line, with the
                          one move the cashier may want (take it off / put it back). */}
                      <fieldset className="pay-lock" disabled={closeLocked}>
                      {(memberNow.kind !== 'none' || billCustomerMsg) && (
                        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12, fontSize: 12 }}>
                          {billCustomerMsg ? (
                            <span style={{ color: 'var(--theme-amber-text)' }}>{billCustomerMsg}</span>
                          ) : memberNow.kind === 'active' ? (
                            <>
                              <span className="badge badge-gray" style={{ whiteSpace: 'nowrap' }}>★ {memberNow.typeName} member</span>
                              {/* S862 COMBOS-8: a bill of combos only takes no bill discount, so the
                                  card says so rather than that its discount is filled in below. */}
                              {comboOnlyBill ? (
                                <span style={{ color: 'var(--theme-text2)' }}>— combos take no bill discount.</span>
                              ) : isMembershipReason(discountReason) ? (
                                <>
                                  <span style={{ color: 'var(--theme-text2)' }}>{pctText(memberNow.pct)}% member discount filled in below.</span>
                                  {!tendersLocked && <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={removeMemberDiscount}>Take it off</button>}
                                </>
                              ) : (
                                <>
                                  <span style={{ color: 'var(--theme-text2)' }}>Member discount ({pctText(memberNow.pct)}%) is not on this bill.</span>
                                  {!tendersLocked && <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={reapplyMemberDiscount}>Give {pctText(memberNow.pct)}%</button>}
                                </>
                              )}
                            </>
                          ) : memberNow.kind === 'expired' ? (
                            <span style={{ color: 'var(--theme-amber-text)' }}>{memberNow.typeName} card expired on {formatAdAsBs(memberNow.expiresOn)}, so there is no member discount. A manager can renew it on Customers.</span>
                          ) : (
                            <span style={{ color: 'var(--theme-amber-text)' }}>{memberNow.typeName} cards are switched off, so there is no member discount.</span>
                          )}
                        </div>
                      )}
                      </fieldset>

                      {!buyerRequired && buyerBlock}

                      <fieldset className="pay-lock" disabled={closeLocked}>
                      <p style={sectionLabel}>
                        Discount <Tip text="Reduces the pre-VAT taxable amount — VAT is recalculated on the discounted base, matching standard invoice practice. Leave at 0 for no discount.">(optional)</Tip>
                      </p>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                        {/* S841: the discount type was shown by colour alone; aria-pressed and a spoken name. */}
                        <span role="group" aria-label="Discount type" style={{ display: 'flex', gap: 8 }}>
                        <button type="button" className="till-hit" aria-pressed={discountMode === 'amount'} aria-label="Discount in rupees" onClick={() => setDiscountMode('amount')} disabled={tendersLocked} style={{
                          padding: '7px 12px', borderRadius: 'var(--radius-sm)', fontSize: 13, cursor: tendersLocked ? 'not-allowed' : 'pointer', opacity: tendersLocked ? DISABLED_FADE : 1,
                          fontWeight: discountMode === 'amount' ? 700 : 400,
                          background: discountMode === 'amount' ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                          color: discountMode === 'amount' ? 'var(--theme-accent-text)' : 'var(--theme-text2)',
                          border: `1px solid ${discountMode === 'amount' ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                        }}>₨</button>
                        <button type="button" className="till-hit" aria-pressed={discountMode === 'percent'} aria-label="Discount in percent" onClick={() => setDiscountMode('percent')} disabled={tendersLocked} style={{
                          padding: '7px 12px', borderRadius: 'var(--radius-sm)', fontSize: 13, cursor: tendersLocked ? 'not-allowed' : 'pointer', opacity: tendersLocked ? DISABLED_FADE : 1,
                          fontWeight: discountMode === 'percent' ? 700 : 400,
                          background: discountMode === 'percent' ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                          color: discountMode === 'percent' ? 'var(--theme-accent-text)' : 'var(--theme-text2)',
                          border: `1px solid ${discountMode === 'percent' ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                        }}>%</button>
                        </span>
                        <input type="number" min="0" step="any" max={discountMode === 'percent' ? 100 : undefined}
                          aria-label={discountMode === 'percent' ? 'Discount percent' : 'Discount amount in rupees'}
                          placeholder="0" value={comboOnlyBill ? '' : discountStr} onChange={e => { if (!comboOnlyBill) setDiscountStr(e.target.value) }}
                          // S839: a bill of combos only has nothing a discount may touch. Read-only rather than
                          // disabled, with the sentence below tied to it, so a press says why.
                          readOnly={comboOnlyBill} aria-disabled={comboOnlyBill || undefined}
                          aria-describedby={comboOnlyBill ? 'pos-orders-discount-combo' : undefined}
                          disabled={tendersLocked} title={tendersLocked ? tendersLockHint : undefined}
                          style={disabledStyle({ ...billInput, flex: 1 }, tendersLocked || comboOnlyBill)} />
                        {discountMode === 'percent' && discountAmt > 0 && (
                          <span style={{ fontSize: 12, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>≈ {fmtNpr(discountAmt)}</span>
                        )}
                      </div>
                      {tendersLocked && (
                        <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '2px 0 8px' }}>{tendersLockHint}</p>
                      )}
                      {comboOnlyBill ? (
                        <p id="pos-orders-discount-combo" style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '2px 0 8px' }}>
                          A combo is already a deal, so a bill discount does not apply to it.
                        </p>
                      ) : payableOrderItems.some(isComboItem) && (
                        <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '2px 0 8px' }}>
                          The discount comes off the other dishes only ({fmtNpr(discountBase)} before VAT): a combo is already a deal.
                        </p>
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
                            {/* S843: a member discount's reason names the card, and is on no outlet list. */}
                            {isMembershipReason(discountReason) && !discountReasons.includes(discountReason) && (
                              <option value={discountReason}>{discountReason}</option>
                            )}
                            {discountReasons.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </div>
                      )}
                      </fieldset>

                      {/* Loyalty redemption. Rendered inside the ORDER-screen return, beside the item-comp
                          panel — PosOrders has three returns and a control placed in the floor tree sets state
                          that nothing renders (S578).

                          Deliberately NOT gated on Supervisor rank, unlike comp below it: comping is
                          discretionary and giving away stock, whereas redeeming is a customer spending
                          something they already own. The real control is server-side — redeem_loyalty_points
                          re-checks the balance and will refuse.
                          S809 2g: nor for a delivery partner's order — the partner owes the bill and neither earns
                          nor spends points (award/redeem_loyalty_points refuse it too). */}
                      {showLoyalty && (() => {
                        // S815 4g (Q19 c): points earned on an unpaid Credit bill wait for it to be settled, and
                        // redeem_loyalty_points refuses them, so the window offers only what can be spent.
                        const spendable = spendablePoints(loyaltyBalance, loyaltyHeld)
                        const cap = maxRedeemablePoints(spendable, redeemableTotal, loyaltyPointValue)
                        // CUSTOMERS-PARKING-11: what this bill earns, never a promise to a guest who will earn none.
                        const earn = earnPreview({ base: paySubEx - discountAmt, scheme: loyaltyScheme, credit: !splitMode && payMethod === 'Credit' })
                        return (
                          <div style={{
                            margin: '16px 0', padding: '10px 12px', borderRadius: 'var(--radius-sm)',
                            background: 'color-mix(in srgb, var(--theme-purple) 7%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--theme-purple) 25%, transparent)',
                          }}>
                            {loyaltyLookupMsg ? (
                              <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--theme-amber-text)' }}>{loyaltyLookupMsg}</p>
                            ) : (<>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                                <span style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                                  <Tip text="Points this customer can spend now, earned on past bills. Redeeming settles part of this bill like a gift card — it is not a discount, so the VAT on the bill does not change. Points from a Credit bill that is not paid yet can be spent once it is settled." width={300}>Loyalty points</Tip>
                                </span>
                                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-purple-text)' }}>
                                  {spendable} pt{spendable === 1 ? '' : 's'} · {fmtNpr(pointsValue(spendable, loyaltyPointValue))}
                                </span>
                              </div>
                              {loyaltyHeld > 0 && (
                                <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                                  + {loyaltyHeld} pt{loyaltyHeld === 1 ? '' : 's'} from a Credit bill not paid yet — usable once it is settled.
                                </p>
                              )}
                              {loyaltyOnOtherBills.map(b => (
                                <p key={b.orderId} style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                                  {pointsOnOtherBillText(b)}
                                </p>
                              ))}
                              {appliedPoints ? (
                                <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--theme-purple-text)' }}>
                                  {appliedPoints.points} pt{appliedPoints.points === 1 ? '' : 's'} applied ({fmtNpr(appliedPoints.amount)}) — undo it in the payment list above to change it.
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
                                  <button className="btn btn-ghost btn-sm till-hit--row" onClick={applyRedemption}
                                    disabled={closeLocked || !(Math.floor(Number(redeemStr) || 0) > 0 && Math.floor(Number(redeemStr) || 0) <= cap)}>
                                    Apply
                                  </button>
                                  <button className="btn btn-ghost btn-sm till-hit--row" onClick={() => setRedeemStr(String(cap))}>Use max</button>
                                </div>
                              ) : (
                                <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--theme-text3)' }}>
                                  {spendable > 0 ? 'Not enough to cover any of this bill yet.' : 'No points to spend yet.'}
                                </p>
                              )}
                              <p style={{ margin: '8px 0 0', fontSize: 12, color: earn.points > 0 ? 'var(--theme-purple-text)' : 'var(--theme-text2)' }}>
                                {earn.text}
                              </p>
                            </>)}
                          </div>
                        )
                      })()}

                      {showComp && (
                        <div style={{ margin: '16px 0' }}>
                          {/* Collapsed by default — a comp checkbox on every item, visible on every single
                              payment, reads as a standing suggestion to comp something. Folding it behind a
                              deliberate tap keeps it available without pushing it in front of every cashier
                              on every bill. The Tip sits around the button since S846, never inside it. */}
                          <Tip text="Comp an individual item — including just part of its quantity, e.g. 1 of 3 — it's removed from this bill and printed on its own internal Complimentary Slip instead, while the rest of the table (and the rest of that line's qty, if any) bills normally. Supervisor+ only.">
                            <button type="button" className="pay-adjust__sub till-hit--row" aria-expanded={itemsExpanded} onClick={() => setItemsExpanded(v => !v)}>
                              {itemsExpanded ? '▾' : '▸'} Comp items
                              {hasItemComp && (
                                <span style={{ color: 'var(--theme-amber-text)', fontWeight: 600, textTransform: 'none', letterSpacing: 'normal' }}>
                                  {' '}· {itemCompCount} comped
                                </span>
                              )}
                            </button>
                          </Tip>
                          {itemsExpanded && (
                          <>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, margin: '8px 0', marginBottom: hasItemComp ? 10 : 0 }}>
                            {cartRows(orderItems).map(row => {
                              // S839: a combo is ONE row, and comping n of it comps n of every one of its dishes
                              // (apply_pos_item_comps refuses part of a combo, combo_comp_whole).
                              const dishes = row.kind === 'combo' ? row.block.dishes.map(d => d.item) : [row.item]
                              const i = row.kind === 'combo'
                                ? { name: row.block.name, qty: row.block.qty, unit_price: dishes.reduce((s, d) => s + d.unit_price, 0) }
                                : row.item
                              const keys = dishes.map(lineKeyOf)
                              const lk = row.kind === 'combo' ? `combo:${row.block.id}` : keys[0]
                              const compQty = Math.min(...keys.map(k => Math.min(compQtyByLine[k] || 0, i.qty)))
                              const comped = compQty > 0
                              const setQty = next => setCompQtyByLine(prev => {
                                const out = { ...prev }
                                for (const k of keys) out[k] = Math.max(0, Math.min(i.qty, next))
                                return out
                              })
                              return (
                                <div key={lk} style={{
                                  display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '5px 8px', borderRadius: 'var(--radius-sm)',
                                  background: comped ? 'var(--theme-input-bg)' : 'transparent',
                                  color: comped ? 'var(--theme-amber-text)' : 'var(--theme-text2)',
                                  fontWeight: comped ? 600 : 400,
                                }}>
                                  <span style={{ flex: 1 }}>{i.qty} x {i.name}</span>
                                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNpr(i.qty * i.unit_price)}</span>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                    <button type="button" className="till-hit" onClick={() => setQty(compQty - 1)} disabled={compQty <= 0 || tendersLocked}
                                      aria-label={`Comp one fewer ${i.name}`}
                                      title={tendersLocked ? tendersLockHint : undefined}
                                      style={{ width: 20, height: 20, lineHeight: '18px', padding: 0, borderRadius: 0, border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)', color: 'var(--theme-text2)', cursor: compQty <= 0 || tendersLocked ? 'not-allowed' : 'pointer', opacity: compQty <= 0 || tendersLocked ? DISABLED_FADE : 1 }}>−</button>
                                    <span style={{ minWidth: 14, textAlign: 'center' }}>{compQty}</span>
                                    <button type="button" className="till-hit" onClick={() => setQty(compQty + 1)} disabled={compQty >= i.qty || tendersLocked}
                                      aria-label={`Comp one more ${i.name}`}
                                      title={tendersLocked ? tendersLockHint : undefined}
                                      style={{ width: 20, height: 20, lineHeight: '18px', padding: 0, borderRadius: 0, border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)', color: 'var(--theme-text2)', cursor: compQty >= i.qty || tendersLocked ? 'not-allowed' : 'pointer', opacity: compQty >= i.qty || tendersLocked ? DISABLED_FADE : 1 }}>+</button>
                                    <span style={{ fontSize: 10, minWidth: 44 }}>{comped ? `/${i.qty} comped` : 'comped'}</span>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                          {hasItemComp && (
                            <div>
                              <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 8px' }}>
                                {compCostFailed ? 'Food cost could not be read' : `${fmtNpr(itemCompFoodCost)} in food cost`} across {itemCompCount} comped item{itemCompCount !== 1 ? 's' : ''} — printed on a separate Complimentary Slip, not this bill.
                                {!compCostFailed && itemCompChoicesUnsaved && ' The slip adds the choices of a dish not saved yet.'}
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

                      {/* S836 (owner, 2026-10-14): an equal split is ONE tax invoice and a printed share slip per
                          guest; each share is then taken with Split between methods. Printing writes nothing. */}
                      <fieldset className="pay-lock" disabled={closeLocked}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
                        {shareCount == null ? (
                          <Tip text="Print a slip for each guest with their equal share of this bill, in whole rupees (any leftover rupee goes on the first slips). Not a tax invoice: the one tax invoice prints when the bill is paid. Take each share with Split between methods.">
                            <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => setShareCount(MIN_SHARES)} disabled={payTotal <= 0}>÷ Share slips</button>
                          </Tip>
                        ) : (
                          <>
                            <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>Share between</span>
                            <button type="button" className="btn btn-ghost till-hit" aria-label="One guest fewer" onClick={() => setShareCount(n => Math.max(MIN_SHARES, n - 1))} disabled={shareCount <= MIN_SHARES}>−</button>
                            <span style={{ minWidth: 22, textAlign: 'center', fontWeight: 700 }}>{shareCount}</span>
                            <button type="button" className="btn btn-ghost till-hit" aria-label="One guest more" onClick={() => setShareCount(n => Math.min(MAX_SHARES, n + 1))} disabled={shareCount >= MAX_SHARES}>+</button>
                            <span style={{ fontSize: 13, color: 'var(--theme-text1)' }}>{shareSummary(equalShares(payTotal, shareCount))}</span>
                            <button type="button" className="btn btn-primary btn-sm till-hit--row" onClick={printShareSlips}>Print {shareCount} slips</button>
                            <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => setShareCount(null)}>Close</button>
                          </>
                        )}
                      </div>
                      </fieldset>
                    </div>
                  )}
                </div>

                {/* ── 3. The two closes that are not a payment, last and quiet. */}
                {(canVoid || canComp) && (
                  <div className="pay-other-ways">
                    <span>Other ways to close</span>
                    {canComp && (
                      <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={openCompTab} disabled={closeLocked}>Complimentary</button>
                    )}
                    {canVoid && (
                      <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => { setBillingTab('void'); setCloseMsg('') }} disabled={closeLocked}>Void the bill</button>
                    )}
                  </div>
                )}
              </>)
            })()}

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
                  Complimentary Slip valued at food cost — not a Tax Invoice or PAN Bill.
                </p>
              </>
            )}
          </div>

          {/* Sticky footer — primary action + Cancel always reachable, independent of how tall the
              scrollable content above gets (e.g. a long list of split-payment tenders). */}
          <div style={{ flexShrink: 0, padding: narrowBilling ? '12px 16px 16px' : '14px 28px 20px', borderTop: '1px solid var(--theme-border)' }}>
            {/* warn: is a caution the cashier must act on (payments kept from a refused try, S809 CHECKOUT-15). */}
            {closeMsg && <p role="alert" style={{ margin: '0 0 10px', fontSize: 12, color: closeMsg.startsWith('error:') ? 'var(--theme-red-text)' : closeMsg.startsWith('warn:') ? 'var(--theme-amber-text)' : 'var(--theme-green-text)' }}>{closeMsg.replace(/^(error|ok|warn):/, '')}</p>}
            {closeLocked && !closing && <p role="status" style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--theme-amber-text)' }}>{closeLockText}</p>}
            {/* aria-disabled, not disabled, for everything but an in-flight close (S776): see pressClose. */}
            {billingTab === 'pay' && (() => {
              const blocker = closeBlocker('paid')
              return (
                <button className="btn btn-primary" style={{ width: '100%', padding: '11px 0', justifyContent: 'center' }}
                  onClick={() => pressClose('paid')}
                  disabled={closing} aria-disabled={!closing && blocker ? true : undefined}>
                  {closing ? (closeStep || 'Processing…')
                    : tendersOverpaid ? `Payments exceed the bill by ${fmtNpr(tendersTotal - payTotal)} — undo and re-take`
                    : splitMode && remaining > 0 ? `Remaining ${fmtNpr(remaining)}`
                    : cashShortfall > 0 ? `Short by ${fmtNpr(cashShortfall)} — collect ${fmtNpr(payTotal)}`
                    : blocker?.label ? blocker.label
                    : splitMode ? `Complete Order — ${fmtNpr(payTotal)}`
                    : `Confirm Payment — ${fmtNpr(payTotal)}`}
                </button>
              )
            })()}
            {billingTab === 'void' && (
              <button className="btn btn-danger btn-danger--strong" style={{ width: '100%', padding: '11px 0', justifyContent: 'center' }}
                onClick={() => pressClose('void')} disabled={closing} aria-disabled={!closing && !closeReason ? true : undefined}>
                {closing ? (closeStep || 'Processing…') : closeReason ? 'Void Order' : 'Choose a reason to void'}
              </button>
            )}
            {billingTab === 'writeoff' && (
              <button className="btn amber-action-btn" style={{ width: '100%', padding: '11px 0', justifyContent: 'center' }}
                onClick={() => pressClose('writeoff')} disabled={closing} aria-disabled={!closing && closeBlocker('writeoff') ? true : undefined}>
                {closing ? (closeStep || 'Processing…') : closeBlocker('writeoff')?.label || 'Mark Complimentary (₨0 collected)'}
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

      {/* Crest Customization choice window (S758). In the ORDER return — addItem and the cart's Change
          button both live on this screen (the S578 two-returns rule). */}
      {optionPicker && (
        <OptionPickerModal
          recipe={optionPicker.recipe}
          dishGroups={optionPicker.dishGroups}
          catalog={optionMaps}
          vatRate={vatReg ? vatOf(optionPicker.recipe) : 0}
          initialIds={optionPicker.initialIds}
          initialQty={optionPicker.replaceKey != null ? orderItems.find(i => lineKeyOf(i) === optionPicker.replaceKey)?.qty : undefined}
          lastIds={lastPicksRef.current[optionPicker.recipe.id] || null}
          lineOptions={optionPicker.lineOptions || null}
          confirmLabel={optionPicker.replaceKey != null ? 'Update dish' : 'Add to order'}
          onClose={() => setOptionPicker(null)}
          onConfirm={(ids, qty) => {
            addCustomLine(optionPicker.recipe, ids, optionPicker.replaceKey ?? null, qty)
            setOptionPicker(null)
          }}
        />
      )}
      {/* S839: a combo's picks, or a Swap of one of its dishes. In the order screen's return, beside the
          choice window, because the menu tile and the cart that open it are here (S578). */}
      {comboPicker && (
        <ComboPickerModal
          combo={comboPicker.combo}
          recipeOf={comboRecipeOf}
          vatReg={vatReg}
          dishGroupsOf={rid => dishGroupsByRecipe[rid]}
          catalog={optionMaps}
          initialPicks={comboPicker.initialPicks || null}
          onlyGroupId={comboPicker.swap?.groupId || null}
          showQty={!comboPicker.swap}
          confirmLabel={comboPicker.swap ? 'Swap dish' : 'Add to order'}
          onClose={() => setComboPicker(null)}
          onConfirm={({ picks, qty }) => {
            const { combo, swap } = comboPicker
            setComboPicker(null)
            if (swap) confirmComboSwap(combo, swap, picks)
            else addComboToCart(combo, picks, qty)
          }}
        />
      )}

      {/* Pulling an already-fired line. Not a ConfirmModal: this asks for an input, and the input
          is the entire point — a yes/no dialog would add friction and record nothing. */}
      {/* S836: the Table menu's dialogs. In THIS return because the menu is on the order screen (S578). */}
      {tableDialog === 'move' && (
        <MoveTableModal
          tables={tables} tableOrders={tableOrders} tableJoins={tableJoins}
          currentTableId={activeTable?.id || null} currentOrderId={orderId} busy={tableBusy}
          onMove={moveBillToTable}
          onJoin={(t, { hasBill }) => { if (hasBill) { setTableDialog(null); askJoinBill(t) } else joinTableToBill(t) }}
          onClose={() => setTableDialog(null)}
        />
      )}
      {(tableDialog === 'dishes' || tableDialog === 'part') && (
        <MoveDishesModal
          mode={tableDialog} lines={tableDialogLines}
          tables={tables} tableOrders={tableOrders} tableJoins={tableJoins}
          currentTableId={activeTable?.id || null} currentOrderId={orderId} covers={covers}
          lineTotal={(l, q) => (l.combo_dishes || [l]).reduce((s, d) => s + q * (Number(d.unit_price) || 0) * (1 + (vatReg ? (d.vat_rate ?? 0) : 0)), 0)}
          busy={tableBusy}
          // A combo row's pick moves every one of its dishes at that quantity (pos_move_lines refuses part
          // of a combo, combo_move_whole).
          onSubmit={args => (tableDialog === 'part' ? makePartBill : moveDishesToTable)({ ...args, picks: expandComboPicks(args.picks, tableDialogLines) })}
          onClose={() => setTableDialog(null)}
        />
      )}
      {pullPrompt && (
        <Modal onClose={() => setPullPrompt(null)} title="Remove an item the kitchen already has" maxWidth={440}>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 14px', lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--theme-text1)' }}>{pullPrompt.pulled} × {pullPrompt.name}</strong>{' '}
            {pullPrompt.pulled === 1 ? 'has' : 'have'} already been sent to the kitchen or bar. Taking{' '}
            {pullPrompt.pulled === 1 ? 'it' : 'them'} off this bill is recorded against your login with the
            reason you give here, and shows on POS Reports → KOT Log → Pulled Items.
            {pullPrompt.swap && ` ${pullPrompt.swap.newLine.name} takes its place in the combo and goes on the next ticket.`}
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
                // S839: a combo's quantity moves every dish; a swap replaces one dish of a combo.
                if (pullPrompt.combo) applyComboQty(pullPrompt.combo.lineId, pullPrompt.combo.qty)
                else if (pullPrompt.swap) setOrderItems(prev => swapComboDish(prev, pullPrompt.swap.lineId, pullPrompt.swap.groupId, pullPrompt.swap.newLine))
                else applyQty(pullPrompt.idx, pullPrompt.qty)
                setPullPrompt(null)
                setMsg('ok:Removed — save the order to record it.')
              }}
            >
              Remove it
            </button>
          </div>
        </Modal>
      )}
      {/* S854: the ← ask over unsaved changes — Send and go back, Leave without saving, Stay. In THIS
          return because requestBackToFloor runs on the order screen (S578); zIndex above the order
          screen's own fixed layer at 1000. */}
      {leavePrompt && (
        <Modal
          title={`${leavePrompt.n} unsaved change${leavePrompt.n === 1 ? '' : 's'} on this order`}
          onClose={() => setLeavePrompt(null)}
          maxWidth={460}
          zIndex={1200}
        >
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            {leavePrompt.n === 1 ? 'One line on this order has' : `${leavePrompt.n} lines on this order have`} changed since it was last saved.
            <strong> Send and go back</strong> saves the order and sends what is new to the kitchen and bar, as Send does.
            <strong> Leave without saving</strong> drops {leavePrompt.n === 1 ? 'that change' : 'those changes'}: nothing reaches the kitchen, the bar or the bill.
          </p>
          <div className="leave-prompt-actions">
            <button type="button" className="btn btn-ghost till-hit--row" onClick={() => setLeavePrompt(null)}>Stay</button>
            <button type="button" className="btn btn-danger till-hit--row" onClick={() => { setLeavePrompt(null); backToFloor() }}>Leave without saving</button>
            <button type="button" className="btn btn-primary till-hit--row" onClick={sendAndGoBack}>Send and go back</button>
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
        <Modal title={closedElsewhereBy ? 'This bill was already closed' : 'This bill was already closed on another device'} onClose={acknowledgeClosedElsewhere} maxWidth={420} zIndex={1300}>
          <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            {closedElsewhereBy
              ? `${closedElsewhere} was closed by ${closedElsewhereBy}'s earlier try on this tablet, so nothing more can be added to it and nothing on this screen was saved to it. Reprint it from Recent Bills if the guest needs the bill.`
              : `${closedElsewhere} was billed or voided on another till, so nothing more can be added to it and nothing on this screen was saved to it.`}
            {' '}The floor shows the table as it is now — open it again to start a new order.
          </p>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-primary" onClick={acknowledgeClosedElsewhere}>Back to the floor</button>
          </div>
        </Modal>
      )}
      {/* The order-screen asks (discard recorded payments, discard unsaved items — S754). Rendered
          here, not only in the floor return: their handlers run on this screen (S578). */}
      {confirmEl}
      {printAlertsEl}
      {tillNoticeEl}
    </div>
  )

  /* ══════════════════════════════════════════ FLOOR VIEW */

  // The floor notices that fold behind one summary line when two or more stand at once (S852), each as
  // the line names it: the ones the cashier must act on first (an order not applied, an upload the
  // server keeps refusing, a write that did not save, points that did not land), then the ones that
  // only report. Each condition is its banner's own render condition below.
  const imsWaitingBills = Math.max(unpostedCount, imsMisses.length)
  const countOf = (n, one, many) => `${n} ${n === 1 ? one : many}`
  const floorNotices = [
    conflictOrders.length > 0 && countOf(conflictOrders.length, 'offline order not applied', 'offline orders not applied'),
    isOnline && !linkDown && uploadTrouble.length > 0 && countOf(uploadTrouble.length, 'upload problem', 'upload problems'),
    writeWarnings.length > 0 && countOf(writeWarnings.length, 'thing did not save', 'things did not save'),
    loyaltyNote && !loyaltyNote.ok && '1 loyalty points problem',
    canSeeImsPosting && (imsWaitingBills > 0 || unpostedNotes > 0) && `${countPhrase(imsWaitingBills, unpostedNotes)} not in Inventory yet`,
    !syncingOffline && isOnline && !linkDown && waitingUploads > 0 && countOf(waitingUploads, 'order change waiting to upload', 'order changes waiting to upload'),
    syncingOffline && !linkDown && `${countOf(pendingOrderIds.size, 'order', 'orders')} syncing`,
    foreignQueued > 0 && countOf(foreignQueued, 'offline order for another outlet', 'offline orders for another outlet'),
    loyaltyNote?.ok && '1 points note',
  ].filter(Boolean)
  // Down to one, the fold has nothing to hide, so the next pile-up starts folded again. Set during
  // render on purpose (React re-renders at once, before anything is drawn): it flips only then.
  if (floorNoticesOpen && floorNotices.length < 2) setFloorNoticesOpen(false)
  const noticesFolded = floorNotices.length >= 2 && !floorNoticesOpen
  // The summary takes the loudest colour it stands for: red while an offline order was not applied.
  const noticeTone = conflictOrders.length > 0 ? 'red' : 'amber'

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
                  <button key={d} className="till-hit" onClick={() => numpadPress(String(d))} style={pad}>{d}</button>
                ))}
                {/* S846: till-hit gives each key the focus pair; the 72x52 box is already over the floor. */}
                <button className="till-hit" onClick={numpadClear} aria-label="Clear" style={{ ...pad, color: 'var(--theme-red-text)', fontSize: 14, fontWeight: 700 }}>CLR</button>
                <button className="till-hit" onClick={() => numpadPress('0')} style={pad}>0</button>
                <button className="till-hit" onClick={numpadBackspace} aria-label="Backspace" style={{ ...pad, fontSize: 18 }}>⌫</button>
              </div>
            )
          })()}

          <button
            className="btn btn-primary"
            style={{ width: '100%', padding: '12px 0', fontSize: 15, marginBottom: 10, justifyContent: 'center' }}
            onClick={confirmCovers}
            ref={coversConfirmRef}
          >
            Open Order
          </button>
          <button
            className="btn btn-ghost"
            style={{ width: '100%', padding: '12px 0', fontSize: 15, justifyContent: 'center' }}
            onClick={() => { setCoversModal(false); setPendingTable(null) }}
          >
            Cancel
          </button>
        </div>
      </Modal>
    )}

    {/* ── The walk-in waitlist (S854). In the FLOOR return, beside its button. Seat closes it and arms
           the party for the next free table tapped, as a seat from Reservations is armed. ── */}
    {waitlistOpen && (
      <WaitlistPanel
        waitlist={waitlist}
        outletName={outletName}
        onClose={() => setWaitlistOpen(false)}
        onSeat={entry => {
          setWaitlistOpen(false)
          seatReservationRef.current = {
            kind: 'waitlist', id: entry.id, customer_name: entry.customer_name,
            phone: entry.phone || '', party_size: entry.party_size,
          }
          setFloorMsg(`ok:Tap a free table to seat ${entry.customer_name} ×${entry.party_size}.`)
        }}
      />
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
                  onClick={openRecentBills}
                  className="btn btn-ghost"
                  style={{ fontSize: 13, flexShrink: 0 }}
                >📄 Recent Bills</button>
              </Tip>
            )}
            {/* S854 (owner decision): the walk-in waitlist lives on the floor. */}
            <Tip text="Parties waiting for a table: who, how many, and how long you told them. Add one when every table is full; WhatsApp or call them when a table frees up, then Seat them.">
              <button className="btn btn-ghost" onClick={() => setWaitlistOpen(true)} style={{ fontSize: 13, flexShrink: 0 }}
                aria-label={`Waitlist, ${waitlist.liveCount} waiting`}>
                Waitlist ({waitlist.liveCount})
              </button>
            </Tip>
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

      {/* Today's bookings — a quiet strip, not an alarm: grey chips, amber only for a party
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
          <button type="button" className="btn btn-ghost btn-sm till-hit--row" style={{ marginLeft: 'auto' }} onClick={() => navigate('/pos/reservations')}>Reservations →</button>
        </div>
      )}

      {/* S847: guest orders are read beside the floor now, so on a first load they can land first;
          the banner waits for the tables it names rather than reading "— ?" with Review dead. */}
      {Object.keys(pendingGuestOrders).length > 0 && !(floorLoad && tables.length === 0) && (() => {
        const total = Object.values(pendingGuestOrders).reduce((s, arr) => s + arr.length, 0)
        const tableNames = Object.keys(pendingGuestOrders).map(tid => tables.find(t => t.id === tid)?.name || '?')
        const firstTable = tables.find(t => t.id === Object.keys(pendingGuestOrders)[0])
        return (
          // S842: amber, as a waiting guest order is on the tile, the strip and the glow (posSignals.js):
          // it was brass here, the one place the same event wore the accent. The whole banner still takes
          // a tap; "Review" is the real button a keyboard and a screen reader reach (it was a div).
          <div
            className="guest-order-banner"
            onClick={() => firstTable && openOnce(firstTable.id, () => openTable(firstTable))}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', flexWrap: 'wrap',
              background: 'color-mix(in srgb, var(--theme-amber) 12%, transparent)', border: '1px solid var(--theme-amber)',
              borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 14, fontWeight: 700,
              color: 'var(--theme-amber-text)',
            }}
          >
            <span aria-hidden="true" style={{ fontSize: 18 }}>🔔</span>
            <span>{total} new guest order{total !== 1 ? 's' : ''} — {tableNames.join(', ')}</span>
            <button type="button" className="btn btn-primary btn-sm till-hit--row" style={{ marginLeft: 'auto' }}
              disabled={!firstTable}
              onClick={e => { e.stopPropagation(); if (firstTable) openOnce(firstTable.id, () => openTable(firstTable)) }}>
              Review {firstTable?.name || 'the order'} →
            </button>
            {/* S809 3c: the app-wide alert keeps sounding here until someone answers; its banner stands
                aside for this one, so its Mute is here. Mute keeps this banner up (S763). */}
            <button type="button" className="btn btn-ghost btn-sm till-hit--row" disabled={guestAlertMute.muted}
              onClick={e => { e.stopPropagation(); guestAlertMute.mute() }}>
              {guestAlertMute.muted ? 'Muted' : 'Mute 5 min'}
            </button>
          </div>
        )
      })()}

      {(!isOnline || linkDown) && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--theme-amber-text)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>📵</span>
            {!isOnline
              ? <span><strong>Offline</strong> — orders are saved on this device and will sync when you reconnect. Billing stays disabled until then.</span>
              : <span><strong>No internet</strong> — the Wi-Fi is on, but the till cannot reach the server. Orders and their tickets work as usual and are kept on this till until the internet is back; bills wait until then.</span>}
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
      {floorMsg && (
        <div role={floorMsg.startsWith('error:') ? 'alert' : 'status'} style={{
          background: floorMsg.startsWith('error:') ? 'color-mix(in srgb, var(--theme-red) 8%, transparent)' : 'color-mix(in srgb, var(--theme-green) 8%, transparent)',
          border: `1px solid ${floorMsg.startsWith('error:') ? 'color-mix(in srgb, var(--theme-red) 25%, transparent)' : 'color-mix(in srgb, var(--theme-green) 25%, transparent)'}`,
          borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13,
          color: floorMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)',
        }}>
          {floorMsg.replace(/^(error|ok):/, '')}
        </div>
      )}
      {/* S852: after an outage the notices below can all stand at once, and on a tablet they pushed the
          tables below the fold. Two or more fold behind this one line, which names each of them (the
          ones a cashier must act on first, so none is hidden silently); one shows as it always did.
          The bookings strip, a guest order, the offline banner and floorMsg (the answer to the tap
          just made) stay outside the fold. */}
      {floorNotices.length >= 2 && (
        <div style={{
          background: `color-mix(in srgb, var(--theme-${noticeTone}) 8%, transparent)`,
          border: `1px solid color-mix(in srgb, var(--theme-${noticeTone}) 28%, transparent)`,
          borderRadius: 'var(--radius-sm)', padding: '10px 16px', marginBottom: 16, fontSize: 13,
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, color: `var(--theme-${noticeTone}-text)`,
        }}>
          <span role="status" style={{ flex: '1 1 240px', minWidth: 0 }}>
            <strong>⚠ {floorNotices.length} notices:</strong> {floorNotices.join(', ')}
          </span>
          <button type="button" className="btn btn-ghost btn-sm till-hit--row" style={{ marginLeft: 'auto', flexShrink: 0 }}
            aria-expanded={!noticesFolded} aria-controls="pos-floor-notices"
            onClick={() => setFloorNoticesOpen(!floorNoticesOpen)}>
            {noticesFolded ? 'Show all' : 'Hide'}
          </button>
        </div>
      )}
      <div id="pos-floor-notices" hidden={noticesFolded}>
        {syncingOffline && !linkDown && (
          <div style={{ background: 'color-mix(in srgb, var(--theme-green) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-green-text)' }}>
            ⟳ Syncing {pendingOrderIds.size} {pendingOrderIds.size === 1 ? 'order' : 'orders'}…
          </div>
        )}
        {/* S809 3f: kept on this till while the browser says online — the internet was down, or an upload
            has yet to run. The upload retries by itself every 15 s; the button is for not waiting. */}
        {!syncingOffline && isOnline && !linkDown && waitingUploads > 0 && (
          <div role="status" style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-amber-text)' }}>
            <span>{waitingUploads} {waitingUploads === 1 ? 'order change is' : 'order changes are'} kept on this till and not uploaded yet — they upload by themselves.</span>
            <Tip text="Sends the orders and kitchen tickets this till kept while the internet was down to the server now, instead of waiting for the next automatic try.">
              <button type="button" className="btn btn-ghost btn-sm till-hit--row" style={{ marginLeft: 'auto', flexShrink: 0 }}
                onClick={() => flushPosOrderQueue()}>Upload now</button>
            </Tip>
          </div>
        )}
        {/* S833 (B3): an entry kept try after try for a reason other than the connection says why. */}
        {isOnline && !linkDown && uploadTrouble.length > 0 && (
          <div role="alert" style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '10px 16px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: 'var(--theme-amber-text)' }}>
            {uploadTrouble.map(t => <span key={t.orderId}>⚠ {uploadTroubleText(t)}</span>)}
          </div>
        )}
        {/* ORDER-FLOW-15: another outlet's offline orders on this device are left for that outlet. */}
        {foreignQueued > 0 && (
          <div role="status" style={{ marginBottom: 16, fontSize: 13, color: 'var(--theme-text2)' }}>
            {foreignQueued} offline {foreignQueued === 1 ? 'order' : 'orders'} on this device {foreignQueued === 1 ? 'was' : 'were'} taken for another outlet — {foreignQueued === 1 ? 'it uploads' : 'they upload'} when that outlet is open here.
          </div>
        )}
        {writeWarningsBanner}
        {/* Bills whose revenue and stock never reached Inventory, because no BS period was open
            for their date. The sale itself is fine and the bill is valid — but IMS has no record of
            it, so MonthlySummary, Variance and stock levels are all short until it is backfilled.
            Silently correct-looking was the worst available option here. */}
        {loyaltyNoteBanner}

        {/* Waiting till bills and credit notes (S809 3j, owner decision Q12 c) are for whoever can post
            them: the Owner, the operator and a POS manager. The banner posts the open month's itself,
            because Periods does not open for a POS manager, and says who posts the rest. An outlet
            without Inventory has none (S809 4e, D6). This till's own misses show at once; the floor
            load that follows a post prunes them against the database's count. */}
        {canSeeImsPosting && (
          <PosImsPostingBanner
            bills={Math.max(unpostedCount, imsMisses.length)}
            notes={unpostedNotes}
            onPosted={() => { loadFloor({ quiet: true }) }}
          />
        )}
        {/* One box for every offline order the server would not take (S852): one heading, then each
            order with its own recovery, rather than a red box per order stacked over the floor. */}
        {conflictOrders.length > 0 && (
          <div style={{ background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 30%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-red-text)' }}>
            <strong>⚠ {conflictOrders.length === 1 ? '1 offline order was not applied' : `${conflictOrders.length} offline orders were not applied`}</strong>
            {conflictOrders.map(c => (
              <div key={c.order_id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 8, paddingTop: 8, borderTop: '1px solid color-mix(in srgb, var(--theme-red) 20%, transparent)' }}>
                <span style={{ flex: '1 1 240px', minWidth: 0 }}>
                  {/* Why the server refused the replay (S754) — each needs different words, the same recovery.
                      S840: dishes another tablet had sent too are not a refusal — the order holds them — so that
                      notice says only what staff must check (owner decision 2026-10-15, "Ask staff to check"). */}
                  {c.reason === 'sent_elsewhere' ? (
                    <><strong>{c.table_name || 'An order'}</strong>: {SENT_ELSEWHERE_TEXT}</>
                  ) : (<>
                    {c.reason === 'stale' ? (
                      <><strong>{c.table_name}</strong>'s order was changed on another device while you were offline — </>
                    ) : c.reason === 'table_taken' ? (
                      <><strong>{c.table_name}</strong> was opened on another device while you were offline — </>
                    ) : c.reason === 'off_menu' ? (
                      // S862 TILL-GUEST-2: a hidden choice on a dish lands here too, not only a dish gone.
                      <><strong>{c.table_name}</strong>: a dish in your offline order, or one of its choices, is no longer offered — </>
                    ) : c.reason === 'refused' ? (
                      <><strong>{c.table_name}</strong>: the server would not take your offline changes{c.refusal ? ` (${c.refusal})` : ''} — </>
                    ) : (
                      <><strong>{c.table_name}</strong>'s bill was closed on another device while you were offline — </>
                    )}
                    your queued changes ({c.items.length} item{c.items.length !== 1 ? 's' : ''}) were NOT applied.
                  </>)}
                  {/* S809 ORDER-FLOW-8: those tickets did print, so Discard is not "nothing happened". */}
                  {conflictPrintedNote(c)}
                </span>
                {/* S754: recover the lines rather than only throw them away. */}
                <Tip text="Puts these items back onto the order this table (or takeaway) has open now — only what that order does not already carry — or onto a new order if it has none. Back onto the same order, dishes this till already printed come back as already sent, so they do not print again; onto any other order they come back unsent, named in the message. This notice goes away once that order is saved.">
                  <button className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 12, flexShrink: 0 }}
                    disabled={!isOnline}
                    onClick={() => startOrderFromConflict(c)}>Start new order with these</button>
                </Tip>
                <button className="btn btn-ghost" style={{ fontSize: 12, color: 'var(--theme-red-text)', flexShrink: 0 }}
                  onClick={() => discardConflictOrder(c.order_id)}>Discard</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {sections.length > 1 && (
        <div className="tab-bar" role="group" aria-label="Floor section" style={{ marginBottom: 20 }}>
          {/* S841: the section showing was carried by colour alone; aria-pressed says it. */}
          {sections.map(s => (
            <button key={s} type="button" aria-pressed={secFilter === s} className={`tab-btn till-hit--row${secFilter === s ? ' tab-btn--active' : ''}`}
              onClick={() => setSecFilter(s)}>{s}</button>
          ))}
        </div>
      )}

      {/* S754: a failed floor read keeps the last good floor below and says so here. It is a line,
          not a till notice: the 15 s poll would re-raise it every time the network blinked. */}
      {floorLoadError && (
        <p role="alert" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-red-text)' }}>
          Couldn't refresh the floor. {floorLoadError}{tables.length > 0 ? ' Tables below are as last loaded and may be out of date.' : ''}{' '}
          <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => loadFloor()}>Retry</button>
        </p>
      )}
      {/* S809 2a (ORDER-FLOW-1): a line like the one above, for the same reason — the till retries on its own. */}
      {settingsFailure && (
        <p role="alert" style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-red-text)' }}>
          {tillSettingsNotice(settingsFailure)}{' '}
          <button type="button" className="btn btn-ghost btn-sm till-hit--row" onClick={() => loadTillSettings()} disabled={settingsReading}>
            {settingsReading ? 'Trying…' : 'Retry'}
          </button>
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
              const label = takeawayCardLabel(t)
              return (
                <div
                  key={t.orderId}
                  className="card floor-tile"
                  data-takeaway-tile={t.orderId}
                  style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}
                >
                  <div style={{
                    margin: '-16px -18px 2px', height: 6, flexShrink: 0,
                    background: tableStripColor({ status: 'occupied', order: t, kotStatus: kot, guestPending: false }),
                  }} />
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                    {/* S846: the tile's ONE control. Its ::after covers the card, so a tap anywhere opens
                        the order and the tile is one tab stop; the chips beside it are read with it. */}
                    <button
                      type="button"
                      className="floor-tile__open"
                      aria-label={`${label}, ${t.itemCount} item${t.itemCount !== 1 ? 's' : ''}, ${fmtNpr(t.total)}`}
                      aria-describedby={`takeaway-facts-${t.orderId}`}
                      aria-busy={openingId === t.orderId || undefined}
                      onClick={() => openOnce(t.orderId, () => openOrderById(t.orderId))}
                    >{label}</button>
                    <div id={`takeaway-facts-${t.orderId}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                      {kotChip && (
                        <span className={kotChip.className} style={{ fontSize: 10 }}>{kotChip.label}</span>
                      )}
                      {unsettledCloses.some(a => a.orderId === t.orderId) && unsettledCloseChip}
                      {t.offlinePending && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: amberBadgeText, background: 'var(--theme-amber)', borderRadius: 0, padding: '1px 6px', whiteSpace: 'nowrap' }}>📵 Not synced</span>
                      )}
                      {t.pending > 0 && (
                        <span style={{ fontSize: 10, fontWeight: 700, color: amberBadgeText, background: 'var(--theme-amber)', borderRadius: 0, padding: '1px 6px', whiteSpace: 'nowrap' }}>⚠ {t.pending} not sent</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                      {t.itemCount} item{t.itemCount !== 1 ? 's' : ''}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontVariantNumeric: 'tabular-nums', marginTop: 3 }}>
                      {fmtNpr(t.total)}
                    </div>
                    {openingId === t.orderId && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', marginTop: 3 }}>Opening…</div>}
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
          <a href="/pos/tables" style={{ color: 'var(--theme-accent-ink)' }}>Go to POS Setup →</a>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
          {visTables.map(t => {
            const ord      = tableOrders[t.id]
            const inactive = t.status === 'inactive'
            const hasPendingGuest = pendingGuestOrders[t.id]?.length > 0
            // S836: joined to another table's bill — taken, with no bill of its own; a tap opens that bill.
            const joinedTo   = tableJoins[t.id] || null
            const joinedMain = joinedTo ? tables.find(x => x.id === mainTableOfJoin(joinedTo, tableOrders)) : null
            // S817 4i (FLOOR-KITCHEN-7): a table taken out of service with its bill still open opens that
            // bill; one with no bill says why it takes no order, instead of ignoring the tap.
            const openTile = () => (inactive && !ord && !joinedTo ? setFloorMsg(`error:${inactiveTableText(t.name)}`) : openOnce(t.id, () => openTable(t)))
            const opening = openingId === t.id
            return (
              <div
                key={t.id}
                data-table-tile={t.id}
                className={`card floor-tile${hasPendingGuest ? ' guest-order-glow' : ''}`}
                style={{
                  padding: '16px 18px',
                  // Muted by a dashed edge and the badge, not opacity (S776): 0.4 took the name and
                  // seat count below AA, so an inactive table was also an unreadable one.
                  ...(inactive ? { borderStyle: 'dashed', background: 'transparent' } : {}),
                  display: 'flex', flexDirection: 'column', gap: 8,
                  overflow: 'hidden',
                  // S846: no accent border for a taken table. The status badge says Occupied in words and
                  // the strip carries what needs a waiter; a lit edge on every full table was the accent
                  // spent on the outcome everyone wants.
                }}
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
                  {/* S846: the tile's ONE control (the S653 rule: a card holding controls takes no
                      role="button"). Its ::after covers the card, so a tap anywhere opens the table and
                      the tile is one tab stop; every chip below is plain text read with it. */}
                  <button
                    type="button"
                    className="floor-tile__open"
                    style={inactive && !ord && !joinedTo ? { cursor: 'default' } : undefined}
                    aria-describedby={`table-facts-${t.id} table-more-${t.id}`}
                    aria-busy={opening || undefined}
                    onClick={openTile}
                  >{t.name}</button>
                  <div id={`table-facts-${t.id}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                    <span className={STATUS_BADGE[t.status] || 'badge-gray'} style={{ fontSize: 10 }}>
                      {STATUS_LABEL[t.status] || t.status}
                    </span>
                    {unsettledCloses.some(a => a.tableId === t.id) && unsettledCloseChip}
                    {ord && ticketSummaryChip(kotStatusByTable[t.id]) && (() => {
                      const chip = ticketSummaryChip(kotStatusByTable[t.id])
                      return <span className={chip.className} style={{ fontSize: 10 }}>{chip.label}</span>
                    })()}
                    {pendingGuestOrders[t.id]?.length > 0 && (
                      <span className="badge-amber" style={{ fontSize: 10 }}>
                        🔔 Guest order{pendingGuestOrders[t.id].length > 1 ? ` (${pendingGuestOrders[t.id].length})` : ''}
                      </span>
                    )}
                    {ord?.offlinePending && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, color: amberBadgeText,
                        background: 'var(--theme-amber)', borderRadius: 0,
                        padding: '1px 6px', whiteSpace: 'nowrap',
                      }}>
                        📵 Not synced
                      </span>
                    )}
                    {ord?.pending > 0 && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, color: amberBadgeText,
                        background: 'var(--theme-amber)', borderRadius: 0,
                        padding: '1px 6px', whiteSpace: 'nowrap',
                      }}>
                        ⚠ {ord.pending} not sent
                      </span>
                    )}
                  </div>
                </div>
                <div id={`table-more-${t.id}`} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

                {t.section && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{t.section}</div>
                )}
                {opening && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)' }}>Opening…</div>}

                {/* The booking due on this table. Grey, with the WORD "Due" inside the seat window (tap
                    to seat) since S846 rather than the accent; amber ONLY when the party has arrived and
                    the table is still occupied — the one state here that is waiting on a person. */}
                {reservationsByTable[t.id] && (() => {
                  const r = reservationsByTable[t.id]
                  const waiting = r.status === 'arrived' && !!ord
                  const due = !waiting && isDue(r, kotNow, reservationSettings.seat_window_minutes)
                  return (
                    <span className={`badge ${waiting ? 'badge-amber' : 'badge-gray'}`} style={{ fontSize: 10, alignSelf: 'flex-start', fontWeight: due ? 700 : undefined }}>
                      {waiting ? 'Arrived · ' : due ? 'Due · ' : ''}🕗 {nepalTime(r.reserved_for)} · {r.customer_name} ×{r.party_size}
                    </span>
                  )
                })()}

                {ord ? (
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                      {ord.itemCount} item{ord.itemCount !== 1 ? 's' : ''} · {ord.covers} cover{ord.covers !== 1 ? 's' : ''}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)', fontVariantNumeric: 'tabular-nums', marginTop: 3 }}>
                      {fmtNpr(ord.total)}
                    </div>
                  </div>
                ) : joinedTo ? (
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)' }}>⇄ With {joinedMain?.name || 'another table'}'s bill</div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>👥 {t.capacity} seats</div>
                )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>

    {recentBillsModal}
    {/* The floor return's copy, for the admin clear-all tool above it. The order screen renders
        the same element for its own asks — only one tree is ever mounted (S578). */}
    {confirmEl}
    {printAlertsEl}
    {tillNoticeEl}
    </>
  )
}
