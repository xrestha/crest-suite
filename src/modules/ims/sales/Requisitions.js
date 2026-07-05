import { useEffect, useState, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { getBsToday } from '../../../utils/bsCalendar'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import SearchableSelect from '../../../components/SearchableSelect'
import { printWithTitle } from '../../../utils/printTitle'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
const DEPARTMENTS = [
  'Kitchen',
  'Bar',
  'Pastry / Bakery',
  'Banquet / Events',
  'Room Service',
  'Coffee Shop / Café',
  'Staff Cafeteria',
  'Housekeeping',
  'Laundry',
  'Stewarding',
  'Engineering / Maintenance',
  'Front Office',
  'Concierge',
  'Spa / Wellness',
  'Pool / Recreation',
  'Security',
  'Administration',
  'Other',
]

export default function Requisitions() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id

  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [items, setItems] = useState([])
  const [reqs, setReqs] = useState([])
  const [loading, setLoading] = useState(true)

  const [mode, setMode] = useState('list') // 'list' | 'new' | 'view'
  const [selectedReq, setSelectedReq] = useState(null)
  const [selectedLines, setSelectedLines] = useState([])

  // New form state
  const [formDay, setFormDay] = useState('')
  const [formDept, setFormDept] = useState('Kitchen')
  const [formNotes, setFormNotes] = useState('')
  const [formLines, setFormLines] = useState([{ item_id: '', qty_requested: '', qty_issued: '', _key: 1 }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const itemOptions = useMemo(() => items.map(i => ({ value: i.id, label: `${i.name} (${i.uom})` })), [items])

  // Issue mode
  const [issuingId, setIssuingId] = useState(null)
  const [issueLines, setIssueLines] = useState([])

  // List filters
  const [filterDept, setFilterDept] = useState('all')

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: i }] = await Promise.all([
      supabase.from('monthly_periods').select('*').eq('client_id', effectiveClientId).order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('items').select('id, name, uom, per_uom_rate, categories(name)').eq('client_id', effectiveClientId).eq('is_active', true).eq('is_sub_recipe', false).order('name')
    ])
    setPeriods(p || [])
    setItems(i || [])
    const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
    if (open) {
      setSelectedPeriod(open)
      await loadReqs(open.id)
    }
    setLoading(false)
  }

  async function loadReqs(periodId) {
    const { data } = await supabase
      .from('requisitions')
      .select('*, requisition_lines(id, item_id, qty_requested, qty_issued, items(name, uom, per_uom_rate, categories(name)))')
      .eq('period_id', periodId)
      .order('bs_day', { ascending: false })
      .order('created_at', { ascending: false })
    setReqs(data || [])
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    backToList()
    setLoading(true)
    await loadReqs(periodId)
    setLoading(false)
  }

  function backToList() {
    setMode('list')
    setSelectedReq(null)
    setSelectedLines([])
    setIssuingId(null)
    setIssueLines([])
  }

  function startNew() {
    const today = getBsToday()
    const isCurrentMonth = selectedPeriod?.bs_year === today.year && selectedPeriod?.bs_month === today.month
    setMode('new')
    setSelectedReq(null)
    setFormDay(isCurrentMonth ? String(today.day) : '')
    setFormDept('Kitchen')
    setFormNotes('')
    setFormLines([{ item_id: '', qty_requested: '', qty_issued: '', _key: Date.now() }])
    setError('')
  }

  function viewReq(req) {
    setMode('view')
    setSelectedReq(req)
    setSelectedLines(req.requisition_lines || [])
    setIssuingId(null)
    setIssueLines([])
  }

  function addFormLine() {
    setFormLines(prev => [...prev, { item_id: '', qty_requested: '', qty_issued: '', _key: Date.now() + Math.random() }])
  }

  function removeFormLine(key) {
    setFormLines(prev => prev.filter(l => l._key !== key))
  }

  function updateFormLine(key, field, value) {
    setFormLines(prev => prev.map(l => l._key === key ? { ...l, [field]: value } : l))
  }

  async function saveReq(statusOverride) {
    if (!effectiveClientId) { setError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    if (!formDay) { setError('Select a day.'); return }
    const validLines = formLines.filter(l => l.item_id && parseFloat(l.qty_requested) > 0)
    if (validLines.length === 0) { setError('Add at least one item with a requested quantity.'); return }
    setSaving(true)
    setError('')

    const { data: header, error: hErr } = await supabase
      .from('requisitions')
      .insert({
        client_id: effectiveClientId,
        period_id: selectedPeriod.id,
        bs_day: parseInt(formDay),
        department: formDept || 'Kitchen',
        notes: formNotes || null,
        status: statusOverride || 'draft'
      })
      .select()
      .single()

    if (hErr || !header) { setError(hErr?.message || 'Failed to save.'); setSaving(false); return }

    const lineRows = validLines.map(l => ({
      requisition_id: header.id,
      item_id: l.item_id,
      qty_requested: parseFloat(l.qty_requested),
      qty_issued: statusOverride === 'issued'
        ? parseFloat(l.qty_issued !== '' ? l.qty_issued : l.qty_requested)
        : parseFloat(l.qty_issued || 0)
    }))

    const { error: lErr } = await supabase.from('requisition_lines').insert(lineRows)
    if (lErr) { setError(lErr.message); setSaving(false); return }

    await loadReqs(selectedPeriod.id)
    backToList()
    setSaving(false)
  }

  async function deleteReq(reqId) {
    if (!window.confirm('Delete this draft requisition?')) return
    await supabase.from('requisitions').delete().eq('id', reqId)
    await loadReqs(selectedPeriod.id)
    if (selectedReq?.id === reqId) backToList()
  }

  function startIssuing() {
    setIssuingId(selectedReq.id)
    setIssueLines(selectedLines.map(l => ({
      ...l,
      qty_issued: l.qty_issued > 0 ? l.qty_issued : l.qty_requested
    })))
  }

  async function confirmIssue() {
    setSaving(true)
    const { error: hErr } = await supabase.from('requisitions').update({ status: 'issued' }).eq('id', selectedReq.id)
    if (hErr) { setSaving(false); return }
    for (const line of issueLines) {
      await supabase.from('requisition_lines').update({ qty_issued: parseFloat(line.qty_issued || 0) }).eq('id', line.id)
    }
    await loadReqs(selectedPeriod.id)
    backToList()
    setSaving(false)
  }

  function reqIssuedValue(req) {
    return (req.requisition_lines || []).reduce((s, l) => {
      const qty = req.status === 'issued' ? parseFloat(l.qty_issued || 0) : parseFloat(l.qty_requested || 0)
      return s + qty * parseFloat(l.items?.per_uom_rate || 0)
    }, 0)
  }

  function exportExcel(req, lines) {
    const wb = XLSX.utils.book_new()
    const rows = lines.map(l => {
      const rate    = parseFloat(l.items?.per_uom_rate || 0)
      const reqQty  = parseFloat(l.qty_requested || 0)
      const issdQty = parseFloat(l.qty_issued || 0)
      const valueQty = req.status === 'issued' ? issdQty : reqQty
      return {
        'Item':           l.items?.name || '',
        'Category':       l.items?.categories?.name || '',
        'UOM':            l.items?.uom || '',
        'Qty Requested':  reqQty || '',
        'Qty Issued':     req.status === 'issued' ? issdQty : '',
        'Rate (NPR/UOM)': rate || '',
        'Value (NPR)':    rate > 0 ? Math.round(valueQty * rate) : '',
      }
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, ws, 'Requisition')
    const filename = `Requisition-Day${req.bs_day}-${req.department}-${periodLabel.replace(' ', '')}.xlsx`
    XLSX.writeFile(wb, filename)
  }

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : '—'
  const periodClosed = selectedPeriod?.status === 'closed'
  const allDepts = [...new Set(reqs.map(r => r.department).filter(Boolean))].sort()
  const filteredReqs = filterDept === 'all' ? reqs : reqs.filter(r => r.department === filterDept)
  const issuedReqs = reqs.filter(r => r.status === 'issued')
  const draftReqs = reqs.filter(r => r.status === 'draft')
  const totalIssuedValue = issuedReqs.reduce((s, r) => s + reqIssuedValue(r), 0)

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Requisitions</h1>
          <p className="page-subtitle">Internal store-to-department stock transfers — {periodLabel}</p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
            value={selectedPeriod?.id || ''}
            onChange={e => handlePeriodChange(e.target.value)}
          >
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          {mode !== 'list' && (
            <button className="btn btn-ghost" onClick={backToList}>← Back to List</button>
          )}
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
      ) : mode === 'new' ? (
        /* ── New Requisition Form ─────────────────────────────────────────── */
        <div>
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
              <div className="form-field">
                <label>Day *</label>
                <BsCalendarPicker
                  lockYear={selectedPeriod?.bs_year}
                  lockMonth={selectedPeriod?.bs_month}
                  value={formDay}
                  onChange={setFormDay}
                  placeholder="Pick day"
                />
              </div>
              <div className="form-field">
                <label>
                  <Tip text="The department receiving items from the main store (e.g. Kitchen, Bar, Pastry)." width={230}>Department</Tip>
                </label>
                <select
                  value={formDept}
                  onChange={e => setFormDept(e.target.value)}
                  style={{ width: '100%' }}
                >
                  {DEPARTMENTS.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label>Notes (optional)</label>
                <input
                  value={formNotes}
                  onChange={e => setFormNotes(e.target.value)}
                  placeholder="e.g. Dinner service, lunch prep…"
                  style={{ width: '100%' }}
                />
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div style={{ fontWeight: 600, color: 'var(--theme-text1)', fontSize: 14, marginBottom: 14 }}>Requested Items</div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: 220 }}>Item</th>
                    <th>UOM</th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Quantity the department is requesting from the store." width={210}>Qty Requested</Tip>
                    </th>
                    <th style={{ textAlign: 'right' }}>
                      <Tip text="Quantity actually issued from the store. Leave blank to issue the full requested quantity when you confirm." width={260}>Qty Issued</Tip>
                    </th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-text3)' }}><Tip text="Per-base-unit cost from the most recent purchase entry for this item." width={240}>Rate / UOM</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent)' }}><Tip text="Estimated store issue cost = Qty Issued (or Requested) × Rate / UOM." width={240}>Est. Value</Tip></th>
                    <th style={{ width: 36 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {formLines.map(line => {
                    const item = items.find(i => i.id === line.item_id)
                    const rate = parseFloat(item?.per_uom_rate || 0)
                    const issuedQty = parseFloat(line.qty_issued !== '' ? line.qty_issued : line.qty_requested || 0)
                    const value = issuedQty * rate
                    return (
                      <tr key={line._key}>
                        <td>
                          <SearchableSelect
                            value={line.item_id}
                            onChange={v => updateFormLine(line._key, 'item_id', v)}
                            options={itemOptions}
                            placeholder="— Select item —"
                          />
                        </td>
                        <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{item?.uom || '—'}</td>
                        <td>
                          <input
                            type="number" min="0" step="any"
                            value={line.qty_requested}
                            onChange={e => updateFormLine(line._key, 'qty_requested', e.target.value)}
                            style={{ width: 90, textAlign: 'right' }}
                            placeholder="0"
                          />
                        </td>
                        <td>
                          <input
                            type="number" min="0" step="any"
                            value={line.qty_issued}
                            onChange={e => updateFormLine(line._key, 'qty_issued', e.target.value)}
                            style={{ width: 90, textAlign: 'right' }}
                            placeholder="same"
                          />
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                          {rate > 0 ? `NPR ${rate.toLocaleString('en-NP', { maximumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: value > 0 ? 'var(--theme-accent)' : 'var(--theme-text2)', fontSize: 12 }}>
                          {value > 0 ? `NPR ${Math.round(value).toLocaleString('en-NP')}` : '—'}
                        </td>
                        <td>
                          <button
                            onClick={() => removeFormLine(line._key)}
                            style={{ background: 'none', border: 'none', color: 'var(--theme-red)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: '2px 4px' }}
                          >×</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <button className="btn btn-ghost" style={{ marginTop: 10, fontSize: 12 }} onClick={addFormLine}>+ Add Item</button>
          </div>

          {error && <div style={{ color: 'var(--theme-red)', fontSize: 13, marginBottom: 12 }}>{error}</div>}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={backToList} disabled={saving}>Cancel</button>
            <button className="btn btn-ghost" onClick={() => saveReq('draft')} disabled={saving}>
              {saving ? 'Saving…' : 'Save as Draft'}
            </button>
            <button className="btn btn-primary" onClick={() => saveReq('issued')} disabled={saving}>
              {saving ? 'Saving…' : 'Save & Issue'}
            </button>
          </div>
        </div>

      ) : mode === 'view' && selectedReq ? (
        /* ── View / Issue Requisition ────────────────────────────────────── */
        <div>
          {/* Print-only slip header */}
          <div className="print-only" style={{ marginBottom: 20 }}>
            <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Store Requisition Slip</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginTop: 8 }}>
              <tbody>
                <tr>
                  <td style={{ padding: '4px 8px', fontWeight: 600 }}>Period:</td>
                  <td style={{ padding: '4px 8px' }}>{periodLabel}</td>
                  <td style={{ padding: '4px 8px', fontWeight: 600 }}>Day:</td>
                  <td style={{ padding: '4px 8px' }}>{selectedReq.bs_day}</td>
                </tr>
                <tr>
                  <td style={{ padding: '4px 8px', fontWeight: 600 }}>Department:</td>
                  <td style={{ padding: '4px 8px' }}>{selectedReq.department}</td>
                  <td style={{ padding: '4px 8px', fontWeight: 600 }}>Status:</td>
                  <td style={{ padding: '4px 8px' }}>{selectedReq.status === 'issued' ? 'ISSUED' : 'DRAFT'}</td>
                </tr>
                {selectedReq.notes && (
                  <tr>
                    <td style={{ padding: '4px 8px', fontWeight: 600 }}>Notes:</td>
                    <td colSpan={3} style={{ padding: '4px 8px' }}>{selectedReq.notes}</td>
                  </tr>
                )}
              </tbody>
            </table>
            <hr style={{ margin: '12px 0', borderTop: '2px solid #000' }} />
          </div>

          {/* Header card */}
          <div className="card no-print" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
              <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 3 }}>Day</div>
                  <div style={{ fontWeight: 700, color: 'var(--theme-accent)', fontSize: 18 }}>{selectedReq.bs_day}</div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{periodLabel}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 3 }}>Department</div>
                  <div style={{ fontWeight: 700, color: 'var(--theme-text1)', fontSize: 15 }}>{selectedReq.department}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 3 }}>Status</div>
                  <span className={`badge ${selectedReq.status === 'issued' ? 'badge-green' : 'badge-yellow'}`} style={{ fontSize: 12, padding: '3px 10px' }}>
                    {selectedReq.status === 'issued' ? 'ISSUED' : 'DRAFT'}
                  </span>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 3 }}>Items</div>
                  <div style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{selectedLines.length}</div>
                </div>
                {selectedReq.notes && (
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 3 }}>Notes</div>
                    <div style={{ color: 'var(--theme-text3)', fontSize: 13 }}>{selectedReq.notes}</div>
                  </div>
                )}
              </div>
              <div className="no-print" style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                {selectedReq.status === 'draft' && !periodClosed && !issuingId && (
                  <>
                    <button
                      className="btn btn-ghost"
                      onClick={() => deleteReq(selectedReq.id)}
                      style={{ color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)' }}
                    >Delete</button>
                    <button className="btn btn-primary" onClick={startIssuing}>Issue</button>
                  </>
                )}
                <button className="btn btn-ghost" onClick={() => exportExcel(selectedReq, selectedLines)}>⬇ Export</button>
                <button className="btn btn-ghost" onClick={() => printWithTitle(`Requisition - Day ${selectedReq.bs_day} - ${selectedReq.department} - ${periodLabel}`)}>Print</button>
              </div>
            </div>
          </div>

          {/* Issue-mode: editable qty_issued */}
          {issuingId === selectedReq.id ? (
            <div className="card">
              <div style={{ fontWeight: 600, color: 'var(--theme-text1)', marginBottom: 14 }}>
                Confirm Issue Quantities — adjust if issuing less than requested
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>UOM</th>
                      <th style={{ textAlign: 'right' }}>Qty Requested</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Set the actual quantity you are issuing from the store. Can be less than requested." width={230}>Qty Issued</Tip>
                      </th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-text3)' }}><Tip text="Per-base-unit cost from the most recent purchase entry for this item." width={240}>Rate / UOM</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-accent)' }}><Tip text="Qty Issued × Rate / UOM — the NPR cost of goods leaving the store." width={240}>Value Issued</Tip></th>
                    </tr>
                  </thead>
                  <tbody>
                    {issueLines.map((line, idx) => {
                      const rate = parseFloat(line.items?.per_uom_rate || 0)
                      const value = parseFloat(line.qty_issued || 0) * rate
                      return (
                        <tr key={line.id}>
                          <td style={{ fontWeight: 600 }}>{line.items?.name}</td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{line.items?.uom}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{Number(line.qty_requested).toLocaleString()}</td>
                          <td>
                            <input
                              type="number" min="0" step="any"
                              value={issueLines[idx].qty_issued}
                              onChange={e => setIssueLines(prev => prev.map((l, j) => j === idx ? { ...l, qty_issued: e.target.value } : l))}
                              style={{ width: 100, textAlign: 'right', float: 'right' }}
                            />
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                            {rate > 0 ? `NPR ${rate.toLocaleString('en-NP', { maximumFractionDigits: 2 })}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-accent)' }}>
                            {value > 0 ? `NPR ${Math.round(value).toLocaleString('en-NP')}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
                <button className="btn btn-ghost" onClick={() => { setIssuingId(null); setIssueLines([]) }} disabled={saving}>Cancel</button>
                <button className="btn btn-primary" onClick={confirmIssue} disabled={saving}>
                  {saving ? 'Issuing…' : 'Confirm Issue'}
                </button>
              </div>
            </div>
          ) : (
            /* Read-only line items */
            <div className="card">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Category</th>
                      <th>UOM</th>
                      <th style={{ textAlign: 'right' }}>Qty Requested</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Qty actually issued from the store. Green = full qty issued, red = partial." width={220}>Qty Issued</Tip>
                      </th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-text3)' }}><Tip text="Per-base-unit cost from the most recent purchase entry for this item." width={240}>Rate / UOM</Tip></th>
                      <th style={{ textAlign: 'right', color: 'var(--theme-accent)' }}><Tip text="Qty Issued × Rate / UOM — the NPR cost of goods that left the store." width={240}>Value</Tip></th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedLines.map(line => {
                      const rate = parseFloat(line.items?.per_uom_rate || 0)
                      const reqQty = parseFloat(line.qty_requested || 0)
                      const issdQty = parseFloat(line.qty_issued || 0)
                      const displayQty = selectedReq.status === 'issued' ? issdQty : reqQty
                      const value = displayQty * rate
                      const partial = selectedReq.status === 'issued' && issdQty < reqQty
                      return (
                        <tr key={line.id}>
                          <td style={{ fontWeight: 600 }}>{line.items?.name}</td>
                          <td>
                            {line.items?.categories?.name
                              ? <span className="badge badge-yellow">{line.items.categories.name}</span>
                              : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                          </td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{line.items?.uom}</td>
                          <td style={{ textAlign: 'right' }}>{Number(reqQty).toLocaleString()}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: selectedReq.status === 'issued' ? (partial ? 'var(--theme-red)' : 'var(--theme-green)') : 'var(--theme-text2)' }}>
                            {selectedReq.status === 'issued' ? Number(issdQty).toLocaleString() : '—'}
                            {partial && <span style={{ fontSize: 10, marginLeft: 4 }}>partial</span>}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)', fontSize: 12 }}>
                            {rate > 0 ? `NPR ${rate.toLocaleString('en-NP', { maximumFractionDigits: 2 })}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: value > 0 ? 'var(--theme-accent)' : 'var(--theme-text2)' }}>
                            {value > 0 ? `NPR ${Math.round(value).toLocaleString('en-NP')}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                    {/* Total */}
                    {(() => {
                      const total = selectedLines.reduce((s, l) => {
                        const qty = selectedReq.status === 'issued' ? parseFloat(l.qty_issued || 0) : parseFloat(l.qty_requested || 0)
                        return s + qty * parseFloat(l.items?.per_uom_rate || 0)
                      }, 0)
                      return total > 0 ? (
                        <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                          <td colSpan={6} style={{ fontWeight: 700, paddingTop: 12 }}>
                            {selectedReq.status === 'issued' ? 'Total Issued Value' : 'Total Requested Value'}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', paddingTop: 12 }}>
                            NPR {Math.round(total).toLocaleString('en-NP')}
                          </td>
                        </tr>
                      ) : null
                    })()}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

      ) : (
        /* ── Requisitions List ───────────────────────────────────────────── */
        <div>
          {/* Stat cards */}
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 24 }}>
            <div className="stat-card">
              <div className="stat-label">Total Requisitions</div>
              <div className="stat-value">{reqs.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Issued</div>
              <div className="stat-value" style={{ color: 'var(--theme-green)' }}>{issuedReqs.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Draft / Pending</div>
              <div className="stat-value" style={{ color: draftReqs.length > 0 ? 'var(--theme-accent)' : 'var(--theme-text2)' }}>{draftReqs.length}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Total Issued Value</div>
              <div className="stat-value gold" style={{ fontSize: 16 }}>
                {totalIssuedValue > 0 ? `NPR ${Math.round(totalIssuedValue).toLocaleString('en-NP')}` : '—'}
              </div>
            </div>
          </div>

          {/* Filters */}
          {allDepts.length > 1 && (
            <div className="tab-bar" style={{ marginBottom: 16 }}>
              <button
                onClick={() => setFilterDept('all')}
                className={`tab-btn${filterDept === 'all' ? ' tab-btn--active' : ''}`}
              >All</button>
              {allDepts.map(d => (
                <button
                  key={d}
                  onClick={() => setFilterDept(d)}
                  className={`tab-btn${filterDept === d ? ' tab-btn--active' : ''}`}
                >{d}</button>
              ))}
            </div>
          )}

          {filteredReqs.length === 0 ? (
            <div className="card" style={{ textAlign: 'center', padding: 48 }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📋</div>
              <div style={{ color: 'var(--theme-text2)', fontSize: 14 }}>No requisitions for {periodLabel}.</div>
              {!periodClosed && (
                <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={startNew}>+ New Requisition</button>
              )}
            </div>
          ) : (
            <div className="card">
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Department</th>
                      <th style={{ textAlign: 'right' }}>Items</th>
                      <th>Status</th>
                      <th>Notes</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Total NPR value based on issued qty × item cost rate. Shows requested value for drafts." width={230}>Value</Tip>
                      </th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReqs.map(req => {
                      const value = reqIssuedValue(req)
                      const lineCount = (req.requisition_lines || []).length
                      return (
                        <tr key={req.id} style={{ cursor: 'pointer' }} onClick={() => viewReq(req)}>
                          <td style={{ fontWeight: 700, color: 'var(--theme-accent)' }}>Day {req.bs_day}</td>
                          <td style={{ fontWeight: 600 }}>{req.department}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{lineCount}</td>
                          <td>
                            <span className={`badge ${req.status === 'issued' ? 'badge-green' : 'badge-yellow'}`}>
                              {req.status === 'issued' ? 'Issued' : 'Draft'}
                            </span>
                          </td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{req.notes || '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600, color: value > 0 ? 'var(--theme-accent)' : 'var(--theme-text2)' }}>
                            {value > 0 ? `NPR ${Math.round(value).toLocaleString('en-NP')}` : '—'}
                          </td>
                          <td onClick={e => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => viewReq(req)}>View</button>
                            {req.status === 'draft' && !periodClosed && (
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 12, padding: '4px 10px', marginLeft: 4, color: 'var(--theme-red)' }}
                                onClick={() => deleteReq(req.id)}
                              >Del</button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <Fab onClick={startNew} label="+ New Requisition" show={mode === 'list' && !periodClosed} />
    </div>
  )
}
