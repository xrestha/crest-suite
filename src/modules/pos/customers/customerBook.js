// What the Customers tab holds after a read of the customer book (S833, S809.4 3l).
//
// `prev` and the result are { clientId, rows, error, stale }: `rows` null until a read has landed for
// that outlet, `error` a failed read with nothing to show (the error card, S754), `stale` a failed
// reload over a list already on screen. A reload that fails keeps the list it had and says so, rather
// than blanking a book the page did read. A failed first read, or a failed read for another outlet,
// shows the error and no list: never another outlet's customers, and never an empty book standing in
// for one that could not be read ("No customers yet" is a statement about the book).
export function customerBookAfterRead(prev, clientId, { data, error }) {
  if (!error) return { clientId, rows: data || [], error: null, stale: null }
  if (prev?.rows && prev.clientId === clientId) return { ...prev, error: null, stale: error }
  return { clientId, rows: null, error, stale: null }
}
