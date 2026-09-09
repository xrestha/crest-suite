import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { BS_MONTHS, getBsToday, daysInBsMonth, formatAdAsBs } from '../../../utils/bsCalendar'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import Fab from '../../../components/Fab'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { printWithTitle } from '../../../utils/printTitle'
import { Navigate, Link } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import ActionError, { asActionError } from '../../../components/ActionError'
import ReportLoadError from '../../../components/ReportLoadError'
import { firstError } from '../../../shared/queryError'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { withTimeout } from '../../../utils/withTimeout'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { PURCHASE_PAYMENT_METHODS } from './purchasesHelpers'

// Quantities are numeric(12,3) in the database, and every one of these figures has been through
// `parseFloat` on the way here. Without this, ordering 0.3 and receiving 0.1 twice leaves
// 0.09999999999999999 "still on order" — a Remaining column that will not reach zero, a PO stuck
// on Partial forever, and (before S709) a refusal that printed those seventeen digits at the user.
// Three decimals, because that is what the column stores; anything finer is not a quantity.
const round3 = n => Math.round((parseFloat(n) || 0) * 1000) / 1000

const STATUS_META = {
  draft:     { label: 'Draft',     color: 'var(--theme-text2)', bg: 'color-mix(in srgb, var(--theme-text2) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-text2) 30%, transparent)' },
  sent:      { label: 'Sent',      color: 'var(--theme-purple-text)', bg: 'color-mix(in srgb, var(--theme-purple) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-purple) 30%, transparent)' },
  partial:   { label: 'Partial',   color: 'var(--theme-accent-ink)', bg: 'color-mix(in srgb, var(--theme-accent) 10%, transparent)',  border: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' },
  received:  { label: 'Received',  color: 'var(--theme-green-text)', bg: 'color-mix(in srgb, var(--theme-green) 10%, transparent)',  border: 'color-mix(in srgb, var(--theme-green) 30%, transparent)' },
  cancelled: { label: 'Cancelled', color: 'var(--theme-red-text)', bg: 'color-mix(in srgb, var(--theme-red) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' },
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.draft
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 'var(--radius-xs)',
      color: m.color, background: m.bg, border: `1px solid ${m.border}`, letterSpacing: '0.04em' }}>
      {m.label}
    </span>
  )
}

