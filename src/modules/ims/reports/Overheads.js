import { useEffect, useState, useMemo } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { daysInBsMonth } from '../../../utils/bsCalendar'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

// labor's blue has no dedicated theme token — accent/green/red/amber/purple are already spoken
// for by food/overhead/profit-loss/target-warning/tax elsewhere on this page, so it stays a fixed
// hex (same reasoning as a chart legend needing more distinct hues than the semantic token set).
const BUCKET_CONFIG = {
  overhead: {
    label: 'Fixed Overheads',
    color: 'var(--theme-accent)',
    target: 25,
    presets: ['Rent', 'Utilities', 'Tech & Software', 'Marketing', 'Insurance', 'Miscellaneous'],
    placeholders: {
      'Rent':           'e.g. Shop lease — Jhamsikhel 3rd floor',
      'Utilities':      'e.g. Electricity, water, gas combined',
      'Tech & Software':'e.g. POS system, music license, Wi-Fi',
      'Marketing':      'e.g. Instagram ads, flyers, promotions',
      'Insurance':      'e.g. Business property & liability insurance',
      'Miscellaneous':  'e.g. Repairs, cleaning supplies, misc',
    }
  },
  labor: {
    label: 'Labor Costs',
    color: 'var(--theme-text1)',
    target: 30,
    presets: ['Manager / Head Chef', 'Kitchen Staff', 'Service Staff', 'Part-time / Hourly', 'Benefits & Bonuses'],
    placeholders: {
      'Manager / Head Chef': 'e.g. Fixed monthly salary',
      'Kitchen Staff':       'e.g. 3 cooks × NPR 18,000',
      'Service Staff':       'e.g. 2 servers × NPR 15,000',
      'Part-time / Hourly':  'e.g. Estimated hourly wages this month',
      'Benefits & Bonuses':  'e.g. Festival bonuses, provident fund',
    }
  },
  tax_fees: {
    label: 'Tax & Fees',
    color: 'var(--theme-purple)',
    target: 5,
    presets: ['VAT Compliance', 'Card Processing', 'Bank Charges', 'License & Permits', 'Accountant Fees'],
    placeholders: {
      'VAT Compliance':   'e.g. Monthly VAT filing costs',
      'Card Processing':  'e.g. FonePay / eSewa processing fee estimate',
      'Bank Charges':     'e.g. Monthly bank maintenance fees',
      'License & Permits':'e.g. Food safety permit renewal',
      'Accountant Fees':  'e.g. Monthly bookkeeping or CA fees',
    }
  }
}

const emptyRow = (category = '') => ({ id: null, category, description: '', amount: '', _dirty: true })

function seedBucket(key) {
  return BUCKET_CONFIG[key].presets.map(cat => emptyRow(cat))
}

