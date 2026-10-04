
import {
	DONE_ISSUE_STATUSES,
	ISSUE_PRIORITY_LABELS,
	ISSUE_STATUS_HINTS,
	PARKABLE_ISSUE_STATUSES,
	PARKED_ISSUE_STATUSES,
	ISSUE_STATUS_LABELS,
	ISSUE_STATUS_TONES,
	type IssueStatusTone,
	WORK_STEP_LABELS,
	type WorkStep,
} from "@forge/contracts/issue-vocabulary";
import type { IssueStanding } from "@forge/contracts/issue-standing";
import {
	REGISTRY_ISSUE_STATUSES,
	type StatusExits,
} from "@forge/contracts/pipeline-registry";
import {
	BLOCKER_SETTLED_STATUSES,
	REASON_REQUIRED_ISSUE_STATUSES,
} from "@forge/contracts/status-sets";
import {
	type SemanticTone,
	STATUS_KEY_TONE,
	type StatusKey,
} from "@/design/status";
import { gateView, pausedRunView } from "./waiting";
import type {
	CommentKind,
	GroupBy,
	IssueAgentSession,
	IssueAgentStatus,
	IssueComplexity,
	IssueDependencies,
	IssueDependencyEdge,
	IssueDetail,
	IssueFilter,
	IssuePark,
	IssuePriority,
	IssueRow,
	IssueStatus,
	IssueWorkStateRow,
	ParkOwes,
	PipelineHealth,
	StepDurationRow,
	StepHandoffRow,
} from "./types";

export const STATUS_LABELS: Record<IssueStatus, string> = ISSUE_STATUS_LABELS;

export const PRIORITY_LABELS: Record<IssuePriority, string> = ISSUE_PRIORITY_LABELS;

export const COMPLEXITY_LABELS: Record<IssueComplexity, string> = {
	xs: "XS",
	s: "Small",
	m: "Medium",
	l: "Large",
	xl: "XL",
};

/** The issue's own status, written out: one word per status, all ten distinct. Every surface that REPORTS a status takes this one. */
export const statusLabel = (s: IssueStatus): string => STATUS_LABELS[s] ?? s;
export const priorityLabel = (p: IssuePriority): string =>
	PRIORITY_LABELS[p] ?? p;
export const complexityLabel = (
	c: IssueComplexity | null | undefined,
): string => (c ? (COMPLEXITY_LABELS[c] ?? c) : "—");

export const statusHint = (s: IssueStatus): string => ISSUE_STATUS_HINTS[s] ?? s;

/** `in_progress` at step `test` reads "In progress · Test"; a step is never guessed from a status. */
export function statusStepLabel(
	status: IssueStatus,
	step: WorkStep | null | undefined,
): string {
	const word = statusLabel(status);
	return status === "in_progress" && step ? `${word} · ${WORK_STEP_LABELS[step]}` : word;
}

export const workStepOf = (row: {
	workState?: Pick<IssueWorkStateRow, "step"> | null;
}): WorkStep | null => row.workState?.step ?? null;

export const TONE_CHIP: Record<IssueStatusTone, StatusKey> = {
	neutral: "queued",
	ready: "passed",
	run: "running",
	you: "waiting",
	blocked: "blocked",
	done: "archived",
	err: "failed",
};

export function toneChip(tone: IssueStatusTone): StatusKey {
	return TONE_CHIP[tone];
}

/** The issue's lifecycle status as a design-kit `StatusKey`. The agent run's state is a different fact with its own chip: `runStatusChip`. */
export function statusToChip(status: IssueStatus): StatusKey {
	return TONE_CHIP[ISSUE_STATUS_TONES[status]] ?? "queued";
}

/** What an issue carries about its run: the sessions' verdict and the pipeline's queued job. */
export interface RunReadingSource {
	agentStatus?: IssueAgentStatus;
	pipelineHealth?: PipelineHealth;
}

/**
 * The agent run's state as a session-domain `StatusKey`, or null when no run has one to show — the
 * one reading every run chip draws from. A job no runner has claimed yet has no session, so
 * `agentStatus` alone reads it as no run; `pipelineHealth.queuedStep` is what says it is queued.
 */
export function runStatusChip({ agentStatus, pipelineHealth }: RunReadingSource): StatusKey | null {
	if (agentStatus === "running") return "running";
	if (agentStatus === "queued" || pipelineHealth?.queuedStep) return "queued";
	if (agentStatus === "completed") return "done";
	if (agentStatus === "failed") return "failed";
	if (agentStatus === "cancelled") return "archived";
	return null;
}

/** Whether the run's reading says an agent is working or waiting to. */
export const isLiveRun = (chip: StatusKey | null): chip is "running" | "queued" =>
	chip === "running" || chip === "queued";

export function statusToTone(status: IssueStatus): SemanticTone {
	return STATUS_KEY_TONE[statusToChip(status)];
}

/**
 * The targets a rung may move to, read off core's exits table as the pipeline
 * registry served it (`useStatusExits`). The row arrives in its declared
 * order and is returned in it: the first entry is the rung's forward move.
 *
 * An absent map (in flight, failed, or an older server) yields NO targets — never the whole enum
 * (ISS-982). A park's return to the status it left comes first, from `parkReturnTargets`.
 */
