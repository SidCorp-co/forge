import { createFileRoute } from "@tanstack/react-router";
import { OperatorGroup } from "@/features/operator";

function AdminPipelinePage() {
  return <OperatorGroup section="pipeline" />;
}

export const Route = createFileRoute("/admin/pipeline/")({ component: AdminPipelinePage });
