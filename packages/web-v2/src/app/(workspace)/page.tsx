"use client";

import { ProjectsConsole } from "@/features/projects/components/projects-console";

/**
 * Workspace landing = the Projects console (`/v2/projects`). Built on
 * `useProjectsConsole()`, which composes `useProjects()` (keyed `['projects']`)
 * + `useProjectHealth()` (keyed `['projects','health']`) — both keys the WS
 * event-router invalidates, so the console refreshes itself on live events
 * (run/issue/device changes) with no bespoke wiring.
 */
export default function ProjectsConsolePage() {
  return <ProjectsConsole />;
}
