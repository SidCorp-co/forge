import { ISSUE_STATUS_TONES, WORK_STEPS } from "@forge/contracts/issue-vocabulary";
import { describe, expect, it } from "vitest";
import {
	REGISTRY_ISSUE_STATUSES,
	type StatusExits,
} from "@forge/contracts/pipeline-registry";
import {
	BLOCKER_SETTLED_STATUSES,
	REASON_REQUIRED_ISSUE_STATUSES,
} from "@forge/contracts/status-sets";
import { STATUS_KEY_TONE } from "@/design/status";
import {
	allowedTransitions,
	bulkAllowedStatuses,
	canonicalIssueId,
	issueQueryKey,
	COMMENT_KIND_META,
	COMPLEXITY_LABELS,
	complexityLabel,
	creatorLabelOf,
	depCounts,
	deriveBlockerState,
	deriveCommentKind,
	filterCount,
	deriveStepOutcomes,
	runningStepOf,
	filterToQueryParams,
	groupRows,
	groupedTransitions,
	HEARTBEAT_STALE_MS,
	heartbeatState,
	initials,
	memberLabel,
	openBlockingRefs,
	PRIORITY_LABELS,
	parseChecklist,
	parkReturnTargets,
	priorityLabel,
	STATUS_LABELS,
	statusLabel,
	statusStepLabel,
	runStatusChip,
	statusToChip,
	statusToTone,
	statusesFromParam,
	transitionLabels,
} from "./derive";
import type { ParkReading } from "./derive";
import type {
	IssueDependencies,
	IssuePark,
	IssueDependencyEdge,
	IssueDetail,
	IssueRow,
	PipelineHealth,
	StepDurationRow,
	StepHandoffRow,
} from "./types";
import { ISSUE_COMPLEXITIES, ISSUE_PRIORITIES, ISSUE_STATUSES } from "./types";

function row(over: Partial<IssueRow> & { id: string }): IssueRow {
	return {
		id: over.id,
		projectId: over.projectId ?? "p1",
		issSeq: over.issSeq ?? 1,
		displayId: over.displayId ?? `ISS-${over.issSeq ?? 1}`,
		title: over.title ?? "Title",
		status: over.status ?? "open",
		priority: over.priority ?? "none",
		category: over.category ?? null,
		complexity: over.complexity ?? null,
		assigneeId: over.assigneeId ?? null,
		createdById: over.createdById ?? "owner-1",
		creatorEmail: over.creatorEmail ?? "owner@example.com",
		creatorIsAgent: over.creatorIsAgent ?? false,
		creatorLabel: over.creatorLabel ?? "owner@example.com",
		reopenCount: over.reopenCount ?? 0,
		mergedAt: over.mergedAt ?? null,
		createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
		updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z",
		agentSessions: over.agentSessions,
		agentStatus: over.agentStatus,
	};
}

describe("runStatusChip — the run's state, never the issue's", () => {
	const queuedJob = {
		stage: "open",
		queuedStep: { jobId: "j1", jobType: "drive", stageStatus: null, queuedAt: "2026-09-05T14:16:00Z", retryAfterAt: null },
	};
	it("maps each session state the API sends to its own session key", () => {
		expect(runStatusChip({ agentStatus: "running" })).toBe("running");
		expect(runStatusChip({ agentStatus: "queued" })).toBe("queued");
		expect(runStatusChip({ agentStatus: "completed" })).toBe("done");
		expect(runStatusChip({ agentStatus: "failed" })).toBe("failed");
	});
	it("reads a job queued before any session exists as a queued run (ISS-1277)", () => {
		expect(runStatusChip({ agentStatus: null, pipelineHealth: queuedJob })).toBe("queued");
	});
	it("reads a job queued behind a finished session as queued, not the old outcome", () => {
		expect(runStatusChip({ agentStatus: "failed", pipelineHealth: queuedJob })).toBe("queued");
		expect(runStatusChip({ agentStatus: "completed", pipelineHealth: queuedJob })).toBe("queued");
	});
	it("lets a running session outrank a queued job", () => {
		expect(runStatusChip({ agentStatus: "running", pipelineHealth: queuedJob })).toBe("running");
	});
	it("shows no chip when neither the sessions nor the pipeline say a run exists", () => {
		expect(runStatusChip({ agentStatus: null })).toBeNull();
		expect(runStatusChip({})).toBeNull();
		expect(runStatusChip({ agentStatus: null, pipelineHealth: { stage: "open" } })).toBeNull();
	});
});

describe("statusToChip", () => {
	it("reads the issue's status alone, so an open issue is not drawn as its run", () => {
		expect(statusToChip("open")).toBe("queued");
		expect(statusToChip("in_progress")).toBe("running");
	});
	it("draws each status in the badge legend's tone", () => {
		expect(statusToChip("draft")).toBe("queued");
		expect(statusToChip("approved")).toBe("passed");
		expect(statusToChip("needs_info")).toBe("waiting");
		expect(statusToChip("awaiting_release")).toBe("waiting");
		expect(statusToChip("on_hold")).toBe("queued");
		expect(statusToChip("reopen")).toBe("failed");
	});
	it("draws the two ways an issue ends alike, apart from every status still moving", () => {
		expect(statusToChip("closed")).toBe("archived");
		expect(statusToChip("dropped")).toBe("archived");
		for (const s of ISSUE_STATUSES.filter((x) => x !== "closed" && x !== "dropped")) {
			expect(statusToChip(s), s).not.toBe("archived");
		}
	});
	it("gives statuses of one tone one chip, and statuses of different tones different chips", () => {
		for (const a of ISSUE_STATUSES) {
			for (const b of ISSUE_STATUSES) {
				const sameTone = ISSUE_STATUS_TONES[a] === ISSUE_STATUS_TONES[b];
				expect(statusToChip(a) === statusToChip(b), `${a} / ${b}`).toBe(sameTone);
			}
		}
	});
	it("folds three statuses onto queued, which is why the label is separate", () => {
		const folded = ["draft", "open", "on_hold"] as const;
		for (const s of folded) {
			expect(statusToChip(s)).toBe("queued");
		}
		expect(new Set(folded.map(statusLabel)).size).toBe(folded.length);
	});
});

describe("statusStepLabel — the run's step on an in_progress chip", () => {
	it("names the step after the status where in_progress has one", () => {
		expect(statusStepLabel("in_progress", "test")).toBe("In progress · Test");
		expect(statusStepLabel("in_progress", "triage")).toBe("In progress · Triage");
	});
	it("reads the status alone where the work state names no step", () => {
		expect(statusStepLabel("in_progress", null)).toBe("In progress");
		expect(statusStepLabel("in_progress", undefined)).toBe("In progress");
	});
	it("never adds a step to any other status, whatever the work state says", () => {
		for (const s of ISSUE_STATUSES.filter((x) => x !== "in_progress")) {
			for (const step of WORK_STEPS) {
				expect(statusStepLabel(s, step), `${s} at ${step}`).toBe(statusLabel(s));
			}
		}
	});
	it("gives every step its own word", () => {
		const words = WORK_STEPS.map((step) => statusStepLabel("in_progress", step));
		expect(new Set(words).size).toBe(WORK_STEPS.length);
	});
});

