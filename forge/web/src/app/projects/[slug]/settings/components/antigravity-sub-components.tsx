// Stub module — original sub-components depended on Strapi endpoints that
// have no equivalent on forge/core yet. Phase 2.6-F2 gates the runtime tab
// behind UnimplementedBanner; these exports remain to keep legacy imports
// compiling until the tab is rewritten in a later phase.

export function AntigravityUsageSection() {
  return null;
}

export function AntigravityQuotaSection() {
  return null;
}

export function AntigravityRunnersSection() {
  return null;
}

export function AntigravityHeader() {
  return null;
}
