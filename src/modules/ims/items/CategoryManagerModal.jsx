import { useMemo, useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { settleWithin } from '../../../utils/withTimeout'
import { outcomeUnknown } from './sheetImport'
import {
  categoryNameProblem, cleanCategoryName, categoryLock, isHeadOfficeCopy, removeTargets, itemCountsByCategory,
  itemCountText, removeNeedsTarget, removeConsequence, mergeResultText, nextSortOrder, CATEGORY_NAME_MAX,
} from './categoryManage'

// Item Master → Manage categories (S885, owner decision 2). Add and rename are plain writes on
// `categories` (IMS supervisor and above, the page's own rank); remove is merge_item_category, one
// transaction, for the Owner or an IMS manager only. Sub-Recipes never reaches this list (the page
// filters it out) and the database refuses it anyway; a branch copy of a head-office category is
// shown with Rename and Remove off, because the next push from head office would undo either.
const WRITE_TIMEOUT_MS = 20000
const MERGE_TIMEOUT_MS = 30000

export default function CategoryManagerModal({ categories, items, inGroup, canRemove, askConfirm, onChanged, onClose }) {
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()
  const counts = useMemo(() => itemCountsByCategory(items), [items])
  const uncategorised = useMemo(() => (items || []).filter(i => !i.category_id).length, [items])
  const [newName, setNewName] = useState('')
  const [addErr, setAddErr] = useState('')
  const [busy, setBusy] = useState(null)          // what is in flight: 'add', 'rename', 'count', 'remove'
  const [renaming, setRenaming] = useState(null)  // { id, text, err }
  const [removing, setRemoving] = useState(null)  // { id, status: 'checking' | 'ready' | 'failed', items, hidden, budgets, target, err, need }
  const [notice, setNotice] = useState('')
  const [error, setError] = useState(null)
  const [why, setWhy] = useState(null)            // { id, text }: what a locked control says when pressed

  const clearMessages = () => { setError(null); setNotice(''); setWhy(null) }

  async function reload() {
    try { await onChanged?.() } catch (e) { console.error('Manage categories: reload failed', e) }
  }

  // A write whose answer did not come back may have landed; the list is reloaded so the reader
  // sees which, and the sentence never says it did not happen.
  function writeFailed(err, notDone, unknownText) {
    const a = asActionError(err)
    setError({ text: outcomeUnknown(err) ? `${unknownText} ${a.text}` : `${notDone} ${a.text}`, detail: a.detail })
  }

  async function addCategory() {
    clearMessages()
    const problem = categoryNameProblem(newName, categories)
    if (problem) { setAddErr(problem); return }
    const name = cleanCategoryName(newName)
    setBusy('add')
    const { error: err } = await settleWithin(
      scopedInsert('categories', { name, sort_order: nextSortOrder(categories) }, { single: true }), WRITE_TIMEOUT_MS, 'Adding the category')
    setBusy(null)
    if (err) {
      if (err.code === '23505') setAddErr(`There is already a category called "${name}". It may have been added in another tab; it shows once the list reloads.`)
      else writeFailed(err, `"${name}" was not added.`, `Crest did not hear back about adding "${name}", so it may or may not have been added. The list has been reloaded: check it before adding again.`)
      await reload()
      return
    }
    setNewName('')
    setAddErr('')
    setNotice(`Added "${name}".`)
    await reload()
  }

  function startRename(cat) {
    clearMessages()
    const lock = categoryLock(cat, { inGroup, canRemove })
    if (lock.rename) { setWhy({ id: cat.id, text: lock.rename }); return }
    setRemoving(null)
    setRenaming({ id: cat.id, text: cat.name, err: '' })
  }

  async function saveRename(cat) {
    clearMessages()
    const problem = categoryNameProblem(renaming.text, categories, { exceptId: cat.id })
    if (problem) { setRenaming(r => ({ ...r, err: problem })); return }
    const name = cleanCategoryName(renaming.text)
    if (name === cat.name) { setRenaming(null); return }
    setBusy('rename')
    // `.select('id')`: an update that matches no row returns no error (S738), and would read as done.
    const { data, error: err } = await settleWithin(
      scopedUpdate('categories', { name }).eq('id', cat.id).select('id'), WRITE_TIMEOUT_MS, 'Renaming the category')
    setBusy(null)
    if (err) {
      if (err.code === '23505') { setRenaming(r => ({ ...r, err: `There is already a category called "${name}".` })); await reload(); return }
      writeFailed(err, `"${cat.name}" was not renamed.`, `Crest did not hear back about renaming "${cat.name}", so it may or may not have been renamed. The list has been reloaded: check it before trying again.`)
      setRenaming(null)
      await reload()
      return
    }
    setRenaming(null)
    if (!data?.length) {
      setError(`"${cat.name}" was not renamed: Crest could not find it to change. It may have been removed in another tab, or this login may not change it. The list has been reloaded.`)
    } else {
      setNotice(`Renamed "${cat.name}" to "${name}". Every item filed under it keeps its category.`)
    }
    await reload()
  }

  // Counted live, not from the page: the confirm names these numbers, and the database decides
  // whether a target is needed from the same rows. A count that could not be read refuses.
  async function startRemove(cat) {
    clearMessages()
    const lock = categoryLock(cat, { inGroup, canRemove })
    if (lock.remove) { setWhy({ id: cat.id, text: lock.remove }); return }
    setRenaming(null)
    setRemoving({ id: cat.id, status: 'checking', target: '' })
    setBusy('count')
    const head = { count: 'exact', head: true }
    const [all, hidden, budgets] = await Promise.all([
      settleWithin(scopedFrom('items', 'id', head).eq('category_id', cat.id), WRITE_TIMEOUT_MS, 'Counting items'),
      settleWithin(scopedFrom('items', 'id', head).eq('category_id', cat.id).eq('is_active', false), WRITE_TIMEOUT_MS, 'Counting items'),
      // budgets has a nullable client_id, so it stays on raw supabase.from(); a category id belongs
      // to one client, so filtering on it is as tight as a client filter.
      settleWithin(supabase.from('budgets').select('id', head).eq('category_id', cat.id), WRITE_TIMEOUT_MS, 'Counting budgets'),
    ])
    setBusy(null)
    const failed = [all, hidden, budgets].find(r => r.error)
    if (failed) {
      const a = asActionError(failed.error)
      setRemoving({ id: cat.id, status: 'failed', err: { text: `Crest could not count what is filed under "${cat.name}", so it will not remove it yet. Nothing was changed. ${a.text}`, detail: a.detail } })
      return
    }
    setRemoving({
      id: cat.id, status: 'ready', target: '', need: '',
      items: all.count || 0, hidden: hidden.count || 0, budgets: budgets.count || 0,
    })
  }

  function askRemove(cat) {
    const r = removing
    const needTarget = removeNeedsTarget(r)
    const to = needTarget ? categories.find(c => c.id === r.target) : null
    if (needTarget && !to) {
      setRemoving(x => ({ ...x, need: 'Pick the category its items and budgets move to first.' }))
      return
    }
    askConfirm({
      title: `Remove "${cat.name}"?`,
      confirmLabel: needTarget ? 'Move and remove' : 'Remove category',
      danger: true, busyLabel: 'Removing…',
      // Over this dialog, which sits at Modal's default 100.
      zIndex: 110,
      body: <p style={{ margin: 0 }}>{removeConsequence({ from: cat, to, items: r.items, hidden: r.hidden, budgets: r.budgets })}</p>,
      run: () => removeNow(cat, to),
    })
  }

  async function removeNow(cat, to) {
    clearMessages()
    setBusy('remove')
    const { data, error: err } = await settleWithin(
      supabase.rpc('merge_item_category', { p_from: cat.id, p_to: to?.id ?? null }), MERGE_TIMEOUT_MS, 'Removing the category')
    setBusy(null)
    setRemoving(null)
    if (err) {
      // One transaction: a refusal the server answered with changed nothing, and an answer that
      // never came back means all of it or none of it happened.
      writeFailed(err, `"${cat.name}" was not removed.`,
        `Crest did not hear back about removing "${cat.name}". The move is all or nothing, so either everything moved or nothing did; the list has been reloaded to show which.`)
      await reload()
      return
    }
    setNotice(mergeResultText(cat.name, to?.name, data))
    await reload()
  }

  const anyBusy = busy != null

  return (
    <Modal onClose={() => { if (!anyBusy) onClose() }} title="Manage categories" maxWidth={720}>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--theme-text2)' }}>
        Categories group your items on this page, on Stock Count and in Budget vs Actual. Item counts include hidden items.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ flex: '1 1 220px' }}>
          <label htmlFor="cat-new" className="visually-hidden">New category name</label>
          <input id="cat-new" className="form-input" value={newName} maxLength={CATEGORY_NAME_MAX + 20}
            onChange={e => { setNewName(e.target.value); setAddErr('') }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCategory() } }}
            placeholder="New category, e.g. Spices"
            {...fieldAria('cat-new', addErr)} />
          <FieldError id="cat-new" message={addErr} />
        </div>
        <button type="button" className="btn btn-primary" onClick={addCategory} disabled={anyBusy}>
          {busy === 'add' ? 'Adding…' : '+ Add category'}
        </button>
      </div>

      <p role="status" style={{ margin: notice ? '0 0 10px' : 0, fontSize: 13, color: 'var(--theme-text1)' }}>{notice}</p>
      <ActionError error={error} />

      {categories.length === 0 ? (
        <p className="empty-state-text" style={{ margin: '8px 0' }}>
          No categories yet. Add one above, or close this and use Load Default Categories.
        </p>
      ) : (
        <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip width={240} text="Items filed under this category, hidden items included. Removing it moves every one of them.">Items</Tip>
                </th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {categories.map(cat => {
                const c = counts[cat.id] || { all: 0, hidden: 0 }
                const lock = categoryLock(cat, { inGroup, canRemove })
                const isRenaming = renaming?.id === cat.id
                const rm = removing?.id === cat.id ? removing : null
                const targets = removeTargets(categories, cat)
                return [
                  <tr key={cat.id}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {isRenaming ? (
                        <>
                          <label htmlFor={`cat-rename-${cat.id}`} className="visually-hidden">New name for {cat.name}</label>
                          <input id={`cat-rename-${cat.id}`} className="form-input" autoFocus value={renaming.text}
                            onChange={e => setRenaming(r => ({ ...r, text: e.target.value, err: '' }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); saveRename(cat) }
                              // Cancels this box only; the dialog stays open (Modal respects defaultPrevented).
                              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRenaming(null) }
                            }}
                            {...fieldAria(`cat-rename-${cat.id}`, renaming.err)} />
                          <FieldError id={`cat-rename-${cat.id}`} message={renaming.err} />
                        </>
                      ) : (
                        <>
                          {cat.name}
                          {isHeadOfficeCopy(cat, inGroup) && <span className="cell-sub">From head office</span>}
                        </>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap', color: 'var(--theme-text1)' }}>
                      {c.all}
                      {c.hidden > 0 && <span className="cell-sub">{c.hidden} hidden</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                        {isRenaming ? (
                          <>
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => saveRename(cat)} disabled={anyBusy}>
                              {busy === 'rename' ? 'Saving…' : 'Save'}
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRenaming(null)} disabled={anyBusy}>Cancel</button>
                          </>
                        ) : (
                          <>
                            {/* aria-disabled, not disabled (S776): a press says why it is off. */}
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => startRename(cat)} disabled={anyBusy}
                              aria-disabled={lock.rename ? true : undefined} aria-label={`Rename ${cat.name}`}>Rename</button>
                            <button type="button" className="btn btn-danger btn-sm" onClick={() => startRemove(cat)} disabled={anyBusy}
                              aria-disabled={lock.remove ? true : undefined} aria-label={`Remove ${cat.name}`}>Remove</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>,
                  why?.id === cat.id && (
                    <tr key={`${cat.id}-why`}>
                      <td colSpan={3} role="status" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{why.text}</td>
                    </tr>
                  ),
                  rm && (
                    <tr key={`${cat.id}-remove`} className="row-tinted">
                      <td colSpan={3}>
                        {rm.status === 'checking' && (
                          <p role="status" style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>Counting what is filed under &quot;{cat.name}&quot;…</p>
                        )}
                        {rm.status === 'failed' && (
                          <>
                            <ActionError error={rm.err} />
                            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startRemove(cat)} disabled={anyBusy}>Try again</button>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRemoving(null)}>Cancel</button>
                            </div>
                          </>
                        )}
                        {rm.status === 'ready' && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text1)' }}>
                              &quot;{cat.name}&quot; holds {itemCountText(rm.items, rm.hidden)}
                              {rm.budgets > 0 ? ` and ${rm.budgets} monthly budget${rm.budgets === 1 ? '' : 's'}` : ' and no monthly budgets'}.
                            </p>
                            {removeNeedsTarget(rm) && (targets.length === 0 ? (
                              <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-amber-text)' }}>
                                There is no other category to move them to. Add one above first, then remove this one.
                              </p>
                            ) : (
                              <div>
                                <label htmlFor={`cat-target-${cat.id}`} style={{ fontSize: 13, color: 'var(--theme-text2)', marginRight: 8 }}>Move them to</label>
                                <select id={`cat-target-${cat.id}`} className="form-select" value={rm.target}
                                  onChange={e => setRemoving(x => ({ ...x, target: e.target.value, need: '' }))}
                                  {...fieldAria(`cat-target-${cat.id}`, rm.need)}>
                                  <option value="">Pick a category…</option>
                                  {targets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                                </select>
                                <FieldError id={`cat-target-${cat.id}`} message={rm.need} />
                              </div>
                            ))}
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button type="button" className="btn btn-danger btn-sm" onClick={() => askRemove(cat)} disabled={anyBusy}
                                aria-disabled={removeNeedsTarget(rm) && (!rm.target || targets.length === 0) ? true : undefined}>
                                {removeNeedsTarget(rm) ? 'Move and remove…' : 'Remove…'}
                              </button>
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRemoving(null)} disabled={anyBusy}>Cancel</button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  ),
                ]
              })}
            </tbody>
          </table>
        </div>
      )}

      {uncategorised > 0 && (
        <p className="page-footnote" style={{ marginTop: 10 }}>
          {uncategorised} item{uncategorised === 1 ? ' has' : 's have'} no category. Edit an item to file it under one.
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={anyBusy}>Close</button>
      </div>
    </Modal>
  )
}
