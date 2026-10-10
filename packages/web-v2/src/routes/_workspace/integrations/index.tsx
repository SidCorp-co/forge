import { createFileRoute } from "@tanstack/react-router";
import { IntegrationsScreen } from "@/features/integrations/components/integrations-screen";

function IntegrationsPage() {
  return <IntegrationsScreen />;
}

export const Route = createFileRoute("/_workspace/integrations/")({ component: IntegrationsPage });
