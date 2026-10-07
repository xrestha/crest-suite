import { useState } from 'react'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { nprInt } from '../../../shared/nepalMoney'

// The year's bonus runs as the page body, and the dialog that starts a new one (S805), for Festival
// Allowance and Incentive Run. Both pages used to start a run of money by typing its name into the
// page header, with the year's other runs as a row of chips above whichever run that name happened
// to match: the run being worked on was whatever the box said, and a half-typed name was a new run.
// Now a page with no run open lists the year's runs with what each paid, a run opens by name, and a
// new one is named in a dialog that says what already exists before anything is generated.

// The product's amber banner (PayrollRun's stale-draft card, S570), sized for a dialog.
const amberNote = {
  padding: '10px 12px', border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)',
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
}

// "Dashain", "dashain" and "Dash ain" are one festival to a reader and three runs to the database.
export const normName = s => String(s || '').toLowerCase().replace(/\s+/g, '')

// A run is a set of rows, so it can be part finalized; the colours are RunStatusBadge's.
export const runStatusChip = g => (g.finalized === g.count
  ? { label: 'Finalized', cls: 'badge-green' }
  : g.finalized === 0 ? { label: 'Draft', cls: 'badge-amber' } : { label: 'Part finalized', cls: 'badge-amber' })

/**
 * `runs`: `[{ name, bs_month, count, staff, finalized, gross, tds }]`, one per run in the year.
 * `noun` names a run in labels ("festival allowance", "bonus run").
 */
