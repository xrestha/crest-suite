// Admin → Clients → Manage → Legal.
//
// Two jobs that belong together: recording who the counterparty legally IS (which no column in this
// schema could hold until the 20260903140000 migration), and recording what they have agreed to.
//
// The entity fields are here rather than on the client's own Settings page deliberately. They are
// the counterparty details on a contract — recorded by the operator drawing it up, not the
// client's to revise unilaterally — and /settings is behind ModuleGate module="ims" anyway, so a
// POS-only client could never have reached them.

import { useEffect, useMemo, useState } from 'react'

import { supabase } from '../../supabaseClient'
import { withTimeout } from '../../utils/withTimeout'
import ActionError, { asActionError } from '../../components/ActionError'
import Tip from '../../components/Tip'
import { nepalTime, nepalDateLong } from '../../shared/nepalTime'
import { adminOp } from '../../shared/adminOp'
import { DOC_TYPES, legalDoc, legalVersionPath, acceptancePayload, legalReadiness } from '../../legal'

const FIELD_ROW = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 12 }

const METHOD_LABEL = {
  clickwrap_trial: 'Online at signup',
  clickwrap_reaccept: 'Online',
  signed_paper: 'Signed paper',
}
const DOC_LABEL = {
  terms: 'Terms of Service',
  privacy: 'Privacy Policy',
  subscription_agreement: 'Subscription Agreement',
}

const AGREEMENT_STATUS_LABEL = {
  none: 'Nothing on record',
  trial_accepted: 'Trial clickwrap accepted',
  paper_pending: 'Agreement sent, awaiting signature',
  paper_signed: 'Signed paper agreement on file',
}

