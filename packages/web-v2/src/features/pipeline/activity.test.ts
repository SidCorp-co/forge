// The feed's whole reason to exist is that N failures must not read as N
// identical lines, so the load-bearing cases are: same cause N times collapses
// and COUNTS; two different causes never collapse; `unclassified` is rendered
// rather than hidden; and a live attempt still says something.

import { describe, expect, it } from "vitest";
import {
  type ActivityEntry,
  deriveActivityFeed,
  distinctCauseCount,
  filterActivity,
  isFailureEntry,
} from "./activity";
import type { PipelineRunAttempt } from "./types";

function attempt(over: Partial<PipelineRunAttempt> = {}): PipelineRunAttempt {
  return {
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    jobType: "code",
    status: "failed",
    attempts: 1,
    retryOf: null,
    deviceId: "dev-1",
    deviceName: "ubuntu5",
    failureReason: null,
    failureCause: null,
    failureDetail: null,
    failureKind: null,
    failureAction: null,
    queuedAt: "2026-08-30T10:00:00.000Z",
    startedAt: "2026-08-30T10:00:05.000Z",
    finishedAt: "2026-08-30T10:01:00.000Z",
    autoRetry: null,
    ...over,
  };
}

describe("deriveActivityFeed", () => {
  it("collapses 16 identical spend-cap deaths into one counted line", () => {
    const rows = Array.from({ length: 16 }, () =>
      attempt({ failureCause: "provider_spend_cap", failureDetail: "org monthly cap reached" }),
    );

    const feed = deriveActivityFeed(rows);

    expect(feed).toHaveLength(1);
    expect(feed[0]?.repeats).toBe(16);
    expect(feed[0]?.positions).toHaveLength(16);
    expect(feed[0]?.outcome).toBe("Spend limit reached");
    expect(feed[0]?.verb).toBe("Retried");
  });

  it("keeps two different causes as two lines — the point of the issue", () => {
    const feed = deriveActivityFeed([
      attempt({ failureCause: "provider_spend_cap" }),
      attempt({ failureCause: "workspace_disk_full" }),
    ]);

    expect(feed).toHaveLength(2);
    expect(feed.map((e) => e.outcome)).toEqual(["Spend limit reached", "Runner disk full"]);
    expect(distinctCauseCount(feed)).toBe(2);
  });

  it("does not collapse the same cause across different runners", () => {
    const feed = deriveActivityFeed([
      attempt({ failureCause: "runner_unreachable", deviceName: "ubuntu5" }),
      attempt({ failureCause: "runner_unreachable", deviceName: "ubuntu6" }),
    ]);

    expect(feed).toHaveLength(2);
    expect(feed.map((e) => e.device)).toEqual(["ubuntu5", "ubuntu6"]);
  });

  it("re-opens a group when a third attempt differs from the collapsed pair", () => {
    const feed = deriveActivityFeed([
      attempt({ failureCause: "provider_spend_cap" }),
      attempt({ failureCause: "provider_spend_cap" }),
      attempt({ failureCause: "agent_killed" }),
      attempt({ failureCause: "provider_spend_cap" }),
    ]);

    expect(feed.map((e) => [e.outcome, e.repeats])).toEqual([
      ["Spend limit reached", 2],
      ["Agent killed", 1],
      ["Spend limit reached", 1],
    ]);
  });

  it("renders unclassified as a first-class line, never a blank", () => {
    const feed = deriveActivityFeed([attempt({ failureCause: "job_failed" })]);

    expect(feed[0]?.cause).toBe("unclassified");
    expect(feed[0]?.outcome).toBe("Unclassified");
    expect(isFailureEntry(feed[0] as ActivityEntry)).toBe(true);
  });

  it("classifies a failed attempt that left no cause at all rather than going quiet", () => {
    const feed = deriveActivityFeed([attempt({ failureCause: null, failureReason: null })]);

    expect(feed[0]?.cause).toBe("unclassified");
    expect(feed[0]?.action).toBeTruthy();
  });

  it("says something for an attempt still in flight — silence is a rendered state", () => {
    const feed = deriveActivityFeed([
      attempt({ status: "queued", finishedAt: null, startedAt: null, failureCause: null }),
      attempt({ status: "running", finishedAt: null, failureCause: null }),
    ]);

    expect(feed.map((e) => e.outcome)).toEqual([
      "Queued — no runner has picked it up",
      "Still running",
    ]);
    expect(feed.every((e) => e.open)).toBe(true);
    expect(feed.every((e) => e.tone === "open")).toBe(true);
  });

  it("keeps a benign cleanup out of the red — a cascade is not a failure", () => {
    const feed = deriveActivityFeed([attempt({ failureCause: "pipeline_cancelled" })]);

    expect(feed[0]?.tone).toBe("cleanup");
    expect(isFailureEntry(feed[0] as ActivityEntry)).toBe(false);
    expect(distinctCauseCount(feed)).toBe(0);
  });

  it("reads a dispatcher skip reason neutral instead of counting it as a death", () => {
    const feed = deriveActivityFeed([
      attempt({ status: "cancelled", failureReason: "runner_full", failureCause: null }),
    ]);

    expect(feed[0]?.cause).toBeNull();
    expect(feed[0]?.outcome).toBe("Runner at capacity");
    expect(feed[0]?.tone).toBe("swept");
  });

  it("prefers the operator sentence over the classifier's free text", () => {
    const feed = deriveActivityFeed([
      attempt({
        failureCause: "provider_spend_cap",
        failureDetail: "org monthly cap reached",
        failureReason: "usage/session limit -> cross-device failover",
      }),
    ]);

    expect(feed[0]?.detail).toBe("org monthly cap reached");
  });

  it("never echoes the cause token back as its own detail", () => {
    const feed = deriveActivityFeed([
      attempt({ failureCause: "agent_killed", failureReason: "agent_killed" }),
    ]);

    expect(feed[0]?.detail).toBeNull();
  });

  it("labels the first attempt Ran and a later one Retried", () => {
    const feed = deriveActivityFeed([
      attempt({ status: "done", failureCause: null }),
      attempt({ jobType: "review", failureCause: "agent_killed" }),
    ]);

    expect(feed.map((e) => e.verb)).toEqual(["Ran", "Retried"]);
  });

  it("returns nothing for a run that has not recorded an attempt", () => {
    expect(deriveActivityFeed([])).toEqual([]);
    expect(deriveActivityFeed(undefined)).toEqual([]);
  });
});

describe("filterActivity", () => {
  it("keeps only real failures, so a cleanup-only run filters to empty", () => {
    const feed = deriveActivityFeed([
      attempt({ status: "done", failureCause: null }),
      attempt({ failureCause: "pipeline_completed" }),
    ]);

    expect(filterActivity(feed, "all")).toHaveLength(2);
    expect(filterActivity(feed, "failures")).toHaveLength(0);
  });
});