export function allowedTransitions(
	exits: StatusExits | undefined,
	from: IssueStatus,
	leftStatus: IssueStatus | null = null,
): IssueStatus[] {
	const row = exits?.[from];
	if (!row) return [];
	return [...parkReturnTargets(from, leftStatus), ...row];
}

/** Core's `parkExitTargets` less the table's row: the left status, or any parkable one where none is recorded. */
export function parkReturnTargets(
	from: IssueStatus,
	leftStatus: IssueStatus | null | undefined,
): IssueStatus[] {
	if (!PARKED_ISSUE_STATUSES.includes(from)) return [];
	return leftStatus ? [leftStatus] : [...PARKABLE_ISSUE_STATUSES];
}

/** How a target reads against the rung it is offered from. */
export type TransitionKind = "forward" | "bounce" | "discard";

export interface GroupedTransition {
	to: IssueStatus;
	kind: TransitionKind;
	/** First of its kind in the menu — the renderer draws a rule above it. */
	startsGroup: boolean;
}

const BOUNCE_TARGETS = new Set<IssueStatus>(["needs_info", "on_hold", "reopen"]);
/* status-tuple: differs — this is the transition MENU's discard group, not core's
   ISSUE_TERMINAL_STATUSES. It answers which exits the menu draws under one rule, and its sibling
   BOUNCE_TARGETS is deliberately not core's PARK_STATUSES for the same reason: the grouping
   follows what the menu offers from a rung, which core's terminal set does not decide. */
const DISCARD_TARGETS = new Set<IssueStatus>(["closed", "dropped"]);

const KIND_ORDER: TransitionKind[] = ["forward", "bounce", "discard"];

/**
 * The rung's targets as the menu draws them: forward first, then the bounces,
 * then the discards, each group in the order core declared it. A row's FIRST
 * exit is its forward move whatever set it belongs to, which is what keeps
 * `awaiting_release → closed` out of the discard group.
 */
export function groupedTransitions(
	exits: StatusExits | undefined,
	from: IssueStatus,
	leftStatus: IssueStatus | null = null,
): GroupedTransition[] {
	const row = allowedTransitions(exits, from, leftStatus);
	const back = new Set(parkReturnTargets(from, leftStatus));
	const kindOf = (to: IssueStatus, i: number): TransitionKind => {
		if (i === 0 || back.has(to)) return "forward";
		if (BOUNCE_TARGETS.has(to)) return "bounce";
		if (DISCARD_TARGETS.has(to)) return "discard";
		return "forward";
	};
	const typed = row.map((to, i) => ({ to, kind: kindOf(to, i) }));
	const out: GroupedTransition[] = [];
	for (const kind of KIND_ORDER) {
		let first = true;
		for (const t of typed) {
			if (t.kind !== kind) continue;
			out.push({ ...t, startsGroup: first && out.length > 0 });
			first = false;
		}
	}
	return out;
}

/** A move target has no holder, so it is named by its own status word, never "Running" (ISS-1213). */
export function transitionLabels(targets: IssueStatus[]): string[] {
	return targets.map(statusLabel);
}

export function bulkAllowedStatuses(
	exits: StatusExits | undefined,
	rows: IssueRow[],
): IssueStatus[] {
	if (rows.length === 0) return [];
	let common: IssueStatus[] | null = null;
	for (const r of rows) {
		const allowed = allowedTransitions(exits, r.status, r.workState?.leftStatus ?? null);
		if (common === null) {
			common = allowed;
		} else {
			const allowedSet = new Set(allowed);
			common = common.filter((s) => allowedSet.has(s));
		}
	}
	return (common ?? []).filter((s) => !BULK_HAS_NO_REASON_TO_COLLECT.has(s));
}

const BULK_HAS_NO_REASON_TO_COLLECT: ReadonlySet<string> = new Set(
	REASON_REQUIRED_ISSUE_STATUSES,
);

export interface DepCounts {
	blockedBy: number;
	blocks: number;
	/** Outgoing `decomposes` edges — this issue is an epic with N subtasks. */
	subtasks: number;
	/** Any incoming `decomposes` edge — this issue is a subtask of an epic. */
	hasParent: boolean;
}

/** The edges still in force. A retracted (expired) edge is shown greyed where relations are
 *  listed, and is never counted, badged or called blocking. */
export function liveDependencies(deps: IssueDependencies | undefined): IssueDependencies {
	if (!deps) return { incoming: [], outgoing: [] };
	return {
		incoming: deps.incoming.filter((e) => !e.expired),
		outgoing: deps.outgoing.filter((e) => !e.expired),
	};
}

export function depCounts(deps: IssueDependencies | undefined): DepCounts {
	if (!deps) return { blockedBy: 0, blocks: 0, subtasks: 0, hasParent: false };
	const live = liveDependencies(deps);
	const blockedBy = live.incoming.filter((e) => e.kind === "blocks").length;
	const blocks = live.outgoing.filter((e) => e.kind === "blocks").length;
	const isParentEdge = (k: IssueDependencyEdge["kind"]) =>
		k === "decomposes" || k === "parent";
	const subtasks = live.outgoing.filter((e) => isParentEdge(e.kind)).length;
	const hasParent = live.incoming.some((e) => isParentEdge(e.kind));
	return { blockedBy, blocks, subtasks, hasParent };
}

