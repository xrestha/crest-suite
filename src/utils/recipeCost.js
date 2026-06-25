// Shared recipe-costing helpers (pure, no React/Supabase deps).

// Suggested menu price to hit a target food-cost %, VAT-inclusive and rounded up to the
// nearest NPR 5. `cost` is the per-portion food cost (ex-VAT), `targetFcPct` is a fraction
// (0.30 = 30%). Used by the Recipe Costing page and the Menu Repricing report.
export function getSuggestedPrice(cost, vatRate = 0.13, targetFcPct = 0.30) {
  const basePrice = cost / targetFcPct
  return Math.ceil((basePrice * (1 + vatRate)) / 5) * 5
}
