import { nprInt } from '../../../shared/nepalMoney'
import { useEffect, useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { chartMotion } from '../../../shared/chartMotion'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import ChartCard from '../../../components/ChartCard'
import StatPill from '../../../components/StatPill'
import Tip from '../../../components/Tip'
import { printWithTitle } from '../../../utils/printTitle'
import { computeValuationAsOf } from './depreciationCompute'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import ReportLoadError from '../../../components/ReportLoadError'
import { formatAdAsBs } from '../../../utils/bsCalendar'
import { nepalBsLong } from '../../../shared/nepalTime'

const fmt = nprInt
// A stored AD date (a period end) as the BS date it falls on (S792, COSTS-11).
const fmtDate = d => formatAdAsBs(d)

// Whole-portfolio valuation, as of any posted period end — cost less the depreciation posted for
// periods ending on or before it, across every asset HELD on that date with personal_use_percent
// = 0 (disposed since included), computed on read (no stored aggregate). S792: COSTS-2, COSTS-4.
export default function ValuationReportTab({ assets }) {
  const { profile } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [posted, setPosted] = useState([]) // all posted schedule rows, client-wide
  const [asOf, setAsOf] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null) // a failed read is not "no posted runs yet"

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true)
    // Paged, with tiebreakers: one row per asset per run crosses the 1000-row cap, and a truncated
    // read values the assets past the cut at full cost (S756).
    const { data, error } = await fetchAllRows(() => scopedFrom('assets_depreciation_schedule', 'id, asset_id, period_start, period_end, depreciation_amount, override_amount')
      .eq('is_posted', true).order('period_end', { ascending: true }).order('id'))
    if (error) { setLoadError(error); setLoading(false); return }
    setLoadError(null)
    setPosted(data || [])
    if (data && data.length > 0) setAsOf(data[data.length - 1].period_end)
    setLoading(false)
  }

  const periodOptions = useMemo(() => [...new Set(posted.map(p => p.period_end))].sort().reverse(), [posted])

  // S792: the assets held on the date — including one disposed AFTER it (COSTS-4) — each at cost
  // less the charges and reversals for periods ending on or before it (COSTS-2). It used to take
  // the closing NBV of the latest row by period end, which a reversal of an earlier run, or a
  // back-dated run posted later, never reached.
  const valuation = useMemo(() => (asOf ? computeValuationAsOf({ assets, postedRows: posted, asOf }) : null), [assets, posted, asOf])

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }} className="no-print">
        <div className="form-field">
          <label htmlFor="valuat-f1"><Tip text="The end of any period a depreciation run has been posted for. Every asset owned on this date is counted — including one sold or written off later — at its cost less the depreciation posted for periods ending on or before it, reversals included." width={290}>As Of</Tip></label>
          <select id="valuat-f1" className="form-select" value={asOf} onChange={e => setAsOf(e.target.value)} disabled={periodOptions.length === 0}>
            {periodOptions.length === 0 && <option value="">No posted periods yet</option>}
            {periodOptions.map(d => <option key={d} value={d}>{fmtDate(d)}</option>)}
          </select>
        </div>
        {valuation && (
          <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => printWithTitle(`Asset Valuation Report - ${fmtDate(asOf)}`)}>Print</button>
        )}
      </div>

      {loading ? (
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : !valuation ? (
        <div className="card"><div className="empty-state"><p className="empty-state-text">No posted depreciation runs yet — post a run on the Depreciation Runs tab first.</p></div></div>
      ) : (
        <div id="valuation-print-area">
          <div className="stat-grid stat-grid--pair">
            <div className="stat-card">
              <div className="stat-label">Total Portfolio Cost</div>
              <div className="stat-value">NPR {fmt(valuation.totalCost)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Accumulated Depreciation</div>
              <div className="stat-value" style={{ color: 'var(--theme-text1)' }}>NPR {fmt(valuation.accumulatedDepreciation)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Net Book Value</div>
              <div className="stat-value" style={{ color: 'var(--theme-text1)' }}>NPR {fmt(valuation.nbv)}</div>
            </div>
          </div>

          <ChartCard
            title="NBV by Category"
            cardStyle={{ marginBottom: 20 }}
            renderChart={h => (
              <ResponsiveContainer width="100%" height={h}>
                <BarChart data={valuation.byCategory} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-border)" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: 'var(--theme-text2)' }} />
                  <YAxis dataKey="categoryName" type="category" width={140} tick={{ fontSize: 11, fill: 'var(--theme-text2)' }} />
                  <Tooltip formatter={v => `NPR ${fmt(v)}`} contentStyle={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', fontSize: 12 }} />
                  <Bar dataKey="nbv" fill="#c9a84c" radius={[0, 4, 4, 0]} {...chartMotion()} />
                </BarChart>
              </ResponsiveContainer>
            )}
            footer={
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                {valuation.byCategory.map(c => <StatPill key={c.categoryName} label={c.categoryName} value={`NPR ${fmt(c.nbv)}`} />)}
              </div>
            }
          />

          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}>Total Cost</th>
                  <th style={{ textAlign: 'right' }}>Accumulated Depreciation</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net Book Value — Total Cost minus Accumulated Depreciation — what these assets were worth on the books on the As Of date. Depreciation taken before Crest counts from its own date onwards." width={260}>NBV</Tip></th>
                </tr>
              </thead>
              <tbody>
                {valuation.byCategory.map(c => (
                  <tr key={c.categoryName}>
                    <td>{c.categoryName}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(c.totalCost)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(c.accumulatedDepreciation)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(c.nbv)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                  <td>Total</td>
                  <td style={{ textAlign: 'right' }}>{fmt(valuation.totalCost)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(valuation.accumulatedDepreciation)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(valuation.nbv)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div style={{ marginTop: 32, fontSize: 10, color: '#aaa', borderTop: '1px solid #eee', paddingTop: 12, textAlign: 'center' }} className="print-only">
            Asset Valuation Report — {profile?.clients?.name || ''} — As of {fmtDate(asOf)} · Generated by Crest Suite · {nepalBsLong(new Date())}
          </div>
        </div>
      )}
    </div>
  )
}
