/**
 * REQ-22 (ISS-547): the operator console lists every alert core sends, each with its level and
 * when that level changed, as the sweep recorded it.
 *
 * @direct-test-of packages/web-v2/src/features/operator/components/alert-feed.tsx
 */

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { AdminAlert } from "../types";
import { AlertFeed } from "./alert-feed";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function alert(id: AdminAlert["id"], status: AdminAlert["status"], changedAt: string | null): AdminAlert {
  return { id, key: `key_${id}`, status, count: status === "ok" ? 0 : 1, detail: `detail ${id}`, since: null, entities: [], changedAt };
}

const SIX: AdminAlert[] = [
  alert("A1", "ok", null),
  alert("A2", "warn", minutesAgo(5)),
  alert("A3", "ok", minutesAgo(90)),
  alert("A4", "crit", minutesAgo(0)),
  alert("A5", "warn", null),
  alert("A6", "ok", null),
];

function rowOf(title: string): HTMLElement {
  const row = screen.getByText(title).closest("li");
  if (!row) throw new Error(`no console row titled ${title}`);
  return row;
}

describe("AlertFeed", () => {
  it("lists every alert it is given, crit first, each with its level", () => {
    renderWithQuery(<AlertFeed alerts={SIX} />);
    const levels = screen.getAllByTestId("status-badge").map((b) => b.getAttribute("data-value"));
    expect(levels).toEqual(["crit", "warn", "warn", "ok", "ok", "ok"]);
    for (const title of ["Orphan jobs", "Stuck jobs", "Runner-starved projects", "Spend spike", "Automation failing", "Dead outbox deliveries"]) {
      expect(rowOf(title)).toBeTruthy();
    }
  });

  it("says when each level changed, with the exact time on hover", () => {
    renderWithQuery(<AlertFeed alerts={SIX} />);
    const stuck = within(rowOf("Stuck jobs")).getByText("for 5m");
    expect(stuck.getAttribute("title")).toBe(SIX[1]?.changedAt);
    expect(within(rowOf("Spend spike")).getByText("changed just now")).toBeTruthy();
    expect(within(rowOf("Runner-starved projects")).getByText("for 1h")).toBeTruthy();
  });

  it("names a level the sweep has not recorded yet, and an alert that never left ok", () => {
    renderWithQuery(<AlertFeed alerts={SIX} />);
    expect(within(rowOf("Automation failing")).getByText("not yet recorded")).toBeTruthy();
    expect(within(rowOf("Orphan jobs")).getByText("no change recorded")).toBeTruthy();
  });
});