describe("statusToTone (ISS-509 — chip↔dashboard color consistency)", () => {
	it("is total over every IssueStatus", () => {
		for (const s of ISSUE_STATUSES) {
			expect(statusToTone(s), s).toBeDefined();
		}
	});

	it("equals the tone of the status's chip (so chip + dashboard agree)", () => {
		for (const s of ISSUE_STATUSES) {
			expect(statusToTone(s), s).toBe(STATUS_KEY_TONE[statusToChip(s)]);
		}
	});

	it("resolves only a reopened issue — one that came back — to the failure tone", () => {
		expect(ISSUE_STATUSES.filter((s) => statusToTone(s) === "failure")).toEqual(["reopen"]);
	});

	it("reads the statuses a person owes in the attention tone", () => {
		expect(statusToTone("needs_info")).toBe("attention");
		expect(statusToTone("awaiting_release")).toBe("attention");
		expect(statusToTone("in_progress")).toBe("active");
	});
});

/** The legal moves of workflow `issue-lifecycle` rev 2, as core's exits table serves them: a park's
 *  way back to the status it left is not in it (`parkReturnTargets` adds it). */
const EXITS = {
	draft: ["open", "dropped"],
	open: ["in_progress", "needs_info", "on_hold", "dropped"],
	reopen: ["in_progress", "needs_info", "on_hold", "dropped"],
	in_progress: ["approved", "awaiting_release", "closed", "needs_info", "on_hold", "dropped"],
	approved: ["in_progress", "needs_info", "on_hold", "dropped"],
	awaiting_release: ["closed", "reopen", "needs_info", "on_hold", "dropped"],
	needs_info: ["on_hold", "dropped"],
	on_hold: ["needs_info", "dropped"],
	closed: ["reopen"],
	dropped: [],
} satisfies StatusExits;

describe("allowedTransitions", () => {
	it("offers a closed issue the one move it has", () => {
		expect(allowedTransitions(EXITS, "closed")).toEqual(["reopen"]);
	});

	it("offers a dropped issue nothing", () => {
		expect(allowedTransitions(EXITS, "dropped")).toEqual([]);
	});

	it("offers only statuses the lifecycle has, from every status it is given", () => {
		const known = new Set<string>(ISSUE_STATUSES);
		for (const from of Object.keys(EXITS) as (keyof typeof EXITS)[]) {
			for (const to of allowedTransitions(EXITS, from)) expect(known.has(to), `${from} -> ${to}`).toBe(true);
		}
	});

	it("returns the row in the order core declared it", () => {
		expect(allowedTransitions(EXITS, "awaiting_release")).toEqual([
			"closed",
			"reopen",
			"needs_info",
			"on_hold",
			"dropped",
		]);
	});

	it("restricts draft to accepting it as work or dropping it", () => {
		expect(allowedTransitions(EXITS, "draft")).toEqual(["open", "dropped"]);
	});

	it("offers nothing at all while the exits are unread", () => {
		expect(allowedTransitions(undefined, "open")).toEqual([]);
		expect(allowedTransitions({}, "open")).toEqual([]);
		expect(allowedTransitions(undefined, "needs_info", "in_progress")).toEqual([]);
	});

	it("returns a park first to the status it left, and to no other working status", () => {
		expect(allowedTransitions(EXITS, "needs_info", "awaiting_release")).toEqual([
			"awaiting_release",
			"on_hold",
			"dropped",
		]);
		expect(allowedTransitions(EXITS, "on_hold", "approved")).toEqual(["approved", "needs_info", "dropped"]);
	});

	it("offers every parkable status from a park whose left status nothing recorded", () => {
		expect(allowedTransitions(EXITS, "on_hold", null)).toEqual([
			"open",
			"reopen",
			"in_progress",
			"approved",
			"awaiting_release",
			"needs_info",
			"dropped",
		]);
		expect(parkReturnTargets("needs_info", undefined)).not.toContain("draft");
		expect(parkReturnTargets("needs_info", undefined)).not.toContain("closed");
	});

	it("adds no way back to a status that is not a park, whatever left status it is handed", () => {
		for (const from of ISSUE_STATUSES.filter((s) => s !== "needs_info" && s !== "on_hold")) {
			expect(parkReturnTargets(from, "in_progress"), from).toEqual([]);
			expect(allowedTransitions(EXITS, from, "in_progress")).toEqual(allowedTransitions(EXITS, from));
		}
	});
});

describe("groupedTransitions (ISS-982)", () => {
	it("puts the forward move first", () => {
		expect(groupedTransitions(EXITS, "open")[0]).toEqual({
			to: "in_progress",
			kind: "forward",
			startsGroup: false,
		});
	});

	it("orders the groups forward, then bounce, then discard", () => {
		expect(groupedTransitions(EXITS, "in_progress").map((g) => g.to)).toEqual([
			"approved",
			"awaiting_release",
			"needs_info",
			"on_hold",
			"closed",
			"dropped",
		]);
	});

	it("keeps each group in the order core declared it, not in any order of its own", () => {
		const reordered = { ...EXITS, in_progress: ["awaiting_release", "on_hold", "approved", "dropped", "needs_info", "closed"] } satisfies StatusExits;
		expect(groupedTransitions(reordered, "in_progress").map((g) => g.to)).toEqual([
			"awaiting_release",
			"approved",
			"on_hold",
			"needs_info",
			"dropped",
			"closed",
		]);
	});

	it("marks the three bounce targets as bounces", () => {
		const byTo = new Map(groupedTransitions(EXITS, "awaiting_release").map((g) => [g.to, g.kind]));
		expect(byTo.get("needs_info")).toBe("bounce");
		expect(byTo.get("on_hold")).toBe("bounce");
		expect(byTo.get("reopen")).toBe("bounce");
	});

	it("marks the two discard targets as discards", () => {
		const byTo = new Map(groupedTransitions(EXITS, "in_progress").map((g) => [g.to, g.kind]));
		expect(byTo.get("closed")).toBe("discard");
		expect(byTo.get("dropped")).toBe("discard");
	});

	it("does not file awaiting_release's close under the discards", () => {
		expect(groupedTransitions(EXITS, "awaiting_release")[0]).toEqual({
			to: "closed",
			kind: "forward",
			startsGroup: false,
		});
	});

	it("starts a group at the first item of each kind after the first", () => {
		const g = groupedTransitions(EXITS, "in_progress");
		expect(g.filter((x) => x.startsGroup).map((x) => x.to)).toEqual(["needs_info", "closed"]);
	});

	it("never starts a group on the very first item", () => {
		for (const from of Object.keys(EXITS) as (keyof typeof EXITS)[]) {
			const g = groupedTransitions(EXITS, from);
			if (g.length > 0) expect(g[0].startsGroup).toBe(false);
		}
	});

	it("files a park's way back as forward, even a way back to reopen", () => {
		const g = groupedTransitions(EXITS, "on_hold", null);
		expect(g.filter((x) => x.kind === "forward").map((x) => x.to)).toEqual([
			"open",
			"reopen",
			"in_progress",
			"approved",
			"awaiting_release",
		]);
		expect(g.find((x) => x.to === "needs_info")?.kind).toBe("bounce");
	});

	it("groups nothing when the exits are unread", () => {
		expect(groupedTransitions(undefined, "open")).toEqual([]);
	});
});

