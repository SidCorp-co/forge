// The board's columns, ISS-999.
//
// Before this change the board had seven columns — triage → clarify → plan → code → review → test
// → release — filled by a hand-written 15-key `STATUS_TO_STAGE` against a pipeline ISS-897 deleted
// from the kernel. `releasing` and `dropped` were in neither that map nor the issues module's
// 17-key copy, so both fell through `?? "triage"`: the same issue read `release` on its row and
// `triage` on the board.
//
// The columns are the lane's labels now, and the lane belongs to `@forge/contracts`. These
// assertions are against the CONTRACTS tuples rather than against anything this module declares,
// so a column that stops tracking the kernel goes red here.

import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_LABELS,
  type AutonomousLabel,
  toAutonomousLabel,
} from "@forge/contracts/issue-vocabulary";
import { REGISTRY_ISSUE_STATUSES } from "@forge/contracts/pipeline-registry";
import { statusToTone } from "@/features/issues/derive";
import type { IssueStatus } from "@/features/issues/types";
import { boardColumns, groupIssuesByLabel, labelTone } from "./derive";
import { BOARD_EXCLUDED_STATUSES, type PipelineIssueRow } from "./types";

function issue(id: string, status: string, held = true): PipelineIssueRow {
  return {
    id,
    projectId: "p1",
    displayId: `ISS-${id}`,
    title: `issue ${id}`,
    status,
    priority: "medium",
    assigneeId: null,
    held,
  } as PipelineIssueRow;
}

/** Every label a returnable status can read, held or not. */
const readable = (status: (typeof RETURNABLE)[number]): AutonomousLabel[] => [
  toAutonomousLabel(status, true),
  toAutonomousLabel(status, false),
];

/** Every status the board's own query can return — the same set `boardColumns` derives from. */
const RETURNABLE = REGISTRY_ISSUE_STATUSES.filter(
  (s) => !(BOARD_EXCLUDED_STATUSES as readonly string[]).includes(s),
);

describe("boardColumns", () => {
  it("draws a column for exactly the labels a returnable status maps to", () => {
    expect([...boardColumns()].sort()).toEqual(
      [...new Set(RETURNABLE.flatMap(readable))].sort(),
    );
  });

  it("keeps the contracts tuple's order, so the column order is not this module's to choose", () => {
    const cols = boardColumns();
    const positions = cols.map((l) => AUTONOMOUS_LABELS.indexOf(l));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions).not.toContain(-1);
  });

  it("omits the labels only an excluded status reaches, and no others", () => {
    expect(boardColumns()).not.toContain("draft");
    expect(boardColumns()).not.toContain("done");
    for (const label of AUTONOMOUS_LABELS) {
      const reachedByALiveStatus = RETURNABLE.some((s) => readable(s).includes(label));
      expect(boardColumns().includes(label)).toBe(reachedByALiveStatus);
    }
  });

  it("keeps a label whose other statuses are still returnable, where subtraction would drop it", () => {
    expect(toAutonomousLabel("waiting", true)).toBe(toAutonomousLabel("needs_info", true));
    expect(boardColumns(["waiting"])).toContain("needs_human");
  });

  it("drops a label only when EVERY status wearing it is excluded", () => {
    expect(boardColumns(["waiting", "needs_info"])).not.toContain("needs_human");
  });

  it("gives every column a tone, and no column an invented one", () => {
    for (const label of boardColumns()) {
      expect(typeof labelTone(label)).toBe("string");
    }
  });
});

