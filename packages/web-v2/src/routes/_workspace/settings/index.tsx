import { createFileRoute } from "@tanstack/react-router";
import { SettingsScreen } from "@/features/settings/components/settings-screen";

function SettingsPage() {
  return <SettingsScreen />;
}

export const Route = createFileRoute("/_workspace/settings/")({ component: SettingsPage });
