import { createFileRoute } from "@tanstack/react-router";
import { OperatorOverviewScreen } from "@/features/operator";

function AdminOverviewPage() {
  return <OperatorOverviewScreen />;
}

export const Route = createFileRoute("/admin/")({ component: AdminOverviewPage });