describe("bulkAllowedStatuses (ISS-463)", () => {
	it("returns [] for an empty selection", () => {
		expect(bulkAllowedStatuses(EXITS, [])).toEqual([]);
	});
	it("matches allowedTransitions when every row shares a status, less the reason-required three", () => {
		const rows = [
			row({ id: "a", status: "approved" }),
			row({ id: "b", status: "approved" }),
		];
		expect(bulkAllowedStatuses(EXITS, rows)).toEqual(
			allowedTransitions(EXITS, "approved").filter(
				(s) => !(REASON_REQUIRED_ISSUE_STATUSES as readonly string[]).includes(s),
			),
		);
	});
	it("omits exactly the targets the shared reason-required answer names, whatever it grows to", () => {
		const rows = [row({ id: "a", status: "in_progress" })];
		const all = allowedTransitions(EXITS, "in_progress");
		const offered = bulkAllowedStatuses(EXITS, rows);
		expect(all.filter((s) => !offered.includes(s))).toEqual(
			all.filter((s) => (REASON_REQUIRED_ISSUE_STATUSES as readonly string[]).includes(s)),
		);
	});
	it("never offers a status that requires an authored reason", () => {
		const rows = [
			row({ id: "a", status: "in_progress" }),
			row({ id: "b", status: "awaiting_release" }),
		];
		const result = bulkAllowedStatuses(EXITS, rows);
		expect(result).not.toContain("needs_info");
		expect(result).not.toContain("reopen");
		expect(result).not.toContain("on_hold");
		expect(result).not.toContain("dropped");
		expect(result).toEqual(["closed"]);
	});
	it("intersects allowed targets across mixed statuses", () => {
		const rows = [
			row({ id: "a", status: "open" }),
			row({ id: "b", status: "approved" }),
		];
		const result = bulkAllowedStatuses(EXITS, rows);
		for (const s of result) {
			expect(allowedTransitions(EXITS, "open")).toContain(s);
			expect(allowedTransitions(EXITS, "approved")).toContain(s);
		}
		expect(result).toEqual(["in_progress"]);
	});
	it("keeps the first selected row's declared order, not the enum's", () => {
		const exits = { ...EXITS, reopen: ["closed", "awaiting_release", "approved"] } satisfies StatusExits;
		const rows = [
			row({ id: "a", status: "in_progress" }),
			row({ id: "b", status: "reopen" }),
		];
		expect(bulkAllowedStatuses(exits, rows)).toEqual(["approved", "awaiting_release", "closed"]);
	});
	it("narrows to nothing when a terminal row is in the mix", () => {
		const rows = [
			row({ id: "a", status: "dropped" }),
			row({ id: "b", status: "approved" }),
		];
		expect(bulkAllowedStatuses(EXITS, rows)).toEqual([]);
	});
	it("narrows to nothing when a draft row is in the mix (a draft's two exits bound the whole selection)", () => {
		const rows = [
			row({ id: "a", status: "draft" }),
			row({ id: "b", status: "approved" }),
		];
		expect(bulkAllowedStatuses(EXITS, rows)).toEqual([]);
	});
	it("offers nothing while the exits are unread", () => {
		const rows = [row({ id: "a", status: "open" })];
		expect(bulkAllowedStatuses(undefined, rows)).toEqual([]);
	});
});

describe("label helpers", () => {
	it("humanizes status / priority / complexity (no raw enum leaks)", () => {
		expect(statusLabel("in_progress")).toBe("In progress");
		expect(statusLabel("needs_info")).toBe("Needs info");
		expect(statusLabel("reopen")).toBe("Reopened");
		expect(statusLabel("awaiting_release")).toBe("Awaiting release");
		expect(priorityLabel("critical")).toBe("Critical");
		expect(complexityLabel("xs")).toBe("XS");
		expect(complexityLabel("m")).toBe("Medium");
	});
	it("labels a deliberate pause as on hold, never as needing information", () => {
		expect(statusLabel("on_hold")).toBe("On hold");
		expect(statusLabel("on_hold")).not.toBe(statusLabel("needs_info"));
	});
	it("names each move target by its own status word", () => {
		expect(transitionLabels(["in_progress", "approved", "awaiting_release"])).toEqual([
			"In progress",
			"Approved",
			"Awaiting release",
		]);
		expect(transitionLabels([...ISSUE_STATUSES])).toEqual(ISSUE_STATUSES.map(statusLabel));
	});
	it("keeps ten distinct status words, one per status", () => {
		expect(new Set(ISSUE_STATUSES.map(statusLabel)).size).toBe(ISSUE_STATUSES.length);
	});

	it("renders an em dash for an absent complexity", () => {
		expect(complexityLabel(null)).toBe("—");
		expect(complexityLabel(undefined)).toBe("—");
	});
	it("covers every enum value (label maps stay in lockstep with the unions)", () => {
		for (const s of ISSUE_STATUSES) expect(STATUS_LABELS[s]).toBeTruthy();
		for (const p of ISSUE_PRIORITIES) expect(PRIORITY_LABELS[p]).toBeTruthy();
		for (const c of ISSUE_COMPLEXITIES)
			expect(COMPLEXITY_LABELS[c]).toBeTruthy();
	});

	it("labels every one of the kernel's statuses and invents none of its own", () => {
		expect(Object.keys(STATUS_LABELS).sort()).toEqual(
			[...REGISTRY_ISSUE_STATUSES].sort(),
		);
		expect(REGISTRY_ISSUE_STATUSES).toHaveLength(10);
	});
});

