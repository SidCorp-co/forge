import { describe, expect, it } from "vitest";
import {
  COMMENT_KIND_META,
  COMPLEXITY_LABELS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  allowedTransitions,
  complexityLabel,
  deriveCommentKind,
  depCounts,
  filterToStatusParams,
  groupRows,
  initials,
  memberLabel,
  parseChecklist,
  priorityLabel,
  statusLabel,
  statusToChip,
  statusToRun,
  statusToStage,
} from "./derive";
import { ISSUE_COMPLEXITIES, ISSUE_PRIORITIES, ISSUE_STATUSES } from "./types";
import type { IssueDependencies, IssueRow } from "./types";

function row(over: Partial<IssueRow> & { id: string }): IssueRow {
  return {
    id: over.id,
    projectId: over.projectId ?? "p1",
    issSeq: over.issSeq ?? 1,
    displayId: over.displayId ?? `ISS-${over.issSeq ?? 1}`,
    title: over.title ?? "Title",
    description: over.description ?? null,
    status: over.status ?? "open",
    priority: over.priority ?? "none",
    category: over.category ?? null,
    complexity: over.complexity ?? null,
    assigneeId: over.assigneeId ?? null,
    parentIssueId: over.parentIssueId ?? null,
    reopenCount: over.reopenCount ?? 0,
    manualHold: over.manualHold ?? false,
    mergedAt: over.mergedAt ?? null,
    createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z",
    agentSessions: over.agentSessions,
    agentStatus: over.agentStatus,
  };
}

describe("statusToStage", () => {
  it("maps lifecycle statuses to pipeline stages", () => {
    expect(statusToStage("open")).toBe("triage");
    expect(statusToStage("approved")).toBe("plan");
    expect(statusToStage("in_progress")).toBe("code");
    expect(statusToStage("developed")).toBe("review");
    expect(statusToStage("testing")).toBe("test");
    expect(statusToStage("released")).toBe("release");
  });
});

describe("statusToRun", () => {
  it("prefers a live agent status over the lifecycle status", () => {
    expect(statusToRun("approved", "running")).toBe("running");
    expect(statusToRun("approved", "queued")).toBe("queued");
    expect(statusToRun("developed", "failed")).toBe("failed");
  });
  it("falls back to a status-derived run state with no agent", () => {
    expect(statusToRun("released")).toBe("done");
    expect(statusToRun("developed")).toBe("review");
    expect(statusToRun("on_hold")).toBe("blocked");
    expect(statusToRun("in_progress")).toBe("running");
    expect(statusToRun("open")).toBe("queued");
  });
});

describe("statusToChip", () => {
  it("maps live agent status first", () => {
    expect(statusToChip("approved", "running")).toBe("running");
    expect(statusToChip("approved", "queued")).toBe("queued");
  });
  it("maps lifecycle status to a kit StatusKey", () => {
    expect(statusToChip("in_progress")).toBe("running");
    expect(statusToChip("waiting")).toBe("waiting");
    expect(statusToChip("pass")).toBe("passed");
    expect(statusToChip("released")).toBe("done");
    expect(statusToChip("on_hold")).toBe("paused");
  });
});

describe("allowedTransitions", () => {
  it("never offers draft as a target, nor the current status", () => {
    const from = allowedTransitions("approved");
    expect(from).not.toContain("draft");
    expect(from).not.toContain("approved");
    // permissive guard: every non-draft status is reachable from a live state
    expect(from).toContain("in_progress");
    expect(from).toContain("on_hold");
    expect(from).toContain("reopen");
  });
  it("restricts draft to promote or discard only", () => {
    expect(allowedTransitions("draft")).toEqual(["open", "closed"]);
  });
});

describe("label helpers", () => {
  it("humanizes status / priority / complexity (no raw enum leaks)", () => {
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("needs_info")).toBe("Needs info");
    expect(priorityLabel("critical")).toBe("Critical");
    expect(complexityLabel("xs")).toBe("XS");
    expect(complexityLabel("m")).toBe("Medium");
  });
  it("renders an em dash for an absent complexity", () => {
    expect(complexityLabel(null)).toBe("—");
    expect(complexityLabel(undefined)).toBe("—");
  });
  it("covers every enum value (label maps stay in lockstep with the unions)", () => {
    for (const s of ISSUE_STATUSES) expect(STATUS_LABELS[s]).toBeTruthy();
    for (const p of ISSUE_PRIORITIES) expect(PRIORITY_LABELS[p]).toBeTruthy();
    for (const c of ISSUE_COMPLEXITIES) expect(COMPLEXITY_LABELS[c]).toBeTruthy();
  });
});

