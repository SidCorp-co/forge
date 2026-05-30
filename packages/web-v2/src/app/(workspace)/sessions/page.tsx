"use client";

// Workspace-tier Sessions index (`/v2/sessions`) — cross-project, no scope.
import { SessionsScreen } from "@/features/sessions/components/sessions-screen";

export default function WorkspaceSessionsPage() {
  return <SessionsScreen />;
}
