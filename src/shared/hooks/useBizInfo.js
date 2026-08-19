import { useEffect, useState } from 'react'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { supabase } from '../../supabaseClient'

/**
 * `{ name, vat, address, vatReg }` for the active client — what an Excel export or a printed
 * document puts in its letterhead.
 *
 * VAT number, address and registration status already live in SettingsContext, so only the client
 * NAME needs a fetch, and `clients` stays on raw supabase.from() (it is the one table scopedDb
 * does not cover). Before this, every page that wanted a letterhead re-implemented the whole
 * settings-plus-client read; see [[excelLetterhead]] for the other half of that duplication.
 */
export function useBizInfo() {
  const { clientId, profile } = useAuth()
  const { settings } = useSettings()
  const effectiveClientId = clientId || profile?.client_id
  const [name, setName] = useState('')

  useEffect(() => {
    let cancelled = false
    if (!effectiveClientId) { setName(''); return }
    supabase.from('clients').select('name').eq('id', effectiveClientId).maybeSingle()
      .then(({ data }) => { if (!cancelled) setName(data?.name || '') })
    return () => { cancelled = true }
  }, [effectiveClientId])

  return {
    name,
    vat: settings?.vat_number || '',
    address: settings?.property_address || '',
    vatReg: settings?.is_vat_registered ?? true,
  }
}
