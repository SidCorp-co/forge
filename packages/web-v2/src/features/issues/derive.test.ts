import { describe, expect, it } from "vitest";
import {
  COMMENT_KIND_META,
  COMPLEXITY_LABELS,
  HEARTBEAT_STALE_MS,
  PRIORITY_LABELS,
  STATUS_LABELS,
  allowedTransitions,
  complexityLabel,
  deriveBlockerState,
  deriveCommentKind,
  deriveStageOutcomes,
  depCounts,
  filterToStatusParams,
  groupRows,
  heartbeatState,
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
import type {
  IssueDependencies,
  IssueDependencyEdge,
  IssueDetail,
  IssueRow,
  StepDurationRow,
  StepHandoffRow,
} from "./types";

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
  it("restricts draft to promote, direct-ship, or discard (ISS-431)", () => {
    expect(allowedTransitions("draft")).toEqual(["open", "developed", "closed"]);
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
    expect(depCounts(deps)).toEqual({ blockedBy: 1, blocks: 1, subtasks: 0, hasParent: false });
  });
  it("returns zeros when undefined", () => {
    expect(depCounts(undefined)).toEqual({
      blockedBy: 0,
      blocks: 0,
      subtasks: 0,
      hasParent: false,
    });
  });
  it("counts outgoing decomposes as subtasks (this issue is the epic)", () => {
    const epic: IssueDependencies = {
      outgoing: [
        { id: "d1", fromIssueId: id, toIssueId: "c1", kind: "decomposes", reason: null, createdAt: "" },
        { id: "d2", fromIssueId: id, toIssueId: "c2", kind: "decomposes", reason: null, createdAt: "" },
        { id: "b1", fromIssueId: id, toIssueId: "x1", kind: "blocks", reason: null, createdAt: "" },
      ],
      incoming: [],
    };
    expect(depCounts(epic)).toEqual({ blockedBy: 0, blocks: 1, subtasks: 2, hasParent: false });
  });
  it("flags incoming decomposes as hasParent (this issue is a subtask)", () => {
    const child: IssueDependencies = {
      outgoing: [],
      incoming: [
        { id: "p1", fromIssueId: "epic", toIssueId: id, kind: "decomposes", reason: null, createdAt: "" },
      ],
    };
    expect(depCounts(child)).toEqual({ blockedBy: 0, blocks: 0, subtasks: 0, hasParent: true });
  });
  it("treats the legacy parent kind like decomposes", () => {
    const legacy: IssueDependencies = {
      outgoing: [
        { id: "p2", fromIssueId: id, toIssueId: "c3", kind: "parent", reason: null, createdAt: "" },
      ],
      incoming: [
        { id: "p3", fromIssueId: "epic", toIssueId: id, kind: "parent", reason: null, createdAt: "" },
      ],
    };
    expect(depCounts(legacy)).toEqual({ blockedBy: 0, blocks: 0, subtasks: 1, hasParent: true });
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

// ─── ISS-377 ────────────────────────────────────────────────────────────────

function blockerIssue(
  over: Partial<Pick<IssueDetail, "status">> = {},
): Pick<IssueDetail, "status"> {
  return {
    status: over.status ?? "in_progress",
  };
}

function incomingBlocks(over: Partial<IssueDependencyEdge> = {}): IssueDependencies {
  const edge: IssueDependencyEdge = {
    id: over.id ?? "e1",
    fromIssueId: over.fromIssueId ?? "blk-1",
    toIssueId: over.toIssueId ?? "me",
    kind: "blocks",
    reason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    fromDisplayId: over.fromDisplayId ?? "ISS-9",
    fromTitle: over.fromTitle ?? "Blocker",
    fromStatus: over.fromStatus ?? "in_progress",
  };
  return { incoming: [edge], outgoing: [] };
}

describe("heartbeatState", () => {
  const now = Date.parse("2026-06-04T12:00:00.000Z");
  it("returns unknown when no/invalid timestamp", () => {
    expect(heartbeatState(undefined, now)).toBe("unknown");
    expect(heartbeatState(null, now)).toBe("unknown");
    expect(heartbeatState("not-a-date", now)).toBe("unknown");
  });
  it("alive within the stale window, stale beyond it", () => {
    expect(heartbeatState(new Date(now - 30_000).toISOString(), now)).toBe("alive");
    expect(heartbeatState(new Date(now - (HEARTBEAT_STALE_MS + 1_000)).toISOString(), now)).toBe("stale");
  });
});

describe("deriveBlockerState", () => {
  it("returns null when actively progressing", () => {
    expect(deriveBlockerState(blockerIssue({ status: "in_progress" }), undefined, undefined)).toBeNull();
    expect(deriveBlockerState(blockerIssue({ status: "reopen" }), undefined, undefined)).toBeNull();
  });

  it("needs_info shows the supplied question and a provide-info action", () => {
    const b = deriveBlockerState(blockerIssue({ status: "needs_info" }), undefined, undefined, {
      needsInfoQuestion: "Which environment?",
    });
    expect(b?.cta.kind).toBe("provide-info");
    expect(b?.question).toBe("Which environment?");
  });

  it("waiting → approve action", () => {
    const b = deriveBlockerState(blockerIssue({ status: "waiting" }), undefined, undefined);
    expect(b?.cta.kind).toBe("approve");
  });

  it("on_hold status → resume action", () => {
    const b = deriveBlockerState(blockerIssue({ status: "on_hold" }), undefined, undefined);
    expect(b?.cta.kind).toBe("resume");
    expect(b?.reason).toContain("paused");
  });

  it("maps each pipelineHealth.waitingOn reason", () => {
    for (const reason of [
      "issue_busy",
      "waiting_on_dep",
      "waiting_on_decomp_parent",
      "project_full",
      "runner_full",
    ] as const) {
      const b = deriveBlockerState(
        blockerIssue({ status: "in_progress" }),
        { stage: "code", waitingOn: { reason, since: "x", details: {} } },
        undefined,
      );
      expect(b).not.toBeNull();
      expect(b?.reason.length).toBeGreaterThan(0);
    }
  });

  it("falls back to open blocks edges with a link action", () => {
    const b = deriveBlockerState(blockerIssue({ status: "in_progress" }), undefined, incomingBlocks());
    expect(b?.cta.kind).toBe("open-blocker");
    expect(b?.blockingRefs?.[0]?.displayId).toBe("ISS-9");
  });

  it("ignores a blocks edge whose blocker is already released", () => {
    const b = deriveBlockerState(
      blockerIssue({ status: "in_progress" }),
      undefined,
      incomingBlocks({ fromStatus: "released" }),
    );
    expect(b).toBeNull();
  });
});

describe("deriveStageOutcomes", () => {
  const handoff = (step: string, attempt: number, payload: Record<string, unknown>): StepHandoffRow => ({
    id: `${step}-${attempt}`,
    projectId: "p1",
    issueId: "me",
    pipelineRunId: "run-1",
    kind: "handoff",
    step,
    attempt,
    payload,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const dur = (
    step: string,
    durationSeconds: number,
    costUsd: number,
    runId = "run-1",
    finishedAt = "2026-01-01T00:05:00.000Z",
  ): StepDurationRow => ({
    runId,
    issueId: "me",
    projectId: "p1",
    step,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt,
    durationSeconds,
    costUsd,
  });

  it("marks done / current / pending around the current stage", () => {
    const cells = deriveStageOutcomes("plan", "running", [], []);
    expect(cells.triage.state).toBe("done");
    expect(cells.clarify.state).toBe("done");
    expect(cells.plan.state).toBe("current");
    expect(cells.code.state).toBe("pending");
    expect(cells.release.state).toBe("pending");
  });

  it("pulls a short outcome label + sums duration/cost from a full payload", () => {
    const cells = deriveStageOutcomes(
      "code",
      "running",
      [handoff("plan", 1, { summary: "wrote the plan" })],
      [dur("plan", 120, 0.25), dur("plan", 60, 0.1)],
    );
    expect(cells.plan.outcomeLabel).toBe("wrote the plan");
    expect(cells.plan.durationSeconds).toBe(180);
    expect(cells.plan.costUsd).toBeCloseTo(0.35);
    expect(cells.plan.handoff?.step).toBe("plan");
  });

  it("keeps the latest attempt and never throws on an empty/odd payload", () => {
    const cells = deriveStageOutcomes(
      "review",
      "running",
      [handoff("plan", 1, {}), handoff("plan", 2, { outcome: "v2" })],
      undefined,
    );
    expect(cells.plan.handoff?.attempt).toBe(2);
    expect(cells.plan.outcomeLabel).toBe("v2");
    // empty payload at the current stage → no label, no crash
    const empty = deriveStageOutcomes("plan", "running", [handoff("plan", 1, {})], []);
    expect(empty.plan.outcomeLabel).toBeUndefined();
  });

  it("marks the failing stage as error", () => {
    const cells = deriveStageOutcomes("code", "failed", [], [], "code");
    expect(cells.code.state).toBe("error");
  });

  it("uses only the most-recent run's duration/cost (no double-count on reopen)", () => {
    const cells = deriveStageOutcomes(
      "code",
      "running",
      [],
      [
        dur("plan", 100, 1.0, "run-old", "2026-01-01T00:05:00.000Z"),
        dur("plan", 200, 2.0, "run-new", "2026-02-01T00:05:00.000Z"),
      ],
    );
    expect(cells.plan.durationSeconds).toBe(200);
    expect(cells.plan.costUsd).toBeCloseTo(2.0);
  });

  it("folds fix handoffs into the code stage", () => {
    const cells = deriveStageOutcomes("review", "running", [handoff("fix", 1, { summary: "patched" })], []);
    expect(cells.code.outcomeLabel).toBe("patched");
  });
});
