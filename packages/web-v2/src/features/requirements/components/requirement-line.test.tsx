// The Requirements list on live dev.227: AGE read "1m" on all 45 rows once area and short name were
// set on each, because it read the last edit. AGE now reads the time in the current state
// (`standing.stateSince`). Waits on is the shared cell every list draws (ISS-1072): one line, whose
// turn it is as a mark and a name, and a short act; the whole sentence, keys and all, is its tooltip.

import { render, screen } from "@testing-library/react";
import type { RequirementSummary } from "@forge/contracts/requirements";
import { describe, expect, it, vi } from "vitest";
import { listGroupsOf, RequirementsList } from "./requirements-list";
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
      coverage: [],
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

// FB-583 (owner, 2026-11-08): "I don't understand their states". A row spoke four vocabularies: the
// group, a stage word beside the name ("Agreed" on 34 of 37 rows, "Your check" on a row the master
// owed), Passing read from another count than the record's (REQ-78 0/7 here, 7/7 on its page), and a
// steward sentence restating the cause. The group is the one state now; a row says nothing it repeats.
describe("a requirement row in the one vocabulary", () => {
  const passing = (code: string) => ({ code, body: code, verdict: "passing", verdicts: [], issues: [] });
  const master = { who: "Master", act: "check BC-1", kind: "agent", rule: "", ref: null, dueAt: null, says: { who: { key: "standing.who.projectMaster" }, act: { key: "standing.act.none" }, rule: { key: "standing.act.none" } } };

  it("reads Passing from the coverage the record reads, not from a count beside it", () => {
    const codes = ["BC-1", "BC-2", "BC-3", "BC-4", "BC-5", "BC-6", "BC-7"];
    line(row({ attentionGroup: "waiting", facts: { criteria: 7, passing: 0, judged: 0 }, coverage: codes.map(passing) } as never));
    expect(screen.getByTestId("req-passing")).toHaveTextContent("7/7");
    expect(screen.getByTestId("req-passing")).not.toHaveTextContent("0/7");
  });

  it("draws no stage word beside the name: not Agreed, and no Your check on a wait the viewer does not owe", () => {
    line(row({ state: "agreed", attentionGroup: "queued", waitingOn: master } as never));
    expect(screen.getByTestId("list-row")).not.toHaveTextContent("Agreed");
    line(row({ state: "delivered", attentionGroup: "waiting", waitingOn: master } as never));
    for (const r of screen.getAllByTestId("list-row")) expect(r).not.toHaveTextContent(/Your check|Your\b/);
    expect(screen.queryByTestId("req-row-state")).toBeNull();
  });

  it("still says an accept by decision, which no group says", () => {
    line(row({ state: "accepted", attentionGroup: "done", acceptedByDecision: { by: "Lan" } } as never));
    expect(screen.getByTestId("req-row-state")).toHaveTextContent("Accepted by decision");
  });

  it("groups in the shared order, Dropped its own folded group and never inside Done", () => {
    const at = (key: string, attentionGroup: string, state = "agreed") => ({ ...row({ attentionGroup, state } as never), key, id: key });
    const rows = [at("D", "done", "accepted"), at("X", "dropped", "dropped"), at("O", "overdue"), at("W", "waiting"), at("Q", "queued"), at("R", "running"), at("N", "needs_you")];
    const groups = listGroupsOf(rows, "attention", [], (g) => g, "");
    expect(groups.map((g) => g.id)).toEqual(["needs_you", "running", "queued", "overdue", "waiting", "done", "dropped"]);
    expect(groups.find((g) => g.id === "done")?.rows.map((r) => r.key)).toEqual(["D"]);
    expect(groups.find((g) => g.id === "dropped")).toMatchObject({ collapsed: true, rows: [expect.objectContaining({ key: "X" })] });
    expect(groups.filter((g) => g.collapsed).map((g) => g.id)).toEqual(["done", "dropped"]);
    // each group wears its own tone, as the feedback list's do: Running is not drawn as Queued
    expect(groups.find((g) => g.id === "running")?.tone).toBe("run");
    expect(groups.find((g) => g.id === "overdue")?.tone).toBe("blocked");
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
