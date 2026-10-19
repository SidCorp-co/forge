"use client";

import { formatElapsed, useElapsed } from "@/design/hooks/use-elapsed";
import type { SessionRow } from "./types";

type Timed = Pick<SessionRow, "startedAt" | "updatedAt">;

/** Ticks while live; once ended, started to its last update, which no later clock moves. */
export function useSessionDuration(session: Timed | undefined, live: boolean): string {
  const startMs = session?.startedAt ? new Date(session.startedAt).getTime() : undefined;
  const elapsed = useElapsed(startMs, live);
  if (!session || startMs === undefined) return "—";
  if (live) return elapsed;
  return formatElapsed(new Date(session.updatedAt).getTime() - startMs);
}
