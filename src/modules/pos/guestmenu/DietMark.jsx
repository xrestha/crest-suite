// The veg / non-veg mark on the guest menu (S844: one copy, used by the menu row, the dish sheet and
// the combo sheet; each had its own until then). The market's own labelling symbol: an outlined
// square with a filled dot, green for veg, red for non-veg, and amber for egg, the third convention,
// which only an option's `diet` carries. The word is the accessible name.
//
// The dot stays round deliberately: this is a food-labelling mark whose shape IS its meaning, not an
// interface control, so the Modernist zero-radius rule does not reshape it (DESIGN.md). Its CSS is
// `.gm-diet` in guestMenu.css.

const DIET_MARK = {
  veg: { label: 'Vegetarian', title: 'Veg', modifier: 'gm-diet--veg' },
  egg: { label: 'Contains egg', title: 'Egg', modifier: 'gm-diet--egg' },
  non_veg: { label: 'Non-vegetarian', title: 'Non-veg', modifier: 'gm-diet--nonveg' },
}

/** `diet` is 'veg' | 'egg' | 'non_veg'; anything else draws nothing. */
export default function DietMark({ diet }) {
  const m = DIET_MARK[diet]
  if (!m) return null
  return (
    <span role="img" aria-label={m.label} title={m.title} className={`gm-diet ${m.modifier}`}>
      <span aria-hidden="true" />
    </span>
  )
}

/** A dish's `is_veg` as a diet: true → 'veg', false → 'non_veg', unknown (null) → null. */
export const dietOfDish = isVeg => (isVeg === true ? 'veg' : isVeg === false ? 'non_veg' : null)
