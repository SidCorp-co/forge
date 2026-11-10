import { useQuery } from "@tanstack/react-query";
import { readOf } from "@/lib/api/query-kit";
import { projectHomeApi } from "./api";

/** The reader's time zone, which the home's days and weeks are counted in. */
export function readerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Under the project status root, so every event that refreshes the status report refreshes the home. */
export const projectHomeKey = (projectId: string | undefined, tz: string) => ["project-status", "home", projectId, tz] as const;

export const useProjectHome = (projectId: string | undefined) => {
  const tz = readerZone();
  return useQuery(readOf(projectHomeKey(projectId, tz), () => projectHomeApi.read(projectId as string, tz)));
};
