import { useEffect, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { settleWithin } from '../../../utils/withTimeout'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { BS_MONTHS, formatAdAsBs } from '../../../utils/bsCalendar'
import { nepalBsLong, nepalTime } from '../../../shared/nepalTime'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import Tip from '../../../components/Tip'
import {
  HISTORY_PAGE_SIZE, HISTORY_STARTED_AD, historyRowView, mergeHistoryPages, nextBeforeId,
} from './salesHistoryRows'

// A read that never answers is a failed read with a retry, not a spinner for good.
export const HISTORY_READ_MS = 20000

// Sales Entry's Change history tab (S885, owner decisions in salesHistoryRows.js). Read-only, for the
// Owner and IMS managers: Sales.js shows the tab only to hasImsAccess('manager'), and the server
// refuses anyone else (hint sales_history_rank). One read per page through get_sales_history, newest
// first; "Load more" asks for the rows before the oldest one shown.
export default function SalesChangeHistory({ period }) {
  const periodId = period?.id || null
  const bsMonth = period?.bs_month
  // Keyed on the period id (S601): a month switched while a page is in flight must not land the old
  // month's rows under the new month's name.
  const req = useLatestRequest()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  // The id the next page starts before, or null when the last page has been read.
  const [beforeId, setBeforeId] = useState(null)
  const [moreLoading, setMoreLoading] = useState(false)
  const [moreError, setMoreError] = useState(null)

  useEffect(() => { if (periodId) loadFirst(periodId) }, [periodId]) // eslint-disable-line react-hooks/exhaustive-deps

  function readPage(id, before) {
    return settleWithin(
      supabase.rpc('get_sales_history', { p_period_id: id, p_before_id: before, p_limit: HISTORY_PAGE_SIZE }),
      HISTORY_READ_MS, 'Reading the sales change history')
  }

  async function loadFirst(id) {
    req.begin(id)
    setLoading(true); setLoadError(null); setRows([]); setBeforeId(null); setMoreError(null); setMoreLoading(false)
    const { data, error } = await readPage(id, null)
    if (!req.isCurrent(id)) return
    if (error) { setLoadError(error); setLoading(false); return }
    const page = data || []
    setRows(mergeHistoryPages([], page))
    setBeforeId(nextBeforeId(page))
    setLoading(false)
  }

  async function loadMore() {
    if (!periodId || beforeId == null || moreLoading) return
    const id = periodId
    setMoreLoading(true); setMoreError(null)
    const { data, error } = await readPage(id, beforeId)
    if (!req.isCurrent(id)) return
    setMoreLoading(false)
    // A failed page keeps every row already shown and the same place to carry on from.
    if (error) {
      const a = asActionError(error)
      setMoreError({ text: 'The earlier changes could not be read, so the list stops here for now. Press Load more to try again. ' + a.text, detail: a.detail })
      return
    }
    const page = data || []
    setRows(prev => mergeHistoryPages(prev, page))
    setBeforeId(nextBeforeId(page))
  }

  const monthName = bsMonth ? `${BS_MONTHS[bsMonth - 1]} ${period?.bs_year || ''}`.trim() : 'this month'
  const startedOn = formatAdAsBs(HISTORY_STARTED_AD)

  if (!periodId) return null
  if (loading) {
    return <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>Loading the change history…</p></div>
  }
  if (loadError) return <ReportLoadError error={loadError} onRetry={() => loadFirst(periodId)} />

  const views = rows.map(r => historyRowView(r, bsMonth))

  return (
    <>
      <div className="no-print note-banner">
        Every change a signed-in person saved to the sales of {monthName}, newest first: typed, imported or cleared, and
        lines removed. The sales the till posts by itself are not listed; each one traces to its bill.
      </div>
      {views.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <p className="empty-state-text">
              No changes are recorded for {monthName}. This record started on {startedOn}, so changes made before then are not listed.
            </p>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th><Tip text="When the change was saved, in BS and Nepal time." width={220}>When</Tip></th>
                  <th><Tip text="The day of the month the figure is for. Bulk is the month total on Bulk Entry." width={240}>Day</Tip></th>
                  <th>Dish</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="What the line said before this change: the quantity sold, and under it its value (quantity times the price recorded, less any discount). A dash means the line did not exist yet, or had no price." width={280}>Before</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="What the line says after this change, in the same form. A dash means the line was removed, or has no price." width={260}>After</Tip>
                  </th>
                  <th><Tip text="Added: a new line. Changed: a different quantity or value. Removed: the line was deleted. Saving the same figures again is not listed." width={280}>Change</Tip></th>
                  <th><Tip text="The login that saved the change." width={200}>By</Tip></th>
                </tr>
              </thead>
              <tbody>
                {views.map(v => (
                  <tr key={v.id}>
                    <td>
                      <span style={{ whiteSpace: 'nowrap' }}>{nepalBsLong(v.at) || '—'}</span>
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{nepalTime(v.at)}</span>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{v.day}</td>
                    <td style={{ fontWeight: 600 }}>{v.dish}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ whiteSpace: 'nowrap' }}>{v.beforeQty}</span>
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{v.beforeValue}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ whiteSpace: 'nowrap' }}>{v.afterQty}</span>
                      <span style={{ display: 'block', fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{v.afterValue}</span>
                    </td>
                    <td><span className="badge-gray">{v.kindLabel}</span></td>
                    <td>{v.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
            <span className="page-footnote" style={{ margin: 0 }}>
              {views.length.toLocaleString('en-IN')} {views.length === 1 ? 'change' : 'changes'} shown
              {beforeId == null ? ', every change recorded for this month.' : '. Earlier ones follow with Load more.'}
            </span>
            {beforeId != null && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={loadMore} disabled={moreLoading} aria-busy={moreLoading || undefined}>
                {moreLoading ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
          <ActionError error={moreError} />
        </div>
      )}
    </>
  )
}
