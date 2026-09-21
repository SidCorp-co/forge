"use client";

// Workspace-tier Usage screen (`/usage`, ISS-359) — replaces the old Activity
// destination. Token-spend overview across the workspace, built to the redesign
// draft (`design/draft-screen/09 Usage.html`).
//
"use client";


import {
  EmptyState,
  PageContainer,
  PageTitle,
} from "@/design";
import { useActiveOrg } from "@/features/orgs/active-org";

export function UsageScreen() {
  const { activeOrg } = useActiveOrg();
  const orgName = activeOrg?.name ?? "your organization";

  return (
    <PageContainer>
      <header className="mb-4">
        <PageTitle className="fg-h2">Usage</PageTitle>
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
