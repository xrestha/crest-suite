import { useAuth } from '../../context/AuthContext'

// Derives module flags from the clients table.
//
// NOTE: this hook appears to be dead code — a grep for the exact export name finds only this
// definition and the `shared/hooks` barrel that re-exports it, and nothing imports that barrel
// either. Left in place rather than deleted, but do not add callers without checking whether
// useAuth() already gives you what you need.
//
// pos_plan/hr_plan were removed from the return shape: Crest HR and Crest POS are yes/no modules
// with no tiers, so a "plan" for either is not something the product sells. ims_plan went too —
// it read the derived `plan`, while the clients.ims_plan column it was named after has never
// existed. Callers should use ims_enabled/pos_enabled/hr_enabled plus `plan` from useAuth().
export function useClientFeatures() {
  const { profile, isAdmin } = useAuth()
  const client = profile?.clients ?? {}

  return {
    ims_enabled: isAdmin || !!client.id,
    pos_enabled: isAdmin || (client.pos_enabled ?? false),
    hr_enabled:  isAdmin || (client.hr_enabled  ?? false),
  }
}
