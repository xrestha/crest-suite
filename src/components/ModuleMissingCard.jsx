import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { customizationState } from '../utils/subscription'
import SupportContactLine from './SupportContactLine'

const MODULE_LABELS = { ims: 'Crest IMS', hr: 'Crest HR', pos: 'Crest POS', customization: 'Crest Customization' }

/**
 * What a reader sees on a page that belongs to a module their subscription does not include.
 *
 * WHY (S683): four gates, four grammars. ModuleGate was three silent `<Navigate to="/dashboard">`
 * — a client whose HR had lapsed clicked HR, landed on the dashboard, and was told nothing.
 * SuiteGate's module-missing card said "Contact your consultant" with no phone, no email and no
 * link, the only gate not using useSupportContact(). Both now render this: it names the module,
 * says the data is untouched, and gives the OWNER a way to act — while a staff login, who cannot
 * buy anything, is told who can, rather than handed a sales pitch.
 *
 * `what` is the thing that needs the module ("Owner Dashboard", or "This page" from a bare
 * route); `modules` the missing ones. Rendered in place, inside the shell, so the sidebar stays.
 * `anyOf` is a route either module opens (ModuleGate's `anyOf`, /menu-pricing): it needs one OR
 * the other, while both are missing.
 *
 * S862 ADD-7: ModuleGate renders it at last. Customization also goes off a week after its paid-up
 * date (customizationState), so a lapsed one is told that, never that it was not bought.
 */
export default function ModuleMissingCard({ what = 'This page', modules = [], anyOf = false }) {
  const { isOwner, isAdmin, profile } = useAuth()
  const names = modules.map(m => MODULE_LABELS[m] || m)
  const list = names.join(' and ')
  const needs = names.join(anyOf ? ' or ' : ' and ')
  const verb = names.length > 1 ? 'are' : 'is'
  const canBuy = isOwner || isAdmin
  const lapsed = modules.length === 1 && modules[0] === 'customization' && customizationState(profile?.clients).lapsed

  return (
    <div className="card" style={{ textAlign: 'center', padding: '48px 24px', maxWidth: 560, margin: '0 auto' }}>
      <div style={{ fontSize: 32, marginBottom: 12 }} aria-hidden="true">⊛</div>
      <p style={{ fontSize: 15, color: 'var(--theme-text1)', fontWeight: 600, margin: '0 0 8px' }}>
        {what} needs {needs}
      </p>
      <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px', lineHeight: 1.6 }}>
        {lapsed ? `${list} has passed its paid-up date, so it is switched off for now.` : `${list} ${verb} not on this subscription yet.`}{' '}
        {canBuy
          ? (lapsed ? 'Ask us to renew it — everything you already set up stays as it is.' : 'Ask us to switch it on — everything you already record stays as it is.')
          : 'It is switched on for the whole outlet, not per login — ask the account owner.'}
      </p>
      {canBuy && <SupportContactLine variant="buttons" />}
      <div style={{ marginTop: 16 }}>
        <Link to="/dashboard" className="btn btn-ghost" style={{ textDecoration: 'none' }}>Go to Dashboard</Link>
      </div>
    </div>
  )
}
