import { useEffect, useState } from 'react'
import ModuleGuideTab from './ModuleGuideTab'
import ActionError, { asActionError } from '../../components/ActionError'
import { recoverFromChunkError } from '../../shared/chunkReload'

// Admin Settings → Guides: one deep per-page reference guide per module, switched by the pill
// bar here. This wrapper is lazy-loaded by Settings.js, and since S878 each module's guide is a chunk
// of its own, fetched when its tab is chosen: the five files are ~780 KB of source, and the tab used
// to download all of them before the first one showed. Nothing else may import a guide data file
// statically, or it rides back into this chunk.
const MODULES = [
  {
    key: 'ims', label: 'Crest IMS', load: () => import('./imsGuideData').then(m => m.IMS_GUIDE_GROUPS),
    docTitle: 'Crest IMS — Module Guide',
    docSubtitle: 'Inventory & food-cost reference. Printed from Admin → Settings → Guides.',
  },
  {
    key: 'hr', label: 'Crest HR', load: () => import('./hrGuideData').then(m => m.HR_GUIDE_GROUPS),
    docTitle: 'Crest HR — Module Guide',
    docSubtitle: 'Payroll, attendance & staff reference. Printed from Admin → Settings → Guides.',
  },
  {
    key: 'pos', label: 'Crest POS', load: () => import('./posGuideData').then(m => m.POS_GUIDE_GROUPS),
    docTitle: 'Crest POS — Module Guide',
    docSubtitle: 'Billing, floor & kitchen reference. Printed from Admin → Settings → Guides.',
  },
  // The POS add-on (S758/S759): sits beside POS because it exists only on a client with a till.
  {
    key: 'customization', label: 'Crest Customization',
    load: () => import('./customizationGuideData').then(m => m.CUSTOMIZATION_GUIDE_GROUPS),
    docTitle: 'Crest Customization — Module Guide',
    docSubtitle: 'Sizes, extras & "No …" choices reference. Printed from Admin → Settings → Guides.',
  },
  // Last, and not a module: Crest Suite Pro is the owner layer sold on top of the three, so it
  // reads across all of them. Its four pages belonged to no module guide and therefore sat in
  // none at all until S636.
  {
    key: 'suite', label: 'Crest Suite', load: () => import('./suiteGuideData').then(m => m.SUITE_GUIDE_GROUPS),
    docTitle: 'Crest Suite — Module Guide',
    docSubtitle: 'Owner, P&L & multi-outlet reference. Printed from Admin → Settings → Guides.',
  },
]

// A guide fetched once stays for the page load, so switching back to a module shows it at once.
const loadedGroups = {}

export default function GuidesTab() {
  const [moduleKey, setModuleKey] = useState('ims')
  const mod = MODULES.find(m => m.key === moduleKey) || MODULES[0]
  const [groupsByKey, setGroupsByKey] = useState(() => ({ ...loadedGroups }))
  const [loadError, setLoadError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const groups = groupsByKey[mod.key] || null

  // Fetch the chosen module's guide unless it is already here. A failed fetch says so with a Try
  // again, never an empty guide; a deploy that replaced the files reloads onto the new build, as a
  // lazy route does.
  useEffect(() => {
    if (loadedGroups[mod.key]) return undefined
    let live = true
    setLoadError(null)
    mod.load().then(loaded => {
      loadedGroups[mod.key] = loaded
      if (live) setGroupsByKey(prev => ({ ...prev, [mod.key]: loaded }))
    }, err => {
      if (!live || recoverFromChunkError(err)) return
      setLoadError(asActionError(err, 'operator'))
    })
    return () => { live = false }
  }, [mod, attempt])

  // Roving tabindex + arrow keys. `role="tab"` PROMISES this behaviour to a screen-reader user,
  // and until S594 the markup delivered none of it: no aria-controls, no panel, no key handling,
  // so the announced tab pointed at nothing and Tab landed on all three buttons separately.
  // Incomplete ARIA is worse than none.
  function onKeyDown(e) {
    const i = MODULES.findIndex(m => m.key === moduleKey)
    let next = null
    if (e.key === 'ArrowRight') next = (i + 1) % MODULES.length
    else if (e.key === 'ArrowLeft') next = (i - 1 + MODULES.length) % MODULES.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = MODULES.length - 1
    if (next === null) return
    e.preventDefault()
    setModuleKey(MODULES[next].key)
    document.getElementById(`guide-tab-${MODULES[next].key}`)?.focus()
  }

  return (
    <div>
      <div className="tab-bar" role="tablist" aria-label="Module guide" style={{ marginBottom: 16 }}
        onKeyDown={onKeyDown}>
        {MODULES.map(m => (
          <button
            key={m.key}
            id={`guide-tab-${m.key}`}
            role="tab"
            aria-selected={m.key === mod.key}
            aria-controls={`guide-panel-${m.key}`}
            tabIndex={m.key === mod.key ? 0 : -1}
            className={`tab-btn${m.key === mod.key ? ' tab-btn--active' : ''}`}
            onClick={() => setModuleKey(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {/* key forces a remount per module: ModuleGuideTab seeds its active section once from
          groups[0], so reusing one instance across a switch would keep a stale activeId. */}
      <div role="tabpanel" id={`guide-panel-${mod.key}`} aria-labelledby={`guide-tab-${mod.key}`} tabIndex={-1}>
        {groups ? (
          <ModuleGuideTab key={mod.key} groups={groups} docTitle={mod.docTitle} docSubtitle={mod.docSubtitle} />
        ) : loadError ? (
          <div>
            <ActionError error={loadError} className="action-error--top" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAttempt(a => a + 1)}>Try again</button>
          </div>
        ) : (
          <p role="status" style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading the {mod.label} guide…</p>
        )}
      </div>
    </div>
  )
}
