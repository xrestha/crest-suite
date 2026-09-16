import { useEffect, useState, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { BS_MONTHS, getBsToday, formatBsDay } from '../../../utils/bsCalendar'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import { firstError } from '../../../shared/queryError'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import Fab from '../../../components/Fab'
import SearchableSelect from '../../../components/SearchableSelect'
import { printWithTitle } from '../../../utils/printTitle'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { loadDeltaExplosion } from '../../../utils/orderLineIngredients'
import { buildStockRows } from '../stockcount/stockReportCalc'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import RequisitionRejectModal from './RequisitionRejectModal'
import { statusMeta, trailParts } from './requisitionTrail'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { chipKeys } from '../../../shared/rovingFocus'
import { FilterChips } from '../../../components/Tabs'

const DEPARTMENTS = [
  'Kitchen',
  'Bar',
  'Pastry / Bakery',
  'Banquet / Events',
  'Room Service',
  'Coffee Shop / Café',
  'Staff Cafeteria',
  'Housekeeping',
  'Laundry',
  'Stewarding',
  'Engineering / Maintenance',
  'Front Office',
  'Concierge',
  'Spa / Wellness',
  'Pool / Recreation',
  'Security',
  'Administration',
  'Other',
]

export default function Requisitions() {
  const { clientId, profile, loading: authLoading, canEditClosedPeriods, hasImsAccess } = useAuth()
  // S765: the three window.confirm()s this page carried included the STOCK-SHORTFALL warning —
  // "you are issuing more than is on hand" — handed to the browser's own dialog on the one action
  // that costs real stock.
  const { ask: askConfirm, confirmEl } = useConfirm()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()

  const periodReq = useLatestRequest()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [items, setItems] = useState([])
  const [reqs, setReqs] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const [mode, setMode] = useState('list') // 'list' | 'new' | 'view'
  const [selectedReq, setSelectedReq] = useState(null)
  const [selectedLines, setSelectedLines] = useState([])

  // New form state
  const [formDay, setFormDay] = useState('')
  const [formDept, setFormDept] = useState('Kitchen')
  const [formNotes, setFormNotes] = useState('')
  const [formLines, setFormLines] = useState([{ item_id: '', qty_requested: '', qty_issued: '', _key: 1 }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // A second error slot on purpose: the form's own `error` renders inside the New Requisition card,
  // while an Issue or a Delete happens on two other screens. This one is bound to a single
  // <ActionError> under the page header, so a refused delete says so instead of silently
  // reappearing in the list on the next reload.
  const [actionError, setActionError] = useState('')

  const itemOptions = useMemo(() => items.map(i => ({ value: i.id, label: `${i.name} (${i.uom})` })), [items])

  // Issue mode
  const [issuingId, setIssuingId] = useState(null)
  const [issueLines, setIssueLines] = useState([])

  // List filters
  const [filterDept, setFilterDept] = useState('all')
  const [filterStatus, setFilterStatus] = useState('all') // 'all' | 'draft' | 'issued' | 'rejected'

  // S756 (D14): who raised / issued / rejected each slip. The ids are stamped by the database; the
  // names come from get_client_profile_names, because a raw profiles read returns only the caller's
  // own row. A failed names read does not block the page — the slips are still right — but it is
  // kept apart from "no such person" so the trail says the name could not be loaded.
  const [names, setNames] = useState({})
  const [namesFailed, setNamesFailed] = useState(false)
  // The draft being rejected, or null. Its own dialog (RequisitionRejectModal) because the reason
  // is required and must survive a refused write.
  const [rejecting, setRejecting] = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line

  async function init() {
    setLoading(true)
    setLoadError(null)
    const [periodsRes, itemsRes, namesRes] = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('items', 'id, name, uom, per_uom_rate, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('name'),
      supabase.rpc('get_client_profile_names', { p_client_id: effectiveClientId }),
    ])
    const results = [periodsRes, itemsRes]
    // A failed read is not an empty period and must not render as one (S612 silent-zero rule).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setLoading(false); return }
    const [{ data: p }, { data: i }] = results
    setNamesFailed(!!namesRes.error)
    setNames(Object.fromEntries((namesRes.data || []).map(n => [n.id, n.full_name])))
    setPeriods(p || [])
    setItems(i || [])
    const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
    if (open) {
      // useLatestRequest's contract: anything that auto-selects a period claims it too. Without
      // this, a period picked while init() was still in flight got the new label over the old
      // list, because init()'s trailing setLoading(false) landed after the newer load had started.
      periodReq.begin(open.id)
      setSelectedPeriod(open)
      await loadReqs(open.id)
      if (!periodReq.isCurrent(open.id)) return
    }
    setLoading(false)
  }

  async function loadReqs(periodId) {
    const { data, error } = await scopedFrom('requisitions', '*, requisition_lines(id, item_id, qty_requested, qty_issued, rate, items(name, uom, per_uom_rate, categories(name)))')
      .eq('period_id', periodId)
      .order('bs_day', { ascending: false })
      .order('created_at', { ascending: false })
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read must not render as "no requisitions" — keep the last good list and show
    // the error card instead (S612/S631).
    if (error) { setLoadError(error); return }
    setReqs(data || [])
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    setLoadError(null)          // a new period is a new attempt — let it recover
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    backToList()
    setLoading(true)
    await loadReqs(periodId)
    setLoading(false)
  }

  function backToList() {
    setActionError('')
    setMode('list')
    setSelectedReq(null)
    setSelectedLines([])
    setIssuingId(null)
    setIssueLines([])
  }

  function startNew() {
    const today = getBsToday()
    const isCurrentMonth = selectedPeriod?.bs_year === today.year && selectedPeriod?.bs_month === today.month
    setMode('new')
    setSelectedReq(null)
    setFormDay(isCurrentMonth ? String(today.day) : '')
    setFormDept('Kitchen')
    setFormNotes('')
    setFormLines([{ item_id: '', qty_requested: '', qty_issued: '', _key: Date.now() }])
    setError('')
  }

  function viewReq(req) {
    setMode('view')
    setSelectedReq(req)
    setSelectedLines(req.requisition_lines || [])
    setIssuingId(null)
    setIssueLines([])
  }

  function addFormLine() {
    setFormLines(prev => [...prev, { item_id: '', qty_requested: '', qty_issued: '', _key: Date.now() + Math.random() }])
  }

  function removeFormLine(key) {
    setFormLines(prev => prev.filter(l => l._key !== key))
  }

  function updateFormLine(key, field, value) {
    setFormLines(prev => prev.map(l => l._key === key ? { ...l, [field]: value } : l))
  }

  // Estimated on-hand qty per item for this period — same formula as StockReport.js's own
  // "on hand" figure (physical closing count if taken, else opening + net purchases − sales usage
  // (recipe-exploded, sub-recipe-recursive) − wastage − staff meals − already-issued
  // requisitions), so issuing a requisition and viewing Stock Report agree on what "available"
  // means. Neither saveReq('issued') nor confirmIssue() checked this before — a requisition could
  // silently issue more of an item than physically exists, corrupting the Requisitioned vs Used
  // reconciliation in Stock.js's Summary tab with no warning at all.
  async function getOnHandMap(periodId) {
    const results = await Promise.all([
      // All paged, for the reason Stock Count states on its own copy of these reads: opening,
      // closing and staff meals are one row per item, so a client past 1000 items silently loses
      // stock — and a truncated read returns NO error, so the firstError() check below passes
      // straight over it (S528). Each needs a unique tiebreaker in its sort or paging can repeat a
      // row on one page and skip it on the next.
      fetchAllRows(() => supabase.from('opening_stock').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('closing_stock').select('item_id, physical_qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', 'item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('wastages').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId).order('id')),
      // source + bs_day feed the shared POS-supersedes-manual dedup (S695) — the same rule
      // Stock Report applies, so this guard and that page agree on "available".
      // ingredient_deltas: a customized plate also consumes its options' stock lines (S758).
      fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day, source, ingredient_deltas').eq('period_id', periodId).order('id')),
      scopedFrom('recipes', 'id'),
      // Issued requisitions are deliberately NOT read here any more (S695, decided with Aashish):
      // what the store issued is consumed by the recipes the kitchen then cooks, and sales × recipe
      // below already subtracts that. Deducting both took every cooked-and-requisitioned item off
      // twice — and on this guard that meant refusing a requisition the store could fill.
    ])
    // A guard whose read failed has not passed (S613): a dropped deduction read INFLATES
    // estimated on-hand, waving the over-issue warning through exactly when the network is
    // the problem. Signal the caller instead of computing from partial data.
    if (firstError(results)) return null
    const [{ data: opening }, { data: closing }, { data: purchases }, { data: returns },
      { data: wastages }, { data: staffMealsData }, { data: sales }, { data: clientRecipes }] = results

    const recipeIds = (clientRecipes || []).map(r => r.id)
    // The recipe walk throws on a failed read (S695); same answer as any other failed read here.
    // The option stock-line walk (S758) likewise: a failure means the check could not run.
    let breakdown = {}
    let explosion = null
    try {
      ;[breakdown, explosion] = await Promise.all([
        recipeIds.length > 0 ? explodeRecipeIngredients(supabase, recipeIds) : {},
        loadDeltaExplosion(supabase, (sales || []).map(s => s.ingredient_deltas)),
      ])
    } catch (_) {
      return null
    }

    // The ONE on-hand calculation Stock Report and Reorder use (S696) — this guard kept a local
    // copy of the same arithmetic, which is how the two drift apart the next time either moves.
    const onHand = {}
    buildStockRows({ items, opening, closing, purchases, returns, wastages, staffMeals: staffMealsData, sales, breakdown, explosion })
      .forEach(r => { onHand[r.item.id] = r.onHand })
    return onHand
  }

  // Returns a confirm-worthy warning string if any line would issue more than estimated on-hand,
  // or null if everything's within stock. Not a hard block — this app's stock model is periodic/
  // physical-count based (see CLAUDE.md), so "on hand" here is an estimate, not a live ledger.
  async function checkStockShortfall(periodId, lines) {
    const onHand = await getOnHandMap(periodId)
    // The check could not run — say so rather than reporting "no shortfall" (the
    // closing-count-preflight convention: inform, never silently pass).
    if (!onHand) return 'Could not check stock on hand — a read failed (check your internet). Issue anyway without the check?'
    const shortfalls = lines
      .map(l => {
        const issuing = parseFloat(l.qty_issued) || 0
        const available = onHand[l.item_id] ?? 0
        if (issuing <= available) return null
        const item = items.find(i => i.id === l.item_id)
        return `${item?.name || l.item_id}: issuing ${issuing} ${item?.uom || ''}, only ~${available.toFixed(1)} estimated on hand`
      })
      .filter(Boolean)
    if (shortfalls.length === 0) return null
    return `This issues more than the estimated stock on hand for:\n\n${shortfalls.join('\n')}\n\nIssue anyway?`
  }

  // `min="0"` on a number input is a hint, not a constraint — nothing enforces it on a paste, and
  // the shortfall test above (`issuing <= available`) waves a negative straight through. A negative
  // qty_issued reaches Stock Count's Requisitioned column and SUBTRACTS from a cross-check figure a
  // month gets closed against. The database refuses it now too (20260909170000); this is the
  // sentence the user reads instead of a constraint name.
  function negativeQtyError(lines) {
    const bad = lines.find(l => parseFloat(l.qty_requested) < 0 || parseFloat(l.qty_issued) < 0)
    if (!bad) return null
    const item = items.find(i => i.id === bad.item_id) || bad.items
    return `${item?.name || 'A line'} has a negative quantity. A quantity can be zero or more — to drop a line, remove it with the × button.`
  }

  // A saved line carries the rate it was WRITTEN with. items.per_uom_rate is generated from
  // items.rate, which every purchase bill rewrites, so reading it live meant a slip signed in
  // Shrawan reprinted with a different total in Bhadra. Only rows written before S710 have no
  // snapshot, and those fall back to the live rate exactly as they always did.
  const lineRate = l => parseFloat(l.rate ?? l.items?.per_uom_rate ?? 0)

  async function saveReq(statusOverride) {
    if (saving) return
    if (!effectiveClientId) { setError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    if (!formDay) { setError('Pick the day this requisition is for.'); return }
    const negative = negativeQtyError(formLines.filter(l => l.item_id))
    if (negative) { setError(negative); return }
    const validLines = formLines.filter(l => l.item_id && parseFloat(l.qty_requested) > 0)
    if (validLines.length === 0) { setError('Add at least one item with a requested quantity.'); return }

    // setSaving BEFORE the await, not after it. The shortfall check below is eight network reads
    // deep, and until this flag is set both buttons are still live and undisabled — a double-click
    // on Save & Issue ran two complete inserts and left two identical requisitions on the day.
    setSaving(true)
    setError('')

    if (statusOverride === 'issued') {
      const checkLines = validLines.map(l => ({
        item_id: l.item_id,
        qty_issued: l.qty_issued !== '' ? l.qty_issued : l.qty_requested,
      }))
      const warning = await checkStockShortfall(selectedPeriod.id, checkLines)
      if (warning) {
        // The write is split out below rather than inlined here: useConfirm takes a `run`
        // callback, and the shortfall is the one thing on this page worth stopping for.
        setSaving(false)
        askConfirm({
          title: 'Not enough stock on hand',
          body: <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{warning}</p>,
          confirmLabel: 'Issue anyway',
          danger: true,
          run: async () => { setSaving(true); await saveReqNow(statusOverride, validLines) },
        })
        return
      }
    }

    await saveReqNow(statusOverride, validLines)
  }

  // The write half of saveReq. Assumes `saving` is already true and owns clearing it.
  async function saveReqNow(statusOverride, validLines) {
    const { data: header, error: hErr } = await scopedInsert('requisitions', {
      period_id: selectedPeriod.id,
      bs_day: parseInt(formDay),
      department: formDept || 'Kitchen',
      notes: formNotes || null,
      status: statusOverride || 'draft',
      // S756: these two are NOT trusted. For every client login the database overwrites them from
      // the session (ims_requisition_attribution) — attribution the subject can choose is not
      // attribution. They are sent only because an operator session (admin "viewing as", which is
      // also how a restore writes) keeps what it supplies, so an operator's own raise is still
      // named rather than recorded as unattributed.
      requested_by: profile?.id || null,
      issued_by: statusOverride === 'issued' ? (profile?.id || null) : null,
    }, { single: true })

    if (hErr || !header) {
      setError(hErr
        ? asActionError(hErr)
        : "The requisition was not saved, and the database didn't say why. Try again — nothing has been recorded.")
      setSaving(false); return
    }

    const lineRows = validLines.map(l => ({
      requisition_id: header.id,
      item_id: l.item_id,
      qty_requested: parseFloat(l.qty_requested),
      qty_issued: statusOverride === 'issued'
        ? parseFloat(l.qty_issued !== '' ? l.qty_issued : l.qty_requested)
        : parseFloat(l.qty_issued || 0),
      // Captured at write time rather than read live at render — see lineRate() above.
      rate: parseFloat(items.find(i => i.id === l.item_id)?.per_uom_rate || 0)
    }))

    const { error: lErr } = await supabase.from('requisition_lines').insert(lineRows)
    if (lErr) {
      // The header row is already committed, so an empty requisition is now sitting in the list
      // under this day — and if it was issued, it reads as a real issue of nothing. Say that,
      // rather than leaving the user to find it.
      const { text, detail } = asActionError(lErr)
      setError({ text: `The requisition was created but none of its items were saved, so it is now showing as an empty ${statusOverride === 'issued' ? 'issued requisition' : 'draft'} for this day. Delete it from the list and enter it again.

${text}`, detail })
      setSaving(false); return
    }

    await loadReqs(selectedPeriod.id)
    backToList()
    setSaving(false)
  }

  function deleteReq(reqId, status) {
    askConfirm({
      title: status === 'issued' ? 'Delete this issued requisition?'
        : status === 'rejected' ? 'Delete this rejected requisition?'
        : 'Delete this draft requisition?',
      body: (
        <p style={{ margin: 0 }}>
          {status === 'issued'
            ? 'Its quantities stop counting towards the Requisitioned column in Stock Count.'
            : status === 'rejected'
              ? 'The record that it was refused, and why, goes with it.'
              : 'Nothing has been issued against it, so nothing else changes.'}
        </p>
      ),
      confirmLabel: 'Delete',
      danger: true,
      run: () => deleteReqNow(reqId),
    })
  }

  async function deleteReqNow(reqId) {
    // A bare `await scopedDelete(...)` discarded the only evidence the delete failed: supabase-js
    // RESOLVES with { data, error } rather than throwing, so an RLS refusal reloaded the list and
    // the row simply reappeared, with nothing on screen to say why (S654).
    const { error: dErr } = await scopedDelete('requisitions').eq('id', reqId)
    if (dErr) { setActionError(asActionError(dErr)); return }
    setActionError('')
    const wasSelected = selectedReq?.id === reqId
    await loadReqs(selectedPeriod.id)
    if (wasSelected) backToList()
  }

  // S756 (D14). Returns an error for the dialog to show, or null once the slip is rejected.
  // `.eq('status', 'draft')` + `.select('id')`: a slip issued, rejected or deleted on another device
  // while this dialog was open matches nothing, and a zero-row update returns no error — so the
  // count is what tells the two apart (S738). The database refuses rejecting a non-draft anyway
  // (requisition_not_draft); this names the situation before that refusal is ever reached.
  async function rejectReq(reason) {
    const req = rejecting
    if (!req || !selectedPeriod) return 'Nothing to reject — close this dialog and open the requisition again.'
    const { data, error: rErr } = await scopedUpdate('requisitions', { status: 'rejected', rejected_reason: reason })
      .eq('id', req.id).eq('status', 'draft').select('id')
    if (rErr) return asActionError(rErr)
    if (!data?.length) {
      return 'This requisition is no longer a draft, so it was not rejected — it was issued, rejected or deleted from another screen while this was open. Close this and check the list.'
    }
    setRejecting(null)
    setActionError('')
    await loadReqs(selectedPeriod.id)
    backToList()
    return null
  }

  function startIssuing() {
    setIssuingId(selectedReq.id)
    setActionError('')
    // Issuing a draft prefills the requested quantity, since that is what the store is about to
    // hand over. CORRECTING an issued slip must open on what was actually issued — including a
    // line issued as 0, which the draft prefill would silently push back up to the requested
    // figure and quietly change a number nobody touched.
    const correcting = selectedReq.status === 'issued'
    setIssueLines(selectedLines.map(l => ({
      ...l,
      qty_issued: correcting ? l.qty_issued : (l.qty_issued > 0 ? l.qty_issued : l.qty_requested)
    })))
  }

  // Issues a draft, and re-saves the quantities of an already-issued slip (`correcting`) — there
  // was no way at all to correct a mis-keyed issue before, and no way to remove one either.
  async function confirmIssue() {
    if (saving) return
    const correcting = selectedReq.status === 'issued'
    const negative = negativeQtyError(issueLines)
    if (negative) { setActionError(negative); return }

    // Same reason as saveReq: the flag goes up before the await, or a double-click runs it twice.
    setSaving(true)
    setActionError('')
    const warning = await checkStockShortfall(selectedPeriod.id, issueLines)
    if (warning) {
      setSaving(false)
      askConfirm({
        title: 'Not enough stock on hand',
        body: <p style={{ margin: 0, whiteSpace: 'pre-line' }}>{warning}</p>,
        confirmLabel: correcting ? 'Save anyway' : 'Issue anyway',
        danger: true,
        run: async () => { setSaving(true); await confirmIssueNow(correcting) },
      })
      return
    }

    await confirmIssueNow(correcting)
  }

  // The write half of confirmIssue. Assumes `saving` is already true and owns clearing it.
  async function confirmIssueNow(correcting) {
    // LINES FIRST, THEN THE STATUS. The other order flipped the header to `issued` and then fired
    // per-line updates whose errors were discarded entirely — not destructured at all — so a
    // failure there left a requisition reading ISSUED with qty_issued = 0 on every line: worth
    // NPR 0 in the list, worth 0 in Stock Count's Requisitioned column, and beyond repair, because
    // Issue is only ever offered on a draft. Written this way a failure leaves it exactly where it
    // started, as a retryable draft. The per-line updates stay parallel; serially they cost one
    // round trip per line (a 20-line requisition took seconds to issue).
    const lineResults = await Promise.all(issueLines.map(line => {
      // On a correction the stored rate is left alone: re-snapshotting would re-price a slip that
      // has already been signed, which is the very thing the column exists to prevent.
      const patch = { qty_issued: parseFloat(line.qty_issued || 0) }
      if (!correcting) patch.rate = parseFloat(line.items?.per_uom_rate || 0)
      return supabase.from('requisition_lines').update(patch).eq('id', line.id)
    }))
    const lineErr = lineResults.find(r => r.error)?.error
    if (lineErr) {
      const { text, detail } = asActionError(lineErr)
      setActionError({ text: correcting
        ? `The corrected quantities were not saved, so this requisition still shows the quantities it was issued with. ${text}`
        : `The issued quantities were not saved, so this requisition is still a draft. Nothing has changed — try Issue again. ${text}`, detail })
      setSaving(false); return
    }

    if (!correcting) {
      const { error: hErr } = await scopedUpdate('requisitions', { status: 'issued' }).eq('id', selectedReq.id)
      if (hErr) {
        const { text, detail } = asActionError(hErr)
        setActionError({ text: `The quantities were saved but the requisition is still showing as a draft. Open it and press Issue again — the quantities are already as you left them. ${text}`, detail })
        setSaving(false); return
      }
    }
    await loadReqs(selectedPeriod.id)
    backToList()
    setSaving(false)
  }

  // A rejected slip moved no stock, so it carries no value in the list (its requested value is
  // still on the slip itself, labelled as such).
  function reqIssuedValue(req) {
    if (req.status === 'rejected') return 0
    return (req.requisition_lines || []).reduce((s, l) => {
      const qty = req.status === 'issued' ? parseFloat(l.qty_issued || 0) : parseFloat(l.qty_requested || 0)
      return s + qty * lineRate(l)
    }, 0)
  }

  async function exportExcel(req, lines) {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const rows = lines.map(l => {
      const rate    = lineRate(l)
      const reqQty  = parseFloat(l.qty_requested || 0)
      const issdQty = parseFloat(l.qty_issued || 0)
      const valueQty = req.status === 'issued' ? issdQty : reqQty
      return {
        'Item':           l.items?.name || '',
        'Category':       l.items?.categories?.name || '',
        'UOM':            l.items?.uom || '',
        'Qty Requested':  reqQty || '',
        'Qty Issued':     req.status === 'issued' ? issdQty : '',
        'Rate (NPR/UOM)': rate || '',
        'Value (NPR)':    rate > 0 ? Math.round(valueQty * rate) : '',
      }
    })
    // S756: the slip's header rides above the lines, so the exported copy carries who raised and
    // who issued it — and, for a rejected slip, why — exactly as the printed one does.
    const trail = trailParts(req, { names, namesFailed, clock: '24' })
    const head = [
      ['Store Requisition Slip'],
      ['Period', periodLabel, 'Day', req.bs_day],
      ['Department', req.department || '', 'Status', statusMeta(req.status).label.toUpperCase()],
      ...trail.map(t => [t.text]),
      ...(req.status === 'rejected' ? [['Reason for rejecting', req.rejected_reason || '']] : []),
      ...(req.notes ? [['Notes', req.notes]] : []),
      [],
    ]
    const ws = XLSX.utils.aoa_to_sheet(head)
    XLSX.utils.sheet_add_json(ws, rows, { origin: -1 })
    XLSX.utils.book_append_sheet(wb, ws, 'Requisition')
    // Four of the eighteen departments carry a slash ("Pastry / Bakery"), which is not a legal
    // filename character on Windows and gets silently rewritten by the browser on the way down.
    const safe = t => String(t || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim()
    const filename = `Requisition-Day${req.bs_day}-${safe(req.department)}-${periodLabel.replace(/\s+/g, '')}.xlsx`
    XLSX.writeFile(wb, filename)
  }

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : '—'
  // Named for what it gates: whether THIS login may write the month. Admin and the Owner edit a
  // closed month in place (S756), as on every other IMS entry page.
  const periodClosed = !canEditClosedPeriods && selectedPeriod?.status === 'closed'
  const allDepts = [...new Set(reqs.map(r => r.department).filter(Boolean))].sort()
  const filteredReqs = filterDept === 'all' ? reqs : reqs.filter(r => r.department === filterDept)
  // The stat strip sits directly above the department tabs, so it counts what those tabs are
  // showing. Filtering to Bar and leaving "Total Issued Value" on every department's total is a
  // figure that contradicts the scope stated an inch below it — and the cards say which scope they
  // are on rather than leaving the reader to infer it.
  const issuedReqs = filteredReqs.filter(r => r.status === 'issued')
  // Pending means draft and nothing else: a rejected slip has been decided (S756).
  const draftReqs = filteredReqs.filter(r => r.status === 'draft')
  const rejectedReqs = filteredReqs.filter(r => r.status === 'rejected')
  // The status tabs narrow the TABLE only; the stat strip keeps counting the department scope, so
  // "Issued" never reads 0 because the Rejected tab is selected.
  const tableReqs = filterStatus === 'all' ? filteredReqs : filteredReqs.filter(r => r.status === filterStatus)
  const statusTabs = [
    { key: 'all', label: 'All', count: filteredReqs.length },
    { key: 'draft', label: 'Draft', count: draftReqs.length },
    { key: 'issued', label: 'Issued', count: issuedReqs.length },
    { key: 'rejected', label: 'Rejected', count: rejectedReqs.length },
  ]
  const selectedTrail = selectedReq ? trailParts(selectedReq, { names, namesFailed }) : []
  const totalIssuedValue = issuedReqs.reduce((s, r) => s + reqIssuedValue(r), 0)
  const statScope = filterDept === 'all' ? '' : ` — ${filterDept}`
  // Correcting or removing an issued slip is a supervisor's call, matching Purchases' own
  // canDeleteAll. Staff can still raise and issue; they cannot rewrite one after the fact.
  const canAmendIssued = hasImsAccess('supervisor')

  // Floor tier, matching every other IMS page's guard (S417 convention). This page had none, so
  // the route was reachable by any account at an ims_enabled client regardless of ims_role.
  if (!hasImsAccess('staff')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read must not wear NoPeriodState (S612 silent-zero rule).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="requisitions" />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Requisitions</h1>
          <p className="page-subtitle">Internal store-to-department stock transfers</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} />
          </div>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Period"
            style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
            value={selectedPeriod?.id || ''}
            onChange={e => handlePeriodChange(e.target.value)}
          >
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          {mode !== 'list' && (
            <button className="btn btn-ghost" onClick={backToList}>← Back to List</button>
          )}
        </div>
      </div>

      {/* Issue and Delete happen on the list and detail screens, neither of which had anywhere to
          put a failure. role="alert" on ActionError announces it at the moment it appears. */}
      <ActionError error={actionError} className="action-error--top" />

      {loading ? (
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : mode === 'new' ? (
        /* ── New Requisition Form ─────────────────────────────────────────── */
        <div>
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
              <div className="form-field">
                <label htmlFor="req-day">Day *</label>
                <BsCalendarPicker
                  id="req-day"
                  lockYear={selectedPeriod?.bs_year}
                  lockMonth={selectedPeriod?.bs_month}
                  value={formDay}
                  onChange={setFormDay}
                  placeholder="Pick day"
                />
              </div>
              <div className="form-field">
                <label htmlFor="requis-f1">
                  <Tip text="The department receiving items from the main store (e.g. Kitchen, Bar, Pastry)." width={230}>Department</Tip>
                </label>
                <select id="requis-f1"
                  value={formDept}
                  onChange={e => setFormDept(e.target.value)}
                  style={{ width: '100%' }}
                >
                  {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label htmlFor="requis-f2">Notes (optional)</label>
                <input id="requis-f2"
                  value={formNotes}
                  onChange={e => setFormNotes(e.target.value)}
                  placeholder="e.g. Dinner service, lunch prep…"
                  style={{ width: '100%' }}
                />
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 14, marginBottom: 14 }}>Requested Items</div>
            <div className="table-wrap table-wrap--fab-clear">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: 220 }}>Item</th>
                    <th>UOM</th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Quantity the department is requesting from the store." width={210}>Qty Requested</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Quantity actually issued from the store. Leave blank to issue the full requested quantity when you confirm." width={260}>Qty Issued</Tip>
                    </th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-text3)' }}><Tip text="Per-base-unit cost from the most recent purchase entry for this item." width={240}>Rate / UOM</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}><Tip text="Estimated store issue cost = Qty Issued (or Requested) × Rate / UOM." width={240}>Est. Value</Tip></th>
                    <th style={{ width: 36 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {formLines.map(line => {
                    const item = items.find(i => i.id === line.item_id)
                    const rate = parseFloat(item?.per_uom_rate || 0)
                    const issuedQty = parseFloat(line.qty_issued !== '' ? line.qty_issued : line.qty_requested || 0)
                    const value = issuedQty * rate
                    return (
                      <tr key={line._key}>
                        <td>
                          <SearchableSelect
                            value={line.item_id}
                            onChange={v => updateFormLine(line._key, 'item_id', v)}
                            options={itemOptions}
                            placeholder="— Select item —"
                          />
                        </td>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{item?.uom || '—'}</td>
                        <td>
                          <input aria-label="Quantity requested"
                            type="number" min="0" step="any"
                            value={line.qty_requested}
                            onChange={e => updateFormLine(line._key, 'qty_requested', e.target.value)}
                            style={{ width: 90, textAlign: 'right' }}
                            placeholder="0"
                          />
                        </td>
                        <td>
                          <input aria-label="Quantity issued"
                            type="number" min="0" step="any"
                            value={line.qty_issued}
                            onChange={e => updateFormLine(line._key, 'qty_issued', e.target.value)}
                            style={{ width: 90, textAlign: 'right' }}
                            placeholder="same"
                          />
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                          {rate > 0 ? `NPR ${rate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: value > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text2)', fontSize: 12 }}>
                          {value > 0 ? `NPR ${Math.round(value).toLocaleString('en-IN')}` : '—'}
                        </td>
                        <td>
                          <button
                            onClick={() => removeFormLine(line._key)}
                            aria-label="Remove line"
                            style={{ background: 'none', border: 'none', color: 'var(--theme-red-text)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '10px' }}
                          >×</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <button className="btn btn-ghost" style={{ marginTop: 10, fontSize: 12 }} onClick={addFormLine}>+ Add Item</button>
          </div>

          <ActionError error={error} className="action-error--top" />

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={backToList} disabled={saving}>Cancel</button>
            <button className="btn btn-ghost" onClick={() => saveReq('draft')} disabled={saving}>
              {saving ? 'Saving…' : 'Save as Draft'}
            </button>
            <button className="btn btn-primary" onClick={() => saveReq('issued')} disabled={saving}>
              {saving ? 'Saving…' : 'Save & Issue'}
            </button>
          </div>
        </div>

      ) : mode === 'view' && selectedReq ? (
        /* ── View / Issue Requisition ────────────────────────────────────── */
        <div>
          {/* Print-only slip header */}
          <div className="print-only" style={{ marginBottom: 20 }}>
            <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Store Requisition Slip</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
              <tbody>
                <tr>
                  <td style={{ padding: '4px 8px', fontWeight: 600 }}>Period:</td>
                  <td style={{ padding: '4px 8px' }}>{periodLabel}</td>
                  <td style={{ padding: '4px 8px', fontWeight: 600 }}>Day:</td>
                  <td style={{ padding: '4px 8px' }}>{selectedReq.bs_day}</td>
                </tr>
                <tr>
                  <td style={{ padding: '4px 8px', fontWeight: 600 }}>Department:</td>
                  <td style={{ padding: '4px 8px' }}>{selectedReq.department}</td>
                  <td style={{ padding: '4px 8px', fontWeight: 600 }}>Status:</td>
                  <td style={{ padding: '4px 8px' }}>{statusMeta(selectedReq.status).label.toUpperCase()}</td>
                </tr>
                {/* S756: the paper copy is the one that gets signed and filed, so it carries the
                    trail too. */}
                {selectedTrail.map(t => (
                  <tr key={t.key}>
                    <td colSpan={4} style={{ padding: '4px 8px' }}>{t.text}</td>
                  </tr>
                ))}
                {selectedReq.status === 'rejected' && (
                  <tr>
                    <td style={{ padding: '4px 8px', fontWeight: 600 }}>Reason:</td>
                    <td colSpan={3} style={{ padding: '4px 8px' }}>{selectedReq.rejected_reason}</td>
                  </tr>
                )}
                {selectedReq.notes && (
                  <tr>
                    <td style={{ padding: '4px 8px', fontWeight: 600 }}>Notes:</td>
                    <td colSpan={3} style={{ padding: '4px 8px' }}>{selectedReq.notes}</td>
                  </tr>
                )}
              </tbody>
            </table>
            <hr style={{ margin: '12px 0', borderTop: '2px solid #000' }} />
          </div>

          {/* Header card */}
          <div className="card no-print" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 3 }}>Day</div>
                  <div style={{ fontWeight: 700, color: 'var(--theme-accent-ink)', fontSize: 18 }}>{selectedReq.bs_day}</div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{periodLabel}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 3 }}>Department</div>
                  <div style={{ fontWeight: 700, color: 'var(--theme-text1)', fontSize: 14 }}>{selectedReq.department}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 3 }}>Status</div>
                  <span className={`badge ${statusMeta(selectedReq.status).badge}`} style={{ fontSize: 12, padding: '3px 10px' }}>
                    {statusMeta(selectedReq.status).label.toUpperCase()}
                  </span>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 3 }}>Items</div>
                  <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{selectedLines.length}</div>
                </div>
                {selectedReq.notes && (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 3 }}>Notes</div>
                    <div style={{ color: 'var(--theme-text3)', fontSize: 13 }}>{selectedReq.notes}</div>
                  </div>
                )}
              </div>
              <div className="no-print" style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                {selectedReq.status === 'draft' && !periodClosed && !issuingId && (
                  <>
                    <button
                      className="btn btn-ghost"
                      onClick={() => deleteReq(selectedReq.id, selectedReq.status)}
                      style={{ color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }}
                    >Delete</button>
                    <button className="btn btn-ghost" onClick={() => { setActionError(''); setRejecting(selectedReq) }}>
                      <Tip text="Refuse this request with a reason. Nothing is issued, it stops counting as pending, and it cannot be issued or edited afterwards." width={260}>Reject</Tip>
                    </button>
                    <button className="btn btn-primary" onClick={startIssuing}>Issue</button>
                  </>
                )}
                {/* A rejected slip is final (S756): no edit, no issue. Deleting one follows the
                    issued-slip rule, and the database enforces both. */}
                {selectedReq.status === 'rejected' && !periodClosed && canAmendIssued && (
                  <button
                    className="btn btn-ghost"
                    onClick={() => deleteReq(selectedReq.id, selectedReq.status)}
                    style={{ color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }}
                  >Delete</button>
                )}
                {/* An issued slip used to be terminal in every direction: no edit, no delete, no
                    un-issue. A quantity keyed wrong was permanent, and so was a requisition raised
                    against the wrong department. Both are a supervisor's call, and both are still
                    closed off once the period is. */}
                {selectedReq.status === 'issued' && !periodClosed && !issuingId && canAmendIssued && (
                  <>
                    <button
                      className="btn btn-ghost"
                      onClick={() => deleteReq(selectedReq.id, selectedReq.status)}
                      style={{ color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }}
                    >Delete</button>
                    <button className="btn btn-ghost" onClick={startIssuing}>
                      <Tip text="Re-open the issued quantities to correct a mis-keyed figure. The rate this slip was priced at does not change." width={260}>Correct Quantities</Tip>
                    </button>
                  </>
                )}
                <button className="btn btn-ghost" onClick={() => exportExcel(selectedReq, selectedLines)}>Export Excel</button>
                <button className="btn btn-ghost" onClick={() => printWithTitle(`Requisition - Day ${selectedReq.bs_day} - ${selectedReq.department} - ${periodLabel}`)}>Print</button>
              </div>
            </div>
            {/* S756 (D14): who raised it, who issued or rejected it, and when — stamped by the
                database, never by this page. */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--theme-border)', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.7 }}>
              {selectedTrail.map(t => <div key={t.key}>{t.text}</div>)}
              {selectedReq.status === 'rejected' && (
                <div style={{ color: 'var(--theme-text1)', marginTop: 4 }}>
                  <span style={{ fontWeight: 600 }}>Reason: </span>{selectedReq.rejected_reason}
                </div>
              )}
            </div>
          </div>

          {/* Issue-mode: editable qty_issued */}
          {issuingId === selectedReq.id ? (
            <div className="card">
              <div style={{ fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 14 }}>
                {selectedReq.status === 'issued'
                  ? 'Correct Issued Quantities — this slip keeps the rate it was issued at'
                  : 'Confirm Issue Quantities — adjust if issuing less than requested'}
              </div>
              <div className="table-wrap table-wrap--fab-clear">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>UOM</th>
                      <th style={{ textAlign: 'right' }}>Qty Requested</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Set the actual quantity you are issuing from the store. Can be less than requested." width={230}>Qty Issued</Tip>
                      </th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-text3)' }}><Tip text="Per-base-unit cost from the most recent purchase entry for this item." width={240}>Rate / UOM</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}><Tip text="Qty Issued × Rate / UOM — the NPR cost of goods leaving the store." width={240}>Value Issued</Tip></th>
                    </tr>
                  </thead>
                  <tbody>
                    {issueLines.map((line, idx) => {
                      const rate = lineRate(line)
                      const value = parseFloat(line.qty_issued || 0) * rate
                      return (
                        <tr key={line.id}>
                          <td style={{ fontWeight: 600 }}>{line.items?.name}</td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{line.items?.uom}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{Number(line.qty_requested).toLocaleString('en-IN')}</td>
                          <td>
                            <input aria-label="Quantity issued"
                              type="number" min="0" step="any"
                              value={issueLines[idx].qty_issued}
                              onChange={e => setIssueLines(prev => prev.map((l, j) => j === idx ? { ...l, qty_issued: e.target.value } : l))}
                              style={{ width: 100, textAlign: 'right', float: 'right' }}
                            />
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                            {rate > 0 ? `NPR ${rate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-accent-ink)' }}>
                            {value > 0 ? `NPR ${Math.round(value).toLocaleString('en-IN')}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" onClick={() => { setIssuingId(null); setIssueLines([]) }} disabled={saving}>Cancel</button>
                <button className="btn btn-primary" onClick={confirmIssue} disabled={saving}>
                  {saving
                    ? (selectedReq.status === 'issued' ? 'Saving…' : 'Issuing…')
                    : (selectedReq.status === 'issued' ? 'Save Corrections' : 'Confirm Issue')}
                </button>
              </div>
            </div>
          ) : (
            /* Read-only line items */
            <div className="card">
              <div className="table-wrap table-wrap--fab-clear">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Category</th>
                      <th>UOM</th>
                      <th style={{ textAlign: 'right' }}>Qty Requested</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Qty actually issued from the store. Green = full qty issued, red = partial." width={220}>Qty Issued</Tip>
                      </th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-text3)' }}><Tip text="Per-base-unit cost from the most recent purchase entry for this item." width={240}>Rate / UOM</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}><Tip text="Qty Issued × Rate / UOM — the NPR cost of goods that left the store." width={240}>Value</Tip></th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedLines.map(line => {
                      const rate = lineRate(line)
                      const reqQty = parseFloat(line.qty_requested || 0)
                      const issdQty = parseFloat(line.qty_issued || 0)
                      const displayQty = selectedReq.status === 'issued' ? issdQty : reqQty
                      const value = displayQty * rate
                      const partial = selectedReq.status === 'issued' && issdQty < reqQty
                      return (
                        <tr key={line.id}>
                          <td style={{ fontWeight: 600 }}>{line.items?.name}</td>
                          <td>
                            {line.items?.categories?.name
                              ? <span className="badge badge-yellow">{line.items.categories.name}</span>
                              : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                          </td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{line.items?.uom}</td>
                          <td style={{ textAlign: 'right' }}>{Number(reqQty).toLocaleString('en-IN')}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: selectedReq.status === 'issued' ? (partial ? 'var(--theme-red-text)' : 'var(--theme-green-text)') : 'var(--theme-text2)' }}>
                            {selectedReq.status === 'issued' ? Number(issdQty).toLocaleString('en-IN') : '—'}
                            {partial && <span style={{ fontSize: 10, marginLeft: 4 }}>partial</span>}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                            {rate > 0 ? `NPR ${rate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: value > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text2)' }}>
                            {value > 0 ? `NPR ${Math.round(value).toLocaleString('en-IN')}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                    {/* Total */}
                    {(() => {
                      const total = selectedLines.reduce((s, l) => {
                        const qty = selectedReq.status === 'issued' ? parseFloat(l.qty_issued || 0) : parseFloat(l.qty_requested || 0)
                        return s + qty * lineRate(l)
                      }, 0)
                      return total > 0 ? (
                        <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                          <td colSpan={6} style={{ fontWeight: 700, paddingTop: 12 }}>
                            {selectedReq.status === 'issued'
                              ? 'Total Issued Value'
                              : selectedReq.status === 'rejected'
                                ? 'Total Requested Value (rejected — nothing was issued)'
                                : 'Total Requested Value'}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', paddingTop: 12 }}>
                            NPR {Math.round(total).toLocaleString('en-IN')}
                          </td>
                        </tr>
                      ) : null
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

      ) : (
        /* ── Requisitions List ───────────────────────────────────────────── */
        <div>
          {/* Stat cards */}
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-label">Total Requisitions{statScope}</div>
              <div className="stat-value">{filteredReqs.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Issued{statScope}</div>
              <div className="stat-value" style={{ color: 'var(--theme-green-text)' }}>{issuedReqs.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Draft / Pending{statScope}</div>
              <div className="stat-value" style={{ color: draftReqs.length > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text2)' }}>{draftReqs.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Total Issued Value{statScope}</div>
              <div className="stat-value gold" style={{ fontSize: 16 }}>
                {totalIssuedValue > 0 ? `NPR ${Math.round(totalIssuedValue).toLocaleString('en-IN')}` : '—'}
              </div>
            </div>
          </div>

          {/* Filters */}
          {allDepts.length > 1 && (
            <FilterChips
              label="Filter by department"
              style={{ marginBottom: 16 }}
              options={[{ key: 'all', label: 'All' }, ...allDepts.map(d => ({ key: d, label: d }))]}
              active={filterDept}
              onChange={setFilterDept}
            />
          )}

          {filteredReqs.length > 0 && (
            <div className="tab-bar" role="group" aria-label="Filter by status" style={{ marginBottom: 16 }} onKeyDown={chipKeys}>
              {statusTabs.map(t => (
                <button
                  key={t.key}
                  onClick={() => setFilterStatus(t.key)}
                  aria-pressed={filterStatus === t.key}
                  className={`tab-btn${filterStatus === t.key ? ' tab-btn--active' : ''}`}
                >{t.label} ({t.count})</button>
              ))}
            </div>
          )}

          {filteredReqs.length > 0 && tableReqs.length === 0 ? (
            <div className="card">
              <div className="empty-state">
                <p className="empty-state-text">No {filterStatus} requisitions for {periodLabel}{statScope}.</p>
              </div>
            </div>
          ) : filteredReqs.length === 0 ? (
            <div className="card">
              <div className="empty-state">
                <div className="empty-state-icon">▤</div>
                <p className="empty-state-text">No requisitions for {periodLabel}.</p>
                {!periodClosed && (
                  <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={startNew}>+ New Requisition</button>
                )}
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="table-wrap table-wrap--fab-clear">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Department</th>
                      <th style={{ textAlign: 'right' }}>Items</th>
                      <th>Status</th>
                      <th>
                        <Tip text="Who raised the slip, and who issued or rejected it and when. Recorded by the system from the login that did it. Slips from before this was recorded say so." width={260}>Raised / Decided</Tip>
                      </th>
                      <th>Notes</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Total NPR value based on issued qty × item cost rate. Shows requested value for drafts." width={230}>Value</Tip>
                      </th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableReqs.map(req => {
                      const value = reqIssuedValue(req)
                      const lineCount = (req.requisition_lines || []).length
                      return (
                        <tr key={req.id} style={{ cursor: 'pointer' }} onClick={() => viewReq(req)}>
                          <td style={{ fontWeight: 700, color: 'var(--theme-accent-ink)', whiteSpace: 'nowrap' }}>{formatBsDay(req.bs_day, selectedPeriod?.bs_month) || '—'}</td>
                          <td style={{ fontWeight: 600 }}>{req.department}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{lineCount}</td>
                          <td>
                            <span className={`badge ${statusMeta(req.status).badge}`}>
                              {statusMeta(req.status).label}
                            </span>
                          </td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12, minWidth: 180 }}>
                            {trailParts(req, { names, namesFailed }).map(t => <div key={t.key}>{t.text}</div>)}
                            {req.status === 'rejected' && (
                              <div style={{ color: 'var(--theme-text1)' }}>Reason: {req.rejected_reason}</div>
                            )}
                          </td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{req.notes || '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: value > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text2)' }}>
                            {value > 0 ? `NPR ${Math.round(value).toLocaleString('en-IN')}` : '—'}
                          </td>
                          <td onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => viewReq(req)}>View</button>
                            {req.status === 'draft' && !periodClosed && (
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 12, padding: '4px 10px', marginLeft: 4, color: 'var(--theme-red-text)' }}
                                onClick={() => deleteReq(req.id, req.status)}
                              >Del</button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <Fab onClick={startNew} label="+ New Requisition" show={mode === 'list' && !periodClosed} />

      {rejecting && (
        <RequisitionRejectModal
          slipLabel={`The ${rejecting.department || ''} requisition for ${formatBsDay(rejecting.bs_day, selectedPeriod?.bs_month) || `day ${rejecting.bs_day}`}`}
          onConfirm={rejectReq}
          onCancel={() => setRejecting(null)}
        />
      )}
      {confirmEl}
    </div>
  )
}