describe("groupIssuesByLabel", () => {
  it("puts every returnable status in a column, so nothing the board fetched is dropped", () => {
    const rows = RETURNABLE.map((s, i) => issue(String(i), s));
    const landed = groupIssuesByLabel(rows).flatMap((g) => g.issues.map((i) => i.id));
    expect(landed.sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("puts each issue in exactly one column", () => {
    const rows = RETURNABLE.map((s, i) => issue(String(i), s));
    const landed = groupIssuesByLabel(rows).flatMap((g) => g.issues.map((i) => i.id));
    expect(new Set(landed).size).toBe(landed.length);
  });

  it("gives `releasing` and `dropped` the column their own status chip names", () => {
    const groups = groupIssuesByLabel([issue("r", "releasing"), issue("d", "dropped")]);
    const columnOf = (id: string) => groups.find((g) => g.issues.some((i) => i.id === id))?.label;
    expect(columnOf("r")).toBe(toAutonomousLabel("releasing", true));
    expect(columnOf("d")).toBe(toAutonomousLabel("dropped", true));
    expect(columnOf("r")).toBe("running");
    expect(columnOf("d")).toBe("dropped");
  });

  it("names each column with the same word the issue's own status chip shows", () => {
    const groups = groupIssuesByLabel([issue("a", "in_progress"), issue("b", "needs_info")]);
    expect(groups.find((g) => g.label === "running")?.title).toBe("Running");
    expect(groups.find((g) => g.label === "needs_human")?.title).toBe("Needs a human");
  });

  // ISS-1213: eleven rows stood at `testing` 5–12h with nothing on ten of them, all under Running.
  it("files a row nothing holds under No check-in and a held one under Running", () => {
    const groups = groupIssuesByLabel([issue("idle", "testing", false), issue("busy", "testing")]);
    const columnOf = (id: string) => groups.find((g) => g.issues.some((i) => i.id === id));
    expect([columnOf("idle")?.label, columnOf("idle")?.title]).toEqual(["unheld", "No check-in"]);
    expect([columnOf("busy")?.label, columnOf("busy")?.title]).toEqual(["running", "Running"]);
  });

  it("draws the No check-in column beside Running, and keeps it when it is empty", () => {
    const cols = boardColumns();
    expect(cols.indexOf("unheld")).toBe(cols.indexOf("running") + 1);
    expect(groupIssuesByLabel([]).find((g) => g.label === "unheld")?.issues).toEqual([]);
  });

  it("leaves a party's column alone whether or not the row is held", () => {
    const groups = groupIssuesByLabel([issue("q", "needs_info", false)]);
    expect(groups.find((g) => g.issues.some((i) => i.id === "q"))?.label).toBe("needs_human");
  });

  it("never names a column after one of the seven deleted stages", () => {
    const stageNames = ["triage", "clarify", "plan", "code", "review", "test", "release"];
    for (const g of groupIssuesByLabel([])) {
      expect(stageNames).not.toContain(g.title.toLowerCase());
      expect(stageNames).not.toContain(g.label);
    }
  });

  it("keeps an empty column rather than hiding it, so a reader can see nothing needs them", () => {
    const groups = groupIssuesByLabel([issue("a", "in_progress")]);
    expect(groups.map((g) => g.label)).toEqual(boardColumns());
    expect(groups.find((g) => g.label === "needs_human")?.issues).toEqual([]);
  });

  it("gives a status outside the column set a column instead of dropping the row", () => {
    const groups = groupIssuesByLabel([issue("x", "draft")]);
    expect(groups.find((g) => g.issues.some((i) => i.id === "x"))?.label).toBe("draft");
  });
});

describe("a column is coloured by the statuses it holds", () => {
  /** The kernel statuses a label buckets, among the ones the board's query can return. */
  const bucket = (label: AutonomousLabel): string[] =>
    RETURNABLE.filter((s) => readable(s).includes(label));

  it("gives a label with ONE status exactly that status's chip colour", () => {
    const single = boardColumns().filter((l) => bucket(l).length === 1);
    expect(single.length).toBeGreaterThanOrEqual(4);
    for (const label of single) {
      const status = bucket(label)[0] as IssueStatus;
      expect([label, labelTone(label)]).toEqual([label, statusToTone(status)]);
    }
  });

  it("never colours a label with a tone no status in its bucket wears", () => {
    for (const label of boardColumns().filter((l) => l !== "unheld")) {
      const tones = bucket(label).map((s) => statusToTone(s as IssueStatus));
      expect([label, tones.includes(labelTone(label))]).toEqual([label, true]);
    }
  });

  // `unheld` is read off the holder, not the status, so no status in its bucket carries its colour.
  it("colours `unheld` as work nothing is moving, never as the work in motion `running` is coloured", () => {
    expect(labelTone("unheld")).toBe(statusToTone("on_hold"));
    expect(labelTone("unheld")).not.toBe(labelTone("running"));
  });

  it("colours `reopened` and `done` as their own status is coloured, not as a bucket word suggests", () => {
    expect(labelTone("reopened")).toBe(statusToTone("reopen"));
    expect(labelTone("done")).toBe(statusToTone("closed"));
  });
});
