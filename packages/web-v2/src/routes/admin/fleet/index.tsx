import { createFileRoute } from "@tanstack/react-router";
import { OperatorGroup } from "@/features/operator";

function AdminFleetPage() {
  return <OperatorGroup section="fleet" />;
}

export const Route = createFileRoute("/admin/fleet/")({ component: AdminFleetPage });
