import { useAuth } from '../../context/AuthContext'
import { scopedFrom, scopedInsert, scopedUpsert, scopedUpdate, scopedDelete } from '../scopedDb'

// Binds scopedDb's functions to the current session's clientId so call sites don't have to
// thread it through themselves. See scopedDb.js for what each function actually guards.
export function useScopedDb() {
  const { clientId } = useAuth()
  return {
    clientId,
    scopedFrom:   (table, columns) => scopedFrom(table, clientId, columns),
    scopedInsert: (table, row) => scopedInsert(table, clientId, row),
    scopedUpsert: (table, rows, options) => scopedUpsert(table, clientId, rows, options),
    scopedUpdate: (table, patch) => scopedUpdate(table, clientId, patch),
    scopedDelete: (table) => scopedDelete(table, clientId),
  }
}
