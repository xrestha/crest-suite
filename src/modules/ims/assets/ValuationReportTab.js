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
import { computeValuationAsOf, assetHeldOn } from './depreciationCompute'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import ReportLoadError from '../../../components/ReportLoadError'
import { formatAdAsBs } from '../../../utils/bsCalendar'
import { nepalBsLong } from '../../../shared/nepalTime'
import { settleWithin } from '../../../utils/withTimeout'
import { ASSET_CALL_MS } from './assetReads'

const fmt = nprInt
// A stored AD date (a period end) as the BS date it falls on (S792, COSTS-11).
const fmtDate = d => formatAdAsBs(d)

// Whole-portfolio valuation, as of any posted period end — cost less the depreciation posted for
// periods ending on or before it, across every asset HELD on that date (disposed since included),
// computed on read (no stored aggregate). S792: COSTS-2, COSTS-4. S849 (ASSETS-6, SU6 a): an asset
// with a personal-use share counts in full here, as in the runs and the tax pools; a footnote says
// how many there are.
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
    // read values the assets past the cut at full cost (S756). Bounded (S857): a read that never
    // answers is a failed read on ReportLoadError's timeout sentence, not "Loading…" for good.
    const { data, error } = await settleWithin(fetchAllRows(() => scopedFrom('assets_depreciation_schedule', 'id, asset_id, period_start, period_end, depreciation_amount, override_amount')
      .eq('is_posted', true).order('period_end', { ascending: true }).order('id')), ASSET_CALL_MS, 'Reading the posted depreciation')
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
  const personalUse = useMemo(() => (asOf ? assets.filter(a => (parseFloat(a.personal_use_percent) || 0) > 0 && assetHeldOn(a, asOf)).length : 0), [assets, asOf])

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 }} className="no-print">
        <div className="form-field">
          <label htmlFor="valuat-f1"><Tip text="The end of a period with a posted depreciation run. Every asset owned on that date counts, even one sold later, at its cost less the depreciation up to that date." width={290}>As Of</Tip></label>
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
              <div className="stat-label"><Tip text="What you paid for every asset you owned on the As Of date, including ones sold or written off later." width={260}>Total Portfolio Cost</Tip></div>
              <div className="stat-value">NPR {fmt(valuation.totalCost)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label"><Tip text="All the value written off these assets up to the As Of date: the posted runs, less any reversals, plus depreciation taken before Crest." width={270}>Accumulated Depreciation</Tip></div>
              <div className="stat-value" style={{ color: 'var(--theme-text1)' }}>NPR {fmt(valuation.accumulatedDepreciation)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label"><Tip text="What these assets are worth on your books on the As Of date: Total Portfolio Cost less Accumulated Depreciation." width={260}>Net Book Value</Tip></div>
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
                  {/* Square ends (S857): Modernist is zero-radius, and a rounded bar end was the one curve on the tab. */}
                  <Bar dataKey="nbv" fill="#c9a84c" {...chartMotion()} />
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

          {personalUse > 0 && (
            <p className="page-footnote">
              {personalUse === 1 ? 'One asset carries' : `${personalUse} assets carry`} a personal-use share; {personalUse === 1 ? 'it is' : 'they are'} counted in full here, as everywhere in Crest.
            </p>
          )}

          <div style={{ marginTop: 32, fontSize: 10, color: '#aaa', borderTop: '1px solid #eee', paddingTop: 12, textAlign: 'center' }} className="print-only">
            Asset Valuation Report — {profile?.clients?.name || ''} — As of {fmtDate(asOf)} · Generated by Crest Suite · {nepalBsLong(new Date())}
          </div>
        </div>
      )}
    </div>
  )
}
