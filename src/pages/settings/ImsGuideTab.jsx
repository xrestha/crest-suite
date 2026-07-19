import { useMemo, useState } from 'react'
import { IMS_GUIDE_GROUPS } from './imsGuideData'

// Admin Settings → Guides → Crest IMS. Static reference content (imsGuideData.js) driving a
// sidebar + content-pane layout — same shape as Help.js's page-group nav, scaled to a much
// deeper per-page reference doc. Added S417; see CLAUDE.md decision log for why this is a
// separate, admin-only doc rather than a rework of Help.js's client-facing Module Guide tab.
export default function ImsGuideTab() {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(IMS_GUIDE_GROUPS[0].sections[0].id)

  const q = query.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!q) return IMS_GUIDE_GROUPS
    return IMS_GUIDE_GROUPS
      .map(g => ({ ...g, sections: g.sections.filter(s => s.title.toLowerCase().includes(q)) }))
      .filter(g => g.sections.length > 0)
  }, [q])

  const active = useMemo(() => {
    for (const g of IMS_GUIDE_GROUPS) {
      const s = g.sections.find(s => s.id === activeId)
      if (s) return s
    }
    return IMS_GUIDE_GROUPS[0].sections[0]
  }, [activeId])

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      {/* Sidebar */}
      <div style={{ width: 240, flexShrink: 0, position: 'sticky', top: 12 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search pages…"
          style={{
            width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)',
            border: '1px solid var(--theme-border)', borderRadius: 6, padding: '7px 10px',
            fontSize: 13, color: 'var(--theme-text1)', outline: 'none', marginBottom: 12,
          }}
        />
        <div style={{ maxHeight: 620, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {filteredGroups.map(g => (
            <div key={g.key}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--theme-text3)', margin: '0 0 6px 4px' }}>
                {g.label}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {g.sections.map(s => {
                  const isActive = s.id === active.id
                  return (
                    <button
                      key={s.id}
                      onClick={() => setActiveId(s.id)}
                      style={{
                        textAlign: 'left', background: isActive ? 'var(--theme-accent)' : 'transparent',
                        color: isActive ? '#000' : 'var(--theme-text2)', border: 'none', borderRadius: 6,
                        padding: '6px 10px', fontSize: 13, fontWeight: isActive ? 700 : 400, cursor: 'pointer',
                      }}
                    >
                      {s.title}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          {filteredGroups.length === 0 && (
            <p style={{ fontSize: 12, color: 'var(--theme-text3)', padding: '0 4px' }}>No pages match "{query}".</p>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="card" style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontSize: 17, color: 'var(--theme-text1)' }}>{active.title}</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {active.route && (
              <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--theme-accent)', background: 'rgba(0,0,0,0.15)', border: '1px solid var(--theme-border)', borderRadius: 4, padding: '2px 8px' }}>
                {active.route}
              </span>
            )}
            {active.plan && (
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', border: '1px solid var(--theme-border)', borderRadius: 4, padding: '2px 8px' }}>
                {active.plan}
              </span>
            )}
          </div>
        </div>

        <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--theme-text2)', margin: '0 0 20px' }}>{active.summary}</p>

        {active.workflow.length > 0 && (
          <GuideSection title="How to use it">
            <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {active.workflow.map((step, i) => (
                <li key={i} style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--theme-text1)' }}>{step}</li>
              ))}
            </ol>
          </GuideSection>
        )}

        {active.fields.length > 0 && (
          <GuideSection title="Key fields">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {active.fields.map((f, i) => (
                <div key={i}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>{f.label}</div>
                  <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--theme-text2)' }}>{f.desc}</div>
                </div>
              ))}
            </div>
          </GuideSection>
        )}

        {active.formulas.length > 0 && (
          <GuideSection title="How it calculates">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {active.formulas.map((f, i) => (
                <div key={i} style={{
                  fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6, color: 'var(--theme-text1)',
                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 10px',
                }}>
                  {f}
                </div>
              ))}
            </div>
          </GuideSection>
        )}

        {active.gotchas.length > 0 && (
          <GuideSection title="Watch out for">
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {active.gotchas.map((g, i) => (
                <li key={i} style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--theme-amber)' }}>{g}</li>
              ))}
            </ul>
          </GuideSection>
        )}

        {active.connections && (
          <GuideSection title="Connects to">
            <p style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--theme-text2)', margin: 0 }}>{active.connections}</p>
          </GuideSection>
        )}
      </div>
    </div>
  )
}

function GuideSection({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--theme-text3)', marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  )
}
