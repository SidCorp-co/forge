// The Requirements list on live dev.227: AGE read "1m" on all 45 rows once area and short name were
// set on each, because it read the last edit. AGE now reads the time in the current state
// (`standing.stateSince`). Waits on is the shared cell every list draws (ISS-1072): one line, whose
// turn it is as a mark and a name, and a short act; the whole sentence, keys and all, is its tooltip.

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

  it("draws Waits on as the shared one-line cell, the long act whole only in its tooltip", () => {
    const long = "Update to the approved design: Issue to release (revision 25); judge BC-4, BC-5 and BC-6 on ISS-643";
    line(row({ waitingOn: { who: "orchestrator", act: long, kind: "agent", rule: "", ref: null, dueAt: null } as never, attentionGroup: "moving" } as never));
    expect(screen.queryByTestId("req-waits")).toBeNull();
    const waits = screen.getByTestId("waiting-on");
    expect(waits).toHaveAttribute("data-kind", "agent");
    expect(waits.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(waits.className).not.toMatch(/\bbreak-words\b/);
    expect(waits.getAttribute("title")).toContain(long);
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
