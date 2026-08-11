// Shared motion settings for every Recharts series in the app (Line/Bar/Area/Pie/Scatter).
//
// Why this exists at all: Recharts animates by interpolating SVG attributes in JavaScript, not
// through CSS transitions. That means no stylesheet rule reaches it — including the
// `@media (prefers-reduced-motion: reduce)` blocks in Layout.css that already cover the sidebar,
// the skeletons, and the ChartCard expand sequence. Before this module, a user who had asked
// their OS for less motion still got the full 1500ms chart animation on every chart in the
// product, on mount AND on every data change. This is the only place that gate can live.
//
// Duration: Recharts' own default is 1500ms (verified in node_modules/recharts/types — the
// defaults are `animationDuration: 1500, animationEasing: "ease"`). On a dashboard that mounts
// four charts at once that reads as the page still loading rather than as motion, and it is
// nearly double the 800ms ceiling the design guidance puts on even a deliberately authored
// entrance. 450ms puts a chart series in the same band as the ChartCard expand sequence it
// usually arrives inside (panel 180ms, stat strip settling ~410ms), so the chart resolves with
// the rest of the card instead of a second after it.
//
// Easing: Recharts accepts only 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'linear' —
// a cubic-bezier() string is not valid here, so Layout.css's --ease-entrance curve deliberately
// cannot be mirrored. 'ease-out' is the nearest available shape (fast start, settling tail);
// the default 'ease' eases in as well, which reads as hesitation on a short duration.
//
// Usage — spread onto the series element, not the chart container:
//   import { chartMotion } from '../../shared/chartMotion'
//   <Line type="monotone" dataKey="fc" {...chartMotion()} />
//
// Call it per render rather than importing a frozen object: the media query is re-read each
// time, so a mid-session OS change is picked up on the component's next render without any
// subscription. Same live-read approach GuestMenu.jsx already uses for its own motion check.

const REDUCE_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.(REDUCE_MOTION_QUERY)?.matches
}

export const CHART_ANIMATION_MS = 450

export function chartMotion() {
  // isAnimationActive:false alone is enough to stop the animation; the 0 duration is belt-and-
  // braces for any Recharts internal that reads the duration before checking the flag.
  if (prefersReducedMotion()) {
    return { isAnimationActive: false, animationDuration: 0 }
  }
  return {
    isAnimationActive: true,
    animationDuration: CHART_ANIMATION_MS,
    animationEasing: 'ease-out',
  }
}
