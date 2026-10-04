import { describe, expect, it } from "vitest";
import type { AgentReport } from "@/features/agent-reports/types";
import type { ScheduleRun } from "@/features/schedules/types";
import { feedbackDraftOf, improvementRows, issueFromReport, matchesFilter } from "./improvements";

const report = (over: Partial<AgentReport> = {}): AgentReport => ({
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
  reviewedAt: null,
  linkedIssueId: null,
  feedback: null,
  createdAt: "2026-10-01T09:00:00.000Z",
  ...over,
});

const run = (actions: NonNullable<ScheduleRun["stewardReport"]>["actions"]): ScheduleRun => ({
  sessionId: "s1",
  pipelineRunId: null,
  status: "completed",
  runStatus: null,
  trigger: "scheduled",
  title: null,
  failureReason: null,
  failureDetail: null,
  startedAt: "2026-10-01T10:00:00.000Z",
  finishedAt: "2026-10-01T10:05:00.000Z",
  durationSeconds: 300,
  stewardReport: { weakestDomain: "testing", skillsAssessed: [], actions, memoryWrites: [], idempotencySkips: [] },
});

describe("the Improvements list", () => {
  it("puts agent reports in and the loop's proposals out on one list, newest first", () => {
    const rows = improvementRows(
      [report()],
      [{ title: "Review", runs: [run([{ skill: "forge-test", kind: "proposed", summary: "Tighten the checklist" }])] }],
    );
    expect(rows.map((r) => [r.source, r.state, r.title])).toEqual([
      ["proposal", "proposal", "Tighten the checklist"],
      ["report", "report", "The boundary axis is missed"],
    ]);
  });

  it("counts reviewed reports and applied changes as done, and leaves skipped actions out", () => {
    const rows = improvementRows(
      [report({ reviewedAt: "2026-10-01T11:00:00.000Z" })],
      [
        {
          title: "Review",
          runs: [
            run([
              { skill: "a", kind: "applied", summary: "Applied one" },
              { skill: "b", kind: "skipped", summary: "Skipped one" },
              { skill: "c", kind: "feedback", summary: "Feedback one" },
            ]),
          ],
        },
      ],
    );
    expect(rows.map((r) => r.state)).toEqual(["done", "done"]);
    expect(rows.filter((r) => matchesFilter(r, "done"))).toHaveLength(2);
    expect(rows.filter((r) => matchesFilter(r, "reports"))).toHaveLength(0);
    expect(rows.filter((r) => matchesFilter(r, "proposals"))).toHaveLength(0);
  });

  it("files an issue from an agent report that names the report it came from", () => {
    const body = issueFromReport(report());
    expect(body.title).toBe("The boundary axis is missed");
    expect(body.description).toContain("Suggested: Add the boundary case");
    expect(body.description).toContain("Agent report f1");
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
    const promoted = report({ reviewedAt: "2026-10-04T09:00:00.000Z", feedback: { id: "fb", key: "FB-7", phase: "new", route: null } });
    expect(improvementRows([promoted], [])[0]?.state).toBe("done");
  });
});
