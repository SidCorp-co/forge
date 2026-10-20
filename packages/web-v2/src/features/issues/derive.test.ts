import { toAutonomousLabel } from "@forge/contracts/issue-vocabulary";
import { describe, expect, it } from "vitest";
import {
	REGISTRY_ISSUE_STATUSES,
	type StatusExits,
} from "@forge/contracts/pipeline-registry";
import {
	BLOCKER_SETTLED_STATUSES,
	BLOCKER_SHIPPED_STATUSES,
	REASON_REQUIRED_ISSUE_STATUSES,
} from "@forge/contracts/status-sets";
import {
	LABEL_WORK_STATE,
	WORK_STATE_LABELS,
	WORK_STATES,
} from "@forge/contracts/work-state";
import { STATUS_KEY_TONE } from "@/design/status";
import {
	allowedTransitions,
	BULK_SHARES_ONE_REASON,
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
	deriveRunView,
	issueSessionId,
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
	priorityLabel,
	STATUS_LABELS,
	statusLabel,
	LABEL_VIEW,
	runStatusChip,
	statusToChip,
	statusToTone,
	originFromParams,
	statusFilterFromParams,
	transitionLabels,
} from "./derive";
import type { ParkReading } from "./derive";
import type {
	IssueDependencies,
	IssuePark,
	IssueStatus,
	IssueDependencyEdge,
	IssueDetail,
	IssueRow,
	PipelineHealth,
	JournalAttempt,
	JournalRun,
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
		statusEnteredAt: over.statusEnteredAt ?? "2026-01-01T00:00:00.000Z",
		agentSessions: over.agentSessions,
		agentStatus: over.agentStatus,
		modules: over.modules,
	};
}


/** The word the board shows for a row: its lane label, held or not. */
const lane = (s: IssueStatus, held: boolean): string => LABEL_VIEW[toAutonomousLabel(s, held)].label;

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
		expect(statusToChip("approved")).toBe("queued");
		expect(statusToChip("in_progress")).toBe("running");
	});
	it("maps lifecycle status to a kit StatusKey", () => {
		expect(statusToChip("in_progress")).toBe("running");
		expect(statusToChip("waiting")).toBe("waiting");
		expect(statusToChip("tested")).toBe("passed");
		expect(statusToChip("on_hold")).toBe("paused");
	});
	it("splits the terminal/gate tail into distinct keys (ISS-511)", () => {
		expect(statusToChip("tested")).toBe("passed");
		expect(statusToChip("awaiting_release")).toBe("shipped");
		expect(statusToChip("closed")).toBe("archived");
	});
	it("folds five distinct statuses onto queued, which is why the label is separate", () => {
		const folded = ["draft", "open", "confirmed", "clarified", "approved"] as const;
		for (const s of folded) {
			expect(statusToChip(s)).toBe("queued");
		}
		const kernel = folded.map(statusLabel);
		expect(new Set(kernel).size).toBe(folded.length);
		expect(statusLabel("draft")).toMatch(/draft/i);
		// The lane word does NOT separate them, which is why it may not label a status chip.
		expect(new Set(folded.map((s) => lane(s, true))).size).toBeLessThan(folded.length);
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

	it("never resolves a benign / blocked / idle status to the failure tone", () => {
		for (const s of ISSUE_STATUSES) {
			expect(statusToTone(s), s).not.toBe("failure");
		}
	});

	it("reconciles the statuses that used to disagree across dashboards", () => {
		expect(statusToTone("reopen")).toBe("active");
		expect(statusToTone("on_hold")).toBe("blocked");
		expect(statusToTone("needs_info")).toBe("attention");
	});
});

const EXITS = {
	open: ["confirmed", "in_progress", "needs_info", "on_hold", "dropped"],
	approved: ["in_progress", "needs_info", "on_hold", "dropped"],
	in_progress: ["developed", "closed", "needs_info", "on_hold", "dropped"],
	developed: ["testing", "reopen", "needs_info", "on_hold", "dropped"],
	testing: ["awaiting_release", "closed", "reopen", "needs_info", "on_hold", "dropped"],
	releasing: ["closed", "reopen", "needs_info", "on_hold"],
	closed: ["reopen"],
	dropped: [],
	confirmed: ["approved", "in_progress", "needs_info", "on_hold", "dropped"],
	draft: ["open", "closed", "dropped", "developed", "in_progress"],
} satisfies StatusExits;

