"use client";

// A check-in moves no event, so the session page takes the newer of its row's check-in and the one
// the Pipeline page's polled read holds, rather than judging a row read once against a moving clock.

import { useMemo } from "react";
import { useSessionsAndHolds } from "@/features/pipeline/hooks";
import type { LiveSession } from "@/features/pipeline/types";
import { isInteractiveSession, type SessionRow } from "@/features/sessions/types";

function newer(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

/** The row with the newer of its own check-in and the live read's; the row itself where neither moves it. */
function withLiveCheckIn<T extends SessionRow>(row: T, live: LiveSession | undefined): T {
  if (!live) return row;
  const lastHeartbeatAt = newer(row.lastHeartbeatAt, live.lastHeartbeatAt);
  return lastHeartbeatAt === row.lastHeartbeatAt ? row : { ...row, lastHeartbeatAt };
}

export function useLiveSessionRow<T extends SessionRow>(row: T | undefined): T | undefined {
  const watched = row && row.status === "running" && !isInteractiveSession(row) ? row.projectId : undefined;
  const live = useSessionsAndHolds(watched);
  const liveSession = row ? live.data?.sessions.find((s) => s.id === row.id) : undefined;
  return useMemo(() => (row ? withLiveCheckIn(row, liveSession) : row), [row, liveSession]);
}
