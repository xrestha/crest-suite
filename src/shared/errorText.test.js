import { errorInfo, errorText } from './errorText'

describe('errorText', () => {
  it('names the offline case from the bare TypeError supabase-js surfaces', () => {
    expect(errorText(new TypeError('Failed to fetch'), 'operator')).toMatch(/connection dropped/i)
    expect(errorText({ message: 'NetworkError when attempting to fetch resource.' }, 'operator')).toMatch(/couldn't reach the server/i)
  })

  it('never claims a failed write did not land — the response can be lost after the commit', () => {
    const text = errorText(new TypeError('Failed to fetch'), 'operator')
    expect(text).not.toMatch(/nothing was saved|not saved|wasn't saved/i)
  })

  it('speaks to the audience: the same failure, two different next steps', () => {
    const err = { code: 'PGRST202', message: 'Could not find the function in the schema cache' }
    expect(errorText(err, 'staff')).toMatch(/tell your manager/i)
    expect(errorText(err, 'operator')).toMatch(/migration/i)
    expect(errorText(err, 'operator')).not.toMatch(/tell your manager/i)
  })

  it('defaults to the staff wording, and treats an unknown audience as staff', () => {
    const err = { code: '42501' }
    expect(errorText(err)).toBe(errorText(err, 'staff'))
    expect(errorText(err, 'nonsense')).toBe(errorText(err, 'staff'))
  })

  it('recognises a duplicate key', () => {
    expect(errorText({ code: '23505', message: 'duplicate key value violates unique constraint' }, 'operator'))
      .toMatch(/already exists/i)
  })

  it('does not say "try again" for a value the database rejected', () => {
    expect(errorText({ code: '23514' }, 'operator')).toMatch(/fail the same way/i)
  })

  it('keeps the technical detail alongside, never in the headline', () => {
    const { text, detail } = errorInfo({ code: 'PGRST202', message: 'schema cache miss' }, 'operator')
    expect(detail).toBe('PGRST202 · schema cache miss')
    expect(text).not.toMatch(/PGRST202/)
  })

  it('accepts a bare string or nothing at all without throwing', () => {
    expect(errorInfo('boom', 'operator').text).toBe(errorInfo(null, 'operator').text)
    expect(errorInfo(null).detail).toBe('')
  })

  // S709. These come out of `receive_purchase_order`, which is one transaction — so unlike the
  // dropped-fetch case above, the server raising one of them really does prove nothing landed,
  // and saying so is what makes the delivery safe to re-enter rather than a coin toss.
  describe('the purchase order receipt refusals', () => {
    const raised = name => ({ code: 'P0001', message: `${name}: purchase order PO-004 …` })

    it('a closed period says the month is the problem, and names who can get past it', () => {
      expect(errorText(raised('po_period_closed'), 'operator')).toMatch(/closed/i)
      expect(errorText(raised('po_period_closed'), 'operator')).toMatch(/operator/i)
      expect(errorText(raised('po_period_closed'), 'staff')).toMatch(/ask your manager/i)
    })

    it('an over-receive points at the order rather than at the number typed', () => {
      const text = errorText(raised('po_over_receive'), 'operator')
      expect(text).toMatch(/outstanding/i)
      expect(text).toMatch(/reopen/i)
    })

    it('a stale order and a vanished one read the same, because they are the same fact', () => {
      expect(errorText(raised('po_receipt_stale'), 'operator'))
        .toBe(errorText(raised('po_not_found'), 'operator'))
    })

    it('these refusals ARE allowed to say nothing landed — they are raised before the commit', () => {
      for (const name of ['po_period_closed', 'po_not_receivable', 'po_over_receive', 'po_receipt_stale']) {
        expect(errorText(raised(name), 'operator')).toMatch(/nothing was received/i)
      }
    })

    it('a delete refusal names the way through instead of only the refusal', () => {
      expect(errorText(raised('po_delete_not_permitted'), 'operator')).toMatch(/cancel it instead/i)
      expect(errorText(raised('po_has_receipts'), 'operator')).toMatch(/cancel the order instead/i)
      // The consequence, not the constraint: what deleting it would do to the bills.
      expect(errorText(raised('po_has_receipts'), 'operator')).toMatch(/bills/i)
    })
  })
})
