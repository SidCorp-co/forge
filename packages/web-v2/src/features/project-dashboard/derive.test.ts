import { describe, expect, it } from "vitest";
import type { AttentionView } from "@/features/attention/types";
import type { PipelineRunListItem, StepDurationRow } from "@/features/pipeline/types";
import type { DeviceRow } from "@/features/runners/types";
import type { QueueStats } from "@/features/sessions/types";
import {
  conicGradient,
  inFlightSpend,
  liveRuns,
  projectAttention,
  runnersSummary,
  spendByStage,
  statusDonut,
  upcomingSchedules,
} from "./derive";

describe("statusDonut", () => {
  it("buckets open statuses and EXCLUDES terminal released/closed/draft from the total (ISS-528)", () => {
    const d = statusDonut({
      in_progress: 2,
      testing: 1,
      developed: 3,
      approved: 1,
      reopen: 1,
      open: 4,
      released: 5, // terminal — excluded from total + produces no segment
    });
    // Open-only total = 12 (the released 5 is dropped so the donut center
    // equals the "Open issues" KPI).
    expect(d.total).toBe(12);
    const byKey = Object.fromEntries(d.segments.map((s) => [s.key, s.count]));
    // ISS-509 — buckets fold by semantic tone. in_progress + testing +
    // developed + reopen are all `active` (cobalt); reopen is NO LONGER a red
    // "blocked" segment — it now matches its in-progress chip + the overview bar.
    expect(byKey.active).toBe(7); // in_progress(2) + testing(1) + developed(3) + reopen(1)
    expect(byKey.queued).toBe(5); // approved(1) + open(4) (neutral)
    // released no longer produces any segment (terminal, excluded).
    expect(d.segments.some((s) => s.key === "ready")).toBe(false);
    // pct sums to 100 across non-empty segments
    expect(d.segments.reduce((n, s) => n + s.pct, 0)).toBeCloseTo(100, 5);
  });

  it("places tested in the Ready bucket and excludes closed/draft (ISS-528)", () => {
    const d = statusDonut({ tested: 3, closed: 100, draft: 4, open: 1 });
    // closed + draft excluded; tested + open are open work.
    expect(d.total).toBe(4);
    const byKey = Object.fromEntries(d.segments.map((s) => [s.key, s.count]));
    expect(byKey.ready).toBe(3); // tested → Ready (awaiting release), not "Done"
    expect(byKey.queued).toBe(1); // open
    // no segment derives from closed/draft (only tested + open counted)
    expect(d.segments.reduce((n, s) => n + s.count, 0)).toBe(4);
  });

  it("drops empty buckets and reports active stage count", () => {
    const d = statusDonut({ open: 2, in_progress: 1 });
    expect(d.segments.map((s) => s.key)).toEqual(["active", "queued"]);
    expect(d.activeStageCount).toBe(2); // triage + code stages
  });

  it("never paints an issue-status segment with the failure(red) tone", () => {
    // Only a failed JOB/session is red; no issue STATUS bucket uses red — this
    // is the ISS-509 fix for reopen/on_hold/needs_info shown as alarm-red.
    const d = statusDonut({ reopen: 1, on_hold: 1, needs_info: 1 });
    expect(d.segments.every((s) => !s.color.includes("red"))).toBe(true);
  });

  it("handles empty/undefined distribution", () => {
    expect(statusDonut(undefined)).toEqual({ segments: [], total: 0, activeStageCount: 0 });
    expect(statusDonut({})).toEqual({ segments: [], total: 0, activeStageCount: 0 });
  });
});

describe("conicGradient", () => {
  it("renders sequential stops covering 0→100", () => {
    const { segments } = statusDonut({ in_progress: 1, open: 1 });
    const css = conicGradient(segments);
    expect(css.startsWith("conic-gradient(")).toBe(true);
    expect(css).toContain("0.000% 50.000%");
    expect(css).toContain("50.000% 100.000%");
  });

  it("falls back to a flat fill when empty", () => {
    expect(conicGradient([])).toBe("var(--paper-200)");
  });
});

describe("spendByStage", () => {
  it("folds steps into test/code/plan/other and sums cost", () => {
    const rows = [
      { step: "test", costUsd: 1 },
      { step: "code", costUsd: 2 },
      { step: "fix", costUsd: 0.5 }, // folds into code
      { step: "plan", costUsd: 1 },
      { step: "review", costUsd: 0.25 }, // other
      { step: "triage", costUsd: 0.25 }, // other
    ] as StepDurationRow[];
    const s = spendByStage(rows);
    expect(s.total).toBeCloseTo(5, 5);
    const byKey = Object.fromEntries(s.segments.map((x) => [x.key, x.cost]));
    expect(byKey.code).toBeCloseTo(2.5, 5);
    expect(byKey.other).toBeCloseTo(0.5, 5);
  });

  it("handles no rows", () => {
    expect(spendByStage(undefined)).toEqual({ segments: [], total: 0 });
  });
});

