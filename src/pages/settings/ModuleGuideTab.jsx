import { useMemo, useState } from 'react'
import { escapeHtml } from '../../utils/escapeHtml'

// Admin Settings → Guides. Static reference content (imsGuideData.js / hrGuideData.js /
// posGuideData.js, selected by GuidesTab.jsx) driving a sidebar + content-pane layout — same
// shape as Help.js's page-group nav, scaled to a much deeper per-page reference doc. Added S417
// as ImsGuideTab, parameterized S594 when the HR and POS guides joined it; see CLAUDE.md decision
// log for why this is a separate, admin-only doc rather than a rework of Help.js's client-facing
// Module Guide tab. Every section object must define all 10 keys (id/title/route/plan/summary/
// workflow/fields/formulas/gotchas/connections) — the render reads `.length` with no null guards.
// Render with key={module} from the caller: activeId is init-once state, so reusing one instance
// across a module switch would fall back to the first section instead of remounting cleanly.
export default function ModuleGuideTab({ groups, docTitle, docSubtitle }) {
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(groups[0].sections[0].id)

  const q = query.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!q) return groups
    return groups
      .map(g => ({ ...g, sections: g.sections.filter(s => s.title.toLowerCase().includes(q)) }))
      .filter(g => g.sections.length > 0)
  }, [q, groups])

  const active = useMemo(() => {
    for (const g of groups) {
      const s = g.sections.find(s => s.id === activeId)
      if (s) return s
    }
    return groups[0].sections[0]
  }, [activeId, groups])

  const printGuide = () => {
    const w = window.open('', '_blank')
    if (!w) return
    w.opener = null
    w.document.write(buildGuidePrintHtml(groups, docTitle, docSubtitle))
    w.document.close()
    w.focus()
    w.onload = () => { w.print() }
  }

  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      {/* Sidebar */}
      <div style={{ width: 240, flexShrink: 0, position: 'sticky', top: 12 }}>
        <input
          className="form-input"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search pages…"
          aria-label="Search guide pages"
          style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }}
        />
        <button
          className="btn btn-ghost"
          onClick={printGuide}
          style={{ width: '100%', marginBottom: 12 }}
        >
          🖨 Print full guide
        </button>
        <div style={{ maxHeight: 620, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {filteredGroups.map(g => (
            <div key={g.key}>
              <h2 style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--theme-text3)', margin: '0 0 6px 4px' }}>
                {g.label}
              </h2>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {g.sections.map(s => {
                  const isActive = s.id === active.id
                  return (
                    <button
                      key={s.id}
                      onClick={() => setActiveId(s.id)}
                      style={{
                        textAlign: 'left', background: isActive ? 'var(--theme-accent)' : 'transparent',
                        color: isActive ? 'var(--theme-accent-text)' : 'var(--theme-text2)', border: 'none', borderRadius: 'var(--radius-sm)',
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
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)' }}>{active.title}</h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {active.route && (
              <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--theme-accent-ink)', background: 'color-mix(in srgb, var(--theme-accent) 10%, transparent)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-xs)', padding: '2px 8px' }}>
                {active.route}
              </span>
            )}
            {active.plan && (
              <span style={{ fontSize: 11, color: 'var(--theme-text2)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-xs)', padding: '2px 8px' }}>
                {active.plan}
              </span>
            )}
          </div>
        </div>

        <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--theme-text2)', margin: '0 0 20px' }}>{active.summary}</p>

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
                  <div style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text2)' }}>{f.desc}</div>
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
                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px',
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
                <li key={i} style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--theme-amber-text)' }}>{g}</li>
              ))}
            </ul>
          </GuideSection>
        )}

        {active.connections && (
          <GuideSection title="Connects to">
            <p style={{ fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text2)', margin: 0 }}>{active.connections}</p>
          </GuideSection>
        )}
      </div>
    </div>
  )
}

