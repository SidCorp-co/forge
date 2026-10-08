
import {
	AUTONOMOUS_LABELS,
	type AutonomousLabel,
	ISSUE_STATUS_LABELS,
	LABEL_TO_KERNEL,
	statusesForLabels,
	type WritableLabel,
} from "@forge/contracts/issue-vocabulary";
import {
	REGISTRY_ISSUE_STATUSES,
	type StatusExits,
} from "@forge/contracts/pipeline-registry";
import {
	LABEL_WORK_STATE,
	WORK_STATE_LABELS,
	WORK_STATES,
	type WorkState,
} from "@forge/contracts/work-state";
import {
	BLOCKER_SETTLED_STATUSES,
	BLOCKER_SHIPPED_STATUSES,
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
	IssueOrigin,
	IssuePark,
	IssuePriority,
	IssueRow,
	IssueStatus,
	ParkOwes,
	PipelineHealth,
	StepDurationRow,
	StepHandoffRow,
} from "./types";

export const STATUS_LABELS: Record<IssueStatus, string> = ISSUE_STATUS_LABELS;

/** A board column head begins with its work state's word, then says after a dash why it is a column of its own. */
const LABEL_QUALIFIER: Partial<Record<AutonomousLabel, string>> = {
	unheld: "no check-in",
	needs_human: "needs an answer",
	paused: "on hold",
	reopened: "reopened",
	done: "closed",
	dropped: "dropped",
};

const LABEL_WORDS = Object.fromEntries(
	AUTONOMOUS_LABELS.map((label) => {
		const state = WORK_STATE_LABELS[LABEL_WORK_STATE[label]];
		const qualifier = LABEL_QUALIFIER[label];
		return [label, qualifier ? `${state} — ${qualifier}` : state];
	}),
) as Record<AutonomousLabel, string>;

export const NO_CHECK_IN_CHIP = "No check-in";

const PAUSED_CHIP = statusToChip(LABEL_TO_KERNEL.paused);

/**
 * How each lane label is shown: its word, `StatusKey` and colour. The status→label map and the
 * order live in `@forge/contracts`. `unheld` is written as no status, so it takes paused's colour.
 */
export const LABEL_VIEW: Record<
	AutonomousLabel,
	{ label: string; status: StatusKey; tone: SemanticTone }
> = {
	...(Object.fromEntries(
		(Object.keys(LABEL_TO_KERNEL) as WritableLabel[]).map((label) => {
			const status = statusToChip(LABEL_TO_KERNEL[label]);
			return [
				label,
				{ label: LABEL_WORDS[label], status, tone: STATUS_KEY_TONE[status] },
			];
		}),
	) as Record<WritableLabel, { label: string; status: StatusKey; tone: SemanticTone }>),
	unheld: { label: LABEL_WORDS.unheld, status: PAUSED_CHIP, tone: STATUS_KEY_TONE[PAUSED_CHIP] },
};

export const PRIORITY_LABELS: Record<IssuePriority, string> = {
	critical: "Critical",
	high: "High",
	medium: "Medium",
	low: "Low",
	none: "None",
};

export const COMPLEXITY_LABELS: Record<IssueComplexity, string> = {
	xs: "XS",
	s: "Small",
	m: "Medium",
	l: "Large",
	xl: "XL",
};

/** The issue's own status, written out: one word per kernel status, all 17 distinct. Every surface that REPORTS a status takes this one. */
export const statusLabel = (s: IssueStatus): string => STATUS_LABELS[s] ?? s;
export const priorityLabel = (p: IssuePriority): string =>
	PRIORITY_LABELS[p] ?? p;
export const complexityLabel = (
	c: IssueComplexity | null | undefined,
): string => (c ? (COMPLEXITY_LABELS[c] ?? c) : "—");

