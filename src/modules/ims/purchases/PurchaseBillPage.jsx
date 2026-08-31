import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { BS_MONTHS, formatBsDay } from '../../../utils/bsCalendar'
import { printWithTitle } from '../../../utils/printTitle'
import PeriodScope from '../../../components/PeriodScope'
import { readPageCache, writePageCache } from '../../../shared/sessionDataCache'
import { getCf, fmtRate } from './purchasesHelpers'
import PurchaseBillForm from './PurchaseBillForm'
import PurchaseBillPrint from './PurchaseBillPrint'

// Add / Edit Purchase Bill, as a route rather than the <Modal maxWidth={1160}> it was until S647.
//
// This page owns three things the form does not: which bill it is (routing + loading), and the two
// things that happen AFTER a save — the auto-printed voucher and the "rate differs from Item
// Master" prompt. Both used to live on Purchases.js because that is where the modal was mounted;
// they belong with the save that triggers them, and moving them here is what lets the list page go
// back to being only a list.
//
// Two entry points:
//   /purchases/new?period=<id>   — period comes from whichever the list page had selected, so an
//                                  admin adding to a past month lands in that month, not the open
//                                  one. Falls back to the open period when absent (a bare URL).
//   /purchases/:groupId/edit     — the period is read off the bill's own rows; nothing to pass.
export default function PurchaseBillPage() {
  const { clientId, profile, loading: authLoading, isAdmin, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const navigate = useNavigate()
  const { groupId } = useParams()
  const [searchParams] = useSearchParams()
  const isEdit = !!groupId

  // Seeded from the list page's own cache sections — same page key, same client — so arriving from
  // Purchases paints the form immediately instead of blanking while three reference reads land.
  // Read-only here: this page never writes `periods`/`vendors` back, and only writes `items` when
  // it actually changes one (applyRateUpdates), which is the same write the modal used to do.
  const [periods, setPeriods] = useState(() => readPageCache('purchases', 'periods', effectiveClientId) ?? [])
  const [items, setItems]     = useState(() => readPageCache('purchases', 'items', effectiveClientId) ?? [])
  const [vendors, setVendors] = useState(() => readPageCache('purchases', 'vendors', effectiveClientId) ?? [])
  const [editingEntries, setEditingEntries] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // Company letterhead for the auto-printed voucher — same source fields the payslip print uses.
  const [bizInfo, setBizInfo] = useState({ name: '', address: '', vatNumber: '' })
  const [printBill, setPrintBill] = useState(null)
  const [rateUpdateItems, setRateUpdateItems]       = useState([])
  const [rateUpdateSelected, setRateUpdateSelected] = useState(new Set())

  useEffect(() => { if (!authLoading && effectiveClientId) load() }, [clientId, groupId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!effectiveClientId) return
    Promise.all([
      supabase.from('clients').select('name').eq('id', effectiveClientId).single(),
      supabase.from('settings').select('property_address, vat_number').eq('client_id', effectiveClientId).maybeSingle(),
    ]).then(([{ data: client }, { data: settings }]) => {
      setBizInfo({ name: client?.name || '', address: settings?.property_address || '', vatNumber: settings?.vat_number || '' })
    })
  }, [effectiveClientId])

  async function load() {
    const [{ data: p, error: pErr }, { data: i, error: iErr }, { data: v, error: vErr }] = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('items', '*, categories(name)').eq('is_active', true).eq('is_sub_recipe', false).order('name'),
      scopedFrom('vendors').eq('is_active', true).order('name'),
    ])
    // A failed read here is not an empty item list — it is a form that would silently offer no
    // items to bill and no vendor to bill them to (the report-pages rule, applied to an entry
    // screen). Say so instead of rendering an empty picker.
    const readErr = pErr || iErr || vErr
    if (readErr) { setLoadError(readErr.message); setLoading(false); return }
    setPeriods(p || [])
    setItems(i || [])
    setVendors(v || [])

    if (isEdit) {
      // A bill is `purchase_group_id`, except on legacy rows written before grouping existed,
      // where the group key IS the single entry's own id — the same `p.purchase_group_id || p.id`
      // the list page keys its rows by. Match both, then narrow in JS so an id that happens to
      // collide with another bill's group cannot pull in a foreign line.
      const { data: rows, error: eErr } = await supabase
        .from('purchase_entries')
        .select('*')
        .or(`purchase_group_id.eq.${groupId},id.eq.${groupId}`)
        .order('created_at').order('id')
      if (eErr) { setLoadError(eErr.message); setLoading(false); return }
      const mine = (rows || []).filter(r => (r.purchase_group_id || r.id) === groupId)
      if (mine.length === 0) { setLoadError('That bill no longer exists. It may have been deleted.'); setLoading(false); return }
      // A bill id is now typeable in the URL, which the in-memory filter this replaced could not
      // be. `purchases_select` scopes a client login through monthly_periods.client_id, so a real
      // client cannot read a sibling tenant's bill — but it also passes `is_admin()`, so an admin
      // viewing client A could load client B's bill and save into it. The period list above is
      // scoped, so requiring the bill's period to be in it is the same tenant check the list page
      // got for free by only ever offering rows it had already loaded.
      if (!(p || []).some(x => x.id === mine[0].period_id)) {
        setLoadError('That bill belongs to a different client than the one currently selected.')
        setLoading(false); return
      }
      setEditingEntries(mine)
    }
    setLoading(false)
  }

  const itemOptions = useMemo(
    () => items.map(i => ({ value: i.id, label: `${i.name}${i.categories?.name ? ` (${i.categories.name})` : ''}` })),
    [items]
  )

  // Edit resolves its period from the bill itself; new takes it from the list page's selection,
  // falling back to the open period so a bare /purchases/new still works.
  const period = useMemo(() => {
    if (isEdit) return editingEntries?.length ? periods.find(p => p.id === editingEntries[0].period_id) || null : null
    const requested = searchParams.get('period')
    return (requested && periods.find(p => p.id === requested)) || periods.find(p => p.status === 'open') || null
  }, [isEdit, editingEntries, periods, searchParams])

  const periodLabel = period ? `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : ''
  const isLocked = !isAdmin && period?.status === 'closed'
  // Back to the list ON THIS BILL'S OWN MONTH. A bare /purchases selects the OPEN period, so an
  // admin who has just filed a missed bill into a closed month would land on the current one and
  // not see what they entered — the single most confusing possible outcome of that workflow.
  const listUrl = period ? `/purchases?period=${period.id}` : '/purchases'

  // ─── AFTER THE SAVE ──────────────────────────────────────

  // Auto-print a new bill's voucher right after save (not on edits — see feedback captured during
  // S404+1 design discussion) so it can be stapled to the vendor's physical bill for approval.
  // `after` runs once the print dialog has closed and the voucher is unmounted: on a route we must
  // not navigate away before that, or the node being printed disappears mid-dialog.
  function printPurchaseBill(header, validLines, after) {
    const vendor = vendors.find(v => v.id === header.vendor_id)
    setPrintBill({ header, lines: validLines, vendorName: vendor?.name || '' })
    setTimeout(() => {
      printWithTitle(`Purchase Voucher - ${vendor?.name || 'No Vendor'} - ${formatBsDay(header.bs_day, period?.bs_month) || periodLabel} ${period?.bs_year || ''}`.trim())
      setPrintBill(null)
      after?.()
    }, 60)
  }

  // Compare both sides in the SAME unit the bill's rate box uses — per base unit, or per purchase
  // unit where the item has a conversion. Comparing against items.rate only worked while that
  // column happened to hold a per-unit figure; it is now always per BASE unit (items are stored in
  // their smallest unit), which a conversion item's rate box is not. An exact !== on floats also
  // re-fired this prompt on rates that had not moved.
  // One .in() read for every line's item, not one .single() per line — a 20-line bill was paying
  // 20 serial round trips here, after the save had already visibly completed.
  async function detectRateChanges(validLines) {
    const { data: freshItems } = await supabase.from('items')
      .select('id, name, uom, per_uom_rate, purchase_unit, conversion_factor')
      .in('id', [...new Set(validLines.map(l => l.item_id))])
    const freshById = new Map((freshItems || []).map(i => [i.id, i]))
    const changed = []
    for (const l of validLines) {
      const capturedRate = parseFloat(l.rate)
      const fi = freshById.get(l.item_id)
      if (!fi) continue
      const cf = getCf(fi)
      const masterRate = (parseFloat(fi.per_uom_rate) || 0) * cf
      if (Math.abs(capturedRate - masterRate) > 0.000001) {
        changed.push({
          itemId: fi.id, itemName: fi.name, cf,
          unit: cf > 1 ? (fi.purchase_unit || fi.uom) : fi.uom,
          baseUom: fi.uom,
          oldRate: masterRate, newRate: capturedRate,
        })
      }
    }
    return changed
  }

  // The save is done; what is left is a print that may still be on screen and a prompt that may
  // still be owed. Both are optional, so neither can be the thing that decides when to leave —
  // a two-sided barrier is. Leaving early would cancel the print dialog or drop the prompt.
  async function handleBillSaved(header, validLines) {
    const wasNew = !isEdit
    let printDone = !wasNew
    let changed = null
    const exitWhenReady = () => {
      if (!printDone || changed === null) return
      if (changed.length > 0) {
        setRateUpdateItems(changed)
        setRateUpdateSelected(new Set(changed.map(i => i.itemId)))
      } else {
        navigate(listUrl)
      }
    }
    if (wasNew) printPurchaseBill(header, validLines, () => { printDone = true; exitWhenReady() })
    changed = await detectRateChanges(validLines)
    exitWhenReady()
  }

  // items.rate is the price of ONE base unit (purchase_qty is always 1), so a rate typed against a
  // purchase unit has to come back down by the conversion factor before it lands. Writing the
  // entered figure raw put a per-CTN price in the column every valuation reads as per-BTL.
  const toPerBase = r => parseFloat((r.newRate / (r.cf || 1)).toFixed(6))

  async function applyRateUpdates() {
    const toUpdate = rateUpdateItems.filter(i => rateUpdateSelected.has(i.itemId))
    await Promise.all(toUpdate.map(i => supabase.from('items').update({ rate: toPerBase(i) }).eq('id', i.itemId)))
    // Write the list page's cached `items` through as well. It seeds its state from this cache on
    // mount, so skipping it would show the pre-update rate on the page we are about to return to.
    const next = items.map(i => {
      const upd = toUpdate.find(r => r.itemId === i.id)
      return upd ? { ...i, rate: toPerBase(upd), per_uom_rate: toPerBase(upd) } : i
    })
    setItems(next)
    writePageCache('purchases', 'items', effectiveClientId, next)
    setRateUpdateItems([])
    setRateUpdateSelected(new Set())
    navigate(listUrl)
  }

  // ─── RENDER ──────────────────────────────────────────────

  if (authLoading) return null
  // Same guard /purchases carries. A sub-route is reachable by URL on its own, so the parent
  // page's guard protects nothing here (CLAUDE.md: "a page reachable by URL needs the guard its
  // nav item implies").
  if (!hasImsAccess('staff')) return <Navigate to="/dashboard" replace />

  const backToList = () => navigate(listUrl)

  return (
    <>
    <div className={printBill ? 'no-print' : ''}>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">{isEdit ? 'Edit Purchase Bill' : 'Add Purchase Bill'}</h1>
          <p className="page-subtitle">One vendor bill, any number of line items</p>
          {periodLabel && (
            <div className="page-scope-row">
              {/* A bill BELONGS to a period rather than reporting on one, so the chip states which
                  month it posts into — the thing easiest to get wrong when this form is reached by
                  URL from a closed month (see the closed-period banner this page already carries). */}
              <PeriodScope label={periodLabel} status={period?.status} />
            </div>
          )}
        </div>
        <button className="btn btn-ghost" onClick={backToList}>← Purchases</button>
      </div>

      {/* Admin counterpart of the isLocked read-only state below. `isLocked` carves admin out of
          the closed-period lock — which is what allows a missed bill to be filed into the month it
          actually belongs to — but without this the form looks identical to one against the open
          month, and a bill dated to a closed month is exactly the mistake worth being loud about.
          Mirrors the same banner on the list page. */}
      {isAdmin && !loading && !loadError && period?.status === 'closed' && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-amber-text)' }}>
          ✎ <strong>{periodLabel} is closed — this bill saves into a closed month.</strong> That is deliberate for a bill that was
          missed at the time. Regenerate that month's Monthly Report afterwards so its figures include it.
        </div>
      )}

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
        ) : loadError ? (
          <div className="empty-state">
            <div className="empty-state-icon">⚠</div>
            <p className="empty-state-text">This bill could not be opened. Nothing has been changed.</p>
            <p style={{ color: 'var(--theme-text3)', fontSize: 12, marginTop: 6 }}>{loadError}</p>
            <button className="btn btn-ghost" style={{ marginTop: 14 }} onClick={backToList}>Back to Purchases</button>
          </div>
        ) : !period ? (
          <div className="empty-state">
            <div className="empty-state-icon">📅</div>
            <p className="empty-state-text">No period to bill against. Open a month in Periods first.</p>
            <button className="btn btn-ghost" style={{ marginTop: 14 }} onClick={backToList}>Back to Purchases</button>
          </div>
        ) : isLocked ? (
          <div className="empty-state">
            <div className="empty-state-icon">🔒</div>
            <p className="empty-state-text">{periodLabel} is closed, so its purchases are read-only. Contact your admin to re-open it.</p>
            <button className="btn btn-ghost" style={{ marginTop: 14 }} onClick={backToList}>Back to Purchases</button>
          </div>
        ) : (
          // Keyed on the bill. The form seeds its header/line state in useState initialisers, which
          // run once per mount — so navigating straight from one bill's edit URL to another's (back
          // button, command palette, a pasted link) would otherwise leave bill A's lines on screen
          // under bill B's id, and save them into B. The key forces a remount instead.
          <PurchaseBillForm
            key={isEdit ? groupId : `new-${period.id}`}
            period={period}
            items={items}
            itemOptions={itemOptions}
            vendors={vendors}
            editingGroupId={isEdit ? groupId : null}
            editingEntries={editingEntries}
            onClose={backToList}
            onSaved={handleBillSaved}
          />
        )}
      </div>

      {/* Rate update prompt */}
      {rateUpdateItems.length > 0 && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.72)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: 'var(--theme-card)', border: '1px solid rgba(201,168,76,0.3)', borderRadius: 'var(--radius-md)', padding: '24px 28px', maxWidth: 520, width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 4 }}>📦 Rate changes detected</div>
            <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginBottom: 16 }}>Select items to update in the Item Master. This affects recipe costing going forward.</div>

            {/* Select all */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--theme-text3)', marginBottom: 10, cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox"
                checked={rateUpdateSelected.size === rateUpdateItems.length}
                onChange={e => setRateUpdateSelected(e.target.checked ? new Set(rateUpdateItems.map(i => i.itemId)) : new Set())} />
              Select all ({rateUpdateItems.length} item{rateUpdateItems.length !== 1 ? 's' : ''})
            </label>

            {/* Item rows */}
            <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 20 }}>
              {rateUpdateItems.map(item => (
                <label key={item.itemId} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--theme-bg)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox"
                    checked={rateUpdateSelected.has(item.itemId)}
                    onChange={e => {
                      const next = new Set(rateUpdateSelected)
                      e.target.checked ? next.add(item.itemId) : next.delete(item.itemId)
                      setRateUpdateSelected(next)
                    }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.itemName}</div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>
                      Item Master will hold NPR {fmtRate(toPerBase(item))} per {item.baseUom}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 13 }}>
                    <span style={{ color: 'var(--theme-red-text)', fontWeight: 600 }}>NPR {fmtRate(item.oldRate)}</span>
                    <span style={{ color: 'var(--theme-text2)' }}> → </span>
                    <span style={{ color: 'var(--theme-green-text)', fontWeight: 600 }}>NPR {fmtRate(item.newRate)}</span>
                    <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 1 }}>per {item.unit}</div>
                  </div>
                </label>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-primary" style={{ fontSize: 12, padding: '7px 16px' }}
                onClick={applyRateUpdates} disabled={rateUpdateSelected.size === 0}>
                Update {rateUpdateSelected.size} item{rateUpdateSelected.size !== 1 ? 's' : ''}
              </button>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '7px 16px' }}
                onClick={() => { setRateUpdateItems([]); setRateUpdateSelected(new Set()); navigate(listUrl) }}>
                Skip all
              </button>
            </div>
          </div>
        </div>
      )}
    </div>

      {/* Print-only purchase voucher — see printPurchaseBill(); mounted only for the brief
          setTimeout window it takes to fire the browser print dialog, then unmounted. */}
      {printBill && (
        <div className="print-only">
          <PurchaseBillPrint
            header={printBill.header}
            lines={printBill.lines}
            items={items}
            vendorName={printBill.vendorName}
            period={period}
            bizInfo={bizInfo}
            enteredBy={profile?.full_name || profile?.email || ''}
          />
        </div>
      )}
    </>
  )
}
