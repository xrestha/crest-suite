import { Fragment, useState } from 'react'
import Tip from '../../../components/Tip'
import RowDisclosure from '../../../components/RowDisclosure'
import RowMenu from '../../../components/RowMenu'
import { npr, npr2 } from '../../../shared/nepalMoney'
import { nepalTime } from '../../../shared/nepalTime'
import { bsDateLabel, statusLabel } from './transferFlows'
import { qtyLabel } from './explodePrepLines'

const STATUS_BADGE = {
  on_the_way: 'badge-amber',
  received: 'badge-green',
  cancelled: 'badge-gray',
  refused: 'badge-gray',
}

const STATUS_TIP = 'On the way: it has left the sending outlet and does not count at the receiving outlet yet. '
  + 'Received: it counts at the receiving outlet from the day it was received; final. '
  + 'Cancelled (by the sender) or Refused (by the receiving outlet): the stock went back on the sending outlet\'s books.'

const TOTAL_TIP = 'At the sending outlet\'s item prices on the day it was sent. The price is frozen on the transfer, '
  + 'so both outlets carry the same value to the paisa.'

/**
 * One list of transfer headers (Incoming or Outgoing). `mode` decides which outlet each row names and
 * which item name a line shows: the receiver sees its own item, the sender its own. Dates are the
 * stored labels, as recorded (the other outlet's period rows are not readable here). `actions(row)`
 * returns `{ primary?: { label, ariaLabel, onClick, disabled }, menu?: RowMenu items }`: `ariaLabel` names the
 * transfer, because the same label repeats down the list. Below 600px the rows render as phone cards.
 */
