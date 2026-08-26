import { describe, expect, it } from "vitest";
import { STATUS_KEY_TONE } from "@/design/status";
import {
	allowedTransitions,
	bulkAllowedStatuses,
	COMMENT_KIND_META,
	COMPLEXITY_LABELS,
	complexityLabel,
	creatorLabelOf,
	depCounts,
	deriveBlockerState,
	deriveCommentKind,
	deriveStageOutcomes,
	FORGE_AGENT_LABEL,
	filterToQueryParams,
	groupRows,
	HEARTBEAT_STALE_MS,
	heartbeatState,
	initials,
	memberLabel,
	PRIORITY_LABELS,
	parseChecklist,
	priorityLabel,
	STATUS_LABELS,
	statusLabel,
	statusLabelFor,
	statusToChip,
	statusToRun,
	statusToStage,
	statusToTone,
} from "./derive";
import type {
	IssueDependencies,
	IssueDependencyEdge,
	IssueDetail,
	IssueRow,
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
		description: over.description ?? null,
		status: over.status ?? "open",
		priority: over.priority ?? "none",
		category: over.category ?? null,
		complexity: over.complexity ?? null,
		assigneeId: over.assigneeId ?? null,
		createdById: over.createdById ?? "owner-1",
		creatorEmail: over.creatorEmail ?? "owner@example.com",
		creatorIsAgent: over.creatorIsAgent ?? false,
		creatorLabel: over.creatorLabel ?? "owner@example.com",
		parentIssueId: over.parentIssueId ?? null,
		reopenCount: over.reopenCount ?? 0,
		mergedAt: over.mergedAt ?? null,
		createdAt: over.createdAt ?? "2026-01-01T00:00:00.000Z",
		updatedAt: over.updatedAt ?? "2026-01-01T00:00:00.000Z",
		agentSessions: over.agentSessions,
		agentStatus: over.agentStatus,
	};
}

describe("statusToStage", () => {
	it("maps lifecycle statuses to pipeline stages", () => {
		expect(statusToStage("open")).toBe("triage");
		expect(statusToStage("approved")).toBe("plan");
		expect(statusToStage("in_progress")).toBe("code");
		expect(statusToStage("developed")).toBe("review");
		expect(statusToStage("testing")).toBe("test");
		expect(statusToStage("released")).toBe("release");
	});
});

describe("statusToRun", () => {
	it("prefers a live agent status over the lifecycle status", () => {
		expect(statusToRun("approved", "running")).toBe("running");
		expect(statusToRun("approved", "queued")).toBe("queued");
		expect(statusToRun("developed", "failed")).toBe("failed");
	});
	it("falls back to a status-derived run state with no agent", () => {
		expect(statusToRun("released")).toBe("done");
		expect(statusToRun("developed")).toBe("review");
		expect(statusToRun("on_hold")).toBe("blocked");
		expect(statusToRun("in_progress")).toBe("running");
		expect(statusToRun("open")).toBe("queued");
	});
});

describe("statusToChip", () => {
	it("maps live agent status first", () => {
		expect(statusToChip("approved", "running")).toBe("running");
		expect(statusToChip("approved", "queued")).toBe("queued");
	});
	it("maps lifecycle status to a kit StatusKey", () => {
		expect(statusToChip("in_progress")).toBe("running");
		expect(statusToChip("waiting")).toBe("waiting");
		expect(statusToChip("tested")).toBe("passed");
		expect(statusToChip("on_hold")).toBe("paused");
	});
	it("splits the terminal/gate tail into distinct keys (ISS-511)", () => {
		expect(statusToChip("tested")).toBe("passed");
		expect(statusToChip("released")).toBe("shipped");
		expect(statusToChip("closed")).toBe("archived");
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
		// No ISSUE status is a real failure — only a failed job/session is red.
		for (const s of ISSUE_STATUSES) {
			expect(statusToTone(s), s).not.toBe("failure");
		}
	});

	it("reconciles the statuses that used to disagree across dashboards", () => {
		expect(statusToTone("reopen")).toBe("active"); // was red "blocked/failed" on one dashboard
		expect(statusToTone("on_hold")).toBe("blocked"); // calm ink, NOT red
		expect(statusToTone("needs_info")).toBe("attention"); // amber, a human must act
	});
});

