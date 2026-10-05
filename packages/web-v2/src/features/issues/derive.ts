
import {
	ISSUE_STATUSES,
	ISSUE_TERMINAL_STATUSES,
} from "@forge/contracts/issue-machine";
import { ISSUE_PRIORITY_LABELS, ISSUE_STATUS_LABELS, ISSUE_STATUS_TONES, type IssueStatusTone, WORK_STEP_LABELS, type WorkStep } from "@forge/contracts/issue-vocabulary";
import {
	type SemanticTone,
	STATUS_KEY_TONE,
	type StatusKey,
} from "@/design/status";
import type { CommentKind, FreshReason, GroupBy, IssueAgentSession, IssueAgentStatus, IssueComplexity, IssueDependencies, IssueFilter, IssuePark, IssuePriority, IssueRow, IssueStatus, IssueWorkStateRow, PipelineHealth, SessionContinuity } from "./types";

const STATUS_LABELS: Record<IssueStatus, string> = ISSUE_STATUS_LABELS;

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

const TONE_CHIP: Record<IssueStatusTone, StatusKey> = {
	neutral: "queued",
	ready: "passed",
	run: "running",
	you: "waiting",
	blocked: "blocked",
	done: "archived",
	err: "failed",
};
/** The issue's lifecycle status as a design-kit `StatusKey`. The agent run's state is a different fact with its own chip: `runStatusChip`. */
export function statusToChip(status: IssueStatus): StatusKey {
	return TONE_CHIP[ISSUE_STATUS_TONES[status]] ?? "queued";
}

/** What an issue carries about its run: the sessions' verdict and the pipeline's queued job. */
interface RunReadingSource {
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

/** A move target has no holder, so it is named by its own status word, never "Running" (ISS-1213). */
export function transitionLabels(targets: IssueStatus[]): string[] {
	return targets.map(statusLabel);
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
/* The toolbar's Closed segment is the two statuses an issue is over at: the release gate
   (`awaiting_release`) is still open work to the person reading the list. */
const CLOSED_STATUSES: IssueStatus[] = [...ISSUE_TERMINAL_STATUSES];

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
	const known = new Set<string>(ISSUE_STATUSES);
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

interface IssueGroup {
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
type CommentBodyForm = "prefix";

interface DerivedCommentKind {
	kind: CommentKind;
	form: CommentBodyForm;
}

export function deriveCommentKind(comment: { body: string }): DerivedCommentKind {
	return { kind: prefixKind(comment.body), form: "prefix" };
}

interface ChecklistItem {
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

/**
 * The park view as the page holds it: still being read, unreadable, or read — where a read
 * `null` means nobody owes the issue anything (ISS-1310).
 */
export type ParkReading =
	| { state: "loading" }
	| { state: "error" }
	| { state: "ready"; park: IssuePark | null };
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

function humanizeSessionGroup(key: string | null | undefined): string {
	if (!key) return "Session";
	return SESSION_GROUP_LABELS[key] ?? titleCase(key);
}

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

/** Core's sessions oldest first, labelled for the timeline; continuity is core's. */
export function deriveSessionTimeline(
	sessions: IssueAgentSession[] | null | undefined,
): SessionTimelineEntry[] {
	if (!sessions || sessions.length === 0) return [];
	const ordered = [...sessions].sort((a, b) => startMs(a) - startMs(b));
	let prevClaude: string | null = null;
	return ordered.map((s) => {
		const group = metaString(s.metadata, "sessionGroup");
		const claude = s.claudeSessionId ?? null;
		const deviceId = s.deviceId ?? null;
		const entry: SessionTimelineEntry = {
			id: s.id,
			jobType: metaString(s.metadata, "jobType"),
			group,
			groupLabel: group ? humanizeSessionGroup(group) : null,
			claudeSessionId: claude,
			claudeShort: claude ? claude.slice(0, 8) : null,
			deviceId,
			deviceShort: deviceId ? deviceId.slice(0, 8) : null,
			deviceName: s.deviceName ?? null,
			status: s.status,
			startedAt: s.startedAt ?? s.createdAt ?? null,
			continuity: s.continuity,
			freshReason: s.freshReason,
			connectedToPrev: !!claude && claude === prevClaude,
		};
		prevClaude = claude;
		return entry;
	});
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
