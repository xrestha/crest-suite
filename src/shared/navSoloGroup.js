// A nav group whose gates leave ONE reachable item renders that item alone, in the drawer and in
// the top bar (S844, owner decision). On Starter "Costing" held only Menu Pricing and "Stock
// Reports" only Wastage Report: a heading to open that named nothing like the one page inside.
// Two groups keep their heading with one item: a PRO-badged upsell group, whose heading IS the
// pitch, and Pinned, whose rows carry the unpin star a flat pill does not.
export function isSoloGroup(group, items) {
  return !!group.label && items.length === 1 && !group.badge && group.key !== 'pinned'
}
