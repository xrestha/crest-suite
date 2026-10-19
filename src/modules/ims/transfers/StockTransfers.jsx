// Stock Transfers (S849, PNL-8; owner answer (b), 2026-10-16): stock moved between two outlets of one
// group counts at the receiving outlet only once it presses Received.
//
//   Send     → on the way: the stock leaves the sender now ('sent' lines, out, in its open month).
//   Receive  → received (final): it counts at the receiver from that day, in its open month.
//   Cancel (sender's Inventory manager / Owner) or Refuse (receiver's supervisor+ / Owner), with a
//            reason → the stock goes back on the sender's books.
//
// Every write is a SECURITY DEFINER RPC (send / receive / end_stock_transfer) that checks rank, group,
// open months and items itself; this page's rank checks only decide which buttons to offer. The page
// is period-free: it works on transfers, and each row says which month it counted in.
//
// Reads: Outgoing through the scoped layer (the header's client_id is the sender); Incoming through
// transferFlows.readIncomingTransfers by to_client_id, the one documented exception to scopedDb.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { useRecipeBook } from '../../../shared/hooks/useRecipeBook'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { withTimeout, settleWithin, isTimeout } from '../../../utils/withTimeout'
import { BS_MONTHS, getBsToday } from '../../../utils/bsCalendar'
import { npr } from '../../../shared/nepalMoney'
import { nepalTime24 } from '../../../shared/nepalTime'
import Tabs from '../../../components/Tabs'
import Tip from '../../../components/Tip'
import ConfirmModal from '../../../components/ConfirmModal'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import FieldError, { fieldAria } from '../../../components/FieldError'
import SendTransferForm from './SendTransferForm'
import TransferTable from './TransferTable'
import {
  TRANSFER_LINE_SELECT, bsDateLabel, endStockTransfer, readIncomingTransfers, readOutgoingTransfers,
  readPeriodTransfers, receiveStockTransfer,
} from './transferFlows'

const LOAD_MS = 20000
const WRITE_MS = 20000
const HISTORY_PAGE = 50

const periodName = p => (p ? `${BS_MONTHS[p.bs_month - 1] || `Month ${p.bs_month}`} ${p.bs_year}` : '')

