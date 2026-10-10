import { createFileRoute } from "@tanstack/react-router";
// One ecosystem's bus (`/ecosystems/[id]`): members across, contracts down, the detail of the pick below; built by `ecosystemRoutes.ecosystem`.
import { useParams } from "@/lib/navigation/router";
import { EcosystemScreen } from "@/features/ecosystem/components/ecosystem-screen";

function EcosystemPage() {
  const params = useParams<{ id: string }>();
  return params?.id ? <EcosystemScreen key={params.id} ecosystemId={decodeURIComponent(params.id)} /> : null;
}

export const Route = createFileRoute("/_workspace/ecosystems/$id/")({ component: EcosystemPage });
