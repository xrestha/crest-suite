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

  return (
    <div>
      <div className="tab-bar" role="tablist" aria-label="Module guide" style={{ marginBottom: 16 }}>
        {MODULES.map(m => (
          <button
            key={m.key}
            role="tab"
            aria-selected={m.key === mod.key}
            className={`tab-btn${m.key === mod.key ? ' tab-btn--active' : ''}`}
            onClick={() => setModuleKey(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>
      {/* key forces a remount per module: ModuleGuideTab seeds its active section once from
          groups[0], so reusing one instance across a switch would keep a stale activeId. */}
      <ModuleGuideTab key={mod.key} groups={mod.groups} docTitle={mod.docTitle} docSubtitle={mod.docSubtitle} />
    </div>
  )
}
