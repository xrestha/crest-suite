import { moveRovingFocus, rovingTabIndex } from '../shared/rovingFocus'

// The product's tab and chip rows (S765).
//
// Before this existed, 27 files in IMS alone hand-rolled a `.tab-btn` strip and every one of them
// stopped at the same place: `aria-controls` appeared ZERO times across the whole module,
// `role="tabpanel"` zero times, and roving `tabIndex` zero times. Seven of those rows declared
// `role="tablist"` + `role="tab"` + `aria-selected` and delivered none of the rest, which is worse
// than declaring nothing — a screen reader is told a tab is selected and given no panel to
// associate it with, and the fallback reading (a plain group of buttons) is suppressed.
//
// The keyboard cost was the visible half: without a roving tabIndex every tab is its own Tab stop,
// so reaching Stock Count's 9th tab — Settings, where blind counting and recount protection live —
// took nine presses, and a keyboard user paid that on every visit.
//
// ── TWO primitives, because `.tab-btn` does two different jobs ──────────────────────────────────
//
// DESIGN.md defines `.tab-btn` as "a filter or sort control that changes what one view shows", and
// `.panel-tab` as "a *section* within one surface". Most of the rows in IMS are the former. Giving
// a filter row `role="tablist"` would be a NEW defect, not a fix: it would tell a screen reader
// that a category chip opens a panel, and it would suppress the pressed/not-pressed reading that is
// the only thing the user actually needs from it.
//
//   <Tabs>        — a real section switcher. tablist / tab / tabpanel, one panel swapped in place.
//   <FilterChips> — a set of toggles narrowing one view. role="group" + aria-pressed.
//
// Both get one Tab stop and arrow keys, from shared/rovingFocus.js rather than a private copy, so
// this row, the till's option chips and the guest sheet all answer Home/End and both arrow axes
// identically.
//
// `idBase` must be unique per rendered INSTANCE, not per page: a component rendering a compact and
// an expanded copy at once (ChartCard does) would otherwise emit duplicate DOM ids and break the
// aria-controls/aria-labelledby pair for both.

const BAR = { pill: 'tab-bar', panel: 'panel-tab-bar' }
const BTN = { pill: 'tab-btn', panel: 'panel-tab' }
const ACTIVE = { pill: 'tab-btn--active', panel: 'panel-tab--active' }

// `hasPanel` is opt-in, and deliberately so: `aria-controls` must name an element that EXISTS, and
// a dangling reference is worse than an absent one — a screen reader announces a relationship it
// then cannot follow. A page that renders <TabPanel> passes it; a page whose body is a set of
// sibling conditionals (most of the report pages) leaves it off and is announced as a plain tab
// list, which is the honest reading. Making this default to true would silently re-create the
// dangling reference on the next caller that forgets the panel.
export default function Tabs({
  idBase, label, tabs, active, onChange,
  variant = 'pill', scroll = false, hasPanel = false, className = '', style, children,
}) {
  // Automatic activation: arrowing to a tab selects it. Correct here because every panel in this
  // product is already-loaded local state — the pattern only becomes wrong when selecting a tab is
  // expensive, and none of these are.
  const onKeyDown = e => { moveRovingFocus(e, '[role="tab"]')?.click() }

  return (
    <>
      <div
        className={`${BAR[variant]}${scroll ? ' tab-bar--scroll' : ''}${className ? ` ${className}` : ''}`}
        role="tablist"
        aria-label={label}
        style={style}
        onKeyDown={onKeyDown}
      >
        {tabs.map(t => {
          const isActive = active === t.key
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`${idBase}-tab-${t.key}`}
              aria-selected={isActive}
              aria-controls={hasPanel ? `${idBase}-panel` : undefined}
              tabIndex={rovingTabIndex(isActive)}
              disabled={t.disabled}
              title={t.title}
              className={`${BTN[variant]}${isActive ? ` ${ACTIVE[variant]}` : ''}${t.className ? ` ${t.className}` : ''}`}
              onClick={() => onChange(t.key)}
            >{t.label}</button>
          )
        })}
      </div>
      {children}
    </>
  )
}

// The body the row controls. Only the ACTIVE panel is rendered in this product (every call site
// swaps content rather than mounting all panels), so one panel id is what every tab points at and
// `aria-labelledby` names whichever tab is currently selected.
//
// `tabIndex={0}` is the WAI-ARIA requirement for a panel with no focusable child of its own —
// without it, a keyboard user arrowing to a tab has nowhere to go next but out of the region.
export function TabPanel({ idBase, active, className = '', style, children }) {
  return (
    <div
      id={`${idBase}-panel`}
      role="tabpanel"
      aria-labelledby={`${idBase}-tab-${active}`}
      tabIndex={0}
      className={className}
      style={style}
    >{children}</div>
  )
}

// A set of toggles that narrows ONE view — a category strip, a status filter, a sort order.
//
// `role="group"` + `aria-pressed`, never tablist: nothing here opens a panel. Before this, 15 of 24
// such rows in IMS carried no `aria-pressed` at all, so which filter was applied was carried by
// COLOUR ALONE — invisible to a screen reader and to anyone who cannot separate the active tint
// from the resting one.
//
// `multi` is for a row where several chips can be on at once; the default is single-select, where
// exactly one chip is pressed and the row behaves like the radiogroup it resembles.
export function FilterChips({ label, options, active, onChange, multi = false, className = '', style }) {
  const onKeyDown = e => { moveRovingFocus(e, 'button:not([disabled])') }
  const isOn = key => (multi ? (active || []).includes(key) : active === key)

  return (
    <div
      className={`tab-bar${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={label}
      style={style}
      onKeyDown={onKeyDown}
    >
      {options.map(o => {
        const on = isOn(o.key)
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            disabled={o.disabled}
            title={o.title}
            tabIndex={rovingTabIndex(on || (!multi && active == null && o === options[0]))}
            className={`tab-btn${on ? ' tab-btn--active' : ''}${o.className ? ` ${o.className}` : ''}`}
            onClick={() => onChange(o.key)}
          >{o.label}</button>
        )
      })}
    </div>
  )
}