export default function ClientLegalTab({ client, clientSettings, onClientChanged }) {
  const [form, setForm] = useState({
    legal_name: '', pan_no: '', registered_address: '', signatory_name: '', signatory_title: '',
    agreement_status: 'none',
  })
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [saveErr, setSaveErr] = useState(null)

  const [rows, setRows] = useState(null)
  const [loadErr, setLoadErr] = useState(null)

  const [paper, setPaper] = useState({ signatory_name: '', signatory_title: '', signed_on_date: '', stamped: true })
  const [recording, setRecording] = useState(false)
  const [paperErr, setPaperErr] = useState(null)

  useEffect(() => {
    setForm({
      legal_name:         client.legal_name || '',
      // Prefilled from the client's own VAT number where they have entered one, so nobody types
      // the same number twice — but STORED separately, because settings is client-editable
      // print-header data and a contract party is not.
      pan_no:             client.pan_no || clientSettings?.vat_number || '',
      registered_address: client.registered_address || clientSettings?.property_address || '',
      signatory_name:     client.signatory_name || client.contact_person || '',
      signatory_title:    client.signatory_title || '',
      agreement_status:   client.agreement_status || 'none',
    })
  }, [client, clientSettings])

  const loadRows = useMemo(() => async () => {
    setRows(null)
    setLoadErr(null)
    try {
      const { data, error } = await withTimeout(
        supabase
          .from('legal_acceptances')
          .select('id, doc_type, doc_version, content_sha256, method, accepted_at, ip_address, user_email, signatory_name, signatory_title, signed_on_date, stamped')
          .eq('client_id', client.id)
          .order('accepted_at', { ascending: false }),
        20000,
        'Loading acceptance history'
      )
      // An empty table on this screen is a claim that this client has agreed to nothing, which is
      // exactly the sort of thing an operator would act on. A failed read must not be able to say it.
      if (error) setLoadErr(asActionError(error, 'operator'))
      else setRows(data || [])
    } catch (e) {
      setLoadErr(asActionError(e, 'operator'))
    }
  }, [client.id])

  useEffect(() => { loadRows() }, [loadRows])

  async function saveEntity() {
    setSaving(true); setSaveErr(null); setSaveMsg('')
    try {
      const { error } = await withTimeout(
        supabase.from('clients').update({
          legal_name:         form.legal_name.trim() || null,
          pan_no:             form.pan_no.trim() || null,
          registered_address: form.registered_address.trim() || null,
          signatory_name:     form.signatory_name.trim() || null,
          signatory_title:    form.signatory_title.trim() || null,
          agreement_status:   form.agreement_status,
        }).eq('id', client.id),
        20000,
        'Saving legal details'
      )
      if (error) throw error
      setSaveMsg('Legal details saved.')
      onClientChanged?.()
    } catch (e) {
      setSaveErr(asActionError(e, 'operator'))
    } finally {
      setSaving(false)
    }
  }

  async function recordPaper() {
    setRecording(true); setPaperErr(null)
    try {
      // Records the agreement AND the two documents it incorporates by reference, because Part 3
      // of the printed agreement lists their versions and hashes — signing it is an acceptance of
      // those exact texts, and recording only the agreement would lose which ones.
      const payload = acceptancePayload()
      const agreement = { version: '1.0', sha256: (legalDoc('terms')?.sha256) || '' }
      await adminOp('record_paper_agreement', {
        client_id: client.id,
        signatory_name: paper.signatory_name.trim(),
        signatory_title: paper.signatory_title.trim() || null,
        signed_on_date: paper.signed_on_date,
        stamped: paper.stamped,
        accepted_legal: { ...payload, subscription_agreement: agreement },
      })
      setPaper({ signatory_name: '', signatory_title: '', signed_on_date: '', stamped: true })
      await loadRows()
      onClientChanged?.()
    } catch (e) {
      setPaperErr(asActionError(e, 'operator'))
    } finally {
      setRecording(false)
    }
  }

  const paperReady = paper.signatory_name.trim() && paper.signed_on_date

  return (
    <div>
      {!legalReadiness().ready && (
        <div className="badge-amber" style={{ display: 'block', padding: '10px 12px', marginBottom: 16, lineHeight: 1.5 }}>
          Not ready to publish — still missing {legalReadiness().missing.join(', ')}. Do not send an
          agreement to a client until these are filled in and the pages are republished.
        </div>
      )}

      {/* ── Counterparty ───────────────────────────────────────────────────────────────── */}
      <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>
        Legal entity
      </p>

      <div style={FIELD_ROW}>
        <div className="form-field">
          <label htmlFor="legal-name">
            <Tip text="The registered name of the business as it appears on its company registration — not the trading name shown in the app.">
              <span>Registered legal name</span>
            </Tip>
          </label>
          <input id="legal-name" value={form.legal_name}
            onChange={e => setForm(f => ({ ...f, legal_name: e.target.value }))}
            placeholder={client.name} />
        </div>
        <div className="form-field">
          <label htmlFor="legal-pan">
            <Tip text="The client's PAN / VAT number as the counterparty on the agreement. Prefilled from the VAT number they entered in Settings, but stored separately — that one is theirs to edit and this one is the contract record.">
              <span>PAN / VAT no.</span>
            </Tip>
          </label>
          <input id="legal-pan" value={form.pan_no}
            onChange={e => setForm(f => ({ ...f, pan_no: e.target.value }))} />
        </div>
      </div>

      <div className="form-field" style={{ marginBottom: 12 }}>
        <label htmlFor="legal-address">Registered office address</label>
        <input id="legal-address" value={form.registered_address}
          onChange={e => setForm(f => ({ ...f, registered_address: e.target.value }))} />
      </div>

      <div style={FIELD_ROW}>
        <div className="form-field">
          <label htmlFor="legal-signatory">
            <Tip text="The person authorised to bind the business — whose name and signature go on the agreement.">
              <span>Authorised signatory</span>
            </Tip>
          </label>
          <input id="legal-signatory" value={form.signatory_name}
            onChange={e => setForm(f => ({ ...f, signatory_name: e.target.value }))} />
        </div>
        <div className="form-field">
          <label htmlFor="legal-title">Signatory title</label>
          <input id="legal-title" value={form.signatory_title}
            onChange={e => setForm(f => ({ ...f, signatory_title: e.target.value }))}
            placeholder="Proprietor / Managing Director" />
        </div>
      </div>

      <div className="form-field" style={{ marginBottom: 14 }}>
        <label htmlFor="legal-status">Agreement status</label>
        <select id="legal-status" className="form-select" value={form.agreement_status}
          onChange={e => setForm(f => ({ ...f, agreement_status: e.target.value }))}>
          {Object.entries(AGREEMENT_STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {saveErr && <ActionError error={saveErr} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <button type="button" className="btn btn-primary" onClick={saveEntity} disabled={saving}>
          {saving ? 'Saving…' : 'Save legal details'}
        </button>
        <a
          className="btn btn-ghost"
          href={`/legal/subscription-agreement/print?client=${client.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Generate agreement ↗
        </a>
        {saveMsg && <span style={{ fontSize: 12, color: 'var(--theme-green-text)' }}>{saveMsg}</span>}
      </div>
      <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 26px', lineHeight: 1.5 }}>
        Save before generating — the agreement is filled from these fields.
      </p>

      {/* ── Record a signed agreement ──────────────────────────────────────────────────── */}
      <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>
        Record a signed paper agreement
      </p>
      <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 12px', lineHeight: 1.55 }}>
        Once the client returns a signed and stamped original. This writes a permanent acceptance
        record for the agreement and for the Terms and Privacy Policy versions it incorporates.
      </p>

      <div style={FIELD_ROW}>
        <div className="form-field">
          <label htmlFor="paper-name">Who signed *</label>
          <input id="paper-name" value={paper.signatory_name}
            onChange={e => setPaper(p => ({ ...p, signatory_name: e.target.value }))} />
        </div>
        <div className="form-field">
          <label htmlFor="paper-title">Their title</label>
          <input id="paper-title" value={paper.signatory_title}
            onChange={e => setPaper(p => ({ ...p, signatory_title: e.target.value }))} />
        </div>
      </div>
      <div style={FIELD_ROW}>
        <div className="form-field">
          <label htmlFor="paper-date">Date signed (AD) *</label>
          <input id="paper-date" type="date" value={paper.signed_on_date}
            onChange={e => setPaper(p => ({ ...p, signed_on_date: e.target.value }))} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer', alignSelf: 'end', paddingBottom: 8 }}>
          <input type="checkbox" checked={paper.stamped}
            onChange={e => setPaper(p => ({ ...p, stamped: e.target.checked }))}
            style={{ width: 16, height: 16, accentColor: 'var(--theme-accent)' }} />
          <span>Company seal / stamp applied</span>
        </label>
      </div>

      {paperErr && <ActionError error={paperErr} />}
      <button type="button" className="btn" onClick={recordPaper} disabled={!paperReady || recording}
        style={{ marginBottom: 28 }}>
        {recording ? 'Recording…' : 'Record signed agreement'}
      </button>

      {/* ── History ────────────────────────────────────────────────────────────────────── */}
      <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 10px' }}>
        Acceptance history
      </p>

      {loadErr ? (
        <ActionError error={loadErr} />
      ) : rows === null ? (
        <p style={{ fontSize: 13, color: 'var(--theme-text3)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
          Nothing on record. This client predates the acceptance flow — get a signed agreement, or
          publish a version that requires re-acceptance so they are asked at next login.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Ver.</th>
                <th>How</th>
                <th>Who</th>
                <th>When</th>
                <th>From</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>
                    <a href={legalVersionPath(r.doc_type, r.doc_version)} target="_blank" rel="noopener noreferrer" className="btn-linklike">
                      {DOC_LABEL[r.doc_type] || r.doc_type}
                    </a>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{r.doc_version}</td>
                  <td>
                    {METHOD_LABEL[r.method] || r.method}
                    {r.method === 'signed_paper' && r.stamped && (
                      <span className="badge-yellow" style={{ marginLeft: 6 }}>Stamped</span>
                    )}
                  </td>
                  <td>
                    {r.signatory_name || r.user_email || '—'}
                    {r.signatory_title && (
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-text3)' }}>{r.signatory_title}</span>
                    )}
                  </td>
                  {/* nepalDateLong, not nepalDateAd: "09/04/2026" reads as 9 April to anyone who
                      writes DD/MM, and on this table the date IS the record. Named month, day
                      first — the form the registry's own effective dates already take. */}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.signed_on_date ? nepalDateLong(`${r.signed_on_date}T00:00:00+05:45`) : nepalDateLong(r.accepted_at)}
                    <span style={{ display: 'block', fontSize: 11, color: 'var(--theme-text3)' }}>
                      {r.signed_on_date ? 'signed' : nepalTime(r.accepted_at)}
                    </span>
                  </td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 11, fontFamily: "source-code-pro, Menlo, Monaco, Consolas, 'Courier New', monospace" }}>
                    {r.ip_address || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '14px 0 0', lineHeight: 1.55 }}>
        These rows cannot be edited or deleted by anyone, including Crest — there is no update or
        delete path to this table. They are also deliberately left out of the Danger Zone's data
        wipe, and are retained for 7 years after the account ends, as the Privacy Policy states.
        Current documents: {DOC_TYPES.map(t => `${legalDoc(t).title} v${legalDoc(t).version}`).join(' · ')}.
      </p>
    </div>
  )
}
