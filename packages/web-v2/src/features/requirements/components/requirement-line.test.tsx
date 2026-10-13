// The Requirements list on live dev.227: AGE read "1m" on all 45 rows once area and short name were
// set on each, because it read the last edit; and a long Waits on act was cut with an ellipsis at
// 1440 px. AGE now reads the time in the current state (`standing.stateSince`), and an act wraps.

import { render, screen } from "@testing-library/react";
import type { RequirementSummary } from "@forge/contracts/requirements";
import { describe, expect, it, vi } from "vitest";
import { RequirementsList } from "./requirements-list";
import { RequirementsMap } from "./requirements-map";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const NOW = Date.parse("2026-10-10T12:00:00.000Z");

const row = (over: Partial<RequirementSummary["standing"]> = {}) =>
  ({
    id: "r1",
    key: "REQ-7",
    title: "Tours for a new sales rep",
    shortName: "Sales tours",
    area: null,
    status: "agreed",
    currentRevision: 2,
    standing: {
      state: "agreed",
      attentionGroup: "you",
      facts: { criteria: 0, passing: 0 },
      waitingOn: { who: "You", act: "review the breakdown", kind: "you" },
      owner: null,
      // area and short name were just written: the touched time is a minute old
      touchedAt: "2026-10-10T11:59:00.000Z",
      stateSince: "2026-10-07T12:00:00.000Z",
      ...over,
    },
  }) as unknown as RequirementSummary;

// the row as the list draws it, through the shared grouped list
const line = (r: RequirementSummary) => render(<RequirementsList groups={[{ id: "you", label: "Needs you", rows: [r] }]} slug="hop" now={NOW} selected={null} onPeek={() => {}} />);

describe("a requirement's row on the list", () => {
  it("reads AGE from the time in its state, not from its last edit", () => {
    line(row());
    expect(screen.getByTestId("list-row")).toHaveTextContent(/3d$/);
    expect(screen.getByTestId("list-row")).not.toHaveTextContent(/1m$/);
  });

  it("says the breakdown act short, and lets any act wrap rather than be cut", () => {
    line(row());
    const waits = screen.getByTestId("req-waits");
    expect(waits).toHaveTextContent("You · review the breakdown");
    expect(waits.className).not.toMatch(/\btruncate\b/);
    expect(waits.className).toMatch(/\bbreak-words\b/);
  });
});

describe("the map's flow strip", () => {
  it("lets a stage label wrap rather than be cut", () => {
    render(<RequirementsMap rows={[row(), { ...row({ state: "in_delivery", attentionGroup: "needs_you" }), id: "r2", key: "REQ-8" }]} areas={[]} slug="hop" onPeek={() => {}} />);
    const decide = screen.getAllByTestId("flow-strip-label").find((l) => l.textContent === "Needs a decision");
    expect(decide).toBeDefined();
    expect(decide?.className).not.toMatch(/\btruncate\b/);
  });
});
