// @vitest-environment jsdom
//
// ISS-1228 round 14 — judge-36 found Abort right under Stop session in the sessions list's row menu,
// with no confirmation and nothing saying it ends only the current turn.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../types";

const { toast, abort } = vi.hoisted(() => ({ toast: vi.fn(), abort: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));
vi.mock("../api", () => ({ sessionsApi: { abort } }));

import { useAbortSession } from "../hooks";
import { buildMenuItems } from "./sessions-screen";

afterEach(() => {
  cleanup();
  toast.mockReset();
});

const row = { id: "s1", status: "running", kind: "chat", metadata: {} } as unknown as SessionRow;
const noop = { mutate: () => {} } as never;
const actions = { cancel: noop, retry: noop, rerun: noop, abort: noop };

describe("the sessions list's row menu", () => {
  // ISS-1228 round 15 (judge-39): End this turn on a run session set it idle, so it read "Not started"
  // with Rerun and no Stop while its box kept it alive; a box ends a chat's turn and nothing else.
  it.each([
    ["a run session", { kind: "run_session", status: "running" }, "running"],
    ["a master", { kind: "master", status: "running" }, "running"],
    ["a pipeline step", { kind: "pipeline", status: "running" }, "running"],
    ["a chat awaiting its reply", { kind: "chat", status: "idle" }, "idle"],
  ] as const)("offers no End this turn on %s, and keeps Stop session", (_n, over, display) => {
    const items = buildMenuItems({ ...row, ...over } as unknown as SessionRow, display, actions);
    expect(items.map((i) => i.label)).not.toContain("End this turn");
    expect(items.map((i) => i.label)).toContain("Stop session");
  });

  it("offers End this turn on a chat whose turn is running, read by its kind where the row names none", () => {
    const legacy = { id: "s2", status: "running", metadata: { type: "chat" } } as unknown as SessionRow;
    expect(buildMenuItems(legacy, "running", actions).map((i) => i.label)).toContain("End this turn");
  });

  it("names the turn-only action for what it ends and sets Stop session apart from it by a rule", () => {
    const items = buildMenuItems(row, "running", actions);
    expect(items.map((i) => i.label)).toEqual(["End this turn", "Stop session"]);
    expect(items.find((i) => i.label === "Stop session")).toMatchObject({ danger: true, separatorBefore: true });
    expect(items.some((i) => /^Abort/.test(i.label))).toBe(false);
  });

  it("says the session stays open once a turn is ended", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAbortSession(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync("s1");
    });
    expect(toast).toHaveBeenCalledWith({ title: "Turn ended. The session stays open.", tone: "success" });
  });
});
