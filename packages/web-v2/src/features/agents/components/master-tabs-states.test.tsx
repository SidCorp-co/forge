// The three master tabs (Passes, Runs holding a lease, Charter) read their own query: while it loads
// they draw the loader, when it fails the error with its Retry, and an empty answer reads in words.
// Pinned before the loading/error branches moved onto QueryBoundary, so the move changes no render.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MasterStanding } from "../types";

type Q = { isLoading: boolean; isError: boolean; data: unknown; error: unknown; refetch: () => unknown };
const refetch = vi.fn();
const idle = (over: Partial<Q>): Q => ({ isLoading: false, isError: false, data: undefined, error: null, refetch, ...over });
const state = { passes: idle({}), runs: idle({}), charter: idle({}) };

vi.mock("../hooks", () => ({
  useMasterStanding: () => idle({ data: MASTER }),
  useMasterPasses: () => state.passes,
  useRunStanding: () => state.runs,
  useMasterCharter: () => state.charter,
}));

const MASTER = {
  generatedAt: "2026-10-07T00:00:00Z",
  projectId: "p",
  state: "idle",
  sessionId: "s1",
  name: null,
  device: null,
  since: null,
  pass: null,
  lastPass: null,
  slots: null,
  runsOut: 0,
  lastBeatAt: null,
  silentAfterSeconds: 60,
  waitingOn: null,
  dialogsAnswered: null,
  outdated: null,
} as unknown as MasterStanding;

import { MasterPage } from "./master-views";

beforeEach(() => {
  refetch.mockClear();
  state.passes = idle({});
  state.runs = idle({});
  state.charter = idle({});
});
afterEach(cleanup);

const tabs = [
  { tab: "passes", key: "passes", loading: "loading passes…", empty: "No pass is recorded for this project's master yet.", data: { items: [], hasMore: false } },
  { tab: "runs", key: "runs", loading: "loading runs…", empty: "No live run this master dispatched holds a lease.", data: { items: [] } },
  { tab: "charter", key: "charter", loading: "loading the charter…", empty: "No charter is declared for this project's master.", data: { declared: false, rules: [] } },
] as const;

describe.each(tabs)("the master $tab tab", ({ tab, key, loading, empty, data }) => {
  const mount = () => {
    window.history.replaceState(null, "", tab === "passes" ? "/" : `/?tab=${tab}`);
    return render(<MasterPage projectId="p" slug="forge" />);
  };

  it("draws the loader with its label while the query loads, with no wrapper of its own", () => {
    state[key] = idle({ isLoading: true });
    const { container } = mount();
    expect(screen.getByText(loading)).toBeTruthy();
    const pane = container.querySelector('[role="tabpanel"], [data-testid="master-detail"]');
    expect(pane?.querySelector(".min-h-\\[40vh\\]")).toBeNull();
  });

  it("draws the error and a Retry that refetches, for any failure", () => {
    state[key] = idle({ isError: true, error: new Error("core said no") });
    const { container } = mount();
    expect(container.textContent).toContain("core said no");
    expect(container.querySelector(".min-h-\\[40vh\\]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("draws the error, not the empty line, when the answer carried no data", () => {
    state[key] = idle({});
    mount();
    expect(screen.queryByText(empty)).toBeNull();
  });

  it("reads an empty answer in words", () => {
    state[key] = idle({ data });
    mount();
    expect(screen.getByText(empty)).toBeTruthy();
  });
});
