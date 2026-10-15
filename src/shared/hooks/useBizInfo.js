import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { supabase } from '../../supabaseClient'
import { settleWithin } from '../../utils/withTimeout'

// The client-name read is one row; a hung one would hold every export off with nothing said, so it
// gives up and reports itself as a failed read, which every consumer already words.
export const BIZ_NAME_READ_MS = 20000

/**
 * `{ name, vat, address, vatReg, error, ready }` for the active client — what an Excel export or a
 * printed document puts in its letterhead.
 *
 * VAT number, address and registration status already live in SettingsContext, so only the client
 * NAME needs a fetch, and `clients` stays on raw supabase.from() (it is the one table scopedDb
 * does not cover). Before this, every page that wanted a letterhead re-implemented the whole
 * settings-plus-client read; see [[excelLetterhead]] for the other half of that duplication.
 *
 * `error` (S754) is the client-name read's error object, or null. The read used to take `data` and
 * drop `error`, so a failed read shipped every workbook with a blank `CompanyName :` line and nothing
 * on the page said so. It is a field rather than a throw so every existing consumer keeps working
 * unchanged; a page shows `ReportLoadError`-style copy for it.
 *
 * `ready` (S845) is true once the read has answered without an error, and false before that, after
 * a failure, and while a client switch re-reads. An export or print GATES ON `ready`, never on
 * `!error` alone: before the read lands `error` is null and `name` is '', so a press in the first
 * moment shipped a blank company name (found S844 on three POS reports, then ~20 IMS ones).
 */
export function useBizInfo() {
  const { clientId, profile } = useAuth()
  const { settings } = useSettings()
  const effectiveClientId = clientId || profile?.client_id
  const [name, setName] = useState('')
  const [error, setError] = useState(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setReady(false)
    if (!effectiveClientId) { setName(''); return }
    settleWithin(supabase.from('clients').select('name').eq('id', effectiveClientId).maybeSingle(),
      BIZ_NAME_READ_MS, "Loading your business's name")
      .then(({ data, error: readError }) => {
        if (cancelled) return
        if (readError) { setName(''); setError(readError); return }
        setName(data?.name || '')
        setReady(true)
      })
    return () => { cancelled = true }
  }, [effectiveClientId])

  return {
    name,
    vat: settings?.vat_number || '',
    address: settings?.property_address || '',
    vatReg: settings?.is_vat_registered ?? true,
    error,
    ready,
  }
}
