import { createFileRoute } from "@tanstack/react-router";
import { OperatorGroup } from "@/features/operator";

function AdminMcpLogsPage() {
  return <OperatorGroup section="mcp-logs" />;
}

export const Route = createFileRoute("/admin/mcp-logs/")({ component: AdminMcpLogsPage });
