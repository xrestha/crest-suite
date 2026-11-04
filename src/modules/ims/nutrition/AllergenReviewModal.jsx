import { useMemo, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import ActionError, { asActionError } from '../../../components/ActionError'
import { FilterChips } from '../../../components/Tabs'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { withTimeout } from '../../../utils/withTimeout'
import { allergensChecked, confirmAllergensPayload, notFoodPayload } from '../../../utils/nutrition'
import { ALLERGEN_KEYS, normaliseAllergens, allergenLabel } from '../../../shared/constants/allergens'
import { suggestAllergens, nearMissText } from '../../../shared/constants/allergenSuggest'

// The Check allergens list (S870): every ingredient nobody has checked, with Crest's guess from its
// name (allergenSuggest.js) and the word each allergen came from. A person confirms, row by row or
// all shown at once; nothing counts as checked before that. A row that needs its label (a sauce, a
// spice mix, a word that is not on the list) has no Confirm: it opens the Nutrition form instead,
// and Confirm all leaves it out. S877: so does a name with a near miss ("ICE CREAN" looks like
// cream), which ticks nothing and says what the word looked like.

const KINDS = [
  { key: 'all', label: 'All' },
  { key: 'guess', label: 'With a guess' },
  { key: 'none', label: 'No allergen words' },
  { key: 'label', label: 'Check the label' },
  { key: 'notfood', label: 'Not food' },
]
const WRITE_LANES = 6

function rowOf(item) {
  const s = suggestAllergens(item.name)
  const current = normaliseAllergens(item.nutrition?.allergens)
  const keys = ALLERGEN_KEYS.filter(k => s.keys.includes(k) || current.keys.includes(k))
  const kind = s.notFood && current.keys.length === 0 && current.other.length === 0 ? 'notfood'
    : s.checkLabel.length > 0 || current.other.length > 0 ? 'label'
      : keys.length > 0 ? 'guess' : 'none'
  return { item, s, current, keys, kind }
}

// "Milk (paneer) · Gluten (aata)", with "already on the item" for an allergen it carried before.
function reasonText(row) {
  return row.keys.map(k => {
    const from = row.s.reasons[k]
    return `${allergenLabel(k)} (${from ? from.join(', ') : 'already on the item'})`
  }).join(' · ')
}

// The amber line of a row that needs its label: "Check the label (sauce)", and for a near miss
// "“crean” looks like “cream”: check the label" (S877), then any word that is not on the list.
function labelText(row) {
  const near = row.s.nearMiss || []
  const nearWords = new Set(near.map(n => n.word))
  const plain = row.s.checkLabel.filter(w => !nearWords.has(w))
  const parts = []
  if (plain.length > 0 || near.length === 0) parts.push(`Check the label${plain.length > 0 ? ` (${plain.join(', ')})` : ''}`)
  if (near.length > 0) parts.push(parts.length > 0 ? nearMissText(near) : `${nearMissText(near)}: check the label`)
  if (row.current.other.length > 0) parts.push(`not on the list: ${row.current.other.join(', ')}`)
  return parts.join(' · ')
}

// The note the Nutrition form shows when Change or Open hands it this row.
function guessNoteOf(row) {
  const notes = []
  if (row.keys.length > 0) notes.push(`Ticked from the guess Crest made: ${reasonText(row)}.`)
  const near = row.s.nearMiss || []
  if (near.length > 0) notes.push(`${nearMissText(near)}: nothing was ticked for ${near.length === 1 ? 'it' : 'them'}.`)
  return notes.length > 0 ? `${notes.join(' ')} Check the label if unsure, then save.` : ''
}

export default function AllergenReviewModal({ items, onClose, onSaved, onChange }) {
  const [kind, setKind] = useState('all')
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(0)
  const { ask, confirmEl } = useConfirm()

  const rows = useMemo(() => items
    .filter(i => !allergensChecked(i.nutrition))
    .map(rowOf)
    .sort((a, b) => a.item.name.localeCompare(b.item.name)), [items])
  const counts = useMemo(() => rows.reduce((c, r) => { c[r.kind] = (c[r.kind] || 0) + 1; return c }, { all: rows.length }), [rows])
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter(r => (kind === 'all' || r.kind === kind) && (!q || r.item.name.toLowerCase().includes(q)))
  }, [rows, kind, search])
  const confirmable = shown.filter(r => r.kind !== 'label')

  // Reads each item's nutrition fresh before writing, so a figure someone else saved meanwhile is
  // kept; then writes in a few lanes. An update RLS refuses returns no row and no error, so each one
  // selects its id back and an empty answer counts as a failure.
  async function save(targets) {
    if (targets.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const ids = targets.map(r => r.item.id)
      const fresh = await withTimeout(fetchAllRowsChunked(ids, chunk =>
        supabase.from('items').select('id, nutrition').in('id', chunk).order('id')), 30000, 'Reading the ingredients')
      if (fresh.error) {
        const a = asActionError(fresh.error)
        setError({ text: 'Nothing was saved: Crest could not read the ingredients first. ' + a.text, detail: a.detail })
        return
      }
      const nutritionById = Object.fromEntries((fresh.data || []).map(r => [r.id, r.nutrition]))
      const queue = [...targets]
      const saved = {}
      const failed = []
      const lane = async () => {
        while (queue.length > 0) {
          const r = queue.shift()
          const payload = r.kind === 'notfood' ? notFoodPayload() : confirmAllergensPayload(nutritionById[r.item.id], r.keys)
          const { data, error: e } = await supabase.from('items').update({ nutrition: payload }).eq('id', r.item.id).select('id')
          if (e || !data || data.length === 0) failed.push({ name: r.item.name, error: e })
          else saved[r.item.id] = payload
        }
      }
      await withTimeout(Promise.all(Array.from({ length: Math.min(WRITE_LANES, targets.length) }, lane)), 120000, 'Saving the allergens')
      if (Object.keys(saved).length > 0) {
        setDone(d => d + Object.keys(saved).length)
        onSaved(saved)
      }
      if (failed.length > 0) {
        const first = failed.find(f => f.error)
        const a = first ? asActionError(first.error) : null
        setError({
          text: `${failed.length} ingredient${failed.length === 1 ? ' was' : 's were'} not saved and ${failed.length === 1 ? 'is' : 'are'} still in the list: ${failed.slice(0, 5).map(f => f.name).join(', ')}${failed.length > 5 ? '…' : ''}.`
            + (a ? ' ' + a.text : ' Your account may not be allowed to change these items.'),
          detail: a?.detail,
        })
      }
    } catch (e) {
      const a = asActionError(e)
      setError({ text: 'The save did not finish. Some ingredients may have been saved; the list shows what is still unchecked. ' + a.text, detail: a.detail })
    } finally {
      setBusy(false)
    }
  }

  function confirmAll() {
    const withAllergens = confirmable.filter(r => r.kind === 'guess').length
    const none = confirmable.filter(r => r.kind === 'none').length
    const notFood = confirmable.filter(r => r.kind === 'notfood').length
    const left = shown.length - confirmable.length
    ask({
      title: `Mark ${confirmable.length} ingredient${confirmable.length === 1 ? '' : 's'} as checked?`,
      body: (
        <>
          <p style={{ margin: '0 0 10px' }}>
            Each one is saved with the allergens shown for it, and the guest menu then trusts them.
          </p>
          <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>
            {withAllergens > 0 && <li>{withAllergens} with the allergens Crest found in the name</li>}
            {none > 0 && <li>{none} as containing none of the 14 allergens</li>}
            {notFood > 0 && <li>{notFood} as not food</li>}
          </ul>
          {left > 0 && <p style={{ margin: 0, color: 'var(--theme-text2)' }}>{left} that need their label are left for you to open one by one.</p>}
        </>
      ),
      confirmLabel: `Confirm ${confirmable.length}`,
      run: () => save(confirmable),
    })
  }

  return (
    <Modal onClose={onClose} title="Check allergens" maxWidth={920}>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 14px' }}>
        Every ingredient nobody has checked yet, with Crest&rsquo;s guess from its name and the word each allergen came from.
        A guess is only a guess: confirm it if it is right, or open the ingredient to change it. Mixed or branded products, and names that look misspelt, need their label.
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <input className="form-input form-input--auto" aria-label="Search ingredients" placeholder="Search…"
          value={search} onChange={e => setSearch(e.target.value)} style={{ minWidth: 200 }} />
        <FilterChips
          label="Show"
          options={KINDS.map(k => ({ key: k.key, label: <>{k.label} <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginLeft: 4 }}>{counts[k.key] || 0}</span></> }))}
          active={kind}
          onChange={setKind}
        />
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <Tip width={300} text="Saves every row shown with its guess: the allergens listed, none, or not food. Rows that need their label are never included. Narrow the list first with the chips or the search.">
          <button type="button" className="btn btn-primary btn-sm" onClick={confirmAll} disabled={busy || confirmable.length === 0} aria-busy={busy || undefined}>
            {busy ? 'Saving…' : `Confirm all ${confirmable.length} shown`}
          </button>
        </Tip>
        <span role="status" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
          {done > 0 ? `${done} checked so far. ` : ''}{rows.length} still to check.
        </span>
      </div>
      <ActionError error={error} />

      {shown.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '16px 0' }}>
          {rows.length === 0 ? 'Every ingredient has been checked for allergens.' : 'Nothing in this list matches.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Ingredient</th>
                <th><Tip width={260} text="What Crest read in the name, and the word each allergen came from. Already on the item means it carried that allergen before.">Crest&rsquo;s guess</Tip></th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.item.id}>
                  <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.item.name}</td>
                  <td style={{ fontSize: 12 }}>
                    {r.kind === 'notfood' ? (
                      <span style={{ color: 'var(--theme-text2)' }}>Not food <span style={{ color: 'var(--theme-text3)' }}>(from &ldquo;{r.s.notFood}&rdquo;)</span></span>
                    ) : (
                      <>
                        {r.keys.length > 0
                          ? <span style={{ color: 'var(--theme-text1)' }}>{reasonText(r)}</span>
                          : r.kind === 'none' && <span style={{ color: 'var(--theme-text2)' }}>No allergen words found</span>}
                        {r.kind === 'label' && (
                          <span style={{ display: 'block', color: 'var(--theme-amber-text)' }}>△ {labelText(r)}</span>
                        )}
                      </>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {r.kind !== 'label' && (
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
                          onClick={() => save([r])} aria-label={`${r.kind === 'notfood' ? 'Mark as not food' : 'Confirm'}: ${r.item.name}`}>
                          {r.kind === 'notfood' ? 'Not food' : 'Confirm'}
                        </button>
                      )}
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
                        onClick={() => onChange(r.item, r.kind === 'notfood' ? [] : r.keys, guessNoteOf(r))}
                        aria-label={`${r.kind === 'label' ? 'Open' : 'Change'} ${r.item.name}`}>
                        {r.kind === 'label' ? 'Open…' : 'Change…'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirmEl}
    </Modal>
  )
}