export default function PurchaseOrders() {
  const { clientId, profile, isAdmin, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()

  // Deliberately NOT on sessionDataCache (S460): the page's core content is the PO list, and
  // confirmReceive writes `qty_received + receiving` off that state — a read-modify-write
  // baseline — so a stale cached row could double-count a delivery. Caching only the reference
  // lists would be invisible, since the skeleton must stay up until the PO list loads anyway.
  const [periods,        setPeriods]        = useState([])
  const periodReq = useLatestRequest()
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [vendors,        setVendors]        = useState([])
  const [items,          setItems]          = useState([])
  const [pos,            setPos]            = useState([])
  const [loading,        setLoading]        = useState(true)
  const [view,           setView]           = useState('list') // list | form | receive
  // The three list-row actions below (Mark Sent, Cancel, Delete) all discarded their write error,
  // so a refusal reloaded the same row unchanged and read as "that did nothing because it was
  // already in that state". `formError`/`receiveError` belong to the other two views.
  const [listError,      setListError]      = useState(null)
  // A failed READ, which is a different fact from an empty period and must never render as one
  // (S594/S612). Every read on this page dropped its error until S709: a failed periods read wore
  // `NoPeriodState` — "no periods yet, create one" — and a failed PO read wore the empty state,
  // which invites raising a second PO for an order that already exists.
  const [loadError,      setLoadError]      = useState(null)
  // po_id -> { count, total } for the bills received against each PO (S709). `null` means the
  // lookup itself failed or has not run: unknown is not zero, so nothing renders from it.
  const [receipts,       setReceipts]       = useState(null)

  // Form state
  const [editingPo,  setEditingPo]  = useState(null)
  const [poForm,     setPoForm]     = useState({ vendor_id: '', period_id: '', notes: '', expected_date: '' })
  const [poItems,    setPoItems]    = useState([{ _key: Date.now(), item_id: '', qty_ordered: '', unit_price: '' }])
  const [saving,     setSaving]     = useState(false)
  const [formError,  setFormError]  = useState('')

  // Receive (GRN) state
  const [receivingPo,    setReceivingPo]    = useState(null)
  const [receiveLines,   setReceiveLines]   = useState([])
  const [receiveBsDay,   setReceiveBsDay]   = useState('')
  const [receivePayment,      setReceivePayment]      = useState('Credit')
  const [receiveVatInclusive, setReceiveVatInclusive] = useState(false)
  const [receiveError,   setReceiveError]   = useState('')
  const [receiveSaving,  setReceiveSaving]  = useState(false)
  const [openingReceive, setOpeningReceive] = useState(null)  // po id whose lines are being re-read

  const [filterStatus, setFilterStatus] = useState('all')
  const [printPo,      setPrintPo]      = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line

  useEffect(() => {
    if (!printPo) return
    const t = setTimeout(() => { printWithTitle(`Purchase Order - ${printPo.po_number}`); setPrintPo(null) }, 80)
    return () => clearTimeout(t)
  }, [printPo])

  async function init() {
    setLoading(true)
    setLoadError(null)
    const results = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('vendors').eq('is_active', true).order('name'),
      // Only what the page reads. It selected `*, categories(name)` — the category was never
      // rendered anywhere on this screen, so every visit paid for a join it threw away.
      scopedFrom('items', 'id, name, uom, per_uom_rate').eq('is_active', true).eq('is_sub_recipe', false).order('name'),
    ])
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setLoading(false); return }
    const [{ data: p }, { data: v }, { data: i }] = results
    setPeriods(p || [])
    setVendors(v || [])
    setItems(i || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) {
      // Claim the page for the auto-selected period — the hook's own contract, and the same miss
      // S698 fixed in Purchases.js. Without it a period change during this first load can be
      // overwritten by the load that started before it.
      periodReq.begin(open.id)
      setSelectedPeriod(open)
      await loadPos(open.id)
    }
    setLoading(false)
  }

  async function loadPos(periodId) {
    const { data, error } = await scopedFrom('purchase_orders', '*, vendors(name), purchase_order_items(*, items(name, uom))')
      .eq('period_id', periodId)
      .order('created_at', { ascending: false })
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    if (error) { setLoadError(error.message || String(error)); return }
    setLoadError(null)
    setPos(data || [])
    await loadReceipts(data || [], periodId)
  }

  // What has actually been BILLED against each PO, through the `po_id` link added in S709. Before
  // that link existed the only trace was `invoice_ref = po_number` — free text anyone can edit in
  // Purchases — so the receive screen could not say what the order had already produced, and
  // deleting a bill left its PO reading Received with nothing to show otherwise.
  //
  // A failure here leaves `receipts` null rather than an empty map: this figure is supplementary,
  // so it must not take the page down, and it equally must not render "no bills yet" for a lookup
  // that never answered. Receipts written before the migration carry no po_id and cannot appear.
  async function loadReceipts(rows, periodId) {
    const ids = rows.map(r => r.id)
    if (ids.length === 0) { setReceipts({}); return }
    const { data, error } = await supabase.rpc('purchase_order_receipts', { p_ids: ids })
    if (!periodReq.isCurrent(periodId)) return
    if (error) { setReceipts(null); return }
    setReceipts(Object.fromEntries((data || []).map(r =>
      [r.ref_po_id, { count: Number(r.entry_count) || 0, total: parseFloat(r.entry_total) || 0 }])))
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setView('list')
    await loadPos(periodId)
  }

  // Paged (S709). A bare `.select()` stops at PostgREST's 1000 rows with no error and nothing in
  // the data to say so, and this one takes a MAX over what it gets back — so past a thousand orders
  // the highest number could sit just outside the window and the next PO would reuse a number that
  // already exists. The unique constraint would catch the collision and the retry below would loop
  // on the same wrong answer three times. Sorting by po_number instead is not the shortcut it
  // looks: 'PO-1000' sorts BELOW 'PO-999' as text, so the string order is wrong at exactly the
  // volume the cap starts mattering.
  async function getNextPoNumber() {
    const { data, error } = await fetchAllRows(() => scopedFrom('purchase_orders', 'id, po_number').order('id'))
    if (error) throw error
    let maxNum = 0
    ;(data || []).forEach(po => {
      const match = (po.po_number || '').match(/^PO-(\d+)$/)
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10))
    })
    return `PO-${String(maxNum + 1).padStart(3, '0')}`
  }

  // ── Form ──────────────────────────────────────────────────

  function openNew() {
    setEditingPo(null)
    setPoForm({ vendor_id: '', period_id: selectedPeriod?.id || '', notes: '', expected_date: '' })
    setPoItems([{ _key: Date.now(), item_id: '', qty_ordered: '', unit_price: '' }])
    setFormError('')
    setView('form')
  }

  // The pickers hold ACTIVE vendors and items only, so a PO naming one that has since been
  // deactivated or archived opened with "— Select vendor —" painted over an order that has a
  // vendor: state still held the id, so it saved correctly right up until someone touched the
  // dropdown, at which point the vendor was gone with no way back to it. Fetch what the PO names
  // and the lists are missing, and label it — the same repair S698 made in PurchaseBillPage for
  // the same reason, on a page that was never swept with it.
  async function backfillPickers(po) {
    const missingVendor = po.vendor_id && !vendors.some(v => v.id === po.vendor_id) ? [po.vendor_id] : []
    const missingItems = [...new Set((po.purchase_order_items || []).map(x => x.item_id))]
      .filter(id => id && !items.some(i => i.id === id))
    if (!missingVendor.length && !missingItems.length) return
    const [xv, xi] = await Promise.all([
      missingVendor.length ? supabase.from('vendors').select('id, name').in('id', missingVendor) : Promise.resolve({ data: [] }),
      missingItems.length ? supabase.from('items').select('id, name, uom, per_uom_rate').in('id', missingItems) : Promise.resolve({ data: [] }),
    ])
    if (xv.data?.length) setVendors(prev => [...prev, ...xv.data.map(x => ({ ...x, _inactive: true }))])
    if (xi.data?.length) setItems(prev => [...prev, ...xi.data.map(x => ({ ...x, _inactive: true }))])
  }

  function openEdit(po) {
    setEditingPo(po)
    setPoForm({ vendor_id: po.vendor_id || '', period_id: po.period_id || '', notes: po.notes || '', expected_date: po.expected_date || '' })
    setPoItems((po.purchase_order_items || []).map(x => ({
      _key: x.id, id: x.id,
      item_id: x.item_id,
      qty_ordered: String(x.qty_ordered),
      unit_price: x.unit_price ? String(x.unit_price) : '',
    })))
    setFormError('')
    setView('form')
    backfillPickers(po)   // not awaited: the form is usable immediately, the labels fill in
  }

  function addPoItemRow() {
    setPoItems(prev => [...prev, { _key: Date.now(), item_id: '', qty_ordered: '', unit_price: '' }])
  }

  function removePoItemRow(key) {
    setPoItems(prev => prev.filter(x => x._key !== key))
  }

  function updatePoItem(key, field, val) {
    setPoItems(prev => prev.map(x => x._key === key ? { ...x, [field]: val } : x))
  }

  function handleItemSelect(key, itemId) {
    const item = items.find(i => i.id === itemId)
    setPoItems(prev => prev.map(x => x._key === key
      ? { ...x, item_id: itemId, unit_price: item?.per_uom_rate ? String(item.per_uom_rate) : x.unit_price }
      : x
    ))
  }

  async function savePo() {
    if (!effectiveClientId) { setFormError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    if (!poForm.vendor_id) { setFormError('Pick the vendor this order goes to.'); return }
    if (!poForm.period_id) { setFormError('Pick the period this order belongs to.'); return }
    // The form is only reachable from controls the lock hides, so this is the case where the
    // period was closed in another tab while it sat open.
    const target = periods.find(p => p.id === poForm.period_id)
    if (!isAdmin && target?.status === 'closed') {
      setFormError(`${BS_MONTHS[target.bs_month - 1]} ${target.bs_year} is closed, so nothing can be saved into it. Nothing has changed. Pick the open period, or ask a Crest operator.`)
      return
    }
    const validItems = poItems.filter(x => x.item_id && parseFloat(x.qty_ordered) > 0)
    if (validItems.length === 0) { setFormError('Add at least one item with a quantity above zero — an order with no lines cannot be sent.'); return }

    setSaving(true)
    setFormError('')

    const poPayload = {
      vendor_id: poForm.vendor_id,
      period_id: poForm.period_id,
      notes: poForm.notes.trim() || null,
      expected_date: poForm.expected_date || null,
    }

    let poId
    if (editingPo) {
      const { error } = await withTimeout(scopedUpdate('purchase_orders', poPayload).eq('id', editingPo.id), 20000, 'Saving the order')
        .catch(e => ({ error: e }))
      if (error) {
        const { text, detail } = asActionError(error)
        setFormError({ text: `${text}

PO ${editingPo.po_number} still has the details it had before — nothing has changed.`, detail })
        setSaving(false); return
      }
      poId = editingPo.id
    } else {
      // getNextPoNumber() computes from in-memory state, not a DB sequence — a genuine collision
      // (two tabs, a fast double-click) is now caught by a client_id+po_number unique constraint
      // instead of silently succeeding twice. Retry with a freshly recomputed number a few times
      // before giving up, rather than surfacing a raw constraint-violation error to the user.
      let data, error
      for (let attempt = 0; attempt < 3; attempt++) {
        let poNumber
        try {
          poNumber = await withTimeout(getNextPoNumber(), 20000, 'Reading the last PO number')
        } catch (e) {
          // getNextPoNumber throws on a failed read now: numbering off a truncated or failed list
          // is how a duplicate gets minted, so not knowing the last number has to stop the save.
          error = e; break
        }
        ;({ data, error } = await withTimeout(
          scopedInsert('purchase_orders', { ...poPayload, po_number: poNumber, status: 'draft' }, { single: true }),
          20000, 'Creating the order').catch(e => ({ error: e })))
        if (!error || error.code !== '23505') break
      }
      if (error) {
        const { text, detail } = asActionError(error)
        setFormError({ text: `${text}

No purchase order was created.`, detail })
        setSaving(false); return
      }
      poId = data.id
    }

    // Insert the new line items BEFORE removing the old ones (not delete-then-insert) — if the
    // insert fails partway, the PO keeps its previous, still-valid line items instead of zero.
    const { error: itemErr } = await withTimeout(supabase.from('purchase_order_items').insert(
      validItems.map(x => ({
        po_id: poId,
        item_id: x.item_id,
        qty_ordered: round3(x.qty_ordered),
        unit_price: parseFloat(x.unit_price) || 0,
        qty_received: 0,
      }))
    ), 20000, 'Saving the order lines').catch(e => ({ error: e }))
    if (itemErr) {
      const { text, detail } = asActionError(itemErr)
      setFormError({ text: editingPo
        ? `The items were not saved, so PO ${editingPo.po_number} still has the lines it had before. ${text}`
        : `The purchase order was created but none of its items were saved, so it is now sitting in the list empty. Open it and add the items, or delete it.

${text}`, detail })
      setSaving(false); return
    }
    if (editingPo) {
      // Delete the ids this form was OPENED on, not "everything that is not what I just wrote".
      // The old form of this — `.not('id','in',(<new ids>))` — had two faults and dropped the
      // evidence of both: with an empty id list it renders as `in.()`, which PostgREST rejects
      // outright, and on any failure at all the bare `await` discarded the error and left the PO
      // holding BOTH sets of lines. A doubled PO does not look broken; it looks like an order for
      // twice as much, and it prices and receives that way. Naming the superseded ids also leaves
      // a line another user added in the meantime alone, instead of deleting it.
      const oldIds = (editingPo.purchase_order_items || []).map(x => x.id)
      if (oldIds.length) {
        const { error: delErr } = await withTimeout(
          supabase.from('purchase_order_items').delete().in('id', oldIds), 20000, 'Removing the replaced lines')
          .catch(e => ({ error: e }))
        if (delErr) {
          const { text, detail } = asActionError(delErr)
          setFormError({ text: `PO ${editingPo.po_number} now has BOTH the old lines and the new ones, so its quantities and value are doubled until that is fixed. Open it again and delete the duplicated rows. ${text}`, detail })
          setSaving(false)
          await loadPos(selectedPeriod.id)
          return
        }
      }
    }

    setSaving(false)
    // The form can put an order in a period other than the one on screen, and the list only ever
    // shows one period — so a PO saved into another month vanished on save, which reads as a save
    // that did not happen. Follow it there instead.
    const savedPeriod = periods.find(p => p.id === poForm.period_id) || selectedPeriod
    if (savedPeriod && savedPeriod.id !== selectedPeriod?.id) {
      periodReq.begin(savedPeriod.id)
      setSelectedPeriod(savedPeriod)
    }
    await loadPos(savedPeriod?.id || poForm.period_id)
    setView('list')
  }

  async function markSent(po) {
    setListError(null)
    const { error } = await scopedUpdate('purchase_orders', { status: 'sent' }).eq('id', po.id)
    if (error) {
      const { text, detail } = asActionError(error)
      setListError({ text: `PO ${po.po_number} is still showing as a draft — the change did not save. ${text}`, detail })
      return
    }
    await loadPos(selectedPeriod.id)
  }

  function cancelPo(po) {
    // "Cancel PO 1234?" in a box whose own Cancel button does the opposite is a coin toss. The
    // native dialog could only be worded around it; this one labels both buttons for what they do.
    askConfirm({
      title: `Mark PO ${po.po_number} as cancelled?`,
      body: (
        <>It stays on the list as a record, but can no longer be sent or received against.{' '}
        {po.status === 'partial' && (
          // Cancel is also how a short delivery is closed off — the vendor sent 40 of the 50 and
          // the rest is never coming — so on a part-received order this dialog has to say what
          // happens to the part that DID arrive. Its Tip used to promise "no purchase entries will
          // be created" on an order whose entries already existed.
          <><strong>The goods already received stay received</strong> — their bills remain in
          Purchases and in this month's stock, and only the outstanding quantity is closed off.{' '}</>
        )}
        <strong>This cannot be undone</strong> — a cancelled PO has no way back to draft, so anything
        still needed from this vendor has to be raised as a new PO.</>
      ),
      confirmLabel: 'Mark cancelled', cancelLabel: 'Keep PO open', danger: true, busyLabel: 'Cancelling…',
      run: async () => {
        setListError(null)
        const { error } = await scopedUpdate('purchase_orders', { status: 'cancelled' }).eq('id', po.id)
        if (error) {
          const { text, detail } = asActionError(error)
          setListError({ text: `PO ${po.po_number} was not cancelled and is still open. ${text}`, detail })
          return
        }
        await loadPos(selectedPeriod.id)
      },
    })
  }

  function deletePo(po) {
    if (!isAdmin) return
    // A PO with bills against it is refused by the database now (S709), so say so here rather than
    // offering the action and letting it fail. `receipts` null means the lookup did not answer —
    // unknown is not "none", so the dialog stays honest about it and the trigger has the last word.
    const billed = receipts ? receipts[po.id] : undefined
    if (billed) {
      setListError(`PO ${po.po_number} has ${billed.count} bill${billed.count === 1 ? '' : 's'} received against it, so it cannot be deleted — deleting it would cut those bills loose from the order they came from. Cancel it instead: it keeps the record and stops any further receiving. To remove it outright, delete those bills in Purchases first.`)
      return
    }
    // A non-draft PO is a sent or received document; the ask is the product's own dialog (S682).
    askConfirm({
      title: `Delete ${po.status !== 'draft' ? po.status.toUpperCase() + ' ' : 'draft '}PO ${po.po_number}?`,
      confirmLabel: 'Delete PO', danger: true, busyLabel: 'Deleting…',
      body: po.status !== 'draft'
        ? <p style={{ margin: 0 }}>The PO and its line items are permanently removed. Nothing has been billed against it{receipts ? '' : ' as far as this screen can tell'}; any purchase entries entered by hand in Purchases are <strong>not</strong> affected. This cannot be undone.</p>
        : <p style={{ margin: 0 }}>The draft and its line items are removed. Nothing has been sent or received against it. This cannot be undone.</p>,
      run: () => deletePoNow(po),
    })
  }

  async function deletePoNow(po) {
    setListError(null)
    // One statement. This used to delete `purchase_order_items` first and then the PO — a cascade
    // the FK already performs (`po_id … ON DELETE CASCADE`), hand-rolled into two round trips that
    // could stop between them and leave the "empty PO" its own error message then apologised for.
    // The database does it atomically, and its BEFORE DELETE trigger is what actually enforces
    // operator-only and refuses an order that has been billed against.
    const { error } = await withTimeout(scopedDelete('purchase_orders').eq('id', po.id), 20000, 'Deleting the order')
      .catch(e => ({ error: e }))
    if (error) {
      const { text, detail } = asActionError(error)
      setListError({ text: `PO ${po.po_number} was not deleted and is still on the list, whole. ${text}`, detail })
      return
    }
    await loadPos(selectedPeriod.id)
  }

  // ── Receive (GRN) ─────────────────────────────────────────

  // Re-reads the order's lines instead of trusting the list's snapshot. The screen is a
  // read-modify-write on `qty_received` — a delivery received on another device while this row sat
  // on screen would otherwise be invisible here, and the remaining quantity it shows would be the
  // one it was loaded with. The database has the last word either way now (`receive_purchase_order`
  // re-checks under a row lock), but a screen that opens on stale figures asks the user to make a
  // decision on numbers that are already wrong.
  //
  // It fails CLOSED: a failed read does not open the receive screen at all. "Remaining: 50" drawn
  // from an error is the single most expensive wrong number this page can show.
  async function openReceive(po) {
    setListError(null)
    setOpeningReceive(po.id)
    const { data, error } = await supabase
      .from('purchase_order_items')
      .select('*, items(name, uom)')
      .eq('po_id', po.id)
    setOpeningReceive(null)
    if (error) {
      const { text, detail } = asActionError(error)
      setListError({ text: `Could not open PO ${po.po_number} for receiving, so its outstanding quantities are unknown — nothing has changed. ${text}`, detail })
      return
    }
    setReceivingPo(po)
    setReceiveLines((data || []).map(x => {
      const remaining = Math.max(0, round3(x.qty_ordered - (x.qty_received || 0)))
      return {
        id: x.id,
        item_id: x.item_id,
        name: x.items?.name || '—',
        uom: x.items?.uom || '',
        qty_ordered: round3(x.qty_ordered),
        qty_received: round3(x.qty_received || 0),
        unit_price: parseFloat(x.unit_price || 0),
        receiving: remaining > 0 ? String(remaining) : '0',
      }
    }))
    // The day belongs to the PO's OWN period, which is not necessarily this month: a Shrawan order
    // delivered in Bhadra used to default to today's day NUMBER and stamp it onto Shrawan, filing
    // the purchase a month early with nothing on screen to say so. Today's day is offered only
    // when today actually falls in that period; otherwise the picker starts empty and asks.
    const p = periods.find(x => x.id === po.period_id)
    let day = ''
    try {
      const t = getBsToday()
      if (p && t.year === p.bs_year && t.month === p.bs_month) day = String(t.day)
    } catch { /* out of the calendar table — the picker asks */ }
    setReceiveBsDay(day)
    setReceivePayment('Credit')
    // Was never reset. Ticking VAT-inclusive for one vendor left it ticked for the next PO opened
    // in the same session, and every rate on that delivery was quietly divided by 1.13.
    setReceiveVatInclusive(false)
    setReceiveError('')
    setView('receive')
  }

  async function confirmReceive() {
    const toReceive = receiveLines.filter(l => round3(l.receiving) > 0)
    if (toReceive.length === 0) { setReceiveError('Enter how much arrived against at least one line.'); return }
    const day = parseInt(receiveBsDay, 10)
    // Against the PO's own month, not the 1–32 the column's CHECK allows: BS months run 29–32 days
    // and Ashwin has no 32nd, so the old bound accepted a day that does not exist in the period the
    // bill is being filed into.
    if (!day || day < 1 || day > receiveMaxDay) {
      setReceiveError(`Pick the day the delivery arrived — ${receivePeriodLabel} has days 1–${receiveMaxDay}.`)
      return
    }

    // The "max" on the qty input was only an HTML hint, never actually enforced — a typo (e.g.
    // 100 instead of 10) silently over-received, inflating qty_received past qty_ordered. This
    // check is the one that can NAME the item; the server re-checks the same thing under a row
    // lock, against the quantity as it stands at that instant rather than as this screen loaded it.
    const overReceived = toReceive.find(l => round3(l.receiving) > round3(l.qty_ordered - l.qty_received))
    if (overReceived) {
      setReceiveError(`Receiving ${round3(overReceived.receiving)} for "${overReceived.name || overReceived.item_id}" exceeds the remaining ${round3(overReceived.qty_ordered - overReceived.qty_received)} still on order.`)
      return
    }

    setReceiveSaving(true)
    setReceiveError('')

    // ONE transaction (S709). This was four round trips — insert the bills, update each line's
    // qty_received, update the PO's status — with no atomicity between them and, on the last one,
    // no error check at all. `receive_purchase_order` does the lot inside one statement: it
    // re-reads the remaining quantity under a row lock, refuses a closed period, writes the bills
    // with `po_id` pointing back here, INCREMENTS qty_received rather than assigning the number
    // this browser computed, and returns the status it derived from the table.
    //
    // One receipt is still ONE bill: purchase_group_id defaults to gen_random_uuid() PER ROW, so
    // the shared id is passed explicitly or a six-line delivery lands as six bills (S698).
    const receiptGroupId = crypto.randomUUID()
    const res = await withTimeout(supabase.rpc('receive_purchase_order', {
      p_po_id: receivingPo.id,
      p_bs_day: day,
      p_payment_method: receivePayment,
      p_vat_inclusive: receiveVatInclusive,
      p_group_id: receiptGroupId,
      p_lines: toReceive.map(l => ({
        po_item_id: l.id,
        qty: round3(l.receiving),
        // The 13% divisor stays here, in the one language that already holds it (calcBillTotals).
        rate: receiveVatInclusive ? l.unit_price / 1.13 : l.unit_price,
      })),
    }), 30000, 'Recording the delivery').catch(e => ({ error: e }))

    if (res.error) {
      // Deliberately does NOT open with "nothing was received". The server's own refusals do prove
      // that and say so through errorText; a dropped connection proves nothing — the response can
      // be lost after the transaction committed — and the old copy claimed it either way. Pointing
      // at the reopened order is the one instruction that is true in both cases, because the order
      // is now the record of what actually landed.
      const { text, detail } = asActionError(res.error)
      setReceiveError({ text: `${text}

Reopen PO ${receivingPo.po_number} before entering this delivery again — what it shows as outstanding is what actually recorded.`, detail })
      setReceiveSaving(false)
      return
    }

    setReceiveSaving(false)
    await loadPos(selectedPeriod.id)
    setView('list')
  }

  // ── Derived ───────────────────────────────────────────────

  const filteredPos = pos.filter(po => filterStatus === 'all' || po.status === filterStatus)

  function getPoTotal(po) {
    return (po.purchase_order_items || []).reduce((s, x) =>
      s + parseFloat(x.qty_ordered) * parseFloat(x.unit_price || 0), 0)
  }

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : '—'

  // The line every period-scoped entry page in IMS spells, and the one page in the module that
  // never had it (closed-periods.md). Raising, editing, receiving and cancelling all write into
  // the month on screen — receiving writes `purchase_entries`, the very table Purchases locks —
  // so this page was the way around a close for anyone who knew it was here. The `!isAdmin`
  // carve-out is the feature: an operator entering a missed delivery into a closed month is a real
  // job, and the server now enforces exactly this rule rather than trusting the page to.
  const isLocked = !isAdmin && selectedPeriod?.status === 'closed'

  // The receive screen's own period — resolved from the PO rather than assumed to be the selected
  // one, because it is the PO's period the bill is filed into.
  const receivePeriod = receivingPo ? periods.find(p => p.id === receivingPo.period_id) : null
  const receiveMaxDay = receivePeriod ? daysInBsMonth(receivePeriod.bs_year, receivePeriod.bs_month) : 32
  const receivePeriodLabel = receivePeriod
    ? `${BS_MONTHS[receivePeriod.bs_month - 1]} ${receivePeriod.bs_year}`
    : periodLabel

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read must not wear NoPeriodState, which tells the reader there
  // are no periods and to go and create one (S612 silent-zero rule).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="purchase orders" />

  const thStyle = { textAlign: 'left', fontSize: 11, color: 'var(--theme-text2)', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }
  const tdStyle = { padding: '12px', fontSize: 13, verticalAlign: 'middle' }

  if (loading) return <div style={{ padding: 40, color: 'var(--theme-text2)' }}>Loading…</div>

  // ── RECEIVE VIEW ──────────────────────────────────────────
  if (view === 'receive' && receivingPo) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <div className="page-header">
          <button className="btn btn-ghost" onClick={() => setView('list')} style={{ marginBottom: 16, fontSize: 12 }}>← Back to POs</button>
          <h1 className="page-title" style={{ marginBottom: 4 }}>Receive Goods — {receivingPo.po_number}</h1>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
            Vendor: <strong style={{ color: 'var(--theme-text1)' }}>{receivingPo.vendors?.name || '—'}</strong>
            {' · '}Period: <strong style={{ color: 'var(--theme-text1)' }}>{receivePeriodLabel}</strong>
          </p>
          {/* The bill is filed into the ORDER's period, which need not be the month it is being
              received in. Said out loud, because the figures below give no hint of it. */}
          {receivePeriod && selectedPeriod && receivePeriod.id !== selectedPeriod.id && (
            <p style={{ fontSize: 12, color: 'var(--theme-amber-text)', margin: '6px 0 0' }}>
              This delivery will be recorded in <strong>{receivePeriodLabel}</strong>, the period this order belongs to.
            </p>
          )}
          {/* Only from the po_id link (S709), so it can only ever show receipts made since. It says
              what this order has ALREADY produced — the question a second delivery against a
              part-received PO always raises, and one the page could not answer before. */}
          {receipts?.[receivingPo.id] && (
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '6px 0 0' }}>
              Already billed against this order: <strong>{receipts[receivingPo.id].count}</strong>{' '}
              line{receipts[receivingPo.id].count === 1 ? '' : 's'} worth{' '}
              <strong>NPR {receipts[receivingPo.id].total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</strong>{' '}
              (ex-VAT) — see Purchases.
            </p>
          )}
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 20 }}>
            <div className="form-field" style={{ minWidth: 170 }}>
              <label htmlFor="po-receive-day">
                <Tip width={280} text={`The day the delivery arrived, in ${receivePeriodLabel} — the period this order belongs to. A BS month runs 29 to 32 days, so the days offered are the ones this month actually has.`}>
                  Day Received *
                </Tip>
              </label>
              {/* Was a bare number input bounded 1–32 and pre-filled with TODAY's day number,
                  whatever month today was in. Locked to the order's own period, it can only produce
                  a day that exists in the month the bill is being filed into. */}
              <BsCalendarPicker
                id="po-receive-day"
                lockYear={receivePeriod?.bs_year}
                lockMonth={receivePeriod?.bs_month}
                value={receiveBsDay}
                onChange={setReceiveBsDay}
                placeholder="Pick day"
                invalid={!!receiveBsDay && (parseInt(receiveBsDay, 10) < 1 || parseInt(receiveBsDay, 10) > receiveMaxDay)} />
            </div>
            <div className="form-field" style={{ minWidth: 140 }}>
              <label htmlFor="purcha-f2">
                <Tip width={260} text="Defaults to Credit — most PO deliveries are on credit terms. Change to Cash or FonePay if the vendor requires payment on delivery.">
                  Payment Method
                </Tip>
              </label>
              <select id="purcha-f2" className="form-select" value={receivePayment} onChange={e => setReceivePayment(e.target.value)}>
                {PURCHASE_PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="form-field" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <span aria-hidden="true" style={{ visibility: 'hidden', fontSize: 13 }}>VAT</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13,
                color: receiveVatInclusive ? 'var(--theme-accent-ink)' : 'var(--theme-text3)', userSelect: 'none', paddingBottom: 6 }}>
                <input type="checkbox" checked={receiveVatInclusive} onChange={e => setReceiveVatInclusive(e.target.checked)}
                  style={{ width: 15, height: 15, accentColor: 'var(--theme-accent)', cursor: 'pointer' }} />
                <Tip text="Tick if the vendor's invoice rates include 13% VAT. The system strips VAT and stores the ex-VAT rate in the purchase entry." width={260}>
                  VAT Incl. (13%)
                </Tip>
              </label>
            </div>
          </div>

          <div className="table-wrap table-wrap--fab-clear">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Item</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Ordered</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Received</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Remaining</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>
                    <Tip width={250} text="Qty delivered today. Can be less than ordered — PO will be marked Partial and you can receive the rest later.">
                      Receiving Now
                    </Tip>
                  </th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>
                    <Tip width={220} text="Pre-agreed price per base unit (from the PO). Carried through to the purchase entry.">
                      Unit Price
                    </Tip>
                  </th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {receiveLines.map((l, idx) => {
                  const rem = Math.max(0, round3(l.qty_ordered - l.qty_received))
                  const val = round3(l.receiving) * l.unit_price
                  const isFullyReceived = rem <= 0
                  return (
                    <tr key={l.id} style={{ opacity: isFullyReceived ? 0.4 : 1 }}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{l.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{l.uom}</div>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--theme-text2)' }}>{l.qty_ordered}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--theme-text2)' }}>{l.qty_received || 0}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: rem > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-green-text)' }}>{rem}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {isFullyReceived ? (
                          <span style={{ color: 'var(--theme-green-text)', fontSize: 12 }}>✓ Done</span>
                        ) : (
                          <input aria-label="Quantity receiving" type="number" min="0" max={rem} value={l.receiving}
                            onChange={e => setReceiveLines(prev => prev.map((x, i) => i === idx ? { ...x, receiving: e.target.value } : x))}
                            style={{ background: 'var(--theme-bg)', border: '1px solid color-mix(in srgb, var(--theme-accent) 40%, transparent)', borderRadius: 'var(--radius-sm)',
                              padding: '6px 10px', fontSize: 13, color: 'var(--theme-text1)', width: 90, textAlign: 'right', outline: 'none' }} />
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--theme-text2)' }}>
                        NPR {l.unit_price.toFixed(2)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>
                        {val > 0 ? `NPR ${val.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td colSpan={6} style={{ ...tdStyle, fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 16 }}>Total Receiving Value</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', fontSize: 14, paddingTop: 16 }}>
                    NPR {receiveLines.reduce((s, l) => s + round3(l.receiving) * l.unit_price, 0)
                      .toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <ActionError error={receiveError} />

          <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setView('list')}>Cancel</button>
            <button className="btn btn-primary" onClick={confirmReceive} disabled={receiveSaving}>
              {receiveSaving ? 'Saving…' : (
                <Tip width={280} text="Creates a purchase entry for each received item in the selected period. Invoice ref is set to the PO number. Stock will increase accordingly.">
                  ✓ Confirm Receipt → Create Purchase Entries
                </Tip>
              )}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── FORM VIEW ─────────────────────────────────────────────
  if (view === 'form') {
    const liveTotal = poItems.reduce((s, x) =>
      s + (parseFloat(x.qty_ordered) || 0) * (parseFloat(x.unit_price) || 0), 0)

    return (
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div className="page-header">
          <button className="btn btn-ghost" onClick={() => setView('list')} style={{ marginBottom: 16, fontSize: 12 }}>← Back to POs</button>
          <h1 className="page-title">{editingPo ? `Edit ${editingPo.po_number}` : 'New Purchase Order'}</h1>
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 20 }}>
            <div className="form-field">
              <label htmlFor="purcha-f3">Vendor *</label>
              <select id="purcha-f3" className="form-select" value={poForm.vendor_id} onChange={e => setPoForm(f => ({ ...f, vendor_id: e.target.value }))}>
                <option value="">— Select vendor —</option>
                {/* `_inactive` rows are the ones this PO names that the active list no longer
                    holds, fetched by backfillPickers so the order can be edited without losing
                    its supplier. Labelled, because picking one for a NEW order is not intended. */}
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}{v._inactive ? ' (inactive)' : ''}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="purcha-f4">Period *</label>
              <select id="purcha-f4" className="form-select" value={poForm.period_id} onChange={e => setPoForm(f => ({ ...f, period_id: e.target.value }))}>
                <option value="">— Select period —</option>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>
                    {BS_MONTHS[p.bs_month - 1]} {p.bs_year}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label htmlFor="po-expected-date">
                <Tip width={240} text="Optional. The date you expect the vendor to deliver. Shown on the PO list for follow-up.">
                  Expected Delivery
                </Tip>
              </label>
              <BsCalendarPicker
                id="po-expected-date"
                value={poForm.expected_date}
                onChange={v => setPoForm(f => ({ ...f, expected_date: v }))}
                placeholder="Pick delivery date"
                clearable />
            </div>
            <div className="form-field" style={{ gridColumn: 'span 2' }}>
              <label htmlFor="purcha-f5">Notes</label>
              <input id="purcha-f5" value={poForm.notes} onChange={e => setPoForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. Deliver before 10am, use back entrance…" />
            </div>
          </div>

          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 12, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>Items</div>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={addPoItemRow}>+ Add Row</button>
          </div>

          <div className="table-wrap table-wrap--fab-clear">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, paddingLeft: 0 }}>Item</th>
                <th style={{ ...thStyle, textAlign: 'right', width: 110 }}>Qty</th>
                <th style={{ ...thStyle, width: 70 }}>UOM</th>
                <th style={{ ...thStyle, textAlign: 'right', width: 130 }}>
                  <Tip width={250} text="The price you agreed with this vendor, per BASE unit — the unit shown in the UOM column, not a case or a sack. Filled in from the item's current Item Master rate; change it if the vendor quoted something else.">
                    Unit Price (NPR)
                  </Tip>
                </th>
                <th style={{ ...thStyle, textAlign: 'right', width: 120 }}>Subtotal</th>
                <th style={{ width: 36 }}></th>
              </tr>
            </thead>
            <tbody>
              {poItems.map(row => {
                const item = items.find(i => i.id === row.item_id)
                const subtotal = (parseFloat(row.qty_ordered) || 0) * (parseFloat(row.unit_price) || 0)
                return (
                  <tr key={row._key}>
                    <td style={{ padding: '5px 0' }}>
                      <select aria-label="Item" value={row.item_id} onChange={e => handleItemSelect(row._key, e.target.value)}
                        className="form-select" style={{ width: '100%' }}>
                        <option value="">— Select item —</option>
                        {items.map(i => <option key={i.id} value={i.id}>{i.name}{i._inactive ? ' (inactive)' : ''}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '5px 8px' }}>
                      <input aria-label="Quantity ordered" type="number" min="0" value={row.qty_ordered}
                        onChange={e => updatePoItem(row._key, 'qty_ordered', e.target.value)}
                        placeholder="0"
                        style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)',
                          padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', textAlign: 'right' }} />
                    </td>
                    <td style={{ padding: '5px 8px', fontSize: 12, color: 'var(--theme-text2)' }}>{item?.uom || '—'}</td>
                    <td style={{ padding: '5px 8px' }}>
                      <input aria-label="Unit price" type="number" min="0" value={row.unit_price}
                        onChange={e => updatePoItem(row._key, 'unit_price', e.target.value)}
                        placeholder="0.00"
                        style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)',
                          padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', textAlign: 'right' }} />
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', fontSize: 13, color: subtotal > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text3)', fontWeight: 600 }}>
                      {subtotal > 0 ? `NPR ${subtotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                    </td>
                    <td style={{ padding: '5px 0', textAlign: 'right' }}>
                      <button onClick={() => removePoItemRow(row._key)} aria-label="Remove item row"
                        style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 16, padding: '8px' }}>×</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            {liveTotal > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td colSpan={4} style={{ paddingTop: 12, fontWeight: 700, color: 'var(--theme-text2)', fontSize: 13 }}>PO Total</td>
                  <td style={{ paddingTop: 12, textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent-ink)', fontSize: 14 }}>
                    NPR {liveTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
          </div>

          <ActionError error={formError} />

          <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setView('list')}>Cancel</button>
            <button className="btn btn-primary" onClick={savePo} disabled={saving}>
              {saving ? 'Saving…' : editingPo ? 'Update PO' : 'Create PO'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── LIST VIEW ─────────────────────────────────────────────
  const statusCounts = Object.keys(STATUS_META).reduce((acc, s) => {
    acc[s] = pos.filter(p => p.status === s).length
    return acc
  }, {})

  return (
    <div>

      {/* ── PRINT-ONLY PO DOCUMENT ── */}
      {printPo && (() => {
        const po = printPo
        // Rounded per line, then summed — not summed and then rounded. This is a document a
        // supplier invoices against, and printing every line to the rupee while printing a total
        // taken from the unrounded figures produces a page whose own column does not add up.
        const printLines = (po.purchase_order_items || []).map(x => ({
          ...x,
          subtotal: Math.round(parseFloat(x.qty_ordered) * parseFloat(x.unit_price || 0) * 100) / 100,
        }))
        const total = printLines.reduce((s, x) => s + x.subtotal, 0)
        const money2 = n => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        return (
          <div className="print-only" style={{ fontFamily: 'Georgia, serif', color: '#111', padding: '32px 48px', maxWidth: 740, margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #111', paddingBottom: 16, marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.04em' }}>PURCHASE ORDER</div>
                <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>Crest Suite</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#111', fontFamily: 'monospace' }}>{po.po_number}</div>
                <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
                  Period: {periodLabel}
                </div>
                {po.expected_date && (
                  <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>
                    {/* Stored as AD, per the storage convention, but picked in BS and read in BS —
                        by the person raising it and by the supplier receiving this page. It printed
                        the raw column: a delivery date in a calendar nobody here uses. */}
                    Expected: {formatAdAsBs(po.expected_date)}
                  </div>
                )}
                <div style={{ marginTop: 6 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 'var(--radius-xs)',
                    border: `1px solid #999`, color: '#333', letterSpacing: '0.06em', textTransform: 'uppercase'
                  }}>{po.status}</span>
                </div>
              </div>
            </div>

            {/* Vendor */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888', marginBottom: 4 }}>Vendor</div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>{po.vendors?.name || '—'}</div>
            </div>

            {/* Notes */}
            {po.notes && (
              <div style={{ marginBottom: 20, padding: '10px 14px', border: '1px solid #ddd', borderRadius: 'var(--radius-xs)', fontSize: 13, color: '#444' }}>
                <strong>Notes:</strong> {po.notes}
              </div>
            )}

            {/* Items table */}
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
              <thead>
                <tr style={{ background: '#f3f3f3' }}>
                  <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid #ccc' }}>#</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid #ccc' }}>Item</th>
                  <th style={{ textAlign: 'right', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid #ccc' }}>Qty</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid #ccc' }}>UOM</th>
                  <th style={{ textAlign: 'right', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid #ccc' }}>Unit Price</th>
                  <th style={{ textAlign: 'right', padding: '8px 10px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', borderBottom: '1px solid #ccc' }}>Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {printLines.map((x, idx) => {
                  const subtotal = x.subtotal
                  return (
                    <tr key={x.id} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: '9px 10px', fontSize: 13, color: '#888' }}>{idx + 1}</td>
                      <td style={{ padding: '9px 10px', fontSize: 13, fontWeight: 600 }}>{x.items?.name || '—'}</td>
                      <td style={{ padding: '9px 10px', fontSize: 13, textAlign: 'right' }}>{x.qty_ordered}</td>
                      <td style={{ padding: '9px 10px', fontSize: 13, color: '#555' }}>{x.items?.uom || '—'}</td>
                      <td style={{ padding: '9px 10px', fontSize: 13, textAlign: 'right' }}>
                        {x.unit_price ? `NPR ${money2(parseFloat(x.unit_price))}` : '—'}
                      </td>
                      <td style={{ padding: '9px 10px', fontSize: 13, textAlign: 'right', fontWeight: 600 }}>
                        {subtotal > 0 ? `NPR ${money2(subtotal)}` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #ccc' }}>
                  <td colSpan={5} style={{ padding: '12px 10px', textAlign: 'right', fontWeight: 700, fontSize: 13 }}>PO Total</td>
                  <td style={{ padding: '12px 10px', textAlign: 'right', fontWeight: 800, fontSize: 16 }}>
                    NPR {money2(total)}
                  </td>
                </tr>
              </tfoot>
            </table>

            {/* Signatures */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 40, marginTop: 60 }}>
              {['Prepared By', 'Approved By', 'Received By'].map(label => (
                <div key={label} style={{ textAlign: 'center' }}>
                  <div style={{ borderTop: '1px solid #888', paddingTop: 6, fontSize: 11, color: '#555', letterSpacing: '0.06em' }}>{label}</div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 32, fontSize: 10, color: '#aaa', borderTop: '1px solid #eee', paddingTop: 12, textAlign: 'center' }}>
              Generated by Crest Suite · {new Date().toLocaleDateString('en-IN')}
            </div>
          </div>
        )
      })()}
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Purchase Orders</h1>
          <p className="page-subtitle">{pos.length} PO{pos.length === 1 ? '' : 's'}</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select aria-label="Period"
            value={selectedPeriod?.id || ''}
            onChange={e => handlePeriodChange(e.target.value)}
            className="form-select"
          >
            {periods.map(p => (
              <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year}</option>
            ))}
          </select>
        </div>
      </div>

      <ActionError error={listError} className="action-error--top" />

      {/* Locked banner — the same wording the other four IMS entry pages carry. */}
      {isLocked && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red-text)' }}>
          🔒 <strong>This period is closed.</strong> Orders here are read-only and no delivery can be received into it. Contact your admin to re-open if needed.
        </div>
      )}

      {/* The admin counterpart: `isLocked` carves admin out of the lock, which is what makes
          entering a missed delivery into a closed month possible — and without this an admin got
          no signal at all that the month on screen was closed. Receiving writes purchase entries,
          so it moves the same figures a late bill does, and the frozen report needs the same
          regeneration afterwards. */}
      {isAdmin && selectedPeriod?.status === 'closed' && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-amber-text)' }}>
          ✎ <strong>{periodLabel} is closed — you are editing it as admin.</strong> A delivery received here still creates its
          purchase entries in this month, which is how a missed one gets into the period it belongs to. Afterwards, open{' '}
          <Link to="/owner-report" style={{ color: 'inherit', textDecoration: 'underline' }}>Monthly Report</Link>{' '}
          for this month and use <strong>Regenerate Snapshot</strong> — the report was frozen when the month closed and will
          not include what you add here until it is regenerated.
        </div>
      )}

      {/* A failed read replaces the table below rather than rendering as a period with no orders. */}
      {loadError && <ReportLoadError error={loadError} />}

      {/* Status filter pills */}
      <div className="tab-bar" style={{ marginBottom: 20 }}>
        {[['all', 'All', pos.length], ...Object.entries(STATUS_META).map(([k, m]) => [k, m.label, statusCounts[k] || 0])].map(([key, label, count]) => (
          <button key={key} onClick={() => setFilterStatus(key)} className={`tab-btn${filterStatus === key ? ' tab-btn--active' : ''}`}>
            {label} {count > 0 && <span style={{ opacity: 0.7 }}>({count})</span>}
          </button>
        ))}
      </div>

      {loadError ? null : filteredPos.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">▤</div>
          <p className="empty-state-text">
            {pos.length === 0
              ? `No purchase orders raised for ${periodLabel} yet. Use + New PO to raise one against a vendor.`
              : `No ${filterStatus} purchase orders in ${periodLabel} — there ${pos.length === 1 ? 'is 1 in another status' : `are ${pos.length} in other statuses`}. Choose All to see them.`}
          </p>
        </div>
      ) : (
        <div className="table-wrap table-wrap--fab-clear">
          <table className="data-table">
            <thead>
              <tr>
                <th>PO #</th>
                <th>Vendor</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip width={220} text="Fully received items out of total items on this PO.">Items</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip width={230} text="Total ordered value (qty × unit price). Actual received value may differ if partial.">PO Value</Tip>
                </th>
                <th>
                  <Tip width={200} text="Expected delivery date set on the PO. Use for vendor follow-up.">Expected</Tip>
                </th>
                <th>Notes</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPos.map(po => {
                const total = getPoTotal(po)
                const itemCount = (po.purchase_order_items || []).length
                const receivedCount = (po.purchase_order_items || []).filter(x => round3(x.qty_received || 0) >= round3(x.qty_ordered)).length
                const canReceive = !isLocked && ['draft', 'sent', 'partial'].includes(po.status)
                // Editing REPLACES the line rows, and a replacement row starts at qty_received 0.
                // On a draft that is harmless — a draft has received nothing. It stops being
                // harmless the moment a draft holds a received quantity, which it can: the status
                // write after a receipt used to be able to fail silently and leave one there, and
                // that is precisely the state in which editing would wipe the evidence of a
                // delivery and let it be received a second time. Belt and braces with the RPC.
                const hasReceipt = (po.purchase_order_items || []).some(x => round3(x.qty_received || 0) > 0)
                const canEdit = po.status === 'draft' && !hasReceipt && !isLocked
                return (
                  <tr key={po.id}>
                    <td>
                      <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)' }}>{po.po_number}</span>
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{po.vendors?.name || '—'}</td>
                    <td><StatusBadge status={po.status} /></td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>
                      {receivedCount}/{itemCount} items
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)' }}>
                      {total > 0 ? `NPR ${total.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                    </td>
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12, whiteSpace: 'nowrap' }}>{formatAdAsBs(po.expected_date)}</td>
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{po.notes || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {canReceive && (
                          <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 12px' }}
                            onClick={() => openReceive(po)} disabled={openingReceive === po.id}>
                            {openingReceive === po.id ? 'Opening…' : (
                              <Tip width={260} text="Open Goods Receipt Note (GRN). Enter what arrived and it creates the purchase entries — one bill — in the period this order belongs to.">
                                Receive
                              </Tip>
                            )}
                          </button>
                        )}
                        {po.status === 'draft' && !isLocked && (
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }}
                            onClick={() => markSent(po)}>
                            <Tip width={240} text="Mark this PO as sent to the vendor. You can still receive goods against it at any time.">
                              Mark Sent
                            </Tip>
                          </button>
                        )}
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
                          onClick={() => setPrintPo(po)} title="Print PO">
                          🖶
                        </button>
                        {canEdit && (
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
                            onClick={() => openEdit(po)}>
                            Edit
                          </button>
                        )}
                        {isAdmin && (
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: 'var(--theme-red-text)' }}
                            onClick={() => deletePo(po)}>
                            <Tip width={250} text="Operator only — permanently removes this PO and its line items. An order that already has bills received against it cannot be deleted; cancel it instead.">
                              Delete
                            </Tip>
                          </button>
                        )}
                        {canReceive && (
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: 'var(--theme-red-text)' }}
                            onClick={() => cancelPo(po)}>
                            <Tip width={250} text={po.status === 'partial'
                              ? 'Close this PO off. Anything already received keeps its bills in Purchases; only the outstanding quantity is cancelled. Cannot be undone.'
                              : 'Cancel this PO. Nothing has been received against it, so no purchase entries exist or will be created. Cannot be undone.'}>
                              {po.status === 'partial' ? 'Close Short' : 'Cancel'}
                            </Tip>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Fab onClick={openNew} label="+ New PO" show={!isLocked && !loadError && !!selectedPeriod} />
      {confirmEl}
    </div>
  )
}
