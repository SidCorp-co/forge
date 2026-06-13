"use client";

// Workspace-tier Usage screen (`/usage`, ISS-359) — replaces the old Activity
// destination. Token-spend overview across the workspace, built to the redesign
// draft (`design/draft-screen/09 Usage.html`).
//
// DATA: web-v2 has no cross-project cost/spend aggregation endpoint yet — v1's
// usage dashboard is per-project only (`GET /api/usage-records/summary` requires
// a projectId). Until a workspace metering endpoint exists we render a calm
// empty state rather than fabricated sample figures (an earlier cut shipped
// hard-coded sample bars behind a "preview" banner — removed because a top-nav
// destination must never show invented numbers). Wire the real layout back in
// once the endpoint lands — do NOT fabricate API routes here.
import { EmptyState, PageContainer } from "@/design";

export function UsageScreen() {
  return (
    <PageContainer>
      <header className="mb-4">
        <h1 className="fg-h2">Usage</h1>
        <p className="fg-body-sm mt-0.5 text-muted">
          Token spend across the workspace · self-hosted · all projects
        </p>
      </header>

      <EmptyState
        title="Workspace usage is coming"
        message="Cross-project spend metering isn't wired up yet. Per-project token usage is available on each project's dashboard in the meantime."
      />
    </PageContainer>
  );
}
