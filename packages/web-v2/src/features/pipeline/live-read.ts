import type { QueryClient } from "@tanstack/react-query";
import { TERMINAL_SESSION_STATUSES } from "@/features/sessions/types";
import type { SessionsAndHolds } from "./types";

/**
 * The live read as it stands once a session has moved to `status`: an ended session leaves the
 * sessions, and the holds only it kept, and a chat no longer running leaves the running chats. The
 * read itself is returned unchanged where nothing in it moved.
 */
export function withSessionMoved(
  read: SessionsAndHolds | undefined,
  sessionId: string,
  status: string,
): SessionsAndHolds | undefined {
  if (!read) return read;
  const ended = TERMINAL_SESSION_STATUSES.has(status);
  const runningChats =
    status === "running" ? read.runningChats : read.runningChats.filter((c) => c.id !== sessionId);
  if (!ended) return runningChats.length === read.runningChats.length ? read : { ...read, runningChats };
  const sessions = read.sessions.filter((s) => s.id !== sessionId);
  const holds = read.holds
    .map((h) => ({ ...h, holders: h.holders.filter((x) => x.by !== "session" || x.sessionId !== sessionId) }))
    .filter((h) => h.holders.length > 0);
  const kept = (h: SessionsAndHolds["holds"][number]) =>
    h.holders.every((x) => x.by !== "session" || x.sessionId !== sessionId);
  const moved =
    runningChats.length !== read.runningChats.length ||
    sessions.length !== read.sessions.length ||
    !read.holds.every(kept);
  return moved ? { ...read, sessions, holds, runningChats } : read;
}

/** Move a session in every open live read as its event arrives, before the re-read lands, so a
 *  box's count of live sessions drops the moment a stop is known (ISS-1228). */
export function moveSessionInLiveReads(qc: QueryClient, sessionId: string, status: string): void {
  qc.setQueriesData<SessionsAndHolds>({ queryKey: ["sessions-and-holds"] }, (prev) =>
    withSessionMoved(prev, sessionId, status),
  );
}