describe("depCounts", () => {
	const id = "i1";
	const deps: IssueDependencies = {
		outgoing: [
			{
				id: "e1",
				fromIssueId: id,
				toIssueId: "i2",
				kind: "blocks",
				reason: null,
				createdAt: "",
				expired: false,
			},
			{
				id: "e2",
				fromIssueId: id,
				toIssueId: "i3",
				kind: "relates",
				reason: null,
				createdAt: "",
				expired: false,
			},
		],
		incoming: [
			{
				id: "e3",
				fromIssueId: "i4",
				toIssueId: id,
				kind: "blocks",
				reason: null,
				createdAt: "",
				expired: false,
			},
		],
	};
	it("counts blocks edges by direction, ignoring other kinds", () => {
		expect(depCounts(deps)).toEqual({
			blockedBy: 1,
			blocks: 1,
			subtasks: 0,
			hasParent: false,
		});
	});
	it("returns zeros when undefined", () => {
		expect(depCounts(undefined)).toEqual({
			blockedBy: 0,
			blocks: 0,
			subtasks: 0,
			hasParent: false,
		});
	});
	it("counts outgoing decomposes as subtasks (this issue is the epic)", () => {
		const epic: IssueDependencies = {
			outgoing: [
				{
					id: "d1",
					fromIssueId: id,
					toIssueId: "c1",
					kind: "decomposes",
					reason: null,
					createdAt: "",
					expired: false,
				},
				{
					id: "d2",
					fromIssueId: id,
					toIssueId: "c2",
					kind: "decomposes",
					reason: null,
					createdAt: "",
					expired: false,
				},
				{
					id: "b1",
					fromIssueId: id,
					toIssueId: "x1",
					kind: "blocks",
					reason: null,
					createdAt: "",
					expired: false,
				},
			],
			incoming: [],
		};
		expect(depCounts(epic)).toEqual({
			blockedBy: 0,
			blocks: 1,
			subtasks: 2,
			hasParent: false,
		});
	});
	it("flags incoming decomposes as hasParent (this issue is a subtask)", () => {
		const child: IssueDependencies = {
			outgoing: [],
			incoming: [
				{
					id: "p1",
					fromIssueId: "epic",
					toIssueId: id,
					kind: "decomposes",
					reason: null,
					createdAt: "",
					expired: false,
				},
			],
		};
		expect(depCounts(child)).toEqual({
			blockedBy: 0,
			blocks: 0,
			subtasks: 0,
			hasParent: true,
		});
	});
	it("treats the legacy parent kind like decomposes", () => {
		const legacy: IssueDependencies = {
			outgoing: [
				{
					id: "p2",
					fromIssueId: id,
					toIssueId: "c3",
					kind: "parent",
					reason: null,
					createdAt: "",
					expired: false,
				},
			],
			incoming: [
				{
					id: "p3",
					fromIssueId: "epic",
					toIssueId: id,
					kind: "parent",
					reason: null,
					createdAt: "",
					expired: false,
				},
			],
		};
		expect(depCounts(legacy)).toEqual({
			blockedBy: 0,
			blocks: 0,
			subtasks: 1,
			hasParent: true,
		});
	});
});

describe("filterToQueryParams — the toolbar's status segment", () => {
	it("all applies no filter, so drafts and closed work stay reachable (ISS-360)", () => {
		expect(filterToQueryParams("all")).toEqual({});
	});
	it("closed is closed and dropped only — the release gate is not finished work", () => {
		expect(filterToQueryParams("closed")).toEqual({ status: ["closed", "dropped"] });
	});
	it("open is exactly every status closed does not name", () => {
		expect(filterToQueryParams("open")).toEqual({ statusNot: ["closed", "dropped"] });
	});
	it("counts open and closed so they sum to all", () => {
		const buckets = { byStatus: { open: 2, awaiting_release: 1, closed: 4, dropped: 1 } };
		expect(filterCount("all", buckets)).toBe(8);
		expect(filterCount("closed", buckets)).toBe(5);
		expect(filterCount("open", buckets)).toBe(3);
	});
});

describe("groupRows", () => {
	const rows = [
		row({
			id: "a",
			status: "open",
			priority: "high",
			createdById: "u1",
			creatorLabel: "ann@x.co",
		}),
		row({
			id: "b",
			status: "open",
			priority: "low",
			createdById: "u2",
			creatorLabel: "bob@x.co",
		}),
		row({
			id: "c",
			status: "awaiting_release",
			priority: "high",
			createdById: "u1",
			creatorLabel: "ann@x.co",
		}),
	];
	it("returns a single group for none", () => {
		const g = groupRows(rows, "none");
		expect(g).toHaveLength(1);
		expect(g[0].rows).toHaveLength(3);
	});
	it("groups by status preserving server order", () => {
		const g = groupRows(rows, "status");
		expect(g.map((x) => x.key)).toEqual(["open", "awaiting_release"]);
		expect(g[0].rows.map((r) => r.id)).toEqual(["a", "b"]);
	});
	// ISS-1137 — an agent is an account with a name, so two agents are two
	// groups. The old shape collapsed every agent into one `__agent__` bucket,
	// which is the case a single-agent fixture cannot tell apart from this one.
	it("groups by creator, one group per account, agents after people", () => {
		const mixed = [
			...rows,
			row({
				id: "d",
				createdById: "a1",
				creatorIsAgent: true,
				creatorLabel: "master",
			}),
			row({
				id: "e",
				createdById: "a2",
				creatorIsAgent: true,
				creatorLabel: "reviewer",
			}),
		];
		const g = groupRows(mixed, "creator");
		expect(g.map((x) => x.key)).toEqual(["u1", "u2", "a1", "a2"]);
		expect(g.map((x) => x.label)).toEqual([
			"ann@x.co",
			"bob@x.co",
			"master",
			"reviewer",
		]);
	});
});

describe("memberLabel / initials", () => {
	it("resolves member email or falls back to a short id", () => {
		expect(memberLabel("u1", [{ userId: "u1", email: "bob@x.co" }])).toBe(
			"bob@x.co",
		);
		expect(memberLabel("abcdef1234", [])).toBe("abcdef12");
		expect(memberLabel(null)).toBe("Unassigned");
	});
	it("derives two-letter initials", () => {
		expect(initials("ann.smith@x.co")).toBe("AS");
		expect(initials("bob@x.co")).toBe("BO");
	});
});

describe("creatorLabelOf", () => {
	it("prefers the server-provided creatorLabel", () => {
		expect(
			creatorLabelOf({
				creatorLabel: "ann@x.co",
				creatorEmail: "ann@x.co",
			}),
		).toBe("ann@x.co");
	});
	it("falls back to the address when the server sent no label", () => {
		expect(
			creatorLabelOf({
				creatorLabel: "",
				creatorEmail: "master@agents.local",
			}),
		).toBe("master@agents.local");
	});
	it("never falls back to a raw id — 'Unknown user' when nothing resolves", () => {
		expect(
			creatorLabelOf({
				creatorLabel: "",
				creatorEmail: null,
			}),
		).toBe("Unknown user");
	});
});

describe("parseChecklist", () => {
	it("returns [] for empty/nullish", () => {
		expect(parseChecklist(null)).toEqual([]);
		expect(parseChecklist("")).toEqual([]);
	});
	it("parses task syntax with checked state", () => {
		expect(parseChecklist("- [ ] do a\n- [x] did b")).toEqual([
			{ text: "do a", checked: false },
			{ text: "did b", checked: true },
		]);
	});
	it("treats bullets + bare lines as unchecked, drops headings/blanks", () => {
		expect(parseChecklist("## AC\n- one\n\nplain line")).toEqual([
			{ text: "one", checked: false },
			{ text: "plain line", checked: false },
		]);
	});
});

describe("deriveCommentKind", () => {
	const cases: [string, string][] = [
		["## Triage\nlooks good", "triage"],
		["REQUEST CHANGES: fix the thing", "changes"],
		["Verdict: APPROVE", "approved"],
		["forge-fix applied the patch", "fix"],
		["## QA Test Report\nall green", "qa"],
		["Released v1.2.0 to prod", "released"],
		["forge-code complete; pushed ISS-1 branch", "code"],
		["Plan written and ready for review", "plan"],
		["Just a normal note here", "comment"],
	];
	it.each(cases)("classifies %j as %s", (body, kind) => {
		expect(deriveCommentKind({ body })).toEqual({ kind, form: "prefix" });
	});
	it("has badge meta for every kind it returns", () => {
		for (const [, kind] of cases) {
			expect(
				COMMENT_KIND_META[kind as keyof typeof COMMENT_KIND_META],
			).toBeDefined();
		}
	});

	it("classifies a stored component body by its prose, not by its markup", () => {
		expect(
			deriveCommentKind({
				body: "<forge-symptom><forge-opening><p>Plan written</p></forge-opening></forge-symptom>",
			}),
		).toEqual({ kind: "plan", form: "prefix" });
	});
});


