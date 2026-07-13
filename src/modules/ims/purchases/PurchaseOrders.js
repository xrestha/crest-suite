import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { getBsToday } from '../../../utils/bsCalendar'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { printWithTitle } from '../../../utils/printTitle'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const PAYMENT_METHODS = ['Cash', 'Credit', 'FonePay']

const STATUS_META = {
  draft:     { label: 'Draft',     color: 'var(--theme-text2)', bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.3)' },
  sent:      { label: 'Sent',      color: 'var(--theme-purple)', bg: 'color-mix(in srgb, var(--theme-purple) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-purple) 30%, transparent)' },
  partial:   { label: 'Partial',   color: 'var(--theme-accent)', bg: 'rgba(201,168,76,0.1)',  border: 'rgba(201,168,76,0.3)' },
  received:  { label: 'Received',  color: 'var(--theme-green)', bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.3)' },
  cancelled: { label: 'Cancelled', color: 'var(--theme-red)', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.3)' },
}

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.draft
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
      color: m.color, background: m.bg, border: `1px solid ${m.border}`, letterSpacing: '0.04em' }}>
      {m.label}
    </span>
  )
}

export default function PurchaseOrders() {
  const { clientId, profile, isAdmin, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()

  const [periods,        setPeriods]        = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [vendors,        setVendors]        = useState([])
  const [items,          setItems]          = useState([])
  const [pos,            setPos]            = useState([])
  const [loading,        setLoading]        = useState(true)
  const [view,           setView]           = useState('list') // list | form | receive

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
    const [{ data: p }, { data: v }, { data: i }] = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('vendors').eq('is_active', true).order('name'),
      scopedFrom('items', '*, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('name'),
    ])
    setPeriods(p || [])
    setVendors(v || [])
    setItems(i || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) {
      setSelectedPeriod(open)
      await loadPos(open.id)
    }
    setLoading(false)
  }

  async function loadPos(periodId) {
    const { data } = await scopedFrom('purchase_orders', '*, vendors(name), purchase_order_items(*, items(name, uom))')
      .eq('period_id', periodId)
      .order('created_at', { ascending: false })
    setPos(data || [])
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setView('list')
    await loadPos(periodId)
  }

  async function getNextPoNumber() {
    const { data } = await scopedFrom('purchase_orders', 'po_number')
      .order('created_at', { ascending: false })
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
    if (!poForm.vendor_id) { setFormError('Select a vendor.'); return }
    if (!poForm.period_id) { setFormError('Select a period.'); return }
    const validItems = poItems.filter(x => x.item_id && parseFloat(x.qty_ordered) > 0)
    if (validItems.length === 0) { setFormError('Add at least one item with qty > 0.'); return }

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
      const { error } = await scopedUpdate('purchase_orders', poPayload).eq('id', editingPo.id)
      if (error) { setFormError(error.message); setSaving(false); return }
      poId = editingPo.id
    } else {
      // getNextPoNumber() computes from in-memory state, not a DB sequence — a genuine collision
      // (two tabs, a fast double-click) is now caught by a client_id+po_number unique constraint
      // instead of silently succeeding twice. Retry with a freshly recomputed number a few times
      // before giving up, rather than surfacing a raw constraint-violation error to the user.
      let data, error
      for (let attempt = 0; attempt < 3; attempt++) {
        const poNumber = await getNextPoNumber()
        ;({ data, error } = await scopedInsert('purchase_orders', { ...poPayload, po_number: poNumber, status: 'draft' }, { single: true }))
        if (!error || error.code !== '23505') break
      }
      if (error) { setFormError(error.message); setSaving(false); return }
      poId = data.id
    }

    // Insert the new line items BEFORE removing the old ones (not delete-then-insert) — if the
    // insert fails partway, the PO keeps its previous, still-valid line items instead of zero.
    const { data: insertedItems, error: itemErr } = await supabase.from('purchase_order_items').insert(
      validItems.map(x => ({
        po_id: poId,
        item_id: x.item_id,
        qty_ordered: parseFloat(x.qty_ordered),
        unit_price: parseFloat(x.unit_price) || 0,
        qty_received: 0,
      }))
    ).select('id')
    if (itemErr) { setFormError(itemErr.message); setSaving(false); return }
    if (editingPo) {
      const newIds = (insertedItems || []).map(r => r.id)
      await supabase.from('purchase_order_items').delete().eq('po_id', poId).not('id', 'in', `(${newIds.join(',')})`)
    }

    setSaving(false)
    await loadPos(selectedPeriod.id)
    setView('list')
  }

  async function markSent(po) {
    await scopedUpdate('purchase_orders', { status: 'sent' }).eq('id', po.id)
    await loadPos(selectedPeriod.id)
  }

  async function cancelPo(po) {
    if (!window.confirm(`Cancel PO ${po.po_number}? This cannot be undone.`)) return
    await scopedUpdate('purchase_orders', { status: 'cancelled' }).eq('id', po.id)
    await loadPos(selectedPeriod.id)
  }

  async function deletePo(po) {
    if (!isAdmin) return
    const msg = po.status !== 'draft'
      ? `Delete ${po.status.toUpperCase()} PO ${po.po_number}?\n\nThis permanently removes the PO and its line items. Purchase entries already created from receiving are NOT deleted — manage those in Purchases.\n\nThis cannot be undone.`
      : `Delete draft PO ${po.po_number}? This cannot be undone.`
    if (!window.confirm(msg)) return
    await supabase.from('purchase_order_items').delete().eq('po_id', po.id)
    await scopedDelete('purchase_orders').eq('id', po.id)
    await loadPos(selectedPeriod.id)
  }

  // ── Receive (GRN) ─────────────────────────────────────────

  function openReceive(po) {
    setReceivingPo(po)
    setReceiveLines((po.purchase_order_items || []).map(x => {
      const remaining = Math.max(0, parseFloat(x.qty_ordered) - parseFloat(x.qty_received || 0))
      return {
        id: x.id,
        item_id: x.item_id,
        name: x.items?.name || '—',
        uom: x.items?.uom || '',
        qty_ordered: parseFloat(x.qty_ordered),
        qty_received: parseFloat(x.qty_received || 0),
        unit_price: parseFloat(x.unit_price || 0),
        receiving: remaining > 0 ? String(remaining) : '0',
      }
    }))
    try {
      const t = getBsToday()
      setReceiveBsDay(String(t.day))
    } catch { setReceiveBsDay('1') }
    setReceivePayment('Credit')
    setReceiveError('')
    setView('receive')
  }

  async function confirmReceive() {
    const toReceive = receiveLines.filter(l => parseFloat(l.receiving) > 0)
    if (toReceive.length === 0) { setReceiveError('Enter received qty for at least one item.'); return }
    const day = parseInt(receiveBsDay)
    if (!day || day < 1 || day > 32) { setReceiveError('Enter a valid BS day (1–32).'); return }

    // The "max" on the qty input was only an HTML hint, never actually enforced — a typo (e.g.
    // 100 instead of 10) silently over-received, inflating qty_received past qty_ordered.
    const overReceived = toReceive.find(l => parseFloat(l.receiving) > (l.qty_ordered - l.qty_received))
    if (overReceived) {
      setReceiveError(`Receiving ${overReceived.receiving} for "${overReceived.name || overReceived.item_id}" exceeds the remaining ${(overReceived.qty_ordered - overReceived.qty_received)} still on order.`)
      return
    }

    setReceiveSaving(true)
    setReceiveError('')

    const { error: purchErr } = await supabase.from('purchase_entries').insert(
      toReceive.map(l => ({
        period_id: receivingPo.period_id,
        item_id: l.item_id,
        vendor_id: receivingPo.vendor_id,
        bs_day: day,
        qty: parseFloat(l.receiving),
        rate: receiveVatInclusive ? l.unit_price / 1.13 : l.unit_price,
        payment_method: receivePayment,
        invoice_ref: receivingPo.po_number,
        vat_inclusive: receiveVatInclusive,
      }))
    )
    if (purchErr) { setReceiveError(purchErr.message); setReceiveSaving(false); return }

    // Stock/purchase history is now written for every line — if a qty_received update fails
    // partway through this loop, that line would otherwise still show its old remaining qty and
    // let staff receive (and double-book) the same delivery again next time. Stop on first
    // failure and say exactly which lines are now out of sync, instead of failing silently.
    for (const l of toReceive) {
      const { error: updErr } = await supabase.from('purchase_order_items')
        .update({ qty_received: l.qty_received + parseFloat(l.receiving) })
        .eq('id', l.id)
      if (updErr) {
        setReceiveError(
          `Stock was recorded, but updating "${l.name || l.item_id}"'s received qty failed (${updErr.message}). ` +
          `Reload this PO before receiving again to avoid double-counting.`
        )
        setReceiveSaving(false)
        return
      }
    }

    const updatedLines = receiveLines.map(l => ({
      ordered: l.qty_ordered,
      totalReceived: l.qty_received + (parseFloat(l.receiving) || 0),
    }))
    const allDone = updatedLines.every(l => l.totalReceived >= l.ordered)
    const anyDone = updatedLines.some(l => l.totalReceived > 0)
    const newStatus = allDone ? 'received' : anyDone ? 'partial' : receivingPo.status

    await scopedUpdate('purchase_orders', { status: newStatus }).eq('id', receivingPo.id)

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

  const thStyle = { textAlign: 'left', fontSize: 11, color: 'var(--theme-text2)', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }
  const tdStyle = { padding: '12px', fontSize: 13, verticalAlign: 'middle' }

  if (loading) return <div style={{ padding: 40, color: 'var(--theme-text2)' }}>Loading…</div>

  // ── RECEIVE VIEW ──────────────────────────────────────────
  if (view === 'receive' && receivingPo) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '32px 24px' }}>
        <button className="btn btn-ghost" onClick={() => setView('list')} style={{ marginBottom: 20, fontSize: 12 }}>← Back to POs</button>

        <div style={{ marginBottom: 24 }}>
          <h1 className="page-title" style={{ marginBottom: 4 }}>Receive Goods — {receivingPo.po_number}</h1>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
            Vendor: <strong style={{ color: 'var(--theme-text1)' }}>{receivingPo.vendors?.name || '—'}</strong>
            {' · '}Period: <strong style={{ color: 'var(--theme-text1)' }}>{periodLabel}</strong>
          </p>
        </div>

        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 20 }}>
            <div className="form-field" style={{ minWidth: 120 }}>
              <label>BS Day *</label>
              <input type="number" min="1" max="32" value={receiveBsDay}
                onChange={e => setReceiveBsDay(e.target.value)} placeholder="e.g. 15" />
            </div>
            <div className="form-field" style={{ minWidth: 140 }}>
              <label>
                <Tip width={260} text="Defaults to Credit — most PO deliveries are on credit terms. Change to Cash or FonePay if the vendor requires payment on delivery.">
                  Payment Method
                </Tip>
              </label>
              <select className="form-select" value={receivePayment} onChange={e => setReceivePayment(e.target.value)}>
                {PAYMENT_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="form-field" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
              <label style={{ visibility: 'hidden' }}>VAT</label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13,
                color: receiveVatInclusive ? 'var(--theme-accent)' : 'var(--theme-text3)', userSelect: 'none', paddingBottom: 6 }}>
                <input type="checkbox" checked={receiveVatInclusive} onChange={e => setReceiveVatInclusive(e.target.checked)}
                  style={{ width: 15, height: 15, accentColor: 'var(--theme-accent)', cursor: 'pointer' }} />
                <Tip text="Tick if the vendor's invoice rates include 13% VAT. The system strips VAT and stores the ex-VAT rate in the purchase entry." width={260}>
                  VAT Incl. (13%)
                </Tip>
              </label>
            </div>
          </div>

          <div className="table-wrap">
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
                  const rem = Math.max(0, l.qty_ordered - l.qty_received)
                  const val = parseFloat(l.receiving || 0) * l.unit_price
                  const isFullyReceived = l.qty_received >= l.qty_ordered
                  return (
                    <tr key={l.id} style={{ opacity: isFullyReceived ? 0.4 : 1 }}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{l.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{l.uom}</div>
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--theme-text2)' }}>{l.qty_ordered}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--theme-text2)' }}>{l.qty_received || 0}</td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: rem > 0 ? 'var(--theme-accent)' : 'var(--theme-green)' }}>{rem}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        {isFullyReceived ? (
                          <span style={{ color: 'var(--theme-green)', fontSize: 12 }}>✓ Done</span>
                        ) : (
                          <input type="number" min="0" max={rem} value={l.receiving}
                            onChange={e => setReceiveLines(prev => prev.map((x, i) => i === idx ? { ...x, receiving: e.target.value } : x))}
                            style={{ background: 'var(--theme-bg)', border: '1px solid rgba(201,168,76,0.4)', borderRadius: 5,
                              padding: '6px 10px', fontSize: 13, color: 'var(--theme-text1)', width: 90, textAlign: 'right', outline: 'none' }} />
                        )}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--theme-text2)' }}>
                        NPR {l.unit_price.toFixed(2)}
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>
                        {val > 0 ? `NPR ${val.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td colSpan={6} style={{ ...tdStyle, fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 16 }}>Total Receiving Value</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', fontSize: 15, paddingTop: 16 }}>
                    NPR {receiveLines.reduce((s, l) => s + parseFloat(l.receiving || 0) * l.unit_price, 0)
                      .toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {receiveError && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '16px 0 0' }}>{receiveError}</p>}

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
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>
        <button className="btn btn-ghost" onClick={() => setView('list')} style={{ marginBottom: 20, fontSize: 12 }}>← Back to POs</button>
        <h1 className="page-title">{editingPo ? `Edit ${editingPo.po_number}` : 'New Purchase Order'}</h1>

        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 20 }}>
            <div className="form-field">
              <label>Vendor *</label>
              <select className="form-select" value={poForm.vendor_id} onChange={e => setPoForm(f => ({ ...f, vendor_id: e.target.value }))}>
                <option value="">— Select vendor —</option>
                {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label>Period *</label>
              <select className="form-select" value={poForm.period_id} onChange={e => setPoForm(f => ({ ...f, period_id: e.target.value }))}>
                <option value="">— Select period —</option>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>
                    {BS_MONTHS[p.bs_month - 1]} {p.bs_year}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>
                <Tip width={240} text="Optional. The date you expect the vendor to deliver. Shown on the PO list for follow-up.">
                  Expected Delivery
                </Tip>
              </label>
              <BsCalendarPicker
                value={poForm.expected_date}
                onChange={v => setPoForm(f => ({ ...f, expected_date: v }))}
                placeholder="Pick delivery date"
                clearable />
            </div>
            <div className="form-field" style={{ gridColumn: 'span 2' }}>
              <label>Notes</label>
              <input value={poForm.notes} onChange={e => setPoForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. Deliver before 10am, use back entrance…" />
            </div>
          </div>

          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 12, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>Items</div>
            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={addPoItemRow}>+ Add Row</button>
          </div>

          <div className="table-wrap">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, paddingLeft: 0 }}>Item</th>
                <th style={{ ...thStyle, textAlign: 'right', width: 110 }}>Qty</th>
                <th style={{ ...thStyle, width: 70 }}>UOM</th>
                <th style={{ ...thStyle, textAlign: 'right', width: 130 }}>
                  <Tip width={230} text="Pre-agreed price per base unit. Auto-filled from item's last purchase rate — adjust if the vendor quoted a different price.">
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
                      <select value={row.item_id} onChange={e => handleItemSelect(row._key, e.target.value)}
                        className="form-select" style={{ width: '100%' }}>
                        <option value="">— Select item —</option>
                        {items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                      </select>
                    </td>
                    <td style={{ padding: '5px 8px' }}>
                      <input type="number" min="0" value={row.qty_ordered}
                        onChange={e => updatePoItem(row._key, 'qty_ordered', e.target.value)}
                        placeholder="0"
                        style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5,
                          padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', textAlign: 'right' }} />
                    </td>
                    <td style={{ padding: '5px 8px', fontSize: 12, color: 'var(--theme-text2)' }}>{item?.uom || '—'}</td>
                    <td style={{ padding: '5px 8px' }}>
                      <input type="number" min="0" value={row.unit_price}
                        onChange={e => updatePoItem(row._key, 'unit_price', e.target.value)}
                        placeholder="0.00"
                        style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5,
                          padding: '7px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', textAlign: 'right' }} />
                    </td>
                    <td style={{ padding: '5px 8px', textAlign: 'right', fontSize: 13, color: subtotal > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)', fontWeight: 600 }}>
                      {subtotal > 0 ? `NPR ${subtotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
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
                  <td style={{ paddingTop: 12, textAlign: 'right', fontWeight: 800, color: 'var(--theme-accent)', fontSize: 15 }}>
                    NPR {liveTotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
          </div>

          {formError && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '16px 0 0' }}>{formError}</p>}

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
    <div style={{ padding: '32px 24px', maxWidth: 1100, margin: '0 auto' }}>

      {/* ── PRINT-ONLY PO DOCUMENT ── */}
      {printPo && (() => {
        const po = printPo
        const total = getPoTotal(po)
        return (
          <div className="print-only" style={{ fontFamily: 'Georgia, serif', color: '#111', padding: '32px 48px', maxWidth: 740, margin: '0 auto' }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #111', paddingBottom: 16, marginBottom: 24 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.04em' }}>PURCHASE ORDER</div>
                <div style={{ fontSize: 13, color: '#555', marginTop: 4 }}>Crest Suite</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#111', fontFamily: 'monospace' }}>{po.po_number}</div>
                <div style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
                  Period: {periodLabel}
                </div>
                {po.expected_date && (
                  <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>
                    Expected: {po.expected_date}
                  </div>
                )}
                <div style={{ marginTop: 6 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 3,
                    border: `1px solid #999`, color: '#333', letterSpacing: '0.06em', textTransform: 'uppercase'
                  }}>{po.status}</span>
                </div>
              </div>
            </div>

            {/* Vendor */}
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#888', marginBottom: 4 }}>Vendor</div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{po.vendors?.name || '—'}</div>
            </div>

            {/* Notes */}
            {po.notes && (
              <div style={{ marginBottom: 20, padding: '10px 14px', border: '1px solid #ddd', borderRadius: 4, fontSize: 13, color: '#444' }}>
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
                {(po.purchase_order_items || []).map((x, idx) => {
                  const subtotal = parseFloat(x.qty_ordered) * parseFloat(x.unit_price || 0)
                  return (
                    <tr key={x.id} style={{ borderBottom: '1px solid #eee' }}>
                      <td style={{ padding: '9px 10px', fontSize: 13, color: '#888' }}>{idx + 1}</td>
                      <td style={{ padding: '9px 10px', fontSize: 13, fontWeight: 600 }}>{x.items?.name || '—'}</td>
                      <td style={{ padding: '9px 10px', fontSize: 13, textAlign: 'right' }}>{x.qty_ordered}</td>
                      <td style={{ padding: '9px 10px', fontSize: 13, color: '#555' }}>{x.items?.uom || '—'}</td>
                      <td style={{ padding: '9px 10px', fontSize: 13, textAlign: 'right' }}>
                        {x.unit_price ? `NPR ${parseFloat(x.unit_price).toLocaleString('en-NP', { maximumFractionDigits: 2 })}` : '—'}
                      </td>
                      <td style={{ padding: '9px 10px', fontSize: 13, textAlign: 'right', fontWeight: 600 }}>
                        {subtotal > 0 ? `NPR ${subtotal.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #ccc' }}>
                  <td colSpan={5} style={{ padding: '12px 10px', textAlign: 'right', fontWeight: 700, fontSize: 13 }}>PO Total</td>
                  <td style={{ padding: '12px 10px', textAlign: 'right', fontWeight: 800, fontSize: 16 }}>
                    NPR {total.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
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
              Generated by Crest Suite · {new Date().toLocaleDateString('en-NP')}
            </div>
          </div>
        )
      })()}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 16 }}>
        <div>
          <h1 className="page-title">Purchase Orders</h1>
          <p className="page-subtitle">{pos.length} POs · {periodLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
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

      {/* Status filter pills */}
      <div className="tab-bar" style={{ marginBottom: 20 }}>
        {[['all', 'All', pos.length], ...Object.entries(STATUS_META).map(([k, m]) => [k, m.label, statusCounts[k] || 0])].map(([key, label, count]) => (
          <button key={key} onClick={() => setFilterStatus(key)} className={`tab-btn${filterStatus === key ? ' tab-btn--active' : ''}`}>
            {label} {count > 0 && <span style={{ opacity: 0.7 }}>({count})</span>}
          </button>
        ))}
      </div>

      {filteredPos.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">▤</div>
          <p className="empty-state-text">
            {pos.length === 0
              ? 'No purchase orders for this period. Click + New PO to create one.'
              : `No ${filterStatus} POs.`}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
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
                const receivedCount = (po.purchase_order_items || []).filter(x => parseFloat(x.qty_received || 0) >= parseFloat(x.qty_ordered)).length
                const canReceive = ['draft', 'sent', 'partial'].includes(po.status)
                const canEdit = po.status === 'draft'
                return (
                  <tr key={po.id} style={{ opacity: po.status === 'cancelled' ? 0.45 : 1 }}>
                    <td>
                      <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: 'var(--theme-accent)' }}>{po.po_number}</span>
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{po.vendors?.name || '—'}</td>
                    <td><StatusBadge status={po.status} /></td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 12 }}>
                      {receivedCount}/{itemCount} items
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)' }}>
                      {total > 0 ? `NPR ${total.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
                    </td>
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{po.expected_date || '—'}</td>
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{po.notes || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {canReceive && (
                          <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 12px' }}
                            onClick={() => openReceive(po)}>
                            <Tip width={260} text="Open Goods Receipt Note (GRN). Enter quantities received and auto-create purchase entries for this period.">
                              Receive
                            </Tip>
                          </button>
                        )}
                        {po.status === 'draft' && (
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
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: 'var(--theme-red)' }}
                            onClick={() => deletePo(po)}>
                            <Tip width={220} text="Admin only — permanently delete this PO and its line items. Purchase entries already created are not affected.">
                              Delete
                            </Tip>
                          </button>
                        )}
                        {canReceive && (
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: 'var(--theme-red)' }}
                            onClick={() => cancelPo(po)}>
                            <Tip width={220} text="Cancel this PO. No purchase entries will be created. Cannot be undone.">
                              Cancel
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

      <Fab onClick={openNew} label="+ New PO" show={!!selectedPeriod} />
    </div>
  )
}
