"use client";

// Create an ecosystem and invite its first members (`/ecosystems/new`); built by `ecosystemRoutes.create`.
import { PageContainer } from "@/design";
import { NewEcosystemScreen } from "@/features/ecosystem/components/ecosystem-form";

export default function NewEcosystemPage() {
  return (
    <PageContainer className="min-w-0">
      <NewEcosystemScreen />
    </PageContainer>
  );
}
