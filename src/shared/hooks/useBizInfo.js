import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { supabase } from '../../supabaseClient'

/**
 * `{ name, vat, address, vatReg, error }` for the active client — what an Excel export or a printed
 * document puts in its letterhead.
 *
 * VAT number, address and registration status already live in SettingsContext, so only the client
 * NAME needs a fetch, and `clients` stays on raw supabase.from() (it is the one table scopedDb
 * does not cover). Before this, every page that wanted a letterhead re-implemented the whole
 * settings-plus-client read; see [[excelLetterhead]] for the other half of that duplication.
 *
 * `error` (S754) is the client-name read's error object, or null. The read used to take `data` and
 * drop `error`, so a failed read shipped every workbook with a blank `CompanyName :` line and nothing
 * on the page said so. It is a field rather than a throw so every existing consumer keeps working
 * unchanged; a page that exports should disable its export while it is set (the S728 rule for a
 * figure-bearing control), and may show `ReportLoadError`-style copy for it.
 */
export function useBizInfo() {
  const { clientId, profile } = useAuth()
  const { settings } = useSettings()
  const effectiveClientId = clientId || profile?.client_id
  const [name, setName] = useState('')
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    if (!effectiveClientId) { setName(''); return }
    supabase.from('clients').select('name').eq('id', effectiveClientId).maybeSingle()
      .then(({ data, error: readError }) => {
        if (cancelled) return
        if (readError) { setName(''); setError(readError); return }
        setName(data?.name || '')
      })
    return () => { cancelled = true }
  }, [effectiveClientId])

  return {
    name,
    vat: settings?.vat_number || '',
    address: settings?.property_address || '',
    vatReg: settings?.is_vat_registered ?? true,
    error,
  }
}