describe("allowedTransitions", () => {
	it("never offers draft as a target, nor the current status", () => {
		const from = allowedTransitions("approved");
		expect(from).not.toContain("draft");
		expect(from).not.toContain("approved");
		// permissive guard: every non-draft status is reachable from a live state
		expect(from).toContain("in_progress");
		expect(from).toContain("on_hold");
		expect(from).toContain("reopen");
	});
	it("restricts draft to promote, direct-ship, or discard (ISS-431)", () => {
		expect(allowedTransitions("draft")).toEqual([
			"open",
			"developed",
			"closed",
		]);
	});
});

describe("bulkAllowedStatuses (ISS-463)", () => {
	it("returns [] for an empty selection", () => {
		expect(bulkAllowedStatuses([])).toEqual([]);
	});
	it("matches allowedTransitions when every row shares a status, less the reason-required three", () => {
		const rows = [
			row({ id: "a", status: "approved" }),
			row({ id: "b", status: "approved" }),
		];
		expect(bulkAllowedStatuses(rows)).toEqual(
			allowedTransitions("approved").filter(
				(s) => s !== "reopen" && s !== "waiting" && s !== "needs_info",
			),
		);
	});
	// cm:guard the bulk endpoint carries no reason, so offering these three mass-422s the selection (RFC 0002 INV-8) — and a single reason pasted across N issues is the unexplained park the RFC deleted, so the fix is to withhold them, never to send a shared one
	it("never offers a status that requires an authored reason", () => {
		const rows = [
			row({ id: "a", status: "in_progress" }),
			row({ id: "b", status: "developed" }),
		];
		const result = bulkAllowedStatuses(rows);
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
		const result = bulkAllowedStatuses(rows);
		// a target is offered only if valid for BOTH rows
		for (const s of result) {
			expect(allowedTransitions("open")).toContain(s);
			expect(allowedTransitions("approved")).toContain(s);
		}
		// never the current status of either row, never draft
		expect(result).not.toContain("open");
		expect(result).not.toContain("approved");
		expect(result).not.toContain("draft");
		// a commonly-valid target survives
		expect(result).toContain("on_hold");
	});
	it("narrows hard when a draft row is in the mix (draft only allows open/developed/closed)", () => {
		const rows = [
			row({ id: "a", status: "draft" }),
			row({ id: "b", status: "approved" }),
		];
		// draft allows [open, developed, closed]; approved excludes its own status
		// but allows open/developed/closed → intersection is exactly those three.
		expect(bulkAllowedStatuses(rows)).toEqual(["open", "developed", "closed"]);
	});
	it("preserves enum order in the result", () => {
		const rows = [
			row({ id: "a", status: "open" }),
			row({ id: "b", status: "confirmed" }),
		];
		const result = bulkAllowedStatuses(rows);
		const sorted = [...result].sort(
			(x, y) => ISSUE_STATUSES.indexOf(x) - ISSUE_STATUSES.indexOf(y),
		);
		expect(result).toEqual(sorted);
	});
});

