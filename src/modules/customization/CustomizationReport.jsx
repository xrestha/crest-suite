import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { supabase } from '../../supabaseClient'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../shared/hooks/useLatestRequest'
import { useBizInfo } from '../../shared/hooks/useBizInfo'
import { fetchAllRows, fetchAllRowsChunked } from '../../shared/fetchAllRows'
import { firstError } from '../../shared/queryError'
import { npr, nprInt } from '../../shared/nepalMoney'
import { sheetWithLetterhead } from '../../shared/excelLetterhead'
import ReportPage from '../../components/ReportPage'
import Tip from '../../components/Tip'
import BsCalendarPicker from '../../components/BsCalendarPicker'
import { nepalDayStartTs, nepalDayEndTs, todayNepalAdIso, bsSlash } from '../pos/reports/reportRange'
import { loadDeltaExplosion, deltaItems } from '../../utils/orderLineIngredients'
import { buildCustomizationReport, withOptionCosts } from './customizationReportCalc'

// Crest Customization Report (S758 stage 8). Four questions an owner asks of their choices:
// which are picked, how often guests customize at all, what the "No …" requests are, and — with
// IMS — whether a paid choice earns more than it costs.
//
// Who (owner decision): the Owner, a POS manager or an IMS manager, plus admin — the same set that
// edits Option Groups, tested on the RAW role columns for the reason OptionGroups.jsx gives.
//
// Basis, stated on the page, the print-free export and the footnote alike: paid bills closed in the
// range; choice prices ex-VAT and before bill discounts; credit notes are not netted off.

const TABS = [
  { key: 'popular',  label: 'Popular choices' },
  { key: 'dishes',   label: 'How often customized' },
  { key: 'removals', label: '"No …" requests' },
  { key: 'margin',   label: 'Choice margin' },
]

const pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const signed = n => {
  const r = Math.round(Number(n) || 0)
  return r === 0 ? 'NPR 0' : `${r > 0 ? '+' : '−'}${npr(Math.abs(r))}`
}

