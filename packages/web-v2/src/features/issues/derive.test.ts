import { toAutonomousLabel } from "@forge/contracts/issue-vocabulary";
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
	priorityLabel,
	STATUS_LABELS,
	statusLabel,
	LABEL_VIEW,
	runStatusChip,
	statusToChip,
	statusToTone,
	statusesFromParam,
	transitionLabels,
} from "./derive";
import type {
	IssueDependencies,
	IssueStatus,
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


/** The word the board shows for a row: its lane label, held or not. */
const lane = (s: IssueStatus, held: boolean): string => LABEL_VIEW[toAutonomousLabel(s, held)].label;

describe("runStatusChip — the run's state, never the issue's", () => {
	it("maps each run state the API sends to its own session key", () => {
		expect(runStatusChip("running")).toBe("running");
		expect(runStatusChip("queued")).toBe("queued");
		expect(runStatusChip("completed")).toBe("done");
		expect(runStatusChip("failed")).toBe("failed");
	});
	it("shows no chip when no run has a state", () => {
		expect(runStatusChip(null)).toBeNull();
		expect(runStatusChip(undefined)).toBeNull();
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

	it("does not file releasing's close under the discards", () => {
		expect(groupedTransitions(EXITS, "releasing")[0]).toEqual({
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
			row({ id: "b", status: "developed" }),
		];
		const result = bulkAllowedStatuses(EXITS, rows);
		expect(result).not.toContain("waiting");
		expect(result).not.toContain("needs_info");
		expect(result).not.toContain("reopen");
		expect(result).toContain("on_hold");
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
		expect(lane("in_progress", true)).toBe("Running");
		expect(lane("needs_info", true)).toBe("Needs a human");

		expect(statusLabel("needs_info")).toBe("Needs info");
		expect(priorityLabel("critical")).toBe("Critical");
		expect(complexityLabel("xs")).toBe("XS");
		expect(complexityLabel("m")).toBe("Medium");
	});
	it("labels a deliberate pause as paused, never as needing a human", () => {
		expect(lane("on_hold", false)).toBe("Paused");
		expect(lane("on_hold", false)).not.toBe("Needs a human");
		expect(lane("waiting", false)).toBe("Needs a human");
		expect(lane("needs_info", false)).toBe("Needs a human");
	});
	it("keeps the ten lane words for the surfaces that want ten buckets", () => {
		expect(lane("in_progress", true)).toBe("Running");
		expect(lane("developed", true)).toBe("Running");
		expect(lane("releasing", true)).toBe("Running");
		expect(lane("waiting", true)).toBe("Needs a human");
		expect(lane("needs_info", true)).toBe("Needs a human");
		const words = ISSUE_STATUSES.flatMap((s) => [lane(s, true), lane(s, false)]);
		expect(new Set(words).size).toBe(10);
	});
	// ISS-1213: a row nothing holds does not read Running, whatever its status.
	it("reads No check-in, never Running or Stalled, on a row nothing holds", () => {
		expect(lane("testing", false)).toBe("No check-in");
		expect(lane("developed", false)).toBe("No check-in");
		expect(ISSUE_STATUSES.map((s) => lane(s, false))).not.toContain("Stalled");
		expect(ISSUE_STATUSES.map((s) => lane(s, false))).not.toContain("Running");
	});
	it("names each move target by its own status word, never by a lane word", () => {
		expect(transitionLabels(["in_progress", "developed", "testing"])).toEqual([
			"In progress",
			"Developed",
			"Testing",
		]);
		expect(transitionLabels([...ISSUE_STATUSES])).toEqual(ISSUE_STATUSES.map(statusLabel));
	});
	it("puts every status the lane reads as running or as no check-in on the agent tab", () => {
		const agent = filterToQueryParams("agent").status ?? [];
		for (const s of ISSUE_STATUSES) {
			const word = lane(s, false);
			if (word === "No check-in" || word === "Open") expect(agent, s).toContain(s);
		}
	});

	it("keeps seventeen status words beside the ten lane words", () => {
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
	it("`you` holds every status a person must act on, from the label axis", () => {
		const s = filterToQueryParams("you").status ?? [];
		for (const parked of ["needs_info", "waiting", "on_hold"]) {
			expect(s, parked).toContain(parked);
		}
	});
	it("counts the release gate and a reopen as the person's, not the machine's", () => {
		const you = filterToQueryParams("you").status ?? [];
		const agent = filterToQueryParams("agent").status ?? [];
		for (const mine of ["awaiting_release", "reopen"]) {
			expect(you, mine).toContain(mine);
			expect(agent, mine).not.toContain(mine);
		}
	});
	it("`agent` never claims a status a person has to answer", () => {
		const s = filterToQueryParams("agent").status ?? [];
		for (const parked of ["waiting", "on_hold", "needs_info"]) {
			expect(s, parked).not.toContain(parked);
		}
	});
	it("`done` carries dropped as well as closed", () => {
		const s = filterToQueryParams("done").status ?? [];
		expect(s).toContain("closed");
		expect(s).toContain("dropped");
	});
	it("every non-terminal status is reachable from exactly one of the three work tabs", () => {
		const buckets = (["you", "agent", "done"] as const).map(
			(f) => filterToQueryParams(f).status ?? [],
		);
		const drafts = ["draft"];
		for (const s of REGISTRY_ISSUE_STATUSES) {
			if (drafts.includes(s)) continue;
			const hits = buckets.filter((b) => b.includes(s)).length;
			expect(hits, `${s} appears in ${hits} tabs`).toBe(1);
		}
	});

	it("draft targets only drafts", () => {
		expect(filterToQueryParams("draft")).toEqual({
			status: ["draft"],
			origin: "human",
		});
	});

	it("findings selects detector origin at any status", () => {
		expect(filterToQueryParams("findings")).toEqual({ origin: "detector" });
	});

	it("all stays unfiltered so nothing is unreachable", () => {
		expect(filterToQueryParams("all")).toEqual({});
	});
	it("done is terminal only — the release gate is not finished work", () => {
		expect(filterToQueryParams("done")).toEqual({
			status: ["closed", "dropped"],
		});
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
			status: "developed",
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

	it("needs_info sends the reader to the decision below, with a provide-info action", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "needs_info" }),
			undefined,
			undefined,
		);
		expect(b?.cta.kind).toBe("provide-info");
		expect(b?.whoMustAct).toMatch(/is below/);
		expect(b?.whoMustAct).not.toMatch(/comment/i);
	});

	describe("waiting → the authored kind (RFC 0002 INV-5)", () => {
		it("names the decision when the kind is needs_decision", () => {
			const b = deriveBlockerState(
				blockerIssue({ status: "waiting" }),
				{ stage: "waiting", waitingCause: { kind: "needs_decision" } },
				undefined,
			);
			expect(b?.cta.kind).toBe("approve");
			expect(b?.reason).toContain("decision");
		});

		it("names the missing resource when the kind is needs_resource", () => {
			const b = deriveBlockerState(
				blockerIssue({ status: "waiting" }),
				{ stage: "waiting", waitingCause: { kind: "needs_resource" } },
				undefined,
			);
			expect(b?.cta.kind).toBe("approve");
			expect(b?.reason).toContain("only a person can supply");
		});

		it("falls back to generic human-needed copy when no kind was authored", () => {
			const b = deriveBlockerState(
				blockerIssue({ status: "waiting" }),
				undefined,
				undefined,
			);
			expect(b?.cta.kind).toBe("approve");
			expect(b?.reason).toContain("A human is needed");
			expect(b?.reason).not.toContain("decision");
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
		const needsInfo = deriveBlockerState(
			blockerIssue({ status: "needs_info" }),
			undefined,
			undefined,
		);
		const waiting = deriveBlockerState(
			blockerIssue({ status: "waiting" }),
			{ waitingCause: { kind: "needs_decision" } } as never,
			undefined,
		);
		expect(needsInfo?.tone).toBe("attention");
		expect(waiting?.tone).toBe("attention");
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

describe("statusesFromParam", () => {
	it("names exactly the statuses the parameter carries", () => {
		expect(statusesFromParam("waiting,needs_info,on_hold")).toEqual([
			"waiting",
			"needs_info",
			"on_hold",
		]);
	});

	it("drops a status the lifecycle does not have, keeping the rest", () => {
		expect(statusesFromParam("open,banana,closed")).toEqual(["open", "closed"]);
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
