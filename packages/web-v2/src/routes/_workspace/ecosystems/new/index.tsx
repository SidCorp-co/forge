import { createFileRoute } from "@tanstack/react-router";
// Create an ecosystem and invite its first members (`/ecosystems/new`); built by `ecosystemRoutes.create`.
import { PageContainer } from "@/design";
import { NewEcosystemScreen } from "@/features/ecosystem/components/ecosystem-form";

function NewEcosystemPage() {
  return (
    <PageContainer className="min-w-0">
      <NewEcosystemScreen />
    </PageContainer>
  );
}

export const Route = createFileRoute("/_workspace/ecosystems/new/")({ component: NewEcosystemPage });
