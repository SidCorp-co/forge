import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { moveSessionInLiveReads } from "./live-read";
import type { LiveSession, SessionsAndHolds } from "./types";

const session = (id: string): LiveSession => ({
  id,
  kind: "pipeline",
  title: null,
  status: "running",
  runtimeState: null,
  deviceId: null,
  deviceName: null,
  parentSessionId: null,
  startedAt: null,
  lastHeartbeatAt: null,
  createdAt: "2026-10-21T02:00:00.000Z",
  issues: [],
  report: null,
});

const reading = (): SessionsAndHolds => ({
  sessions: [session("s-1")],
  holds: [],
  runningChats: [],
  readAt: "2026-10-21T02:00:00.000Z",
});

const KEY = ["sessions-and-holds", "project-1"];

/** A client with no failure guard, so what is read is what this function wrote. */
function holding(read: SessionsAndHolds): { qc: QueryClient; writes: () => number } {
  const qc = new QueryClient();
  qc.setQueryData(KEY, read, { updatedAt: 1_000 });
  let writes = 0;
  qc.getQueryCache().subscribe((e) => {
    if (e.type === "updated" && (e.action as { type: string }).type === "success") writes += 1;
  });
  return { qc, writes: () => writes };
}

describe("a session frame on the live read (criterion 233)", () => {
  it("writes nothing where it changes nothing, so the reading keeps when it was read", () => {
    const { qc, writes } = holding(reading());
    moveSessionInLiveReads(qc, "s-1", "running");
    moveSessionInLiveReads(qc, "s-unknown", "completed");
    expect(writes()).toBe(0);
    expect(qc.getQueryState(KEY)?.dataUpdatedAt).toBe(1_000);
  });

  it("drops a session that ended from a read that stands", () => {
    const { qc, writes } = holding(reading());
    moveSessionInLiveReads(qc, "s-1", "completed");
    expect(writes()).toBe(1);
    expect(qc.getQueryData<SessionsAndHolds>(KEY)?.sessions).toEqual([]);
  });

  it("never writes a failed read, which keeps what it last read", () => {
    const { qc, writes } = holding(reading());
    const query = qc.getQueryCache().find({ queryKey: KEY });
    const error = new ApiError(503, "Forge is restarting.", "UNAVAILABLE");
    query?.setState({ status: "error", error });
    moveSessionInLiveReads(qc, "s-1", "completed");
    expect(writes()).toBe(0);
    expect(qc.getQueryState(KEY)).toMatchObject({ status: "error", error, dataUpdatedAt: 1_000 });
    expect(qc.getQueryData<SessionsAndHolds>(KEY)?.sessions.map((s) => s.id)).toEqual(["s-1"]);
  });
});
