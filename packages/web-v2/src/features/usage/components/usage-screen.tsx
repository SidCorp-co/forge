"use client";

// Workspace-tier Usage screen (`/usage`, ISS-359) — replaces the old Activity
// destination. Token-spend overview across the workspace, built to the redesign
// draft (`design/draft-screen/09 Usage.html`).
//
"use client";

// DATA: web-v2 has no org-level cost/spend aggregation endpoint yet — v1's usage
// dashboard is per-project only (`GET /api/usage-records/summary` requires a
// projectId). Until an org metering endpoint exists we render a calm empty state
// rather than fabricated sample figures (an earlier cut shipped hard-coded sample
// bars behind a "preview" banner — removed because a top-nav destination must
// never show invented numbers). Wire the real layout back in once the endpoint
// lands — do NOT fabricate API routes here.
//
// ISS-477 — even as a placeholder this must read per-ORGANIZATION, never
// cross-org: the page names the active org and the real rollup (when built) will
// scope to that org's projects, not a global workspace total.

import { EmptyState, PageContainer } from "@/design";
import { useActiveOrg } from "@/features/orgs/active-org";

export function UsageScreen() {
  const { activeOrg } = useActiveOrg();
  const orgName = activeOrg?.name ?? "your organization";

  return (
    <PageContainer>
      <header className="mb-4">
        <h1 className="fg-h2">Usage</h1>
        <p className="fg-body-sm mt-0.5 text-muted">
          Token spend for {orgName} · self-hosted
        </p>
      </header>

      <EmptyState
        title="Organization usage is coming"
        message={`Spend metering for ${orgName} isn't wired up yet. Per-project token usage is available on each project's dashboard in the meantime.`}
      />
    </PageContainer>
  );
}
