"use client";

import { Suspense } from "react";
import { ProjectsConsole } from "@/features/projects/components/projects-console";

/**
 * Workspace landing = the Projects console (`/v2/projects`). Built on
 * `useProjectsConsole()`, which composes `useProjects()` (keyed `['projects']`)
 * + `useProjectHealth()` (keyed `['projects','health']`) — both keys the WS
 * event-router invalidates, so the console refreshes itself on live events
 * (run/issue/device changes) with no bespoke wiring.
 *
 * Wrapped in Suspense because `ProjectsConsole` reads `useSearchParams()` (the
 * rail's `?new=1` deep link that opens the create-project dialog).
 */
export default function ProjectsConsolePage() {
  return (
    <Suspense fallback={null}>
      <ProjectsConsole />
    </Suspense>
  );
}
