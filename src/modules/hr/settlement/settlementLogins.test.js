import { splitPlan, loginLabel, moveLine, removeLine, finalizedLoginNote, reopenLoginLines, notUndoneLines } from './settlementLogins'

const ramesh = { full_name: 'Ramesh', modules: 'HR', hr_manager: false, action: 'move', outlet_name: 'Lakeside' }
const sita = { full_name: 'Sita', modules: 'HR', hr_manager: true, action: 'remove_access', outlet_name: 'Lakeside' }
const hari = { full_name: 'Hari', modules: 'POS', hr_manager: false, action: 'block', outlet_name: null }

describe('settlementLogins — what Finalize does to a leaver\'s logins (S798 3f-2, H22)', () => {
  it('splits the plan by action, reading a row with no action as blocked', () => {
    const p = splitPlan([ramesh, sita, hari, { full_name: 'Old', modules: 'IMS' }])
    expect(p.block.map(l => l.full_name)).toEqual(['Hari', 'Old'])
    expect(p.move).toEqual([ramesh])
    expect(p.remove).toEqual([sita])
    expect(splitPlan(null)).toEqual({ block: [], move: [], remove: [] })
  })

  it('names the login, its modules and an HR Manager rank', () => {
    expect(loginLabel(sita)).toBe('Sita (HR, HR Manager)')
    expect(moveLine(ramesh)).toMatch(/^Ramesh \(HR\) still works at Lakeside.*moves to Lakeside at the same rank.*Reopen moves it back\.$/)
    expect(removeLine(sita)).toMatch(/loses access to Lakeside only/)
  })

  it('ends the finalized message with every login it touched', () => {
    const row = {
      blocked_logins: ['Hari'],
      login_changes: [
        { kind: 'moved', name: 'Ramesh', outlet: 'Lakeside' },
        { kind: 'access_removed', name: 'Sita', outlet: 'Thamel' },
        { kind: 'unknown', name: 'X' },
      ],
    }
    expect(finalizedLoginNote(row)).toBe("; staff login blocked: Hari; Ramesh's login now belongs to Lakeside; Sita can no longer open Thamel")
    expect(finalizedLoginNote({ blocked_logins: [], login_changes: [] })).toBe('')
    expect(finalizedLoginNote({})).toBe('')
  })

  it('tells Reopen what it puts back, and a reopened draft what it could not', () => {
    const finalized = { login_changes: [{ kind: 'moved', name: 'Ramesh', outlet: 'Lakeside' }, { kind: 'access_removed', name: 'Sita', outlet: 'Thamel' }] }
    expect(reopenLoginLines(finalized)).toHaveLength(2)
    expect(reopenLoginLines(finalized)[0]).toMatch(/^Ramesh's login moves back to this outlet/)
    expect(notUndoneLines(finalized)).toEqual([])

    const draft = { login_changes: [{ kind: 'moved', name: 'Ramesh', outlet: 'Lakeside', not_undone: 'the login has been moved or relinked since' }] }
    expect(notUndoneLines(draft)).toEqual(["Ramesh's login was not moved back from Lakeside: the login has been moved or relinked since. Check it on HR Staff there."])
    expect(reopenLoginLines(draft)).toEqual([])
  })
})
