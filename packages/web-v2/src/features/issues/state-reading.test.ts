// ISS-1155 — what the Issues list's one state signal says for a row.
//
// ISS-1257 — the row says which issues wait on a person and for how long, and says nothing on a
// draft, on finished work or at the release gate, where a question leaves the state alone.
// ISS-903 / ISS-700 — a queued step names the gate holding it, a failed run keeps its reason.

import { describe, expect, it } from "vitest";
import { stateReading } from "./state-reading";
import type { IssueRow, IssueStatus, PipelineHealth } from "./types";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

const row = (over: Partial<IssueRow> = {}): IssueRow =>
  ({
    id: "i",
    projectId: "p",
    issSeq: 1155,
    displayId: "ISS-1155",
    title: "A row",
    status: "in_progress",
    priority: "medium",
    category: null,
    complexity: null,
    assigneeId: null,
    createdById: "u",
    creatorEmail: null,
    creatorIsAgent: false,
    creatorLabel: "A person",
    reopenCount: 0,
    mergedAt: null,
    createdAt: iso(90 * HOUR),
    updatedAt: iso(2 * HOUR),
    agentStatus: null,
    ...over,
  }) as IssueRow;

const queuedHealth = (reason?: string): PipelineHealth =>
  ({
    stage: "in_progress",
    queuedAt: iso(10 * MIN),
    queuedStep: { jobId: "j", jobType: "drive", stageStatus: "open", queuedAt: iso(10 * MIN), retryAfterAt: null },
    ...(reason ? { waitingOn: { reason, since: iso(10 * MIN), details: {} } } : {}),
  }) as PipelineHealth;

describe("the status word", () => {
  it("is the issue's own status, whatever else the row says", () => {
    expect(stateReading(row({ status: "in_progress", agentStatus: "running" }), NOW).statusWord).toBe("In progress");
    expect(stateReading(row({ status: "releasing" }), NOW).statusWord).toBe("Releasing");
  });
});

describe("the dot", () => {
  it.each([
    ["an agent is running", { agentStatus: "running" as const }, "running"],
    ["the run failed", { agentStatus: "failed" as const }, "failed"],
    ["nothing has started", { status: "open" as IssueStatus }, "queued"],
    ["the issue is closed", { status: "closed" as IssueStatus }, "archived"],
    ["the issue needs an answer", { status: "needs_info" as IssueStatus }, "waiting"],
  ])("reads %s", (_name, over, tone) => {
    expect(stateReading(row(over), NOW).tone).toBe(tone);
  });

  it("is amber for a queued step only when its gate needs a person to act", () => {
    expect(stateReading(row({ pipelineHealth: queuedHealth("runner_stale") }), NOW).tone).toBe("waiting");
    expect(stateReading(row({ pipelineHealth: queuedHealth("retry_cooldown") }), NOW).tone).toBe("queued");
    expect(stateReading(row({ pipelineHealth: queuedHealth() }), NOW).tone).toBe("queued");
  });

  it("puts a failure ahead of a person's wait, and a person's wait ahead of a running agent", () => {
    const owed = { waitingOnPersonSince: iso(3 * HOUR) };
    expect(stateReading(row({ ...owed, agentStatus: "failed" }), NOW).tone).toBe("failed");
    expect(stateReading(row({ ...owed, agentStatus: "running" }), NOW).tone).toBe("waiting");
  });

  it("pulses only while an agent is working", () => {
    expect(stateReading(row({ agentStatus: "running" }), NOW).live).toBe(true);
    expect(stateReading(row({ agentStatus: "queued" }), NOW).live).toBe(false);
    expect(stateReading(row(), NOW).live).toBe(false);
  });
});

describe("waiting on a person", () => {
  const since = iso(3 * 24 * HOUR);

  it("says how long the question has waited, against the list's one clock", () => {
    expect(stateReading(row({ waitingOnPersonSince: since }), NOW).waitingOnPerson).toEqual({ age: "3d" });
  });

  it("says nothing for an issue no question waits on", () => {
    expect(stateReading(row({ waitingOnPersonSince: null }), NOW).waitingOnPerson).toBeNull();
    expect(stateReading(row(), NOW).waitingOnPerson).toBeNull();
  });

  it("says nothing rather than NaN for a timestamp it cannot read", () => {
    const reading = stateReading(row({ waitingOnPersonSince: "not a date" }), NOW);
    expect(reading.waitingOnPerson).toBeNull();
    expect(JSON.stringify(reading)).not.toContain("NaN");
  });

  it.each(["open", "testing", "needs_info", "waiting", "on_hold", "reopen"] as const)(
    "says it on a %s issue, which a question leaves in Blocked on a person",
    (status) => {
      expect(stateReading(row({ status, waitingOnPersonSince: since }), NOW).waitingOnPerson).not.toBeNull();
    },
  );

  it.each(["draft", "closed", "dropped", "awaiting_release", "tested"] as const)(
    "says nothing on a %s issue, whose state a question does not move",
    (status) => {
      const reading = stateReading(row({ status, waitingOnPersonSince: since }), NOW);
      expect(reading.waitingOnPerson).toBeNull();
      expect(reading.tone).not.toBe("waiting");
    },
  );

  it("takes the question's wait as the figure, not the issue's last write", () => {
    const reading = stateReading(row({ waitingOnPersonSince: since, updatedAt: iso(MIN) }), NOW);
    expect(reading.elapsed?.label).toBe("3d");
    expect(reading.elapsed?.title).toMatch(/waited on a person/);
  });
});

