// @vitest-environment jsdom
//
// ISS-1163 — the Schedules screen's claims about the present: a paused schedule says "Paused" and
// carries no verdict chip, the last run is dated neutral text, the list opens with its sum, cron is
// in words with the expression kept, and the narrow layout is a flush list rather than cards.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleRow } from "../types";
import { SchedulesScreen } from "./schedules-screen";

expect.extend(matchers);

const NOW = new Date("2026-09-21T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const HOUR = 3_600_000;

let rows: ScheduleRow[] = [];
let loadState: { isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "forge-dev" }) }));
vi.mock("../hooks", () => ({
  useSchedules: () => ({ data: rows, ...loadState, refetch: vi.fn(), error: null }),
  useSetScheduleEnabled: () => ({ mutate: vi.fn(), isPending: false }),
  useRunSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useScheduleRuns: () => ({ data: { runs: [] }, isLoading: false, isError: false }),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  loadState = { isLoading: false, isError: false };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

function row(over: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: "s1",
    projectId: "p1",
    name: "Nightly",
    cron: "0 16 * * *",
    prompt: "go",
    kind: "prompt",
    script: null,
    enabled: false,
    targetProjectSlug: null,
    lastRunAt: ago(17 * DAY),
    nextRunAt: null,
    lastStatus: "success",
    lastSessionId: "sess-1",
    metadata: null,
    templateKey: null,
    params: null,
    mode: null,
    appliedMessageVersions: null,
    createdAt: ago(60 * DAY),
    updatedAt: ago(17 * DAY),
    ...over,
  };
}

function renderScreen() {
  return render(<SchedulesScreen scope={{ projectId: "p1", canManage: true }} />);
}

/** The desktop table's body rows, in order. */
function tableRows(): HTMLElement[] {
  return within(screen.getByRole("table")).getAllByRole("row").slice(1);
}

describe("SchedulesScreen — present state", () => {
  it("a paused schedule says Paused, and its 17-day-old success is neutral dated text with no chip", () => {
    rows = [row({ id: "a", name: "Paused one" })];
    renderScreen();
    const [r] = tableRows();
    expect(within(r).getByText("Paused")).toBeInTheDocument();
    expect(within(r).queryByText("Off")).toBeNull();
    expect(within(r).queryByText("Verified")).toBeNull();
    const last = within(r).getByText(/Succeeded 17 days ago/);
    expect(last.textContent).toBe("Succeeded 17 days ago · stale");
    expect(last.getAttribute("style")).toBeNull();
    // State and Last run are the two cells that speak about status; neither carries a coloured element.
    const cells = within(r).getAllByRole("cell");
    expect(cells[4].querySelector("[style]")).toBeNull();
    expect(cells[5].querySelector("[style]")).toBeNull();
  });

  it("an enabled schedule shows Next run and its recent verdict, not marked stale", () => {
    rows = [
      row({
        id: "b",
        name: "Live one",
        enabled: true,
        nextRunAt: new Date(NOW.getTime() + 4 * HOUR).toISOString(),
        lastRunAt: ago(5 * HOUR),
      }),
    ];
    renderScreen();
    const [r] = tableRows();
    expect(within(r).getByText("Next run")).toBeInTheDocument();
    expect(within(r).queryByText("Paused")).toBeNull();
    expect(within(r).getByText(/Succeeded 5 hours ago/).textContent).toBe("Succeeded 5 hours ago");
  });

  it("a failed run is stated as Failed in the same neutral text", () => {
    rows = [row({ id: "c", enabled: true, lastStatus: "failed", lastRunAt: ago(2 * HOUR) })];
    renderScreen();
    const [r] = tableRows();
    const last = within(r).getByText(/Failed 2 hours ago/);
    expect(last.className).toContain("text-subtle");
    expect(last.className).not.toContain("text-danger");
  });

  it("a never-run schedule says Never run with no age", () => {
    rows = [row({ id: "d", lastStatus: null, lastRunAt: null, lastSessionId: null })];
    renderScreen();
    const [r] = tableRows();
    expect(within(r).getByText("Never run")).toBeInTheDocument();
    expect(r.textContent).not.toMatch(/ago|stale/);
  });

  it("opens with what the list adds up to, and states the stale rule", () => {
    rows = [1, 2, 3, 4, 5].map((n) => row({ id: `s${n}`, name: `Sched ${n}` }));
    renderScreen();
    expect(screen.getByText("5 schedules · none enabled")).toBeInTheDocument();
    expect(screen.getByText(/two cadences/)).toBeInTheDocument();
  });

  it("counts the enabled ones", () => {
    rows = [row({ id: "e1", enabled: true, nextRunAt: ago(-HOUR) }), row({ id: "e2" })];
    renderScreen();
    expect(screen.getByText("2 schedules · 1 enabled")).toBeInTheDocument();
  });

  it("reads cron in words with the expression kept beneath, and shows an unreadable one alone", () => {
    rows = [
      row({ id: "f1", name: "Two-hourly", cron: "0 */2 * * *" }),
      row({ id: "f2", name: "Odd", cron: "not a cron" }),
    ];
    renderScreen();
    const [first, second] = tableRows();
    expect(within(first).getByText(/every 2 hours/i)).toBeInTheDocument();
    expect(within(first).getByText("0 */2 * * *")).toBeInTheDocument();
    expect(within(second).getByText("not a cron")).toBeInTheDocument();
    expect(second.textContent).not.toMatch(/\bAt\b|[Ee]very/);
  });

  it("the narrow layout is a flush list: hairline-divided items, no card", () => {
    rows = [row({ id: "m1", name: "Mobile one" }), row({ id: "m2", name: "Mobile two" })];
    const { container } = renderScreen();
    const list = container.querySelector(".md\\:hidden") as HTMLElement;
    expect(list).not.toBeNull();
    expect(list.children).toHaveLength(2);
    for (const item of Array.from(list.children)) {
      expect(item.className).toContain("border-b");
      expect(item.className).not.toMatch(/rounded|shadow|bg-surface/);
    }
    expect(within(list).getAllByText("Paused")).toHaveLength(2);
    expect(within(list).queryByText("Verified")).toBeNull();
  });

  it("an empty project still shows the empty state and no sum", () => {
    rows = [];
    renderScreen();
    expect(screen.getByText("No schedules yet")).toBeInTheDocument();
    expect(screen.queryByText(/none enabled/)).toBeNull();
  });
});
