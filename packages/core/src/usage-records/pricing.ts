// Pricing helpers moved to `@forge/observability` so the desktop runner
// can share the same table (ISS-210 in-flight budget kill). Kept as a
// thin re-export to avoid churning existing call sites.
export { lookupPricing, estimateCost } from '@forge/observability';