describe("label helpers", () => {
	it("humanizes status / priority / complexity (no raw enum leaks)", () => {
		expect(statusLabel("in_progress")).toBe("In progress");
		expect(statusLabelFor("in_progress", "autonomous")).toBe("Running");
		expect(statusLabelFor("in_progress", "staged")).toBe("In progress");
		expect(statusLabelFor("needs_info", "autonomous")).toBe("Needs a human");

		expect(statusLabel("needs_info")).toBe("Needs info");
		expect(priorityLabel("critical")).toBe("Critical");
		expect(complexityLabel("xs")).toBe("XS");
		expect(complexityLabel("m")).toBe("Medium");
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
	it("review targets the verification band", () => {
		expect(filterToQueryParams("review").status).toContain("developed");
		expect(filterToQueryParams("review").status).toContain("testing");
	});
	it("blocked targets parked statuses", () => {
		expect(filterToQueryParams("blocked")).toEqual({
			status: ["on_hold", "needs_info"],
		});
	});
	// ISS-438 — explicit Draft + Done buckets.
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
	it("done targets shipped work (released + closed)", () => {
		expect(filterToQueryParams("done")).toEqual({
			status: ["released", "closed"],
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
	it("groups by creator, distinct group per creator, agent group last", () => {
		const mixed = [
			...rows,
			row({
				id: "d",
				createdById: "u3",
				creatorIsAgent: true,
				creatorLabel: FORGE_AGENT_LABEL,
			}),
		];
		const g = groupRows(mixed, "creator");
		expect(g.map((x) => x.key)).toEqual(["u1", "u2", "__agent__"]);
		expect(g[0].label).toBe("ann@x.co");
		expect(g[1].label).toBe("bob@x.co");
		expect(g[g.length - 1].label).toBe(FORGE_AGENT_LABEL);
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
				creatorIsAgent: false,
			}),
		).toBe("ann@x.co");
	});
	it("falls back to Forge Agent for an agent row with no label", () => {
		expect(
			creatorLabelOf({
				creatorLabel: "",
				creatorEmail: null,
				creatorIsAgent: true,
			}),
		).toBe(FORGE_AGENT_LABEL);
	});
	it("never falls back to a raw id — 'Unknown user' when nothing resolves", () => {
		expect(
			creatorLabelOf({
				creatorLabel: "",
				creatorEmail: null,
				creatorIsAgent: false,
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
		expect(deriveCommentKind(body)).toBe(kind);
	});
	it("has badge meta for every kind it returns", () => {
		for (const [, kind] of cases) {
			expect(
				COMMENT_KIND_META[kind as keyof typeof COMMENT_KIND_META],
			).toBeDefined();
		}
	});
});

// ─── ISS-377 ────────────────────────────────────────────────────────────────

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

	it("needs_info shows the supplied question and a provide-info action", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "needs_info" }),
			undefined,
			undefined,
			{
				needsInfoQuestion: "Which environment?",
			},
		);
		expect(b?.cta.kind).toBe("provide-info");
		expect(b?.question).toBe("Which environment?");
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

		// cm:guard the generic arm is what makes the nullable column safe — an issue parked before `waiting_kind` existed has no kind, and a banner that guessed one is the ISS-163 failure the RFC deleted
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

		it("a dependency closed-without-merging still wins over the generic copy", () => {
			const b = deriveBlockerState(
				blockerIssue({ status: "waiting" }),
				{
					stage: "waiting",
					waitingOn: {
						reason: "waiting_on_dep",
						since: "x",
						details: {
							blockerIssueIds: ["blk-1"],
							closedUnmergedBlockerIssueIds: ["blk-1"],
						},
					},
				},
				incomingBlocks({ fromStatus: "closed" }),
			);
			expect(b?.reason).toContain("closed without");
			expect(b?.cta.kind).toBe("open-blocker");
		});
	});

	it("on_hold status → resume action", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "on_hold" }),
			undefined,
			undefined,
		);
		expect(b?.cta.kind).toBe("resume");
		expect(b?.reason).toContain("paused");
	});

	it("maps each pipelineHealth.waitingOn reason", () => {
		for (const reason of [
			"issue_busy",
			"run_not_running",
			"waiting_on_dep",
			"waiting_on_decomp_children",
			"project_full",
			"runner_stale",
			"runner_full",
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

	// cm:guard `run_not_running` and `runner_stale` must never say "No action" — a paused run and an empty runner pool are the only two queued gates that cannot clear themselves, so the reassuring copy the capacity waits use is a lie there (measured 2026-08-14: ISS-576/ISS-652 paused 3 days, 11 jobs behind dead runners up to 22)
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

	// cm:guard the two halves of `job_held` must read differently — for months this said "No action — it resumes itself" for every hold reason, while three of the five never self-release, so the UI told the reader to sit tight in front of a step that was waiting on them
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

	it("escalates closed-unmerged blockers to an operator decision with refs", () => {
		const b = deriveBlockerState(
			blockerIssue({ status: "in_progress" }),
			{
				stage: "code",
				waitingOn: {
					reason: "waiting_on_dep",
					since: "x",
					details: {
						blockerIssueIds: ["blk-1"],
						closedUnmergedBlockerIssueIds: ["blk-1"],
					},
				},
			},
			incomingBlocks({ fromStatus: "closed" }),
		);
		expect(b?.tone).toBe("attention");
		expect(b?.reason).toContain("closed without");
		expect(b?.cta.kind).toBe("open-blocker");
		expect(b?.blockingRefs?.length).toBe(1);
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
			incomingBlocks({ fromStatus: "released" }),
		);
		expect(b).toBeNull();
	});
});

describe("deriveStageOutcomes", () => {
	const handoff = (
		step: string,
		attempt: number,
		payload: Record<string, unknown>,
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

	it("marks done / current / pending around the current stage", () => {
		const cells = deriveStageOutcomes("plan", "running", [], []);
		expect(cells.triage.state).toBe("done");
		expect(cells.clarify.state).toBe("done");
		expect(cells.plan.state).toBe("current");
		expect(cells.code.state).toBe("pending");
		expect(cells.release.state).toBe("pending");
	});

	it("pulls a short outcome label + sums duration/cost from a full payload", () => {
		const cells = deriveStageOutcomes(
			"code",
			"running",
			[handoff("plan", 1, { summary: "wrote the plan" })],
			[dur("plan", 120, 0.25), dur("plan", 60, 0.1)],
		);
		expect(cells.plan.outcomeLabel).toBe("wrote the plan");
		expect(cells.plan.durationSeconds).toBe(180);
		expect(cells.plan.costUsd).toBeCloseTo(0.35);
		expect(cells.plan.handoff?.step).toBe("plan");
	});

	it("keeps the latest attempt and never throws on an empty/odd payload", () => {
		const cells = deriveStageOutcomes(
			"review",
			"running",
			[handoff("plan", 1, {}), handoff("plan", 2, { outcome: "v2" })],
			undefined,
		);
		expect(cells.plan.handoff?.attempt).toBe(2);
		expect(cells.plan.outcomeLabel).toBe("v2");
		// empty payload at the current stage → no label, no crash
		const empty = deriveStageOutcomes(
			"plan",
			"running",
			[handoff("plan", 1, {})],
			[],
		);
		expect(empty.plan.outcomeLabel).toBeUndefined();
	});

	it("marks the failing stage as error", () => {
		const cells = deriveStageOutcomes("code", "failed", [], [], "code");
		expect(cells.code.state).toBe("error");
	});

	it("keeps special test outcomes as handoff evidence without assigning current wait provenance", () => {
		const cells = deriveStageOutcomes(
			"plan",
			"queued",
			[
				handoff("test", 1, {
					result: "blocked_fixture",
					resultReason: "The shared fixture is unavailable.",
				}),
			],
			[],
		);
		expect(cells.plan.state).toBe("current");
		expect(cells.test.state).toBe("pending");
		expect(cells.test.outcomeLabel).toBe("blocked_fixture");
	});

	it("retains verified-by-test evidence on the test artifact", () => {
		const cells = deriveStageOutcomes(
			"plan",
			"queued",
			[handoff("test", 1, { result: "verified_by_test" })],
			[],
		);
		expect(cells.test.outcomeLabel).toBe("verified_by_test");
	});

	it("keeps a real failed run above a special test handoff", () => {
		const cells = deriveStageOutcomes(
			"test",
			"failed",
			[handoff("test", 1, { result: "blocked_fixture" })],
			[],
			"test",
		);
		expect(cells.test.state).toBe("error");
	});

	it("uses a newer run's handoff instead of a prior attempt", () => {
		const old = handoff("test", 2, { result: "blocked_fixture" });
		const current = {
			...handoff("test", 1, { result: "pass" }),
			pipelineRunId: "run-2",
			updatedAt: "2026-02-01T00:00:00.000Z",
		};
		const cells = deriveStageOutcomes("release", "running", [old, current], []);
		expect(cells.test.handoff?.pipelineRunId).toBe("run-2");
		expect(cells.test.state).toBe("done");
	});

	it("does not retain fixture-blocked state after completion", () => {
		const cells = deriveStageOutcomes(
			"release",
			"done",
			[handoff("test", 1, { result: "blocked_fixture" })],
			[],
		);
		expect(cells.test.state).toBe("done");
	});

it("uses only the most-recent run's duration/cost (no double-count on reopen)", () => {
		const cells = deriveStageOutcomes(
			"code",
			"running",
			[],
			[
				dur("plan", 100, 1.0, "run-old", "2026-01-01T00:05:00.000Z"),
				dur("plan", 200, 2.0, "run-new", "2026-02-01T00:05:00.000Z"),
			],
		);
		expect(cells.plan.durationSeconds).toBe(200);
		expect(cells.plan.costUsd).toBeCloseTo(2.0);
	});

	it("folds fix handoffs into the code stage", () => {
		const cells = deriveStageOutcomes(
			"review",
			"running",
			[handoff("fix", 1, { summary: "patched" })],
			[],
		);
		expect(cells.code.outcomeLabel).toBe("patched");
	});
});