export default function StockTransfers() {
  const {
    clientId, groupId, outlets, isAdmin, isOwner, hasImsAccess, profile, adminViewClientName,
  } = useAuth()
  const { scopedFrom } = useScopedDb()
  const recipeBook = useRecipeBook()
  const req = useLatestRequest()
  const biz = useBizInfo()
  const { ask, confirmEl } = useConfirm()

  // For the operator, AuthContext's groupId and outlets are the VIEWED client's group (ACCESS-8 /
  // GAPS-6), never the operator's own row, so one rule serves every login.
  const allowed = hasImsAccess('supervisor') && !!groupId
  const canCancel = isAdmin || isOwner || hasImsAccess('manager')
  // A supervisor can only escalate; a manager, the Owner and the operator can act on the message.
  const audience = isAdmin || isOwner || hasImsAccess('manager') ? 'operator' : 'staff'

  const [tab, setTab] = useState('send')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [actionError, setActionError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [reasonDraft, setReasonDraft] = useState(null)   // { transfer, action, reason, err, busy, error }
  const [showAllHistory, setShowAllHistory] = useState(false)
  const [exportPeriodId, setExportPeriodId] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(null)

  const load = useCallback(async () => {
    if (!clientId || !allowed) return
    const key = req.begin(clientId)
    setLoading(true)
    let results
    try {
      results = await withTimeout(Promise.all([
        fetchAllRows(() => scopedFrom('items', 'id, name, uom, is_sub_recipe')
          .eq('is_active', true).order('name').order('id')),
        fetchAllRows(() => scopedFrom('recipes', 'id, name, yield_qty, yield_uom, linked_item_id')
          .not('linked_item_id', 'is', null).order('id')),
        readIncomingTransfers(clientId),
        readOutgoingTransfers(scopedFrom),
        fetchAllRows(() => scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
          .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }).order('id')),
      ]), LOAD_MS, 'Loading Stock Transfers')
    } catch (e) {
      if (!req.isCurrent(key)) return
      setLoadError(e)
      setLoading(false)
      return
    }
    if (!req.isCurrent(key)) return
    const failed = results.find(r => r.error)?.error
    if (failed) {
      setLoadError(failed)
      setLoading(false)
      return
    }
    const [items, prepRecipes, incoming, outgoing, periods] = results.map(r => r.data)
    setData({ items, prepRecipes, incoming, outgoing, periods })
    setLoadError(null)
    setLoading(false)
    setExportPeriodId(prev => prev || periods.find(p => p.status === 'open')?.id || periods[0]?.id || '')
  }, [clientId, allowed, scopedFrom, req])

  useEffect(() => { load() }, [load])

  const fromName = useMemo(() => (
    (outlets || []).find(o => o.id === clientId)?.name
      || (isAdmin ? adminViewClientName : profile?.clients?.name)
      || 'this outlet'
  ), [isAdmin, adminViewClientName, outlets, clientId, profile])

  // Sibling outlets that can receive: same group, not this one, Inventory on (NULL counts as on).
  const receivers = useMemo(() => (outlets || []).filter(o => o.id !== clientId && o.ims_enabled !== false
    && (!o.group_id || o.group_id === groupId)), [outlets, clientId, groupId])

  const recipeByPrep = useMemo(
    () => new Map((data?.prepRecipes || []).map(r => [r.linked_item_id, r])),
    [data],
  )

  const openPeriod = useMemo(() => (data?.periods || []).find(p => p.status === 'open') || null, [data])
  const today = useMemo(() => getBsToday(), [])

  const lists = useMemo(() => {
    const incoming = data?.incoming || []
    const outgoing = data?.outgoing || []
    const endedThisMonth = t => t.ended_bs_year === today.year && t.ended_bs_month === today.month
    const newestEnded = (a, b) => String(b.ended_at || '').localeCompare(String(a.ended_at || ''))
    return {
      inWaiting: incoming.filter(t => t.status === 'on_the_way'),
      inRecent: incoming.filter(t => t.status !== 'on_the_way' && endedThisMonth(t)).sort(newestEnded),
      outWaiting: outgoing.filter(t => t.status === 'on_the_way'),
      outHistory: outgoing.filter(t => t.status !== 'on_the_way').sort(newestEnded),
    }
  }, [data, today])

  function onSent(result) {
    setActionError(null)
    setNotice(result?.replayed
      ? `That transfer was already sent (it is ${result.status === 'on_the_way' ? 'on the way' : result.status}). Nothing was sent twice.`
      : `Sent — on the way to ${result?.toName || 'the other outlet'}, ${npr(result?.total)}. It counts there once they press Received.`)
    setTab('outgoing')
    load()
  }

  function askReceive(t) {
    const lines = Array.isArray(t.lines) ? t.lines.length : 0
    const into = openPeriod ? periodName(openPeriod) : 'your open month'
    setNotice(null)
    setActionError(null)
    ask({
      title: `Receive the stock from ${t.from_name}?`,
      body: (
        <p style={{ margin: 0 }}>
          Receive {lines} item{lines === 1 ? '' : 's'}, {npr(t.total_value)}, into {into} today.
          {' '}This cannot be undone — a mistake is fixed by sending the stock back.
        </p>
      ),
      confirmLabel: 'Receive',
      busyLabel: 'Receiving…',
      run: async () => {
        setBusyId(t.id)
        const { data: res, error } = await settleWithin(receiveStockTransfer(t.id), WRITE_MS, 'Receive')
        setBusyId(null)
        if (error) {
          setActionError(isTimeout(error)
            ? `No answer from the server, so it is not known whether the stock from ${t.from_name} was received. Reload Stock Transfers to see where it stands; pressing Received again cannot receive it twice.`
            : asActionError(error, audience))
          load()
          return
        }
        setNotice(res?.already
          ? `That transfer from ${t.from_name} was already received. Nothing changed.`
          : `Received — ${npr(t.total_value)} from ${t.from_name}, counted in ${bsDateLabel(res?.received_bs_year, res?.received_bs_month, res?.received_bs_day)}.`)
        load()
      },
    })
  }

  function openReason(t, action) {
    setNotice(null)
    setActionError(null)
    setReasonDraft({ transfer: t, action, reason: '', err: '', busy: false, error: null })
  }

  async function confirmReason() {
    const d = reasonDraft
    if (!d) return
    const reason = d.reason.trim()
    if (reason.length < 3) {
      setReasonDraft(x => ({ ...x, err: 'Say why in a few words (at least 3 characters). The reason stays on the transfer.' }))
      return
    }
    setReasonDraft(x => ({ ...x, busy: true, err: '', error: null }))
    setBusyId(d.transfer.id)
    const { data: res, error } = await settleWithin(endStockTransfer(d.transfer.id, d.action, reason), WRITE_MS,
      d.action === 'cancel' ? 'Cancel' : 'Refuse')
    setBusyId(null)
    const verb = d.action === 'cancel' ? 'cancelled' : 'refused'
    if (error) {
      // Kept open: a refusal (an item hidden at the sender since sending, a month behind) names what to
      // fix, and the reason typed is not lost.
      setReasonDraft(x => ({
        ...x,
        busy: false,
        error: isTimeout(error)
          ? `No answer from the server, so it is not known whether the transfer was ${verb}. Close this and reload Stock Transfers to see where it stands; doing it again cannot do it twice.`
          : asActionError(error, audience),
      }))
      return
    }
    setReasonDraft(null)
    setNotice(res?.already
      ? `That transfer was already ${res.already}. Nothing changed.`
      : `Transfer ${verb} — the stock is back on ${d.transfer.from_name}'s books from ${bsDateLabel(res?.returned_bs_year, res?.returned_bs_month, res?.returned_bs_day)}.`)
    load()
  }

  async function exportMonth() {
    const period = (data?.periods || []).find(p => p.id === exportPeriodId)
    if (!period || !biz.ready) return
    setExporting(true)
    setExportError(null)
    let res
    try {
      res = await withTimeout(readPeriodTransfers(scopedFrom, period.id, { select: `${TRANSFER_LINE_SELECT}, items(name, uom)` }),
        LOAD_MS, 'Reading the month\'s transfers')
    } catch (e) {
      res = { data: null, error: e }
    }
    if (res.error) {
      setExporting(false)
      setExportError(asActionError(res.error, audience))
      return
    }
    const LEG = { sent: 'Sent', received: 'Received', returned: 'Came back' }
    const rows = (res.data || [])
      .slice()
      .sort((a, b) => (a.bs_day - b.bs_day) || String(a.created_at).localeCompare(String(b.created_at)))
      .map(l => ({
        'Day': l.bs_day,
        'In / Out': l.direction === 'in' ? 'In' : 'Out',
        'What happened': LEG[l.leg] || l.leg,
        'Other outlet': l.counterpart_name || '',
        'Item': l.items?.name || '',
        'Quantity': Number(l.qty) || 0,
        'Unit': l.items?.uom || '',
        'Rate (NPR)': Number(l.rate) || 0,
        'Value (NPR)': Number(l.value) || 0,
        'From prep': l.prep_label || '',
        'Recorded by': l.created_by_name || '',
        'Recorded at': nepalTime24(l.created_at),
      }))
    try {
      const XLSX = await import('xlsx')
      const ws = sheetFor(XLSX, period, rows)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Stock transfers')
      XLSX.writeFile(wb, `Stock_Transfers_${BS_MONTHS[period.bs_month - 1] || period.bs_month}_${period.bs_year}.xlsx`)
    } catch (e) {
      setExportError(asActionError(e, audience))
    }
    setExporting(false)
  }

  function sheetFor(XLSX, period, rows) {
    return sheetWithLetterhead(XLSX, {
      title: 'Stock Transfers',
      biz,
      scopeLine: `${fromName} — ${periodName(period)}${period.status === 'open' ? ' (open)' : ''}`,
      rows,
      notes: [
        'In = received at this outlet, or stock that came back to it from a cancelled or refused transfer; Out = sent from it.',
        'Values are at the sending outlet\'s item prices on the day it was sent. In counts like a purchase and Out like a supplier return in this outlet\'s stock figures.',
      ],
    })
  }

  // ── Guards (after every hook) ──────────────────────────────────────────────────────────────────
  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  if (!groupId) return <Navigate to="/dashboard" replace />

  const tabs = [
    { key: 'send', label: 'Send' },
    { key: 'incoming', label: lists.inWaiting.length ? `Incoming (${lists.inWaiting.length})` : 'Incoming' },
    { key: 'outgoing', label: lists.outWaiting.length ? `Outgoing (${lists.outWaiting.length} on the way)` : 'Outgoing' },
  ]

  const incomingActions = t => (t.status !== 'on_the_way' ? {} : {
    primary: { label: 'Receive', onClick: () => askReceive(t) },
    menu: [{ key: 'refuse', label: 'Refuse…', danger: true, onSelect: () => openReason(t, 'refuse') }],
  })
  const outgoingActions = t => (t.status !== 'on_the_way' || !canCancel ? {} : {
    menu: [{ key: 'cancel', label: 'Cancel transfer…', danger: true, onSelect: () => openReason(t, 'cancel') }],
  })

  const history = showAllHistory ? lists.outHistory : lists.outHistory.slice(0, HISTORY_PAGE)

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Stock Transfers</h1>
          <p className="page-subtitle">Send stock to another outlet of your group. It counts there once they press Received.</p>
        </div>
        {!loading && !loadError && (data?.periods || []).length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <label htmlFor="transfer-export-month" className="sr-only">Month to export</label>
            <select id="transfer-export-month" className="form-select form-input--auto" value={exportPeriodId}
              onChange={e => setExportPeriodId(e.target.value)}>
              {data.periods.map(p => (
                <option key={p.id} value={p.id}>{periodName(p)}{p.status === 'open' ? ' (open)' : ''}</option>
              ))}
            </select>
            <Tip text="Every transfer line this outlet recorded in the month: stock sent, received, and stock that came back from a cancelled or refused transfer." width={280}>
              <button type="button" className="btn btn-ghost" onClick={exportMonth} disabled={exporting || !biz.ready || !exportPeriodId}>
                {exporting ? 'Exporting…' : 'Export'}
              </button>
            </Tip>
          </div>
        )}
      </div>

      <ActionError error={exportError} className="action-error--top" />

      <Tabs idBase="stock-transfers" label="Stock transfers" tabs={tabs} active={tab} onChange={k => { setTab(k); setNotice(null) }} />

      {notice && <p role="status" className="note-banner" style={{ margin: '12px 0' }}>{notice}</p>}
      <ActionError error={actionError} className="action-error--top" />

      {loading ? (
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : tab === 'send' ? (
        receivers.length === 0 ? (
          <div className="card"><div className="empty-state">
            <p className="empty-state-text">No other outlet of your group runs Crest Inventory, so there is nowhere to send stock to.</p>
          </div></div>
        ) : (
          <SendTransferForm
            clientId={clientId}
            fromName={fromName}
            receivers={receivers}
            items={data.items || []}
            recipeByPrep={recipeByPrep}
            recipeBook={recipeBook}
            audience={audience}
            onSent={onSent}
          />
        )
      ) : tab === 'incoming' ? (
        <div>
          <h2 className="dash-card-title" style={{ margin: '16px 0 8px' }}>On the way to {fromName}</h2>
          {lists.inWaiting.length === 0 ? (
            <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Nothing is on the way to this outlet.</p>
          ) : (
            <TransferTable rows={lists.inWaiting} mode="incoming" actions={incomingActions} busyId={busyId}
              caption={`Stock on the way to ${fromName}`} />
          )}
          <p className="page-footnote">
            Press Received when the stock arrives, before your month-end count: stock counted on the shelf before it is
            received makes that month's food cost look lower and the next month's higher.
          </p>
          {lists.inRecent.length > 0 && (
            <>
              <h2 className="dash-card-title" style={{ margin: '20px 0 8px' }}>Ended this month</h2>
              <TransferTable rows={lists.inRecent} mode="incoming" busyId={busyId} caption="Incoming transfers ended this month" />
            </>
          )}
        </div>
      ) : (
        <div>
          <h2 className="dash-card-title" style={{ margin: '16px 0 8px' }}>On the way from {fromName}</h2>
          {lists.outWaiting.length === 0 ? (
            <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Nothing sent from this outlet is on the way.</p>
          ) : (
            <TransferTable rows={lists.outWaiting} mode="outgoing" actions={outgoingActions} busyId={busyId}
              caption={`Stock on the way from ${fromName}`} />
          )}
          {lists.outWaiting.length > 0 && (
            <p className="page-footnote">
              Stock on the way has left this outlet's stock and does not count anywhere until it is received.
              {canCancel ? ' Cancel puts it back on this outlet\'s books.' : ' Your Inventory manager or the Owner can cancel one.'}
            </p>
          )}
          <h2 className="dash-card-title" style={{ margin: '20px 0 8px' }}>History</h2>
          {lists.outHistory.length === 0 ? (
            <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>No transfer sent from this outlet has ended yet.</p>
          ) : (
            <>
              <TransferTable rows={history} mode="outgoing" busyId={busyId} caption="Transfers sent from this outlet that have ended" />
              {!showAllHistory && lists.outHistory.length > HISTORY_PAGE && (
                <button type="button" className="btn btn-ghost" style={{ marginTop: 8 }} onClick={() => setShowAllHistory(true)}>
                  Show all {lists.outHistory.length}
                </button>
              )}
            </>
          )}
        </div>
      )}

      {reasonDraft && (
        <ConfirmModal
          title={reasonDraft.action === 'cancel'
            ? `Cancel the transfer to ${reasonDraft.transfer.to_name}?`
            : `Refuse the stock from ${reasonDraft.transfer.from_name}?`}
          confirmLabel={reasonDraft.action === 'cancel' ? 'Cancel transfer' : 'Refuse'}
          cancelLabel="Back"
          busyLabel={reasonDraft.action === 'cancel' ? 'Cancelling…' : 'Refusing…'}
          danger
          busy={reasonDraft.busy}
          onCancel={() => setReasonDraft(null)}
          onConfirm={confirmReason}
        >
          <p style={{ margin: '0 0 10px' }}>
            {npr(reasonDraft.transfer.total_value)}, sent {bsDateLabel(reasonDraft.transfer.sent_bs_year, reasonDraft.transfer.sent_bs_month, reasonDraft.transfer.sent_bs_day)}.
            {' '}{reasonDraft.action === 'cancel'
              ? 'The stock comes back on this outlet\'s books today.'
              : `The stock goes back on ${reasonDraft.transfer.from_name}'s books.`}
            {' '}This cannot be undone.
          </p>
          <div className="form-field">
            <label htmlFor="transfer-reason">Reason *</label>
            <textarea id="transfer-reason" className="form-input" rows={2} autoFocus maxLength={500}
              value={reasonDraft.reason}
              onChange={e => { const reason = e.target.value; setReasonDraft(x => ({ ...x, reason, err: '' })) }}
              placeholder={reasonDraft.action === 'cancel' ? 'e.g. Van did not go — sending tomorrow instead' : 'e.g. 2 kg short — please send again with the right quantity'}
              style={{ resize: 'vertical', fontFamily: 'inherit' }}
              {...fieldAria('transfer-reason', reasonDraft.err)} />
            <FieldError id="transfer-reason" message={reasonDraft.err} />
          </div>
          <ActionError error={reasonDraft.error} />
        </ConfirmModal>
      )}
      {confirmEl}
    </div>
  )
}
