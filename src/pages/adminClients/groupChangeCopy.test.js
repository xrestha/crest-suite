import { groupChangeCopy } from './groupChangeCopy'

// S849 GROUP-11: a group change names whose Owners gain or lose this outlet.
describe('groupChangeCopy', () => {
  const base = { clientName: 'BLOOM CAFE - PKR', clientId: 'pkr' }

  it('joining names the other outlets whose Owners gain this one', () => {
    const c = groupChangeCopy({ ...base, fromGroup: null, toGroup: { id: 'g', name: 'Bloom Cafe Group' }, toOthers: ['BLOOM CAFE', 'BLOOM KTM'] })
    expect(c.title).toBe('Put BLOOM CAFE - PKR in Bloom Cafe Group?')
    expect(c.body[0]).toBe("Owners of BLOOM CAFE and BLOOM KTM will be able to open BLOOM CAFE - PKR as its Owner — sales, payroll, closed months, staff — and BLOOM CAFE - PKR's Owner theirs.")
    expect(c.body[c.body.length - 1]).toMatch(/signed back to their own/)
    expect(c.confirmLabel).toBe('Join this group')
  })

  it('leaving names who loses it, and says the group loses its HQ when this outlet is the HQ', () => {
    const c = groupChangeCopy({ ...base, fromGroup: { id: 'g', name: 'Bloom Cafe Group', hq_client_id: 'pkr' }, toGroup: null, fromOthers: ['BLOOM CAFE'] })
    expect(c.body[0]).toBe('BLOOM CAFE - PKR leaves Bloom Cafe Group; its Owner can no longer open BLOOM CAFE, and theirs can no longer open it.')
    expect(c.body[1]).toMatch(/Bloom Cafe Group will have no HQ and Push to branches stops until you pick a new one under HQ outlet/)
    expect(c.confirmLabel).toBe('Leave the group')
  })

  it('no HQ sentence when another outlet is the HQ; a move between groups says both sides', () => {
    const c = groupChangeCopy({ ...base, fromGroup: { id: 'a', name: 'A', hq_client_id: 'other' }, toGroup: { id: 'b', name: 'B' }, fromOthers: ['X'], toOthers: [] })
    expect(c.body.some(l => /HQ/.test(l))).toBe(false)
    expect(c.body[0]).toMatch(/leaves A/)
    expect(c.body[1]).toBe('B has no other outlets yet, so nobody else reaches BLOOM CAFE - PKR until one joins.')
    expect(c.confirmLabel).toBe('Move to this group')
  })
})
