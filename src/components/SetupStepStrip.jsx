import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { readSetupStrip, clearSetupStrip } from '../shared/onboarding/setupStrip'
import './SetupGuide.css'

// "Setup step 2 of 5 — press + Add Vendor (bottom right)", on the page a setup-guide step opened
// (S790). Rendered once, in Layout, above every page: the guide stores the payload when Start is
// pressed, and this shows it only on that step's own page. Deliberately small and eager — it
// imports none of the step catalogue, only the few words the guide handed over.
export default function SetupStepStrip() {
  const location = useLocation()
  const navigate = useNavigate()
  const [payload, setPayload] = useState(() => readSetupStrip())

  useEffect(() => { setPayload(readSetupStrip()) }, [location.pathname])

  if (!payload || payload.route !== location.pathname) return null

  const close = () => { clearSetupStrip(); setPayload(null) }

  return (
    <div className="setup-strip no-print" role="status">
      <div className="setup-strip__body">
        <span className="setup-strip__step">
          Setup step {payload.n} of {payload.of}{payload.group ? ` · ${payload.group}` : ''}
        </span>
        <span className="setup-strip__label">{payload.label}</span>
        {payload.strip && <span className="setup-strip__do">{payload.strip}</span>}
      </div>
      <div className="setup-strip__actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/dashboard')}>
          Back to setup guide
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={close} aria-label="Close this setup tip" title="Close this setup tip">
          ×
        </button>
      </div>
    </div>
  )
}
