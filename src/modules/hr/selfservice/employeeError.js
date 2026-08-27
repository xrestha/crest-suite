// The employee-facing wording of the shared error table (src/shared/errorText.js).
//
// Kept as its own named export because "employeeError" says at every call site in this module
// WHICH audience it is speaking to — the person holding the phone, who can only escalate. The
// rules themselves live in one place so an Owner-facing screen and this one can never come to
// recognise different sets of failures.
import { errorInfo } from '../../../shared/errorText'

// → { text, detail }. `text` is always safe to show; `detail` may be empty.
export const employeeError = err => errorInfo(err, 'staff')

// Convenience for the call sites that only have room for one string.
export const employeeErrorText = err => employeeError(err).text
