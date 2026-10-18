import type { QueryClient } from "@tanstack/react-query";
import { TERMINAL_SESSION_STATUSES } from "@/features/sessions/types";
import type { SessionsAndHolds } from "./types";

/** The live read once a session moved to `status`: an ended one leaves the sessions and the holds
 *  only it kept, a chat no longer running leaves the running chats; unchanged where nothing moved. */
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

/** A box's live count drops as a stop's event arrives, before the re-read lands (ISS-1228). */
export function moveSessionInLiveReads(qc: QueryClient, sessionId: string, status: string): void {
  qc.setQueriesData<SessionsAndHolds>({ queryKey: ["sessions-and-holds"] }, (prev) =>
    withSessionMoved(prev, sessionId, status),
  );
}