export function BonusRunList({ runs, year, noun, onOpen, emptyTitle, emptyText }) {
  if (!runs.length) return (
    <div className="card" style={{ padding: 40, textAlign: 'center' }}>
      <div style={{ fontSize: 14, color: 'var(--theme-text1)', marginBottom: 6 }}>{emptyTitle}</div>
      <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6, maxWidth: 520, marginInline: 'auto' }}>{emptyText}</div>
    </div>
  )
  const label = `${noun[0].toUpperCase()}${noun.slice(1)}s in BS ${year}`
  return (
    <div className="card" style={{ padding: 0 }}>
      {/* Below 600px each run is one card and the table hides (the S796 pattern). */}
      <div className="phone-only" style={{ padding: '0 16px' }}>
        <ul className="phone-cards" aria-label={label}>
          {runs.map(g => {
            const chip = runStatusChip(g)
            return (
              <li key={g.name} className="phone-card">
                <div className="phone-card__top">
                  <span className="phone-card__title">{g.name}</span>
                  <span className="phone-card__figure">NPR {nprInt(g.gross)}</span>
                </div>
                <div className="phone-card__meta">
                  Paid in {BS_MONTHS[g.bs_month - 1]} · {g.staff} staff · income tax {nprInt(g.tds)} · net {nprInt(g.gross - g.tds)}
                </div>
                <div className="phone-card__meta"><span className={`badge ${chip.cls}`}>{chip.label}</span></div>
                <div className="phone-card__actions">
                  <button type="button" className="btn btn-ghost" onClick={() => onOpen(g.name)} aria-label={`Open ${g.name}`}>Open</button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
      <div className="table-wrap phone-hide">
        <table className="data-table" aria-label={label}>
          <thead>
            <tr>
              <th><Tip text="Press a name to open that run." width={200}>Run</Tip></th>
              <th>
                <Tip text="The month the run is paid. It decides the tax year and which other bonuses count as paid before it." width={260}>Paid in</Tip>
              </th>
              <th style={{ textAlign: 'right' }}>
                <Tip text="People in the run, not counting anyone marked Excluded." width={220}>Staff</Tip>
              </th>
              <th style={{ textAlign: 'right' }}><Tip text="All figures in NPR. Gross is before income tax." width={220}>Gross</Tip></th>
              <th style={{ textAlign: 'right' }}>Income tax</th>
              <th style={{ textAlign: 'right' }}>
                <Tip text="What reaches staff accounts: gross minus income tax." width={220}>Net</Tip>
              </th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(g => {
              const chip = runStatusChip(g)
              return (
                <tr key={g.name}>
                  <td>
                    <button type="button" className="btn-linklike btn-linklike--prints" onClick={() => onOpen(g.name)}>{g.name}</button>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>{BS_MONTHS[g.bs_month - 1]} {year}</td>
                  <td style={{ textAlign: 'right' }}>{g.staff}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{nprInt(g.gross)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{nprInt(g.tds)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600, color: 'var(--theme-text1)' }}>{nprInt(g.gross - g.tds)}</td>
                  <td><span className={`badge ${chip.cls}`}>{chip.label}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Names a new run before anything is written. Continue only opens the run: its rows are written by
 * Generate on the next screen, as before. `types` (Incentive Run) adds a Bonus type select whose pick
 * names a blank run after the type, as the header select used to.
 */
export function NewBonusRunDialog({
  title, runs, year, noun, defaultName = '', defaultMonth, nameLabel, namePlaceholder, monthTip,
  types, onClose, onContinue,
}) {
  const [name, setName] = useState(defaultName)
  const [month, setMonth] = useState(defaultMonth)
  const [typeId, setTypeId] = useState('')
  const trimmed = name.trim()
  const exact = runs.find(g => g.name === trimmed)
  const lookalikes = trimmed ? runs.filter(g => g.name !== trimmed && normName(g.name) === normName(trimmed)) : []
  const others = runs.filter(g => normName(g.name) !== normName(trimmed))
  const submit = e => { e.preventDefault(); if (trimmed) onContinue(exact ? { name: exact.name } : { name: trimmed, month, typeId }) }

  return (
    <Modal onClose={onClose} title={title} maxWidth={560}>
      <form onSubmit={submit}>
        <div className="field-grid">
          <div className="form-field field-grid__wide">
            <label htmlFor="bonus-run-name">{nameLabel}</label>
            <input id="bonus-run-name" className="form-input" value={name} placeholder={namePlaceholder} autoComplete="off"
              onChange={e => setName(e.target.value)} />
          </div>
          {types && (
            <div className="form-field">
              <label htmlFor="bonus-run-type">Bonus type</label>
              <select id="bonus-run-type" className="form-select" style={{ width: '100%' }} value={exact ? '' : typeId} disabled={!!exact}
                onChange={e => {
                  setTypeId(e.target.value)
                  const t = types.find(x => x.id === e.target.value)
                  if (t && !trimmed) setName(t.name)
                }}>
                <option value="">— No type: type each amount —</option>
                {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
          <div className="form-field">
            <label htmlFor="bonus-run-month"><Tip text={monthTip} width={300}>Paid in</Tip></label>
            <select id="bonus-run-month" className="form-select" style={{ width: '100%' }} value={exact ? exact.bs_month : month} disabled={!!exact}
              onChange={e => setMonth(parseInt(e.target.value, 10))}>
              {BS_MONTHS.map((m, i) => <option key={m} value={i + 1}>{m} {year}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginTop: 14, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
          {exact ? (
            <p style={{ margin: 0 }}>“{exact.name}” already exists in BS {year}: Continue opens it.</p>
          ) : lookalikes.length > 0 ? (
            <div role="alert" style={amberNote}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>“{trimmed}” differs from “{lookalikes[0].name}” only by capital letters or spaces.</strong>{' '}
              Continuing makes a second, separate run. Open the existing one instead:{' '}
              {lookalikes.map(g => (
                <button key={g.name} type="button" className="btn btn-ghost btn-sm" onClick={() => onContinue({ name: g.name })}>{g.name}</button>
              ))}
            </div>
          ) : (
            <p style={{ margin: 0 }}>
              {others.length > 0 && <>
                {others.length === 1 ? `“${others[0].name}” already exists` : `${others.length} ${noun}s already exist`} in BS {year}.
                This one is taxed on top of the bonuses paid before it, so its income tax can be higher.{' '}
              </>}
              Nothing is saved until you press Generate on the next screen.
            </p>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!trimmed}>{exact ? 'Open it' : 'Continue'}</button>
        </div>
      </form>
    </Modal>
  )
}
