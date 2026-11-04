import { useState } from 'react'

// Recipes' auto-fill confirm: every ingredient beside the library food it will take, ticked.
// Unticking one leaves it out of the fill. The confirm body is rendered once and holds no page
// state, so the choice travels back through `skipRef` (a Set of item ids) for the run to read.
export default function AutoFillList({ targets, skipRef }) {
  const [skipped, setSkipped] = useState(() => new Set())

  function toggle(id) {
    const next = new Set(skipped)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    skipRef.current = next
    setSkipped(next)
  }

  return (
    <ul style={{ listStyle: 'none', margin: '0 0 10px', padding: 0, maxHeight: 260, overflowY: 'auto' }}>
      {targets.map(({ it, seed }) => (
        <li key={it.id}>
          <label className="form-check">
            <input type="checkbox" checked={!skipped.has(it.id)} onChange={() => toggle(it.id)} />
            <span>
              {it.name}
              <span style={{ display: 'block', fontSize: 12, color: 'var(--theme-text2)' }}>→ {seed.name} · {seed.source}</span>
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}