describe("allowedTransitions", () => {
	it("offers a closed issue the one move it has", () => {
		expect(allowedTransitions(EXITS, "closed")).toEqual(["reopen"]);
	});

	it("offers a dropped issue nothing", () => {
		expect(allowedTransitions(EXITS, "dropped")).toEqual([]);
	});

	it("offers no retired status from any rung it is given", () => {
		for (const from of Object.keys(EXITS) as (keyof typeof EXITS)[]) {
			const offered = allowedTransitions(EXITS, from);
			expect(offered).not.toContain("clarified");
			expect(offered).not.toContain("waiting");
			expect(offered).not.toContain("tested");
		}
	});

	it("returns the row in the order core declared it", () => {
		expect(allowedTransitions(EXITS, "developed")).toEqual([
			"testing",
			"reopen",
			"needs_info",
			"on_hold",
			"dropped",
		]);
	});

	it("restricts draft to promote, take up, direct-ship, or either discard", () => {
		expect(allowedTransitions(EXITS, "draft")).toEqual([
			"open",
			"closed",
			"dropped",
			"developed",
			"in_progress",
		]);
	});

	it("offers nothing at all while the exits are unread", () => {
		expect(allowedTransitions(undefined, "open")).toEqual([]);
		expect(allowedTransitions({}, "open")).toEqual([]);
	});
});

