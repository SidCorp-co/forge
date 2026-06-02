"use client";

import { Suspense } from "react";
import { ProjectsConsole } from "@/features/projects/components/projects-console";

/**
 * The full Projects console (`/v2/projects`) — ISS-355 relocated it off the
 * landing route (now the Overview dashboard) to here. Reachable from the nav
 * project-switcher flyout's "All projects" / "New project" actions and the
 * mobile drawer "View all". `?new=1` opens the create-project dialog.
 *
 * Wrapped in Suspense because `ProjectsConsole` reads `useSearchParams()` (the
 * `?new=1` deep link).
 */
export default function ProjectsConsolePage() {
  return (
    <Suspense fallback={null}>
      <ProjectsConsole />
    </Suspense>
  );
}
