// The one test for "is there a revenue to divide by" (S887), used by every ratio over revenue or
// sales on the dashboards, the reports and the frozen Owner Report.
//
// A month whose bills were all credited back does not sum to 0: the bill and its minus add up to a
// float residue like 5.2e-13, and `revenue > 0` let that through. Dividing a margin by it printed
// a Net Margin of -240397222296944640000.0% on BLOOM CAFE's Home. Money in this product is never
// smaller than one paisa, so a figure under that is no revenue, and every ratio over it is null.
export const REVENUE_FLOOR = 0.01

// A float residue is not revenue: true only for a figure of at least one paisa.
export const hasRevenue = v => v != null && v >= REVENUE_FLOOR