/* The toolbar's Closed segment is the two statuses an issue is over at: the release gate
   (`awaiting_release`) is still open work to the person reading the list. */
const CLOSED_STATUSES: IssueStatus[] = [...DONE_ISSUE_STATUSES];

/** The search params one status segment of the toolbar stands for. */
export function filterToQueryParams(filter: IssueFilter): {
	status?: IssueStatus[];
	statusNot?: IssueStatus[];
} {
	if (filter === "open") return { statusNot: CLOSED_STATUSES };
	if (filter === "closed") return { status: CLOSED_STATUSES };
	return {};
}

/** How many issues a status segment holds, from the search's buckets. */
export function filterCount(
	filter: IssueFilter,
	buckets: { byStatus: Partial<Record<IssueStatus, number>> },
): number {
	let all = 0;
	let closed = 0;
	for (const [s, v] of Object.entries(buckets.byStatus)) {
		all += v ?? 0;
		if ((CLOSED_STATUSES as string[]).includes(s)) closed += v ?? 0;
	}
	return filter === "all" ? all : filter === "closed" ? closed : all - closed;
}

/**
 * The statuses named by a `?status=` parameter, or undefined where it names
 * none the lifecycle has.
 */
export function statusesFromParam(
	raw: string | null | undefined,
): IssueStatus[] | undefined {
	if (!raw) return undefined;
	const known = new Set<string>(REGISTRY_ISSUE_STATUSES);
	const seen = new Set<string>();
	const out: IssueStatus[] = [];
	for (const part of raw.split(",")) {
		const s = part.trim();
		if (!s || seen.has(s) || !known.has(s)) continue;
		seen.add(s);
		out.push(s as IssueStatus);
	}
	return out.length > 0 ? out : undefined;
}

export interface IssueGroup {
	key: string;
	label: string;
	rows: IssueRow[];
}

/** Resolve a member display label (email local-part) for grouping/avatars. */
export function memberLabel(
	assigneeId: string | null,
	members?: { userId: string; email: string }[],
): string {
	if (!assigneeId) return "Unassigned";
	const m = members?.find((x) => x.userId === assigneeId);
	return m ? m.email : assigneeId.slice(0, 8);
}

/** The creator-filter option that selects every agent's issues at once. */
export const ANY_AGENT_LABEL = "any agent";

/** ISS-756 — the ONE creator-label helper for every surface. A writer is a
 *  named account, so never a class label (ISS-1137) and never a raw id. */
export function creatorLabelOf(
	row: Pick<IssueRow, "creatorLabel" | "creatorEmail">,
): string {
	return row.creatorLabel || row.creatorEmail || "Unknown user";
}

/** Two-letter initials from an email/id, for an Avatar. */
export function initials(label: string): string {
	const at = label.indexOf("@");
	const base = at > 0 ? label.slice(0, at) : label;
	const parts = base.split(/[.\-_\s]+/).filter(Boolean);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
	return base.slice(0, 2).toUpperCase();
}

/**
 * Group rows client-side. `none` returns a single group. Within each group the
 * server-provided order is preserved (server already sorted). Group ordering is
 * deterministic (by the natural enum/status order, Unassigned last for people).
 */
export function groupRows(rows: IssueRow[], groupBy: GroupBy): IssueGroup[] {
	if (groupBy === "none") {
		return [{ key: "all", label: "All issues", rows }];
	}
	const buckets = new Map<string, IssueRow[]>();
	for (const r of rows) {
		let key: string;
		if (groupBy === "status") key = r.status;
		else if (groupBy === "priority") key = r.priority;
		else key = r.createdById;
		const arr = buckets.get(key);
		if (arr) arr.push(r);
		else buckets.set(key, [r]);
	}
	const groups: IssueGroup[] = [];
	for (const [key, groupRowsArr] of buckets) {
		const label =
			groupBy === "creator" ? creatorLabelOf(groupRowsArr[0]) : key;
		groups.push({ key, label, rows: groupRowsArr });
	}
	if (groupBy === "creator") {
		// An agent is an account with a name, not a class (ISS-1137).
		const isAgentGroup = (g: IssueGroup) => g.rows[0].creatorIsAgent;
		groups.sort((a, b) => {
			const byKind = Number(isAgentGroup(a)) - Number(isAgentGroup(b));
			return byKind !== 0 ? byKind : a.label.localeCompare(b.label);
		});
	}
	return groups;
}

/**
 * Lifecycle-kind for a comment, read from the prose markers the pipeline
 * writes. Order matters — more specific markers first.
 *
 * It read `template` (the root component name) first until 2026-09-14, when
 * the component vocabulary and that column were removed. The prose regex this
 * was meant to replace is the only reader again.
 */
