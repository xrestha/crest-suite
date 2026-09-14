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

  // S754. A POS table with QR guest orders on record is refused by a plain FK.
  describe('the POS table delete refused by its guest orders', () => {
    const fk = {
      code: '23503',
      message: 'update or delete on table "pos_tables" violates foreign key constraint "pos_guest_order_requests_table_id_fkey" on table "pos_guest_order_requests"',
    }

    it('names the consequence and offers Inactive instead of a retry', () => {
      const text = errorText(fk, 'operator')
      expect(text).toMatch(/guest orders/i)
      expect(text).toMatch(/inactive/i)
      expect(text).not.toMatch(/try again/i)
      expect(errorText(fk, 'staff')).toMatch(/ask your manager/i)
    })

    it('does not capture a foreign-key refusal from any other table', () => {
      const other = { code: '23503', message: 'update or delete on table "items" violates foreign key constraint "purchase_entries_item_id_fkey" on table "purchase_entries"' }
      expect(errorText(other, 'operator')).not.toMatch(/guest orders|inactive/i)
    })
  })

  // S754. The POS guards raise a stable code in HINT (supabase-js keeps it as `error.hint`), and most
  // also lead the message with it. Either must match, and the generic 42501/23505 rules must not win.
  describe('the POS bill-integrity and rank refusals', () => {
    const hinted = (hint, message, code = '42501') => ({ code, hint, message })

    it('matches on the hint alone, where the message carries no code', () => {
      const err = hinted('bill_locked', 'pos_orders: this bill is closed and printed, so it can no longer be changed — issue a Credit Note to correct it')
      expect(errorText(err, 'operator')).toMatch(/credit note/i)
      expect(errorText(err, 'operator')).not.toBe(errorText({ code: '42501' }, 'operator'))
    })

    it('matches on a message that leads with the code, where the hint was lost', () => {
      const err = { code: '42501', message: 'pos_shift_rank: opening or closing a shift needs a POS supervisor, a POS manager or the Owner' }
      expect(errorText(err, 'operator')).toMatch(/supervisor/i)
    })

    it('does not let one code match a longer code that contains it', () => {
      const locked = { message: 'pos_cash_movement_locked: a cash movement is a drawer record…' }
      expect(errorText(locked, 'operator')).toMatch(/correcting Cash In or Cash Out/i)
      expect(errorText(locked, 'operator')).not.toMatch(/needs a POS supervisor/i)
      const enrol = hinted('loyalty_enrol_rank', 'loyalty_enrol_rank: only the Owner or a POS manager can enrol…')
      expect(errorText(enrol, 'operator')).toMatch(/enrol/i)
    })

    it('a second credit note is named, ahead of the generic duplicate-key sentence', () => {
      const err = hinted('credit_note_exists', 'pos_credit_notes: this bill already has a Credit Note — a bill is credited once', '23505')
      expect(errorText(err, 'operator')).toMatch(/credited once/i)
      expect(errorText(err, 'operator')).not.toBe(errorText({ code: '23505' }, 'operator'))
    })

    it('bill_locked says what is locked, by the table the guard refused on', () => {
      const note = hinted('bill_locked', 'pos_credit_notes: an issued credit note cannot be changed — only its print count and Inventory posting mark are recorded afterwards')
      const settled = hinted('bill_locked', 'pos_orders: this bill is not an unsettled Credit bill, so it cannot be settled')
      const bill = hinted('bill_locked', 'pos_order_items: this bill is closed and printed, so its lines can no longer be changed — issue a Credit Note to correct it')
      expect(errorText(note, 'operator')).toMatch(/numbered tax document/i)
      expect(errorText(settled, 'operator')).toMatch(/settled on another device/i)
      expect(errorText(bill, 'operator')).toMatch(/closed and printed/i)
    })

    it('the recipe price refusal points at Menu Pricing, not at POS Staff', () => {
      const err = hinted('rank_required', 'recipes: a menu price, its VAT rate and whether a dish is on the POS menu are set by a manager (Menu Pricing)')
      expect(errorText(err, 'operator')).toMatch(/Menu Pricing/)
      expect(errorText(hinted('rank_required', 'pos_orders: closing a bill needs POS Supervisor access or above'), 'operator')).toMatch(/POS Staff/)
    })

    it('a stale order and a closed shift send the reader to reload, not to retry blind', () => {
      expect(errorText(hinted('stale_order', 'stale_order: this order was changed on another device…', 'P0001'), 'staff')).toMatch(/reload/i)
      expect(errorText(hinted('pos_shift_closed', 'pos_shift_closed: this shift is closed…'), 'operator')).toMatch(/reload/i)
    })

    it('every code the two migrations raise has its own sentence in both audiences', () => {
      const generic = { staff: errorText({ code: '42501' }, 'staff'), operator: errorText({ code: '42501' }, 'operator') }
      const fallback = { staff: errorText({ message: 'x' }, 'staff'), operator: errorText({ message: 'x' }, 'operator') }
      const codes = ['bill_locked', 'rank_required', 'stale_order', 'order_not_open', 'order_not_closed', 'line_not_on_menu',
        'credit_note_exists', 'award_window_closed', 'redeem_exceeds_bill', 'pos_shift_rank', 'pos_cash_movement_rank',
        'pos_cash_refund_rank', 'pos_setup_rank', 'invoice_settings_rank', 'pos_tables_rank', 'loyalty_rank',
        'loyalty_enrol_rank', 'pos_shift_closed', 'pos_shift_locked', 'pos_cash_movement_locked',
        'pos_cash_movement_shift_closed', 'pos_cash_refund_over', 'pos_table_has_open_order']
      for (const c of codes) {
        for (const aud of ['staff', 'operator']) {
          const text = errorText({ code: '42501', hint: c, message: 'refused' }, aud)
          expect([c, text]).not.toEqual([c, generic[aud]])
          expect([c, text]).not.toEqual([c, fallback[aud]])
        }
      }
    })
  })

  // S749. Raised by BEFORE triggers and by approve_shift_swap's one transaction.
  describe('the roster, attendance, leave and overtime refusals', () => {
    const raised = name => ({ code: 'P0001', message: `${name}: …` })

    it('a finalized month names the way out — reopen the payroll run', () => {
      expect(errorText(raised('hr_month_finalized'), 'operator')).toMatch(/reopen the payroll run/i)
      expect(errorText(raised('hr_month_finalized'), 'staff')).toMatch(/ask your manager/i)
    })

    it('an overlapping leave request says why two requests over one day cannot both stand', () => {
      expect(errorText(raised('leave_overlap'), 'operator')).toMatch(/balance/i)
    })

    it('a duplicate overtime day points at editing the entry that exists', () => {
      const err = { code: '23505', message: 'duplicate key value violates unique constraint "hr_overtime_entries_employee_day_key"' }
      expect(errorText(err, 'operator')).toMatch(/edit the existing entry/i)
      expect(errorText(err, 'operator')).toMatch(/twice/i)
    })

    it('the staff wording for a refused leave or swap says nothing was sent', () => {
      for (const name of ['leave_all_holidays', 'swap_day_past', 'swap_day_unpublished', 'swap_already_requested']) {
        expect(errorText(raised(name), 'staff')).toMatch(/nothing was sent/i)
      }
    })

    it('a shift type in use offers Active instead of the delete', () => {
      expect(errorText(raised('shift_type_in_use'), 'operator')).toMatch(/untick active/i)
    })

    it('every swap refusal says the roster was not changed — the approval is one transaction', () => {
      for (const name of ['swap_not_pending', 'swap_shift_changed', 'swap_day_taken', 'swap_not_permitted']) {
        expect(errorText(raised(name), 'operator')).toMatch(/roster was not changed/i)
      }
    })
  })
})
