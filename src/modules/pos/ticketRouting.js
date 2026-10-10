// Which menu categories print on the BAR ticket (BOT): POS Setup → Ticket Routing, stored in
// `settings.pos_bot_categories` (text[]). One reading of that column for every screen that uses it:
// the till's ticket split and its BOT button, Ticket Routing itself, Sales Report's Kitchen / Bar
// axis and Settings' category rename (S809 3m, FLOOR-KITCHEN-3, owner decision Q15 (1)).
//
//   NULL (never set, or no settings row)  the built-in default, Beverage to the bar, so a new outlet
//                                          still starts with drinks on the bar ticket.
//   an array, EMPTY included               exactly what was saved. Empty means the outlet has no bar:
//                                          every dish prints on the kitchen ticket.
//
// Until S809 3m every reader but Ticket Routing took an empty list for the default, so an all-Kitchen
// routing showed "Routing saved." while every till kept printing Beverage on a bar ticket nobody
// watched, and a later category rename in Settings wrote a bar category back in.
export const DEFAULT_BAR_CATEGORIES = Object.freeze(['Beverage'])

export function barCategoriesOf(stored) {
  return Array.isArray(stored) ? stored : DEFAULT_BAR_CATEGORIES
}

// Said by Ticket Routing, and by Sales Report's Kitchen / Bar note, when nothing goes to the bar.
export const NO_BAR_TEXT = 'No bar: every dish prints on the kitchen ticket.'
