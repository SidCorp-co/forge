import { createFileRoute } from "@tanstack/react-router";
import { OperatorGroup } from "@/features/operator";

function AdminAlertsPage() {
  return <OperatorGroup section="alerts" />;
}

export const Route = createFileRoute("/admin/alerts/")({ component: AdminAlertsPage });
