// JU-8: hop's Overview read "Awaiting release · Nothing waiting on a release decision" beside an issue
// flow saying 72 awaited one, because the card listed live pipeline runs parked at the gate and those
// issues' runs had ended. The card counts the issues at awaiting_release, as the flow does, and names
// the draft release's turn from the draft forecast the dashboard's lateness reads.

import type { QueryKey } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Seeded } from "@/test/vi-chrome-requirements";
import { AwaitingReleaseCard } from "./awaiting-release-card";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/" }));
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));

const AT = "2026-10-07T08:00:00.000Z";
const OPTS = { status: ["awaiting_release"], sort: "createdAt:asc", pageSize: 50 };
const issue = (n: number) => ({ id: `i${n}`, displayId: `ISS-${n}`, title: `Issue ${n}`, status: "awaiting_release" });
const draft = (late: boolean) => ({
  label: "forecast",
  asOf: AT,
  scope: "release",
  key: "draft",
  title: null,
  progress: { total: 72, shipped: 0, awaitingRelease: 72, toDo: 0 },
  forecast: null,
  delivery: null,
  next: { label: "forecast", asOf: AT, kind: "paused", who: "You", act: "cut 0.3.0", reason: "r", ref: null, since: AT, late: late ? { reason: "waiting_over_day", since: AT, byMinutes: 2 * 24 * 60 } : null },
});

function mount(seed: [QueryKey, unknown][]) {
  render(
    <Seeded data={seed}>
      <AwaitingReleaseCard slug="hop" projectId="p1" />
    </Seeded>,
  );
}

describe("the awaiting-release card", () => {
  it("counts the issues at awaiting_release, never runs, and lists them", () => {
    mount([[["issues", "search", "p1", OPTS], { items: Array.from({ length: 50 }, (_, k) => issue(k + 1)), totalCount: 72 }]]);
    expect(screen.getByTestId("awaiting-release-count").textContent).toBe("72");
    expect(screen.queryByText("Nothing waiting on a release decision.")).toBeNull();
    expect(screen.getAllByTestId("awaiting-release-issue")).toHaveLength(5);
  });

  it("names the draft release's turn and its lateness as the dashboard does", () => {
    mount([
      [["issues", "search", "p1", OPTS], { items: [issue(1)], totalCount: 72 }],
      [["issues", "standing", "forecast", "release-draft", "p1"], draft(true)],
    ]);
    expect(screen.getByTestId("awaiting-release-turn").textContent).toBe("Waiting on You · 2 d over a day");
  });

  it("says nothing waits only where no issue stands at awaiting_release", () => {
    mount([[["issues", "search", "p1", OPTS], { items: [], totalCount: 0 }]]);
    expect(screen.getByText("Nothing waiting on a release decision.")).toBeTruthy();
    expect(screen.queryByTestId("awaiting-release-count")).toBeNull();
  });
});