export default function TransferTable({ rows, mode, actions, busyId, caption }) {
  const [open, setOpen] = useState(() => new Set())
  const toggle = id => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const incoming = mode === 'incoming'
  const otherOf = t => (incoming ? t.from_name : t.to_name)

  // The row's buttons, for the table and the phone list alike. While busy the button says Working…,
  // so its own name stands in; otherwise `ariaLabel` names the transfer and starts with the label.
  const actionsOf = (t, act, size = '') => (
    <>
      {act.primary && (
        <button type="button" className={`btn btn-primary${size ? ` ${size}` : ''}`} onClick={act.primary.onClick}
          disabled={act.primary.disabled || busyId === t.id}
          aria-label={busyId === t.id ? undefined : act.primary.ariaLabel}>
          {busyId === t.id ? 'Working…' : act.primary.label}
        </button>
      )}
      {act.menu && (
        <RowMenu label={`More for the transfer ${incoming ? 'from' : 'to'} ${otherOf(t) || 'another outlet'}`}
          items={act.menu} busy={busyId === t.id} />
      )}
    </>
  )

  return (
    <>
      <div className="table-wrap phone-hide">
        <table className="data-table">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              <th aria-label="Lines" />
              <th>Sent</th>
              <th>{incoming ? 'From' : 'To'}</th>
              <th style={{ textAlign: 'right' }}><Tip text={TOTAL_TIP} width={280}>Value</Tip></th>
              <th><Tip text={STATUS_TIP} width={320}>Status</Tip></th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map(t => {
              const lines = Array.isArray(t.lines) ? t.lines : []
              const expanded = open.has(t.id)
              const act = actions?.(t) || {}
              const other = incoming ? t.from_name : t.to_name
              const detailId = `transfer-lines-${t.id}`
              return (
                <Fragment key={t.id}>
                  <tr>
                    <td style={{ width: 36 }}>
                      <RowDisclosure expanded={expanded} onToggle={() => toggle(t.id)} controls={detailId}
                        label={`${expanded ? 'Hide' : 'Show'} the ${lines.length} line${lines.length === 1 ? '' : 's'} of this transfer`} />
                    </td>
                    <td>
                      <span style={{ whiteSpace: 'nowrap' }}>{bsDateLabel(t.sent_bs_year, t.sent_bs_month, t.sent_bs_day)}</span>
                      <span className="cell-sub">
                        <span style={{ whiteSpace: 'nowrap' }}>{nepalTime(t.sent_at)}</span>
                        {t.sent_by_name ? ` by ${t.sent_by_name}` : ''}
                      </span>
                    </td>
                    <td>
                      {other || '—'}
                      {t.note && <span className="cell-sub">“{t.note}”</span>}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {npr(t.total_value)}
                      <span className="cell-sub">{lines.length} item{lines.length === 1 ? '' : 's'}</span>
                    </td>
                    <td>
                      <span className={`badge ${STATUS_BADGE[t.status] || 'badge-gray'}`}>{statusLabel(t.status)}</span>
                      {t.status !== 'on_the_way' && (
                        <span className="cell-sub">
                          <span style={{ whiteSpace: 'nowrap' }}>{bsDateLabel(t.ended_bs_year, t.ended_bs_month, t.ended_bs_day)}</span>
                          {t.ended_by_name ? ` by ${t.ended_by_name}` : ''}
                          {t.end_reason ? ` — ${t.end_reason}` : ''}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                        {actionsOf(t, act, 'btn-sm')}
                      </div>
                    </td>
                  </tr>
                  {expanded && (
                    <tr id={detailId}>
                      <td />
                      <td colSpan={5}>
                        <table className="data-table" style={{ margin: 0 }}>
                          <thead>
                            <tr>
                              <th>{incoming ? 'Your item' : 'Item'}</th>
                              {!incoming && <th>At {t.to_name}</th>}
                              <th style={{ textAlign: 'right' }}>Quantity</th>
                              <th style={{ textAlign: 'right' }}>Rate</th>
                              <th style={{ textAlign: 'right' }}>Value</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map((l, i) => (
                              <tr key={`${l.item_id || i}`}>
                                <td>
                                  {incoming ? (l.to_name || '—') : (l.name || '—')}
                                  {incoming && l.name && l.name !== l.to_name && <span className="cell-sub">{t.from_name}: {l.name}</span>}
                                  {l.prep_label && <span className="cell-sub">{l.prep_label}</span>}
                                </td>
                                {!incoming && <td>{l.to_name || '—'}</td>}
                                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{qtyLabel(l.qty, l.uom)}</td>
                                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{l.rate != null ? npr2(l.rate) : '—'}</td>
                                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{npr2(l.value)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* S852, the S796 phone-cards pattern: six columns put the value, the status and Receive past a
          phone's edge. One card per transfer, from the same rows, the value on the first line, the lines
          one tap away, the actions last. CSS shows the table or this, never both, and this never prints. */}
      <ul className="phone-cards phone-only phone-cards--no-fab" aria-label={caption || 'Transfers'}>
        {rows.map(t => {
          const lines = Array.isArray(t.lines) ? t.lines : []
          const act = actions?.(t) || {}
          const other = otherOf(t)
          const ended = t.status !== 'on_the_way'
          return (
            <li key={t.id} className="phone-card">
              <div className="phone-card__top">
                <span className="phone-card__title">{incoming ? 'From' : 'To'} {other || '—'}</span>
                <span className="phone-card__figure">{npr(t.total_value)}</span>
              </div>
              <div className="phone-card__meta">
                <span className={`badge ${STATUS_BADGE[t.status] || 'badge-gray'}`}>{statusLabel(t.status)}</span>
                {' '}Sent <span style={{ whiteSpace: 'nowrap' }}>{bsDateLabel(t.sent_bs_year, t.sent_bs_month, t.sent_bs_day)}</span>
                {' '}<span style={{ whiteSpace: 'nowrap' }}>{nepalTime(t.sent_at)}</span>
                {t.sent_by_name ? ` by ${t.sent_by_name}` : ''}
              </div>
              {ended && (
                <div className="phone-card__meta">
                  {statusLabel(t.status)} <span style={{ whiteSpace: 'nowrap' }}>{bsDateLabel(t.ended_bs_year, t.ended_bs_month, t.ended_bs_day)}</span>
                  {t.ended_by_name ? ` by ${t.ended_by_name}` : ''}
                  {t.end_reason ? ` — ${t.end_reason}` : ''}
                </div>
              )}
              {t.note && <div className="phone-card__meta">“{t.note}”</div>}
              <details className="phone-card__lines">
                <summary>Show {lines.length === 1 ? 'the item' : `the ${lines.length} items`}</summary>
                <ul>
                  {lines.map((l, i) => (
                    <li key={`${l.item_id || i}`}>
                      <span>{incoming ? (l.to_name || '—') : (l.name || '—')} — {qtyLabel(l.qty, l.uom)}</span>
                      <span>{npr2(l.value)}</span>
                    </li>
                  ))}
                </ul>
              </details>
              {(act.primary || act.menu) && <div className="phone-card__actions">{actionsOf(t, act)}</div>}
            </li>
          )
        })}
      </ul>
    </>
  )
}
