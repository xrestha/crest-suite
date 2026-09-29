import { useMemo, useRef, useState } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { nprExact } from '../../../shared/nepalMoney'
import { returnChangeReopensBill, returnEditReopensBill } from '../reports/payablesAllocation'
import { isNetworkError } from '../../../shared/errorText'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import SearchableSelect from '../../../components/SearchableSelect'
import FieldError from '../../../components/FieldError'
import { getCf, returnBillPeriods, remainingReturnableQty, returnDayProblem, LATE_RETURN_MONTHS } from './purchasesHelpers'
// Every rate on this tab goes through fmtLineRate, not a 2-decimal format, so a per-base-unit rate
// such as 0.004/GM no longer reads "0" (S792, PURCHASES-9).
import { fmtLineRate } from './purchaseLines'
import { BS_MONTHS, formatBsDay, daysInBsMonth } from '../../../utils/bsCalendar'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useConfirm } from '../../../shared/hooks/useConfirm'

const EMPTY_RETURN = { bill_period_id: '', vendor_filter: '', purchase_entry_id: '', qty: '', bs_day: '', notes: '' }

const monthLabel = p => (p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : '')

// What deleting a return has to know about its bill (S792 stage 2): every line's figures and its
// settle stamp. `invoice_ref` names the bill in the sentences below.
const BILL_LINE_COLUMNS = 'id, qty, rate, vat_inclusive, discount_amount, paid_at, invoice_ref, purchase_group_id'