function readPark(over: Partial<IssuePark> = {}): ParkReading {
	return {
		state: "ready",
		park: {
			shape: "park",
			status: "needs_info",
			owes: "information",
			since: null,
			reason: null,
			resume: { at: null, why: "no park record" },
			record: null,
			readings: [],
			answer: null,
			openQuestionIds: [],
			...over,
		},
	};
}

function blockerIssue(
	over: Partial<Pick<IssueDetail, "status">> = {},
): Pick<IssueDetail, "status"> {
	return {
		status: over.status ?? "in_progress",
	};
}

function incomingBlocks(
	over: Partial<IssueDependencyEdge> = {},
): IssueDependencies {
	const edge: IssueDependencyEdge = {
		id: over.id ?? "e1",
		fromIssueId: over.fromIssueId ?? "blk-1",
		toIssueId: over.toIssueId ?? "me",
		kind: "blocks",
		reason: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		expired: over.expired ?? false,
		fromDisplayId: over.fromDisplayId ?? "ISS-9",
		fromTitle: over.fromTitle ?? "Blocker",
		fromStatus: over.fromStatus ?? "in_progress",
	};
	return { incoming: [edge], outgoing: [] };
}

describe("heartbeatState", () => {
	const now = Date.parse("2026-06-04T12:00:00.000Z");
	it("returns unknown when no/invalid timestamp", () => {
		expect(heartbeatState(undefined, now)).toBe("unknown");
		expect(heartbeatState(null, now)).toBe("unknown");
		expect(heartbeatState("not-a-date", now)).toBe("unknown");
	});
	it("alive within the stale window, stale beyond it", () => {
		expect(heartbeatState(new Date(now - 30_000).toISOString(), now)).toBe(
			"alive",
		);
		expect(
			heartbeatState(
				new Date(now - (HEARTBEAT_STALE_MS + 1_000)).toISOString(),
				now,
			),
		).toBe("stale");
	});
});

describe("openBlockingRefs", () => {
	it("reports nothing for a retracted edge, whatever its blocker's status", () => {
		expect(
			openBlockingRefs(incomingBlocks({ fromStatus: "in_progress", expired: true })),
		).toEqual([]);
		expect(depCounts(incomingBlocks({ expired: true })).blockedBy).toBe(0);
	});

	it("reports a blocker core has not settled, so the row can flag it", () => {
		const refs = openBlockingRefs(incomingBlocks({ fromStatus: "in_progress" }));
		expect(refs.map((r) => r.displayId)).toEqual(["ISS-9"]);
	});

	it("reports nothing for a blocker core has already released for dispatch", () => {
		for (const status of BLOCKER_SETTLED_STATUSES) {
			expect(
				openBlockingRefs(incomingBlocks({ fromStatus: status })),
				status,
			).toEqual([]);
		}
	});

	it("flags exactly the statuses core does not count as settled", () => {
		const flagged = REGISTRY_ISSUE_STATUSES.filter(
			(s) => openBlockingRefs(incomingBlocks({ fromStatus: s })).length > 0,
		);
		expect(flagged).toEqual(
			REGISTRY_ISSUE_STATUSES.filter(
				(s) => !(BLOCKER_SETTLED_STATUSES as readonly string[]).includes(s),
			),
		);
	});
});

