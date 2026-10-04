import { describe, expect, it } from "vitest";
import type { AutomationWaitingOn, FireProposal, ReportStanding } from "@/features/automation/types";
import { feedbackDraftOf, improvementRows, matchesFilter } from "./improvements";

const NOBODY: AutomationWaitingOn = { kind: "none", who: "Nobody", act: null, rule: "", ref: null };

const report = (over: Partial<ReportStanding> = {}): ReportStanding => ({
  id: "f1",
  projectId: "p1",
  projectSlug: "eco-a",
  issueId: null,
  runId: null,
  jobId: null,
  stage: null,
  kind: "friction",
  severity: "medium",
  target: "skill",
  targetRef: "forge-test",
  summary: "The boundary axis is missed",
  detail: "Seen twice in review",
  suggestion: "Add the boundary case",
  signalKey: "k",
  sessionId: null,
  scheduleRunId: null,
  triage: "new",
  triagedBy: null,
  triagedAt: null,
  triageReason: null,
  duplicateOf: null,
  linkedIssueId: null,
  feedback: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  fire: null,
  attentionGroup: over.triage && over.triage !== "new" ? (over.triage === "filed" ? "filed" : "closed") : "needs_you",
  waitingOn: NOBODY,
  ...over,
});

const proposal = (over: Partial<FireProposal> = {}): FireProposal => ({
  fireId: "fire-1",
  scheduleId: "sch-1",
  scheduleName: "improve:skills",
  sessionId: "s1",
  skill: "forge-test",
  kind: "proposed",
  summary: "Tighten the checklist",
  at: "2026-10-01T10:05:00.000Z",
  ...over,
});

const loop = (scheduleId: string) => (scheduleId === "sch-1" ? "Review" : "Improvement loop");

describe("the Improvements list", () => {
  it("puts agent reports in and the loop's proposals out on one list, newest first, named by their loop", () => {
    const rows = improvementRows([report()], [proposal()], loop);
    expect(rows.map((r) => [r.source, r.state, r.title, r.from])).toEqual([
      ["proposal", "proposal", "Tighten the checklist", "Review · forge-test"],
      ["report", "report", "The boundary axis is missed", "Friction · Skill forge-test"],
    ]);
  });

  it("counts triaged reports and applied changes as done", () => {
    const rows = improvementRows(
      [report({ triage: "dismissed", triagedAt: "2026-10-01T11:00:00.000Z", triageReason: "already fixed" })],
      [proposal({ kind: "applied", summary: "Applied one" })],
      loop,
    );
    expect(rows.map((r) => r.state)).toEqual(["done", "done"]);
    expect(rows.filter((r) => matchesFilter(r, "done"))).toHaveLength(2);
    expect(rows.filter((r) => matchesFilter(r, "reports"))).toHaveLength(0);
    expect(rows.filter((r) => matchesFilter(r, "proposals"))).toHaveLength(0);
  });

  it("keeps a report the read model groups as awaiting triage waiting, whoever owes it, and the rest done", () => {
    const states = (["needs_you", "waiting", "filed", "closed"] as const).map(
      (attentionGroup) => improvementRows([report({ attentionGroup })], [], loop)[0]?.state,
    );
    expect(states).toEqual(["report", "report", "done", "done"]);
  });
});

describe("promoting a report into feedback (ISS-93)", () => {
  it("prefills the form from what the report said, as a screen named by its target", () => {
    expect(feedbackDraftOf(report())).toEqual({
      kind: "change_request",
      severity: "medium",
      targetType: "screen",
      target: "Skill forge-test",
      title: "The boundary axis is missed",
      body: "Seen twice in review\n\nSuggested: Add the boundary case",
    });
  });

  it("reads a bug as a bug, a suggestion or learning as an idea, and high severity as high", () => {
    expect(feedbackDraftOf(report({ kind: "bug", severity: "high" }))).toMatchObject({ kind: "bug", severity: "high" });
    expect(feedbackDraftOf(report({ kind: "suggestion" })).kind).toBe("idea");
    expect(feedbackDraftOf(report({ kind: "learning", targetRef: null })).target).toBe("Skill");
  });

  it("lists a promoted report as done", () => {
    const promoted = report({ triage: "filed", triagedAt: "2026-10-04T09:00:00.000Z", feedback: { id: "fb", key: "FB-7", phase: "new", route: null } });
    expect(improvementRows([promoted], [], loop)[0]?.state).toBe("done");
  });
});
