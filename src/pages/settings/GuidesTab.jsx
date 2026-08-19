import { useState } from 'react'
import ModuleGuideTab from './ModuleGuideTab'
import { IMS_GUIDE_GROUPS } from './imsGuideData'
import { HR_GUIDE_GROUPS } from './hrGuideData'
import { POS_GUIDE_GROUPS } from './posGuideData'

// Admin Settings → Guides: one deep per-page reference guide per module, switched by the pill
// bar here. This wrapper (and everything it imports — the component plus all three data files)
// is lazy-loaded by Settings.js so the guide prose lives in its own on-demand chunk: the tab is
// admin-only, and before this split ~1200 lines of admin-only strings shipped inside the Settings
// chunk to every client login that opened Settings.
const MODULES = [
  {
    key: 'ims', label: 'Crest IMS', groups: IMS_GUIDE_GROUPS,
    docTitle: 'Crest IMS — Module Guide',
    docSubtitle: 'Inventory & food-cost reference. Printed from Admin → Settings → Guides.',
  },
  {
    key: 'hr', label: 'Crest HR', groups: HR_GUIDE_GROUPS,
    docTitle: 'Crest HR — Module Guide',
    docSubtitle: 'Payroll, attendance & staff reference. Printed from Admin → Settings → Guides.',
  },
  {
    key: 'pos', label: 'Crest POS', groups: POS_GUIDE_GROUPS,
    docTitle: 'Crest POS — Module Guide',
    docSubtitle: 'Billing, floor & kitchen reference. Printed from Admin → Settings → Guides.',
  },
]

export default function GuidesTab() {
  const [moduleKey, setModuleKey] = useState('ims')
  const mod = MODULES.find(m => m.key === moduleKey) || MODULES[0]

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
        <ModuleGuideTab key={mod.key} groups={mod.groups} docTitle={mod.docTitle} docSubtitle={mod.docSubtitle} />
      </div>
    </div>
  )
}