export default function CustomizationReport() {
  const { isAdmin, isOwner, profile, clientId, clientModules } = useAuth()
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  const imsOn = !!clientModules?.ims || isAdmin

  const [tab, setTab] = useState('popular')
  const [fromIso, setFromIso] = useState(todayNepalAdIso)
  const [toIso, setToIso] = useState(todayNepalAdIso)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [data, setData] = useState(null)       // { report, costed }
  const [costError, setCostError] = useState(null)
  const rangeReq = useLatestRequest()

  const load = useCallback(async () => {
    if (!clientId) return
    const key = rangeReq.begin(`${clientId}:${fromIso}:${toIso}`)
    setLoading(true); setLoadError(null); setCostError(null)
    try {
      const [ordersRes, attachRes] = await Promise.all([
        // Paged: a month of bills passes 1000 at any real volume, and every share on this page
        // divides by a count taken from it.
        fetchAllRows(() => scopedFrom('pos_orders', 'id')
          .eq('close_type', 'paid')
          .gte('closed_at', nepalDayStartTs(fromIso)).lte('closed_at', nepalDayEndTs(toIso))
          .order('id')),
        fetchAllRows(() => scopedFrom('pos_recipe_option_groups', 'id, recipe_id').order('id')),
      ])
      const err1 = firstError([ordersRes, attachRes])
      if (err1) throw err1
      const orderIds = (ordersRes.data || []).map(o => o.id)
      const [linesRes, snapRes] = await Promise.all([
        fetchAllRowsChunked(orderIds, ids => scopedFrom('pos_order_items', 'id, order_id, recipe_id, name, qty, comped, selection_key')
          .in('order_id', ids).order('id')),
        fetchAllRowsChunked(orderIds, ids => scopedFrom('pos_order_item_options',
          'id, order_item_id, option_id, group_name, option_name, is_removal, price_delta, ingredient_deltas')
          .in('order_id', ids).order('id')),
      ])
      const err2 = firstError([linesRes, snapRes])
      if (err2) throw err2
      const report = buildCustomizationReport({
        lines: linesRes.data || [],
        snapshots: snapRes.data || [],
        attachedRecipeIds: new Set((attachRes.data || []).map(a => a.recipe_id)),
      })

      // Choice cost needs IMS (stock lines and item rates). A failure here costs the Margin tab
      // only, and says so there — the three sales tabs stand on their own reads.
      let costed = null
      if (imsOn && report.options.some(o => o.sampleDeltas?.length)) {
        try {
          const explosion = await loadDeltaExplosion(supabase, report.options.map(o => o.sampleDeltas))
          const toItems = d => deltaItems(d, explosion)
          const itemIds = [...new Set(report.options.flatMap(o => (o.sampleDeltas?.length ? toItems(o.sampleDeltas) : []).map(x => x.item_id)))]
          const ratesRes = await fetchAllRowsChunked(itemIds, ids => scopedFrom('items', 'id, per_uom_rate').in('id', ids).order('id'))
          if (ratesRes.error) throw ratesRes.error
          const rateByItem = Object.fromEntries((ratesRes.data || []).map(r => [r.id, Number(r.per_uom_rate) || 0]))
          costed = withOptionCosts(report.options, toItems, rateByItem)
        } catch (e) {
          if (!rangeReq.isCurrent(key)) return
          setCostError(e)
        }
      }
      if (!rangeReq.isCurrent(key)) return
      setData({ report, costed })
    } catch (e) {
      if (!rangeReq.isCurrent(key)) return
      setLoadError(e)
      setData(null)
    } finally {
      if (rangeReq.isCurrent(key)) setLoading(false)
    }
  }, [clientId, fromIso, toIso, scopedFrom, rangeReq, imsOn])

  useEffect(() => { load() }, [load])

  const report = data?.report
  const scopeLine = `Paid bills closed ${fromIso} (B.S. ${bsSlash(fromIso)}) to ${toIso} (B.S. ${bsSlash(toIso)}) · choice prices ex-VAT, before bill discounts · credit notes not netted`
  const marginRows = useMemo(() => (data?.costed || []).filter(o => !o.is_removal), [data])
  const top = report?.options.find(o => !o.is_removal)

  const canView = isAdmin || isOwner || profile?.pos_role === 'manager' || profile?.ims_role === 'manager'
  if (!canView) return <Navigate to="/dashboard" replace />

  async function exportExcel() {
    if (!report) return
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const add = (name, title, rows) => XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, { title, biz, scopeLine, rows }), name)
    add('Popular choices', 'Customization — Popular choices', report.options.map(o => ({
      Choice: o.option_name, Group: o.group_name, 'Times picked (plates)': o.picks,
      'Extra charged (NPR, ex-VAT)': Math.round(o.charged), 'Picked on': o.dishes.join(', '),
    })))
    add('How often', 'Customization — How often customized', report.dishes.map(d => ({
      Dish: d.name, 'Plates sold': d.plates, 'Plates customized': d.customizedPlates, 'Share customized': pct(d.share),
    })))
    add('No requests', 'Customization — "No …" requests', report.removalsByDish.map(r => ({
      Dish: r.dish, Request: r.option_name, 'Plates': r.picks, 'Share of the dish': pct(r.dishPlates ? r.picks / r.dishPlates : null),
    })))
    if (marginRows.length) {
      add('Choice margin', 'Customization — Choice margin', marginRows.map(o => ({
        Choice: o.option_name, 'Charged per plate (NPR)': Math.round(o.chargedPerPick),
        'Cost per plate (NPR, today\'s rates)': o.costPerPick == null ? '' : Math.round(o.costPerPick),
        'Margin per plate (NPR)': o.costPerPick == null ? '' : Math.round(o.chargedPerPick - o.costPerPick),
        'Times picked': o.picks,
      })))
    }
    XLSX.writeFile(wb, `customization-report-${fromIso}-to-${toIso}.xlsx`)
  }

  const exportDisabled = loading || !!loadError || !report || !!biz.error

  return (
    <ReportPage
      title="Customization Report"
      subtitle="Which choices guests pick, how often they customize, and what the choices earn."
      actions={(
        <Tip text={biz.error ? "The outlet's name could not be read, so the workbook's letterhead would be blank. Reload and try again." : 'Download every tab as a workbook, with the range and basis on each sheet.'}>
          <button type="button" className="btn btn-ghost" onClick={exportExcel} disabled={exportDisabled}>Export Excel</button>
        </Tip>
      )}
      loading={loading}
      error={loadError}
      empty={!!report && report.customizablePlates === 0}
      emptyText="No dish with choices was sold in this range. Attach option groups to dishes in Option Groups, then check back after some bills."
      filters={(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="form-field" style={{ margin: 0 }}>
              <label htmlFor="cust-report-from">From</label>
              <BsCalendarPicker id="cust-report-from" value={fromIso} onChange={setFromIso} />
            </div>
            <div className="form-field" style={{ margin: 0 }}>
              <label htmlFor="cust-report-to">To</label>
              <BsCalendarPicker id="cust-report-to" value={toIso} onChange={setToIso} />
            </div>
          </div>
          <div className="tab-bar" role="tablist" aria-label="Report view">
            {TABS.filter(t => t.key !== 'margin' || imsOn).map(t => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                className={`tab-btn${tab === t.key ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
      )}
      stats={report && (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="stat-label"><Tip text="Plates of dishes that have choices, on paid bills in the range. A line of 3 is three plates.">Plates of customizable dishes</Tip></div>
            <div className="stat-value">{nprInt(report.customizablePlates)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="Of those plates, how many had at least one choice picked (a size, an extra, a 'No …').">Customized</Tip></div>
            <div className="stat-value">{pct(report.customizedShare)}</div>
            <div className="stat-sub">{nprInt(report.customizedPlates)} plates</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="What the choices added to bills, ex-VAT and before bill discounts. A Half size that costs less than the full dish counts as a negative. Comped plates add nothing.">Charged for choices</Tip></div>
            <div className="stat-value">{signed(report.extraCharged)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Most picked</div>
            <div className="stat-value" style={{ fontSize: 18 }}>{top ? top.option_name : '—'}</div>
            {top && <div className="stat-sub">{nprInt(top.picks)} plates</div>}
          </div>
        </div>
      )}
      footnote={<p className="page-subtitle" style={{ margin: 0 }}>{scopeLine}.</p>}
    >
      {report && tab === 'popular' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th>Choice</th><th>Group</th>
              <th style={{ textAlign: 'right' }}><Tip text="Plates this choice was on.">Times picked</Tip></th>
              <th style={{ textAlign: 'right' }}><Tip text="Price the choice added × paid plates, ex-VAT, before bill discounts.">Charged</Tip></th>
              <th>Picked on</th>
            </tr></thead>
            <tbody>
              {report.options.map(o => (
                <tr key={o.key}>
                  <td><span style={{ whiteSpace: 'nowrap' }}>{o.option_name}</span></td>
                  <td>{o.group_name}</td>
                  <td style={{ textAlign: 'right' }}>{nprInt(o.picks)}</td>
                  <td style={{ textAlign: 'right' }}>{o.is_removal ? '—' : signed(o.charged)}</td>
                  <td>{o.dishes.join(', ')}</td>
                </tr>
              ))}
              {report.options.length === 0 && <tr><td colSpan={5} className="empty-state">No choices were picked in this range.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {report && tab === 'dishes' && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr>
              <th>Dish</th>
              <th style={{ textAlign: 'right' }}>Plates sold</th>
              <th style={{ textAlign: 'right' }}>Customized</th>
              <th style={{ textAlign: 'right' }}><Tip text="Plates with at least one choice ÷ plates sold. A dish nobody customizes may not need its groups; one everybody customizes may want a new default.">Share</Tip></th>
            </tr></thead>
            <tbody>
              {report.dishes.map(d => (
                <tr key={d.recipe_id}>
                  <td><span style={{ whiteSpace: 'nowrap' }}>{d.name}</span></td>
                  <td style={{ textAlign: 'right' }}>{nprInt(d.plates)}</td>
                  <td style={{ textAlign: 'right' }}>{nprInt(d.customizedPlates)}</td>
                  <td style={{ textAlign: 'right' }}>{pct(d.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report && tab === 'removals' && (
        report.removalsByDish.length === 0
          ? <p className="empty-state">No "No …" choices were picked in this range.</p>
          : (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <th>Dish</th><th>Request</th>
                  <th style={{ textAlign: 'right' }}>Plates</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Plates with this request ÷ all plates of the dish. A request on most plates may mean the recipe should change.">Share of the dish</Tip></th>
                </tr></thead>
                <tbody>
                  {report.removalsByDish.map((r, i) => (
                    <tr key={i}>
                      <td><span style={{ whiteSpace: 'nowrap' }}>{r.dish}</span></td>
                      <td>{r.option_name}</td>
                      <td style={{ textAlign: 'right' }}>{nprInt(r.picks)}</td>
                      <td style={{ textAlign: 'right' }}>{pct(r.dishPlates ? r.picks / r.dishPlates : null)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
      )}

      {report && tab === 'margin' && imsOn && (
        costError ? (
          <p role="alert" className="action-error">The stock lines or item rates could not be read, so choice costs are not shown. The other tabs are unaffected — reload to try again.</p>
        ) : marginRows.length === 0 ? (
          <p className="empty-state">No choice with stock lines was picked in this range. Add stock lines to a choice in Option Groups to see its cost here.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr>
                <th>Choice</th>
                <th style={{ textAlign: 'right' }}><Tip text="Average price this choice added per paid plate, ex-VAT. A free 'first N' pick lowers it.">Charged / plate</Tip></th>
                <th style={{ textAlign: 'right' }}><Tip text="The choice's stock lines as they were on the bill, valued at today's item rates.">Cost / plate</Tip></th>
                <th style={{ textAlign: 'right' }}>Margin / plate</th>
                <th style={{ textAlign: 'right' }}>Times picked</th>
              </tr></thead>
              <tbody>
                {marginRows.map(o => {
                  const margin = o.costPerPick == null ? null : o.chargedPerPick - o.costPerPick
                  return (
                    <tr key={o.key}>
                      <td><span style={{ whiteSpace: 'nowrap' }}>{o.option_name}</span></td>
                      <td style={{ textAlign: 'right' }}>{signed(o.chargedPerPick)}</td>
                      <td style={{ textAlign: 'right' }}>{o.costPerPick == null ? <span title="No stock lines on this choice">—</span> : npr(Math.round(o.costPerPick))}</td>
                      <td style={{ textAlign: 'right', color: margin == null ? undefined : margin < 0 ? 'var(--theme-red-text)' : undefined }}>
                        {margin == null ? '—' : `${signed(margin)}${margin < 0 ? ' ▼' : ''}`}
                      </td>
                      <td style={{ textAlign: 'right' }}>{nprInt(o.picks)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </ReportPage>
  )
}
