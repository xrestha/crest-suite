/**
 * The body of every period-close ConfirmModal: the consequence copy, then the preflight notes.
 *
 * One component rather than a `closeBody` closure per page, so the Dashboard's close and the
 * three closes on Periods render the same note the same way (S683). Red is the closing-count
 * ZERO branch — the one that freezes wrong figures. Amber is a note that says the close is
 * permitted but this is not the usual case (payroll still open). Everything else is quiet.
 *
 * `main` is a plain sentence; pass `children` instead when the ask has structure (the
 * Dashboard's bullet list). Falsy notes are skipped, so a caller can pass `hrOn ? note : null`.
 */
export default function CloseConfirmBody({ main, notes = [], children }) {
  return (
    <>
      {children ?? <p style={{ margin: 0 }}>{main}</p>}
      {notes.filter(Boolean).map((n, i) => (
        <p
          key={i}
          style={{
            margin: '10px 0 0',
            fontWeight: n.danger ? 700 : 400,
            color: n.danger ? 'var(--theme-red-text)' : n.warn ? 'var(--theme-amber-text)' : 'var(--theme-text2)',
          }}
        >
          {n.text}
        </p>
      ))}
    </>
  )
}
