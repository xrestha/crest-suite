import { npr } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useSettings } from '../../../context/SettingsContext'
import { supabase } from '../../../supabaseClient'
import { firstError } from '../../../shared/queryError'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { computeRecipeCosts } from '../../../utils/recipeCost'
import { fcFigure, menuFcPct, recipeCostOf } from '../../../shared/imsFormulas'
import { errorInfo } from '../../../shared/errorText'
import Tip from '../../../components/Tip'
import ActionError from '../../../components/ActionError'
import ReportLoadError from '../../../components/ReportLoadError'
import SearchableSelect from '../../../components/SearchableSelect'
import { Link, Navigate } from 'react-router-dom'

const fmtNpr = npr
const WINDOW_OPTIONS = [30, 90, 180]

/**
 * Our own sentence as the headline, the library's sentence and the Postgres code as fine print.
 * `errorInfo` recognises database SHAPES; an English sentence we wrote matches no rule and would
 * come back as the generic fallback with our real text demoted (S715). Converting at the CALL
 * SITE, and never destroying the technical detail, is the S619 rule.
 */
function saveFailure(sentence, err) {
  const info = errorInfo(err, 'operator')
  return { text: sentence, detail: info.detail ? `${info.text} (${info.detail})` : info.text }
}

// vat_rate is a FRACTION on `recipes` (DEFAULT 0.13), and may legitimately be 0 for a No-VAT item;
// only null/undefined falls back. Same shape as MenuRepricing's own vatOf.
function vatOf(r) {
  return (r?.vat_rate === null || r?.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
}

export default function ComboBuilder() {
  // `posEnabled`, not clientModules.pos — CLAUDE.md: anything asking "does this client have POS"
  // reads posEnabled/hrEnabled. It resolves true for admin, which is right here: an operator
  // viewing a client should see the report rather than the module notice.
  const { clientId, posEnabled, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  const { scopedFrom } = useScopedDb()
  const pairReq = useLatestRequest()

  const [menu, setMenu] = useState([])
  const [costMap, setCostMap] = useState({})
  const [menuLoading, setMenuLoading] = useState(true)
  const [menuError, setMenuError] = useState(null)
  const [anchorId, setAnchorId] = useState('')
  const [days, setDays] = useState(90)
  const [pairs, setPairs] = useState([])
  const [anchorBills, setAnchorBills] = useState(0)
  const [pairsLoading, setPairsLoading] = useState(false)
  const [pairsError, setPairsError] = useState(null)
  const [discountPct, setDiscountPct] = useState(10)
  const [saveError, setSaveError] = useState(null)
  const settingsRowId = useRef(null)

  // The data behind this page is POS bills. `get_cooccurrence` reads pos_order_items/pos_orders and
  // nothing else, so an IMS-only client can pick an anchor, wait, and be told forever that it
  // "needs more bills with this item on them" — a sentence that describes a fixable shortage when
  // the real answer is that this client has no till. The route stays gated on IMS (decided with
  // Aashish, 2026-09-10: the feature is sold in the Growth IMS list and removing it would take it
  // off a plan people already bought); the page says what it needs instead of blaming the data.

  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    setMenuLoading(true)
    setMenuError(null)
    ;(async () => {
      const results = await Promise.all([
        scopedFrom('recipes', 'id, name, category, selling_price, vat_rate, cost_price')
          .eq('pos_enabled', true)
          // NULL-safe (S714) — see Menu Pricing. `.neq` on a nullable column drops NULL rows too.
          .or('category.is.null,category.neq.Sub-Recipe').order('name'),
        supabase.from('settings').select('id, combo_discount_pct').eq('client_id', clientId).maybeSingle(),
      ])
      // Every read on this page used to be `.then(([{ data }, { data }]) => …)` — no `error`
      // destructured anywhere and no `.catch()`. A failed recipes read left `menu` empty and
      // rendered "No POS-enabled items yet — toggle items on in Menu Pricing first", which is a
      // confident instruction to go and fix something that is not broken (S612/S619).
      const failed = firstError(results)
      if (cancelled) return
      if (failed) { setMenuError(failed); setMenuLoading(false); return }
      const [{ data: recs }, { data: settingsRow }] = results

      const list = recs || []
      setMenu(list)
      setAnchorId(prev => prev || list[0]?.id || '')
      settingsRowId.current = settingsRow?.id || null
      setDiscountPct(settingsRow?.combo_discount_pct ?? 10)

      // A combo is a discount, and a discount comes out of margin. This page suggested one with no
      // idea what either dish costs to make — so a 25% bundle of two dishes already running at 38%
      // food cost priced the pair past 50% FC while the row said "Savings" in green (S724).
      // computeRecipeCosts THROWS on a failed read (S695/S711); an uncosted menu is not an error,
      // so the FC% column simply shows — and the rest of the page still works.
      try {
        const ids = list.map(r => r.id)
        if (ids.length > 0) {
          const costs = await computeRecipeCosts(supabase, ids)
          if (!cancelled) setCostMap(costs)
        }
      } catch (err) {
        if (!cancelled) setMenuError(err)
      }
      if (!cancelled) setMenuLoading(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  const loadPairs = useCallback(async () => {
    if (!clientId || !anchorId) { setPairs([]); setAnchorBills(0); return }
    // Claim the page before the await (S601). Anchor and window are both one-click controls, so
    // two loads overlap easily and the last response to land used to win the table regardless of
    // which anchor was actually selected. Keyed on the pair, not a counter — see useLatestRequest.
    const key = `${anchorId}:${days}`
    pairReq.begin(key)
    setPairsLoading(true)
    setPairsError(null)
    const { data, error } = await supabase.rpc('get_cooccurrence', { p_client_id: clientId, p_recipe_id: anchorId, p_days: days })
    if (!pairReq.isCurrent(key)) return
    // The RPC RAISEs on an authorisation failure, and its error used to be dropped — so "not
    // authorized for this client" rendered as "No co-occurrence data yet … needs more bills".
    if (error) { setPairsError(error); setPairs([]); setAnchorBills(0); setPairsLoading(false); return }
    setPairs(data || [])
    setAnchorBills(Number(data?.[0]?.anchor_bills) || 0)
    setPairsLoading(false)
  }, [clientId, anchorId, days, pairReq])

  useEffect(() => { loadPairs() }, [loadPairs])

  async function saveDiscountPct(raw) {
    const pct = Math.max(0, Math.min(100, parseFloat(raw) || 0))
    setDiscountPct(pct)
    if (!clientId) return   // the admin "no client selected" window: client_id:null is the global-defaults row
    setSaveError(null)
    // This was the only `settings` writer in src/ with neither an error check nor an
    // insert-if-missing branch: `.update(...).eq('client_id', clientId)` on a client with no
    // settings row matches nothing and reports success, and an RLS refusal was equally silent —
    // the input kept the new value and reverted on the next visit with nothing said (S724).
    // The read-then-branch shape is PosTableManagement's, including its rule that a FAILED
    // existing-row read must not fall through into insert (S613) — that writes a second settings
    // row for the client and splits every settings read after it.
    let error = null
    let rowId = settingsRowId.current
    if (!rowId) {
      const { data: existing, error: existErr } = await supabase
        .from('settings').select('id').eq('client_id', clientId).maybeSingle()
      if (existErr) { setSaveError(saveFailure('The combo discount was not saved — your settings could not be read, so nothing was written.', existErr)); return }
      rowId = existing?.id || null
      settingsRowId.current = rowId
    }
    if (rowId) {
      ;({ error } = await supabase.from('settings').update({ combo_discount_pct: pct }).eq('id', rowId))
    } else {
      const { data: created, error: insErr } = await supabase
        .from('settings').insert({ client_id: clientId, combo_discount_pct: pct }).select('id').maybeSingle()
      error = insErr
      if (!insErr) settingsRowId.current = created?.id || null
    }
    // Never claims the write did not land (S619): a response lost after the server committed does
    // not prove the row is unchanged. `settings` is one row per client, so re-saving is safe either
    // way — which is what the sentence tells the reader to do.
    if (error) setSaveError(saveFailure(`The combo discount may not have been saved — the prices below still use ${pct}%. Reopen this page to see what was stored, and set it again if it did not stick.`, error))
  }

  const menuById = Object.fromEntries(menu.map(r => [r.id, r]))
  const anchor = menuById[anchorId]

  const rows = pairs
    .map(p => ({ paired_recipe_id: p.paired_recipe_id, coCount: Number(p.co_count), recipe: menuById[p.paired_recipe_id] }))
    .filter(p => p.recipe) // a paired recipe may have since gone inactive/off-POS — don't suggest it
    .sort((a, b) => b.coCount - a.coCount)

  const menuOptions = menu.map(r => ({ value: r.id, label: `${r.name}${r.category ? ` (${r.category})` : ''}` }))

  // The whole page is one combo discount applied to pairs of the anchor, so the anchor's own cost
  // is resolved once. `recipeCostOf` returns null when nothing has costed the dish — carried all
  // the way to the cell rather than collapsed to a 0 that `fcBand` would paint green.
  const anchorCost = anchor ? recipeCostOf(costMap, anchor) : null

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">
          Combo Builder{' '}
          <Tip text="Shows which items are actually ordered together most often on real paid POS bills (last N days) and suggests a discounted combo price. Insight-only — pick a pairing you like, then create the priced bundle yourself in Menu Pricing." width={320}>ⓘ</Tip>
        </h1>
        <p className="page-subtitle">
          What actually sells together — and what to charge if you bundle it.
        </p>
      </div>

      {menuError && <ReportLoadError error={menuError} />}
      {saveError && <ActionError error={saveError} />}

      {!posEnabled && (
        <div className="card" style={{ padding: 16, marginBottom: 20, borderLeft: '3px solid var(--theme-amber)' }}>
          <strong style={{ display: 'block', marginBottom: 4, fontSize: 13 }}>This report reads POS bills</strong>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
            Which items are ordered together can only be seen from bills that were rung up on a till, so Combo Builder
            needs the Crest POS module. Without it this page has nothing to read — that is not a shortage of sales
            history, and no amount of waiting will fill it in. Talk to Crest about adding POS to see pairings here.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        <div style={{ minWidth: 260 }}>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="combob-f1">
            <Tip text="The item to find pairings for — results show what's most often ordered alongside it." width={240}>Anchor Item</Tip>
          </label>
          <SearchableSelect id="combob-f1" value={anchorId} onChange={setAnchorId} options={menuOptions} placeholder="Select an item…" />
        </div>
        <div>
          <span style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Window</span>
          <div role="group" aria-label="Look-back window" className="tab-bar" style={{ marginBottom: 0 }}>
            {WINDOW_OPTIONS.map(d => (
              <button key={d} aria-pressed={days === d} className={`tab-btn${days === d ? ' tab-btn--active' : ''}`} onClick={() => setDays(d)}>{d}d</button>
            ))}
          </div>
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="combob-f2">
            <Tip text="Discount applied to the combined price when you bundle two items — used to compute the suggested combo price below. Saved per client." width={260}>Combo Discount %</Tip>
          </label>
          <input id="combob-f2"
            type="number" min="0" max="100" step="1" value={discountPct}
            onChange={e => setDiscountPct(e.target.value)}
            onBlur={e => saveDiscountPct(e.target.value)}
            className="form-input" style={{ width: 80 }}
          />
        </div>
      </div>

      {menuError ? null : menuLoading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading menu…</p>
      ) : menu.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          No POS-enabled items yet — toggle items on in Menu Pricing first.
        </div>
      ) : pairsError ? (
        <ReportLoadError error={pairsError} />
      ) : pairsLoading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading pairings…</p>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          {posEnabled
            ? <>No co-occurrence data yet for {anchor?.name || 'this item'} in the last {days} days — needs more paid bills with this item on them.</>
            : <>Nothing to show — pairings come from paid POS bills, and this client has no POS module.</>}
        </div>
      ) : (
        <>
          {anchorBills > 0 && (
            <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 10px' }}>
              {anchor?.name} appeared on <strong style={{ color: 'var(--theme-text1)' }}>{anchorBills.toLocaleString('en-IN')}</strong> paid
              {anchorBills === 1 ? ' bill' : ' bills'} in the last {days} days. Frequency below is the share of those bills that also had the paired item.
            </p>
          )}
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Paired With</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="How many paid bills in this window had both items on them. Counts bills, not lines — a bill where one item was part-comped is still one bill." width={280}>Bills Together</Tip>
                  </th>
                  <th>
                    <Tip text={`Share of ${anchor?.name || 'the anchor item'}'s own bills that also had this item.`} width={260}>Frequency</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>Combined Price</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text={`Combined price less ${discountPct}%, grossed up for VAT and rounded up to NPR 5 — the number to print. Suggestion only; nothing is created.`} width={280}>Suggested Combo Price</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>Savings</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="What the bundle's food cost would be as a share of the discounted, ex-VAT combo price. A discount comes out of margin, so this is the number that says whether the combo is still worth selling. Banded against your own thresholds in Settings → Thresholds." width={340}>Combo FC%</Tip>
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(p => {
                  const anchorPrice = parseFloat(anchor?.selling_price) || 0
                  const pairPrice = parseFloat(p.recipe.selling_price) || 0
                  const combined = anchorPrice + pairPrice
                  const comboExVat = combined * (1 - discountPct / 100)
                  const savings = combined - comboExVat
                  // The one page in this module that suggests a price and did NOT round it, while
                  // its sibling Menu Repricing has rounded up to NPR 5 VAT-inclusive since it
                  // shipped "because it is the number to print on the menu". It also quoted the
                  // figure ex-VAT, so it was not what a guest would pay either. getSuggestedPrice
                  // does both, given a cost and the FC% target that reproduces this discount.
                  const vat = vatOf(anchor)
                  const comboMenuPrice = Math.ceil((comboExVat * (1 + vat)) / 5) * 5
                  const pairCost = recipeCostOf(costMap, p.recipe)
                  const comboCost = (anchorCost == null || pairCost == null) ? null : anchorCost + pairCost
                  // Measured against the ROUNDED price taken back to ex-VAT — the price actually
                  // being suggested, not the unrounded one behind it.
                  const comboFc = menuFcPct(comboCost, comboMenuPrice / (1 + vat))
                  const fcFig = fcFigure(comboFc, settings)
                  const pct = anchorBills > 0 ? Math.min(100, (p.coCount / anchorBills) * 100) : 0
                  return (
                    <tr key={p.paired_recipe_id}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                        {p.recipe.name}
                        {p.recipe.category && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-text3)' }}>{p.recipe.category}</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>{p.coCount}</td>
                      {/* Frequency needs `anchor_bills`, which arrives with migration
                          20260910120000. Until that is applied the RPC returns two columns and
                          this is 0 — so the cell says it cannot show the share rather than
                          drawing an empty track for every row, which reads as "never happens". */}
                      <td style={{ minWidth: 120 }}>
                        {anchorBills > 0 ? (
                          <>
                            <div style={{ background: 'var(--theme-input-bg)', borderRadius: 'var(--radius-xs)', height: 8, overflow: 'hidden' }}>
                              <div style={{ width: `${pct}%`, height: '100%', background: 'var(--theme-accent)' }} />
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{pct.toFixed(0)}%</span>
                          </>
                        ) : (
                          <span style={{ color: 'var(--theme-text3)' }} title="Needs the anchor item's own bill count, which this database has not returned">—</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>{fmtNpr(combined)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)' }}>{fmtNpr(comboMenuPrice)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>−{fmtNpr(savings)}</td>
                      <td style={{ textAlign: 'right', fontWeight: comboFc != null ? 700 : 400, ...fcFig.style }}
                          title={fcFig.title || 'One or both dishes have no food cost recorded, so the bundle cannot be costed'}>
                        {fcFig.text}
                      </td>
                      <td>
                        {/* A plain <a> reloaded the whole SPA — bundle refetch, contexts rebuilt. */}
                        <Link to="/menu-pricing" style={{ fontSize: 12, color: 'var(--theme-accent-ink)', whiteSpace: 'nowrap' }}>Create as Menu Item →</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
