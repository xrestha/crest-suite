// The invoice code a bill or credit note was printed under (S834, owner decision D35).
//
// A printed number is put together at print time: TI1147-<code>-83/84. The code used to come from
// today's settings.invoice_prefix, so changing it (CAC to CASA) relabelled every bill and note
// already issued. Since migration 20261014100000 the close stamps pos_orders.invoice_prefix and the
// issue stamps pos_credit_notes.invoice_prefix; '' is "printed with no code". A row from before that
// carries NULL (or a read that did not select the column, undefined) and keeps today's code, as before.
export function invoiceCodeOf(row, current) {
  return typeof row?.invoice_prefix === 'string' ? row.invoice_prefix : (current || '')
}
