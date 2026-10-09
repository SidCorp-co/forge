// The filters the chat may set on each list beside it (REQ-41 BC-4, BC-5, BC-7). One shape for every
// list: a closed set of fields per list, each held in one URL query param, so the page, the chat's
// action and the orange "set by the assistant" mark all read the same param. Every list filters by
// whom a row waits on, read from its standing by `waitingFilterOf`, never from the row's prose.

import { z } from "zod";
import {
	FEEDBACK_KINDS,
	FEEDBACK_PHASES,
	FEEDBACK_SEVERITIES,
} from "./feedback.js";
import { ISSUE_STATUSES } from "./issue-machine.js";
import { REGISTRY_ISSUE_PRIORITIES } from "./pipeline-registry.js";
import { RELEASE_STATES } from "./releases.js";
import { REQUIREMENT_STATES } from "./requirements.js";
import type { StandingGroup, WaitingKind } from "./standing.js";

/** Who a row waits on, as a list filters it (BC-5): the viewer, an agent, or work that is running. */
export const UI_WAITING_FILTERS = ["you", "agent", "running"] as const;
export type UiWaitingFilter = (typeof UI_WAITING_FILTERS)[number];

const AGENT_KINDS: readonly WaitingKind[] = ["agent", "master", "judge"];
/** A row waits on running work when a run holds it or it waits on its issues being worked. */
const RUNNING_KINDS: readonly WaitingKind[] = ["run", "issue", "feedback"];
const RUNNING_GROUPS: readonly StandingGroup[] = ["running", "moving"];

/**
 * The waiting filter a row answers to, from its standing alone; null where it waits on someone the
 * three do not name (another person, a release, a gate, nobody), which only an unfiltered list shows.
 * `you` is the read model's own verdict for the viewer, so it is never guessed from a name.
 */
export function waitingFilterOf(s: {
	attentionGroup?: StandingGroup;
	waitingOn: { kind: WaitingKind };
}): UiWaitingFilter | null {
	const kind = s.waitingOn.kind;
	if (kind === "you") return "you";
	if (AGENT_KINDS.includes(kind)) return "agent";
	if (RUNNING_KINDS.includes(kind)) return "running";
	if (
		s.attentionGroup !== undefined &&
		RUNNING_GROUPS.includes(s.attentionGroup)
	)
		return "running";
	return null;
}

/** How far back a list reaches by the time a row was filed. */
export const UI_SINCE = ["1d", "7d", "30d"] as const;
export type UiSince = (typeof UI_SINCE)[number];
const SINCE_DAYS: Record<UiSince, number> = { "1d": 1, "7d": 7, "30d": 30 };

/** Whether a row filed at `at` falls inside `since`, read against `now`. */
export const withinSince = (since: UiSince, at: Date, now: Date): boolean =>
	now.getTime() - at.getTime() <= SINCE_DAYS[since] * 86_400_000;

const text = z.string().trim().min(1).max(200);
const waitingOn = z.enum(UI_WAITING_FILTERS);
const many = <T extends readonly [string, ...string[]]>(values: T) =>
	z.array(z.enum(values)).min(1);

/** Every list the chat can filter, with its fields. Issues keeps the fields ui.issues.filter has always had. */
export const UI_LIST_FILTERS = {
	issues: z.strictObject({
		status: many(ISSUE_STATUSES).optional(),
		priority: z.enum(REGISTRY_ISSUE_PRIORITIES).optional(),
		createdBy: z.literal("me").optional(),
		assignee: z.literal("me").optional(),
		waitingOn: waitingOn.optional(),
		text: text.optional(),
	}),
	requirements: z.strictObject({
		waitingOn: waitingOn.optional(),
		state: many(REQUIREMENT_STATES).optional(),
		text: text.optional(),
	}),
	feedback: z.strictObject({
		waitingOn: waitingOn.optional(),
		phase: many(FEEDBACK_PHASES).optional(),
		kind: many(FEEDBACK_KINDS).optional(),
		severity: z.enum(FEEDBACK_SEVERITIES).optional(),
		since: z.enum(UI_SINCE).optional(),
		text: text.optional(),
	}),
	workflows: z.strictObject({
		waitingOn: waitingOn.optional(),
		text: text.optional(),
	}),
	releases: z.strictObject({
		waitingOn: waitingOn.optional(),
		state: many(RELEASE_STATES).optional(),
		text: text.optional(),
	}),
} as const;
export type UiList = keyof typeof UI_LIST_FILTERS;
export const UI_LISTS = Object.keys(UI_LIST_FILTERS) as [UiList, ...UiList[]];
export type UiListFilter<L extends UiList> = z.infer<
	(typeof UI_LIST_FILTERS)[L]
>;

/**
 * The URL query param each field lives in, the same on every list: the page reads it, the chat's
 * action writes it, and the assistant's mark compares against it (BC-7). `text` is the `q` the list
 * search already writes; a multi-valued field joins its values with a comma.
 */
export const UI_FILTER_PARAMS = {
	status: "status",
	priority: "priority",
	createdBy: "createdBy",
	assignee: "assignee",
	waitingOn: "waiting",
	state: "state",
	phase: "phase",
	kind: "kind",
	severity: "severity",
	since: "since",
	text: "q",
} as const;
export type UiFilterField = keyof typeof UI_FILTER_PARAMS;

/**
 * A filter action's params over one filter schema: `merge` keeps the filter the person sees and
 * changes only the named fields, `replace` drops every field it does not set. A field is never both
 * set and cleared, and a merge that names nothing is refused, so an action always changes what it says.
 */
