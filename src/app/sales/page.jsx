/**
 * Sales Overview.
 *
 * Deliberately the same component as /dashboard rather than a copy of it: the
 * drill-down, filters, date range, scoping, search and metric filters are all
 * identical, and only the metrics on display differ. The component reads the
 * pathname to decide which set to show, so the two pages cannot drift apart.
 *
 * Admin-only — enforced in middleware for the page and in the API for the data.
 */
export { default } from "@/app/dashboard/page";
