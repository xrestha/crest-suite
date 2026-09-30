import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import ActionError, { asActionError } from '../../../components/ActionError'
import { readItemRefCounts, PRICE_CHANGE_KEEPS } from './itemRefTables'
import { unitRateText } from '../../../shared/unitRate'
import {
  vatCostPriceReview, reviewImpactSentence, reviewSignature, REVIEW_PERIODS,
} from './vatCostPriceReview'

// S792 (owner decision D32): a one-time review of Item Master prices on the wrong VAT basis, modelled
// on PanPriceBanner (recipes). On a PAN-bill outlet the VAT on a VAT bill is food cost, so an item's
// price should be what was PAID — its latest VAT bill's rate × 1.13. Items priced before D32 still
// hold the ex-VAT rate, which values stock 13% low against purchases now valued at the paid price.
// The reverse after the outlet registers for VAT ("remove the 13%"). The arithmetic and the list are
// vatCostPriceReview.js; this reads the recent bill lines, shows the list and writes on a confirm
// that names what re-values (D5). Nothing is changed for the owner without that press.
//
// Hidden when the list is empty, while the outlet's VAT status is unknown, and after "Not now" until
// the list changes (a per-viewer convenience in localStorage — never needed for correctness).

const SHOW = 6
const dismissKey = clientId => `crest.vatCostPriceReview.${clientId}`

function readDismissed(clientId) {
  try { return window.localStorage.getItem(dismissKey(clientId)) } catch { return null }
}
function writeDismissed(clientId, sig) {
  try { window.localStorage.setItem(dismissKey(clientId), sig) } catch { /* private window: shows again next time */ }
}

export default function VatCostPriceBanner({ items, clientId, vatMode, canUpdate, askConfirm, onUpdated }) {
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const [lines, setLines] = useState(null)
  const [periodRank, setPeriodRank] = useState(null)
  const [dismissed, setDismissed] = useState(() => (clientId ? readDismissed(clientId) : null))
  const [error, setError] = useState(null)

  // The last few months' priced bill lines — enough to find each item's latest one. A failed read
  // shows nothing: this is an optional review, and a list built off a failed read would be a guess.
  useEffect(() => {
    let live = true
    setLines(null); setPeriodRank(null); setDismissed(clientId ? readDismissed(clientId) : null)
    if (!clientId || (vatMode !== 'pan' && vatMode !== 'vat')) return undefined
    ;(async () => {
      const { data: periods, error: pErr } = await scopedFrom('monthly_periods', 'id, bs_year, bs_month')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }).limit(REVIEW_PERIODS)
      if (!live) return
      if (pErr) { console.error('VAT price review: periods could not be read', pErr); return }
      const ids = (periods || []).map(p => p.id)
      if (ids.length === 0) return
      const { data, error: lErr } = await fetchAllRows(() => supabase.from('purchase_entries')
        .select('id, item_id, rate, vat_inclusive, vat_is_cost, period_id, bs_day, created_at')
        .in('period_id', ids).gt('rate', 0).order('id'))
      if (!live) return
      if (lErr) { console.error('VAT price review: bill lines could not be read', lErr); return }
      const rank = new Map((periods || []).map(p => [p.id, p.bs_year * 100 + p.bs_month]))
      setPeriodRank(rank)
      setLines(data || [])
    })()
    return () => { live = false }
  }, [clientId, vatMode, scopedFrom])

  const rows = useMemo(
    () => (lines && periodRank ? vatCostPriceReview({ items, lines, periodRank, mode: vatMode }) : []),
    [items, lines, periodRank, vatMode],
  )
  const signature = reviewSignature(rows)

  if (!rows.length || dismissed === signature) return null

  const adding = vatMode === 'pan'
  const n = rows.length
  const head = rows.slice(0, SHOW)
  const rest = rows.slice(SHOW)

  async function update() {
    setError(null)
    const ids = rows.map(r => r.id)
    const { data: counts, error: countErr } = await readItemRefCounts(supabase, ids)
    const impact = reviewImpactSentence(countErr ? null : counts, ids, { complete: !countErr })
    askConfirm({
      title: adding ? `Update ${n} item price${n === 1 ? '' : 's'} to the price you paid?` : `Take the 13% VAT off ${n} item price${n === 1 ? '' : 's'}?`,
      confirmLabel: `Update ${n} item${n === 1 ? '' : 's'}`,
      body: (
        <p style={{ margin: 0 }}>
          {adding
            ? `Each price becomes its latest VAT bill's rate plus the 13% VAT, which this outlet cannot claim back.`
            : `Each price becomes its latest VAT bill's rate before VAT, now that this outlet claims the VAT back.`}
          {impact ? ` ${impact}` : ''} {PRICE_CHANGE_KEEPS}
        </p>
      ),
      run: async () => {
        const results = await Promise.all(rows.map(r =>
          scopedUpdate('items', { rate: r.suggestedRate }).eq('id', r.id).select('id')
            .then(res => ({ row: r, error: res.error, none: !res.error && !res.data?.length }))))
        const failed = results.filter(x => x.error || x.none)
        const landed = results.length - failed.length
        if (failed.length) {
          const refusal = failed.find(f => f.error)
          const { text, detail } = refusal
            ? asActionError(refusal.error)
            : { text: 'Your login may not be allowed to change Item Master prices — ask your manager or the Owner.', detail: undefined }
          setError({ text: `${landed > 0 ? `${landed} updated. ` : ''}Item Master still holds the old price for ${failed.map(f => f.row.name).join(', ')}. ${text}`, detail })
        }
        await onUpdated?.()
      },
    })
  }

  function line(r) {
    return (
      <li key={r.id}>
        <strong style={{ color: 'var(--theme-text1)' }}>{r.name}</strong>: Item Master {unitRateText(r.currentRate, r.uom)}, {adding ? 'you paid' : 'before VAT'} {unitRateText(r.suggestedRate, r.uom)}
      </li>
    )
  }

  return (
    <div role="note" className="no-print" style={{
      marginBottom: 16, padding: '10px 14px', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text2)',
      border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)',
      background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{ fontWeight: 600, color: 'var(--theme-amber-text)', marginBottom: 4 }}>
        △ {n} item price{n === 1 ? ' is' : 's are'} {adding ? 'missing the VAT you paid' : 'still carrying 13% VAT'}
      </div>
      <div>
        {adding
          ? `This outlet gives PAN bills (it is not VAT-registered), so the 13% VAT on a VAT bill cannot be claimed back — it is part of what the food cost. ${n === 1 ? 'This item still holds' : 'These items still hold'} the price before VAT from ${n === 1 ? 'its' : 'their'} latest bill, so stock, wastage and recipes are valued 13% below what you paid.`
          : `This outlet is now VAT-registered and claims the VAT on its bills back, but ${n === 1 ? 'this item still holds' : 'these items still hold'} a price with the 13% added, so stock, wastage and recipes are valued 13% above the bills.`}
        {' '}Nothing has been changed for you. Confirm the treatment with your accountant.
      </div>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{head.map(line)}</ul>
      {rest.length > 0 && (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: 'pointer' }}>{rest.length} more</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{rest.map(line)}</ul>
        </details>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {canUpdate && (
          <button type="button" className="btn btn-primary btn-sm" onClick={update}>
            {adding ? 'Update to the price you paid' : 'Remove the 13%'}
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { writeDismissed(clientId, signature); setDismissed(signature) }}>
          Not now
        </button>
      </div>
      {!canUpdate && <div style={{ marginTop: 6 }}>Only a supervisor, manager or the Owner can change Item Master prices.</div>}
      <ActionError error={error} />
    </div>
  )
}
