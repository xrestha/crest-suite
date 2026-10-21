import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import SearchableSelect from '../../../components/SearchableSelect'
import QtyInput from '../../../components/QtyInput'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import ActionError, { asActionError } from '../../../components/ActionError'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { explodeRecipeTree } from '../../../utils/recipeCost'
import { settleWithin, isTimeout } from '../../../utils/withTimeout'
import { randomUUID } from '../../../utils/uuid'
import { npr, npr2 } from '../../../shared/nepalMoney'
import {
  MAX_TRANSFER_LINES, bsDateLabel, planHasProblems, problemText, sendStockTransfer,
} from './transferFlows'
import { explodePrepLines, prepProblemText, qtyLabel } from './explodePrepLines'

const WRITE_MS = 20000

// The Send tab (S849, PNL-8). The sender picks raw items or prep; prep is sent as the raw ingredients
// it was made from (explodePrepLines over the one recipe walk). Preview always runs first: it is
// send_stock_transfer's dry run, and the plan it returns (the receiving item per line, or the reason a
// line cannot go, at the sender's frozen rate) is exactly what Send applies. Send carries an id minted
// per send attempt and kept for retries of that attempt, so a retry after a lost answer cannot send
// twice (the server replays it).
export default function SendTransferForm({
  clientId, fromName, receivers, items, recipeByPrep, recipeBook, audience, onSent,
}) {
  const [toId, setToId] = useState('')
  const [note, setNote] = useState('')
  const [picks, setPicks] = useState([])            // [{ key, item_id, qty }]
  const [pickItem, setPickItem] = useState('')
  const [pickQty, setPickQty] = useState('')
  const [walk, setWalk] = useState({})               // recipe id → walk output (prep explosion)
  const [walkError, setWalkError] = useState(null)
  const [fieldErr, setFieldErr] = useState({})
  const [error, setError] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [plan, setPlan] = useState(null)             // dry-run answer + { sentLines, transferId, toName }
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState(null)
  const keyRef = useRef(0)
  const removeButtons = useRef(new Map())            // pick key → its × button
  const focusAfterRemove = useRef(null)              // a pick key, or 'pick' for the Item picker

  const itemsById = useMemo(() => new Map(items.map(i => [i.id, i])), [items])
  const toName = receivers.find(r => r.id === toId)?.name || ''

  const itemOptions = useMemo(() => items.map(i => ({
    value: i.id,
    label: i.is_sub_recipe
      ? `${i.name} (${i.uom || 'unit'}) — prep, sent as its ingredients`
      : `${i.name} (${i.uom || 'unit'})`,
  })), [items])
  const receiverOptions = useMemo(() => receivers.map(r => ({ value: r.id, label: r.name })), [receivers])

  // The raw lines the server will be sent, from the picks as they stand. Prep picks whose walk has
  // not landed yet contribute nothing until it does (the row says "working out…").
  const exploded = useMemo(
    () => explodePrepLines({ picks, itemsById, recipeByPrep, walk }),
    [picks, itemsById, recipeByPrep, walk],
  )
  const rawByPick = useMemo(() => {
    const out = {}
    for (const p of picks) {
      const item = itemsById.get(p.item_id)
      if (!item?.is_sub_recipe) continue
      out[p.key] = explodePrepLines({ picks: [p], itemsById, recipeByPrep, walk })
    }
    return out
  }, [picks, itemsById, recipeByPrep, walk])

  async function ensureWalk(itemId) {
    const recipe = recipeByPrep.get(itemId)
    if (!recipe || walk[recipe.id]) return
    setWalkError(null)
    try {
      const book = await recipeBook()
      const w = await explodeRecipeTree(supabase, [recipe.id], { book })
      setWalk(prev => ({ ...prev, ...w }))
    } catch (e) {
      setWalkError(asActionError(e, audience))
    }
  }

  function changed() {
    // Any edit makes a fresh send attempt: the open preview no longer describes the form.
    setError(null)
    setSendError(null)
  }

  function addPick() {
    const qty = Number(pickQty)
    const errs = {}
    if (!pickItem) errs.pick = 'Pick an item to add.'
    else if (!(qty > 0)) errs.pick = 'Enter a quantity above 0, then press Add.'
    setFieldErr(errs)
    if (errs.pick) return
    changed()
    setPicks(prev => {
      // Lines naming one item merge: adding it again adds to its quantity.
      const at = prev.findIndex(p => p.item_id === pickItem)
      if (at >= 0) return prev.map((p, i) => (i === at ? { ...p, qty: (Number(p.qty) || 0) + qty } : p))
      keyRef.current += 1
      return [...prev, { key: keyRef.current, item_id: pickItem, qty }]
    })
    if (itemsById.get(pickItem)?.is_sub_recipe) ensureWalk(pickItem)
    setPickItem('')
    setPickQty('')
  }

  function setPickQtyAt(key, qty) {
    changed()
    setPicks(prev => prev.map(p => (p.key === key ? { ...p, qty } : p)))
  }

  function removePick(key) {
    changed()
    // S852: the × leaves with its line, and focus fell to the page. It moves to the next line's ×
    // (the one before, for the last line), or back to the Item picker once no line is left.
    const at = picks.findIndex(p => p.key === key)
    const neighbour = picks[at + 1] || picks[at - 1]
    focusAfterRemove.current = neighbour ? neighbour.key : 'pick'
    setPicks(prev => prev.filter(p => p.key !== key))
  }
  useEffect(() => {
    const target = focusAfterRemove.current
    if (target == null) return
    focusAfterRemove.current = null
    const el = target === 'pick' ? document.getElementById('transfer-pick') : removeButtons.current.get(target)
    el?.focus()
  }, [picks])

  async function preview() {
    const errs = {}
    if (!toId) errs.to = 'Pick the outlet the stock is going to.'
    if (picks.length === 0) errs.pick = 'Add at least one item to send.'
    else if (picks.some(p => !(Number(p.qty) > 0))) errs.pick = 'Every line needs a quantity above 0.'
    setFieldErr(errs)
    setError(null)
    if (errs.to || errs.pick) return
    if (exploded.problems.length > 0) {
      const first = exploded.problems[0]
      setError(`${itemsById.get(first.item_id)?.name || 'A prep item'}: ${prepProblemText(first.problem)}`)
      return
    }
    const waitingForWalk = picks.some(p => itemsById.get(p.item_id)?.is_sub_recipe
      && recipeByPrep.get(p.item_id) && !walk[recipeByPrep.get(p.item_id).id])
    if (waitingForWalk) {
      setError(walkError ? 'The recipes behind a prep item could not be read, so its ingredients are not known yet. Remove it and add it again.' : 'Still working out the ingredients of a prep item. Press Preview again in a moment.')
      return
    }
    if (exploded.lines.length > MAX_TRANSFER_LINES) {
      setError(`A transfer holds at most ${MAX_TRANSFER_LINES} lines and this one has ${exploded.lines.length}. Send it as two.`)
      return
    }
    setPreviewing(true)
    const { data, error: err } = await settleWithin(sendStockTransfer({
      transferId: randomUUID(), fromClientId: clientId, toClientId: toId,
      lines: exploded.lines, note, dryRun: true,
    }), WRITE_MS, 'Preview')
    setPreviewing(false)
    if (err) { setError(asActionError(err, audience)); return }
    setSendError(null)
    // The id for THIS send attempt, kept for its retries.
    setPlan({ ...data, sentLines: exploded.lines, transferId: randomUUID(), toName: data?.to_name || toName })
  }

  async function send() {
    if (!plan || planHasProblems(plan)) return
    setSending(true)
    setSendError(null)
    const { data, error: err } = await settleWithin(sendStockTransfer({
      transferId: plan.transferId, fromClientId: clientId, toClientId: toId,
      lines: plan.sentLines, note, dryRun: false,
    }), WRITE_MS, 'Send')
    setSending(false)
    if (err) {
      if (isTimeout(err)) {
        setSendError('No answer from the server, so it is not known whether the stock was sent. Press Send again: '
          + 'this is the same transfer, so it cannot be sent twice. Or close this and check Outgoing.')
      } else {
        setSendError(asActionError(err, audience))
      }
      return
    }
    const sentTo = plan.toName
    setPlan(null)
    setPicks([])
    setNote('')
    setToId('')
    setWalk({})
    onSent?.({ ...data, toName: sentTo })
  }

  const planBad = planHasProblems(plan)

  return (
    <div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="field-grid">
          <div className="form-field">
            <label htmlFor="transfer-to">
              <Tip text="Only the other outlets of your group that run Crest Inventory are listed." width={260}>Send to</Tip>
            </label>
            <SearchableSelect id="transfer-to" value={toId} onChange={v => { changed(); setToId(v); setFieldErr(f => ({ ...f, to: '' })) }}
              options={receiverOptions} placeholder="— Receiving outlet —" invalid={fieldErr.to} />
            <FieldError id="transfer-to" message={fieldErr.to} />
          </div>
          <div className="form-field field-grid__wide">
            <label htmlFor="transfer-note">Note for the receiving outlet</label>
            <textarea id="transfer-note" className="form-input" rows={2} maxLength={500} value={note}
              onChange={e => { changed(); setNote(e.target.value) }}
              placeholder="e.g. Sent with Ram on the 3 pm van" style={{ resize: 'vertical', fontFamily: 'inherit' }} />
          </div>
        </div>

        <div className="field-grid" style={{ marginTop: 12, alignItems: 'end' }}>
          <div className="form-field field-grid__wide">
            <label htmlFor="transfer-pick">
              <Tip text="Your active items. A prep item (momo filling, a sauce) is sent as the raw ingredients it was made from, worked out from its recipe, because every food-cost figure counts prep at that level." width={300}>Item</Tip>
            </label>
            <SearchableSelect id="transfer-pick" value={pickItem} onChange={v => { setPickItem(v); setFieldErr(f => ({ ...f, pick: '' })) }}
              options={itemOptions} placeholder="— Pick an item —" invalid={fieldErr.pick} />
          </div>
          <div className="form-field">
            <label htmlFor="transfer-qty">Quantity{pickItem && itemsById.get(pickItem)?.uom ? ` (${itemsById.get(pickItem).uom})` : ''}</label>
            {/* No onKeyDown here: QtyInput spreads extra props after its own, so one would replace its
                Enter-commits / Escape-cancels handling. Enter commits the box; Add adds the line. */}
            <QtyInput id="transfer-qty" className="form-input" value={pickQty} onChange={setPickQty} onCommit={setPickQty}
              {...fieldAria('transfer-pick', fieldErr.pick)} />
          </div>
          <div className="form-field">
            <button type="button" className="btn btn-ghost" onClick={addPick}>Add</button>
          </div>
        </div>
        <FieldError id="transfer-pick" message={fieldErr.pick} />
      </div>

      {picks.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 12 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ textAlign: 'right' }}>Quantity</th>
                <th>Unit</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {picks.map(p => {
                const item = itemsById.get(p.item_id)
                const prep = item?.is_sub_recipe
                const raw = rawByPick[p.key]
                const recipe = prep ? recipeByPrep.get(p.item_id) : null
                const walking = prep && recipe && !walk[recipe.id]
                return (
                  <tr key={p.key}>
                    <td>
                      {item?.name || 'Unknown item'}
                      {prep && (
                        walking ? <span className="cell-sub">{walkError ? 'Its recipe could not be read.' : 'Working out its ingredients…'}</span>
                          : raw?.problems.length ? <span className="cell-sub" style={{ color: 'var(--theme-red-text)' }}>{prepProblemText(raw.problems[0].problem)}</span>
                            : (
                              <span className="cell-sub">
                                Sent as: {(raw?.lines || []).map(l => `${itemsById.get(l.item_id)?.name || 'item'} ${qtyLabel(l.qty, itemsById.get(l.item_id)?.uom)}`).join(', ') || '—'}
                              </span>
                            )
                      )}
                    </td>
                    <td style={{ textAlign: 'right', width: 140 }}>
                      <QtyInput className="form-input" value={p.qty} aria-label={`Quantity of ${item?.name || 'item'}`}
                        onChange={v => setPickQtyAt(p.key, v)} onCommit={v => setPickQtyAt(p.key, v)} style={{ textAlign: 'right' }} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{item?.uom || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button type="button" className="btn btn-ghost btn-icon btn-icon--delete" aria-label={`Remove ${item?.name || 'line'}`}
                        title={`Remove ${item?.name || 'line'}`} onClick={() => removePick(p.key)}
                        ref={el => { if (el) removeButtons.current.set(p.key, el); else removeButtons.current.delete(p.key) }}>×</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <ActionError error={walkError} />
      <ActionError error={error} />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary" onClick={preview} disabled={previewing}
          aria-disabled={exploded.lines.length > MAX_TRANSFER_LINES || undefined}>
          {previewing ? 'Checking…' : 'Preview'}
        </button>
        {picks.length > 0 && (
          <span style={{ fontSize: 12, color: exploded.lines.length > MAX_TRANSFER_LINES ? 'var(--theme-amber-text)' : 'var(--theme-text2)' }}>
            {exploded.lines.length} line{exploded.lines.length === 1 ? '' : 's'} to send
            {exploded.lines.length > MAX_TRANSFER_LINES && ` — one transfer holds at most ${MAX_TRANSFER_LINES}, so send it as two`}
          </span>
        )}
      </div>

      {plan && (
        <Modal title={`Send to ${plan.toName}?`} onClose={sending ? () => {} : () => setPlan(null)} maxWidth={760}>
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
            This stock leaves {fromName} now and counts at {plan.toName} only when they press Received.
            {' '}It is recorded in {bsDateLabel(plan.sent_bs_year, plan.sent_bs_month, plan.sent_bs_day)}.
          </p>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th><Tip text="The item at the other outlet this line lands on. Items match through Push master data, never by name." width={260}>At {plan.toName}</Tip></th>
                  <th style={{ textAlign: 'right' }}>Quantity</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Your item price today. It is frozen on the transfer, so both outlets carry the same value." width={240}>Rate</Tip></th>
                  <th style={{ textAlign: 'right' }}>Value</th>
                </tr>
              </thead>
              <tbody>
                {(plan.lines || []).map(l => (
                  <tr key={l.item_id || l.name} className={l.problem ? 'row-tinted' : undefined}>
                    <td>
                      {l.name || itemsById.get(l.item_id)?.name || 'Unknown item'}
                      {l.prep_label && <span className="cell-sub">{l.prep_label}</span>}
                    </td>
                    <td>
                      {l.problem
                        ? <span style={{ color: 'var(--theme-red-text)' }}>{problemText(l.problem)}</span>
                        : l.to_name}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{qtyLabel(l.qty, l.uom)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{l.rate != null ? npr2(l.rate) : '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{l.problem ? '—' : npr2(l.value)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4} style={{ fontWeight: 600 }}>Total</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>{npr(plan.total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          {planBad && (
            <p role="status" style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--theme-amber-text)' }}>
              Some lines can't be sent as they are (the reason is on each line). Close this, fix or remove them, and preview again.
            </p>
          )}
          <ActionError error={sendError} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setPlan(null)} disabled={sending}>Back</button>
            <button type="button" className="btn btn-primary" onClick={send} disabled={sending || planBad}>
              {sending ? 'Sending…' : `Send ${npr(plan.total)}`}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
