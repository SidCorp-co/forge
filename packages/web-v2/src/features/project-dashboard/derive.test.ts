import type { AttentionView } from "@/features/attention/types";
import type {
	PipelineRunListItem,
	StepDurationRow,
} from "@/features/pipeline/types";
import type { QueueStats } from "@/features/sessions/types";
import { describe, expect, it } from "vitest";
import {
	activeRuns,
	conicGradient,
	idleRuns,
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
		expect(statusDonut(undefined)).toEqual({
			segments: [],
			total: 0,
			activeStageCount: 0,
		});
		expect(statusDonut({})).toEqual({
			segments: [],
			total: 0,
			activeStageCount: 0,
		});
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
		needsReview: [
			{
				kind: "needs_review",
				title: "Review changes",
				link: "/r",
				since: "x",
				projectSlug: "p1",
				issueRef: "ISS-1",
			},
		],
		awaitingInput: [
			{
				kind: "awaiting_input",
				title: "Needs info",
				link: "/a",
				since: "x",
				projectSlug: "p2",
			},
		],
		mentions: [],
		failedJobs: [
			{
				kind: "failed_job",
				title: "code failed",
				link: "/f",
				since: "x",
				projectSlug: "p1",
				issueRef: "ISS-2",
			},
		],
		pendingSkillUpdates: [],
		// cm:why the per-project dashboard deliberately does NOT carry unseen drafts: every row it renders pairs with an action button (retry / diff / input) and "read this proposal and decide" is not one of them. The cross-project inbox and the overview digest are that bucket's surfaces.
		unseenDrafts: [],
		unseenDraftsTotal: 0,
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
	// cm:why the spine is the project's runners, so these fixtures carry no owner at all — the field the old defect keyed on is gone from the input
	const runners = [
		{ runnerId: "r1", deviceId: "d1", deviceName: "mac", platform: "macos", deviceStatus: "online", runnerStatus: "online" },
		{ runnerId: "r2", deviceId: "d2", deviceName: "lin", platform: "linux", deviceStatus: "online", runnerStatus: "online" },
		{ runnerId: "r3", deviceId: "d3", deviceName: "old", platform: "windows", deviceStatus: "revoked", runnerStatus: "online" },
		{ runnerId: "r4", deviceId: "d4", deviceName: "off", platform: "linux", deviceStatus: "offline", runnerStatus: "offline" },
	] as Parameters<typeof runnersSummary>[0];
	const queue: QueueStats = {
		devices: [
			{ deviceId: "d1", queued: 0, running: 2 },
			{ deviceId: "d2", queued: 1, running: 0 },
		],
	};

	it("counts a runner the viewer does not own", () => {
		const s = runnersSummary(
			[
				{
					runnerId: "r9",
					deviceId: "dx",
					deviceName: "forge-vm",
					platform: "linux",
					deviceStatus: "online",
					runnerStatus: "online",
				},
			] as Parameters<typeof runnersSummary>[0],
			undefined,
		);
		expect(s.total).toBe(1);
		expect(s.onlineCount).toBe(1);
		expect(s.lines[0]?.name).toBe("forge-vm");
	});

	it("drops a retired runner and never counts a draining one as online", () => {
		const s = runnersSummary(
			[
				{
					runnerId: "gone",
					deviceId: "d9",
					deviceName: "ubuntu6",
					platform: "linux",
					deviceStatus: "online",
					runnerStatus: "disabled",
				},
				{
					runnerId: "drain",
					deviceId: "d8",
					deviceName: "dev1 · CLI runner",
					platform: "linux",
					deviceStatus: "online",
					runnerStatus: "draining",
				},
			] as Parameters<typeof runnersSummary>[0],
			undefined,
		);
		expect(s.lines.map((l) => l.id)).toEqual(["drain"]);
		expect(s.total).toBe(1);
		expect(s.onlineCount).toBe(0);
		expect(s.lines[0]?.draining).toBe(true);
	});

	it("joins queue counters, drops revoked, derives busy/online", () => {
		const s = runnersSummary(runners, queue);
		expect(s.total).toBe(3); // revoked dropped
		expect(s.onlineCount).toBe(2);
		expect(s.busyCount).toBe(1); // d1 running>0
		expect(s.lines.find((l) => l.id === "r1")?.busy).toBe(true);
		expect(s.lines.find((l) => l.id === "r2")?.busy).toBe(false);
		expect(s.lines.every((l) => l.limit === null)).toBe(true);
	});

	it("reads a runner's limit off its own row", () => {
		const now = Date.parse("2026-06-22T08:00:00.000Z");
		const withLimits = [
			{
				...(runners as unknown as Record<string, unknown>[])[0],
				limitReason: "usage_limit",
				rateLimitedUntil: "2026-06-22T08:42:00.000Z",
				limitDetail: "out of extra usage",
			},
			{ ...(runners as unknown as Record<string, unknown>[])[1], limitReason: null },
		] as Parameters<typeof runnersSummary>[0];
		const s = runnersSummary(withLimits, queue, now);
		const r1 = s.lines.find((l) => l.id === "r1");
		expect(r1?.limit?.reason).toBe("usage_limit");
		expect(r1?.limit?.resetText).toBe("resets in 42m");
		expect(s.lines.find((l) => l.id === "r2")?.limit).toBeNull();
	});

	it("sources busy + active issue/stage from the live snapshot, keyed by runnerId", () => {
		const now = Date.parse("2026-06-22T08:00:00.000Z");
		const active = [
			{
				runnerId: "r1",
				name: "mac",
				status: "online",
				lastSeenAt: null,
				current: {
					jobId: "j1",
					stage: "code",
					startedAt: "2026-06-22T08:00:00.000Z",
					issueId: "i1",
					issueRef: "ISS-417",
					issueTitle: "Add export",
				},
			},
			{ runnerId: "r2", name: "lin", status: "online", lastSeenAt: null, current: null },
		] as Parameters<typeof runnersSummary>[3];
		const s = runnersSummary(runners, queue, now, active);
		const r1 = s.lines.find((l) => l.id === "r1");
		const r2 = s.lines.find((l) => l.id === "r2");
		expect(r1?.busy).toBe(true);
		expect(r1?.activeIssueRef).toBe("ISS-417");
		expect(r1?.activeStage).toBe("code");
		expect(r2?.busy).toBe(false);
		expect(r2?.activeIssueRef).toBeNull();
		expect(s.busyCount).toBe(1);
	});

	it("falls back to queue counters for busy when no active snapshot is passed", () => {
		const s = runnersSummary(runners, queue);
		expect(s.lines.find((l) => l.id === "r1")?.busy).toBe(true);
		expect(s.lines.find((l) => l.id === "r1")?.activeIssueRef).toBeNull();
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

describe("activeRuns / idleRuns — liveness comes from liveJobs, not from a step name (ISS-789)", () => {
	const run = (over: Partial<PipelineRunListItem>): PipelineRunListItem =>
		({
			id: over.id ?? "r1",
			projectId: "p1",
			issueId: null,
			issueRef: null,
			issueTitle: null,
			kind: "issue",
			status: "running",
			currentStep: "code",
			startedAt: "2026-08-11T00:00:00.000Z",
			finishedAt: null,
			cost: undefined,
			liveJobs: 0,
			...over,
		}) as unknown as PipelineRunListItem;

	it("counts a run with work on it as active", () => {
		expect(activeRuns([run({ liveJobs: 1 })])).toHaveLength(1);
	});

	// cm:guard this is the case the old `currentStep !== "tested"` guess got wrong: every park OTHER than the release gate read as live forever. getcontent measured 14 runs at status running, 3 with any live job.
	it.each(["waiting", "needs_info", "on_hold", "triage"])(
		"does NOT count a run parked at %s with no live job",
		(currentStep) => {
			const runs = [run({ currentStep, liveJobs: 0 })];
			expect(activeRuns(runs)).toHaveLength(0);
			expect(idleRuns(runs)).toHaveLength(1);
		},
	);

	it("keeps excluding the release gate, and does not report it as idle-and-stuck", () => {
		const runs = [run({ currentStep: "tested", liveJobs: 0 })];
		expect(activeRuns(runs)).toHaveLength(0);
		expect(idleRuns(runs)).toHaveLength(0);
	});

	it("ignores terminal runs entirely on both sides", () => {
		const runs = [
			run({ id: "a", status: "completed", liveJobs: 0 }),
			run({ id: "b", status: "cancelled", liveJobs: 2 }),
		];
		expect(activeRuns(runs)).toHaveLength(0);
		expect(idleRuns(runs)).toHaveLength(0);
	});

	it("splits a real mixed project cleanly — every live run lands in exactly one bucket", () => {
		const runs = [
			run({ id: "a", liveJobs: 2, currentStep: "code" }),
			run({ id: "b", liveJobs: 0, currentStep: "waiting" }),
			run({ id: "c", liveJobs: 0, currentStep: "tested" }),
			run({ id: "d", liveJobs: 1, currentStep: "review" }),
		];
		expect(activeRuns(runs).map((r) => r.id)).toEqual(["a", "d"]);
		expect(idleRuns(runs).map((r) => r.id)).toEqual(["b"]);
	});

	it("treats a payload with no liveJobs as not-active rather than guessing it is", () => {
		const stale = {
			...run({}),
			liveJobs: undefined,
		} as unknown as PipelineRunListItem;
		expect(activeRuns([stale])).toHaveLength(0);
	});
});
