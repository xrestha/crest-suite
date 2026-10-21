import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useConfirm } from '../../shared/hooks/useConfirm'
import { supabase } from '../../supabaseClient'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { withTimeout, settleWithin } from '../../utils/withTimeout'
import { npr, nprPaisa } from '../../shared/nepalMoney'
import Tip from '../../components/Tip'
import Fab from '../../components/Fab'
import RowMenu from '../../components/RowMenu'
import ReportLoadError from '../../components/ReportLoadError'
import ActionError, { asActionError } from '../../components/ActionError'
import { vatModeOf } from '../ims/recipes/menuPriceVat'
import { standaloneGuestPrice } from './comboPricing'
import {
  assembleCombos, pickSummary, isSetMeal, isComboDish, emptyCombo, editorFromCombo, prefillFromDishes,
} from './comboEditor'
import ComboEditorModal from './ComboEditorModal'

// Crest Customization release 2 (S839, docs/pos-combos.md) — Combos.
//
// A combo is sold at one price and is made of picks, each one dish from a short list. Each dish of a
// sold combo is its own bill line carrying a share of the price, so it prints at its own station,
// takes its own stock and counts as that dish in every report; the bill prints the combo as one line.
//
// Who: the same set as Option Groups — admin, the Owner, a POS manager or an IMS manager, tested on
// the raw pos_role / ims_role columns as OptionGroups.jsx does. save_pos_combo refuses everyone else
// (option_edit_rank), so the guard here only keeps a page from offering a save that will fail.
//
// Writes go through save_pos_combo / delete_pos_combo only: the tables refuse a direct write, and the
// RPC keeps a combo whole (its picks and dishes in one transaction). Hide and "QR menu" on the list
// re-send the saved combo with one flag changed.
//
// Combo Builder hands a pairing over as ?new=1&dishes=<id>,<id>&price=<suggested guest price>; the
// page opens a new combo with one pick per dish, then drops the parameters so a reload does not.

const READ_TIMEOUT_MS = 20000
const WRITE_TIMEOUT_MS = 20000

