import { createFileRoute } from "@tanstack/react-router";
// The person's ecosystems (`/ecosystems`), or the empty state with the requests to join; built by `ecosystemRoutes.list`.
import { PageContainer } from "@/design";
import { EcosystemsHome } from "@/features/ecosystem/components/ecosystems-home";

function EcosystemsPage() {
  return (
    <PageContainer className="min-w-0">
      <EcosystemsHome />
    </PageContainer>
  );
}

export const Route = createFileRoute("/_workspace/ecosystems/")({ component: EcosystemsPage });
