"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ProjectListItem } from "@/features/projects/types";

// The rail's resolved project: on a screen with no slug in its URL (Settings) it is
// the only answer to "which project is this person working in". Null when there is none.
const CurrentProjectContext = createContext<ProjectListItem | null>(null);

export function CurrentProjectProvider({
  project,
  children,
}: {
  project: ProjectListItem | null;
  children: ReactNode;
}) {
  return <CurrentProjectContext.Provider value={project}>{children}</CurrentProjectContext.Provider>;
}

export function useCurrentProject(): ProjectListItem | null {
  return useContext(CurrentProjectContext);
}