describe("deriveBlockerState", () => {
	it("returns null when actively progressing", () => {
		expect(
			deriveBlockerState(
				blockerIssue({ status: "in_progress" }),
				undefined,
				undefined,
			),
		).toBeNull();
		expect(
			deriveBlockerState(
				blockerIssue({ status: "reopen" }),
				undefined,
				undefined,
			),
		).toBeNull();
	});

	it("tones the gate the way its own who-line reads", () => {
		const banner = (reason: string) =>
			deriveBlockerState(
				blockerIssue({ status: "in_progress" }),
				{
					stage: "in_progress",
					waitingOn: {
						reason: reason as never,
						since: "2026-09-03T14:43:00.000Z",
						details: {},
					},
				},
				undefined,
			);
		expect(banner("runner_stale")?.tone).toBe("attention");
		expect(banner("run_not_running")?.tone).toBe("attention");
		expect(banner("retry_cooldown")?.tone).toBe("info");
	});

	it("names a gate whose reason this build has no copy for", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "in_progress" }),
			{
				stage: "in_progress",
				waitingOn: {
					reason: "gate_added_after_this_build" as never,
					since: "2026-09-03T14:43:00.000Z",
					details: {},
				},
			},
			undefined,
		);
		expect(b?.reason).toMatch(/does not recognise/);
		expect(b?.whoMustAct).toMatch(/pipeline view/);
		expect(b?.cta.kind).toBe("none");
		expect(b?.tone).toBe("attention");
	});

	it("needs_info with its park read sends the reader to the question below", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "needs_info" }),
			undefined,
			undefined,
			readPark({ status: "needs_info", reason: "Which tenant?" }),
		);
		expect(b?.cta.kind).toBe("provide-info");
		expect(b?.reason).toMatch(/information/);
		expect(b?.whoMustAct).toMatch(/is below/);
		expect(b?.whoMustAct).not.toMatch(/comment/i);
	});

	describe("a park names what the person owes, and never requests approved (ISS-1310)", () => {
		it("names a decision and resumes at the status the park left — sid-desk ISS-529's shape", () => {
			const b = deriveBlockerState(
				blockerIssue({ status: "needs_info" }),
				{ stage: "needs_info", waitingCause: { kind: "needs_decision" } },
				undefined,
				readPark({ status: "needs_info", owes: "decision", resume: { at: "awaiting_release", recordId: null } }),
			);
			expect(b?.reason).toContain("a decision");
			expect(b?.cta).toEqual({ label: "Resume at Awaiting release", kind: "resume-park" });
			expect(b?.resumeAt).toBe("awaiting_release");
		});

		it("names a resource in words a person reads", () => {
			const b = deriveBlockerState(
				blockerIssue({ status: "needs_info" }),
				undefined,
				undefined,
				readPark({ status: "needs_info", owes: "resource", resume: { at: "in_progress", recordId: "c1" }, openQuestionIds: ["q1"] }),
			);
			expect(b?.reason).toContain("only a person can supply");
			expect(b?.reason).not.toMatch(/needs_resource|needs_info/);
			expect(b?.cta.kind).toBe("provide-info");
		});

		it("offers no move it cannot back where nothing says which status the park left", () => {
			const b = deriveBlockerState(
				blockerIssue({ status: "needs_info" }),
				undefined,
				undefined,
				readPark({ status: "needs_info", owes: "decision", resume: { at: null, why: "no left status" } }),
			);
			expect(b?.reason).toContain("a decision");
			expect(b?.cta.kind).toBe("none");
			expect(b?.resumeAt).toBeUndefined();
			expect(b?.detail).toMatch(/Move anyway/);
		});

		it("says a thread question is answered and resumes where the work stopped, once a person replied", () => {
			const b = deriveBlockerState(
				blockerIssue({ status: "needs_info" }),
				undefined,
				undefined,
				readPark({
					status: "needs_info",
					reason: "Which tenant?",
					resume: { at: "in_progress", recordId: "c1" },
					answer: { commentId: "a1", postedAt: "2026-09-30T00:00:00.000Z", text: "tenant B" },
				}),
			);
			expect(b?.reason).toMatch(/has an answer/);
			expect(b?.cta).toEqual({ label: "Resume at In progress", kind: "resume-park" });
			expect(b?.resumeAt).toBe("in_progress");
		});

		it("speaks no kernel word — park, rung, decision round — in any banner a park can show", () => {
			const KERNEL_WORDS = /\b(park|parked|parking|rung|decision round)\b/i;
			const shapes: Array<Partial<IssuePark>> = [];
			const resumes: IssuePark["resume"][] = [{ at: "in_progress", recordId: null }, { at: null, why: "x" }];
			for (const owes of ["information", "decision", "resource"] as const) {
				for (const resume of resumes) {
					shapes.push({ status: "needs_info", owes, resume });
					shapes.push({ status: "needs_info", owes, resume, reason: "Which tenant?" });
					shapes.push({
						status: "needs_info",
						owes,
						resume,
						reason: "Which tenant?",
						answer: { commentId: "a", postedAt: "x", text: "B" },
					});
				}
			}
			for (const shape of shapes) {
				const b = deriveBlockerState(blockerIssue({ status: shape.status ?? "needs_info" }), undefined, undefined, readPark(shape));
				for (const said of [b?.reason, b?.whoMustAct, b?.cta.label, b?.detail]) {
					expect(said ?? "").not.toMatch(KERNEL_WORDS);
				}
			}
		});

		it("never requests approved from any park shape", () => {
			for (const owes of ["information", "decision", "resource"] as const) {
				for (const at of ["open", "reopen", "in_progress", "awaiting_release"] as const) {
					const b = deriveBlockerState(
						blockerIssue({ status: "needs_info" }),
						undefined,
						undefined,
						readPark({ status: "needs_info", owes, resume: { at, recordId: null } }),
					);
					expect(b?.cta.kind).not.toBe("approve");
					expect(b?.cta.label).not.toMatch(/approve/i);
				}
			}
		});

		it("says so while the park is being read, or could not be read, and offers nothing", () => {
			for (const state of ["loading", "error"] as const) {
				const b = deriveBlockerState(blockerIssue({ status: "needs_info" }), undefined, undefined, { state });
				expect(b?.tone).toBe("attention");
				expect(b?.cta.kind).toBe("none");
			}
			const failed = deriveBlockerState(blockerIssue({ status: "needs_info" }), undefined, undefined, {
				state: "error",
			});
			expect(failed?.whoMustAct).toMatch(/could not be read/);
		});
	});

	it("on_hold resumes only at the status it left, in the calm tone", () => {
		const b = deriveBlockerState(
			{ status: "on_hold", workState: { leftStatus: "in_progress" } },
			undefined,
			undefined,
		);
		expect(b?.cta).toEqual({ label: "Resume at In progress", kind: "resume-park" });
		expect(b?.resumeAt).toBe("in_progress");
		expect(b?.reason).toContain("paused");
		expect(b?.tone).toBe("info");
	});

	it("on_hold with no status it left offers no resume, and says the status menu has the moves", () => {
		for (const workState of [{ leftStatus: null }, null, undefined]) {
			const b = deriveBlockerState({ status: "on_hold", workState }, undefined, undefined);
			expect(b?.cta.kind).toBe("none");
			expect(b?.resumeAt).toBeUndefined();
			expect(b?.detail).toMatch(/status menu/);
			expect(b?.tone).toBe("info");
		}
	});

	it("never offers a reopen to resume a hold — a hold returns where it stopped", () => {
		for (const leftStatus of ["open", "approved", "awaiting_release"] as const) {
			const b = deriveBlockerState({ status: "on_hold", workState: { leftStatus } }, undefined, undefined);
			expect(b?.resumeAt).toBe(leftStatus);
		}
	});

	it("keeps the attention tone for the park that DOES ask a person", () => {
		const b = deriveBlockerState(blockerIssue({ status: "needs_info" }), undefined, undefined, readPark());
		expect(b?.tone).toBe("attention");
	});

	it("maps each pipelineHealth.waitingOn reason", () => {
		for (const reason of [
			"issue_busy",
			"run_not_running",
			"retry_cooldown",
			"runner_stale",
			"runner_too_old",
		] as const) {
			const b = deriveBlockerState(
				blockerIssue({ status: "in_progress" }),
				{ stage: "code", waitingOn: { reason, since: "x", details: {} } },
				undefined,
			);
			expect(b).not.toBeNull();
			expect(b?.reason.length).toBeGreaterThan(0);
		}
	});

	it.each(["run_not_running", "runner_stale"] as const)(
		"gives %s an action instead of reassurance",
		(reason) => {
			const b = deriveBlockerState(
				blockerIssue({ status: "in_progress" }),
				{ stage: "code", waitingOn: { reason, since: "x", details: {} } },
				undefined,
			);
			expect(b?.whoMustAct).not.toContain("No action");
		},
	);

	it("splits job_held copy on whether the hold clears itself", () => {
		const held = (holdReason: string) =>
			deriveBlockerState(
				blockerIssue({ status: "in_progress" }),
				{
					stage: "code",
					waitingOn: {
						reason: "job_held",
						since: "x",
						details: { holdReason },
					},
				},
				undefined,
			);

		const selfResuming = held("all_devices_exhausted");
		expect(selfResuming?.whoMustAct).toContain("No action");
		expect(selfResuming?.whoMustAct).toContain("resumes itself");

		const permanent = held("non_retryable_terminal");
		expect(permanent?.reason).toContain("does not clear on its own");
		expect(permanent?.whoMustAct).not.toContain("No action");
		expect(permanent?.whoMustAct).toContain("cancel the step");
	});

	it("falls back to open blocks edges with a link action", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "in_progress" }),
			undefined,
			incomingBlocks(),
		);
		expect(b?.cta.kind).toBe("open-blocker");
		expect(b?.blockingRefs?.[0]?.displayId).toBe("ISS-9");
	});

	it("ignores a blocks edge whose blocker is already released", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "in_progress" }),
			undefined,
			incomingBlocks({ fromStatus: "awaiting_release" }),
		);
		expect(b).toBeNull();
	});
});

