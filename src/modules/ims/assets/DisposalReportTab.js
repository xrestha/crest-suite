import { useMemo, useState } from 'react'
import { nprInt } from '../../../shared/nepalMoney'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { printWithTitle } from '../../../utils/printTitle'
import Tip from '../../../components/Tip'
import { formatAd, formatAdAsBs, getBsFiscalYear, getBsFiscalYearStart, getBsToday } from '../../../utils/bsCalendar'
import { nepalBsLong } from '../../../shared/nepalTime'
import { getFiscalYearAdRange } from '../reports/vendorBalanceHelpers'
import { fiscalYearStartOfAdDate } from './taxPoolCompute'

const fmt = nprInt
// A stored AD date as the BS date it was picked as (S792, COSTS-11).
const fmtDate = d => formatAdAsBs(d)
const ALL = 'all'

// S849 (ASSETS-16): the report is for one fiscal year — the current one unless another is chosen —
// or for all years. It used to total every disposal ever made, under a title that named no year,
// which is not a figure anyone files. A disposal belongs to the year its disposal_date falls in,
// compared as formatAd strings so no timezone moves either end.
export default function DisposalReportTab({ assets }) {
  const biz = useBizInfo()
  const today = getBsToday()
  const currentFy = getBsFiscalYearStart(today.year, today.month)
  const [fy, setFy] = useState(currentFy)

  const everDisposed = useMemo(() => assets
    .filter(a => a.status === 'disposed' || a.status === 'written_off')
    .sort((a, b) => String(b.disposal_date || '').localeCompare(String(a.disposal_date || ''))), [assets])

  // The years that hold a disposal, plus the current one (the default), newest first.
  const fyOptions = useMemo(() => {
    const set = new Set([currentFy])
    everDisposed.forEach(a => { const s = fiscalYearStartOfAdDate(a.disposal_date); if (s != null) set.add(s) })
    return [...set].sort((a, b) => b - a)
  }, [everDisposed, currentFy])

  const fyLabel = fy === ALL ? null : getBsFiscalYear(fy, 4)
  const disposed = useMemo(() => {
    if (fy === ALL) return everDisposed
    const { start, end } = getFiscalYearAdRange(fy)
    const from = formatAd(start), to = formatAd(end)
    return everDisposed.filter(a => {
      const d = String(a.disposal_date || '').slice(0, 10)
      return d >= from && d <= to
    })
  }, [everDisposed, fy])

  const totalProceeds = disposed.reduce((s, a) => s + (a.disposal_proceeds || 0), 0)
  const totalGainLoss = disposed.reduce((s, a) => s + (a.disposal_gain_loss || 0), 0)
  const scope = fyLabel ? `FY ${fyLabel}` : 'All years'
  const title = `Asset Disposal Report — ${scope}`

  return (
    <div>
      <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="form-field">
          <label htmlFor="disposal-fy"><Tip text="The fiscal year (Shrawan to Ashadh) whose disposals are listed and totalled, by the date each asset was disposed of or written off." width={260}>Fiscal Year</Tip></label>
          <select id="disposal-fy" className="form-select" value={fy} onChange={e => setFy(e.target.value === ALL ? ALL : parseInt(e.target.value))}>
            {fyOptions.map(y => <option key={y} value={y}>FY {getBsFiscalYear(y, 4)}</option>)}
            <option value={ALL}>All years</option>
          </select>
        </div>
        {disposed.length > 0 && (
          // The printed heading names the business, so Print waits for its name (S845).
          <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={!biz.ready} onClick={() => printWithTitle(title)}>Print</button>
        )}
      </div>
      {disposed.length > 0 && biz.error && (
        <p className="no-print" style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text2)' }}>The business name for the printed heading could not be read, so Print is held. Reload the page to try again.</p>
      )}

      {disposed.length === 0 ? (
        <div className="card"><div className="empty-state"><p className="empty-state-text">
          {everDisposed.length === 0
            ? 'No disposed or written-off assets yet.'
            : `No disposals in FY ${fyLabel}. Choose another year, or All years, to see the ${everDisposed.length} recorded so far.`}
        </p></div></div>
      ) : (
        <>
          <h2 className="print-only" style={{ fontSize: 16, margin: '0 0 12px', color: 'var(--theme-text1)' }}>
            {title}{biz.name ? ` — ${biz.name}` : ''}
          </h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Outcome</th>
                  <th>Disposal Date</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net book value on the disposal date: cost less depreciation up to that day. Some older disposals use the value at the last posted run instead." width={230}>NBV at Disposal</Tip></th>
                  <th style={{ textAlign: 'right' }}>Proceeds</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Proceeds minus NBV at Disposal. Green = you sold it for more than its book value (a gain); red = for less (a loss)." width={260}>Gain / (Loss)</Tip></th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {disposed.map(a => {
                  const nbvAtDisposal = (a.disposal_proceeds || 0) - (a.disposal_gain_loss || 0)
                  return (
                    <tr key={a.id}>
                      <td>{a.asset_code}</td>
                      <td style={{ fontWeight: 600 }}>{a.name}</td>
                      <td>{a.status === 'disposed' ? 'Disposed' : 'Written Off'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(a.disposal_date)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(nbvAtDisposal)}</td>
                      <td style={{ textAlign: 'right' }}>{fmt(a.disposal_proceeds)}</td>
                      <td style={{ textAlign: 'right', color: a.disposal_gain_loss >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)', fontWeight: 600 }}>
                        {a.disposal_gain_loss >= 0 ? '+' : '−'}{fmt(Math.abs(a.disposal_gain_loss))}
                      </td>
                      <td style={{ color: 'var(--theme-text2)' }}>{a.disposal_reason || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                  <td colSpan={5}>Total — {scope}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(totalProceeds)}</td>
                  <td style={{ textAlign: 'right', color: totalGainLoss >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                    {totalGainLoss >= 0 ? '+' : '−'}{fmt(Math.abs(totalGainLoss))}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="print-only" style={{ marginTop: 32, fontSize: 10, color: '#aaa', borderTop: '1px solid #eee', paddingTop: 12, textAlign: 'center' }}>
            {title}{biz.name ? ` — ${biz.name}` : ''} · Generated by Crest Suite · {nepalBsLong(new Date())}
          </div>
        </>
      )}
    </div>
  )
}
