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

  it('names a timeout without claiming the request did or did not land (S776)', () => {
    const err = new Error('Closing the bill timed out after 20s — check your connection and try again.')
    err.name = 'TimeoutError'
    for (const audience of ['staff', 'operator']) {
      const text = errorText(err, audience)
      expect(text).toMatch(/too long/i)
      expect(text).not.toMatch(/nothing was saved|not saved|did not go through|didn't go through/i)
    }
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

    it('a till too old for the database is told it reloads itself and keeps its unsent items (S809 1b)', () => {
      const err = hinted('pos_till_build_too_old', 'pos_till_build_too_old: this page runs crest-v412, and bills now need crest-v413 or newer; reload the page', 'P0001')
      expect(errorText(err, 'staff')).toMatch(/reloads itself/i)
      expect(errorText(err, 'staff')).toMatch(/not sent/i)
      expect(errorText(err, 'operator')).toMatch(/reload the page/i)
    })

    it('every code the two migrations raise has its own sentence in both audiences', () => {
      const generic = { staff: errorText({ code: '42501' }, 'staff'), operator: errorText({ code: '42501' }, 'operator') }
      const fallback = { staff: errorText({ message: 'x' }, 'staff'), operator: errorText({ message: 'x' }, 'operator') }
      const codes = ['bill_locked', 'rank_required', 'stale_order', 'order_not_open', 'order_not_closed', 'line_not_on_menu',
        'credit_note_exists', 'award_window_closed', 'redeem_exceeds_bill', 'pos_shift_rank', 'pos_cash_movement_rank',
        'pos_cash_refund_rank', 'pos_setup_rank', 'invoice_settings_rank', 'pos_tables_rank', 'loyalty_rank',
        'loyalty_enrol_rank', 'pos_shift_closed', 'pos_shift_locked', 'pos_cash_movement_locked',
        'pos_cash_movement_shift_closed', 'pos_cash_refund_over', 'pos_table_has_open_order',
        // S755
        'table_hold_overlap', 'credit_note_amounts',
        // S809 1b
        'pos_till_build_too_old']
      for (const c of codes) {
        for (const aud of ['staff', 'operator']) {
          const text = errorText({ code: '42501', hint: c, message: 'refused' }, aud)
          expect([c, text]).not.toEqual([c, generic[aud]])
          expect([c, text]).not.toEqual([c, fallback[aud]])
        }
      }
    })
  })

  // S809 1k. The parking-slip and payment-confirmation guards (migration 20261009170000).
  describe('the parking slip and payment confirmation refusals', () => {
    const codes = ['pos_parking_slip_rank', 'pos_parking_slip_bill', 'pos_parking_slip_locked',
      'pos_parking_slip_closed', 'pos_parking_slip_not_stale', 'pos_payment_confirmation_locked']

    it('every code has its own sentence in both audiences, ahead of the generic ones', () => {
      const generic = { staff: errorText({ code: '42501' }, 'staff'), operator: errorText({ code: '42501' }, 'operator') }
      const fallback = { staff: errorText({ message: 'x' }, 'staff'), operator: errorText({ message: 'x' }, 'operator') }
      for (const c of codes) {
        for (const aud of ['staff', 'operator']) {
          const text = errorText({ code: '42501', hint: c, message: 'refused' }, aud)
          expect([c, text]).not.toEqual([c, generic[aud]])
          expect([c, text]).not.toEqual([c, fallback[aud]])
        }
      }
      // and no two of them share a sentence
      const seen = new Set(codes.map(c => errorText({ hint: c, message: 'refused' }, 'operator')))
      expect(seen.size).toBe(codes.length)
    })

    it('matches on the hint alone and on a message that leads with the table', () => {
      const hinted = { code: '42501', hint: 'pos_parking_slip_rank', message: 'pos_parking_slips: issuing a parking slip needs a POS supervisor, a POS manager or the Owner' }
      expect(errorText(hinted, 'staff')).toMatch(/supervisor/i)
      expect(errorText({ message: 'pos_parking_slip_bill: …' }, 'operator')).toMatch(/bill of this outlet/i)
    })

    it('a print or close by a login with no POS rank falls to the shared rank sentence, not the issue one', () => {
      const err = { code: '42501', hint: 'rank_required', message: 'pos_parking_slips: printing or closing a parking slip needs a POS login (Staff rank or above) or the Owner' }
      expect(errorText(err, 'operator')).toMatch(/POS Staff/)
      expect(errorText(err, 'operator')).not.toMatch(/issue slips/i)
    })

    it('says nothing was changed or issued — each is raised before the statement writes', () => {
      for (const c of codes) {
        expect(errorText({ hint: c, message: 'refused' }, 'operator')).toMatch(/nothing was changed|no slip was issued|slip was not issued/i)
      }
    })
  })

  // S755. A same-second double booking and a credit note whose amounts are not the bill's.
  describe('the S755 table-hold and credit-note amount refusals', () => {
    it('a table-hold refusal says the table is taken and sends the reader to refresh, ahead of the generic sentences', () => {
      const err = { code: '23P01', hint: 'table_hold_overlap', message: 'table_hold_overlap: Table 4 is already held for Sharma ×4 at 7:30 PM on 2026-09-18 (Nepal time) — pick another table or change the time' }
      expect(errorText(err, 'staff')).toMatch(/already booked/i)
      expect(errorText(err, 'operator')).toMatch(/refresh the list/i)
      expect(errorText({ message: err.message }, 'operator')).toBe(errorText(err, 'operator'))
    })

    it('a credit-note amount refusal says no note was issued and that a retry of the same amounts will not help', () => {
      const err = { code: '23514', hint: 'credit_note_amounts', message: 'pos_credit_notes: the amounts on this Credit Note do not match the bill it credits' }
      expect(errorText(err, 'operator')).toMatch(/no note was issued/i)
      expect(errorText(err, 'operator')).toMatch(/reload the bill/i)
      // ahead of the generic CHECK sentence the 23514 code would otherwise get
      expect(errorText(err, 'operator')).not.toBe(errorText({ code: '23514' }, 'operator'))
    })

    it('since S809 1l the VAT-change case no longer sends the reader to a screen that skips the check', () => {
      const err = { code: '23514', hint: 'credit_note_amounts', message: 'pos_credit_notes: the amounts on this Credit Note do not match the bill it credits' }
      expect(errorText(err, 'operator')).toMatch(/Crest support’s included/)
      expect(errorText(err, 'operator')).toMatch(/bill’s own VAT/)
      expect(errorText(err, 'operator')).not.toMatch(/cannot be issued from the till — contact support/)
    })
  })

  // S809 1l (migration 20261009180000). pos_shifts_guard adds up the shift's own cash as it closes,
  // and the counted total must be the notes counted.
  describe('the shift-close cash refusals', () => {
    const changed = { code: 'P0001', hint: 'pos_shift_figures_changed', message: "pos_shift_figures_changed: this shift's cash figures are not the ones sent with the close (cashSales, byMethod.Cash, expectedCash, variance) — a bill or a cash entry probably reached the shift after its figures were read; nothing was closed, so press Close Shift again to count against the new figures" }
    const counted = { code: '23514', hint: 'pos_shift_count_mismatch', message: 'pos_shift_count_mismatch: the counted cash (NPR 3530) is not the total of the notes counted (NPR 3430) — count the drawer on the Shifts screen, which adds the notes up itself' }
    const fallback = errorText({ message: 'x' }, 'operator')

    it('a close refused because a bill landed during the count says the count is kept and to press Close Shift again', () => {
      for (const aud of ['staff', 'operator']) {
        expect(errorText(changed, aud)).toMatch(/press Close Shift again/i)
        expect(errorText(changed, aud)).toMatch(/still open/i)
      }
      expect(errorText(changed, 'operator')).not.toBe(fallback)
      // the hint lost, the code still leads the message
      expect(errorText({ message: changed.message }, 'operator')).toBe(errorText(changed, 'operator'))
    })

    it('a count that does not add up says so, ahead of the generic CHECK sentence, without offering the same retry', () => {
      expect(errorText(counted, 'operator')).toMatch(/notes counted/i)
      expect(errorText(counted, 'operator')).not.toBe(errorText({ code: '23514' }, 'operator'))
      expect(errorText(counted, 'operator')).not.toMatch(/try again/i)
    })

    it('neither code is matched by the other', () => {
      expect(errorText(changed, 'operator')).not.toBe(errorText(counted, 'operator'))
    })
  })

  // S809 1c. A close whose status and close type disagree is refused by guard_pos_order_close
  // with ERRCODE 22023, which no generic rule words.
  describe('the S809 mismatched-close refusal', () => {
    const err = {
      code: '22023',
      hint: 'pos_close_mismatch',
      message: 'pos_orders: a bill closes as paid or complimentary (billed) or as void (voided), and this close sent status voided with close type none',
    }

    it('names the three ways a bill closes and sends the reader to the Payment screen, in both audiences', () => {
      for (const aud of ['staff', 'operator']) {
        const text = errorText(err, aud)
        expect(text).toMatch(/void/i)
        expect(text).toMatch(/Payment screen/)
        expect(text).not.toBe(errorText({ message: 'x' }, aud))
      }
    })

    it('matches on the hint alone, and is not the generic closed-bill sentence', () => {
      expect(errorText({ code: '22023', hint: 'pos_close_mismatch', message: 'refused' }, 'operator')).toBe(errorText(err, 'operator'))
      expect(errorText(err, 'operator')).not.toBe(errorText({ code: '42501', hint: 'bill_locked', message: 'refused' }, 'operator'))
    })
  })

  // S809 1d. The kitchen-ticket log and the pulled-item record, guarded by triggers.
  describe('the S809 kitchen-ticket and pulled-item refusals', () => {
    const codes = ['pos_kot_ticket_locked', 'pos_kot_other_outlet', 'pos_kot_cancel_rank',
      'pos_kot_status_backwards', 'pos_kot_removal_direct', 'pos_item_sent_lowered']

    it('every code has its own sentence in both audiences, ahead of the generic ones', () => {
      for (const c of codes) {
        for (const aud of ['staff', 'operator']) {
          const text = errorText({ code: '42501', hint: c, message: 'refused' }, aud)
          expect([c, text]).not.toEqual([c, errorText({ code: '42501' }, aud)])
          expect([c, text]).not.toEqual([c, errorText({ message: 'x' }, aud)])
        }
      }
      // the outlet refusal is raised as 23503, which has its own generic sentence too
      expect(errorText({ code: '23503', hint: 'pos_kot_other_outlet', message: 'x' }, 'operator'))
        .not.toBe(errorText({ code: '23503', message: 'x' }, 'operator'))
    })

    it('matches on the message alone, where the hint was lost', () => {
      const err = { message: 'pos_kot_ticket_locked: a kitchen ticket is the record of what was sent to the kitchen or bar…' }
      expect(errorText(err, 'operator')).toMatch(/void it/i)
      expect(errorText({ message: 'pos_item_sent_lowered: a dish already sent…' }, 'operator')).toMatch(/Pulled Items/)
    })

    it('a cancel refusal names who may cancel, and a backwards move sends the reader to reload', () => {
      expect(errorText({ code: '42501', hint: 'pos_kot_cancel_rank', message: 'x' }, 'staff')).toMatch(/supervisor/i)
      expect(errorText({ code: '42501', hint: 'pos_kot_status_backwards', message: 'x' }, 'staff')).toMatch(/reload/i)
    })
  })

  // S809 1j. apply_pos_item_comps refuses a part-comp outside 1..qty-1 before it writes anything.
  describe('the part-comp quantity refusal (S809 1j)', () => {
    const err = {
      code: '22023',
      hint: 'pos_comp_qty_invalid',
      message: 'pos_comp_qty_invalid: Chicken Momo can be made complimentary from 1 up to 2 here (the bill has 3), not 5 — a whole line is comped in full',
    }

    it('says nothing was made complimentary and how to comp a whole dish', () => {
      expect(errorText(err, 'staff')).toMatch(/nothing was made complimentary/i)
      expect(errorText(err, 'operator')).toMatch(/nothing was made complimentary/i)
      expect(errorText(err, 'operator')).toMatch(/whole dish/i)
    })

    it('matches on the message alone when the hint was lost, ahead of the fallback', () => {
      expect(errorText({ message: err.message }, 'operator')).toBe(errorText(err, 'operator'))
      expect(errorText(err, 'staff')).not.toBe(errorText({ message: 'x' }, 'staff'))
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

    // S798 4e (DOCS-7): the exact texts the live functions raise. Each was plain text before and fell
    // through to the fallback, whose "Try again" could never work.
    it('a Crest Staff swap refusal has its own sentence, never the fallback', () => {
      const fallback = errorText({ message: 'something nobody wrote a rule for' }, 'staff')
      const cases = [
        ['swap_not_found: request not found', /already been decided or withdrawn/i],
        ['swap_not_pending: request is no longer pending', /already been decided or withdrawn/i],
        ['swap_coworker_unavailable: coworker not found', /can't answer a swap/i],
        ['swap_own_shift_gone: you have no shift on that day', /your shift on that day has changed/i],
        ['swap_coworker_shift_gone: coworker has no shift on that day', /their days have been refreshed/i],
      ]
      for (const [message, wording] of cases) {
        const text = errorText({ code: 'P0001', message }, 'staff')
        expect(text).not.toBe(fallback)
        expect(text).toMatch(wording)
      }
      for (const name of ['swap_own_shift_gone', 'swap_coworker_shift_gone']) {
        expect(errorText(raised(name), 'staff')).toMatch(/nothing was sent/i)
      }
    })
  })
})

// S782 — salary payments. The rank refusal carries ERRCODE 42501, so it must sit ahead of the
// generic permission rule or it would read as a bare "not allowed".
describe('salary payment refusals', () => {
  const raised = (name, code = 'P0001') => ({ code, message: `${name}: …` })

  it('the rank refusal names who can do it, ahead of the generic 42501 rule', () => {
    const text = errorText(raised('salary_payment_rank', '42501'), 'operator')
    expect(text).toMatch(/Owner or an HR manager/)
    expect(text).toMatch(/nothing was recorded/i)
  })

  it('a stale page is told to reload, not to retry blind', () => {
    for (const name of ['salary_payment_nothing_due', 'salary_payment_not_finalized', 'salary_payment_already_voided', 'salary_payment_run_missing']) {
      expect(errorText(raised(name), 'operator')).toMatch(/reload the page/i)
    }
  })

  it('a direct write is pointed back at the Payroll page', () => {
    expect(errorText(raised('salary_payment_ledger_locked'), 'operator')).toMatch(/Mark paid/)
  })
})

// S792 (STOCK-2). Every IMS database guard raises ERRCODE 42501 with a hint. S756 appended their
// rules AFTER the generic 42501 rule, and the first-match lookup meant each read "You're not allowed
// to do that" — the closed-month, month-rank and rank refusals never reached their own sentence.
// Each case below is the real shape PostgREST returns: the code, the hint and the trigger's message.
describe('IMS database guard refusals (S756/S792)', () => {
  const GENERIC = /You're not allowed to do that/
  const raised = (hint, message, code = '42501') => ({ code, hint, message })

  it.each([
    ['period_closed', 'closing_stock: this month is closed, so its figures cannot be changed except by the account owner', /month is closed/i],
    ['period_rank', 'monthly_periods: closing the month needs the account owner or an IMS supervisor or manager', /start or close a month/i],
    ['recipe_delete_rank', 'recipes: deleting a dish needs an IMS manager', /Deleting a dish/],
    ['recipe_hide_rank', 'recipes: hiding a dish needs an IMS supervisor', /Hiding or showing a dish/],
    ['ims_settings_rank', 'ims_settings_rank: only the Owner or an IMS manager can change the inventory thresholds', /thresholds/],
    ['ims_rank', 'items: changing an item needs an IMS supervisor, a manager or the account owner', /inventory rank/],
    ['item_unit_locked', 'items: MILK already has purchases, counts or recipe lines recorded in ML, so its unit cannot change', /unit cannot change/],
    ['ims_count_settings_rank', 'ims_count_settings_rank: only the Owner or an IMS manager can change how stock counts are fenced', /recount protection/],
    ['po_receipt_only', 'purchase_order_items: a received quantity is recorded only by receiving the delivery', /Receive on the order/],
    ['snapshot_frozen', "monthly_periods: this month's target is already set, and only a newer forecast can replace it", /target is already set/],
  ])('%s reaches its own sentence, not the generic one', (hint, message, expected) => {
    const text = errorText(raised(hint, message), 'operator')
    expect(text).toMatch(expected)
    expect(text).not.toMatch(GENERIC)
    expect(errorText(raised(hint, message), 'staff')).not.toMatch(GENERIC)
  })

  it('a double-posted depreciation run says it was not charged twice', () => {
    const e = raised('dep_run_duplicate', 'dep_run_duplicate: this run was posted moments ago, from this page or another', 'P0001')
    expect(errorText(e, 'operator')).toMatch(/not charged a second time/)
  })

  // S792 stage 3 (migration 20260928180000): not 42501, and the generic constraint rule at the end
  // would otherwise swallow the 23514.
  it.each([
    ['recipe_cycle', 'recipe_cycle: Sauce B already contains Sauce A', '23514', /already contains this dish/],
    ['item_other_client', 'item_other_client: that item belongs to another business', '23503', /belongs to another business/],
  ])('%s reaches its own sentence', (hint, message, code, expected) => {
    expect(errorText(raised(hint, message, code), 'operator')).toMatch(expected)
    expect(errorText(raised(hint, message, code), 'staff')).toMatch(expected)
  })

  it('a read stopped at fetchAllRows\' ceiling says so, by code or by message alone (TAX-13)', () => {
    expect(errorText({ code: 'crest_row_cap', hint: 'crest_row_cap', message: 'x' }, 'operator')).toMatch(/stopped rather than shown with a short total/)
    expect(errorText({ message: 'This list is too long to read in full: it runs past 1,00,000 rows' }, 'staff')).toMatch(/too long for Crest to read in full/)
  })

  it('a plain RLS refusal with no hint still gets the generic sentence', () => {
    expect(errorText({ code: '42501', message: 'new row violates row-level security policy for table "x"' }, 'operator')).toMatch(GENERIC)
  })
})

// S798 3a (owner decision H2, H13): your own pay and a run that pays you are the Owner's; a decided
// travel claim goes back to pending at HR manager rank. Each raises P0001 with the code first.
describe('own pay, own run and claim undo refusals (S798 3a)', () => {
  const raised = name => ({ code: 'P0001', message: `${name}: …` })

  it('your own pay names the Owner and says nothing was saved', () => {
    const text = errorText(raised('hr_own_pay'), 'operator')
    expect(text).toMatch(/Owner/)
    expect(text).toMatch(/nothing was saved/i)
  })

  it('a run that pays you is the Owner\'s to finalize', () => {
    expect(errorText(raised('hr_own_run'), 'operator')).toMatch(/Owner finalizes/)
    expect(errorText(raised('hr_own_run'), 'staff')).toMatch(/Owner finalizes/)
  })

  it('undoing a claim decision names who can', () => {
    expect(errorText(raised('tada_undo_rank'), 'operator')).toMatch(/HR manager or the Owner/)
  })
})

// S809 1i (migration 20261009150000). The payment-line guard and the customer-book guard raise a
// stable code in HINT and lead the message with it, like the S754 POS guards.
describe('POS payment-line and customer-book refusals (S809 1i)', () => {
  const hinted = (hint, message) => ({ code: '42501', hint, message })

  it('a hand edit of a payment line points at Undo on the points, ahead of the generic permission sentence', () => {
    const err = hinted('pos_payment_line_locked', "pos_payment_line_locked: a bill's payment lines are written by the till itself …")
    expect(errorText(err, 'operator')).toMatch(/Undo on the points/)
    expect(errorText(err, 'staff')).toMatch(/Nothing was changed/)
    expect(errorText(err, 'operator')).not.toBe(errorText({ code: '42501' }, 'operator'))
    // the message alone still matches when the hint was lost
    expect(errorText({ message: err.message }, 'operator')).toBe(errorText(err, 'operator'))
  })

  it('a closed bill keeps its own sentence', () => {
    const closed = hinted('bill_locked', 'pos_order_payments: this bill is closed, so how it was paid can no longer be changed')
    expect(errorText(closed, 'operator')).toMatch(/closed and printed/i)
    expect(errorText(closed, 'operator')).not.toMatch(/Undo on the points/)
  })

  it('a customer with points history is not deleted, and the sentence says how to stop them earning', () => {
    const err = hinted('pos_customer_has_points_history', 'pos_customer_has_points_history: this customer has a loyalty points history …')
    expect(errorText(err, 'operator')).toMatch(/Customers → Loyalty/)
    expect(errorText(err, 'staff')).toMatch(/Nothing was changed/)
  })

  it('deleting an enrolled customer below POS manager names who can', () => {
    const err = hinted('pos_customer_delete_rank', 'pos_customer_delete_rank: this customer is enrolled in a loyalty scheme …')
    expect(errorText(err, 'operator')).toMatch(/Owner or a POS manager/)
    expect(errorText(err, 'operator')).not.toBe(errorText(hinted('loyalty_enrol_rank', 'loyalty_enrol_rank: …'), 'operator'))
  })

  it('a phone change says the points stay with the old number, and does not send the reader to support', () => {
    const err = hinted('pos_customer_phone_locked', "pos_customer_phone_locked: a customer's phone number and outlet …")
    expect(errorText(err, 'staff')).toMatch(/new customer/i)
    expect(errorText(err, 'operator')).toMatch(/stay with the old number/)
    // GAP-OPERATOR-1 / Q26 (a): the operator is held to this rule too, so support cannot do it either
    expect(errorText(err, 'operator')).not.toMatch(/support/i)
  })

  it('every code this slice raises has its own sentence in both audiences', () => {
    const generic = { staff: errorText({ code: '42501' }, 'staff'), operator: errorText({ code: '42501' }, 'operator') }
    const fallback = { staff: errorText({ message: 'x' }, 'staff'), operator: errorText({ message: 'x' }, 'operator') }
    for (const c of ['pos_payment_line_locked', 'pos_customer_has_points_history', 'pos_customer_delete_rank', 'pos_customer_phone_locked']) {
      for (const aud of ['staff', 'operator']) {
        const text = errorText({ code: '42501', hint: c, message: 'refused' }, aud)
        expect([c, text]).not.toEqual([c, generic[aud]])
        expect([c, text]).not.toEqual([c, fallback[aud]])
      }
    }
  })
})

// S809 3k (migration 20261010110000, owner decision Q13 b): adjust_loyalty_points.
describe('hand corrections of a points balance (S809 3k)', () => {
  const codes = ['pos_points_adjust_rank', 'pos_points_adjust_amount', 'pos_points_adjust_reason',
    'pos_points_adjust_below_zero', 'pos_points_adjust_partner', 'pos_points_adjust_no_customer']

  it('every code has its own sentence in both audiences, ahead of the generic ones', () => {
    const generic = { staff: errorText({ code: '42501' }, 'staff'), operator: errorText({ code: '42501' }, 'operator') }
    const fallback = { staff: errorText({ message: 'x' }, 'staff'), operator: errorText({ message: 'x' }, 'operator') }
    const seen = new Set()
    for (const c of codes) {
      for (const aud of ['staff', 'operator']) {
        const text = errorText({ code: c === 'pos_points_adjust_rank' ? '42501' : 'P0001', hint: c, message: 'refused' }, aud)
        expect([c, text]).not.toEqual([c, generic[aud]])
        expect([c, text]).not.toEqual([c, fallback[aud]])
        // Raised before the ledger row is written, so each may say so.
        expect([c, text]).toEqual([c, expect.stringMatching(/No points were changed|no points were changed|none were added/)])
        seen.add(text)
      }
    }
    expect(seen.size).toBe(codes.length * 2)
  })

  it('the message alone still matches when the hint was lost', () => {
    const msg = 'pos_points_adjust_below_zero: this customer holds 40 points, so at most 40 can be taken off, and no points were changed'
    expect(errorText({ message: msg }, 'operator')).toBe(errorText({ code: 'P0001', hint: 'pos_points_adjust_below_zero', message: msg }, 'operator'))
  })

  it('the till and the award refusals send the reader to Customers → Loyalty, not to "ask the Owner" with nowhere to go', () => {
    const late = { code: '42501', hint: 'award_window_closed', message: 'This bill closed too long ago …' }
    const notCloser = { code: '42501', hint: 'rank_required', message: 'Points for a bill are added by the person who closed it, as it closes — …' }
    for (const err of [late, notCloser]) {
      for (const aud of ['staff', 'operator']) expect(errorText(err, aud)).toMatch(/Customers → Loyalty/)
    }
  })

  it('a phone change still says the points stay with the old number, and now how to move them', () => {
    const err = { code: '42501', hint: 'pos_customer_phone_locked', message: "pos_customer_phone_locked: a customer's phone number and outlet …" }
    expect(errorText(err, 'operator')).toMatch(/stay with the old number/)
    expect(errorText(err, 'operator')).toMatch(/Adjust in Customers → Loyalty/)
  })
})

describe('login link refusals (S798 3f-1)', () => {
  const raised = (name, code = 'P0001') => ({ code, message: `${name}: …` })

  it('the two 42501 refusals name who can, ahead of the generic permission rule', () => {
    expect(errorText(raised('login_link_rank', '42501'), 'operator')).toMatch(/Only the Owner links or unlinks/)
    expect(errorText(raised('login_link_outlet', '42501'), 'operator')).toMatch(/Switch to that outlet/)
  })

  it('each refusal says what to do and that nothing changed', () => {
    for (const [name, says] of [
      ['login_link_not_hr', /HR staff login/],
      ['login_link_taken', /Unlink it first/],
      ['login_link_employee_taken', /unlink the other one first/],
      ['login_link_no_access', /Outlet Access/],
      ['login_link_missing', /Reload the page/],
    ]) {
      const text = errorText(raised(name), 'operator')
      expect(text).toMatch(says)
      expect(text).toMatch(/Nothing was changed/)
    }
  })
})

describe('till PIN outlet refusals (S809 ACCESS-4)', () => {
  const refused = (name, msg) => ({ code: '42501', hint: name, message: `${name}: ${msg}` })

  it('a PIN login switching outlet is told it stays at its own, ahead of the generic permission rule', () => {
    const err = refused('pos_pin_outlet_pinned', 'a till PIN login works only at its own outlet, so it cannot switch to another')
    expect(errorText(err, 'staff')).toMatch(/only at its own outlet/)
    expect(errorText(err, 'staff')).toMatch(/Nothing was changed/)
    expect(errorText(err, 'operator')).toMatch(/POS Staff/)
    expect(errorText(err, 'operator')).not.toBe(errorText({ code: '42501', message: 'x' }, 'operator'))
    // A wrapper that dropped the hint still matches on the message.
    expect(errorText({ message: err.message }, 'operator')).toBe(errorText(err, 'operator'))
  })

  it('granting a PIN login another outlet says nothing was saved and where to add them instead', () => {
    const err = refused('outlet_access_pin_login', 'a till PIN login works only at its own outlet, so it cannot be given another')
    expect(errorText(err, 'operator')).toMatch(/nothing was saved/)
    expect(errorText(err, 'operator')).toMatch(/PIN of their own/)
  })
})