describe("deriveStepOutcomes — the steps an issue actually ran (ISS-999)", () => {
	const handoff = (
		step: string,
		attempt: number,
		payload: Record<string, unknown>,
		over: Partial<StepHandoffRow> = {},
	): StepHandoffRow => ({
		id: `${step}-${attempt}`,
		projectId: "p1",
		issueId: "me",
		pipelineRunId: "run-1",
		kind: "handoff",
		step,
		attempt,
		payload,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	});
	const dur = (
		step: string,
		durationSeconds: number,
		costUsd: number,
		runId = "run-1",
		finishedAt = "2026-01-01T00:05:00.000Z",
	): StepDurationRow => ({
		runId,
		issueId: "me",
		projectId: "p1",
		step,
		startedAt: "2026-01-01T00:00:00.000Z",
		finishedAt,
		durationSeconds,
		costUsd,
	});

	it("lists only the steps that have a row, and never one that has not run", () => {
		const out = deriveStepOutcomes([handoff("plan", 1, { summary: "s" })], [dur("code", 10, 1)]);
		expect(out.map((o) => o.step).sort()).toEqual(["code", "plan"]);
	});

	it("returns nothing at all for an issue with no handoffs and no durations", () => {
		expect(deriveStepOutcomes([], [])).toEqual([]);
		expect(deriveStepOutcomes(undefined, undefined)).toEqual([]);
	});

	it("keeps a job type outside the seven staged names under its own name", () => {
		const out = deriveStepOutcomes([handoff("drive", 1, { outcome: "shipped it" })], []);
		expect(out.map((o) => o.step)).toEqual(["drive"]);
		expect(out[0].outcomeLabel).toBe("shipped it");
	});

	it("gives `fix` a row of its own rather than folding it onto `code`", () => {
		const out = deriveStepOutcomes(
			[handoff("code", 1, { summary: "wrote it" }), handoff("fix", 1, { summary: "patched" })],
			[],
		);
		expect(out.map((o) => o.step).sort()).toEqual(["code", "fix"]);
		expect(out.find((o) => o.step === "fix")?.outcomeLabel).toBe("patched");
	});

	it("orders by when a step last ran, not by any stage order", () => {
		const out = deriveStepOutcomes(
			[],
			[
				dur("release", 1, 0, "r1", "2026-01-03T00:00:00.000Z"),
				dur("triage", 1, 0, "r1", "2026-01-01T00:00:00.000Z"),
				dur("code", 1, 0, "r1", "2026-01-02T00:00:00.000Z"),
			],
		);
		expect(out.map((o) => o.step)).toEqual(["triage", "code", "release"]);
	});

	it("reads `running` from the active step's own name and from nothing else", () => {
		const rows = [handoff("plan", 1, {}), handoff("code", 1, {})];
		const out = deriveStepOutcomes(rows, [], { activeStep: "code" });
		expect(out.find((o) => o.step === "code")?.state).toBe("running");
		expect(out.find((o) => o.step === "plan")?.state).toBe("done");
	});

	it("reads `failed` from the failed step's own name, and it outranks running", () => {
		const out = deriveStepOutcomes([handoff("test", 1, {})], [], {
			activeStep: "test",
			failedStep: "test",
		});
		expect(out[0].state).toBe("failed");
	});

	it("leaves every step `done` when neither field names one", () => {
		const out = deriveStepOutcomes([handoff("plan", 1, {}), handoff("code", 1, {})], [], {
			activeStep: null,
			failedStep: null,
		});
		expect(out.map((o) => o.state)).toEqual(["done", "done"]);
	});

	it("pulls a short outcome label and sums duration/cost across a run's attempts", () => {
		const out = deriveStepOutcomes(
			[handoff("plan", 1, { summary: "wrote the plan" })],
			[dur("plan", 120, 0.25), dur("plan", 60, 0.1)],
		);
		expect(out[0].outcomeLabel).toBe("wrote the plan");
		expect(out[0].durationSeconds).toBe(180);
		expect(out[0].costUsd).toBeCloseTo(0.35);
		expect(out[0].handoff?.step).toBe("plan");
	});

	it("keeps the latest attempt and never throws on an empty/odd payload", () => {
		const out = deriveStepOutcomes(
			[handoff("plan", 1, {}), handoff("plan", 2, { outcome: "v2" })],
			undefined,
		);
		expect(out[0].handoff?.attempt).toBe(2);
		expect(out[0].outcomeLabel).toBe("v2");
		expect(deriveStepOutcomes([handoff("plan", 1, {})], [])[0].outcomeLabel).toBeUndefined();
	});

	it("uses a newer run's handoff instead of a prior attempt", () => {
		const old = handoff("test", 2, { result: "blocked_fixture" });
		const current = handoff("test", 1, { result: "pass" }, {
			pipelineRunId: "run-2",
			updatedAt: "2026-02-01T00:00:00.000Z",
		});
		const out = deriveStepOutcomes([old, current], []);
		expect(out[0].handoff?.pipelineRunId).toBe("run-2");
		expect(out[0].outcomeLabel).toBe("pass");
	});

	it("uses only the most-recent run's duration/cost (no double-count on reopen)", () => {
		const out = deriveStepOutcomes(
			[],
			[
				dur("plan", 100, 1.0, "run-old", "2026-01-01T00:05:00.000Z"),
				dur("plan", 200, 2.0, "run-new", "2026-02-01T00:05:00.000Z"),
			],
		);
		expect(out[0].durationSeconds).toBe(200);
		expect(out[0].costUsd).toBeCloseTo(2.0);
	});

	it("keeps a special test outcome as handoff evidence without it becoming a state", () => {
		const out = deriveStepOutcomes(
			[handoff("test", 1, { result: "blocked_fixture", resultReason: "no fixture" })],
			[],
		);
		expect(out[0].outcomeLabel).toBe("blocked_fixture");
		expect(out[0].state).toBe("done");
	});
});

describe("deriveBlockerState — ISS-853, the paused run the screen used to hide", () => {
	const pausedHealth = (
		over: Partial<NonNullable<PipelineHealth["pausedRun"]>> = {},
	): PipelineHealth => ({
		stage: "approved",
		pausedRun: {
			runId: over.runId ?? "run-1",
			pauseReason: over.pauseReason ?? null,
			kind: over.kind ?? null,
			detail: over.detail ?? null,
			resumer: over.resumer ?? "operator",
			since: over.since ?? "2026-09-06T10:00:00.000Z",
		},
	});

	it("banners an operator pause on an issue whose own status says nothing is wrong", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "approved" }),
			pausedHealth(),
			undefined,
		);
		expect(b?.tone).toBe("attention");
		expect(b?.reason).toContain("paused");
		expect(b?.cta).toEqual({ label: "Resume run", kind: "resume-run" });
		expect(b?.runId).toBe("run-1");
	});

	it("names the kind and its detail rather than saying only that something holds it", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "in_progress" }),
			pausedHealth({
				pauseReason: "stage_stalled:code",
				kind: "stage_stalled",
				detail: "code",
			}),
			undefined,
		);
		expect(b?.reason).toContain("held by a stalled stage");
		expect(b?.reason).not.toContain("stage_stalled");
		expect(b?.reason).toContain("code");
	});

	it("reads a sweeper-cleared pause differently, and offers no resume for it", () => {
		const operator = deriveBlockerState(
			blockerIssue({ status: "approved" }),
			pausedHealth(),
			undefined,
		);
		const sweeper = deriveBlockerState(
			blockerIssue({ status: "approved" }),
			pausedHealth({ resumer: "sweeper", kind: "missing_skill", detail: "open" }),
			undefined,
		);
		expect(sweeper?.reason).not.toBe(operator?.reason);
		expect(sweeper?.whoMustAct).not.toBe(operator?.whoMustAct);
		expect(sweeper?.tone).toBe("info");
		expect(sweeper?.cta.kind).toBe("none");
		expect(sweeper?.runId).toBeUndefined();
	});

	it("outranks needs_info, whose CTA would promise movement the pause forbids", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "needs_info" }),
			pausedHealth(),
			undefined,
		);
		expect(b?.cta.kind).toBe("resume-run");
	});

	it("outranks the generic run_not_running gate copy when a step is queued too", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "in_progress" }),
			{
				...pausedHealth({ kind: "stage_stalled", detail: "code" }),
				waitingOn: {
					reason: "run_not_running",
					since: "2026-09-06T10:00:00.000Z",
					details: {},
				},
			},
			undefined,
		);
		expect(b?.reason).toContain("held by a stalled stage");
		expect(b?.reason).not.toContain("stage_stalled");
		expect(b?.cta.kind).toBe("resume-run");
	});

	it("keeps the blocking refs it would have shown anyway", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "approved" }),
			pausedHealth(),
			incomingBlocks(),
		);
		expect(b?.blockingRefs?.[0]?.displayId).toBe("ISS-9");
	});
});

