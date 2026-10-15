// The first rows of a long register, a page at a time (S842).
//
// The Bill Register and the KOT Register rendered every row they read, and fetchAllRows allows
// 1,00,000: a quarter's tickets is tens of thousands of table rows mounted at once, which locks a
// tablet for seconds on every re-render. The page renders `slice(rows)`; its totals, Excel export
// and anything else that counts keep reading the full list. ShowMoreRows is the control.
//
// - `resetKey` names what the rows are OF (the range, the filters). A new key starts again at one
//   page; a reload of the same range keeps what the reader opened.
// - A browser print renders every row: paper cannot press "Show more", and a printed register that
//   stops at row 200 under a TOTAL for all of them is a short document that looks complete. React
//   commits the `beforeprint` update synchronously (flushSync), before the print is laid out.
import { useState, useEffect } from 'react'
import { flushSync } from 'react-dom'

export const ROW_WINDOW_STEP = 200

export function useRowWindow(resetKey, step = ROW_WINDOW_STEP) {
  const [limit, setLimit] = useState(step)
  const [keyShown, setKeyShown] = useState(resetKey)
  const [printing, setPrinting] = useState(false)
  // Reset during render, React's "adjust state when a prop changes" pattern: an effect would paint
  // the new range's rows once at the old count first.
  if (keyShown !== resetKey) {
    setKeyShown(resetKey)
    setLimit(step)
  }

  useEffect(() => {
    const before = () => flushSync(() => setPrinting(true))
    const after = () => setPrinting(false)
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])

  const cap = printing ? Infinity : limit
  return {
    step,
    /** The rows to render: the first `limit` of `rows`, or all of them while printing. */
    slice: rows => (rows.length > cap ? rows.slice(0, cap) : rows),
    showMore: () => setLimit(n => n + step),
    showAll: () => setLimit(Infinity),
    showFirst: () => setLimit(step),
  }
}