describe("what the run is doing", () => {
  it("names the step an agent is running", () => {
    const reading = stateReading(
      row({
        agentStatus: "running",
        pipelineHealth: { stage: "in_progress", activeSession: { id: "s1", status: "running", skill: "code" } } as PipelineHealth,
      }),
      NOW,
    );
    expect(reading.runs).toEqual([{ word: "Running", step: "code", detail: null }]);
  });

  it("names the gate holding a queued step, with its detail", () => {
    const [run] = stateReading(row({ pipelineHealth: queuedHealth("runner_stale") }), NOW).runs;
    expect(run.word).toBe("No runner online");
    expect(run.step).toBe("drive");
    expect(run.detail).toMatch(/No runner is online/);
  });

  it("says Queued when nothing is holding the step, so queued never reads as stuck", () => {
    const [run] = stateReading(row({ pipelineHealth: queuedHealth() }), NOW).runs;
    expect(run).toEqual({ word: "Queued", step: "drive", detail: null });
  });

  it("keeps a failure's step and reason, and still shows the gate on a deferred retry", () => {
    const reading = stateReading(
      row({
        agentStatus: "failed",
        failureInfo: { failedStep: "review", failureReason: "tests red", failureKind: null, failedAt: iso(5 * MIN) },
        pipelineHealth: queuedHealth("runner_stale"),
      }),
      NOW,
    );
    expect(reading.runs.map((r) => r.word)).toEqual(["No runner online", "Failed"]);
    expect(reading.runs[1]).toMatchObject({ step: "review" });
    expect(reading.runs[1].detail).toBe("Review failed · tests red · 5m ago");
  });

  it("says a failure has no details rather than inventing one", () => {
    const [run] = stateReading(row({ agentStatus: "failed", failureInfo: null }), NOW).runs;
    expect(run.detail).toBe("No failure details available");
  });

  it("shows nothing for a completed run or none", () => {
    expect(stateReading(row({ agentStatus: "completed" }), NOW).runs).toEqual([]);
    expect(stateReading(row(), NOW).runs).toEqual([]);
  });
});

describe("how long, and measured from what", () => {
  const running = (updatedAgo: number): IssueRow =>
    row({
      agentStatus: "running",
      updatedAt: iso(updatedAgo),
      agentSessions: [
        { id: "s1", status: "running", metadata: null, createdAt: iso(40 * MIN), updatedAt: iso(MIN), title: null, startedAt: iso(31 * MIN) },
      ],
      pipelineHealth: { stage: "in_progress", activeSession: { id: "s1", status: "running", skill: "code" } } as PipelineHealth,
    });

  it("is the run's own age while an agent runs, not the write that a claim or a lease renewal makes", () => {
    const reading = stateReading(running(MIN), NOW);
    expect(reading.elapsed?.label).toBe("31m");
    expect(reading.elapsed?.title).toMatch(/run began 31m ago/);
    expect(reading.elapsed?.title).not.toMatch(/written/);
  });

  it("is the queued step's age while one waits", () => {
    const reading = stateReading(row({ pipelineHealth: queuedHealth(), updatedAt: iso(MIN) }), NOW);
    expect(reading.elapsed?.label).toBe("10m");
  });

  it("is the failure's age on a failed run", () => {
    const reading = stateReading(
      row({ agentStatus: "failed", failureInfo: { failedStep: "code", failureReason: null, failureKind: null, failedAt: iso(2 * HOUR) } }),
      NOW,
    );
    expect(reading.elapsed?.label).toBe("2h");
  });

  it("falls back to the last write only when the row records nothing more specific, and says so", () => {
    const fresh = stateReading(row({ updatedAt: iso(2 * HOUR) }), NOW).elapsed;
    expect(fresh).toMatchObject({ label: "2h", stale: false });
    expect(fresh?.title).toMatch(/last written to 2h ago/);
    expect(fresh?.title).toMatch(/comment on its own does not/);
    expect(fresh?.title).not.toMatch(/in this status|at this status/i);
  });

  it("reports a fresh write as a write, not as time in a status the issue has sat at for days", () => {
    const reading = stateReading(row({ status: "open", createdAt: iso(10 * 24 * HOUR), updatedAt: iso(MIN) }), NOW);
    expect(reading.elapsed?.label).toBe("1m");
    expect(reading.elapsed?.title).toMatch(/last written to/);
  });

  it("marks a figure of a day or more as stale, and a fresher one not", () => {
    expect(stateReading(row({ updatedAt: iso(48 * HOUR) }), NOW).elapsed?.stale).toBe(true);
    expect(stateReading(row({ updatedAt: iso(23 * HOUR) }), NOW).elapsed?.stale).toBe(false);
  });

  it("has none for a settled issue", () => {
    expect(stateReading(row({ status: "closed" }), NOW).elapsed).toBeNull();
    expect(stateReading(row({ status: "dropped" }), NOW).elapsed).toBeNull();
  });
});
