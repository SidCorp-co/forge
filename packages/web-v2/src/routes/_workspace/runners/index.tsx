import { createFileRoute } from "@tanstack/react-router";
import { RunnersScreen } from "@/features/runners";

function RunnersPage() {
  return <RunnersScreen />;
}

export const Route = createFileRoute("/_workspace/runners/")({ component: RunnersPage });
