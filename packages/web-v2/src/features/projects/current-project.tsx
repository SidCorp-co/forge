"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { ProjectListItem } from "./types";

// The rail's resolved project: on a screen with no slug in its URL (Settings) it is
// the only answer to "which project is this person working in". Null when there is none.
const CurrentProjectContext = createContext<ProjectListItem | null>(null);
const CurrentProjectRefContext = createContext<string | undefined>(undefined);

/** `projectRef` is what reads address the rail's project by: its slug until the list names its uuid (`useProjectRef`). */
export function CurrentProjectProvider({
  project,
  projectRef,
  children,
}: {
  project: ProjectListItem | null;
  projectRef?: string;
  children: ReactNode;
}) {
  return (
    <CurrentProjectContext.Provider value={project}>
      <CurrentProjectRefContext.Provider value={projectRef ?? project?.id}>{children}</CurrentProjectRefContext.Provider>
    </CurrentProjectContext.Provider>
  );
}

export function useCurrentProject(): ProjectListItem | null {
  return useContext(CurrentProjectContext);
}

export function useCurrentProjectRef(): string | undefined {
  return useContext(CurrentProjectRefContext);
}
