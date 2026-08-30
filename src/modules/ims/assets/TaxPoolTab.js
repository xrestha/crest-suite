import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { getBsFiscalYear, getBsFiscalYearStart, getBsToday, formatAd } from '../../../utils/bsCalendar'
import { getFiscalYearAdRange } from '../reports/vendorBalanceHelpers'
import { printWithTitle } from '../../../utils/printTitle'
import {
  acquisitionProrationTier, computePoolMovement, computeRepairCapCheck, computeIntangibleAmortization,
} from './taxPoolCompute'
import { POOL_LABELS, POOL_EXAMPLES, POOL_RATES, DISCLAIMER_TEXT } from './taxPoolConstants'

const poolTip = pool => pool === 'E'
  ? POOL_EXAMPLES.E
  : `${POOL_EXAMPLES[pool]} — depreciated at ${Math.round(POOL_RATES[pool] * 100)}% a year under Nepal tax rules.`

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')
const POOLS_AD = ['A', 'B', 'C', 'D']

function fyOptionsAround(currentFyStart) {
  return [currentFyStart + 1, currentFyStart, currentFyStart - 1, currentFyStart - 2, currentFyStart - 3]
}

export default function TaxPoolTab({ assets }) {
  const { clientId, hasImsAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedDelete } = useScopedDb()

  const todayBs = getBsToday()
  const currentFyStart = getBsFiscalYearStart(todayBs.year, todayBs.month)
  const [fyStart, setFyStart] = useState(currentFyStart)
  const [repairExpenses, setRepairExpenses] = useState([])
  const [newExpense, setNewExpense] = useState({ pool: 'A', expense_date: '', amount: '', description: '' })
  const [lines, setLines] = useState(null)
  const [loading, setLoading] = useState(false)
  const [posting, setPosting] = useState(false)
  const [msg, setMsg] = useState('')

  const fyLabel = getBsFiscalYear(fyStart, 4)
  const canPost = hasImsAccess('manager')

  useEffect(() => { loadRepairExpenses() }, [fyStart]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadRepairExpenses() {
    const { data } = await scopedFrom('assets_repair_expenses').eq('fiscal_year', fyLabel).order('expense_date')
    setRepairExpenses(data || [])
  }

  const repairTotalsByPool = useMemo(() => {
    const totals = {}
    repairExpenses.forEach(e => { totals[e.pool] = (totals[e.pool] || 0) + parseFloat(e.amount) })
    return totals
  }, [repairExpenses])

  async function addExpense() {
    if (!newExpense.expense_date || !parseFloat(newExpense.amount) > 0) { setMsg('error:Date and a positive amount are required.'); return }
    const { error } = await scopedInsert('assets_repair_expenses', {
      pool: newExpense.pool, fiscal_year: fyLabel, expense_date: newExpense.expense_date,
      amount: parseFloat(newExpense.amount), description: newExpense.description.trim() || null,
    })
    if (error) { setMsg('error:' + error.message); return }
    setNewExpense({ pool: 'A', expense_date: '', amount: '', description: '' })
    loadRepairExpenses()
  }

  async function deleteExpense(id) {
    await scopedDelete('assets_repair_expenses').eq('id', id)
    loadRepairExpenses()
  }

  async function preview() {
    setLoading(true); setMsg('')
    const priorFyLabel = getBsFiscalYear(fyStart - 1, 4)
    const { data: priorRun } = await scopedFrom('assets_tax_pool_runs')
      .eq('fiscal_year', priorFyLabel).eq('status', 'posted')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    let priorLinesByPool = {}
    if (priorRun) {
      const { data: priorLines } = await scopedFrom('assets_tax_pool_lines').eq('run_id', priorRun.id)
      ;(priorLines || []).forEach(l => { priorLinesByPool[l.pool] = l })
    }

    const { start: fyStartAd, end: fyEndAd } = getFiscalYearAdRange(fyStart)
    const fyStartAdStr = formatAd(fyStartAd), fyEndAdStr = formatAd(fyEndAd)

    const poolLines = POOLS_AD.map(pool => {
      const prior = priorLinesByPool[pool]
      const openingWdv = prior ? prior.closing_wdv : 0
      const priorYearCapitalizedRepairExcess = prior ? prior.repair_expense_capitalized : 0

      let additionsFull = 0, additionsTwoThird = 0, additionsOneThird = 0
      assets.forEach(a => {
        if (a.tax_pool !== pool) return
        if (a.acquisition_date < fyStartAdStr || a.acquisition_date > fyEndAdStr) return
        const tier = acquisitionProrationTier({ acquisitionDate: a.acquisition_date, fiscalYearStartBs: fyStart })
        if (tier === 'full') additionsFull += a.total_cost
        else if (tier === 'two_third') additionsTwoThird += a.total_cost
        else if (tier === 'one_third') additionsOneThird += a.total_cost
      })

      const disposalProceeds = assets
        .filter(a => a.tax_pool === pool && a.status !== 'active' && a.disposal_date >= fyStartAdStr && a.disposal_date <= fyEndAdStr)
        .reduce((s, a) => s + (a.disposal_proceeds || 0), 0)

      const movement = computePoolMovement({
        pool, openingWdv, additionsFull, additionsTwoThird, additionsOneThird, disposalProceeds, priorYearCapitalizedRepairExcess,
      })
      const repairExpenseTotal = repairTotalsByPool[pool] || 0
      const repairCap = computeRepairCapCheck({ repairExpenseTotal, closingWdv: movement.closing_wdv })

      return {
        pool, opening_wdv: openingWdv, additions_full: additionsFull, additions_two_third: additionsTwoThird,
        additions_one_third: additionsOneThird, disposal_proceeds: disposalProceeds,
        repair_expense_total: repairExpenseTotal, repair_expense_deductible: repairCap.deductible,
        repair_expense_capitalized: repairCap.capitalizedExcess,
        depreciation_base: movement.depreciation_base, depreciation_amount: movement.depreciation_amount,
        closing_wdv: movement.closing_wdv,
      }
    })

    // Pool E — intangibles, straight-line per asset, not a shared-rate declining balance pool.
    // Aggregate: prior year's closing carried forward + this year's additions (at cost) minus
    // this year's total amortization across active Pool E assets.
    const priorE = priorLinesByPool.E
    let eAdditions = 0, eAmortization = 0
    assets.filter(a => a.tax_pool === 'E' && a.status === 'active').forEach(a => {
      const acquiredThisFy = a.acquisition_date >= fyStartAdStr && a.acquisition_date <= fyEndAdStr
      const { annual_amortization, first_year_amount } = computeIntangibleAmortization({
        cost: a.total_cost, usefulLifeYears: a.useful_life_years, acquisitionDate: a.acquisition_date, fiscalYearStartBs: fyStart,
      })
      if (acquiredThisFy) { eAdditions += a.total_cost; eAmortization += first_year_amount }
      else eAmortization += annual_amortization
    })
    const eOpening = priorE ? priorE.closing_wdv : 0
    const eClosing = Math.max(0, eOpening + eAdditions - eAmortization)
    poolLines.push({
      pool: 'E', opening_wdv: eOpening, additions_full: eAdditions, additions_two_third: 0, additions_one_third: 0,
      disposal_proceeds: 0, repair_expense_total: 0, repair_expense_deductible: 0, repair_expense_capitalized: 0,
      depreciation_base: eOpening + eAdditions, depreciation_amount: eAmortization, closing_wdv: eClosing,
    })

    setLines(poolLines)
    setLoading(false)
  }

  async function post() {
    if (!lines) return
    setPosting(true); setMsg('')
    const { error } = await supabase.rpc('post_tax_pool_run', {
      p_client_id: clientId, p_fiscal_year: fyLabel, p_lines: lines, p_notes: null,
    })
    setPosting(false)
    if (error) { setMsg('error:' + error.message); return }
    setMsg('ok:Posted — tax pool schedule locked for FY ' + fyLabel)
    setLines(null)
  }

  return (
    <div>
      <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 12, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        ⚠ {DISCLAIMER_TEXT}
      </div>

      <p className="no-print" style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6, marginBottom: 20, maxWidth: 760 }}>
        This tab is for your <strong style={{ color: 'var(--theme-text1)' }}>annual tax filing</strong> — hand it to your
        accountant, or use it yourself if you file directly. It's separate from the <strong style={{ color: 'var(--theme-text1)' }}>Depreciation Runs</strong> tab,
        which is for your own internal books and will show a different number — that's expected. Nepal's tax rules don't
        depreciate each item you own separately; instead every asset is grouped into one of five government-defined
        "pools" (hover any Pool name below for what belongs in it, in plain terms).
      </p>

      <div className="card no-print" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field">
            <label htmlFor="taxpoo-f1"><Tip text="Nepal's tax year runs mid-July to mid-July (Shrawan to Ashadh) — it doesn't line up with the Jan-Dec calendar year most people think in." width={280}>Fiscal Year</Tip></label>
            <select id="taxpoo-f1" className="form-select" value={fyStart} onChange={e => { setFyStart(parseInt(e.target.value)); setLines(null) }}>
              {fyOptionsAround(currentFyStart).map(y => <option key={y} value={y}>FY {getBsFiscalYear(y, 4)}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" onClick={preview} disabled={loading}>{loading ? 'Computing…' : 'Preview'}</button>
          {lines && (
            <Tip text={canPost ? 'Writes the pool schedule and locks it for this fiscal year — corrections need a new adjustment run.' : 'Only a Manager or Owner login can post.'} width={280}>
              <button className="btn btn-primary" onClick={post} disabled={!canPost || posting}>{posting ? 'Posting…' : 'Post'}</button>
            </Tip>
          )}
          {lines && (
            <button className="btn btn-ghost" onClick={() => printWithTitle(`Tax Depreciation Schedule - FY ${fyLabel}`)}>Print</button>
          )}
          {msg && <span style={{ fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>{msg.split(':').slice(1).join(':')}</span>}
        </div>
      </div>

      {/* Repair/maintenance expense ledger — feeds the Section 16 cap check */}
      <div className="card no-print" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 13, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
          <Tip text="Fixing or maintaining something you already own — e.g. servicing an oven, repainting, fixing a fridge compressor. Buying a brand new item is NOT a repair expense; that's a new asset in the Register tab instead." width={300}>Repair &amp; Maintenance Expenses</Tip> — FY {fyLabel}
        </h3>
        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 12px', lineHeight: 1.5 }}>
          Nepal tax law only lets you deduct repair costs up to 5% of what a pool is worth — spend more than that on
          repairs for one pool in a year, and the extra rolls into next year instead of counting this year.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 4 }}>
          <div className="form-field" style={{ gap: 4 }}>
            <label style={{ fontSize: 11 }} htmlFor="taxpoo-f2">Which pool was this equipment in?</label>
            <select id="taxpoo-f2" className="form-select" value={newExpense.pool} onChange={e => setNewExpense(f => ({ ...f, pool: e.target.value }))}>
              {POOLS_AD.map(p => <option key={p} value={p}>{POOL_LABELS[p]}</option>)}
            </select>
          </div>
          <input type="date" className="form-input form-input--auto" value={newExpense.expense_date} onChange={e => setNewExpense(f => ({ ...f, expense_date: e.target.value }))} />
          <input type="number" className="form-input" placeholder="Amount" value={newExpense.amount} onChange={e => setNewExpense(f => ({ ...f, amount: e.target.value }))} style={{ width: 120 }} />
          <input className="form-input" placeholder="Description" value={newExpense.description} onChange={e => setNewExpense(f => ({ ...f, description: e.target.value }))} style={{ flex: 1, minWidth: 160 }} />
          <button className="btn btn-ghost" onClick={addExpense}>+ Add</button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 12px', fontStyle: 'italic' }}>
          e.g. {POOL_EXAMPLES[newExpense.pool]}
        </p>
        {repairExpenses.length > 0 && (
          <div className="table-wrap">
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead><tr><th>Pool</th><th>Date</th><th style={{ textAlign: 'right' }}>Amount</th><th>Description</th><th></th></tr></thead>
              <tbody>
                {repairExpenses.map(e => (
                  <tr key={e.id}>
                    <td>{e.pool}</td><td>{e.expense_date}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(e.amount)}</td>
                    <td>{e.description || '—'}</td>
                    <td><button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => deleteExpense(e.id)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {lines && (
        <div id="tax-pool-print-area">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Pool</th>
                  <th style={{ textAlign: 'right' }}><Tip text="What this pool was worth at the start of the fiscal year — last year's Closing WDV carried forward, or 0 if this pool has never been used before." width={280}>Opening WDV</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Cost of anything new bought into this pool during the fiscal year (new equipment, furniture, vehicles, etc.)." width={260}>Additions</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Money received from selling or scrapping equipment in this pool during the fiscal year." width={260}>Disposals</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Repair/maintenance spend on this pool — the first number is what you can deduct this year (capped at 5% of Closing WDV); the second, if shown, is the extra that rolls into next year instead." width={300}>Repair (Deductible / Capitalized)</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="The tax-deductible depreciation for this pool this year, at Nepal's statutory rate for that pool." width={260}>Depreciation</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="What this pool is worth at the end of the fiscal year (WDV = Written-Down Value). Becomes next year's Opening WDV." width={280}>Closing WDV</Tip></th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => (
                  <tr key={l.pool}>
                    <td><Tip text={poolTip(l.pool)} width={300}>{POOL_LABELS[l.pool]}</Tip></td>
                    <td style={{ textAlign: 'right' }}>{fmt(l.opening_wdv)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(l.additions_full + l.additions_two_third + l.additions_one_third)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(l.disposal_proceeds)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {fmt(l.repair_expense_deductible)}{l.repair_expense_capitalized > 0 && ` / ${fmt(l.repair_expense_capitalized)}`}
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmt(l.depreciation_amount)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmt(l.closing_wdv)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                  <td>Total</td>
                  <td style={{ textAlign: 'right' }}>{fmt(lines.reduce((s, l) => s + l.opening_wdv, 0))}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(lines.reduce((s, l) => s + l.additions_full + l.additions_two_third + l.additions_one_third, 0))}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(lines.reduce((s, l) => s + l.disposal_proceeds, 0))}</td>
                  <td></td>
                  <td style={{ textAlign: 'right' }}>{fmt(lines.reduce((s, l) => s + l.depreciation_amount, 0))}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(lines.reduce((s, l) => s + l.closing_wdv, 0))}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div className="print-only" style={{ marginTop: 32, fontSize: 10, color: '#aaa', borderTop: '1px solid #eee', paddingTop: 12, textAlign: 'center' }}>
            {DISCLAIMER_TEXT} · Generated by Crest Suite · {new Date().toLocaleDateString('en-NP')}
          </div>
        </div>
      )}
    </div>
  )
}
