"use client";

// Workspace-tier Settings (`/v2/settings`). User-scoped (account/tokens/
// notifications are not project-bound), so it lives here rather than under a
// project. The auth-provider hydrates the user; the layout owns the login gate.
import { SettingsScreen } from "@/features/settings/components/settings-screen";

export default function SettingsPage() {
  return <SettingsScreen />;
}
