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
import { moveRovingFocus, rovingTabIndex } from '../../shared/rovingFocus'
import ReportPage from '../../components/ReportPage'
import Tip from '../../components/Tip'
import BsCalendarPicker from '../../components/BsCalendarPicker'
import { nepalDayStartTs, nepalDayEndTs, bsSlash, bsMonthRangeIso } from '../pos/reports/reportRange'
import { loadDeltaExplosion, deltaItems } from '../../utils/orderLineIngredients'
import { loadOptionCatalog } from './customizationData'
import { buildCustomizationReport, withOptionCosts, mostAddedOf } from './customizationReportCalc'

// Crest Customization Report (S758 stage 8). Four questions an owner asks of their choices:
// which are picked, how often guests customize at all, what the "No …" requests are, and — with
// IMS — whether a paid choice earns more than it costs.
//
// Who (owner decision): the Owner, a POS manager or an IMS manager, plus admin — the same set that
// edits Option Groups, tested on the RAW role columns for the reason OptionGroups.jsx gives.
//
// Basis, stated on the page, the print-free export and the footnote alike: paid bills closed in the
// range; choice prices ex-VAT and before bill discounts; credit notes are not netted off.
//
// S759 critique fixes: the range opens on the BS month rather than one day; the KPI strip splits
// add-on income from size discounts and names the most ADDED choice (a size is answered, not
// added); the Margin tab stops painting a free-by-design choice as a loss; every table sorts.

const TABS = [
  { key: 'popular',  label: 'Popular choices' },
  { key: 'dishes',   label: 'How often customized' },
  { key: 'removals', label: '"No …" requests' },
  { key: 'margin',   label: 'Choice margin' },
]

// Each preset is a pair of BS-month offsets — see bsMonthRangeIso. Ranges are recomputed per
// render so the active pill follows the pickers, and are cheap (four bsToAd calls).
const RANGE_PRESETS = [
  { key: 'today',  label: 'Today',         range: () => { const { to } = bsMonthRangeIso(0); return { from: to, to } } },
  { key: 'month',  label: 'This month',    range: () => bsMonthRangeIso(0) },
  { key: 'last',   label: 'Last month',    range: () => bsMonthRangeIso(-1) },
  { key: 'three',  label: 'Last 3 months', range: () => bsMonthRangeIso(-2, 0) },
]

const DEFAULT_SORT = {
  popular:  { key: 'picks',  dir: 'desc' },
  dishes:   { key: 'plates', dir: 'desc' },
  removals: { key: 'picks',  dir: 'desc' },
  margin:   { key: 'picks',  dir: 'desc' },
}

const pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)
const signed = n => {
  const r = Math.round(Number(n) || 0)
  return r === 0 ? 'NPR 0' : `${r > 0 ? '+' : '−'}${npr(Math.abs(r))}`
}
/** A figure that is only ever ≤ 0, read as a reduction: "−NPR 200", or "NPR 0". */
const negative = n => {
  const r = Math.round(Number(n) || 0)
  return r === 0 ? 'NPR 0' : `−${npr(Math.abs(r))}`
}

/** Sort rows on one accessor; strings by locale, numbers with nulls last in both directions. */
function sortRows(rows, sort, accessors, tiebreak) {
  const get = accessors[sort.key]
  if (!get) return rows
  const dir = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = get(a), bv = get(b)
    const an = av == null, bn = bv == null
    if (an && bn) return tiebreak(a, b)
    if (an) return 1
    if (bn) return -1
    const c = typeof av === 'string' ? av.localeCompare(bv) : av - bv
    return (c * dir) || tiebreak(a, b)
  })
}

const byName = key => (a, b) => String(a[key]).localeCompare(String(b[key]))

/**
 * A sortable column heading — the S690 markup: the button INSIDE the Tip so the column is one tab
 * stop and the tip is announced on the control, `aria-sort` on the th. A numeric column opens
 * descending on its first click (the reason to sort by a figure is to find the top of it), a name
 * column ascending.
 */