describe("liveRuns / inFlightSpend", () => {
  const runs = [
    { id: "a", status: "running", cost: { estimatedCost: 1.5 } },
    { id: "b", status: "paused", cost: { estimatedCost: 0.5 } },
    { id: "c", status: "completed", cost: { estimatedCost: 9 } },
  ] as PipelineRunListItem[];

  it("keeps only running + paused", () => {
    expect(liveRuns(runs).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("sums estimated cost across live runs only", () => {
    expect(inFlightSpend(runs)).toBeCloseTo(2.0, 5);
    expect(inFlightSpend(undefined)).toBe(0);
  });
});

describe("projectAttention", () => {
  const view: AttentionView = {
    needsReview: [{ kind: "needs_review", title: "Review changes", link: "/r", since: "x", projectSlug: "p1", issueRef: "ISS-1" }],
    awaitingInput: [{ kind: "awaiting_input", title: "Needs info", link: "/a", since: "x", projectSlug: "p2" }],
    mentions: [],
    failedJobs: [{ kind: "failed_job", title: "code failed", link: "/f", since: "x", projectSlug: "p1", issueRef: "ISS-2" }],
    offlineRunners: [],
    total: 3,
  };

  it("filters to the project and tags actions", () => {
    const items = projectAttention(view, "p1", [
      { issueId: "ISS-9", documentId: "doc-9", status: "reopen" },
    ]);
    // failed (p1) + review (p1) + blocked; awaiting (p2) excluded
    expect(items.map((i) => i.actionKind)).toEqual(["retry", "diff", "chain"]);
    const chain = items.find((i) => i.actionKind === "chain");
    expect(chain?.link).toBe("/projects/p1/issues/doc-9");
    expect(chain?.issueRef).toBe("ISS-9");
  });

  it("is empty (no throw) with no data", () => {
    expect(projectAttention(undefined, "p1", undefined)).toEqual([]);
  });
});

describe("runnersSummary", () => {
  const devices = [
    { id: "d1", name: "mac", platform: "macos", status: "online" },
    { id: "d2", name: "lin", platform: "linux", status: "online" },
    { id: "d3", name: "old", platform: "windows", status: "revoked" },
    { id: "d4", name: "off", platform: "linux", status: "offline" },
  ] as DeviceRow[];
  const queue: QueueStats = {
    devices: [
      { deviceId: "d1", queued: 0, running: 2 },
      { deviceId: "d2", queued: 1, running: 0 },
    ],
  };

  it("joins queue counters, drops revoked, derives busy/online", () => {
    const s = runnersSummary(devices, queue);
    expect(s.total).toBe(3); // revoked dropped
    expect(s.onlineCount).toBe(2);
    expect(s.busyCount).toBe(1); // d1 running>0
    expect(s.lines.find((l) => l.id === "d1")?.busy).toBe(true);
    expect(s.lines.find((l) => l.id === "d2")?.busy).toBe(false);
    // No project runners passed → no limit on any line.
    expect(s.lines.every((l) => l.limit === null)).toBe(true);
  });

  it("joins a project runner's limit onto its device line by deviceId", () => {
    const now = Date.parse("2026-06-22T08:00:00.000Z");
    const projectRunners = [
      {
        runnerId: "r1",
        deviceId: "d1",
        limitReason: "usage_limit",
        rateLimitedUntil: "2026-06-22T08:42:00.000Z",
        limitDetail: "out of extra usage",
      },
      {
        runnerId: "r2",
        deviceId: "d2",
        limitReason: null,
        rateLimitedUntil: null,
        limitDetail: null,
      },
    ] as Parameters<typeof runnersSummary>[2];
    const s = runnersSummary(devices, queue, projectRunners, now);
    const d1 = s.lines.find((l) => l.id === "d1");
    expect(d1?.limit?.reason).toBe("usage_limit");
    expect(d1?.limit?.resetText).toBe("resets in 42m");
    expect(s.lines.find((l) => l.id === "d2")?.limit).toBeNull();
  });
});

describe("upcomingSchedules", () => {
  it("orders by soonest next run, nulls last", () => {
    const rows = [
      { id: "a", nextRunAt: "2026-06-10T00:00:00Z" },
      { id: "b", nextRunAt: null },
      { id: "c", nextRunAt: "2026-06-05T00:00:00Z" },
    ] as Parameters<typeof upcomingSchedules>[0];
    expect(upcomingSchedules(rows).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});
