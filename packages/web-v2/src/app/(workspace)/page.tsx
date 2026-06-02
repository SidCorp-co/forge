"use client";

import { OverviewScreen } from "@/features/overview/components/overview-screen";

/**
 * Workspace landing = the Overview dashboard (`/v2`) — ISS-355. Replaces the
 * old flat project list (which now lives at `/v2/projects`). Built entirely on
 * existing hooks (`useProjectsConsole` → `['projects']` + `['projects','health']`,
 * `useAttention` → `['attention']`, `useActivity` → `['chat-logs']`), all keys
 * the WS event-router already invalidates, so the dashboard refreshes itself on
 * live events with no bespoke wiring.
 */
export default function OverviewPage() {
  return <OverviewScreen />;
}
