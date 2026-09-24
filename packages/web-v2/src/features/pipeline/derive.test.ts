import { describe, expect, it } from "vitest";
import { aggregateStepCosts, cardStatus, median, runGateNote } from "./derive";
import { LABEL_VIEW, statusToChip } from "@/features/issues/derive";
import { PIPELINE_RUN_STATUSES, type PipelineIssueRow, type RunGateCondition, type StepDurationRow } from "./types";

function step(over: Partial<StepDurationRow> & { step: string }): StepDurationRow {
  return {
    runId: over.runId ?? "r1",
    issueId: over.issueId ?? "i1",
    projectId: over.projectId ?? "p1",
    step: over.step,
    startedAt: over.startedAt ?? "2026-06-01T00:00:00Z",
    finishedAt: over.finishedAt ?? "2026-06-01T00:01:00Z",
    durationSeconds: over.durationSeconds ?? 10,
    costUsd: over.costUsd ?? 0.01,
  };
}

describe("median", () => {
  it("returns null for an empty list", () => {
    expect(median([])).toBeNull();
  });
  it("returns the middle of an odd-length list", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it("averages the two middles of an even-length list", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("aggregateStepCosts — the job types that actually ran (ISS-999)", () => {
	it("returns one row per job type on the rows, and none for a job type with no row", () => {
		const rows = aggregateStepCosts([step({ step: "code" }), step({ step: "test" })]);
		expect(rows.map((r) => r.step).sort()).toEqual(["code", "test"]);
	});

	it("keeps a job type outside the seven staged names under its own name", () => {
		const rows = aggregateStepCosts([step({ step: "drive", durationSeconds: 9 })]);
		expect(rows.map((r) => r.step)).toEqual(["drive"]);
		expect(rows[0].medianSec).toBe(9);
	});

	it("gives `fix` a row of its own rather than summing it into `code`", () => {
		const rows = aggregateStepCosts([
			step({ step: "code", durationSeconds: 10, costUsd: 0.01 }),
			step({ step: "fix", durationSeconds: 20, costUsd: 0.03 }),
		]);
		expect(rows.find((r) => r.step === "code")?.samples).toBe(1);
		expect(rows.find((r) => r.step === "fix")?.samples).toBe(1);
	});

	it("takes the median duration and the summed cost per job type", () => {
		const rows = aggregateStepCosts([
			step({ step: "code", durationSeconds: 10, costUsd: 0.01 }),
			step({ step: "code", durationSeconds: 30, costUsd: 0.02 }),
			step({ step: "code", durationSeconds: 20, costUsd: 0.03 }),
		]);
		expect(rows[0].samples).toBe(3);
		expect(rows[0].medianSec).toBe(20);
		expect(rows[0].cost).toBeCloseTo(0.06, 5);
	});

	it("orders slowest median first, so the caller's `[0]` IS the bottleneck", () => {
		const rows = aggregateStepCosts([
			step({ step: "code", durationSeconds: 10 }),
			step({ step: "test", durationSeconds: 90 }),
			step({ step: "plan", durationSeconds: 50 }),
		]);
		expect(rows.map((r) => r.step)).toEqual(["test", "plan", "code"]);
	});

	it("colours one of the seven from its own token and anything else neutrally", () => {
		const rows = aggregateStepCosts([step({ step: "code" }), step({ step: "drive" })]);
		expect(rows.find((r) => r.step === "code")?.color).toBe("var(--stage-code)");
		expect(rows.find((r) => r.step === "drive")?.color).toBe("var(--fg-subtle)");
	});

	it("returns nothing for an empty or absent window", () => {
		expect(aggregateStepCosts([])).toEqual([]);
		expect(aggregateStepCosts(undefined)).toEqual([]);
	});
});

describe("cardStatus", () => {
  const issue = (over: Partial<PipelineIssueRow> = {}): PipelineIssueRow =>
    ({
      id: "i",
      projectId: "p",
      displayId: "ISS-903",
      title: "t",
      status: "in_progress",
      priority: "high",
      assigneeId: null,
      agentStatus: null,
      held: true,
      ...over,
    }) as PipelineIssueRow;
  const queuedHealth = (reason?: string) =>
    ({
      stage: "in_progress",
      queuedStep: {
        jobId: "a872c0b8",
        jobType: "drive",
        stageStatus: "open",
        queuedAt: "2026-09-03T14:43:00.000Z",
        retryAfterAt: null,
      },
      ...(reason
        ? { waitingOn: { reason, since: "2026-09-03T14:43:00.000Z", details: {} } }
        : {}),
    }) as PipelineIssueRow["pipelineHealth"];

  it("lets a queued step outrank the run's own Running", () => {
    const card = cardStatus(
      issue({ pipelineHealth: queuedHealth("runner_stale") }),
      { status: "running" },
    );
    expect(card.status).toBe("waiting");
    expect(card.label).toBe("No runner online");
    expect(card.domain).toBe("session");
    expect(card.waitingReason).toMatch(/No runner is online/);
  });

  it("says Queued with no gate sentence for a step merely awaiting its turn", () => {
    const card = cardStatus(
      issue({ pipelineHealth: queuedHealth() }),
      { status: "running" },
    );
    expect(card.status).toBe("queued");
    expect(card.label).toBe("Queued");
    expect(card.waitingReason).toBe("");
  });

  it("keeps the run's status when a session is live", () => {
    const card = cardStatus(
      issue({ pipelineHealth: queuedHealth("runner_stale"), agentStatus: "running" }),
      { status: "running" },
    );
    expect(card.status).toBe("running");
    expect(card.label).toBeUndefined();
  });

  it("shows the gate for a deferred retry, whose agentStatus reads failed", () => {
    const card = cardStatus(
      issue({ pipelineHealth: queuedHealth("runner_stale"), agentStatus: "failed" }),
      { status: "running" },
    );
    expect(card.label).toBe("No runner online");
  });

  it("falls back to the lane word a held row reads with no run and nothing queued", () => {
    const card = cardStatus(issue(), undefined);
    expect(card.domain).toBe("issue");
    expect(card.label).toBe("Running");
    expect(card.status).toBe(statusToChip("in_progress"));
  });

  // ISS-1213: rows stood at `testing` for hours with nothing on them, their cards reading Running.
  it("reads Stalled, in the stalled chip, on a row nothing holds", () => {
    const card = cardStatus(issue({ status: "testing", held: false }), undefined);
    expect([card.label, card.status]).toEqual(["Stalled", LABEL_VIEW.stalled.status]);
    expect(card.status).not.toBe(statusToChip("testing"));
  });

  // A live run would have made the row held, so every run the board kept for an unheld row is history.
  it.each(PIPELINE_RUN_STATUSES)("reads Stalled on a row nothing holds whatever its kept run (%s)", (status) => {
    const card = cardStatus(issue({ status: "testing", held: false }), { status });
    expect([card.label, card.status, card.domain]).toEqual(["Stalled", LABEL_VIEW.stalled.status, "issue"]);
  });

  it("keeps a party's word on a row nothing holds, since no run was owed there", () => {
    const card = cardStatus(issue({ status: "needs_info", held: false }), undefined);
    expect(card.label).toBe("Needs a human");
  });
});

const runGate = (over: Partial<RunGateCondition> = {}): RunGateCondition => ({
	verdict: "failing_open",
	count: 30,
	perDay: 144,
	windowMs: 18_000_000,
	byReason: [{ reason: "this pane carries no control capability", count: 30 }],
	...over,
});

describe("runGateNote", () => {
	it("names the count, the rate and the window of a gate that was failing open", () => {
		const note = runGateNote({ read: "ok", condition: runGate() });
		expect(note?.verdict).toBe("failing_open");
		expect(note?.detail).toBe("30 dispatch(es) admitted without a decision, 144/day over 5h 00m");
	});

	it("says when one reason accounts for the whole count", () => {
		expect(runGateNote({ read: "ok", condition: runGate() })?.reason).toBe(
			"every one of them: this pane carries no control capability",
		);
	});

	it("names the commonest reason with its share where the count is a mixture", () => {
		const note = runGateNote({
			read: "ok",
			condition: runGate({
				byReason: [
					{ reason: "no control capability", count: 20 },
					{ reason: "the daemon did not answer", count: 10 },
				],
			}),
		});
		expect(note?.reason).toBe("20 of 30: no control capability");
	});

	it("still states a gate that had marked without reaching failing open", () => {
		const note = runGateNote({
			read: "ok",
			condition: runGate({ verdict: "marked", count: 2, perDay: 3 }),
		});
		expect(note?.verdict).toBe("marked");
		expect(note?.headline).toContain("admitted undecided dispatches");
	});

	it("says nothing where the response did not carry the field", () => {
		expect(runGateNote(undefined)).toBeNull();
	});

	// The API keeps "the box sent none" apart from "the gate was clear"; the
	// screen used to render nothing for both and put them back together.
	it("says a box reported no condition, and says it differently from a gate that was deciding", () => {
		const none = runGateNote(null);
		const clear = runGateNote({ read: "ok", condition: runGate({ verdict: "clear", count: 0 }) });
		expect(none?.verdict).toBe("none");
		expect(none?.headline).toContain("reported no gate condition");
		expect(clear?.verdict).toBe("clear");
		expect(clear?.headline).toContain("was deciding");
		expect(none?.headline).not.toBe(clear?.headline);
		expect(none?.detail).not.toBe(clear?.detail);
	});

	// A condition core holds but cannot read is evidence, and rendering nothing
	// would tell the reviewer the box reported none (ISS-1192 F1).
	it("says a stored condition could not be read, rather than showing nothing", () => {
		const note = runGateNote({ read: "unreadable", reason: "gate.verdict: bad enum" });
		expect(note?.verdict).toBe("unreadable");
		expect(note?.headline).toContain("cannot be read");
		expect(note?.detail).toContain("gate.verdict: bad enum");
	});

	it("does not invent a rate or a window the box did not state", () => {
		const note = runGateNote({
			read: "ok",
			condition: runGate({ perDay: null, windowMs: null }),
		});
		expect(note?.detail).toBe(
			"30 dispatch(es) admitted without a decision, at an unstated rate over an unknown span",
		);
	});
});