// Builds a standalone, print-optimised HTML document of the entire IMS guide (every group and
// section), opened in a new window for the browser's native print dialog. Uses plain black-on-white
// inline styles rather than the app's theme tokens — a print stylesheet should never depend on the
// live theme, and a new window doesn't inherit Layout.css anyway.
function buildGuidePrintHtml(guideGroups, docTitle, docSubtitle) {
  const esc = escapeHtml

  const block = (heading, inner) => inner
    ? `<div class="block"><div class="block-h">${heading}</div>${inner}</div>`
    : ''

  const sectionHtml = (s) => {
    const meta = [s.route, s.plan].filter(Boolean).map(m => `<span class="meta">${esc(m)}</span>`).join(' ')
    const workflow = s.workflow.length
      ? `<ol>${s.workflow.map(step => `<li>${esc(step)}</li>`).join('')}</ol>` : ''
    const fields = s.fields.length
      ? s.fields.map(f => `<p><b>${esc(f.label)}</b> — ${esc(f.desc)}</p>`).join('') : ''
    const formulas = s.formulas.length
      ? s.formulas.map(f => `<pre>${esc(f)}</pre>`).join('') : ''
    const gotchas = s.gotchas.length
      ? `<ul>${s.gotchas.map(g => `<li>${esc(g)}</li>`).join('')}</ul>` : ''
    const connections = s.connections ? `<p>${esc(s.connections)}</p>` : ''
    return `<section>
      <h2>${esc(s.title)}</h2>
      ${meta ? `<div class="metas">${meta}</div>` : ''}
      <p class="summary">${esc(s.summary)}</p>
      ${block('How to use it', workflow)}
      ${block('Key fields', fields)}
      ${block('How it calculates', formulas)}
      ${block('Watch out for', gotchas)}
      ${block('Connects to', connections)}
    </section>`
  }

  const groups = guideGroups.map(g =>
    `<div class="group"><h1>${esc(g.label)}</h1>${g.sections.map(sectionHtml).join('')}</div>`
  ).join('')

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(docTitle)}</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #111; max-width: 760px; margin: 0 auto; padding: 24px; line-height: 1.5; orphans: 3; widows: 3; }
      .doc-title { font-size: 22px; font-weight: 800; margin: 0 0 4px; }
      .doc-sub { font-size: 12px; color: #666; margin: 0 0 24px; }
      .group { margin-bottom: 8px; }
      /* break-after: avoid keeps a heading glued to the content right after it, so a group/section
         title can never print alone at the bottom of a page with its content stranded on the next. */
      h1 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #96700a; border-bottom: 2px solid #96700a; padding-bottom: 4px; margin: 28px 0 12px; break-after: avoid; page-break-after: avoid; }
      /* No page-break-inside: avoid here — a section is allowed to split across a page boundary
         (between blocks) so the layout doesn't waste the rest of a page just because the whole
         section doesn't fit in the remaining space. Only the small atomic pieces below stay intact. */
      section { margin-bottom: 22px; }
      h2 { font-size: 16px; margin: 0 0 4px; break-after: avoid; page-break-after: avoid; }
      .metas { margin-bottom: 6px; break-after: avoid; page-break-after: avoid; }
      .meta { display: inline-block; font-size: 10px; font-family: monospace; color: #555; border: 1px solid #ccc; border-radius: 3px; padding: 1px 6px; margin-right: 4px; }
      .summary { font-size: 13px; margin: 0 0 12px; break-inside: avoid; page-break-inside: avoid; }
      .block { margin-bottom: 10px; }
      .block-h { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #666; margin-bottom: 4px; break-after: avoid; page-break-after: avoid; }
      ol, ul { margin: 0; padding-left: 20px; }
      li { font-size: 12.5px; margin-bottom: 4px; break-inside: avoid; page-break-inside: avoid; }
      p { font-size: 12.5px; margin: 0 0 6px; }
      pre { font-size: 11px; background: #f5f5f5; border: 1px solid #e0e0e0; border-radius: 4px; padding: 7px 9px; white-space: pre-wrap; word-break: break-word; margin: 0 0 6px; break-inside: avoid; page-break-inside: avoid; }
      @media print { body { padding: 0; } }
    </style></head><body>
    <div class="doc-title">${esc(docTitle)}</div>
    <div class="doc-sub">${esc(docSubtitle)}</div>
    ${groups}
  </body></html>`
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
