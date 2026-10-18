import { describe, expect, it } from "vitest";
import { aggregateStepCosts, drawerRunChip, median, runGateNote, runSummaryReading } from "./derive";
import type { PipelineRunAttempt, PipelineRunStatus, RunGateCondition, StepDurationRow } from "./types";

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

const att = (status: string) => ({ status }) as PipelineRunAttempt;
const NO_JOBS = { attempts: [], lastSessionBeatAt: null };
const runOf = (status: PipelineRunStatus, attempts: PipelineRunAttempt[] = [], beat: string | null = null) => ({
  status,
  attempts,
  lastSessionBeatAt: beat,
});

describe("runSummaryReading — what the run summary alone says its agent is doing (ISS-1297)", () => {
  it("reads a queued job nothing has claimed as queued", () => {
    expect(runSummaryReading({ attempts: [att("queued")], lastSessionBeatAt: null })).toBe("queued");
  });
  it("reads a job handed to a runner, or running, as running", () => {
    expect(runSummaryReading({ attempts: [att("dispatched")], lastSessionBeatAt: null })).toBe("running");
    expect(runSummaryReading({ attempts: [att("running")], lastSessionBeatAt: null })).toBe("running");
  });
  it("lets a started job outrank a queued one beside it, in either order", () => {
    expect(runSummaryReading({ attempts: [att("queued"), att("running")], lastSessionBeatAt: null })).toBe("running");
    expect(runSummaryReading({ attempts: [att("running"), att("queued")], lastSessionBeatAt: null })).toBe("running");
  });
  it("lets a session beat outrank a job row still reading queued", () => {
    expect(runSummaryReading({ attempts: [att("queued")], lastSessionBeatAt: "2026-09-05T14:20:00Z" })).toBe("running");
  });
  it("reads a queued retry behind finished attempts as queued, and says nothing where no job is live", () => {
    expect(runSummaryReading({ attempts: [att("failed"), att("queued")], lastSessionBeatAt: null })).toBe("queued");
    expect(runSummaryReading({ attempts: [att("failed"), att("done")], lastSessionBeatAt: null })).toBeNull();
    expect(runSummaryReading(NO_JOBS)).toBeNull();
  });
});

describe("drawerRunChip — one header reading whichever screen opens the drawer (ISS-1277, ISS-1297)", () => {
  it("shows a queued step under a running run as queued", () => {
    expect(drawerRunChip(runOf("running"), "queued")).toBe("queued");
  });
  it("shows a running step under a running run as running", () => {
    expect(drawerRunChip(runOf("running"), "running")).toBe("running");
  });
  it("keeps the run's own status when neither the issue's reading nor the summary says otherwise", () => {
    expect(drawerRunChip(runOf("running"), null)).toBe("running");
    expect(drawerRunChip(runOf("running"), "done")).toBe("running");
    expect(drawerRunChip(runOf("running"), "failed")).toBe("running");
  });
  it("reads the summary where there is no issue row: the same chip the board gives that run", () => {
    const queuedRun = runOf("running", [att("queued")]);
    expect(drawerRunChip(queuedRun, null)).toBe("queued");
    expect(drawerRunChip(queuedRun, "queued")).toBe(drawerRunChip(queuedRun, null));
    expect(drawerRunChip(runOf("running", [att("running")]), null)).toBe("running");
  });
  it("gives one chip for one summary whatever the issue row says beside it", () => {
    const handedOff = runOf("running", [att("dispatched")]);
    expect(drawerRunChip(handedOff, "queued")).toBe(drawerRunChip(handedOff, null));
    expect(drawerRunChip(handedOff, "queued")).toBe("running");
    const waiting = runOf("running", [att("queued")]);
    expect(drawerRunChip(waiting, "running")).toBe(drawerRunChip(waiting, null));
    expect(drawerRunChip(waiting, "running")).toBe("queued");
  });
  it("keeps a paused run paused whatever the issue's session, queued job or attempts say", () => {
    expect(drawerRunChip(runOf("paused"), "running")).toBe("paused");
    expect(drawerRunChip(runOf("paused"), "queued")).toBe("paused");
    expect(drawerRunChip(runOf("paused", [att("queued")]), null)).toBe("paused");
  });
  it("keeps a finished or cancelled run's own status", () => {
    expect(drawerRunChip(runOf("completed"), "queued")).toBe("done");
    expect(drawerRunChip(runOf("failed", [att("queued")]), null)).toBe("failed");
    expect(drawerRunChip(runOf("cancelled"), "queued")).toBe("blocked");
  });
});
