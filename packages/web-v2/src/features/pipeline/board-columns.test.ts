// The board's columns, ISS-999 and ISS-54.
//
// Before ISS-999 the board had seven columns — triage → clarify → plan → code → review → test →
// release — filled by a hand-written status→stage map against a pipeline ISS-897 deleted from the
// kernel. Until ISS-54 the columns were the autonomous lane's ten labels, read many-to-one off
// seventeen statuses. Since ISS-54 the statuses ARE what the lane said, so a column is a status —
// plus "No check-in", the in_progress rows nothing holds. A run's step is never a column.
//
// These assertions are against the CONTRACTS tuple rather than against anything this module
// declares, so a column that stops tracking the kernel goes red here.

import { describe, expect, it } from "vitest";
import { WORK_STEPS } from "@forge/contracts/issue-vocabulary";
import { REGISTRY_ISSUE_STATUSES } from "@forge/contracts/pipeline-registry";
import { statusLabel, statusToTone } from "@/features/issues/derive";
import type { IssueStatus } from "@/features/issues/types";
import { boardColumns, columnTone, groupIssuesByColumn, rowColumn } from "./derive";
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

/** Every status the board's own query can return — the same set `boardColumns` derives from. */
const RETURNABLE = REGISTRY_ISSUE_STATUSES.filter(
  (s) => !(BOARD_EXCLUDED_STATUSES as readonly string[]).includes(s),
);

describe("boardColumns", () => {
  it("draws a column for exactly the returnable statuses, plus No check-in", () => {
    expect([...boardColumns()].sort()).toEqual([...RETURNABLE, "unheld"].sort());
  });

  it("keeps the contracts tuple's order, so the column order is not this module's to choose", () => {
    const statuses = boardColumns().filter((k) => k !== "unheld") as IssueStatus[];
    const positions = statuses.map((s) => REGISTRY_ISSUE_STATUSES.indexOf(s));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions).not.toContain(-1);
  });

  it("omits exactly the excluded statuses", () => {
    expect(boardColumns()).not.toContain("draft");
    expect(boardColumns()).not.toContain("closed");
    for (const status of REGISTRY_ISSUE_STATUSES) {
      expect(boardColumns().includes(status)).toBe(RETURNABLE.includes(status));
    }
  });

  it("draws No check-in right after In progress, and not at all when in_progress is excluded", () => {
    const cols = boardColumns();
    expect(cols.indexOf("unheld")).toBe(cols.indexOf("in_progress") + 1);
    expect(boardColumns(["in_progress"])).not.toContain("unheld");
  });

  it("never draws a column per step: the step is the in_progress card's word, not a place", () => {
    for (const step of WORK_STEPS) expect(boardColumns() as string[]).not.toContain(step);
  });

  it("gives every column a tone", () => {
    for (const key of boardColumns()) {
      expect(typeof columnTone(key)).toBe("string");
    }
  });
});

describe("groupIssuesByColumn", () => {
  it("puts every returnable status in a column, so nothing the board fetched is dropped", () => {
    const rows = RETURNABLE.map((s, i) => issue(String(i), s));
    const landed = groupIssuesByColumn(rows).flatMap((g) => g.issues.map((i) => i.id));
    expect(landed.sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("puts each issue in exactly one column", () => {
    const rows = RETURNABLE.map((s, i) => issue(String(i), s));
    const landed = groupIssuesByColumn(rows).flatMap((g) => g.issues.map((i) => i.id));
    expect(new Set(landed).size).toBe(landed.length);
  });

  it("files each row under its own status", () => {
    const groups = groupIssuesByColumn([issue("a", "awaiting_release"), issue("d", "dropped")]);
    const columnOf = (id: string) => groups.find((g) => g.issues.some((i) => i.id === id))?.key;
    expect(columnOf("a")).toBe("awaiting_release");
    expect(columnOf("d")).toBe("dropped");
  });

  it("names each column with the same word the issue's own status chip shows", () => {
    const groups = groupIssuesByColumn([]);
    for (const status of RETURNABLE) {
      expect(groups.find((g) => g.key === status)?.title).toBe(statusLabel(status));
    }
  });

  // ISS-1213: eleven rows stood at a working status 5–12h with nothing on ten of them, all under one column.
  it("files an in_progress row nothing holds under No check-in and a held one under In progress", () => {
    const groups = groupIssuesByColumn([issue("idle", "in_progress", false), issue("busy", "in_progress")]);
    const columnOf = (id: string) => groups.find((g) => g.issues.some((i) => i.id === id));
    expect([columnOf("idle")?.key, columnOf("idle")?.title]).toEqual(["unheld", "No check-in"]);
    expect([columnOf("busy")?.key, columnOf("busy")?.title]).toEqual(["in_progress", "In progress"]);
  });

  it("keeps the No check-in column when it is empty", () => {
    expect(groupIssuesByColumn([]).find((g) => g.key === "unheld")?.issues).toEqual([]);
  });

  it("leaves every status but in_progress in its own column whether or not the row is held", () => {
    for (const status of RETURNABLE.filter((s) => s !== "in_progress")) {
      expect(rowColumn(issue("q", status, false))).toBe(status);
    }
  });

  it("never names a column after one of the seven deleted stages", () => {
    const stageNames = ["triage", "clarify", "plan", "code", "review", "test", "release"];
    for (const g of groupIssuesByColumn([])) {
      expect(stageNames).not.toContain(g.title.toLowerCase());
      expect(stageNames).not.toContain(g.key);
    }
  });

  it("keeps an empty column rather than hiding it, so a reader can see nothing needs them", () => {
    const groups = groupIssuesByColumn([issue("a", "in_progress")]);
    expect(groups.map((g) => g.key)).toEqual(boardColumns());
    expect(groups.find((g) => g.key === "needs_info")?.issues).toEqual([]);
  });

  it("gives a status outside the column set a column instead of dropping the row", () => {
    const groups = groupIssuesByColumn([issue("x", "draft")]);
    expect(groups.find((g) => g.issues.some((i) => i.id === "x"))?.key).toBe("draft");
  });
});

describe("a column is coloured by the status it holds", () => {
  it("gives every status column exactly that status's chip colour", () => {
    for (const status of RETURNABLE) {
      expect([status, columnTone(status)]).toEqual([status, statusToTone(status)]);
    }
  });

  // `unheld` is read off the holder, not the status, so it is not coloured as the work in motion.
  it("colours No check-in as work nothing is moving, never as In progress is coloured", () => {
    expect(columnTone("unheld")).not.toBe(columnTone("in_progress"));
  });
});
