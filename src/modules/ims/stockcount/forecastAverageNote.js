// The per-dish averages behind Demand Forecast's whole plates, as text (S877).
//
// The dish table shows each forecast as whole plates (`platesOf`, ceil), because "0.8" was read as
// a portion size (S694). The raw per-day average and the number of sample days behind it were on
// hover only, in a `title` (S858 took ~180 Tab stops off the table), so a keyboard, screen reader
// or phone could not reach them. The page's "Show averages" toggle adds them as a quiet second
// line, plain text with no tab stop, built here. Nothing here changes a figure: the average is the
// same `qty.toFixed(1)` the hover and the printed sheet have always shown.
//
// `sampleCount` is the day's `sample_count`: how many past days of that weekday the average comes
// from. NULL on a run written before the column existed, and 0 when no such day had sales; neither
// is a count worth printing, so the days part is left out rather than guessed.

export function sampleDaysText(sampleCount) {
  return sampleCount > 0 ? `${sampleCount} day${sampleCount === 1 ? '' : 's'}` : null
}

// Under a plate count: "avg 2.4 · 8 days".
export function plateAverageLine(qty, sampleCount) {
  const days = sampleDaysText(sampleCount)
  return `avg ${qty.toFixed(1)}${days ? ` · ${days}` : ''}`
}

// Under an occasional dish, whose average is already on screen beside its name ("(0.4/day)"), so
// only the days are added: "over 8 days", or nothing when the count is unknown.
export function occasionalAverageLine(sampleCount) {
  const days = sampleDaysText(sampleCount)
  return days ? `over ${days}` : null
}

// The bracket on the printed sheet: "(2.4)" as before, "(2.4 · 8 days)" while the toggle is on.
export function printedAverage(qty, sampleCount, showAverages) {
  const days = showAverages ? sampleDaysText(sampleCount) : null
  return `(${qty.toFixed(1)}${days ? ` · ${days}` : ''})`
}