describe("depCounts", () => {
  const id = "i1";
  const deps: IssueDependencies = {
    outgoing: [
      { id: "e1", fromIssueId: id, toIssueId: "i2", kind: "blocks", reason: null, createdAt: "" },
      { id: "e2", fromIssueId: id, toIssueId: "i3", kind: "relates", reason: null, createdAt: "" },
    ],
    incoming: [
      { id: "e3", fromIssueId: "i4", toIssueId: id, kind: "blocks", reason: null, createdAt: "" },
    ],
  };
  it("counts blocks edges by direction, ignoring other kinds", () => {
    expect(depCounts(deps)).toEqual({ blockedBy: 1, blocks: 1 });
  });
  it("returns zeros when undefined", () => {
    expect(depCounts(undefined)).toEqual({ blockedBy: 0, blocks: 0 });
  });
});

describe("filterToStatusParams", () => {
  it("all applies no filter — every issue incl. drafts + closed (ISS-360)", () => {
    expect(filterToStatusParams("all")).toEqual({});
  });
  it("review targets the verification band", () => {
    expect(filterToStatusParams("review").status).toContain("developed");
    expect(filterToStatusParams("review").status).toContain("testing");
  });
  it("blocked targets parked statuses", () => {
    expect(filterToStatusParams("blocked")).toEqual({ status: ["on_hold", "needs_info"] });
  });
});

describe("groupRows", () => {
  const rows = [
    row({ id: "a", status: "open", priority: "high", assigneeId: "u1" }),
    row({ id: "b", status: "open", priority: "low", assigneeId: null }),
    row({ id: "c", status: "developed", priority: "high", assigneeId: "u1" }),
  ];
  it("returns a single group for none", () => {
    const g = groupRows(rows, "none");
    expect(g).toHaveLength(1);
    expect(g[0].rows).toHaveLength(3);
  });
  it("groups by status preserving server order", () => {
    const g = groupRows(rows, "status");
    expect(g.map((x) => x.key)).toEqual(["open", "developed"]);
    expect(g[0].rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("groups by assignee with Unassigned last + resolved labels", () => {
    const g = groupRows(rows, "assignee", [{ userId: "u1", email: "ann@x.co" }]);
    expect(g[g.length - 1].label).toBe("Unassigned");
    expect(g[0].label).toBe("ann@x.co");
  });
});

describe("memberLabel / initials", () => {
  it("resolves member email or falls back to a short id", () => {
    expect(memberLabel("u1", [{ userId: "u1", email: "bob@x.co" }])).toBe("bob@x.co");
    expect(memberLabel("abcdef1234", [])).toBe("abcdef12");
    expect(memberLabel(null)).toBe("Unassigned");
  });
  it("derives two-letter initials", () => {
    expect(initials("ann.smith@x.co")).toBe("AS");
    expect(initials("bob@x.co")).toBe("BO");
  });
});

describe("parseChecklist", () => {
  it("returns [] for empty/nullish", () => {
    expect(parseChecklist(null)).toEqual([]);
    expect(parseChecklist("")).toEqual([]);
  });
  it("parses task syntax with checked state", () => {
    expect(parseChecklist("- [ ] do a\n- [x] did b")).toEqual([
      { text: "do a", checked: false },
      { text: "did b", checked: true },
    ]);
  });
  it("treats bullets + bare lines as unchecked, drops headings/blanks", () => {
    expect(parseChecklist("## AC\n- one\n\nplain line")).toEqual([
      { text: "one", checked: false },
      { text: "plain line", checked: false },
    ]);
  });
});

describe("deriveCommentKind", () => {
  const cases: [string, string][] = [
    ["## Triage\nlooks good", "triage"],
    ["REQUEST CHANGES: fix the thing", "changes"],
    ["Verdict: APPROVE", "approved"],
    ["forge-fix applied the patch", "fix"],
    ["## QA Test Report\nall green", "qa"],
    ["Released v1.2.0 to prod", "released"],
    ["forge-code complete; pushed ISS-1 branch", "code"],
    ["Plan written and ready for review", "plan"],
    ["Just a normal note here", "comment"],
  ];
  it.each(cases)("classifies %j as %s", (body, kind) => {
    expect(deriveCommentKind(body)).toBe(kind);
  });
  it("has badge meta for every kind it returns", () => {
    for (const [, kind] of cases) {
      expect(COMMENT_KIND_META[kind as keyof typeof COMMENT_KIND_META]).toBeDefined();
    }
  });
});
