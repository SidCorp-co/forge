"use client";

// Workspace-tier Activity index (`/v2/activity`) — cross-project, no scope.
// Migrates v1 Chat Logs into the workspace feed (ISS-314).
import { ActivityScreen } from "@/features/activity/components/activity-screen";

export default function ActivityPage() {
  return <ActivityScreen />;
}
