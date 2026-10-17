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

const row = { id: "s1", status: "running", metadata: {} } as unknown as SessionRow;
const noop = { mutate: () => {} } as never;
const actions = { cancel: noop, retry: noop, rerun: noop, abort: noop };

describe("the sessions list's row menu", () => {
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