export default function Combos() {
  const { isAdmin, isOwner, profile, clientId, clientModules } = useAuth()
  const settingsCtx = useSettings()
  const { scopedFrom, scopedUpdate } = useScopedDb()
  const { ask, confirmEl } = useConfirm()
  const [searchParams, setSearchParams] = useSearchParams()

  const canEdit = isAdmin || isOwner || profile?.pos_role === 'manager' || profile?.ims_role === 'manager'
  // The combo price is stored as the guest pays it, so the VAT mode only labels and previews; while it
  // is unknown the figures read it as VAT, as the till does.
  const vatMode = vatModeOf(settingsCtx, clientId)
  const vatReg = vatMode !== 'pan'

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [rows, setRows] = useState({ combos: [], groups: [], items: [] })
  const [recipes, setRecipes] = useState([])
  const [pageError, setPageError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [editor, setEditor] = useState(null) // { state, isNew, prefilled }

  // An admin switching client mid-load must not let the previous tenant's combos land.
  const loadSeq = useRef(0)

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!clientId) return
    const seq = ++loadSeq.current
    if (!quiet) setLoading(true)
    setLoadError(null)
    let results
    try {
      results = await withTimeout(Promise.all([
        fetchAllRows(() => scopedFrom('pos_combos', 'id, name, guest_price, description, is_active, on_guest_menu, sort')
          .order('sort').order('name').order('id')),
        fetchAllRows(() => scopedFrom('pos_combo_groups', 'id, combo_id, name, sort').order('sort').order('id')),
        fetchAllRows(() => scopedFrom('pos_combo_items', 'id, group_id, recipe_id, extra_price, is_default, sort')
          .order('sort').order('id')),
        // Every recipe, inactive ones too, so a combo still holding a dish taken off the menu can name
        // it. Only active non-Sub-Recipe dishes are offered (isComboDish).
        fetchAllRows(() => scopedFrom('recipes', 'id, name, category, selling_price, vat_rate, is_active, pos_enabled')
          .order('name').order('id')),
      ]), READ_TIMEOUT_MS, 'Loading combos')
    } catch (err) {
      if (seq !== loadSeq.current) return
      setLoadError(err)
      setLoading(false)
      return
    }
    if (seq !== loadSeq.current) return
    const failed = results.find(r => r.error)?.error
    if (failed) { setLoadError(failed); setLoading(false); return }
    const [{ data: combos }, { data: groups }, { data: items }, { data: recs }] = results
    setRows({ combos: combos || [], groups: groups || [], items: items || [] })
    setRecipes(recs || [])
    setLoading(false)
  }, [clientId, scopedFrom])

  useEffect(() => { load() }, [load])

  const combos = useMemo(() => assembleCombos(rows.combos, rows.groups, rows.items), [rows])
  const recipeById = useMemo(() => new Map(recipes.map(r => [r.id, r])), [recipes])
  const dishes = useMemo(
    () => recipes.filter(isComboDish).map(r => ({ ...r, guestPrice: standaloneGuestPrice(r, vatReg) })),
    [recipes, vatReg],
  )
  const nextSort = useMemo(() => Math.max(-1, ...combos.map(c => Number(c.sort) || 0)) + 1, [combos])

  // Combo Builder's hand-off, once the dishes are known.
  useEffect(() => {
    if (!canEdit || loading || loadError || searchParams.get('new') !== '1') return
    const ids = (searchParams.get('dishes') || '').split(',').map(s => s.trim()).filter(Boolean)
    const state = prefillFromDishes(ids, searchParams.get('price'), recipeById, nextSort)
    setEditor({ state, isNew: true, prefilled: state.picks.length > 0 })
    setSearchParams({}, { replace: true })
  }, [canEdit, loading, loadError, searchParams, setSearchParams, recipeById, nextSort])

  // ── Guard, after every hook ──
  if (!canEdit) return <Navigate to="/dashboard" replace />

  const flash = text => setNotice(text)
  const nameOf = id => recipeById.get(id)?.name

  function openNew() {
    setPageError(null)
    setEditor({ state: emptyCombo(nextSort), isNew: true, prefilled: false })
  }

  function openEdit(c) {
    setPageError(null)
    setEditor({ state: editorFromCombo(c), isNew: false, prefilled: false })
  }

  // Hide / Show and the QR-menu switch re-send the saved combo whole with one flag changed.
  async function quickSave(c, patch, doneText) {
    if (busyId) return
    setBusyId(c.id)
    setPageError(null)
    setNotice(null)
    // Only the two switches change, so they are written on their own: re-sending the whole combo
    // through save_pos_combo would be refused once one of its dishes had gone inactive, and Hide is
    // exactly what an owner reaches for then. guard_pos_combo_edit checks the rank either way.
    const { data, error } = await settleWithin(
      scopedUpdate('pos_combos', patch).eq('id', c.id).select('id'),
      WRITE_TIMEOUT_MS, 'Saving the combo',
    )
    setBusyId(null)
    if (error) { setPageError(asActionError(error)); return }
    if (!data || data.length === 0) {
      setPageError('That combo was not changed — it may have been deleted on another device. Reload the page.')
      return
    }
    flash(doneText)
    load({ quiet: true })
  }

  function deleteCombo(c) {
    const n = c.groups.length
    ask({
      title: `Delete “${c.name}”?`,
      danger: true,
      confirmLabel: 'Delete combo',
      busyLabel: 'Deleting…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            It leaves the till and the QR guest menu at once, with its {n} pick{n === 1 ? '' : 's'}. Bills already rung keep the combo and its dishes exactly as they were sold, and reports still count them.
          </p>
          <p style={{ margin: 0, color: 'var(--theme-text2)' }}>To stop selling it for now without losing it, use Hide instead.</p>
        </>
      ),
      run: async () => {
        setPageError(null)
        setNotice(null)
        const { error } = await settleWithin(
          supabase.rpc('delete_pos_combo', { p_combo_id: c.id }),
          WRITE_TIMEOUT_MS, 'Deleting the combo',
        )
        if (error) { setPageError(asActionError(error)); return }
        flash(`“${c.name}” was deleted.`)
        await load({ quiet: true })
      },
    })
  }

  // A dish taken off the menu (or deleted) since the combo was saved: named on the card, and the
  // editor refuses to save until it is taken out.
  function troubleOf(c) {
    const gone = []
    const empty = []
    c.groups.forEach(g => {
      if (!g.items.length) empty.push(g.name)
      g.items.forEach(it => { if (!isComboDish(recipeById.get(it.recipe_id))) gone.push(nameOf(it.recipe_id) || 'a removed dish') })
    })
    const parts = []
    if (gone.length) parts.push(`${gone.map(n => `“${n}”`).join(', ')} ${gone.length === 1 ? 'is' : 'are'} no longer an active dish`)
    if (empty.length) parts.push(`${empty.map(n => `“${n}”`).join(', ')} ${empty.length === 1 ? 'has' : 'have'} no dishes left`)
    return parts.length ? `△ ${parts.join(', and ')}. Edit the combo to fix ${parts.length === 1 && gone.length + empty.length === 1 ? 'it' : 'them'}.` : null
  }

  return (
    <div className="page-container">
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Combos</h1>
          <p className="page-subtitle">
            Sell dishes together at one price — a set meal, or a deal where the guest picks one dish from each list.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Fab label="+ New combo" onClick={openNew} show={!loading && !loadError} />
        </div>
      </div>

      {isAdmin && clientModules && !clientModules.customization && (
        <div role="status" className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>Crest Customization is off for this client.</strong>{' '}
          <span style={{ color: 'var(--theme-text2)' }}>You can prepare combos now; nothing is offered on the till or guest menu until it is switched on in Admin → Clients.</span>
        </div>
      )}

      <ActionError error={pageError} className="action-error--top" />
      {notice && (
        <p role="status" style={{ fontSize: 13, color: 'var(--theme-green-text)', margin: '0 0 12px' }}>{notice}</p>
      )}

      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : combos.length === 0 ? (
        <div className="empty-state">
          <p style={{ margin: '0 0 8px' }}>No combos yet.</p>
          <p style={{ margin: 0, color: 'var(--theme-text2)' }}>
            A combo sells dishes together at one price. Make a <strong>set meal</strong> (Thali Set: dal, rice, tarkari — every pick one dish) or a <strong>pick-your-own deal</strong> (Momo Combo, NPR 350: pick a momo, pick a drink, Chicken +50). Each dish still goes to its own kitchen, takes its own stock and counts as that dish in every report. Press <strong>+ New combo</strong> to make the first one.
          </p>
        </div>
      ) : (
        <div className="fab-clear" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {combos.map(c => {
            const trouble = troubleOf(c)
            const setMeal = isSetMeal(c.groups)
            return (
              <section key={c.id} className="card" aria-labelledby={`combo-${c.id}`} style={{ margin: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h2 id={`combo-${c.id}`} style={{ margin: 0, fontSize: 16, color: c.is_active ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>{c.name}</h2>
                  {setMeal && (
                    <Tip width={260} text="Every pick has one dish, so the till adds the whole combo in one tap." style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>
                      <span className="badge-gray">Set meal</span>
                    </Tip>
                  )}
                  {c.is_active
                    ? <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{c.on_guest_menu ? 'Till and QR menu' : 'Till only'}</span>
                    : <span className="badge-gray">Hidden</span>}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap', color: 'var(--theme-text1)' }}>NPR {nprPaisa(c.guest_price)}</span>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => openEdit(c)} aria-label={`Edit ${c.name}`}
                      disabled={busyId === c.id}>Edit</button>
                    <RowMenu label={`More for ${c.name}`} busy={busyId === c.id} items={[
                      { key: 'hide', label: c.is_active ? 'Hide from till and guest menu' : 'Show again',
                        onSelect: () => quickSave(c, { is_active: !c.is_active }, c.is_active ? `“${c.name}” is hidden from the till and the guest menu.` : `“${c.name}” is on sale again.`) },
                      { key: 'qr', label: c.on_guest_menu ? 'Take off the QR guest menu' : 'Put on the QR guest menu',
                        onSelect: () => quickSave(c, { on_guest_menu: !c.on_guest_menu }, c.on_guest_menu ? `“${c.name}” is off the QR guest menu; the till still sells it.` : `“${c.name}” is on the QR guest menu${c.is_active ? '' : ' once it is shown again'}.`) },
                      '-',
                      { key: 'delete', label: 'Delete combo…', danger: true, onSelect: () => deleteCombo(c) },
                    ]} />
                  </div>
                </div>
                <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--theme-text2)' }}>
                  {c.groups.length ? pickSummary(c.groups) : 'No picks'}
                </p>
                {c.description && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--theme-text3)' }}>{c.description}</p>}
                {trouble && <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--theme-amber-text)' }}>{trouble}</p>}
                {c.groups.length > 0 && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ fontSize: 12, color: 'var(--theme-text2)', cursor: 'pointer' }}>Dishes</summary>
                    <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {c.groups.map(g => (
                        <li key={g.id}>
                          <strong style={{ fontWeight: 600 }}>{g.name}:</strong>{' '}
                          {g.items.map(it => {
                            const extra = Number(it.extra_price) || 0
                            const r = recipeById.get(it.recipe_id)
                            return [
                              nameOf(it.recipe_id) || 'a removed dish',
                              extra ? ` +${npr(extra)}` : '',
                              it.is_default && g.items.length > 1 ? ' (default)' : '',
                              r && r.pos_enabled === false ? ' (not sold alone)' : '',
                            ].join('')
                          }).join(', ') || '—'}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            )
          })}
        </div>
      )}

      {editor && (
        <ComboEditorModal
          initial={editor.state}
          isNew={editor.isNew}
          prefilled={editor.prefilled}
          dishes={dishes}
          recipeById={recipeById}
          vatMode={vatMode}
          otherNames={combos.filter(c => c.id !== editor.state.id).map(c => c.name)}
          clientId={clientId}
          onClose={() => setEditor(null)}
          onSaved={({ name, isNew }) => {
            setEditor(null)
            setPageError(null)
            flash(isNew ? `“${name}” was created.` : `“${name}” was saved.`)
            load({ quiet: true })
          }}
        />
      )}

      {confirmEl}
    </div>
  )
}
