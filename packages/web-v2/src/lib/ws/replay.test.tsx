// When the socket opens after the page read its data, the page refetches only what changed in
// between: the server replays its rooms' frames since the reads began, and the event router
// invalidates exactly those. Only a replay the server cannot vouch for costs the broad refetch.

import { QueryClient, QueryClientProvider, useQueries } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { id: "u1" }, isLoading: false }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => auth }));

import { REPLAY_WAIT_MS, wsClient } from "./client";
import { useRoom } from "./use-room";
import { useWebSocket } from "./use-websocket";

class FakeSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(event: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ event, data, timestamp: new Date().toISOString() }) });
  }
}

const ISSUE = "8b1d4e2f-2c7a-4b9e-a1f0-5d6e7c8b9a01";
const PROJECT = "3f0c2a9e-6a51-4f7e-9d3c-0b6f1e2a7c11";
const KEYS = [["attention"], ["projects"], ["issues", "standing", PROJECT, "open"], ["issue", ISSUE], ["notifications"], ["questions", ISSUE]];

function page() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  const reads = new Map<string, number>(KEYS.map((key) => [JSON.stringify(key), 0]));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  renderHook(
    () => {
      useQueries({
        queries: KEYS.map((key) => ({
          queryKey: key,
          queryFn: async () => {
            const hash = JSON.stringify(key);
            reads.set(hash, (reads.get(hash) ?? 0) + 1);
            return {};
          },
          initialData: {},
        })),
      });
      useWebSocket();
      useRoom(`project:${PROJECT}`);
    },
    { wrapper },
  );
  const refetched = () => [...reads.entries()].filter(([, n]) => n > 0).map(([k]) => JSON.parse(k));
  return { qc, refetched };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.last = null;
});

afterEach(() => {
  cleanup();
  wsClient.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle(ms = 400) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("the socket opening after the page read its data", () => {
  it("asks each room for what it missed since its reads began, and refetches nothing when nothing moved", async () => {
    const { refetched } = page();
    const socket = FakeSocket.last as FakeSocket;
    await settle(50);
    act(() => socket.open());
    const asked = socket.sent.filter((m) => m.type === "subscribe");
    expect(asked.map((m) => m.room).sort()).toEqual([`project:${PROJECT}`, "user:u1"]);
    for (const m of asked) expect(m.replayMs).toEqual(expect.any(Number));
    act(() => {
      socket.receive("replay.done", { room: "user:u1", frames: 0, complete: true });
      socket.receive("replay.done", { room: `project:${PROJECT}`, frames: 0, complete: true });
    });
    await settle(REPLAY_WAIT_MS + 500);
    expect(refetched()).toEqual([]);
  });

  it("refetches only what a replayed frame names", async () => {
    const { refetched } = page();
    const socket = FakeSocket.last as FakeSocket;
    await settle(50);
    act(() => socket.open());
    act(() => {
      socket.receive("issue.updated", { issueId: ISSUE, projectId: PROJECT, fields: ["title"], actorId: "u2" });
      socket.receive("replay.done", { room: `project:${PROJECT}`, frames: 1, complete: true });
      socket.receive("replay.done", { room: "user:u1", frames: 0, complete: true });
    });
    await settle(REPLAY_WAIT_MS + 500);
    const keys = refetched().map((k) => k[0]);
    expect(keys).toEqual(expect.arrayContaining(["issue", "attention", "issues"]));
    expect(keys).not.toContain("projects");
    expect(keys).not.toContain("notifications");
  });

  it("refetches broadly when the server cannot vouch for the whole span", async () => {
    const { refetched } = page();
    const socket = FakeSocket.last as FakeSocket;
    await settle(50);
    act(() => socket.open());
    act(() => {
      socket.receive("replay.done", { room: "user:u1", frames: 0, complete: false });
      socket.receive("replay.done", { room: `project:${PROJECT}`, frames: 0, complete: true });
    });
    await settle(400);
    expect(refetched().map((k) => k[0])).toEqual(expect.arrayContaining(["projects", "attention", "notifications", "questions"]));
  });

  it("refetches broadly when the server never answers the replay it was asked for", async () => {
    const { refetched } = page();
    const socket = FakeSocket.last as FakeSocket;
    await settle(50);
    act(() => socket.open());
    await settle(REPLAY_WAIT_MS - 500);
    expect(refetched()).toEqual([]);
    await settle(1_000);
    expect(refetched().map((k) => k[0])).toEqual(expect.arrayContaining(["projects", "attention"]));
  });
});
