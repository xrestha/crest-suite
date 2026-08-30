/**
 * The message shown when an ACTION failed — a save, a delete, a post. The third member of a family
 * whose other two already exist: `FieldError` speaks for one control, `ReportLoadError` speaks for
 * a whole report that could not be read, and this one speaks for the thing the user just pressed.
 *
 * It exists because that third case was hand-rolled at ~20 sites in IMS alone, every one of them
 * as `{error && <p style={{ color: 'var(--theme-red-text)', fontSize: 13 }}>{error}</p>}` — and
 * what those paragraphs were handed was, at most of them, `error.message` straight from Postgres.
 * "duplicate key value violates unique constraint" is not a sentence a restaurant owner can act on,
 * and "TypeError: Failed to fetch" — supabase-js's rendering of every dropped connection — is worse
 * than useless: it names a JavaScript type where the reader needed to know whether their bill saved.
 * See shared/errorText.js for that rule and the audiences behind it.
 *
 * TWO PARTS, because the failure has two readers at different moments. `text` is the sentence the
 * owner acts on. `detail` is the code and the raw message, kept because whoever eventually
 * diagnoses this still needs it — quiet, small, and never the headline.
 *
 *   const { error, setError } = ...
 *   if (err) { setError(asActionError(err, 'operator')); return }   // a failure
 *   setError('Add at least one item with a quantity.')              // a validation message
 *   ...
 *   <ActionError error={error} />
 *
 * A plain string passes through untouched, so the validation copy a form already writes by hand is
 * never run through the error table and flattened into "that didn't work". Only a real error object
 * goes through `asActionError`, and only at the call site — the audience ('operator' for an owner
 * or manager who can fix it, 'staff' for someone who can only escalate) is a fact about who is
 * looking at that screen, which a render-time component has no way to know.
 */
import { errorInfo } from '../shared/errorText'

/** Turn a Supabase/Postgres error into what `<ActionError>` renders. */
export function asActionError(err, audience = 'operator') {
  const { text, detail } = errorInfo(err, audience)
  return { text, detail }
}

/** `role="alert"` so the failure is announced at the moment it appears — a user who pressed Save
 *  and heard nothing has been told the save succeeded. */
export default function ActionError({ error, className = '' }) {
  if (!error) return null
  const { text, detail } = typeof error === 'string' ? { text: error, detail: '' } : error
  if (!text) return null
  return (
    <div className={`action-error ${className}`.trim()} role="alert">
      <p className="action-error-text">{text}</p>
      {detail && <p className="action-error-detail">{detail}</p>}
    </div>
  )
}