function SortTh({ label, tip, sortKey, sort, onSort, numeric = false }) {
  const active = sort.key === sortKey
  const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'
  const button = (
    <button type="button" className={`th-sort${active ? ' th-sort--active' : ''}`}
      onClick={() => onSort(sortKey, numeric)}
      aria-label={`Sort by ${label}${active ? (sort.dir === 'asc' ? ', ascending' : ', descending') : ''}`}>
      {label}<span className="th-sort-arrow" aria-hidden="true">{arrow}</span>
    </button>
  )
  return (
    <th style={{ textAlign: numeric ? 'right' : 'left' }}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      {tip ? <Tip text={tip}>{button}</Tip> : button}
    </th>
  )
}

/** "Momo, Chowmein, Thukpa +4 more" — the rest in a Tip, the whole list in the workbook. */
function DishList({ dishes }) {
  const shown = dishes.slice(0, 3)
  const rest = dishes.slice(3)
  return (
    <>
      {shown.join(', ')}
      {rest.length > 0 && (
        <>
          {' '}
          <Tip text={rest.join(', ')}>
            <span style={{ color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>+{rest.length} more</span>
          </Tip>
        </>
      )}
    </>
  )
}

export default function CustomizationReport() {
  const { isAdmin, isOwner, profile, clientId, clientModules } = useAuth()
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  // The CLIENT's module, not the viewer's: an admin looking at a POS-only outlet must not be shown
  // a Margin tab that outlet cannot have.
  const imsOn = !!clientModules?.ims

  const [tab, setTab] = useState('popular')
  const [range, setRange] = useState(() => bsMonthRangeIso(0))
  const { from: fromIso, to: toIso } = range
  const setFromIso = v => setRange(r => ({ ...r, from: v }))
  const setToIso = v => setRange(r => ({ ...r, to: v }))
  const [sorts, setSorts] = useState(DEFAULT_SORT)
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
      const [ordersRes, attachRes, catalog] = await Promise.all([
        // Paged: a month of bills passes 1000 at any real volume, and every share on this page
        // divides by a count taken from it.
        fetchAllRows(() => scopedFrom('pos_orders', 'id')
          .eq('close_type', 'paid')
          .gte('closed_at', nepalDayStartTs(fromIso)).lte('closed_at', nepalDayEndTs(toIso))
          .order('id')),
        fetchAllRows(() => scopedFrom('pos_recipe_option_groups', 'id, recipe_id').order('id')),
        // Today's catalog: which group a choice belongs to (a size is not an add-on) and its list
        // price (a free-by-design choice is not a loss). A failed catalog read is a failed report
        // read — without it the tiles and the Margin tab would state things they cannot know.
        loadOptionCatalog(scopedFrom),
      ])
      const err1 = firstError([ordersRes, attachRes]) || catalog.error
      if (err1) throw err1
      const kindByGroup = Object.fromEntries(catalog.groups.map(g => [g.id, g.kind]))
      const kindByOptionId = Object.fromEntries(catalog.options.map(o => [o.id, kindByGroup[o.group_id] || 'unknown']))
      const listPriceByOptionId = Object.fromEntries(catalog.options.map(o => [o.id, Number(o.price_delta) || 0]))

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
        kindByOptionId,
        listPriceByOptionId,
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
  const top = report ? mostAddedOf(report.options) : null
  const onlySizes = !!report && !top && report.options.some(o => !o.is_removal && o.group_kind === 'size')

  const sort = sorts[tab] || DEFAULT_SORT[tab]
  const toggleSort = (key, numeric) => setSorts(s => {
    const cur = s[tab] || DEFAULT_SORT[tab]
    const dir = cur.key === key ? (cur.dir === 'asc' ? 'desc' : 'asc') : (numeric ? 'desc' : 'asc')
    return { ...s, [tab]: { key, dir } }
  })

  const popularRows = useMemo(() => report ? sortRows(report.options, sorts.popular, {
    option_name: o => o.option_name, group_name: o => o.group_name, picks: o => o.picks,
    charged: o => (o.is_removal ? null : o.charged),
  }, byName('option_name')) : [], [report, sorts.popular])
  const dishRows = useMemo(() => report ? sortRows(report.dishes, sorts.dishes, {
    name: d => d.name, plates: d => d.plates, customizedPlates: d => d.customizedPlates, share: d => d.share,
  }, byName('name')) : [], [report, sorts.dishes])
  const removalRows = useMemo(() => report ? sortRows(report.removalsByDish, sorts.removals, {
    dish: r => r.dish, option_name: r => r.option_name, picks: r => r.picks,
    share: r => (r.dishPlates ? r.picks / r.dishPlates : null),
  }, byName('dish')) : [], [report, sorts.removals])
  const marginSorted = useMemo(() => sortRows(marginRows, sorts.margin, {
    option_name: o => o.option_name, chargedPerPick: o => o.chargedPerPick, costPerPick: o => o.costPerPick,
    margin: o => (o.costPerPick == null ? null : o.chargedPerPick - o.costPerPick), picks: o => o.picks,
  }, byName('option_name')), [marginRows, sorts.margin])

  const canView = isAdmin || isOwner || profile?.pos_role === 'manager' || profile?.ims_role === 'manager'
  if (!canView) return <Navigate to="/dashboard" replace />

  async function exportExcel() {
    if (!report) return
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const add = (name, title, rows) => XLSX.utils.book_append_sheet(wb, sheetWithLetterhead(XLSX, { title, biz, scopeLine, rows }), name)
    add('Popular choices', 'Customization — Popular choices', popularRows.map(o => ({
      Choice: o.option_name, Group: o.group_name, 'Times picked (plates)': o.picks,
      'Extra charged (NPR, ex-VAT)': Math.round(o.charged), 'Picked on': o.dishes.join(', '),
    })))
    add('How often', 'Customization — How often customized', dishRows.map(d => ({
      Dish: d.name, 'Plates sold': d.plates, 'Plates customized': d.customizedPlates, 'Share customized': pct(d.share),
    })))
    add('No requests', 'Customization — "No …" requests', removalRows.map(r => ({
      Dish: r.dish, Request: r.option_name, 'Plates': r.picks, 'Share of the dish': pct(r.dishPlates ? r.picks / r.dishPlates : null),
    })))
    if (marginSorted.length) {
      add('Choice margin', 'Customization — Choice margin', marginSorted.map(o => ({
        Choice: o.option_name, 'List price (NPR)': o.listPriceDelta == null ? '' : Math.round(o.listPriceDelta),
        'Charged per plate (NPR)': Math.round(o.chargedPerPick),
        'Cost per plate (NPR, today\'s rates)': o.costPerPick == null ? '' : Math.round(o.costPerPick),
        'Margin per plate (NPR)': o.costPerPick == null ? '' : Math.round(o.chargedPerPick - o.costPerPick),
        'Times picked': o.picks,
      })))
    }
    XLSX.writeFile(wb, `customization-report-${fromIso}-to-${toIso}.xlsx`)
  }

  const exportDisabled = loading || !!loadError || !report || !!biz.error
  const visibleTabs = TABS.filter(t => t.key !== 'margin' || imsOn)

  const marginCell = o => {
    if (o.costPerPick == null) return <td style={{ textAlign: 'right' }}>—</td>
    const margin = o.chargedPerPick - o.costPerPick
    const free = o.listPriceDelta === 0 || (o.listPriceDelta == null && o.chargedPerPick === 0)
    const sizeBelow = o.listPriceDelta != null && o.listPriceDelta < 0
    if (free || sizeBelow) {
      // Not an upsell that lost money: a choice priced at 0 by design (or a size priced below the
      // dish) costs what it costs inside the dish's own food cost. No red, no ▼.
      const tip = free
        ? 'Free choice — its cost is part of the dish\'s food cost, not a loss on an upsell.'
        : 'A size priced below the dish — its cost is part of the dish\'s food cost, not a loss on an upsell.'
      return (
        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
          <Tip text={tip}>{signed(margin)}</Tip>
        </td>
      )
    }
    const loss = margin < 0
    return (
      <td style={{ textAlign: 'right', color: loss ? 'var(--theme-red-text)' : undefined }}>
        {signed(margin)}{loss ? ' ▼' : ''}
      </td>
    )
  }

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
      emptyText="No dish with choices was sold in this range. Attach option groups to dishes on Option Groups → Dishes, then check back after some bills."
      filters={(
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="tab-bar" role="group" aria-label="Range presets" style={{ alignSelf: 'flex-end' }}>
              {RANGE_PRESETS.map(p => {
                const r = p.range()
                const active = r.from === fromIso && r.to === toIso
                return (
                  <button key={p.key} type="button" aria-pressed={active}
                    className={`tab-btn${active ? ' tab-btn--active' : ''}`} onClick={() => setRange(r)}>
                    {p.label}
                  </button>
                )
              })}
            </div>
            <div className="form-field" style={{ margin: 0 }}>
              <label htmlFor="cust-report-from">From</label>
              <BsCalendarPicker id="cust-report-from" value={fromIso} onChange={setFromIso} />
            </div>
            <div className="form-field" style={{ margin: 0 }}>
              <label htmlFor="cust-report-to">To</label>
              <BsCalendarPicker id="cust-report-to" value={toIso} onChange={setToIso} />
            </div>
          </div>
          <div className="tab-bar" role="tablist" aria-label="Report view"
            onKeyDown={e => moveRovingFocus(e, '[role="tab"]')?.click()}>
            {visibleTabs.map(t => (
              <button key={t.key} type="button" role="tab" id={`cust-tab-${t.key}`}
                aria-selected={tab === t.key} aria-controls={`cust-panel-${t.key}`}
                tabIndex={rovingTabIndex(tab === t.key)}
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
            <div className="stat-label"><Tip text="Of those plates, how many carried at least one choice — a pre-selected size counts, so a dish whose size is always chosen will read as 100%.">With a choice picked</Tip></div>
            <div className="stat-value">{pct(report.customizedShare)}</div>
            <div className="stat-sub">{nprInt(report.customizedPlates)} plates</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="What paid add-ons added to bills, ex-VAT and before bill discounts. Comped plates add nothing.">Extras earned</Tip></div>
            <div className="stat-value">{npr(Math.round(report.extrasEarned))}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="What sizes priced below the dish took off bills — a Half at −NPR 100 counts here, never against extras. Ex-VAT, before bill discounts.">Size adjustments</Tip></div>
            <div className="stat-value">{negative(report.sizeAdjustments)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label"><Tip text="The choice guests asked for most. Sizes are left out — a size is answered on every plate of a dish that has one, not added — and so are 'No …' requests.">Most added</Tip></div>
            <div className="stat-value" style={{ fontSize: 18 }}>{top ? top.option_name : '—'}</div>
            {top && <div className="stat-sub">{nprInt(top.picks)} plates</div>}
            {onlySizes && <div className="stat-sub">Only sizes were picked</div>}
          </div>
        </div>
      )}
      footnote={<p className="page-subtitle" style={{ margin: '12px 0 0' }}>{scopeLine}.</p>}
    >
      {report && (
        <div role="tabpanel" id={`cust-panel-${tab}`} aria-labelledby={`cust-tab-${tab}`}>
          {tab === 'popular' && (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <SortTh label="Choice" sortKey="option_name" sort={sort} onSort={toggleSort} />
                  <SortTh label="Group" sortKey="group_name" sort={sort} onSort={toggleSort} />
                  <SortTh label="Times picked" tip="Plates this choice was on." sortKey="picks" sort={sort} onSort={toggleSort} numeric />
                  <SortTh label="Charged" tip="Price the choice added × paid plates, ex-VAT, before bill discounts." sortKey="charged" sort={sort} onSort={toggleSort} numeric />
                  <th>Picked on</th>
                </tr></thead>
                <tbody>
                  {popularRows.map(o => (
                    <tr key={o.key}>
                      <td><span style={{ whiteSpace: 'nowrap' }}>{o.option_name}</span></td>
                      <td>{o.group_name}</td>
                      <td style={{ textAlign: 'right' }}>{nprInt(o.picks)}</td>
                      <td style={{ textAlign: 'right' }}>{o.is_removal ? '—' : signed(o.charged)}</td>
                      <td><DishList dishes={o.dishes} /></td>
                    </tr>
                  ))}
                  {popularRows.length === 0 && <tr><td colSpan={5} className="empty-state">No choices were picked in this range.</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'dishes' && (
            <div className="table-wrap">
              <table className="data-table">
                <thead><tr>
                  <SortTh label="Dish" sortKey="name" sort={sort} onSort={toggleSort} />
                  <SortTh label="Plates sold" sortKey="plates" sort={sort} onSort={toggleSort} numeric />
                  <SortTh label="Customized" sortKey="customizedPlates" sort={sort} onSort={toggleSort} numeric />
                  <SortTh label="Share" tip="Plates with at least one choice ÷ plates sold. A dish nobody customizes may not need its groups; one everybody customizes may want a new default." sortKey="share" sort={sort} onSort={toggleSort} numeric />
                </tr></thead>
                <tbody>
                  {dishRows.map(d => (
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

          {tab === 'removals' && (
            removalRows.length === 0
              ? <p className="empty-state">No "No …" choices were picked in this range.</p>
              : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr>
                      <SortTh label="Dish" sortKey="dish" sort={sort} onSort={toggleSort} />
                      <SortTh label="Request" sortKey="option_name" sort={sort} onSort={toggleSort} />
                      <SortTh label="Plates" sortKey="picks" sort={sort} onSort={toggleSort} numeric />
                      <SortTh label="Share of the dish" tip="Plates with this request ÷ all plates of the dish. A request on most plates may mean the recipe should change." sortKey="share" sort={sort} onSort={toggleSort} numeric />
                    </tr></thead>
                    <tbody>
                      {removalRows.map(r => (
                        <tr key={`${r.recipe_id}|${r.option_name}`}>
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

          {tab === 'margin' && imsOn && (
            costError ? (
              <p role="alert" className="action-error">The stock lines or item rates could not be read, so choice costs are not shown. The other tabs are unaffected — reload to try again.</p>
            ) : marginSorted.length === 0 ? (
              <p className="empty-state">No choice with stock lines was picked in this range. Add stock lines to a choice in Option Groups to see its cost here.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <SortTh label="Choice" sortKey="option_name" sort={sort} onSort={toggleSort} />
                    <SortTh label="Charged / plate" tip="Average price this choice added per paid plate, ex-VAT. A free 'first N' pick or a comped plate lowers it below the list price." sortKey="chargedPerPick" sort={sort} onSort={toggleSort} numeric />
                    <SortTh label="Cost / plate" tip="The choice's stock lines as they were on the bill, valued at today's item rates." sortKey="costPerPick" sort={sort} onSort={toggleSort} numeric />
                    <SortTh label="Margin / plate" tip="Charged minus cost. A choice that is free by design is shown in grey — its cost belongs to the dish, not to an upsell." sortKey="margin" sort={sort} onSort={toggleSort} numeric />
                    <SortTh label="Times picked" sortKey="picks" sort={sort} onSort={toggleSort} numeric />
                  </tr></thead>
                  <tbody>
                    {marginSorted.map(o => {
                      const belowList = o.listPriceDelta != null && o.listPriceDelta > 0 && o.chargedPerPick < o.listPriceDelta - 0.005
                      return (
                        <tr key={o.key}>
                          <td><span style={{ whiteSpace: 'nowrap' }}>{o.option_name}</span></td>
                          <td style={{ textAlign: 'right' }}>
                            {signed(o.chargedPerPick)}
                            {belowList && (
                              <div className="stat-sub" style={{ marginTop: 2 }}>
                                <Tip text={`Listed at ${signed(o.listPriceDelta)}. Some plates paid less — a pick inside the group's "first N free", or a comped plate.`}>incl. free picks</Tip>
                              </div>
                            )}
                          </td>
                          <td style={{ textAlign: 'right' }}>{o.costPerPick == null ? <Tip text="No stock lines on this choice.">—</Tip> : npr(Math.round(o.costPerPick))}</td>
                          {marginCell(o)}
                          <td style={{ textAlign: 'right' }}>{nprInt(o.picks)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      )}
    </ReportPage>
  )
}