export function listFilterParamsOf<S extends z.ZodObject>(filter: S) {
	const fields = Object.keys(filter.shape) as [
		keyof S["shape"] & string,
		...(keyof S["shape"] & string)[],
	];
	return z
		.strictObject({
			mode: z.enum(["merge", "replace"]),
			set: (filter as z.ZodObject).default({}) as unknown as z.ZodDefault<S>,
			clear: z.array(z.enum(fields)).max(fields.length).default([]),
		})
		.refine(
			(v) =>
				Object.keys(v.set as object).length > 0 ||
				v.clear.length > 0 ||
				v.mode === "replace",
			{
				message: "a merge must set or clear at least one field",
			},
		)
		.refine((v) => !v.clear.some((f) => f in (v.set as object)), {
			message: "a field cannot be both set and cleared",
		});
}

/** The filter action's params for one list (`ui.<list>.filter`). */
export const uiListFilterParams = <L extends UiList>(list: L) =>
	listFilterParamsOf(UI_LIST_FILTERS[list]);

/** What the person sees on a Product list, as the page reports it with each message (BC-8). */
export const uiListFilterSnapshotSchema = z.discriminatedUnion("list", [
	z.strictObject({
		list: z.literal("requirements"),
		filter: UI_LIST_FILTERS.requirements,
	}),
	z.strictObject({
		list: z.literal("feedback"),
		filter: UI_LIST_FILTERS.feedback,
	}),
	z.strictObject({
		list: z.literal("workflows"),
		filter: UI_LIST_FILTERS.workflows,
	}),
	z.strictObject({
		list: z.literal("releases"),
		filter: UI_LIST_FILTERS.releases,
	}),
]);
export type UiListFilterSnapshot = z.infer<typeof uiListFilterSnapshotSchema>;

const WAITING_WORDS: Record<UiWaitingFilter, string> = {
	you: "waiting on you",
	agent: "waiting on an agent",
	running: "running",
};

/** A filter as the words "Sees" reads, field by field in declaration order. */
export function describeListFilter(filter: Record<string, unknown>): string[] {
	const parts: string[] = [];
	for (const [field, value] of Object.entries(filter)) {
		if (value === undefined) continue;
		if (field === "waitingOn")
			parts.push(WAITING_WORDS[value as UiWaitingFilter]);
		else if (field === "createdBy") parts.push("created by me");
		else if (field === "assignee") parts.push("assigned to me");
		else if (field === "text") parts.push(`"${String(value)}"`);
		else if (field === "since") parts.push(`since ${String(value)}`);
		else
			parts.push(
				`${field} ${Array.isArray(value) ? value.join("/") : String(value)}`,
			);
	}
	return parts;
}

/**
 * A list's filter as its URL holds it: each field read from its one param (`UI_FILTER_PARAMS`), so
 * the list narrows by exactly what the chat's action wrote and the mark compares against. A value a
 * field does not take is left out, as an unknown URL choice reads as its default. `createdBy` and
 * `assignee` hold a person's id in the URL and "me" in the filter, so only the caller that knows
 * the signed-in id reads them.
 */
export function listFilterFromSearch<L extends UiList>(
	list: L,
	search: string | URLSearchParams,
): UiListFilter<L> {
	const sp = typeof search === "string" ? new URLSearchParams(search) : search;
	const shape = UI_LIST_FILTERS[list].shape as Record<string, z.ZodType>;
	const out: Record<string, unknown> = {};
	for (const [field, schema] of Object.entries(shape)) {
		if (field === "createdBy" || field === "assignee") continue;
		const raw = sp.get(UI_FILTER_PARAMS[field as UiFilterField])?.trim();
		if (!raw) continue;
		const one = schema.safeParse(raw);
		if (one.success && one.data !== undefined) {
			out[field] = one.data;
			continue;
		}
		const each = raw
			.split(",")
			.map((v) => v.trim())
			.filter((v) => schema.safeParse([v]).success);
		if (each.length > 0) out[field] = each;
	}
	return out as UiListFilter<L>;
}

/** What a list row shows of itself, as every list's filter reads it. */
export interface UiListRowFacts {
	/** `waitingFilterOf` the row's standing. */
	waiting: UiWaitingFilter | null;
	/** What the list's search reads: its key and title, and whatever else that list searches. */
	text: string;
	state?: string | undefined;
	status?: string | undefined;
	priority?: string | undefined;
	phase?: string | undefined;
	kind?: string | undefined;
	severity?: string | undefined;
	/** When the row was filed, for `since`. */
	createdAt?: string | undefined;
}

const MATCHED_FIELDS = new Set([
	"waitingOn",
	"text",
	"state",
	"status",
	"priority",
	"phase",
	"kind",
	"severity",
	"since",
]);

/**
 * Whether one row stays on a list under `filter`. A field this function does not read (`createdBy`,
 * `assignee`, which need the signed-in id) is refused by name rather than passed over, so a filter
 * the person sees is never one the list silently ignores.
 */
export function matchesListFilter(
	filter: Record<string, unknown>,
	row: UiListRowFacts,
	now: Date = new Date(),
): boolean {
	for (const [field, value] of Object.entries(filter)) {
		if (value === undefined) continue;
		if (!MATCHED_FIELDS.has(field))
			throw new Error(
				`matchesListFilter does not read "${field}": the list that offers it narrows by it itself, against the signed-in id`,
			);
		if (field === "waitingOn") {
			if (row.waiting !== value) return false;
		} else if (field === "text") {
			if (!row.text.toLowerCase().includes(String(value).trim().toLowerCase()))
				return false;
		} else if (field === "since") {
			if (
				!row.createdAt ||
				!withinSince(value as UiSince, new Date(row.createdAt), now)
			)
				return false;
		} else {
			const own = row[field as keyof UiListRowFacts];
			const allowed = Array.isArray(value) ? value : [value];
			if (typeof own !== "string" || !allowed.includes(own)) return false;
		}
	}
	return true;
}