function prefixKind(body: string): CommentKind {
	const b = body.toLowerCase();
	if (/^#+\s*triage|triage (report|summary)|\btriaged\b/.test(b))
		return "triage";
	if (/request changes|requesting changes|changes requested/.test(b))
		return "changes";
	if (/\bapprove\b|approved ✅|review: approve|verdict: approve/.test(b))
		return "approved";
	if (/forge-fix|^#+\s*fix\b|fix applied/.test(b)) return "fix";
	if (
		/qa test report|qa report|test report|e2e (pass|report)|verified live/.test(
			b,
		)
	)
		return "qa";
	if (/released|release note|published release|shipped/.test(b))
		return "released";
	if (
		/forge-code|plan implemented|implementation complete|code complete|pushed .* branch/.test(
			b,
		)
	)
		return "code";
	if (/plan written|^#+\s*(implementation )?plan\b|approved plan/.test(b))
		return "plan";
	if (/^#+\s*clarif|clarif(y|ication)/.test(b)) return "clarify";
	if (/^#+\s*review\b|reviewing|self-review/.test(b)) return "review";
	return "comment";
}

/**
 * Which body form answered. `component` was the other value until the
 * vocabulary was removed on 2026-09-14; the union is kept at one member rather
 * than deleted because callers report it, and a field that silently stops
 * being reported is harder to notice than one that reports the same thing.
 */
export type CommentBodyForm = "prefix";

export interface DerivedCommentKind {
	kind: CommentKind;
	form: CommentBodyForm;
}

export function deriveCommentKind(comment: { body: string }): DerivedCommentKind {
	return { kind: prefixKind(comment.body), form: "prefix" };
}

export interface ChecklistItem {
	text: string;
	checked: boolean;
}

/**
 * Parse an acceptance-criteria blob into checklist items. Recognises markdown
 * task syntax (`- [ ]` / `- [x]`), plain bullets (`-`/`*`), and bare lines.
 * Blank lines + pure markdown headings are dropped.
 */
export function parseChecklist(
	text: string | null | undefined,
): ChecklistItem[] {
	if (!text) return [];
	const items: ChecklistItem[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		if (/^#{1,6}\s/.test(line)) continue;
		const task = line.match(/^[-*]\s*\[( |x|X)\]\s*(.+)$/);
		if (task) {
			items.push({
				text: task[2].trim(),
				checked: task[1].toLowerCase() === "x",
			});
			continue;
		}
		const bullet = line.match(/^[-*]\s+(.+)$/);
		if (bullet) {
			items.push({ text: bullet[1].trim(), checked: false });
			continue;
		}
		items.push({ text: line, checked: false });
	}
	return items;
}

/** Heartbeat staleness threshold. Mirrors core's sweeper
 *  `HEARTBEAT_TIMEOUT_MS_DEFAULT = 3*60_000` (`pipeline/sweeper.ts`, env
 *  `PIPELINE_HEARTBEAT_TIMEOUT_MS`). Not env-readable from the FE, so kept in
 *  lockstep: a session older than this is the "stale" the server uses. */
export const HEARTBEAT_STALE_MS = 3 * 60_000;

export type HeartbeatState = "alive" | "stale" | "unknown";

/** Alive vs stale from a session's `lastHeartbeatAt` (AC#3). `unknown` when the
 *  field is absent (older server) or unparseable — the caller then hides the
 *  dot rather than lying about liveness. `nowMs` is injectable for tests. */
export function heartbeatState(
	lastHeartbeatAt: string | null | undefined,
	nowMs: number = Date.now(),
): HeartbeatState {
	if (!lastHeartbeatAt) return "unknown";
	const t = Date.parse(lastHeartbeatAt);
	if (Number.isNaN(t)) return "unknown";
	return nowMs - t <= HEARTBEAT_STALE_MS ? "alive" : "stale";
}

export type BlockerCtaKind =
	| "provide-info"
	| "resume-park"
	| "resume-run"
	| "open-blocker"
	| "none";

/** A blocking dependency endpoint, ready to render as a clickable ISS-x chip. */
export interface BlockingRef {
	id: string;
	displayId: string;
	title: string | null;
	status: IssueStatus | null;
	merged: boolean;
	designHold: string | null;
}

/** Single server-derived "why is it stuck" verdict for the blocker banner
 *  (AC#1/#2). Computed in ONE place from status / pipelineHealth.waitingOn /
 *  blocks edges / the park view — the component never re-joins those sources.
 *  `null` ⇒ not blocked ⇒ render nothing. */
export interface BlockerState {
	tone: "danger" | "attention" | "info";
	reason: string;
	whoMustAct: string;
	cta: { label: string; kind: BlockerCtaKind };
	/** The paused `pipeline_runs.id` the `resume-run` CTA acts on. Set only
	 *  alongside that kind. */
	runId?: string;
	/** The status the park left (`workState.leftStatus`), which the `resume-park` CTA moves to. Set only alongside that kind. */
	resumeAt?: IssueStatus;
	/** Open `blocks` issues this one is waiting on. */
	blockingRefs?: BlockingRef[];
	/** Extra context (failure classification, hold-until), Tier-2 detail. */
	detail?: string;
}

/**
 * The park view as the page holds it: still being read, unreadable, or read — where a read
 * `null` means nobody owes the issue anything (ISS-1310).
 */
export type ParkReading =
	| { state: "loading" }
	| { state: "error" }
	| { state: "ready"; park: IssuePark | null };

export const NO_PARK: ParkReading = { state: "ready", park: null };

/** Whether Answer the question has anything to take the reader to: a question nobody has answered yet. */
export function parkAsksAQuestion(park: IssuePark): boolean {
	if (park.openQuestionIds.length > 0) return true;
	const asked = threadQuestionOf(park);
	return asked !== null && asked.answer === null;
}

/** One reading as the run wrote it, `reading -> outcome`, split into the choice and where it leads. */
export interface ThreadReading {
	choice: string;
	outcome: string | null;
}

/** A question a `needs_info` issue asked only in the thread: the sentence it stopped with, why, its choices, and the answer a person gave. */
export interface ThreadQuestionView {
	prompt: string | null;
	why: string | null;
	readings: ThreadReading[];
	answer: IssuePark["answer"];
}

function readingOf(raw: string): ThreadReading {
	const at = raw.indexOf("->");
	if (at < 0) return { choice: raw.trim(), outcome: null };
	return { choice: raw.slice(0, at).trim(), outcome: raw.slice(at + 2).trim() || null };
}

/** This park's thread question, or `null` where a question row carries it or none was asked. */
export function threadQuestionOf(park: IssuePark): ThreadQuestionView | null {
	if (park.shape !== "park" || park.status !== "needs_info") return null;
	if (park.openQuestionIds.length > 0) return null;
	const prompt = park.reason ?? park.record?.why ?? null;
	if (!prompt && park.readings.length === 0) return null;
	const why = park.record?.why && park.record.why !== prompt ? park.record.why : null;
	return { prompt, why, readings: park.readings.map(readingOf), answer: park.answer ?? null };
}

/** What the person owes, in their words rather than the enum's. */
export const PARK_OWES_COPY: Record<ParkOwes, { reason: string; who: string }> = {
	information: {
		reason: "This issue is waiting for information — an answer to a question.",
		who: "Anyone on the project can answer it; the question is below.",
	},
	decision: {
		reason: "This issue is waiting for a decision — a judgement only a person can make.",
		who: "Whoever owns the call decides, then resumes it where it stopped.",
	},
	resource: {
		reason:
			"This issue is waiting for something only a person can supply — an account, a credential, or data.",
		who: "Supply it, then resume it where it stopped.",
	},
};

/** The banner once a question asked in the thread has a person's answer on it. */
export const ANSWERED_COPY = {
	reason: "The question this issue asked has an answer on the thread.",
	who: "Resume it where it stopped once the answer is enough to go on.",
};

export const NOTHING_TO_RESUME_AT =
	"Nothing says where this issue picks up again — Move anyway… in the status menu lists every move.";

/** An `on_hold` issue whose work state names no status it left: its own exits are the whole answer. */
export const NOTHING_TO_RESUME_FROM_HOLD =
	"Nothing says where this issue picks up again — the status menu lists every status it may return to.";

function parkBlocker(park: IssuePark, blockingRefs: BlockingRef[]): BlockerState {
	const answered = threadQuestionOf(park)?.answer ? ANSWERED_COPY : null;
	const copy = answered ?? PARK_OWES_COPY[park.owes];
	const refs = blockingRefs.length ? { blockingRefs } : {};
	if (parkAsksAQuestion(park)) {
		return {
			tone: "attention",
			reason: copy.reason,
			whoMustAct: PARK_OWES_COPY.information.who,
			cta: { label: "Answer it", kind: "provide-info" },
			...refs,
		};
	}
	const at = park.resume.at;
	if (at) {
		return {
			tone: "attention",
			reason: copy.reason,
			whoMustAct: copy.who,
			cta: { label: `Resume at ${statusLabel(at)}`, kind: "resume-park" },
			resumeAt: at,
			...refs,
		};
	}
	return {
		tone: "attention",
		reason: copy.reason,
		whoMustAct: copy.who,
		cta: { label: "", kind: "none" },
		detail: NOTHING_TO_RESUME_AT,
		...refs,
	};
}

const SETTLED_BLOCKERS: ReadonlySet<string> = new Set(BLOCKER_SETTLED_STATUSES);

/** Incoming `blocks` edges whose blocker core has not settled — i.e. this issue is genuinely
 *  blocked-by one Forge will not dispatch past. Exported so list/board rows can flag a
 *  genuinely-stuck issue (danger chip) without re-deriving the rule. */
export function openBlockingRefs(
	deps: IssueDependencies | undefined,
): BlockingRef[] {
	if (!deps) return [];
	return liveDependencies(deps)
		.incoming.filter(
			(e) =>
				e.kind === "blocks" &&
				!(
					e.fromStatus &&
					SETTLED_BLOCKERS.has(e.fromStatus) &&
					!e.fromDesignHold
				),
		)
		.map((e) => ({
			id: e.fromIssueId,
			displayId: e.fromDisplayId ?? `#${e.fromIssueId.slice(0, 6)}`,
			title: e.fromTitle ?? null,
			status: e.fromStatus ?? null,
			merged: Boolean(e.fromMergedAt),
			designHold: e.fromDesignHold ?? null,
		}));
}

// cm:why a blocker whose change has landed holds its dependents until its criteria pass (ISS-54), so
// what holds this issue is that blocker's judge, never "finish the blocking issue" (ISS-80). Which
// blocker waits on a judge is core's standing fact (`IssueEdgeRef.landed`), never re-derived here.
function blocksBlocker(blockingRefs: BlockingRef[], judged: ReadonlySet<string>): BlockerState {
	const keys = blockingRefs.map((r) => r.displayId).join(", ");
	const one = blockingRefs.length === 1;
	if (blockingRefs.every((r) => r.designHold)) {
		return {
			tone: "info",
			reason: `Blocked by ${keys}, which ${one ? "delivers a design" : "deliver designs"} not yet approved: ${blockingRefs.map((r) => r.designHold).join("; ")}.`,
			whoMustAct: `The design approver decides the revision ${keys} ${one ? "delivers" : "deliver"}; this issue is released once it is approved.`,
			cta: { label: "Open blocking issue", kind: "open-blocker" },
			blockingRefs,
		};
	}
	if (blockingRefs.every((r) => judged.has(r.displayId))) {
		return {
			tone: "info",
			reason: `Blocked by ${keys}, which ${one ? "has" : "have"} landed and ${one ? "waits" : "wait"} on a judge.`,
			whoMustAct: `A judge records a verdict on each criterion of ${keys}; this issue is released once ${one ? "it passes" : "they pass"}.`,
			cta: { label: "Open blocking issue", kind: "open-blocker" },
			blockingRefs,
		};
	}
	return {
		tone: "info",
		reason: `Blocked by ${blockingRefs.length} open issue${one ? "" : "s"}.`,
		whoMustAct: "Finish the blocking issue(s) first.",
		cta: { label: "Open blocking issue", kind: "open-blocker" },
		blockingRefs,
	};
}

function onHoldBlocker(
	leftStatus: IssueStatus | null | undefined,
	blockingRefs: BlockingRef[],
): BlockerState {
	const refs = blockingRefs.length ? { blockingRefs } : {};
	const base = {
		tone: "info" as const,
		reason: "The issue is paused.",
		whoMustAct: "An operator can resume it when the work is wanted again.",
	};
	if (leftStatus) {
		return {
			...base,
			cta: { label: `Resume at ${statusLabel(leftStatus)}`, kind: "resume-park" },
			resumeAt: leftStatus,
			...refs,
		};
	}
	return { ...base, cta: { label: "", kind: "none" }, detail: NOTHING_TO_RESUME_FROM_HOLD, ...refs };
}

/**
 * Derive the single blocker verdict for an issue, or `null` when it is actively
 * progressing. Precedence (richest signal first): a paused run → the park view
 * (every park shape, and an open question at any status) → on_hold →
 * pipelineHealth capacity/dep waits → open `blocks` edges.
 *
 * A mechanically-failed job has no card of its own (ISS-393): it re-dispatches or parks at
 * `needs_info`, both covered below.
 */
export function deriveBlockerState(
	issue: Pick<IssueDetail, "status"> & {
		workState?: Pick<IssueWorkStateRow, "leftStatus"> | null;
	},
	pipelineHealth: PipelineHealth | undefined,
	deps: IssueDependencies | undefined,
	/** The park view: what a person owes this issue, read once for the banner and the status control. */
	park: ParkReading = NO_PARK,
	standing: Pick<IssueStanding, "blockedBy"> | null = null,
): BlockerState | null {
	const blockingRefs = openBlockingRefs(deps);

	const paused = pausedRunView(pipelineHealth?.pausedRun);
	if (paused) {
		return {
			tone: paused.needsAction ? "attention" : "info",
			reason: paused.reason,
			whoMustAct: paused.who,
			cta: paused.needsAction
				? { label: "Resume run", kind: "resume-run" }
				: { label: "", kind: "none" },
			...(paused.needsAction ? { runId: paused.runId } : {}),
			...(blockingRefs.length ? { blockingRefs } : {}),
		};
	}

	if (park.state === "ready" && park.park) return parkBlocker(park.park, blockingRefs);

	if (issue.status === "needs_info") {
		return {
			tone: "attention",
			reason: "This issue is stopped until a person acts.",
			whoMustAct:
				park.state === "error"
					? "What it waits on could not be read — reload the page, or read the thread."
					: "Reading what it waits on…",
			cta: { label: "", kind: "none" },
			...(blockingRefs.length ? { blockingRefs } : {}),
		};
	}

	if (issue.status === "on_hold") {
		return onHoldBlocker(issue.workState?.leftStatus, blockingRefs);
	}

	const waitingOn = pipelineHealth?.waitingOn;
	const gate = waitingOn ? gateView(waitingOn) : null;
	if (waitingOn && gate) {
		const copy = { reason: gate.detail, who: gate.who };
		return {
			tone: gate.needsAction ? "attention" : "info",
			reason: copy.reason,
			whoMustAct: copy.who,
			cta: blockingRefs.length
				? { label: "Open blocking issue", kind: "open-blocker" }
				: { label: "", kind: "none" },
			...(blockingRefs.length ? { blockingRefs } : {}),
		};
	}

	if (blockingRefs.length) {
		const judged = new Set((standing?.blockedBy ?? []).filter((b) => b.landed).map((b) => b.key));
		return blocksBlocker(blockingRefs, judged);
	}

	return null;
}

export type StepState = "done" | "running" | "failed";

/** One step an issue ACTUALLY ran, rolled up for the detail screen's steps card. */
export interface StepOutcome {
	/** The job type exactly as the kernel recorded it — never folded onto another name. */
	step: string;
	state: StepState;
	outcomeLabel?: string;
	durationSeconds?: number;
	costUsd?: number;
	handoff?: StepHandoffRow;
	/** When this step last ran, for ordering. */
	ranAt: string;
}

function truncate(s: string, max: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Pull a short, human one-liner from a free-form handoff payload. Tries the
 *  stable fields first, then any string field; never throws on a missing/odd
 *  shape (AC#4 graceful fallback). */
export function handoffOutcomeLabel(
	payload: Record<string, unknown> | null | undefined,
): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const preferred = [
		"outcome",
		"summary",
		"verdict",
		"result",
		"planSummary",
		"rootCauseHypothesis",
	];
	for (const k of preferred) {
		const v = payload[k];
		if (typeof v === "string" && v.trim()) return truncate(v, 90);
	}
	for (const v of Object.values(payload)) {
		if (typeof v === "string" && v.trim()) return truncate(v, 90);
	}
	return undefined;
}

/**
 * The step an issue is RUNNING right now, read off the kernel's own active session — or `null`.
 *
 * A session the kernel calls `queued` names a step nobody has started, so it names no running step.
 */
export function runningStepOf(
	health: PipelineHealth | null | undefined,
): string | null {
	const session = health?.activeSession;
	return session?.status === "running" ? session.skill : null;
}

/**
 * The steps this issue ran, from the rows that record them.
 *
 * One entry per job type carried on a `step_handoffs` or `step_durations` row, ordered by when it
 * last ran. A job type outside the seven staged names keeps its own name; `drive` is one, and on an
 * autonomous project it is the only one. Durations and cost are summed across the attempts of the
 * most recent RUN of that step, and the latest attempt's handoff is attached.
 */
export function deriveStepOutcomes(
	handoffs: StepHandoffRow[] | undefined,
	durations: StepDurationRow[] | undefined,
	live?: { activeStep?: string | null; failedStep?: string | null },
): StepOutcome[] {
	const handoffByStep = new Map<string, StepHandoffRow>();
	for (const row of handoffs ?? []) {
		const prev = handoffByStep.get(row.step);
		if (
			!prev ||
			row.updatedAt > prev.updatedAt ||
			(row.updatedAt === prev.updatedAt && row.attempt > prev.attempt)
		) {
			handoffByStep.set(row.step, row);
		}
	}

	const byStepRun = new Map<
		string,
		Map<string, { durationSeconds: number; costUsd: number; latest: string }>
	>();
	for (const row of durations ?? []) {
		const runs = byStepRun.get(row.step) ?? new Map();
		const acc = runs.get(row.runId) ?? {
			durationSeconds: 0,
			costUsd: 0,
			latest: "",
		};
		acc.durationSeconds += row.durationSeconds ?? 0;
		acc.costUsd += row.costUsd ?? 0;
		if ((row.finishedAt ?? row.startedAt ?? "") > acc.latest)
			acc.latest = row.finishedAt ?? row.startedAt ?? "";
		runs.set(row.runId, acc);
		byStepRun.set(row.step, runs);
	}

	const outcomes: StepOutcome[] = [];
	for (const step of new Set([...handoffByStep.keys(), ...byStepRun.keys()])) {
		const handoff = handoffByStep.get(step);
		let pick:
			| { durationSeconds: number; costUsd: number; latest: string }
			| undefined;
		for (const acc of byStepRun.get(step)?.values() ?? []) {
			if (!pick || acc.latest > pick.latest) pick = acc;
		}
		const state: StepState =
			live?.failedStep === step
				? "failed"
				: live?.activeStep === step
					? "running"
					: "done";
		outcomes.push({
			step,
			state,
			ranAt: pick?.latest || handoff?.updatedAt || "",
			...(handoff
				? { handoff, outcomeLabel: handoffOutcomeLabel(handoff.payload) }
				: {}),
			...(pick && pick.durationSeconds > 0
				? { durationSeconds: pick.durationSeconds }
				: {}),
			...(pick && pick.costUsd > 0 ? { costUsd: pick.costUsd } : {}),
		});
	}
	return outcomes.sort((a, b) => a.ranAt.localeCompare(b.ranAt));
}

/** Known session-group keys → humanized labels. The label set is data-driven:
 *  any unknown key (a project may define its own groups) gets a Title-Case
 *  fallback so the raw `sessionGroup` value never reaches the UI (AC8). */
const SESSION_GROUP_LABELS: Record<string, string> = {
	build: "Build",
	planning: "Planning",
	verify: "Verify",
};

/** Title-case a raw group key as a fallback (`new-group` → "New Group"). */
function titleCase(key: string): string {
	return key
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(" ");
}

export function humanizeSessionGroup(key: string | null | undefined): string {
	if (!key) return "Session";
	return SESSION_GROUP_LABELS[key] ?? titleCase(key);
}

/** Whether a step reused the prior same-group Claude session, started a new one,
 *  or carries too little metadata to tell (legacy rows → no badge). */
export type SessionContinuity = "resumed" | "fresh" | "unknown";

/** Why a step is `fresh` rather than `resumed` — surfaced in operator detail. */
export type FreshReason =
	| "first-in-group"
	| "different-device"
	| "prior-failed"
	| "new-session";

/** One row of the session-continuity timeline — a pure projection of an
 *  `IssueAgentSession`. Holds both the humanized labels (default view) and the
 *  short raw ids (operator expand); the component decides what to show. */
export interface SessionTimelineEntry {
	id: string;
	/** Pipeline step label (`metadata.jobType`), e.g. `plan` / `review`. */
	jobType: string | null;
	/** Raw group key (`metadata.sessionGroup`) — for keys, never rendered. */
	group: string | null;
	/** Humanized group label (`Build` / `Verify` / …). */
	groupLabel: string | null;
	claudeSessionId: string | null;
	claudeShort: string | null;
	deviceId: string | null;
	deviceShort: string | null;
	/** ISS-411 — friendly runner name (`devices.name`); null on a pre-411 server
	 *  or when the device row is gone. The UI prefers this over `deviceShort`. */
	deviceName: string | null;
	status: string;
	startedAt: string | null;
	continuity: SessionContinuity;
	/** Set only when `continuity === 'fresh'`. */
	freshReason: FreshReason | null;
	/** True when this entry shares a Claude session with the entry directly above
	 *  it (drives the solid connector); false at a `fresh session` break. */
	connectedToPrev: boolean;
}

function metaString(
	meta: Record<string, unknown> | null,
	key: string,
): string | null {
	const v = meta?.[key];
	return typeof v === "string" && v.trim() ? v : null;
}

/** Best chronological timestamp for ordering. The hydrator returns sessions
 *  `updatedAt desc`; we sort ascending by the earliest available start time. */
function startMs(s: IssueAgentSession): number {
	const iso = s.startedAt ?? s.createdAt ?? s.updatedAt;
	const t = iso ? Date.parse(iso) : NaN;
	return Number.isNaN(t) ? 0 : t;
}

export function deriveSessionTimeline(
	sessions: IssueAgentSession[] | null | undefined,
): SessionTimelineEntry[] {
	if (!sessions || sessions.length === 0) return [];
	const ordered = [...sessions].sort((a, b) => startMs(a) - startMs(b));

	const lastByGroup = new Map<
		string,
		{ claude: string; deviceId: string | null; status: string }
	>();
	let prevClaude: string | null = null;
	const entries: SessionTimelineEntry[] = [];

	for (const s of ordered) {
		const group = metaString(s.metadata, "sessionGroup");
		const jobType = metaString(s.metadata, "jobType");
		const claude = s.claudeSessionId ?? null;
		const deviceId = s.deviceId ?? null;

		let continuity: SessionContinuity;
		let freshReason: FreshReason | null = null;

		if (!group || !claude) {
			continuity = "unknown";
		} else {
			const prior = lastByGroup.get(group);
			if (!prior) {
				continuity = "fresh";
				freshReason = "first-in-group";
			} else if (prior.claude === claude) {
				continuity = "resumed";
			} else {
				continuity = "fresh";
				freshReason =
					prior.deviceId !== deviceId
						? "different-device"
						: prior.status === "failed"
							? "prior-failed"
							: "new-session";
			}
			lastByGroup.set(group, { claude, deviceId, status: s.status });
		}

		entries.push({
			id: s.id,
			jobType,
			group,
			groupLabel: group ? humanizeSessionGroup(group) : null,
			claudeSessionId: claude,
			claudeShort: claude ? claude.slice(0, 8) : null,
			deviceId,
			deviceShort: deviceId ? deviceId.slice(0, 8) : null,
			deviceName: s.deviceName ?? null,
			status: s.status,
			startedAt: s.startedAt ?? s.createdAt ?? null,
			continuity,
			freshReason,
			connectedToPrev: !!claude && claude === prevClaude,
		});

		prevClaude = claude;
	}

	return entries;
}

/** Human copy for a fresh-reason (operator detail, AC8). */
export const FRESH_REASON_COPY: Record<FreshReason, string> = {
	"first-in-group": "First step in this session group",
	"different-device": "Ran on a different device (device-pin drift)",
	"prior-failed": "Prior session in this group failed",
	"new-session": "Started a new Claude session",
};

/** Display metadata for each comment kind badge. */
export const COMMENT_KIND_META: Record<
	CommentKind,
	{
		label: string;
		tone: "neutral" | "accent" | "cobalt" | "green" | "red" | "amber";
	}
> = {
	triage: { label: "Triage", tone: "cobalt" },
	clarify: { label: "Clarify", tone: "cobalt" },
	plan: { label: "Plan", tone: "cobalt" },
	code: { label: "Code", tone: "accent" },
	review: { label: "Review", tone: "amber" },
	changes: { label: "Changes", tone: "red" },
	fix: { label: "Fix", tone: "accent" },
	approved: { label: "Approved", tone: "green" },
	qa: { label: "QA", tone: "amber" },
	released: { label: "Released", tone: "green" },
	outcome: { label: "Outcome", tone: "accent" },
	blocked: { label: "Blocked", tone: "red" },
	comment: { label: "Comment", tone: "neutral" },
};

// ISS-1160 — a display key collides across projects; the fetched row's uuid never does.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonicalIssueId(rawId: string, fetchedId: string | undefined): string | undefined {
	return UUID_RE.test(rawId) ? rawId : fetchedId;
}

export function issueQueryKey(id: string | undefined, projectId: string | undefined): readonly unknown[] {
	return !id || UUID_RE.test(id) ? ["issue", id] : ["issue", id, projectId];
}
