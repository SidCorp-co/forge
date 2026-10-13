import { createFileRoute } from "@tanstack/react-router";
import { OverviewScreen } from "@/features/overview/components/overview-screen";

function OverviewPage() {
  return <OverviewScreen />;
}

export const Route = createFileRoute("/_workspace/")({ component: OverviewPage });