// Vendor Returns tab — record + list returns against an existing purchase entry. Rate, vendor,
// and payment method are always inherited from the linked purchase (a return can't have its own).
// The DAY is the return's own (S698): it used to be copied from the bill, so every return was
// dated to the day the goods were bought, and Vendor Balance Confirmation's running ledger — which
// orders by that day — showed returns before they happened, while this tab's own Day column
// tooltip promised the opposite. The picker pre-fills the bill's day, so the common same-day case
// costs nothing extra to type.
//
// LATE RETURNS (S756, owner decision D10). The bill could only come from the month on screen, and
// the day was locked to that month — so milk bought on 28 Bhadra and sent back on 2 Ashwin had to
// be recorded as a Bhadra return dated in Bhadra, and once Bhadra closed a staff login could not
// record it at all. A return now SITS in the month it happened (its own period_id and bs_day are the
// month on screen) and may take its bill from this month or any of the twelve before it. Three
// things follow, and each is enforced here:
//   - the over-return cap is read FRESH, per purchase line, across every month — the list on screen
//     holds only this month's returns, so capping from it let the same goods go back twice;
//   - "not dated before its bill" applies only when the bill is in this same month;
//   - each row says which month its bill was from.
export default function ReturnsTab({ period, periods, purchases, returns, isLocked, effectiveClientId, onChanged }) {
  // .btn-primary's CSS pairs its background with --theme-accent-text, calibrated for --theme-accent
  // — overriding just the background to red here left the text color mismatched to accent, not red.
  const { scopedFrom, scopedUpdate, scopedInsert, scopedDelete } = useScopedDb()
  const { isAdmin, hasImsAccess } = useAuth()
  // Clearing a bill's settle stamp is an UPDATE of purchase_entries, which the database lets only an
  // IMS manager, the Owner or admin make (ims_rank_guard, S756) — the same logins Outstanding
  // Payables is for. Checked here so a staff login is told before anything is written.
  const canReopenBills = isAdmin || hasImsAccess('manager')
  const { ask: askConfirm, confirmEl } = useConfirm()
  const [checkingId, setCheckingId] = useState(null)   // the return whose bill is being read before its delete
  const [showReturnForm, setShowReturnForm] = useState(false)
  const [returnForm, setReturnForm]         = useState(EMPTY_RETURN)
  const [returnSaving, setReturnSaving]     = useState(false)
  const [returnError, setReturnError]       = useState('')
  const [dayErr, setDayErr]                 = useState('')
  const [actionError, setActionError]       = useState(null)   // the last delete that did not land
  const [editingReturnId, setEditingReturnId] = useState(null)
  // An earlier month's bill lines, read on demand: { [periodId]: { rows, error, loading } }. This
  // month's come from the page (`purchases`), which already holds them.
  const [billLinesByPeriod, setBillLinesByPeriod] = useState({})
  // Every return already recorded against the picked line, whichever month it sits in.
  const [prior, setPrior] = useState({ lineId: null, rows: [], error: null, loading: false })
  const priorReqRef = useRef(null)

  const billPeriods = useMemo(() => returnBillPeriods(periods, period), [periods, period])
  const periodById = useMemo(() => Object.fromEntries((periods || []).map(p => [p.id, p])), [periods])

  function linesFor(pid) {
    if (!pid || pid === period?.id) return purchases
    return billLinesByPeriod[pid]?.rows || []
  }

  // Paged (fetchAllRows): an earlier month is a whole month of bill lines, the same read the
  // Purchases tab makes for this one. A failed read is kept and SHOWN — an empty picker would read
  // as "that month had no bills".
  async function ensureLines(pid) {
    if (!pid || pid === period?.id) return
    const have = billLinesByPeriod[pid]
    if (have && (have.rows || have.loading)) return
    setBillLinesByPeriod(m => ({ ...m, [pid]: { rows: null, error: null, loading: true } }))
    const { data, error } = await fetchAllRows(() => supabase
      .from('purchase_entries')
      .select('*, items(name, uom, purchase_unit, conversion_factor), vendors(name)')
      .eq('period_id', pid)
      .order('bs_day')
      .order('created_at')
      .order('id'))
    setBillLinesByPeriod(m => ({ ...m, [pid]: { rows: error ? null : (data || []), error: error || null, loading: false } }))
  }

  // Read fresh on every call; the save path calls it again rather than trusting what the form shows.
  async function readPriorReturns(lineId) {
    return scopedFrom('vendor_returns', 'id, qty, period_id, bs_day').eq('purchase_entry_id', lineId).order('id')
  }

  async function loadPrior(lineId) {
    priorReqRef.current = lineId
    if (!lineId) { setPrior({ lineId: null, rows: [], error: null, loading: false }); return }
    setPrior({ lineId, rows: [], error: null, loading: true })
    const { data, error } = await readPriorReturns(lineId)
    if (priorReqRef.current !== lineId) return   // a different line was picked meanwhile
    setPrior({ lineId, rows: data || [], error: error || null, loading: false })
  }

  function openNewReturn() {
    setEditingReturnId(null)
    setReturnForm({ ...EMPTY_RETURN, bill_period_id: period?.id || '' })
    setReturnError(''); setDayErr('')
    loadPrior(null)
    setShowReturnForm(true)
  }

  function openEditReturn(ret) {
    setEditingReturnId(ret.id)
    const cf = getCf(ret.items)
    const billPid = ret.purchase_entries?.period_id || period?.id || ''
    ensureLines(billPid)
    setReturnForm({
      bill_period_id: billPid,
      vendor_filter: '',
      purchase_entry_id: ret.purchase_entry_id || '',
      qty: cf > 1 ? ret.qty / cf : ret.qty,   // DB stores base units; form shows purchase units
      bs_day: ret.bs_day ? String(ret.bs_day) : '',
      notes: ret.notes || ''
    })
    setReturnError(''); setDayErr('')
    loadPrior(ret.purchase_entry_id || null)
    setShowReturnForm(true)
  }

  // When a purchase is selected, auto-derive item/vendor/rate/payment from it
  function getLinkedPurchase(purchaseEntryId) {
    return linesFor(returnForm.bill_period_id).find(p => p.id === purchaseEntryId) || null
  }

  async function saveReturn() {
    if (!effectiveClientId) { setReturnError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    if (!returnForm.purchase_entry_id) { setReturnError('Select the bill line the goods are going back against.'); return }
    const linked = getLinkedPurchase(returnForm.purchase_entry_id)
    if (!linked) { setReturnError('That bill line could not be found — it may have been deleted or edited since. Pick it again from the list.'); return }
    const retQty = parseFloat(returnForm.qty)
    if (!returnForm.qty || retQty <= 0) { setReturnError('Enter a valid return quantity.'); return }
    const maxDay = period ? daysInBsMonth(period.bs_year, period.bs_month) : 32
    const samePeriod = linked.period_id === period?.id
    // Goods cannot go back before they arrived (S756) — but only a same-month bill has a day number
    // that compares with this month's (S756, D10): day 2 of Ashwin is after day 28 of Bhadra.
    const dayProblem = returnDayProblem({ retDay: returnForm.bs_day, maxDay, billDay: linked.bs_day, samePeriod })
    if (dayProblem === 'range') { setDayErr(`Pick the day the goods went back (1–${maxDay}).`); return }
    if (dayProblem === 'before-bill') {
      const billDay = parseInt(linked.bs_day, 10)
      setDayErr(`This bill is dated ${formatBsDay(billDay, period?.bs_month)}, so the goods cannot have gone back before then. Pick ${formatBsDay(billDay, period?.bs_month)} or a later day.`)
      return
    }
    setDayErr('')
    const retCf = getCf(linked.items)
    const baseRetQty = retQty * retCf

    setReturnSaving(true)
    setReturnError('')

    // The cap counts EVERY return against this line, whichever month it sits in (S756, D10), read
    // fresh at the moment of saving. It was built from this month's list — correct only while a
    // return and its bill always shared a month — and before S698 not even that: two 8 kg returns
    // against a 10 kg purchase both passed, returning 16 kg and driving Variance/FIFO stock negative.
    // A read that fails has not checked anything, so it refuses rather than letting the return by.
    const { data: priorRows, error: priorErr } = await readPriorReturns(linked.id)
    if (priorErr) {
      const a = asActionError(priorErr)
      setReturnError({ text: `The return was not ${editingReturnId ? 'updated' : 'recorded'} — Crest could not check how much of this line has already been returned. ${a.text}`, detail: a.detail })
      setReturnSaving(false); return
    }
    const { total: linkedQty, prior: priorReturnedQty, remaining: remainingQty } = remainingReturnableQty(linked.qty, priorRows, editingReturnId)
    if (baseRetQty > remainingQty + 1e-9) {
      const shown = q => (retCf > 1 ? `${(q / retCf).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${linked.items?.purchase_unit}` : `${q.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${linked.items?.uom}`)
      setReturnError(priorReturnedQty > 0
        ? `Only ${shown(Math.max(0, remainingQty))} of this line can still go back. ${shown(linkedQty)} was bought and ${shown(priorReturnedQty)} has already been returned — possibly in another month.`
        : `Return qty cannot be more than was bought on this line (${shown(linkedQty)}).`)
      setPrior({ lineId: linked.id, rows: priorRows || [], error: null, loading: false })
      setReturnSaving(false); return
    }

    const payload = {
      // The month on screen — the month the goods went back — never the bill's month (D10).
      period_id:          period.id,
      purchase_entry_id:  linked.id,
      item_id:            linked.item_id,
      vendor_id:          linked.vendor_id || null,
      qty:                baseRetQty,
      rate:               parseFloat(linked.rate),
      payment_method:     linked.payment_method || 'Cash',
      bs_day:             parseInt(returnForm.bs_day, 10),
      notes:              returnForm.notes.trim() || null
    }

    if (editingReturnId) {
      // S792 stage 2 review (P1). An edit changes what the return takes off its bill — a smaller
      // qty, or a re-link to another line or another bill — so a bill settled BY this return owes
      // again exactly as it does when the return is deleted, and its stamps would keep it in Paid
      // History. The delete's read, decision and order of writes, asked of the return as it will be
      // written (returnEditReopensBill). A re-link off the bill is a delete there; the bill it moves
      // to only gains a return, which can never make it owe more, so it is not read.
      const id = editingReturnId
      const original = (returns || []).find(r => r.id === id) || { id, purchase_entry_id: null }
      const next = { purchase_entry_id: payload.purchase_entry_id, qty: payload.qty, rate: payload.rate }
      const pre = await readReturnBill(original, next)
      if (pre.error) { refuseEditUnchecked(pre.error); setReturnSaving(false); return }
      const d = pre.decision
      if (!d?.reopen) { await writeReturnEdit(id, payload, pre); return }
      setReturnSaving(false)
      if (!canReopenBills) {
        setReturnError(`The return was not updated — it still shows its previous figures. ${billName(pre.invoiceRef)} is marked settled, and this change means ${nprExact(d.owedAgain)} is owed on it again, so the bill has to move back to Outstanding Payables. Reopening a settled bill needs an IMS manager or the Owner — ask one of them to make this change.`)
        return
      }
      askConfirm({
        title: 'Update this return?',
        confirmLabel: 'Update Return', busyLabel: 'Saving…',
        body: <p style={{ margin: 0 }}>This bill{pre.invoiceRef ? ` (#${pre.invoiceRef})` : ''} is marked settled; with this change <strong>{nprExact(d.owedAgain)}</strong> is owed on it again and the bill moves back to Outstanding Payables.</p>,
        run: async () => {
          setReturnSaving(true)
          // Read again, fresh, as the delete does: the dialog may have stood open.
          const fresh = await readReturnBill(original, next)
          if (fresh.error) { refuseEditUnchecked(fresh.error); setReturnSaving(false); onChanged(); return }
          await writeReturnEdit(id, payload, fresh)
        },
      })
      return
    }
    const { error } = await scopedInsert('vendor_returns', payload)
    if (error) { const a = asActionError(error); setReturnError({ text: 'The return was not recorded. ' + a.text, detail: a.detail }); setReturnSaving(false); return }
    finishSave()
  }

  function finishSave() {
    setReturnSaving(false)
    setShowReturnForm(false)
    setEditingReturnId(null)
    onChanged()
  }

  // The edit's writes, in the delete's order: the stamps first (the write that can refuse), then
  // the return, and the stamps put back if the return did not land. `bill` is readReturnBill's.
  async function writeReturnEdit(id, payload, bill) {
    const d = bill.decision
    const name = billName(bill.invoiceRef)
    let cleared = []
    if (d?.reopen) {
      const c = await clearStamps(d, bill.lines)
      if (c.failed) {
        setReturnError(clearFailureText(c, { lead: 'The return was not updated', change: 'this change', name, owedAgain: d.owedAgain, askTo: 'make this change' }))
        setReturnSaving(false); onChanged(); return
      }
      cleared = c.cleared
    }
    // `.select('id')` (S756): an update an RLS policy filters to nothing is `error: null`, so the
    // form closed as if saved over a return that had not changed. Zero rows back is proof.
    const { data: updated, error } = await scopedUpdate('vendor_returns', payload).eq('id', id).select('id')
    if (!error && updated?.length) { finishSave(); return }
    // A lost response is not a refusal: the update may have landed (S792 stage 2 review, P2).
    // Look before undoing anything, and claim nothing a look could not settle.
    const landed = error && isNetworkError(error) ? await returnWriteLanded(id, payload) : false
    if (landed === true) { finishSave(); return }
    if (landed === null) {
      const a = asActionError(error)
      setReturnError({ text: `Crest lost the connection while saving this return and could not check whether the change went through.${cleared.length ? ` ${name} was already moved back to Outstanding Payables for it.` : ''} Saving again is safe either way — press Update Return once the connection is back. ${a.text}`, detail: a.detail })
      setReturnSaving(false); onChanged(); return
    }
    const billState = await putBillBack(bill.lines, cleared, name)
    if (error) {
      const a = asActionError(error)
      setReturnError({ text: `The return was not updated — it still shows its previous figures.${billState} ${a.text}`, detail: a.detail })
    } else {
      setReturnError(`The return was not updated — it still shows its previous figures.${billState} It may have been deleted since you opened it (the list behind this form has been reloaded), or your login is not allowed to change it — ask your manager or the Owner.`)
    }
    setReturnSaving(false); onChanged()
  }

  // ── Deleting a return from a settled bill (S792 stage 2) ─────────────────────────────────────
  //
  // A return lowers what its bill owes, so a bill can be settled BY one: paid down to what the
  // return left, or closed from Outstanding Payables once its goods all went back ("Close this
  // bill", PURCHASES-8). Deleting that return makes the bill owe again — and its `paid_at` stamps
  // still file it under Paid History, where nothing can be paid on it and no total counts it as
  // owed. So the delete reads the bill first, and when returnChangeReopensBill says the bill is
  // settled now and would owe money without this return, the stamps are cleared and the bill goes
  // back to Outstanding Payables with the right balance. A stamp with no payment rows behind it on
  // a bill whose figures never showed it settled is a bill paid before payable_payments existed,
  // and is left alone (the helper's rule).
  //
  // Every line of the bill, every return against those lines from ANY month (a late return sits
  // in its own month, D10), and every payment on them — resolves { lines, invoiceRef, decision }
  // (decision null when the return belongs to no bill) or { error }. A bill written before grouping
  // has no purchase_group_id and is its own single line, as Outstanding Payables treats it. `next`
  // is an edit's return as it will be written (saveReturn); without it the question is a delete.
  async function readReturnBill(ret, next = null) {
    if (!ret.purchase_entry_id) return { decision: null }   // an unlinked return belongs to no bill
    const { data: line, error: lineErr } = await supabase.from('purchase_entries').select(BILL_LINE_COLUMNS).eq('id', ret.purchase_entry_id).maybeSingle()
    if (lineErr) return { error: lineErr }
    if (!line) return { decision: null }
    let lines = [line]
    if (line.purchase_group_id) {
      const { data, error } = await fetchAllRows(() => supabase.from('purchase_entries').select(BILL_LINE_COLUMNS)
        .eq('purchase_group_id', line.purchase_group_id).order('id'))
      if (error) return { error }
      if (data?.length) lines = data
    }
    const ids = lines.map(l => l.id)
    const [rets, pays] = await Promise.all([
      fetchAllRowsChunked(ids, chunk => scopedFrom('vendor_returns', 'id, purchase_entry_id, qty, rate').in('purchase_entry_id', chunk).order('id')),
      fetchAllRowsChunked(ids, chunk => scopedFrom('payable_payments', 'id, purchase_entry_id, amount').in('purchase_entry_id', chunk).order('id')),
    ])
    const failed = rets.error || pays.error
    if (failed) return { error: failed }
    return {
      lines,
      invoiceRef: line.invoice_ref,
      decision: next
        ? returnEditReopensBill({ lines, returns: rets.data, payments: pays.data, returnId: ret.id, next })
        : returnChangeReopensBill({ lines, returns: rets.data, payments: pays.data, returnId: ret.id }),
    }
  }

  // A check that could not run has not passed: the delete is refused rather than risk leaving a
  // bill filed as settled while it owes money.
  function refuseUnchecked(error) {
    const { text, detail } = asActionError(error)
    setActionError({ text: `This return is still recorded — it was not deleted. Crest could not check whether its bill is settled, and deleting a return from a settled bill has to move that bill back to Outstanding Payables. Try again in a moment. ${text}`, detail })
  }

  // The same refusal for an edit, in the form.
  function refuseEditUnchecked(error) {
    const { text, detail } = asActionError(error)
    setReturnError({ text: `The return was not updated — it still shows its previous figures. Crest could not check whether its bill is settled, and changing a return on a settled bill can move that bill back to Outstanding Payables. Try again in a moment. ${text}`, detail })
  }

  const billName = ref => (ref ? `Bill #${ref}` : 'Its bill')

  // Puts back the stamps cleared before a delete that then did not land, each line's own date.
  async function restoreStamps(lines, clearedIds) {
    const byDate = new Map()
    lines.filter(l => clearedIds.includes(l.id) && l.paid_at).forEach(l => {
      byDate.set(l.paid_at, [...(byDate.get(l.paid_at) || []), l.id])
    })
    for (const [date, ids] of byDate) {
      const { data, error } = await supabase.from('purchase_entries').update({ paid_at: date }).in('id', ids).select('id')
      if (error || (data?.length || 0) < ids.length) return false
    }
    return true
  }

  // What the sentence says about a bill whose stamps were cleared for a return write that then did
  // not land: put back, or — if that failed too — where it is now and the way out.
  async function putBillBack(lines, cleared, name) {
    if (!cleared.length) return ''
    return (await restoreStamps(lines, cleared))
      ? ` ${name} is still settled, as it was.`
      : ` ${name} was moved back to Outstanding Payables on the way and could not be put back: it owes nothing there, so open Outstanding Payables and use Close this bill on it.`
  }

  // Clears a settled bill's stamps before the return write that makes it owe again. It goes FIRST
  // because it is the write that can refuse: it needs a manager where the return needs any IMS
  // login, so refused here nothing has changed. Only `paid_at` changes, so a closed month's guard
  // lets it through (closed-periods.md). `.select('id')`: an update filtered to nothing is
  // `error: null`. A lost response may have cleared them after all, so the stamps are put back —
  // safe whether or not the clear landed — and only a failed put-back leaves the bill uncertain.
  // Resolves { cleared } or { failed, error, uncertain }.
  async function clearStamps(d, lines) {
    const { data, error } = await supabase.from('purchase_entries').update({ paid_at: null }).in('id', d.stampedIds).select('id')
    if (!error && data?.length) return { cleared: data.map(r => r.id) }
    const uncertain = !!error && isNetworkError(error) && !(await restoreStamps(lines, d.stampedIds))
    return { failed: true, error, uncertain }
  }

  // The sentence for a clear that did not go through. The return write was never sent, so `lead`
  // (what is still as it was) holds whatever happened to the bill; "nothing was changed" only when
  // the bill is known to be as it was too.
  function clearFailureText(c, { lead, change, name, owedAgain, askTo }) {
    const a = c.error ? asActionError(c.error) : null
    const why = c.uncertain
      ? 'the connection dropped while it was being moved, so Crest cannot tell whether it moved. If it now shows on Outstanding Payables owing nothing, use Close this bill on it there.'
      : c.error ? 'that could not be done.'
      : `this login is not allowed to reopen it. Ask an IMS manager or the Owner to ${askTo}.`
    return {
      text: `${lead}${c.uncertain ? '.' : ' — nothing was changed.'} ${name} is marked settled, and ${change} means ${nprExact(owedAgain)} is owed on it again, so the bill has to move back to Outstanding Payables first — and ${why}${a ? ` ${a.text}` : ''}`,
      detail: a?.detail || (c.error ? undefined : 'purchase_entries paid_at update matched 0 rows'),
    }
  }

  // After a return write whose response was lost (isNetworkError), whether it landed, read back —
  // a dead fetch proves only that the answer did not arrive (error-messages.md), and the bill's
  // stamps may be put back only if the write really did not. A delete landed when the row is gone;
  // an update when the row holds what was sent. Resolves true, false, or null when the read-back
  // failed too — then nothing is undone and the sentence says what cannot be known.
  async function returnWriteLanded(id, sent = null) {
    const { data, error } = await scopedFrom('vendor_returns', 'id, period_id, purchase_entry_id, qty, bs_day, notes').eq('id', id).maybeSingle()
    if (error) return null
    if (!sent) return !data
    if (!data) return false   // gone: an update had nothing to land on
    return data.period_id === sent.period_id && data.purchase_entry_id === sent.purchase_entry_id
      && Math.abs((parseFloat(data.qty) || 0) - sent.qty) < 1e-9
      && data.bs_day === sent.bs_day && (data.notes || null) === sent.notes
  }

  async function deleteReturn(ret) {
    if (checkingId) return
    setActionError(null)
    const value = (parseFloat(ret.qty) || 0) * (parseFloat(ret.rate) || 0)
    setCheckingId(ret.id)
    const pre = await readReturnBill(ret)
    setCheckingId(null)
    if (pre.error) { refuseUnchecked(pre.error); return }
    const reopening = !!pre.decision?.reopen
    if (reopening && !canReopenBills) {
      setActionError(`This return is still recorded — it was not deleted. ${billName(pre.invoiceRef)} is marked settled, and deleting this return means ${nprExact(pre.decision.owedAgain)} is owed on it again, so the bill has to move back to Outstanding Payables. Reopening a settled bill needs an IMS manager or the Owner — ask one of them to delete this return.`)
      return
    }
    // The product's own consequence dialog, with the money in it (S682 moved bill delete off
    // window.confirm; this one had been left behind). And the delete's error is READ: a bare
    // await meant a refused delete reloaded the same rows and the return "came back" unexplained.
    askConfirm({
      title: 'Delete this return?',
      confirmLabel: 'Delete Return', danger: true, busyLabel: 'Deleting…',
      body: <>
        <p style={{ margin: 0 }}>{ret.items?.name || 'This return'}, NPR {Math.round(value).toLocaleString('en-IN')}, goes back onto this period's net purchases and the vendor's payable. This cannot be undone.</p>
        {reopening && (
          <p style={{ margin: '8px 0 0' }}>
            This bill{pre.invoiceRef ? ` (#${pre.invoiceRef})` : ''} is marked settled; deleting the return means <strong>{nprExact(pre.decision.owedAgain)}</strong> is owed again and the bill moves back to Outstanding Payables.
          </p>
        )}
      </>,
      run: async () => {
        setActionError(null)
        // Read again, fresh: the dialog may have stood open while a payment was recorded or the
        // bill was closed, and the stamp must follow the bill as it is at the moment of the delete.
        const fresh = await readReturnBill(ret)
        if (fresh.error) { refuseUnchecked(fresh.error); onChanged(); return }
        const d = fresh.decision
        const name = billName(fresh.invoiceRef)
        // The stamp is cleared FIRST (clearStamps says why), so a refusal there changes nothing.
        let cleared = []
        if (d?.reopen) {
          const c = await clearStamps(d, fresh.lines)
          if (c.failed) {
            setActionError(clearFailureText(c, { lead: 'This return is still recorded', change: 'deleting this return', name, owedAgain: d.owedAgain, askTo: 'delete this return' }))
            onChanged()
            return
          }
          cleared = c.cleared
        }
        const { data: removed, error } = await scopedDelete('vendor_returns').eq('id', ret.id).select('id')
        if (error || !removed?.length) {
          // A lost response is not a refusal: the delete may have landed (S792 stage 2 review, P2),
          // and re-stamping the bill then would file it as settled while it owes. Look first.
          const landed = error && isNetworkError(error) ? await returnWriteLanded(ret.id) : false
          if (landed === true) { onChanged(); return }   // it went through, and the bill is where it belongs
          if (landed === null) {
            const a = asActionError(error)
            setActionError({ text: `Crest lost the connection while deleting this return and could not check whether the delete went through.${cleared.length ? ` ${name} was already moved back to Outstanding Payables for it.` : ''} Once the connection is back, look for the return in the list below: if it is gone, it was deleted; if it is still there, delete it again — that is safe either way. ${a.text}`, detail: a.detail })
            onChanged()
            return
          }
          // The delete did not land, so the bill is put back exactly as it was.
          const billState = await putBillBack(fresh.lines, cleared, name)
          if (error) {
            const { text, detail } = asActionError(error)
            setActionError({ text: `This return is still recorded — it was not deleted.${billState} ${text}`, detail })
          } else {
            // Zero rows removed with no error (S756): a policy filtered the delete, or it was already gone.
            setActionError(`Nothing was removed.${billState} If the return is still in the list below (it has been reloaded), your login is not allowed to delete it — ask your manager or the Owner. If it is gone, it was already deleted.`)
          }
        }
        onChanged()
      },
    })
  }

  const returnTotal = returns.reduce((s, r) => s + r.qty * r.rate, 0)

  // ─── The form's derived lists ───────────────────────────
  const billPid = returnForm.bill_period_id || period?.id || ''
  const billPeriod = periodById[billPid] || period
  const billState = billPid === period?.id ? { rows: purchases, error: null, loading: false } : (billLinesByPeriod[billPid] || { rows: null, error: null, loading: true })
  const billStateRows = billState.rows
  const monthLines = useMemo(() => billStateRows || [], [billStateRows])
  // An edited return whose bill is older than the picker's window still names its own month.
  const billPeriodOptions = billPeriods.some(p => p.id === billPid) || !periodById[billPid]
    ? billPeriods
    : [...billPeriods, periodById[billPid]]
  const billReadError = billState.error ? asActionError(billState.error) : null
  const vendorOptions = useMemo(() => {
    const seen = new Map()
    monthLines.forEach(p => { if (p.vendor_id && !seen.has(p.vendor_id)) seen.set(p.vendor_id, p.vendors?.name || 'Unnamed vendor') })
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [monthLines])
  const lineOptions = useMemo(() => monthLines
    .filter(p => !returnForm.vendor_filter || p.vendor_id === returnForm.vendor_filter)
    .map(p => {
      const cf = getCf(p.items)
      const dQty  = cf > 1 ? p.qty / cf : p.qty
      const dUnit = cf > 1 ? p.items?.purchase_unit : p.items?.uom
      const dRate = cf > 1 ? p.rate * cf : p.rate
      return {
        value: p.id,
        label: `${formatBsDay(p.bs_day, billPeriod?.bs_month) || 'No day'} · ${p.items?.name || 'Item'} · ${Number(dQty).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${dUnit || ''} @ NPR ${fmtLineRate(dRate)} (${p.payment_method || 'Cash'})${p.vendors?.name ? ` — ${p.vendors.name}` : ''}${p.invoice_ref ? ` #${p.invoice_ref}` : ''}`,
      }
    }), [monthLines, returnForm.vendor_filter, billPeriod])

  const linkedForForm = returnForm.purchase_entry_id ? getLinkedPurchase(returnForm.purchase_entry_id) : null
  const isLateBill = !!linkedForForm && linkedForForm.period_id !== period?.id

  return (
    <>
      {purchases.length === 0 && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }}>
          No purchases in this month yet. You can still record a return here against a bill from an earlier month.
        </div>
      )}

      {/* Return Add/Edit Form */}
      {showReturnForm && (
        <Modal onClose={() => { setShowReturnForm(false); setEditingReturnId(null) }} title={editingReturnId ? 'Edit Return' : 'Record Return to Vendor'}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="form-field">
              <label htmlFor="return-bill-month"><Tip text={`The month the goods were BOUGHT. Usually this month — pick an earlier one (up to ${LATE_RETURN_MONTHS} months back) when the goods go back after the month they came in. The return itself is still recorded in ${monthLabel(period)}, the month it happened.`} width={300}>Bill from</Tip></label>
              <select id="return-bill-month" className="form-select"
                value={billPid}
                onChange={e => {
                  const pid = e.target.value
                  ensureLines(pid)
                  loadPrior(null)
                  setDayErr('')
                  setReturnForm(f => ({ ...f, bill_period_id: pid, vendor_filter: '', purchase_entry_id: '', qty: '' }))
                }}>
                {billPeriodOptions.map(p => (
                  <option key={p.id} value={p.id}>{monthLabel(p)}{p.id === period?.id ? ' (this month)' : ''}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="return-vendor-filter"><Tip text="Narrow the bill lines below to one supplier. Optional." width={220}>Supplier</Tip></label>
              <select id="return-vendor-filter" className="form-select"
                value={returnForm.vendor_filter}
                onChange={e => setReturnForm(f => ({ ...f, vendor_filter: e.target.value, purchase_entry_id: '', qty: '' }))}>
                <option value="">All suppliers</option>
                {vendorOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="return-f1">Bill line to return against *</label>
            {billReadError ? (
              <ActionError error={{ text: `${monthLabel(billPeriod)}'s bills could not be read, so there is nothing to pick from yet — this is a failed read, not a month without bills. ${billReadError.text}`, detail: billReadError.detail }} />
            ) : null}
            {billReadError ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => ensureLines(billPid)}>Try reading {monthLabel(billPeriod)} again</button>
            ) : billState.loading ? (
              <p style={{ margin: '6px 0', fontSize: 13, color: 'var(--theme-text2)' }}>Loading {monthLabel(billPeriod)}'s bills…</p>
            ) : monthLines.length === 0 ? (
              <p style={{ margin: '6px 0', fontSize: 13, color: 'var(--theme-text2)' }}>No purchase bills in {monthLabel(billPeriod)}. Pick another month above.</p>
            ) : (
              <SearchableSelect
                id="return-f1"
                value={returnForm.purchase_entry_id}
                placeholder="— Search by item, supplier or bill no. —"
                options={lineOptions}
                onChange={v => {
                  // Pre-fill the day from a SAME-month bill; the reader corrects it only when the
                  // goods went back on a later day. An earlier month's day number means nothing in
                  // this month, so the day is left for the reader to pick.
                  const linked = linesFor(billPid).find(p => p.id === v)
                  setDayErr('')
                  loadPrior(v || null)
                  setReturnForm(f => ({
                    ...f, purchase_entry_id: v, qty: '',
                    bs_day: linked?.period_id === period?.id && linked?.bs_day ? String(linked.bs_day) : f.bs_day,
                  }))
                }}
              />
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 16 }}>
            <div className="form-field">
              {(() => {
                const linked = linkedForForm
                const cf = getCf(linked?.items)
                const inputUnit = cf > 1 ? linked.items.purchase_unit : (linked?.items?.uom || '')
                const { remaining } = linked ? remainingReturnableQty(linked.qty, prior.lineId === linked.id ? prior.rows : [], editingReturnId) : { remaining: 0 }
                const inUnits = q => (cf > 1 ? q / cf : q)
                return (
                  <>
                    <label htmlFor="return-f2">Return Qty {inputUnit ? `(${inputUnit})` : ''} *</label>
                    <input id="return-f2"
                      type="number" min="0.001" step="any"
                      value={returnForm.qty}
                      onChange={e => setReturnForm(f => ({ ...f, qty: e.target.value }))}
                      placeholder={linked && !prior.loading && !prior.error ? `Max ${Number(Math.max(0, inUnits(remaining))).toLocaleString(undefined, { maximumFractionDigits: 3 })}` : '0'}
                    />
                    {linked && (
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 4 }}>
                        Bought: {cf > 1
                          ? `${(linked.qty / cf).toLocaleString(undefined, { maximumFractionDigits: 3 })} ${linked.items.purchase_unit} (${Number(linked.qty).toLocaleString('en-IN')} ${linked.items?.uom})`
                          : `${Number(linked.qty).toLocaleString('en-IN')} ${linked.items?.uom}`}
                      </div>
                    )}
                    {linked && prior.lineId === linked.id && !prior.loading && !prior.error && (prior.rows || []).some(r => r.id !== editingReturnId) && (
                      <div style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 2 }}>
                        <Tip text="Every return already recorded against this bill line, in any month. Only what is left can still go back." width={240}>
                          Already returned: {Number(inUnits(remainingReturnableQty(linked.qty, prior.rows, editingReturnId).prior)).toLocaleString(undefined, { maximumFractionDigits: 3 })} {inputUnit}
                        </Tip>
                      </div>
                    )}
                    {linked && prior.error && (
                      <div style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 2 }}>Could not check earlier returns on this line — Save will check again.</div>
                    )}
                    {cf > 1 && returnForm.qty && (
                      <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 2 }}>
                        = {(parseFloat(returnForm.qty) * cf).toLocaleString('en-IN')} {linked?.items?.uom}
                      </div>
                    )}
                  </>
                )
              })()}
            </div>

            <div className="form-field">
              <label htmlFor="return-f4"><Tip text={`The day the goods actually went back to the vendor, in ${monthLabel(period)}. Pre-filled with the bill's day when the bill is from this month; change it if the return happened later. Vendor ledgers and balance letters date the return by this.`} width={280}>Day Returned *</Tip></label>
              <BsCalendarPicker id="return-f4" lockYear={period?.bs_year} lockMonth={period?.bs_month} value={returnForm.bs_day}
                onChange={d => { setDayErr(''); setReturnForm(f => ({ ...f, bs_day: d })) }} placeholder="Pick day" invalid={dayErr} />
              <FieldError id="return-f4" message={dayErr} />
            </div>

            <div className="form-field">
              <label htmlFor="return-f3">Notes (optional)</label>
              <input id="return-f3"
                value={returnForm.notes}
                onChange={e => setReturnForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Reason for return, damaged batch, etc."
              />
            </div>
          </div>

          {/* A return against an earlier month's bill counts in THIS month (D10). Say so before it
              is saved, and say the part Crest cannot decide: which month the VAT on it belongs in. */}
          {isLateBill && (
            <div role="note" style={{ marginTop: 12, padding: '10px 14px', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text2)', border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', borderRadius: 'var(--radius-sm)' }}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>This bill is from {monthLabel(periodById[linkedForForm.period_id])}.</strong>{' '}
              The return is recorded in {monthLabel(period)} — the month the goods went back — so it lowers {monthLabel(period)}'s
              net purchases and appears in {monthLabel(period)}'s VAT Report. {monthLabel(periodById[linkedForForm.period_id])} is not changed.
              Which month the VAT on a return like this should be claimed in is a question for your accountant — confirm it with them before filing.
            </div>
          )}

          {/* Auto-inherited fields preview */}
          {linkedForForm && (() => {
            const linked = linkedForForm
            const cf = getCf(linked.items)
            const displayRate = cf > 1 ? linked.rate * cf : linked.rate
            const displayRateUnit = cf > 1 ? linked.items?.purchase_unit : linked.items?.uom
            const baseRetQty = returnForm.qty ? parseFloat(returnForm.qty) * cf : 0
            const retValue = baseRetQty * linked.rate
            return (
              <div style={{ marginTop: 12, padding: '10px 14px', background: 'color-mix(in srgb, var(--theme-red) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 15%, transparent)', borderRadius: 'var(--radius-sm)', fontSize: 13, color: 'var(--theme-text2)', display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                <span>Rate: <strong style={{ color: 'var(--theme-text1)' }}>NPR {fmtLineRate(displayRate)}/{displayRateUnit}</strong></span>
                <span>Vendor: <strong style={{ color: 'var(--theme-text1)' }}>{linked.vendors?.name || '—'}</strong></span>
                <span>Payment: <strong style={{ color: 'var(--theme-text1)' }}>{linked.payment_method || 'Cash'}</strong></span>
                {retValue > 0 && <span>Return Value: <strong style={{ color: 'var(--theme-red-text)' }}>−NPR {retValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</strong></span>}
                <span style={{ color: 'var(--theme-text3)', fontSize: 11 }}>Rate, vendor & payment inherited from original purchase</span>
              </div>
            )
          })()}

          <ActionError error={returnError} />
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => { setShowReturnForm(false); setEditingReturnId(null) }}>Cancel</button>
            {/* .btn-danger, not a solid --theme-red fill: red has no paired foreground token (it ranges
                from #f87171 on Dark to #dc2626 on Bright), which is why this had to compute a
                black/white foreground at runtime. The variant is the documented tint pattern. */}
            <button className="btn btn-danger" onClick={saveReturn} disabled={returnSaving}>
              {returnSaving ? 'Saving…' : editingReturnId ? 'Update Return' : 'Record Return'}
            </button>
          </div>
        </Modal>
      )}

      <ActionError error={actionError} />

      {/* Returns table */}
      <div className="card">
        {returns.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">↩</div>
            <p className="empty-state-text">No returns recorded for this period. Click + Add Return to record a vendor return.</p>
          </div>
        ) : (
          <div className="table-wrap table-wrap--fab-clear">
            <table className="data-table">
              <thead>
                <tr>
                  <th><Tip text="Day of the Nepali month the goods went back to the vendor — not the day the bill was raised." width={250}>Day</Tip></th>
                  <th><Tip text="The day of the bill these goods came in on. A different month here means the goods were bought in that month and returned in this one — the return counts in this month." width={270}>Bill Date</Tip></th>
                  <th>Item</th><th>Vendor</th>
                  <th style={{ textAlign: 'right' }}><Tip text="How much went back, in the item's base unit. e.g. a 12-bottle crate returned on an item tracked in bottles shows 12." width={260}>Returned Qty</Tip></th>
                  <th>UOM</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Rate per base unit, inherited from the original purchase — a return is credited at what you paid, not at today's price." width={260}>Rate</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Returned Qty × Rate. This is subtracted from the vendor's purchases everywhere in IMS, so net purchases and COGS both drop by it." width={270}>Return Value</Tip></th>
                  <th><Tip text="Whether the original bill was Cash or Credit. A Cash return is money back; a Credit return reduces what you still owe that vendor." width={260}>Payment</Tip></th>
                  <th>Notes</th><th></th>
                </tr>
              </thead>
              <tbody>
                {returns.map(ret => {
                  const bill = ret.purchase_entries
                  const billMonth = bill?.monthly_periods
                  const lateBill = !!bill && bill.period_id !== period?.id
                  return (
                  <tr key={ret.id}>
                    <td style={{ fontWeight: 700, color: 'var(--theme-accent-ink)', whiteSpace: 'nowrap' }}>{formatBsDay(ret.bs_day, period?.bs_month) || '—'}</td>
                    <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                      {!bill ? (
                        <Tip text="The bill this return was made against has since been deleted or re-saved, so the return is no longer linked to it. It still counts in this month's returns." width={260}>
                          <span style={{ color: 'var(--theme-text3)' }}>Bill unlinked</span>
                        </Tip>
                      ) : (
                        <>
                          <span style={{ whiteSpace: 'nowrap' }}>{formatBsDay(bill.bs_day, billMonth?.bs_month ?? period?.bs_month) || '—'}{lateBill && billMonth ? ` ${billMonth.bs_year}` : ''}</span>
                          {lateBill && <span className="badge badge-yellow" style={{ marginLeft: 6 }}>earlier month</span>}
                          {bill.invoice_ref && <span style={{ display: 'block', whiteSpace: 'nowrap', fontSize: 11, color: 'var(--theme-text3)' }}>#{bill.invoice_ref}</span>}
                        </>
                      )}
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{ret.items?.name}</td>
                    <td style={{ color: 'var(--theme-text2)' }}>{ret.vendors?.name || <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                    {(() => {
                      const cf = getCf(ret.items)
                      const displayQty  = cf > 1 ? ret.qty / cf : ret.qty
                      const displayUnit = cf > 1 ? ret.items.purchase_unit : ret.items?.uom
                      const displayRate = cf > 1 ? ret.rate * cf : ret.rate
                      return (
                        <>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontWeight: 600 }}>
                            −{Number(displayQty).toLocaleString(undefined, { maximumFractionDigits: 3 })}
                            {cf > 1 && <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{Number(ret.qty).toLocaleString('en-IN')} {ret.items?.uom}</div>}
                          </td>
                          <td style={{ color: 'var(--theme-text2)' }}>{displayUnit}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtLineRate(displayRate)}</td>
                        </>
                      )
                    })()}
                    <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontWeight: 700 }}>
                      −NPR {(ret.qty * ret.rate).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td>
                      {/* badge-yellow for Credit, as the Purchases tab: a credit bill is a normal
                          commercial arrangement, not a fault, and red is this product's warning. */}
                      <span className={`badge ${ret.payment_method === 'Cash' ? 'badge-green' : ret.payment_method === 'Credit' ? 'badge-yellow' : 'badge-purple'}`}>
                        {ret.payment_method || 'Cash'}
                      </span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{ret.notes || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {!isLocked && (
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEditReturn(ret)}>Edit</button>
                          {/* Reads the return's bill before asking (S792 stage 2), so it says so while it does. */}
                          <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteReturn(ret)} disabled={!!checkingId}>
                            {checkingId === ret.id ? 'Checking…' : 'Del'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  )
                })}
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td colSpan={7} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total Returns</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', fontSize: 14, paddingTop: 12 }}>
                    −NPR {returnTotal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td colSpan={3}></td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
      {/* No longer needs a purchase in THIS month (S756, D10): the bill may be an earlier month's. */}
      <Fab onClick={openNewReturn} label="+ Add Return" show={!isLocked && !showReturnForm && !!period} />
      {confirmEl}
    </>
  )
}
