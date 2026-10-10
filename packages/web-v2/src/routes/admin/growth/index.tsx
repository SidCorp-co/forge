import { createFileRoute } from "@tanstack/react-router";
import { OperatorGroup } from "@/features/operator";

function AdminGrowthPage() {
  return <OperatorGroup section="growth" />;
}

export const Route = createFileRoute("/admin/growth/")({ component: AdminGrowthPage });
