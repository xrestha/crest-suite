import './dietMark.css'

// The veg / egg / non-veg food mark (S844: one copy, used by the guest menu's rows, dish sheet and
// combo sheet; S846: the till's menu tiles and choice window too). The market's own labelling
// symbol: an outlined square with a filled shape inside. The shape carries the meaning as well as
// the colour (S846, owner decision), so the mark still reads under colour-blindness, in a
// forced-colours mode and on a black-and-white print:
//   veg      a round dot, green;
//   non_veg  a triangle pointing up, red;
//   egg      a bold capital E, amber (drawn as a path, so it does not depend on a font).
// The word is the accessible name; `DietLabel` prints it beside the mark.
//
// The dot stays round deliberately: this is a food-labelling mark whose shape IS its meaning, not an
// interface control, so the Modernist zero-radius rule does not reshape it (DESIGN.md). The square
// stays square. Its CSS is dietMark.css, unscoped so the till gets it as well as the guest menu.

/** The words for each diet: `short` beside a mark, `long` as its accessible name or where there is room. */
export const DIET_WORDS = {
  veg: { short: 'Veg', long: 'Vegetarian' },
  egg: { short: 'Egg', long: 'Contains egg' },
  non_veg: { short: 'Non-veg', long: 'Non-vegetarian' },
}

/** The kinds in the order a key lists them. */
export const DIET_ORDER = ['veg', 'egg', 'non_veg']

const MODIFIER = { veg: 'diet-mark--veg', egg: 'diet-mark--egg', non_veg: 'diet-mark--nonveg' }

// The filled shape inside the square, on a 12 × 12 grid. The triangle and the E are sized to the same
// optical weight; the E's bars are 1.5 thick with a 1-unit gap, so it holds together at 12px.
const TRIANGLE = 'M6 2.75L9.25 8.75H2.75Z'
const LETTER_E = 'M3.75 2.75H8.25V4.25H5.5V5.25H7.75V6.75H5.5V7.75H8.25V9.25H3.75Z'

function Shape({ diet }) {
  if (diet === 'veg') return <circle data-shape="dot" cx="6" cy="6" r="3" fill="currentColor" />
  if (diet === 'non_veg') return <path data-shape="triangle" d={TRIANGLE} fill="currentColor" />
  return <path data-shape="egg" d={LETTER_E} fill="currentColor" />
}

/**
 * `diet` is 'veg' | 'egg' | 'non_veg'; anything else draws nothing. `decorative` drops the
 * accessible name, for a mark printed beside its own word (the name would be read twice).
 * `className` is added to the mark's own (`diet-mark--lead` puts 4px after it, before a name).
 */
export default function DietMark({ diet, decorative = false, className = '' }) {
  const words = DIET_WORDS[diet]
  if (!words) return null
  const a11y = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': words.long }
  return (
    <span {...a11y} title={words.short} className={`diet-mark ${MODIFIER[diet]}${className ? ` ${className}` : ''}`}>
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
        <rect x=".75" y=".75" width="10.5" height="10.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <Shape diet={diet} />
      </svg>
    </span>
  )
}

/**
 * The mark with its word printed beside it: "Veg", "Egg", "Non-veg", or with `long` "Vegetarian",
 * "Contains egg", "Non-vegetarian". The mark is decorative here, because the word is the name.
 */
export function DietLabel({ diet, long = false, className = '' }) {
  const words = DIET_WORDS[diet]
  if (!words) return null
  return (
    <span className={`diet-label${className ? ` ${className}` : ''}`}>
      <DietMark diet={diet} decorative />{long ? words.long : words.short}
    </span>
  )
}

/**
 * A dish's diet from its two recipe columns — the one read rule. `is_veg` true → 'veg' (whatever
 * `is_egg` says); `is_veg` false with `is_egg` true → 'egg'; `is_veg` false → 'non_veg'; `is_veg`
 * unknown (null or undefined) → null, not stated. `is_egg` may be undefined on a database without
 * the column (S846), which reads as no egg.
 */
export const dietOfDish = (isVeg, isEgg) => (
  isVeg === true ? 'veg'
    : isVeg === false ? (isEgg === true ? 'egg' : 'non_veg')
      : null
)