export default function Overheads() {
  const { profile, clientId, isAdmin } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedDelete } = useScopedDb()

  const [periods, setPeriods]       = useState([])
  const [periodId, setPeriodId]     = useState('')
  const [rows, setRows]             = useState({ overhead: [], labor: [], tax_fees: [] })
  const [activeBucket, setActiveBucket] = useState('overhead')
  const [periodData, setPeriodData] = useState(null)
  const [loading, setLoading]       = useState(true)
  const [saving, setSaving]         = useState(false)
  const [saved, setSaved]           = useState(false)

  useEffect(() => { if (effectiveClientId) loadPeriods() }, [effectiveClientId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (periodId) loadAll() }, [periodId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadPeriods() {
    const { data } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month, status')
      .order('bs_year', { ascending: false })
      .order('bs_month', { ascending: false })
    const withLabel = (data || []).map(p => ({ ...p, label: `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` }))
    setPeriods(withLabel)
    const open = withLabel.find(p => p.status === 'open') || withLabel[0]
    if (open) setPeriodId(open.id)
  }

  async function loadAll() {
    setLoading(true)
    await Promise.all([loadOverheads(), loadPeriodData()])
    setLoading(false)
  }

  async function loadOverheads() {
    const { data } = await scopedFrom('overheads')
      .eq('period_id', periodId)
      .order('created_at')

    const grouped = { overhead: [], labor: [], tax_fees: [] }
    if (data && data.length > 0) {
      data.forEach(r => {
        const b = r.bucket || 'overhead'
        if (grouped[b]) grouped[b].push({ ...r, _dirty: false })
        else grouped.overhead.push({ ...r, _dirty: false })
      })
    }
    // Seed empty buckets with preset rows
    Object.keys(BUCKET_CONFIG).forEach(b => {
      if (grouped[b].length === 0) grouped[b] = seedBucket(b)
    })
    setRows(grouped)
  }

  async function loadPeriodData() {
    const [
      { data: purchases },
      { data: returns },
      { data: salesData },
      { data: recipes }
    ] = await Promise.all([
      supabase.from('purchase_entries').select('qty, rate').eq('period_id', periodId),
      scopedFrom('vendor_returns', 'qty, rate').eq('period_id', periodId),
      // Revenue excludes comps (source='pos_comp') — a comped dish was never paid for.
      supabase.from('sales_entries').select('recipe_id, qty_sold, unit_price').eq('period_id', periodId).neq('source', 'pos_comp'),
      scopedFrom('recipes', 'id, selling_price')
    ])

    const gross  = (purchases || []).reduce((s, p) => s + parseFloat(p.qty || 0) * parseFloat(p.rate || 0), 0)
    const ret    = (returns  || []).reduce((s, r) => s + parseFloat(r.qty || 0) * parseFloat(r.rate || 0), 0)
    const foodCost = gross - ret

    const recipeMap = {}
    ;(recipes || []).forEach(r => { recipeMap[r.id] = parseFloat(r.selling_price) || 0 })
    // unit_price captured on the row (price actually charged) used per-row when present, else
    // falls back to the recipe's current price — previously always used the current price, so
    // this period's revenue silently reflected today's menu price, not what was charged then.
    const soldMap = {}, revenueBySold = {}
    ;(salesData || []).forEach(s => {
      const qty = parseFloat(s.qty_sold || 0)
      const price = s.unit_price != null ? parseFloat(s.unit_price) : (recipeMap[s.recipe_id] || 0)
      soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + qty
      revenueBySold[s.recipe_id] = (revenueBySold[s.recipe_id] || 0) + qty * price
    })
    const revenue = Object.values(revenueBySold).reduce((s, v) => s + v, 0)
    const covers  = Object.values(soldMap).reduce((s, qty) => s + qty, 0)

    setPeriodData({ revenue, foodCost, covers })
  }

  function updateRow(bucket, idx, field, value) {
    setRows(prev => ({
      ...prev,
      [bucket]: prev[bucket].map((row, i) => i === idx ? { ...row, [field]: value, _dirty: true } : row)
    }))
  }

  function addRow(bucket) {
    setRows(prev => ({ ...prev, [bucket]: [...prev[bucket], emptyRow()] }))
  }

  function removeRow(bucket, idx) {
    setRows(prev => ({ ...prev, [bucket]: prev[bucket].filter((_, i) => i !== idx) }))
  }

  async function save() {
    if (!effectiveClientId) { alert('No client selected. Pick a client in the top-left switcher before saving.'); return }
    setSaving(true)
    await scopedDelete('overheads').eq('period_id', periodId)
    const inserts = []
    Object.entries(rows).forEach(([bucket, bucketRows]) => {
      bucketRows
        .filter(r => r.category?.trim() && parseFloat(r.amount) > 0)
        .forEach(r => inserts.push({
          period_id:   periodId,
          bucket,
          category:    r.category.trim(),
          description: r.description?.trim() || '',
          amount:      parseFloat(r.amount) || 0,
        }))
    })
    if (inserts.length > 0) await scopedInsert('overheads', inserts)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
    await loadOverheads()
  }

  const totals = useMemo(() => ({
    overhead: rows.overhead.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
    labor:    rows.labor.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
    tax_fees: rows.tax_fees.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0),
  }), [rows])

  const totalFixed = totals.overhead + totals.labor + totals.tax_fees
  const revenue  = periodData?.revenue  || 0
  const foodCost = periodData?.foodCost || 0
  const covers   = periodData?.covers   || 0
  const netProfit = revenue > 0 ? revenue - foodCost - totalFixed : null
  // BS months run 28-32 days, never 30 — a hardcoded /30 over/understates daily burn by up to
  // ~7% depending on the period.
  const selectedPeriodObj = periods.find(p => p.id === periodId)
  const daysInSelectedMonth = selectedPeriodObj ? daysInBsMonth(selectedPeriodObj.bs_year, selectedPeriodObj.bs_month) : 30

  const hasSales = revenue > 0

  function pct(amount, base) {
    return base > 0 ? (amount / base) * 100 : null
  }

  function fmtPct(amount, base) {
    const p = pct(amount, base)
    return p != null ? `${p.toFixed(1)}%` : null
  }

  function trafficLight(actual, target) {
    if (actual == null) return 'var(--theme-text2)'
    const diff = actual - target
    if (diff <= 2)  return 'var(--theme-green)'
    if (diff <= 8)  return 'var(--theme-amber)'
    return 'var(--theme-red)'
  }

  function fmt(val) {
    return `NPR ${Number(val || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`
  }

  // P&L rows
  const pnlRows = hasSales ? [
    { key: 'food',   label: 'Food Cost',  amount: foodCost,        target: 30, color: 'var(--theme-accent)' },
    { key: 'labor',  label: 'Labor',      amount: totals.labor,    target: 30, color: 'var(--theme-text1)' },
    { key: 'oh',     label: 'Overhead',   amount: totals.overhead, target: 25, color: 'var(--theme-green)' },
    { key: 'tax',    label: 'Tax & Fees', amount: totals.tax_fees, target: 5,  color: 'var(--theme-purple)' },
    { key: 'profit', label: 'Net Profit', amount: netProfit,       target: 10,
      color: netProfit != null && netProfit >= 0 ? 'var(--theme-green)' : 'var(--theme-red)' },
  ] : null

  // Cross-bucket ranked pivot — all line items with amount > 0, sorted by spend
  const allLineItems = useMemo(() => {
    return Object.entries(rows).flatMap(([bucket, bucketRows]) =>
      bucketRows
        .filter(r => parseFloat(r.amount) > 0)
        .map(r => ({
          bucket,
          category:    r.category || '—',
          description: r.description || '',
          amount:      parseFloat(r.amount),
          pctOfTotal:  totalFixed > 0 ? (parseFloat(r.amount) / totalFixed) * 100 : 0,
          pctOfRev:    revenue    > 0 ? (parseFloat(r.amount) / revenue)    * 100 : null,
        }))
    ).sort((a, b) => b.amount - a.amount)
  }, [rows, totalFixed, revenue])

  // Break-even
  const avgTicket = covers > 0 ? revenue / covers : 0
  const fcPct     = revenue > 0 ? foodCost / revenue : 0.30
  const contribMargin   = 1 - fcPct
  const breakEvenRev    = contribMargin > 0 && totalFixed > 0 ? totalFixed / contribMargin : null
  const breakEvenCovers = avgTicket > 0 && breakEvenRev ? Math.ceil(breakEvenRev / avgTicket) : null
  const isAboveBreakEven = breakEvenRev != null && revenue >= breakEvenRev

  const period  = periods.find(p => p.id === periodId)
  const isLocked = !isAdmin && period?.status === 'closed'
  const cfg = BUCKET_CONFIG[activeBucket]
  const activeRows  = rows[activeBucket]
  const bucketTotal = totals[activeBucket]

  return (
    <div>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Overheads & Cost Breakdown</h1>
          <p className="page-subtitle">Fixed costs · Labor · Tax & Fees · True P&L — {period?.label || '—'}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select
            value={periodId}
            onChange={e => setPeriodId(e.target.value)}
            style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
          >
            {periods.map(p => <option key={p.id} value={p.id}>{p.label}{p.status === 'open' ? ' (open)' : ''}</option>)}
          </select>
          <button className="btn btn-primary" onClick={save} disabled={saving || isLocked}>
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Save'}
          </button>
        </div>
      </div>

      {isLocked && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red)' }}>
          🔒 <strong>This period is closed.</strong> Data is read-only. Contact your admin to re-open if needed.
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 14, marginBottom: 24 }}>
        {[
          {
            label: 'Fixed Overheads', value: fmt(totals.overhead),
            sub: fmtPct(totals.overhead, revenue) ? `${fmtPct(totals.overhead, revenue)} of revenue` : 'No sales data',
            color: 'var(--theme-accent)',
            tip: 'Rent, utilities, tech, marketing — costs that exist regardless of how many customers you serve.'
          },
          {
            label: 'Labor Costs', value: fmt(totals.labor),
            sub: fmtPct(totals.labor, revenue) ? `${fmtPct(totals.labor, revenue)} of revenue` : 'No sales data',
            color: 'var(--theme-text1)',
            tip: 'Salaries, wages, and benefits. Industry target: ~30% of revenue.'
          },
          {
            label: 'Tax & Fees', value: fmt(totals.tax_fees),
            sub: fmtPct(totals.tax_fees, revenue) ? `${fmtPct(totals.tax_fees, revenue)} of revenue` : 'No sales data',
            color: 'var(--theme-purple)',
            tip: 'VAT compliance, card processing fees, bank charges, licenses. Often forgotten but real.'
          },
          {
            label: 'Total Fixed Costs', value: fmt(totalFixed),
            sub: fmtPct(totalFixed, revenue) ? `${fmtPct(totalFixed, revenue)} of revenue` : 'Overhead + Labor + Tax',
            color: 'var(--theme-text1)',
            tip: 'Sum of all three buckets. Every month you must earn more than this just to survive.'
          },
          {
            label: 'Daily Fixed Cost', value: fmt(totalFixed / daysInSelectedMonth),
            sub: `÷ ${daysInSelectedMonth} days this month`,
            color: 'var(--theme-text2)',
            tip: 'How much your fixed costs burn each day, even if the cafe is closed.'
          },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <div className="stat-label">
              <Tip text={s.tip} width={220}>{s.label}</Tip>
            </div>
            <div className="stat-value" style={{ fontSize: 16, color: s.color }}>{s.value}</div>
            <div className="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Entry card — tabs + table */}
      <div className="card" style={{ marginBottom: 20 }}>
        {/* Bucket tabs */}
        <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--theme-border)', marginBottom: 20 }}>
          {Object.entries(BUCKET_CONFIG).map(([key, c]) => (
            <button
              key={key}
              onClick={() => setActiveBucket(key)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '10px 20px', fontSize: 13, fontWeight: 500,
                color: activeBucket === key ? c.color : 'var(--theme-text2)',
                borderBottom: activeBucket === key ? `2px solid ${c.color}` : '2px solid transparent',
                marginBottom: -1, transition: 'color 0.12s', whiteSpace: 'nowrap'
              }}
            >
              {c.label}
              {totals[key] > 0 && (
                <span style={{ marginLeft: 8, fontSize: 11, background: 'color-mix(in srgb, var(--theme-text1) 8%, transparent)', borderRadius: 10, padding: '2px 7px', color: c.color }}>
                  {fmt(totals[key])}
                </span>
              )}
            </button>
          ))}
          {!isLocked && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, marginLeft: 'auto' }}
              onClick={() => addRow(activeBucket)}
            >
              + Add Row
            </button>
          )}
        </div>

        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
        ) : (
          <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 200 }}>Category</th>
                <th>Description</th>
                <th style={{ textAlign: 'right', width: 160 }}>Amount (NPR)</th>
                <th style={{ textAlign: 'right', width: 80 }}><Tip text="This item's share of the total overhead for its bucket (Food Cost, Labour, or Other)." width={260}>% of Bucket</Tip></th>
                <th style={{ width: 40 }}></th>
              </tr>
            </thead>
            <tbody>
              {activeRows.map((row, idx) => (
                <tr key={idx}>
                  <td>
                    <select
                      value={cfg.presets.includes(row.category) ? row.category : '__custom__'}
                      onChange={e => {
                        if (e.target.value === '__custom__') updateRow(activeBucket, idx, 'category', '')
                        else updateRow(activeBucket, idx, 'category', e.target.value)
                      }}
                      disabled={isLocked}
                      style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '6px 8px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%' }}
                    >
                      {cfg.presets.map(c => <option key={c} value={c}>{c}</option>)}
                      <option value="__custom__">Custom…</option>
                    </select>
                    {!cfg.presets.includes(row.category) && (
                      <input
                        value={row.category}
                        onChange={e => updateRow(activeBucket, idx, 'category', e.target.value)}
                        placeholder="Category name"
                        disabled={isLocked}
                        style={{ marginTop: 4, background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '5px 8px', fontSize: 12, color: 'var(--theme-text1)', outline: 'none', width: '100%' }}
                      />
                    )}
                  </td>
                  <td>
                    <input
                      value={row.description || ''}
                      onChange={e => updateRow(activeBucket, idx, 'description', e.target.value)}
                      disabled={isLocked}
                      placeholder={cfg.placeholders[row.category] || 'Description…'}
                      style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '6px 8px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%' }}
                    />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <input
                      type="number"
                      value={row.amount}
                      onChange={e => updateRow(activeBucket, idx, 'amount', e.target.value)}
                      disabled={isLocked}
                      placeholder="0"
                      style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 5, padding: '6px 8px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 130, textAlign: 'right' }}
                    />
                  </td>
                  <td style={{ textAlign: 'right', fontSize: 13, color: bucketTotal > 0 && parseFloat(row.amount) > 0 ? cfg.color : 'var(--theme-text3)', fontWeight: 600 }}>
                    {bucketTotal > 0 && parseFloat(row.amount) > 0
                      ? `${((parseFloat(row.amount) / bucketTotal) * 100).toFixed(1)}%`
                      : '—'}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {!isLocked && (
                      <button onClick={() => removeRow(activeBucket, idx)}
                        style={{ background: 'none', border: 'none', color: 'var(--theme-red)', cursor: 'pointer', fontSize: 16, padding: '4px 8px' }}>×</button>
                    )}
                  </td>
                </tr>
              ))}
              <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                <td colSpan={2} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12, fontSize: 13 }}>TOTAL</td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: cfg.color, fontSize: 16, paddingTop: 12 }}>{fmt(bucketTotal)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text2)', fontSize: 13, paddingTop: 12 }}>100%</td>
                <td></td>
              </tr>
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* P&L Summary */}
      {pnlRows ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
            <div>
              <h3 style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>P&L Summary</h3>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-text3)' }}>
                Revenue: {fmt(revenue)} &nbsp;·&nbsp; {Math.round(covers).toLocaleString()} covers &nbsp;·&nbsp; {period?.label || '—'}
              </p>
            </div>
            <Tip text="Food cost uses net purchases ÷ revenue (purchase-based). For COGS-based food cost, see Monthly Summary." width={240}>
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', cursor: 'help' }}>Purchase-based FC%</span>
            </Tip>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {pnlRows.map(row => {
              const actualPct  = pct(row.amount, revenue)
              const numPct     = actualPct || 0
              const isProfit   = row.key === 'profit'
              const barColor   = isProfit
                ? (row.amount != null && row.amount >= 0 ? 'var(--theme-green)' : 'var(--theme-red)')
                : trafficLight(numPct, row.target)
              const barWidth   = Math.min(Math.abs(numPct), 100)

              return (
                <div key={row.key}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: row.color, display: 'inline-block', flexShrink: 0 }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', minWidth: 90 }}>{row.label}</span>
                      <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>target {row.target}%</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
                      <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{fmt(row.amount)}</span>
                      <span style={{ fontSize: 15, fontWeight: 700, color: barColor, minWidth: 54, textAlign: 'right' }}>
                        {actualPct != null
                          ? `${isProfit && row.amount >= 0 ? '+' : ''}${actualPct.toFixed(1)}%`
                          : '—'}
                      </span>
                    </div>
                  </div>
                  <div style={{ height: 7, background: 'var(--theme-border)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: '100%', height: '100%', background: barColor, borderRadius: 4, transform: `scaleX(${barWidth / 100})`, transformOrigin: 'left', transition: 'transform 0.4s ease' }} />
                  </div>
                </div>
              )
            })}
          </div>

          {/* Net profit callout */}
          {netProfit != null && (
            <div style={{
              marginTop: 20, padding: '12px 16px', borderRadius: 8,
              background: netProfit >= 0 ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)',
              border: `1px solid ${netProfit >= 0 ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)'}`,
              display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
                {netProfit >= 0 ? '✓ Profitable this period' : '✗ Operating at a loss this period'}
              </span>
              <span style={{ fontSize: 20, fontWeight: 800, color: netProfit >= 0 ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                {netProfit >= 0 ? '+' : ''}{fmt(netProfit)}
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={{ marginBottom: 16, background: 'rgba(201,168,76,0.04)', borderColor: 'rgba(201,168,76,0.15)' }}>
          <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>
            💡 Add sales entries for this period to unlock the <strong style={{ color: 'var(--theme-accent)' }}>P&L Summary</strong>, <strong style={{ color: 'var(--theme-accent)' }}>Break-Even</strong>, and <strong style={{ color: 'var(--theme-accent)' }}>Overhead per Cover</strong> panels.
          </p>
        </div>
      )}

      {/* Charts — cost stack + bucket breakdown + pivot */}
      {totalFixed > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: '0 0 20px', fontSize: 13, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Cost Visualisation</h3>

          {/* Revenue cost stack — only when sales data available */}
          {hasSales && (() => {
            const fc  = { key: 'food',     label: 'Food Cost', color: 'var(--theme-accent)', amount: foodCost,        pct: pct(foodCost,        revenue) || 0 }
            const lb  = { key: 'labor',    label: 'Labor',     color: 'var(--theme-text1)', amount: totals.labor,    pct: pct(totals.labor,    revenue) || 0 }
            const oh  = { key: 'overhead', label: 'Overhead',  color: 'var(--theme-green)', amount: totals.overhead, pct: pct(totals.overhead, revenue) || 0 }
            const tx  = { key: 'tax',      label: 'Tax & Fees',color: 'var(--theme-purple)', amount: totals.tax_fees, pct: pct(totals.tax_fees, revenue) || 0 }
            const prPct = netProfit != null ? pct(netProfit, revenue) : null
            const pr  = { key: 'profit',   label: prPct != null && prPct < 0 ? 'Loss' : 'Net Profit',
                          color: prPct != null && prPct < 0 ? 'var(--theme-red)' : 'var(--theme-green)',
                          amount: netProfit, pct: prPct || 0 }
            const segments = [fc, lb, oh, tx, pr].filter(s => s.amount != null && s.pct > 0.2)
            return (
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 10 }}>
                  Where each rupee of revenue goes &nbsp;·&nbsp; <span style={{ color: 'var(--theme-accent)', fontWeight: 600 }}>Revenue {fmt(revenue)}</span>
                </div>
                {/* Stacked bar */}
                <div style={{ display: 'flex', height: 36, borderRadius: 8, overflow: 'hidden', gap: 2, marginBottom: 10 }}>
                  {segments.map(s => (
                    <div key={s.key} title={`${s.label}: ${fmt(s.amount)} (${s.pct.toFixed(1)}%)`} style={{
                      width: `${Math.min(s.pct, 100)}%`, minWidth: s.pct > 4 ? 2 : 0,
                      background: s.color, display: 'flex', alignItems: 'center',
                      justifyContent: 'center', overflow: 'hidden', cursor: 'default',
                    }}>
                      {s.pct > 7 && (
                        <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--theme-bg)', whiteSpace: 'nowrap' }}>
                          {s.pct.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                {/* Legend */}
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  {segments.map(s => (
                    <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: s.color, display: 'inline-block', flexShrink: 0 }} />
                      <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{s.label}</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: s.color }}>{s.pct.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

          {/* Per-bucket category breakdown */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 24 }}>
            {Object.entries(BUCKET_CONFIG).map(([key, cfg]) => {
              const bucketRows = rows[key].filter(r => parseFloat(r.amount) > 0)
              const total = totals[key]
              return (
                <div key={key} style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 8, padding: '14px', border: '1px solid var(--theme-border)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: cfg.color }}>{cfg.label}</span>
                    <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{fmt(total)}</span>
                  </div>
                  {total === 0 ? (
                    <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0 }}>No entries yet.</p>
                  ) : bucketRows.length === 0 ? (
                    <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: 0 }}>Nothing entered.</p>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                      {bucketRows.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount)).map((row, i) => {
                        const rowPct = total > 0 ? (parseFloat(row.amount) / total) * 100 : 0
                        return (
                          <div key={i}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                              <span style={{ fontSize: 11, color: 'var(--theme-text1)', fontWeight: 500 }}>{row.category}</span>
                              <span style={{ fontSize: 11, color: cfg.color, fontWeight: 700 }}>{rowPct.toFixed(0)}%</span>
                            </div>
                            <div style={{ height: 5, background: 'var(--theme-border)', borderRadius: 3, overflow: 'hidden' }}>
                              <div style={{ width: `${rowPct}%`, height: '100%', background: cfg.color, opacity: 0.75, borderRadius: 3 }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* All line items pivot — cross-bucket ranked by spend */}
          {allLineItems.length > 0 && (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 10 }}>
                All Cost Lines — Ranked by Spend
              </div>
              <div className="table-wrap">
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Bucket</th>
                      <th>Category</th>
                      <th>Description</th>
                      <th style={{ textAlign: 'right' }}>Amount (NPR)</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="This line item's share of your total fixed costs (overheads + labor + tax combined)." width={220}>% of Total Cost</Tip>
                      </th>
                      {revenue > 0 && (
                        <th style={{ textAlign: 'right' }}>
                          <Tip text="This line item as a percentage of period revenue. Helps see which costs eat into margin most." width={220}>% of Revenue</Tip>
                        </th>
                      )}
                      <th style={{ minWidth: 100 }}>
                        <Tip text="Visual share of total fixed costs." width={160}>Share</Tip>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {allLineItems.map((item, i) => {
                      const cfg = BUCKET_CONFIG[item.bucket]
                      return (
                        <tr key={i}>
                          <td>
                            <span style={{ fontSize: 11, fontWeight: 700, color: cfg?.color, background: 'rgba(255,255,255,0.05)', borderRadius: 4, padding: '2px 7px', whiteSpace: 'nowrap' }}>
                              {cfg?.label || item.bucket}
                            </span>
                          </td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{item.category}</td>
                          <td style={{ color: 'var(--theme-text2)', maxWidth: 220 }}>{item.description || '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>{item.amount.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontWeight: 600 }}>{item.pctOfTotal.toFixed(1)}%</td>
                          {revenue > 0 && (
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                              {item.pctOfRev != null ? `${item.pctOfRev.toFixed(1)}%` : '—'}
                            </td>
                          )}
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ flex: 1, height: 6, background: 'var(--theme-border)', borderRadius: 3, overflow: 'hidden', minWidth: 60 }}>
                                <div style={{ width: `${item.pctOfTotal}%`, height: '100%', background: cfg?.color || 'var(--theme-accent)', borderRadius: 3 }} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                      <td colSpan={3} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 10, fontSize: 12 }}>TOTAL FIXED COSTS</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)', paddingTop: 10 }}>{totalFixed.toLocaleString('en-NP', { maximumFractionDigits: 0 })}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', paddingTop: 10 }}>100%</td>
                      {revenue > 0 && (
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 10 }}>
                          {fmtPct(totalFixed, revenue)}
                        </td>
                      )}
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Break-even + Overhead per cover */}
      {hasSales && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>

          {/* Break-even */}
          <div className="card" style={{
            background: isAboveBreakEven ? 'rgba(52,211,153,0.04)' : 'rgba(248,113,113,0.04)',
            borderColor: isAboveBreakEven ? 'rgba(52,211,153,0.2)' : 'rgba(248,113,113,0.2)'
          }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 16 }}>
              <Tip text="The minimum revenue / covers needed to cover all fixed costs. Below this = loss. Above = profit begins." width={230}>Break-Even Analysis</Tip>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Need (Revenue)</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>{breakEvenRev ? fmt(breakEvenRev) : '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Need (Covers)</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>{breakEvenCovers ? breakEvenCovers.toLocaleString() : '—'}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Actual Revenue</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: isAboveBreakEven ? 'var(--theme-green)' : 'var(--theme-red)' }}>{fmt(revenue)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Actual Covers</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: isAboveBreakEven ? 'var(--theme-green)' : 'var(--theme-red)' }}>{Math.round(covers).toLocaleString()}</div>
              </div>
            </div>
            <div style={{ padding: '10px 14px', borderRadius: 6, fontSize: 13, fontWeight: 700,
              background: isAboveBreakEven ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)',
              color: isAboveBreakEven ? 'var(--theme-green)' : 'var(--theme-red)'
            }}>
              {isAboveBreakEven && breakEvenRev
                ? `✓ Above break-even by ${fmt(revenue - breakEvenRev)}`
                : breakEvenRev
                  ? `✗ Below break-even by ${fmt(breakEvenRev - revenue)}`
                  : contribMargin <= 0
                    ? `✗ Purchase cost (${(fcPct * 100).toFixed(1)}% FC) exceeds revenue — break-even is undefined`
                    : totalFixed === 0
                      ? 'Enter overhead costs above and save to calculate'
                      : 'Unable to calculate'}
            </div>
            <p style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 10, marginBottom: 0, lineHeight: 1.6 }}>
              Formula: Total Fixed Costs ÷ (1 − FC%) &nbsp;·&nbsp;
              Avg ticket: {avgTicket > 0 ? fmt(avgTicket) : '—'} &nbsp;·&nbsp;
              FC%: {revenue > 0 ? `${(fcPct * 100).toFixed(1)}%` : '—'}
            </p>
          </div>

          {/* Overhead per cover */}
          <div className="card">
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 16 }}>
              <Tip text="How much of each sale goes to fixed costs before any food cost or profit. Every cover must earn at least this much just to keep the lights on." width={240}>Cost per Cover</Tip>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Fixed OH / Cover</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-accent)' }}>
                  {covers > 0 && totals.overhead > 0 ? fmt(totals.overhead / covers) : '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Labor / Cover</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--theme-text1)' }}>
                  {covers > 0 && totals.labor > 0 ? fmt(totals.labor / covers) : '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Tax & Fees / Cover</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--theme-purple)' }}>
                  {covers > 0 && totals.tax_fees > 0 ? fmt(totals.tax_fees / covers) : '—'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Total Fixed / Cover</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>
                  {covers > 0 && totalFixed > 0 ? fmt(totalFixed / covers) : '—'}
                </div>
              </div>
            </div>
            <p style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 14, marginBottom: 0, lineHeight: 1.6 }}>
              Every sale must earn at least <strong style={{ color: 'var(--theme-text1)' }}>{covers > 0 && totalFixed > 0 ? fmt(totalFixed / covers) : '—'}</strong> just to cover fixed costs. Food cost and profit are on top of this.
            </p>
          </div>
        </div>
      )}

      {/* Footer note */}
      <div className="card" style={{ background: 'rgba(201,168,76,0.04)', borderColor: 'rgba(201,168,76,0.15)' }}>
        <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.7 }}>
          💡 <strong style={{ color: 'var(--theme-accent)' }}>How overhead is allocated to recipes:</strong> Only <strong style={{ color: 'var(--theme-text1)' }}>Fixed Overheads</strong> (not labor or tax) are distributed across menu items proportionally by each item's share of period revenue. This gives you the true overhead-per-portion in Recipe Costing. Labor and Tax & Fees are period-level costs tracked separately.
        </p>
      </div>
    </div>
  )
}
