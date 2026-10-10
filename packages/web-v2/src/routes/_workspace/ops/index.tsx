import { createFileRoute } from "@tanstack/react-router";
import { OpsMonitor } from "@/features/pipeline";

function OpsPage() {
  return <OpsMonitor />;
}

export const Route = createFileRoute("/_workspace/ops/")({ component: OpsPage });
