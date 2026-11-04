import { createFileRoute } from "@tanstack/react-router";
import { ActivityScreen } from "@/features/activity";

function ActivityPage() {
  return <ActivityScreen />;
}

export const Route = createFileRoute("/_workspace/activity/")({ component: ActivityPage });