describe("statusesFromParam", () => {
	it("names exactly the statuses the parameter carries", () => {
		expect(statusesFromParam("approved,needs_info,on_hold")).toEqual([
			"approved",
			"needs_info",
			"on_hold",
		]);
	});

	it("drops a status the lifecycle does not have, keeping the rest", () => {
		expect(statusesFromParam("open,banana,closed")).toEqual(["open", "closed"]);
	});

	it("drops a retired status a bookmarked link still carries, rather than guessing its successor", () => {
		expect(statusesFromParam("developed,testing,in_progress")).toEqual(["in_progress"]);
		expect(statusesFromParam("waiting,tested")).toBeUndefined();
	});

	it("returns undefined where the parameter names nothing valid, leaving the tab filter in charge", () => {
		expect(statusesFromParam("banana")).toBeUndefined();
		expect(statusesFromParam("")).toBeUndefined();
		expect(statusesFromParam(null)).toBeUndefined();
	});

	it("tolerates spacing and repeats without sending a status twice", () => {
		expect(statusesFromParam(" open , open ,closed")).toEqual(["open", "closed"]);
	});
});

describe("runningStepOf — a queued session names no running step (ISS-999)", () => {
	const row = (step: string): StepHandoffRow => ({
		id: `${step}-1`,
		projectId: "p1",
		issueId: "me",
		pipelineRunId: "run-1",
		kind: "handoff",
		step,
		attempt: 1,
		payload: { summary: "first attempt" },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	});
	const health = (
		session?: { status: "queued" | "running"; skill: string },
	): PipelineHealth =>
		({
			stage: "code",
			...(session ? { activeSession: { id: "s1", ...session } } : {}),
		}) as PipelineHealth;

	it("names the skill of a session the kernel calls running", () => {
		expect(runningStepOf(health({ status: "running", skill: "drive" }))).toBe(
			"drive",
		);
	});

	it("names nothing for a session the kernel calls queued", () => {
		expect(runningStepOf(health({ status: "queued", skill: "drive" }))).toBeNull();
	});

	it("names nothing when there is no session, and survives a missing health", () => {
		expect(runningStepOf(health())).toBeNull();
		expect(runningStepOf(undefined)).toBeNull();
		expect(runningStepOf(null)).toBeNull();
	});

	it("keeps a queued step out of the outcomes the card renders", () => {
		const queued = health({ status: "queued", skill: "drive" });
		const out = deriveStepOutcomes(
			[row("drive")],
			undefined,
			{ activeStep: runningStepOf(queued), failedStep: null },
		);
		expect(out.map((o) => [o.step, o.state])).toEqual([["drive", "done"]]);
		const running = health({ status: "running", skill: "drive" });
		const live = deriveStepOutcomes(
			[row("drive")],
			undefined,
			{ activeStep: runningStepOf(running), failedStep: null },
		);
		expect(live.map((o) => [o.step, o.state])).toEqual([["drive", "running"]]);
	});
});

describe("canonicalIssueId (ISS-1160)", () => {
	const UUID = "123e4567-e89b-12d3-a456-426614174000";

	it("passes a uuid straight through, ignoring whatever the fetch answered", () => {
		expect(canonicalIssueId(UUID, "some-other-id")).toBe(UUID);
	});

	it("answers undefined for a display key until the fetch resolves — never the raw key itself", () => {
		expect(canonicalIssueId("ISS-42", undefined)).toBeUndefined();
	});

	it("resolves a display key to the fetched row's own uuid once it answers", () => {
		expect(canonicalIssueId("ISS-42", UUID)).toBe(UUID);
	});

	it("is what keeps two projects' own ISS-42 from colliding: the id passed on is project-a's row uuid, never the shared display key both rows answer to", () => {
		const projectARowId = "aaaaaaaa-0000-0000-0000-000000000000";
		const projectBRowId = "bbbbbbbb-0000-0000-0000-000000000000";
		expect(canonicalIssueId("ISS-42", projectARowId)).toBe(projectARowId);
		expect(canonicalIssueId("ISS-42", projectBRowId)).toBe(projectBRowId);
		expect(canonicalIssueId("ISS-42", projectARowId)).not.toBe(canonicalIssueId("ISS-42", projectBRowId));
	});
});

describe("issueQueryKey (ISS-1160 — codex 1a508e/F1, recheck-confirmed)", () => {
	const UUID = "123e4567-e89b-12d3-a456-426614174000";

	it("keys a uuid the same as before this issue — the shape the WS event-router invalidates by", () => {
		expect(issueQueryKey(UUID, "p1")).toEqual(["issue", UUID]);
		expect(issueQueryKey(UUID, undefined)).toEqual(["issue", UUID]);
	});

	it("keys a display key with the project too, so project A's and B's own ISS-42 are different queries", () => {
		expect(issueQueryKey("ISS-42", "project-a")).toEqual(["issue", "ISS-42", "project-a"]);
		expect(issueQueryKey("ISS-42", "project-b")).toEqual(["issue", "ISS-42", "project-b"]);
		expect(issueQueryKey("ISS-42", "project-a")).not.toEqual(issueQueryKey("ISS-42", "project-b"));
	});

	it("passes an absent id through unscoped, matching the hook's own disabled state", () => {
		expect(issueQueryKey(undefined, "p1")).toEqual(["issue", undefined]);
	});
});

// ISS-1257 — a question marks its issue and moves nothing, so the surfaces a person reads take
// the marker as well as the status.
describe("the marker that a person owes an issue an answer", () => {
	it("shows a banner on an issue in progress that a person owes an answer", () => {
		const banner = deriveBlockerState(
			blockerIssue({ status: "in_progress" }),
			undefined,
			undefined,
			readPark({ shape: "question", status: "in_progress", openQuestionIds: ["q1"], resume: { at: null, why: "not stopped" } }),
		);
		expect(banner?.tone).toBe("attention");
		expect(banner?.reason).toMatch(/information/);
		expect(banner?.cta.kind).toBe("provide-info");
	});

	it("shows no banner in progress when the park view reads nobody owes it anything", () => {
		expect(
			deriveBlockerState(blockerIssue({ status: "in_progress" }), undefined, undefined, {
				state: "ready",
				park: null,
			}),
		).toBeNull();
	});
});