/** The issue's lifecycle status as a design-kit `StatusKey`. The agent run's state is a different fact with its own chip: `runStatusChip`. */
export function statusToChip(status: IssueStatus): StatusKey {
	switch (status) {
		case "in_progress":
		case "reopen":
			return "running";
		case "open":
		case "confirmed":
		case "clarified":
		case "approved":
		case "draft":
			return "queued";
		case "waiting":
		case "needs_info":
			return "waiting";
		case "developed":
		case "testing":
			return "review";
		case "tested":
			return "passed";
		case "awaiting_release":
			return "shipped";
		case "releasing":
			return "review";
		case "closed":
		case "dropped":
			return "archived";
		case "on_hold":
			return "paused";
		default:
			return "queued";
	}
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
 * An absent map — the read is in flight, or it failed, or the server predates
 * `statusExits` — yields NO targets. It is never widened back to the enum:
 * offering fifteen moves from a terminal issue, three of them statuses
 * nothing dispatches at, is what ISS-982 removed.
 */
export function allowedTransitions(
	exits: StatusExits | undefined,
	from: IssueStatus,
): IssueStatus[] {
	return [...(exits?.[from] ?? [])];
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
   BOUNCE_TARGETS is deliberately not core's HUMAN_PARK_STATUSES for the same reason: the grouping
   follows what the menu offers from a rung, which core's terminal set does not decide. */
const DISCARD_TARGETS = new Set<IssueStatus>(["closed", "dropped"]);

const KIND_ORDER: TransitionKind[] = ["forward", "bounce", "discard"];

/**
 * The rung's targets as the menu draws them: forward first, then the bounces,
 * then the discards, each group in the order core declared it. A row's FIRST
 * exit is its forward move whatever set it belongs to, which is what keeps
 * `releasing → closed` out of the discard group.
 */
export function groupedTransitions(
	exits: StatusExits | undefined,
	from: IssueStatus,
): GroupedTransition[] {
	const row = allowedTransitions(exits, from);
	const kindOf = (to: IssueStatus, i: number): TransitionKind => {
		if (i === 0) return "forward";
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

/** A move target has no holder, so it is named by its own status word, never by the word of a column it only seems to sit in (ISS-1213). */
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
		const allowed = allowedTransitions(exits, r.status);
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

export function depCounts(deps: IssueDependencies | undefined): DepCounts {
	if (!deps) return { blockedBy: 0, blocks: 0, subtasks: 0, hasParent: false };
	const blockedBy = deps.incoming.filter((e) => e.kind === "blocks").length;
	const blocks = deps.outgoing.filter((e) => e.kind === "blocks").length;
	const isParentEdge = (k: IssueDependencyEdge["kind"]) =>
		k === "decomposes" || k === "parent";
	const subtasks = deps.outgoing.filter((e) => isParentEdge(e.kind)).length;
	const hasParent = deps.incoming.some((e) => isParentEdge(e.kind));
	return { blockedBy, blocks, subtasks, hasParent };
}

export function filterToQueryParams(filter: IssueFilter): { workState?: WorkState } {
	return filter === "all" ? {} : { workState: filter };
}

/** A strip segment's count; All is the six summed, so the segments add up to it. */
export function filterCount(
	filter: IssueFilter,
	buckets: { byWorkState: Record<WorkState, number> },
): number {
	if (filter === "all") {
		return WORK_STATES.reduce((n, s) => n + (buckets.byWorkState[s] ?? 0), 0);
	}
	return buckets.byWorkState[filter] ?? 0;
}

/** What a link's `?status=` parameters name: the statuses the lifecycle has, and the words it does not. */
export interface StatusFilterParams {
	statuses: IssueStatus[] | undefined;
	unknown: string[];
}

/**
 * Every `?status=` parameter of a link, repeated or comma-joined, read whole: each status the
 * lifecycle has narrows the list, and each word it does not have is returned by name so the page
 * can say it was not applied rather than drop it.
 */
export function statusFilterFromParams(
	values: readonly string[],
): StatusFilterParams {
	const known = new Set<string>(REGISTRY_ISSUE_STATUSES);
	const seen = new Set<string>();
	const statuses: IssueStatus[] = [];
	const unknown: string[] = [];
	for (const value of values) {
		for (const part of value.split(",")) {
			const s = part.trim();
			if (!s || seen.has(s)) continue;
			seen.add(s);
			if (known.has(s)) statuses.push(s as IssueStatus);
			else unknown.push(s);
		}
	}
	return { statuses: statuses.length > 0 ? statuses : undefined, unknown };
}

export const VALID_ISSUE_ORIGINS: readonly IssueOrigin[] = ["detector", "human"];

export interface OriginParams {
	origin: IssueOrigin | undefined;
	dropped: string[];
	first: string;
	firstUnknown: boolean;
}

/** The Source filter takes one source: a link naming several reads the first (`first`, and `origin` where it is one the filter offers) and returns the rest by name in `dropped`. */
export function originFromParams(values: readonly string[]): OriginParams {
	const first = values[0] ?? "";
	const origin = (VALID_ISSUE_ORIGINS as readonly string[]).includes(first)
		? (first as IssueOrigin)
		: undefined;
	const dropped = [...new Set(values.slice(1).filter((o) => o !== first))];
	return { origin, dropped, first, firstUnknown: first !== "" && origin === undefined };
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
 *  lockstep here; a session whose last heartbeat is older than this is the same
 *  "stale" the server uses before marking it failed. */
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
	| "resume"
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
	/** The rung the park recorded, which the `resume-park` CTA moves to. Set only alongside that kind. */
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
export const PARK_OWES_COPY: Record<ParkOwes | "unstated", { reason: string; who: string }> = {
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
	unstated: {
		reason: "This issue is stopped until a person acts, and it did not say for what.",
		who: "Read what it waits on in the thread, then resume it or move it on.",
	},
};

/** The banner once a question asked in the thread has a person's answer on it. */
export const ANSWERED_COPY = {
	reason: "The question this issue asked has an answer on the thread.",
	who: "Resume it where it stopped once the answer is enough to go on.",
};

export const NOTHING_TO_RESUME_AT =
	"Nothing says where this issue picks up again — Move anyway… in the status menu lists every move.";

function parkBlocker(park: IssuePark, blockingRefs: BlockingRef[]): BlockerState {
	const answered = threadQuestionOf(park)?.answer ? ANSWERED_COPY : null;
	const copy = answered ?? PARK_OWES_COPY[park.owes ?? "unstated"];
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
const SHIPPED_BLOCKERS: ReadonlySet<string> = new Set(BLOCKER_SHIPPED_STATUSES);

/** Whether the blocker's status releases this edge's dependent: `shipped` edges wait for close. */
const releasesDependent = (edge: IssueDependencyEdge): boolean => {
	const releasing =
		edge.holdsUntil === "shipped" ? SHIPPED_BLOCKERS : SETTLED_BLOCKERS;
	return Boolean(edge.fromStatus && releasing.has(edge.fromStatus));
};

/** Incoming `blocks` edges whose blocker core has not settled — i.e. this issue is genuinely
 *  blocked-by one Forge will not dispatch past. Exported so list/board rows can flag a
 *  genuinely-stuck issue (danger chip) without re-deriving the rule. */
export function openBlockingRefs(
	deps: IssueDependencies | undefined,
): BlockingRef[] {
	if (!deps) return [];
	return deps.incoming
		.filter(
			(e) => e.kind === "blocks" && !releasesDependent(e),
		)
		.map((e) => ({
			id: e.fromIssueId,
			displayId: e.fromDisplayId ?? `#${e.fromIssueId.slice(0, 6)}`,
			title: e.fromTitle ?? null,
			status: e.fromStatus ?? null,
		}));
}

/**
 * Derive the single blocker verdict for an issue, or `null` when it is actively
 * progressing. Precedence (richest signal first): a paused run → the park view
 * (every park shape, and an open question at any rung) → on_hold →
 * pipelineHealth capacity/dep waits → open `blocks` edges.
 *
 * ISS-393 removed the manual-hold failure card: a mechanically-failed job now
 * reverts the issue to its stage entry-status (auto re-dispatch) or parks it at
 * `waiting` for human review — both already covered by the branches below.
 */
export function deriveBlockerState(
	issue: Pick<IssueDetail, "status">,
	pipelineHealth: PipelineHealth | undefined,
	deps: IssueDependencies | undefined,
	/** The park view: what a person owes this issue, read once for the banner and the status control. */
	park: ParkReading = NO_PARK,
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

	if (statusesForLabels("needs_human").includes(issue.status)) {
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
		return {
			tone: "info",
			reason: "The issue is paused.",
			whoMustAct: "An operator can resume it when the work is wanted again.",
			cta: { label: "Resume", kind: "resume" },
			...(blockingRefs.length ? { blockingRefs } : {}),
		};
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
		return {
			tone: "info",
			reason: `Blocked by ${blockingRefs.length} open issue${blockingRefs.length > 1 ? "s" : ""}.`,
			whoMustAct: "Finish the blocking issue(s) first.",
			cta: { label: "Open blocking issue", kind: "open-blocker" },
			blockingRefs,
		};
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
