import { describe, expect, it } from "vitest";
import type { FeedbackReport } from "@/features/feedback/types";
import type { ScheduleRun } from "@/features/schedules/types";
import { improvementRows, issueFromFeedback, matchesFilter } from "./improvements";

const report = (over: Partial<FeedbackReport> = {}): FeedbackReport => ({
  id: "f1",
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
  it("puts feedback in and the loop's proposals out on one list, newest first", () => {
    const rows = improvementRows(
      [report()],
      [{ title: "Review", runs: [run([{ skill: "forge-test", kind: "proposed", summary: "Tighten the checklist" }])] }],
    );
    expect(rows.map((r) => [r.source, r.state, r.title])).toEqual([
      ["proposal", "proposal", "Tighten the checklist"],
      ["feedback", "feedback", "The boundary axis is missed"],
    ]);
  });

  it("counts reviewed feedback and applied changes as done, and leaves skipped actions out", () => {
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
    expect(rows.filter((r) => matchesFilter(r, "feedback"))).toHaveLength(0);
    expect(rows.filter((r) => matchesFilter(r, "proposals"))).toHaveLength(0);
  });

  it("files an issue from feedback that names the report it came from", () => {
    const body = issueFromFeedback(report());
    expect(body.title).toBe("The boundary axis is missed");
    expect(body.description).toContain("Suggested: Add the boundary case");
    expect(body.description).toContain("Feedback f1");
  });
});