describe("groupedTransitions (ISS-982)", () => {
	it("puts the forward rung first", () => {
		expect(groupedTransitions(EXITS, "open")[0]).toEqual({
			to: "confirmed",
			kind: "forward",
			startsGroup: false,
		});
	});

	it("orders the groups forward, then bounce, then discard", () => {
		expect(groupedTransitions(EXITS, "in_progress").map((g) => g.to)).toEqual([
			"developed",
			"needs_info",
			"on_hold",
			"closed",
			"dropped",
		]);
	});

	it("keeps each group in the order core declared it, not in any order of its own", () => {
		expect(groupedTransitions(EXITS, "testing").map((g) => g.to)).toEqual([
			"awaiting_release",
			"reopen",
			"needs_info",
			"on_hold",
			"closed",
			"dropped",
		]);
	});

	it("marks the three bounce targets as bounces", () => {
		const byTo = new Map(groupedTransitions(EXITS, "developed").map((g) => [g.to, g.kind]));
		expect(byTo.get("needs_info")).toBe("bounce");
		expect(byTo.get("on_hold")).toBe("bounce");
		expect(byTo.get("reopen")).toBe("bounce");
	});

	it("marks the two discard targets as discards", () => {
		const byTo = new Map(groupedTransitions(EXITS, "in_progress").map((g) => [g.to, g.kind]));
		expect(byTo.get("closed")).toBe("discard");
		expect(byTo.get("dropped")).toBe("discard");
	});

	it("files a park that comes first as a bounce, not as the rung's forward move (ISS-1421)", () => {
		const atGate: StatusExits = { ...EXITS, awaiting_release: ["needs_info", "on_hold", "dropped"] };
		expect(groupedTransitions(atGate, "awaiting_release")).toEqual([
			{ to: "needs_info", kind: "bounce", startsGroup: false },
			{ to: "on_hold", kind: "bounce", startsGroup: false },
			{ to: "dropped", kind: "discard", startsGroup: true },
		]);
	});

	it("never offers releasing, even where a table lists it (ISS-1421)", () => {
		const stale: StatusExits = {
			...EXITS,
			awaiting_release: ["releasing", "needs_info", "on_hold", "dropped"],
		};
		expect(allowedTransitions(stale, "awaiting_release")).not.toContain("releasing");
		expect(groupedTransitions(stale, "awaiting_release").map((g) => g.to)).toEqual([
			"needs_info",
			"on_hold",
			"dropped",
		]);
	});

	it("offers no move out of releasing, even where a table lists some (ISS-1421)", () => {
		const stale: StatusExits = { ...EXITS, releasing: ["closed", "reopen", "needs_info", "on_hold"] };
		expect(allowedTransitions(stale, "releasing")).toEqual([]);
		expect(groupedTransitions(stale, "releasing")).toEqual([]);
		expect(bulkAllowedStatuses(stale, [row({ id: "a", status: "releasing" })])).toEqual([]);
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

	it("groups nothing when the exits are unread", () => {
		expect(groupedTransitions(undefined, "open")).toEqual([]);
	});
});

describe("bulkAllowedStatuses (ISS-463)", () => {
	it("returns [] for an empty selection", () => {
		expect(bulkAllowedStatuses(EXITS, [])).toEqual([]);
	});
	it("matches allowedTransitions when every row shares a status, less the reason-required ones a shared reason cannot serve", () => {
		const rows = [
			row({ id: "a", status: "approved" }),
			row({ id: "b", status: "approved" }),
		];
		expect(bulkAllowedStatuses(EXITS, rows)).toEqual(
			allowedTransitions(EXITS, "approved").filter(
				(s) =>
					!(REASON_REQUIRED_ISSUE_STATUSES as readonly string[]).includes(s) ||
					BULK_SHARES_ONE_REASON.has(s),
			),
		);
	});
	it("omits every reason-required target but the one that takes a single shared reason", () => {
		const rows = [row({ id: "a", status: "in_progress" })];
		const offered = bulkAllowedStatuses(EXITS, rows);
		for (const owing of REASON_REQUIRED_ISSUE_STATUSES) {
			expect(offered.includes(owing as never)).toBe(BULK_SHARES_ONE_REASON.has(owing));
		}
	});
	it("omits exactly the targets the shared reason-required answer names, less the one shared reason, whatever it grows to", () => {
		const rows = [row({ id: "a", status: "in_progress" })];
		const all = allowedTransitions(EXITS, "in_progress");
		const offered = bulkAllowedStatuses(EXITS, rows);
		expect(all.filter((s) => !offered.includes(s))).toEqual(
			all.filter(
				(s) =>
					(REASON_REQUIRED_ISSUE_STATUSES as readonly string[]).includes(s) &&
					!BULK_SHARES_ONE_REASON.has(s),
			),
		);
	});
	it("never offers a status that requires an authored reason", () => {
		const rows = [
			row({ id: "a", status: "in_progress" }),
			row({ id: "b", status: "developed" }),
		];
		const result = bulkAllowedStatuses(EXITS, rows);
		expect(result).not.toContain("waiting");
		expect(result).not.toContain("needs_info");
		expect(result).not.toContain("reopen");
		expect(result).toContain("on_hold");
		expect(result).toContain("dropped");
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
		expect(result).toEqual(["in_progress", "on_hold", "dropped"]);
	});
	it("keeps the first selected row's declared order, not the enum's", () => {
		const rows = [
			row({ id: "a", status: "draft" }),
			row({ id: "b", status: "approved" }),
		];
		expect(bulkAllowedStatuses(EXITS, rows)).toEqual(["dropped", "in_progress"]);
	});
	it("narrows to nothing when a terminal row is in the mix", () => {
		const rows = [
			row({ id: "a", status: "dropped" }),
			row({ id: "b", status: "approved" }),
		];
		expect(bulkAllowedStatuses(EXITS, rows)).toEqual([]);
	});
	it("narrows hard when a draft row is in the mix (a draft's five exits bound the whole selection)", () => {
		const rows = [
			row({ id: "a", status: "draft" }),
			row({ id: "b", status: "approved" }),
		];
		expect(bulkAllowedStatuses(EXITS, rows)).toEqual(["dropped", "in_progress"]);
	});
	it("offers nothing while the exits are unread", () => {
		const rows = [row({ id: "a", status: "open" })];
		expect(bulkAllowedStatuses(undefined, rows)).toEqual([]);
	});
});

describe("label helpers", () => {
	it("humanizes status / priority / complexity (no raw enum leaks)", () => {
		expect(statusLabel("in_progress")).toBe("In progress");
		expect(lane("in_progress", true)).toBe("In flight");
		expect(lane("needs_info", true)).toBe("Blocked on a person — needs an answer");

		expect(statusLabel("needs_info")).toBe("Needs info");
		expect(priorityLabel("critical")).toBe("Critical");
		expect(complexityLabel("xs")).toBe("XS");
		expect(complexityLabel("m")).toBe("Medium");
	});
	it("heads a deliberate pause as on hold, in the same state as a question but never as one", () => {
		expect(lane("on_hold", false)).toBe("Blocked on a person — on hold");
		expect(lane("on_hold", false)).not.toBe(lane("waiting", false));
		expect(lane("waiting", false)).toBe("Blocked on a person — needs an answer");
		expect(lane("needs_info", false)).toBe("Blocked on a person — needs an answer");
	});
	it("begins every column head with the word of the work state its label is in", () => {
		for (const status of ISSUE_STATUSES) {
			for (const held of [true, false]) {
				const label = toAutonomousLabel(status, held);
				expect(lane(status, held).startsWith(WORK_STATE_LABELS[LABEL_WORK_STATE[label]])).toBe(true);
			}
		}
	});
	it("heads a label alone in its state with that state's word and no more", () => {
		expect(lane("open", true)).toBe("Open, not picked up");
		expect(lane("developed", true)).toBe("In flight");
		expect(lane("tested", true)).toBe("Awaiting release");
		expect(lane("draft", true)).toBe("Draft");
	});
	it("heads a row nothing holds as in flight with no check-in, never as in flight alone", () => {
		expect(lane("testing", false)).toBe("In flight — no check-in");
		expect(lane("developed", false)).toBe("In flight — no check-in");
		expect(ISSUE_STATUSES.map((s) => lane(s, false))).not.toContain("Stalled");
		expect(ISSUE_STATUSES.map((s) => lane(s, false))).not.toContain("In flight");
	});
	it("keeps ten column heads, one per lane label, so the lane's finer distinctions stay columns", () => {
		const words = ISSUE_STATUSES.flatMap((s) => [lane(s, true), lane(s, false)]);
		expect(new Set(words).size).toBe(10);
	});
	it("names each move target by its own status word, never by a lane word", () => {
		expect(transitionLabels(["in_progress", "developed", "testing"])).toEqual([
			"In progress",
			"Developed",
			"Testing",
		]);
		expect(transitionLabels([...ISSUE_STATUSES])).toEqual(ISSUE_STATUSES.map(statusLabel));
	});
	it("keeps seventeen status words beside the ten column heads", () => {
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
		expect(REGISTRY_ISSUE_STATUSES).toHaveLength(17);
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
			},
			{
				id: "e2",
				fromIssueId: id,
				toIssueId: "i3",
				kind: "relates",
				reason: null,
				createdAt: "",
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
				},
				{
					id: "d2",
					fromIssueId: id,
					toIssueId: "c2",
					kind: "decomposes",
					reason: null,
					createdAt: "",
				},
				{
					id: "b1",
					fromIssueId: id,
					toIssueId: "x1",
					kind: "blocks",
					reason: null,
					createdAt: "",
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

describe("filterToQueryParams", () => {
	it("all applies no filter — every issue incl. drafts + closed (ISS-360)", () => {
		expect(filterToQueryParams("all")).toEqual({});
	});
	it("asks the search for the work state a segment is, and for nothing else", () => {
		for (const state of WORK_STATES) {
			expect(filterToQueryParams(state)).toEqual({ workState: state });
		}
	});
	it("gives the strip one segment per work state, in the state order, then All", () => {
		const labels = WORK_STATES.map((s) => WORK_STATE_LABELS[s]);
		expect(labels).toEqual([
			"Open, not picked up",
			"In flight",
			"Awaiting release",
			"Blocked on a person",
			"Draft",
			"Finished",
		]);
	});
});

describe("filterCount", () => {
	const byWorkState = {
		open: 56,
		in_flight: 11,
		awaiting_release: 1,
		blocked_on_person: 4,
		draft: 24,
		finished: 1306,
	};

	it("reads a segment's own state's count", () => {
		for (const state of WORK_STATES) {
			expect(filterCount(state, { byWorkState }), state).toBe(byWorkState[state]);
		}
	});

	it("makes All the six segments summed, so the segments add up to it", () => {
		const segments = WORK_STATES.reduce((n, s) => n + filterCount(s, { byWorkState }), 0);
		expect(filterCount("all", { byWorkState })).toBe(segments);
		expect(segments).toBe(1402);
	});
});

describe("groupRows", () => {
	const rows = [
		row({
			id: "a",
			status: "open",
			priority: "high",
			createdById: "u1",
			creatorLabel: "Ann Lee",
		}),
		row({
			id: "b",
			status: "open",
			priority: "low",
			createdById: "u2",
			creatorLabel: "Another member",
		}),
		row({
			id: "c",
			status: "developed",
			priority: "high",
			createdById: "u1",
			creatorLabel: "Ann Lee",
		}),
	];
	it("returns a single group for none", () => {
		const g = groupRows(rows, "none");
		expect(g).toHaveLength(1);
		expect(g[0].rows).toHaveLength(3);
	});
	it("groups by status preserving server order", () => {
		const g = groupRows(rows, "status");
		expect(g.map((x) => x.key)).toEqual(["open", "developed"]);
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
			"Ann Lee",
			"Another member",
			"master",
			"reviewer",
		]);
	});
});

describe("groupRows by module", () => {
	const mod = (labelId: string, name: string, isPrimary = true) => ({
		labelId,
		name,
		color: "#000",
		isPrimary,
	});
	const rows = [
		row({ id: "a", modules: [mod("m1", "Auth", false), mod("m2", "Pipeline")] }),
		row({ id: "b" }),
		row({ id: "c", modules: [mod("m1", "Auth")] }),
		row({ id: "d", modules: [mod("m2", "Pipeline")] }),
		row({ id: "e", modules: [] }),
	];

	it("files each issue once, under its primary module, never under a secondary", () => {
		const g = groupRows(rows, "module");
		expect(g.find((x) => x.moduleId === "m1")?.rows.map((r) => r.id)).toEqual(["c"]);
		expect(g.find((x) => x.moduleId === "m2")?.rows.map((r) => r.id)).toEqual(["a", "d"]);
		expect(g.flatMap((x) => x.rows)).toHaveLength(rows.length);
	});

	it("orders modules by name and puts the issues with none last, under No module", () => {
		const g = groupRows(rows, "module");
		expect(g.map((x) => x.label)).toEqual(["Auth", "Pipeline", "No module"]);
		expect(g[2]).toMatchObject({ moduleId: null, key: "no-module" });
		expect(g[2].rows.map((r) => r.id)).toEqual(["b", "e"]);
	});

	it("files an issue with only secondary modules under No module, as its module cell shows it", () => {
		const g = groupRows([row({ id: "s", modules: [mod("m1", "Auth", false)] })], "module");
		expect(g).toHaveLength(1);
		expect(g[0]).toMatchObject({ moduleId: null, label: "No module" });
	});

	it("has no No module group when every issue carries a module", () => {
		const g = groupRows([rows[0], rows[2]], "module");
		expect(g.map((x) => x.moduleId)).toEqual(["m1", "m2"]);
	});
});

// ISS-1229 r21: a member is named as personName says — never by address, never by a raw id.
describe("memberLabel / initials", () => {
	it("names a member by display name, else Another member, never by address or id", () => {
		expect(memberLabel("u1", [{ userId: "u1", displayName: "Bob Tran" }])).toBe("Bob Tran");
		expect(memberLabel("u1", [{ userId: "u1", displayName: null }])).toBe("Another member");
		expect(memberLabel("u1", [{ userId: "u1", displayName: "bob@x.co" }])).toBe(
			"Another member",
		);
		expect(memberLabel("abcdef1234", [])).toBe("Unknown user");
		expect(memberLabel(null)).toBe("Unassigned");
	});
	it("derives two-letter initials from a name, never from an address", () => {
		expect(initials("Ann Smith")).toBe("AS");
		expect(initials("Another member")).toBe("AM");
		expect(initials("ann.smith@x.co")).toBe("AM");
	});
});

describe("creatorLabelOf", () => {
	it("is the server-provided creatorLabel", () => {
		expect(creatorLabelOf({ creatorLabel: "Ann Smith" })).toBe("Ann Smith");
	});
	it("never falls back to an address or a raw id — 'Unknown user' when nothing resolves", () => {
		expect(creatorLabelOf({ creatorLabel: "" })).toBe("Unknown user");
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
		["forge-code complete; pushed ISS-1 branch", "code"],
		["Plan written and ready for review", "plan"],
		["Just a normal note here", "comment"],
	];
	it.each(cases)("classifies %j as %s", (body, kind) => {
		expect(deriveCommentKind({ body, announces: null })).toBe(kind);
	});
	it("has badge meta for every kind it returns", () => {
		for (const kind of [...cases.map(([, k]) => k), "released"]) {
			expect(
				COMMENT_KIND_META[kind as keyof typeof COMMENT_KIND_META],
			).toBeDefined();
		}
	});

	// ISS-1228: the kind is read off the comment's opening line, so a word met further down a body
	// that is about something else stamps nothing. The judge saw a Released badge on a Draft issue.
	it.each([
		["Moving this to draft until the plan is settled.\nNothing here has been released yet.", "comment"],
		["Parking: the previous fix shipped with a typo, see below.", "comment"],
		["Note on the plan\nThe reviewer approved the plan written above.", "comment"],
	])("reads %j by its opening as %s", (body, kind) => {
		expect(deriveCommentKind({ body, announces: null })).toBe(kind);
	});

	// ISS-1228 round 9: Released is a fact core records as its release flow writes the comment, never
	// a reading of the words. Judge-21's four denials, and every line rounds 7 and 8 badged by its
	// words, typed by a person or an agent carry no badge.
	it.each([
		"Released: nothing this week.",
		"Shipped to QA failed — the build broke before upload.",
		"Released to production got pushed to Monday, nothing went out today.",
		"Released to production doesn't describe this one; it never left staging.",
		"Released v1.2.0 to prod",
		"Released v10.2.0 to prod",
		"Released — v1.2.0 to production",
		"Released v1.2.0 on May 3",
		"Released 2026.10 to production",
		"**Released** in v0.4.3 — the picker went out.",
		"__Shipped__ to production this morning.",
		"Released in v0.4.2 — the picker went out.",
		"Released outside a release batch, and recorded from what production is serving.",
		"Released: the new picker.",
		"Published release v2.0.1",
		"## Release notes\nThe picker is new.",
		"**Release note**\nThe picker is new.",
		"## Release note\nThe Pipeline page now lists live sessions.",
	])("badges the typed comment %j with nothing", (body) => {
		expect(deriveCommentKind({ body, announces: null })).toBe("comment");
		expect(deriveCommentKind({ body })).toBe("comment");
	});

	it.each([
		"Released outside a release batch, and recorded on the account of whoever released it.",
		"**This issue is being closed by a release that was not verified.**",
		"Not released: the deploy was rolled back.",
		"Just a normal note here",
	])("badges %j Released where core's release flow marked it, whatever its words", (body) => {
		expect(deriveCommentKind({ body, announces: "release" })).toBe("released");
	});

	it("classifies a stored component body by its prose, not by its markup", () => {
		expect(
			deriveCommentKind({
				body: "<forge-symptom><forge-opening><p>Plan written</p></forge-opening></forge-symptom>",
				announces: null,
			}),
		).toBe("plan");
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
		...(over.holdsUntil ? { holdsUntil: over.holdsUntil } : {}),
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

describe("openBlockingRefs for an edge that holds until shipped (ISS-1225)", () => {
	const held = (status: IssueStatus, holdsUntil?: "settled" | "shipped") =>
		openBlockingRefs(incomingBlocks({ fromStatus: status, holdsUntil }));

	it("flags a shipped edge's blocker at awaiting_release, where a settled edge's is released", () => {
		expect(held("awaiting_release", "shipped").map((r) => r.displayId)).toEqual([
			"ISS-9",
		]);
		expect(held("awaiting_release", "settled")).toEqual([]);
		expect(held("awaiting_release")).toEqual([]);
	});

	it("releases a shipped edge's blocker only at the shipped statuses", () => {
		const released = REGISTRY_ISSUE_STATUSES.filter(
			(s) => held(s, "shipped").length === 0,
		);
		expect(released).toEqual([...BLOCKER_SHIPPED_STATUSES]);
	});
});

describe("deriveBlockerState", () => {
	// ISS-1228 round 8: the banner names each blocker by its status. A dropped blocker is not open,
	// and since it never finishes, telling a person to finish it first is no way out.
	it("names each blocker with its status and never calls a dropped one open", () => {
		const deps: IssueDependencies = {
			incoming: [
				...incomingBlocks({ id: "e1", fromIssueId: "b1", fromDisplayId: "ISS-9", fromStatus: "in_progress" }).incoming,
				...incomingBlocks({ id: "e2", fromIssueId: "b2", fromDisplayId: "ISS-11", fromStatus: "dropped" }).incoming,
			],
			outgoing: [],
		};
		const b = deriveBlockerState(blockerIssue({ status: "approved" }), undefined, deps);
		expect(b?.reason).toBe("Blocked by ISS-9 (In progress) and ISS-11 (Dropped).");
		expect(b?.reason).not.toMatch(/open/i);
		expect(b?.whoMustAct).toMatch(/dropped issue never finishes/i);
		expect(b?.whoMustAct).toMatch(/remove/i);
	});

	it("tells a person to finish blockers that can still finish", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "approved" }),
			undefined,
			incomingBlocks({ fromDisplayId: "ISS-9", fromStatus: "open" }),
		);
		expect(b?.reason).toBe("Blocked by ISS-9 (Open).");
		expect(b?.whoMustAct).toMatch(/^Finish ISS-9 first/);
	});

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
		it("names a decision and resumes at the recorded rung — sid-desk ISS-529's shape", () => {
			const b = deriveBlockerState(
				blockerIssue({ status: "waiting" }),
				{ stage: "waiting", waitingCause: { kind: "needs_decision" } },
				undefined,
				readPark({ status: "waiting", owes: "decision", resume: { at: "developed", recordId: "c1" } }),
			);
			expect(b?.reason).toContain("a decision");
			expect(b?.cta).toEqual({ label: "Resume at Developed", kind: "resume-park" });
			expect(b?.resumeAt).toBe("developed");
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

		it("says the park did not say what it waits for, and offers no move it cannot back", () => {
			const b = deriveBlockerState(
				blockerIssue({ status: "waiting" }),
				undefined,
				undefined,
				readPark({ status: "waiting", owes: null }),
			);
			expect(b?.reason).toContain("did not say for what");
			expect(b?.cta.kind).toBe("none");
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
			for (const owes of ["information", "decision", "resource", null] as const) {
				for (const resume of [{ at: "developed" as const, recordId: "c" }, { at: null, why: "x" }]) {
					shapes.push({ status: "waiting", owes, resume });
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
			for (const owes of ["information", "decision", "resource", null] as const) {
				for (const status of ["needs_info", "waiting"] as const) {
					const b = deriveBlockerState(
						blockerIssue({ status }),
						undefined,
						undefined,
						readPark({ status, owes, resume: { at: "developed", recordId: "c" } }),
					);
					expect(b?.cta.kind).not.toBe("approve");
					expect(b?.cta.label).not.toMatch(/approve/i);
				}
			}
		});

		it("says so while the park is being read, or could not be read, and offers nothing", () => {
			for (const state of ["loading", "error"] as const) {
				const b = deriveBlockerState(blockerIssue({ status: "waiting" }), undefined, undefined, { state });
				expect(b?.tone).toBe("attention");
				expect(b?.cta.kind).toBe("none");
			}
			const failed = deriveBlockerState(blockerIssue({ status: "needs_info" }), undefined, undefined, {
				state: "error",
			});
			expect(failed?.whoMustAct).toMatch(/could not be read/);
		});
	});

	it("on_hold status → resume action, in the calm tone", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "on_hold" }),
			undefined,
			undefined,
		);
		expect(b?.cta.kind).toBe("resume");
		expect(b?.reason).toContain("paused");
		expect(b?.tone).toBe("info");
	});

	it("keeps the attention tone for the two parks that DO ask a person", () => {
		for (const status of ["needs_info", "waiting"] as const) {
			const b = deriveBlockerState(blockerIssue({ status }), undefined, undefined, readPark({ status }));
			expect(b?.tone).toBe("attention");
		}
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

describe("deriveRunView — one view of what each run did (ISS-1133)", () => {
	const attempt = (
		phase: string,
		n: number,
		over: Partial<JournalAttempt> = {},
	): JournalAttempt => ({
		phase,
		attempt: n,
		source: "agent",
		outcome: "ok",
		startedAt: "2026-10-15T07:00:00.000Z",
		endedAt: "2026-10-15T07:01:00.000Z",
		durationSeconds: 60,
		artifact: null,
		handoff: null,
		handoffAt: null,
		...over,
	});
	const run = (runId: string, over: Partial<JournalRun> = {}): JournalRun => ({
		runId,
		ordinal: 1,
		kind: "issue",
		status: "completed",
		group: null,
		startedAt: "2026-10-15T07:00:00.000Z",
		finishedAt: "2026-10-15T07:30:00.000Z",
		costUsd: null,
		sessionId: null,
		attempts: [],
		...over,
	});

	it("answers nothing for an issue that never ran, or before the read lands", () => {
		expect(deriveRunView([], [])).toEqual([]);
		expect(deriveRunView(undefined, undefined)).toEqual([]);
	});

	it("keeps the number the server gave each run, so a run past the page keeps its own", () => {
		const out = deriveRunView(
			[run("r52", { ordinal: 52 }), run("r51", { ordinal: 51 })],
			[],
		);
		expect(out.map((r) => [r.runId, r.ordinal])).toEqual([
			["r52", 52],
			["r51", 51],
		]);
	});

	it("names the other issues a group run was opened over, never this one", () => {
		const [grouped, alone] = deriveRunView(
			[run("g", { group: ["ISS-7", "ISS-9"] }), run("r")],
			[],
			"ISS-7",
		);
		expect(grouped?.alongside).toEqual(["ISS-9"]);
		expect(alone?.alongside).toEqual([]);
	});

	it("keeps a phase's own name, and numbers an attempt only where the run made more than one", () => {
		const [out] = deriveRunView(
			[run("r1", { attempts: [attempt("plan", 1), attempt("drive", 1), attempt("drive", 2)] })],
			[],
		);
		expect(out?.attempts.map((a) => [a.key, a.numbered])).toEqual([
			["plan#1", false],
			["drive#1", true],
			["drive#2", true],
		]);
	});

	it("carries the session a run session ran, though no session it was hydrated with names the issue", () => {
		expect(deriveRunView([run("r1", { sessionId: "s-run" })], [])[0]?.sessionId).toBe("s-run");
	});

	it("reads an open attempt as running only while its run is live, and as left open once it ended", () => {
		const open = attempt("drive", 1, { outcome: null, endedAt: null, durationSeconds: null });
		const states = (status: JournalRun["status"]) =>
			deriveRunView([run("r1", { status, attempts: [open] })], [])[0]?.attempts[0]?.state;
		expect(states("running")).toBe("running");
		expect(states("paused")).toBe("running");
		expect(states("failed")).toBe("left-open");
		expect(states("completed")).toBe("left-open");
	});

	it("reads each ended attempt by the outcome the journal holds", () => {
		const [out] = deriveRunView(
			[
				run("r1", {
					status: "running",
					attempts: [
						attempt("plan", 1),
						attempt("code", 1, { outcome: "failed" }),
						attempt("code", 2, { outcome: "abandoned" }),
					],
				}),
			],
			[],
		);
		expect(out?.attempts.map((a) => a.state)).toEqual(["done", "failed", "abandoned"]);
	});

	it("summarises an attempt by its handoff first, then by the artifact it ended with", () => {
		const [out] = deriveRunView(
			[
				run("r1", {
					attempts: [
						attempt("drive", 1, {
							handoff: { step: "drive", outcome: "advanced", summary: "pushed the branch" },
							artifact: { kind: "note", text: "not this" },
						}),
						attempt("code", 1, {
							artifact: { kind: "commit", sha: "abcdef1234567890", message: "fix it" },
						}),
						attempt("review", 1, { artifact: { kind: "note", text: "looked fine" } }),
						attempt("test", 1),
					],
				}),
			],
			[],
		);
		expect(out?.attempts.map((a) => a.summary)).toEqual([
			"pushed the branch",
			"abcdef123 fix it",
			"looked fine",
			null,
		]);
	});

	it("puts each session under the run it served, and leaves out a session that served none", () => {
		const session = (id: string, pipelineRunId: string | null, jobType: string) =>
			({
				id,
				status: "completed",
				metadata: { jobType, sessionGroup: "build" },
				createdAt: "2026-10-15T07:00:00.000Z",
				updatedAt: "2026-10-15T07:00:00.000Z",
				startedAt: `2026-10-15T07:0${id.length}:00.000Z`,
				title: null,
				pipelineRunId,
				claudeSessionId: "c1",
			}) as const;
		const out = deriveRunView(
			[run("r2"), run("r1")],
			[session("s1", "r1", "plan"), session("s22", "r1", "code"), session("chat", null, "chat")],
		);
		expect(out[0]?.sessions).toEqual([]);
		expect(out[1]?.sessions.map((s) => [s.jobType, s.continuity])).toEqual([
			["plan", "fresh"],
			["code", "resumed"],
		]);
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
		expect(b?.reason).toContain("stage_stalled");
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
		expect(b?.reason).toContain("stage_stalled");
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

describe("statusFilterFromParams", () => {
	it("names exactly the statuses a comma-joined parameter carries", () => {
		expect(statusFilterFromParams(["waiting,needs_info,on_hold"])).toEqual({
			statuses: ["waiting", "needs_info", "on_hold"],
			unknown: [],
		});
	});

	it("reads a repeated parameter whole, so ?status=open&status=closed applies both", () => {
		expect(statusFilterFromParams(["open", "closed"])).toEqual({
			statuses: ["open", "closed"],
			unknown: [],
		});
	});

	it("returns a word the lifecycle does not have by name, keeping the rest", () => {
		expect(statusFilterFromParams(["open,banana,closed"])).toEqual({
			statuses: ["open", "closed"],
			unknown: ["banana"],
		});
	});

	it("returns undefined statuses where nothing valid is named, leaving the tab filter in charge", () => {
		expect(statusFilterFromParams(["banana"])).toEqual({ statuses: undefined, unknown: ["banana"] });
		expect(statusFilterFromParams([""])).toEqual({ statuses: undefined, unknown: [] });
		expect(statusFilterFromParams([])).toEqual({ statuses: undefined, unknown: [] });
	});

	it("tolerates spacing and repeats without sending a status twice", () => {
		expect(statusFilterFromParams([" open , open ", "closed"])).toEqual({
			statuses: ["open", "closed"],
			unknown: [],
		});
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
	it("shows a banner on an issue at testing that a person owes an answer", () => {
		const banner = deriveBlockerState(
			blockerIssue({ status: "testing" }),
			undefined,
			undefined,
			readPark({ shape: "question", status: "testing", openQuestionIds: ["q1"], resume: { at: null, why: "not stopped" } }),
		);
		expect(banner?.tone).toBe("attention");
		expect(banner?.reason).toMatch(/information/);
		expect(banner?.cta.kind).toBe("provide-info");
	});

	it("shows no banner at testing when the park view reads nobody owes it anything", () => {
		expect(
			deriveBlockerState(blockerIssue({ status: "testing" }), undefined, undefined, {
				state: "ready",
				park: null,
			}),
		).toBeNull();
	});
});


describe("originFromParams", () => {
	it("reads the first source and returns the rest by name, once each", () => {
		expect(originFromParams(["detector", "human", "agent", "human"])).toEqual({
			origin: "detector",
			dropped: ["human", "agent"],
			first: "detector",
			firstUnknown: false,
		});
	});

	it("applies no source where the first is one the filter does not offer, and still names the rest", () => {
		expect(originFromParams(["bogus", "human"])).toEqual({
			origin: undefined,
			dropped: ["human"],
			first: "bogus",
			firstUnknown: true,
		});
	});

	it("reads an empty first value as no source, not as an unknown one", () => {
		expect(originFromParams(["", "detector"])).toEqual({
			origin: undefined,
			dropped: ["detector"],
			first: "",
			firstUnknown: false,
		});
		expect(originFromParams([])).toEqual({ origin: undefined, dropped: [], first: "", firstUnknown: false });
	});

	it("drops a repeat of the first value rather than call it left out", () => {
		expect(originFromParams(["human", "human"]).dropped).toEqual([]);
	});
});

// ISS-1228 round 14 (judge-36): Open session landed on the unfiltered runs list, where no row opens
// a session.
describe("issueSessionId — the session Open session opens", () => {
	const runs = (...sessionIds: (string | null)[]) => sessionIds.map((sessionId) => ({ sessionId }));

	it("opens the live session holding the issue before any that ran it", () => {
		expect(issueSessionId(["live-1"], runs("s-new"))).toBe("live-1");
	});

	it("else opens the newest session of the newest run that had one", () => {
		expect(issueSessionId([], runs("s-b", "s-old"))).toBe("s-b");
	});

	it("skips a newest run that had no session for an older run's newest", () => {
		expect(issueSessionId([], runs(null, "s-2"))).toBe("s-2");
	});

	it("opens nothing for an issue that never had a session", () => {
		expect(issueSessionId([], runs(null, null))).toBeNull();
		expect(issueSessionId([], [])).toBeNull();
	});
});

