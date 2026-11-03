import { ALLERGENS, ALLERGEN_KEYS, normaliseAllergens } from '../shared/constants/allergens'

// The allergen tick-list (S870), shared by the ingredient nutrition form and the Customization
// choice form. `value` is an array of words: the ticked keys, then any unmatched word saved before
// the list existed. An unmatched word is shown, never dropped, until someone removes it.
export default function AllergenTicks({ id, value, onChange, disabled = false }) {
  const { keys, other } = normaliseAllergens(value)
  const set = (nextKeys, nextOther) => onChange([...ALLERGEN_KEYS.filter(k => nextKeys.includes(k)), ...nextOther])
  const toggle = key => set(keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key], other)

  return (
    <div>
      <div role="group" aria-labelledby={`${id}-label`}
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', columnGap: 16 }}>
        {ALLERGENS.map(a => (
          <label key={a.key} className="form-check" style={{ alignItems: 'flex-start', paddingTop: 6 }}>
            <input type="checkbox" checked={keys.includes(a.key)} disabled={disabled} onChange={() => toggle(a.key)} style={{ marginTop: 2 }} />
            <span>
              {a.label}
              <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-text3)', lineHeight: 1.35 }}>{a.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {other.length > 0 && (
        <div role="note" style={{ marginTop: 10, padding: '8px 12px', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontSize: 12, color: 'var(--theme-text2)' }}>
          <span style={{ color: 'var(--theme-text1)', fontWeight: 600 }}>Not on the list: </span>
          {other.map(w => (
            <span key={w} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 10 }}>
              {w}
              <button type="button" className="btn btn-ghost" disabled={disabled} aria-label={`Remove ${w}`}
                style={{ padding: '0 6px', minHeight: 24, fontSize: 12 }} onClick={() => set(keys, other.filter(x => x !== w))}>×</button>
            </span>
          ))}
          <div style={{ marginTop: 4 }}>Tick the matching allergen above, then remove the word. Until then this counts as not checked.</div>
        </div>
      )}
    </div>
  )
}
