import { describe, expect, it } from "vitest";
import { aggregateStepCosts, median, runGateNote, runHasStarted, runReadingChip } from "./derive";
import type { PipelineRunStatus, RunGateCondition, RunReading, StepDurationRow } from "./types";

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

	it("returns nothing for an empty or absent window", () => {
		expect(aggregateStepCosts([])).toEqual([]);
		expect(aggregateStepCosts(undefined)).toEqual([]);
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
		expect(note?.detail).toBe("30 dispatches were admitted without a decision, 144/day over 5h 00m.");
	});

	it("says when one reason accounts for the whole count", () => {
		expect(runGateNote({ read: "ok", condition: runGate() })?.reason).toBe(
			"Every one of them: this pane carries no control capability.",
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
		expect(note?.reason).toBe("20 of 30: no control capability.");
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
			"30 dispatches were admitted without a decision, at an unstated rate over an unknown span.",
		);
	});
});

// ISS-1228 round 17 (judge-47): the runs tab read a taken and a sent run Running where the drawer read
// Queued, and the drawer read a sent run Running beside "not started yet". One reading, from core.
describe("runReadingChip — the one word a run reads on every surface", () => {
  const of = (status: PipelineRunStatus, reading: RunReading | null = null) => runReadingChip({ status, reading });

  it("reads a chat waiting on its person as Waiting for me (ISS-1228 round 18)", () => {
    expect(of("running", "waiting")).toEqual({ status: "waiting", label: "Waiting for me" });
  });

  it("calls a run started only once an agent works on it or a chat waits on its person", () => {
    const started = (reading: RunReading | null) => runHasStarted({ status: "running", reading });
    expect([started("running"), started("waiting"), started("starting"), started("queued"), started(null)]).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(runHasStarted({ status: "completed", reading: "running" })).toBe(false);
  });

  it("reads an open run by what core says its agent is doing", () => {
    expect(of("running", "queued")).toEqual({ status: "queued", label: "Queued" });
    expect(of("running", "starting")).toEqual({ status: "queued", label: "Starting" });
    expect(of("running", "running")).toEqual({ status: "running", label: "Running" });
  });

  it("reads a running run core says nothing of by its status", () => {
    expect(of("running")).toEqual({ status: "running", label: "Running" });
  });

  it("keeps a paused, finished or stopped run's own status whatever its reading", () => {
    expect(of("paused", "running")).toEqual({ status: "paused", label: "Paused" });
    expect(of("completed", "queued")).toEqual({ status: "done", label: "Completed" });
    expect(of("failed", "starting")).toEqual({ status: "failed", label: "Failed" });
    expect(of("cancelled")).toEqual({ status: "blocked", label: "Stopped" });
  });
});

