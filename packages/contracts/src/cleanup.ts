// Fast delivery's records (REQ-79): the impact the building agent rates its change at, the cleanup
// debt it leaves for the cleanup lane, and the report a cleanup run writes. Agents record all three;
// core keeps them and reads them where a release asks, and never infers what an agent did
// (`VISION: state-never-lies`).
//
// A rating is the change's system impact by type: `type` is the landing surface it touches
// (`./landing-artifacts.ts`), `rating` low, medium or high, high covering severe. A change rated high
// lands and ships on its build like any other, and the audit owes it a cleanup report (BC-5); a red
// rated high is no debt at all, it holds its issue (BC-3).

import { z } from "zod";
import { wholeShaSchema } from "./check-runs.js";
import {
	LANDING_SURFACE_LABELS,
	type LandingSurface,
} from "./landing-artifacts.js";
import type { ScheduleRunStatus } from "./schedules.js";

/** The surfaces a changed path can map to: every landing surface but `design` and `adoption`. */
type PathSurface = Exclude<LandingSurface, "design" | "adoption">;

/**
 * What a change can touch, by the surface a path maps to. Listed as a tuple because the database
 * CHECK reads one; `satisfies` holds each to a landing surface, and `IMPACT_TYPE_LABELS` (keyed by
 * every path surface) fails the build where a surface is added there and not here.
 */
export const IMPACT_TYPES = [
	"ui",
	"api",
	"logic",
	"data",
	"config",
	"runner",
] as const satisfies readonly PathSurface[];
export type ImpactType = (typeof IMPACT_TYPES)[number];

/** Each impact type's label, the landing surface's own. */
export const IMPACT_TYPE_LABELS: Readonly<Record<PathSurface, string>> =
	Object.fromEntries(
		IMPACT_TYPES.map((t) => [t, LANDING_SURFACE_LABELS[t]]),
	) as Record<ImpactType, string> satisfies Record<PathSurface, string>;

export const IMPACT_RATINGS = ["low", "medium", "high"] as const;
export type ImpactRating = (typeof IMPACT_RATINGS)[number];

/** The rating that counts: a change rated so is owed a cleanup report by the audit, a red rated so holds its issue. */
export const HOLDING_RATING: ImpactRating = "high";

const LIMITS = {
	reason: 600,
	where: 500,
	detail: 2000,
	check: 200,
	items: 50,
	listed: 500,
} as const;

const text = (what: string, max: number) =>
	z
		.string()
		.trim()
		.min(1, `${what} says it in words`)
		.max(max, `${what} is at most ${max} characters`);

export const impactSchema = z.strictObject({
	type: z.enum(IMPACT_TYPES, {
		error: (issue) =>
			`impact type ${JSON.stringify(issue.input)} is not a surface a change touches: it is one of ${IMPACT_TYPES.join(", ")}`,
	}),
	rating: z.enum(IMPACT_RATINGS, {
		error: (issue) =>
			`impact rating ${JSON.stringify(issue.input)} is not a rating: it is low, medium or high (high covers severe)`,
	}),
	reason: text("the rating's reason", LIMITS.reason),
});
export type Impact = z.infer<typeof impactSchema>;

/** `POST /api/issues/:id/impact`: the building agent's rating of its change, and the commit it rated. */
export const recordImpactRequestSchema = impactSchema.extend({
	commit: wholeShaSchema("commit").optional(),
});
export type RecordImpactRequest = z.infer<typeof recordImpactRequestSchema>;

/** `red`: a check that ended red; `debt`: code left worse than it should be; `simplify`: room to cut. */
export const DEBT_KINDS = ["red", "debt", "simplify"] as const;
export type DebtKind = (typeof DEBT_KINDS)[number];

export const debtItemSchema = z
	.strictObject({
		kind: z.enum(DEBT_KINDS),
		/** The check, suite or CI job that ended red; a red names one. */
		check: text("check", LIMITS.check).optional(),
		/** Where it is: the files, module or suite. */
		where: text("where", LIMITS.where),
		detail: text("detail", LIMITS.detail),
		impact: impactSchema,
	})
	.refine((d) => d.kind !== "red" || d.check !== undefined, {
		path: ["check"],
		message: "a red names the check, suite or CI job that ended red",
	});
export type DebtItem = z.infer<typeof debtItemSchema>;

export const debtItemsSchema = z.array(debtItemSchema).min(1).max(LIMITS.items);

/** `POST /api/projects/:id/debts`: debt an agent saw, on the issue it was working where it had one. */
export const recordDebtsRequestSchema = z.strictObject({
	issue: z.string().trim().min(1).max(200).optional(),
	items: debtItemsSchema,
});
export type RecordDebtsRequest = z.infer<typeof recordDebtsRequestSchema>;

/**
 * `POST /api/projects/:id/debts/:debt/carry` (BC-10): a debt no change can clear, carried as a priced
 * amnesty. A carried debt still remains on every report until it is cleared, and never turns one red.
 */
export const carryDebtRequestSchema = z.strictObject({
	trades: text("trades", LIMITS.reason),
	costs: text("costs", LIMITS.reason),
	endsWhen: text("endsWhen", LIMITS.reason),
});
export type CarryDebtRequest = z.infer<typeof carryDebtRequestSchema>;

/**
 * `POST /api/projects/:id/debts/:debt/evidence` (ISS-839): what someone found about an open debt, kept
 * on it in their name, which every later cleanup brief and ledger read carries.
 */
export const debtEvidenceRequestSchema = z.strictObject({
	evidence: text("evidence", LIMITS.detail),
});
export type DebtEvidenceRequest = z.infer<typeof debtEvidenceRequestSchema>;

/** One piece of evidence on a debt: what it says, who gave it, when. */
export interface DebtEvidenceView {
	evidence: string;
	by: string | null;
	at: string;
}

export const CLEANUP_RESULTS = ["green", "red"] as const;
export type CleanupResult = (typeof CLEANUP_RESULTS)[number];

/**
 * `POST /api/projects/:id/cleanup-reports` (BC-9): what one cleanup run cleared, what remains and why.
 * Every debt open when it reports is named once, in `cleared` or `remains`. A report covers no
 * change: the audit holds none, so the strict body refuses a `covers` key by name (ISS-1057).
 * `base.sha` is checked against the project's source host: a commit on `base.branch` there, or the
 * report is refused (ISS-912). A later report naming the same `fire` supersedes the one before it,
 * which is kept and reads as superseded.
 */
export const cleanupReportRequestSchema = z.strictObject({
	fire: z
		.uuid("fire is the id of the schedule fire that started this run")
		.optional(),
	base: z.strictObject({
		branch: z.string().trim().min(1).max(200),
		sha: wholeShaSchema("base.sha"),
	}),
	result: z.enum(CLEANUP_RESULTS),
	ci: z.url().max(500).optional(),
	cleared: z
		.array(z.strictObject({ debt: z.uuid(), how: text("how", LIMITS.reason) }))
		.max(LIMITS.listed),
	remains: z
		.array(z.strictObject({ debt: z.uuid(), why: text("why", LIMITS.reason) }))
		.max(LIMITS.listed),
});
export type CleanupReportRequest = z.infer<typeof cleanupReportRequestSchema>;

export const CLEANUP_REFUSAL_CODES = [
	"CLEANUP_REFUSED",
	"FAST_DELIVERY_OFF",
	"DEBT_RED_HOLDS_THE_ISSUE",
	"CLEANUP_REPORT_INCOMPLETE",
	"CLEANUP_DEBT_UNKNOWN",
	"CLEANUP_DEBT_NAMED_TWICE",
	"CLEANUP_RESULT_DISAGREES",
	"CLEANUP_BASE_NOT_ON_BRANCH",
	"CLEANUP_BASE_UNCHECKABLE",
] as const;
export type CleanupRefusalCode = (typeof CLEANUP_REFUSAL_CODES)[number];

/** Why a cleanup fire started nothing, recorded as its refusal (`schedule_runs.refusal`). */
export const CLEANUP_FIRE_REFUSALS = [
	"FAST_DELIVERY_OFF",
	"CLEANUP_RUN_LIVE",
	/** Nothing else is owed and what landed on the base since the last report cannot be read (ISS-1050). */
	"CLEANUP_BASE_UNCHECKABLE",
] as const;

/** The cleanup window a project admin turns on, as the ledger suggests it: end of day, UTC (ISS-1049). */
export const CLEANUP_WINDOW_DEFAULT = {
	cron: "0 18 * * *",
	timeZone: null,
	name: "Cleanup window",
} as const;

export interface ImpactView {
	id: string;
	issueId: string;
	type: ImpactType;
	rating: ImpactRating;
	reason: string;
	commit: string | null;
	ratedBy: string | null;
	ratedAt: string;
}

export interface DebtView {
	id: string;
	issueId: string | null;
	issueKey: string | null;
	kind: DebtKind;
	check: string | null;
	where: string;
	detail: string;
	impact: Impact;
	recordedBy: string | null;
	recordedAt: string;
	cleared: { reportId: string; how: string; at: string } | null;
	/** The priced amnesty it is carried under (BC-10), or null. */
	carried: (CarryDebtRequest & { by: string | null; at: string }) | null;
	/** What was found about it, oldest first (ISS-839). */
	evidence: DebtEvidenceView[];
}

export interface CleanupReportView {
	id: string;
	fireId: string | null;
	base: { branch: string; sha: string };
	result: CleanupResult;
	ci: string | null;
	cleared: { debt: string; how: string }[];
	remains: { debt: string; why: string }[];
	reportedBy: string | null;
	reportedAt: string;
	/** The later report from the same fire that stands in its place, or null while it is current (ISS-912). */
	supersededBy: string | null;
}

/** `GET /api/projects/:id/cleanup-reports`: current reports only, unless `superseded=include` asks for every one. */
export const cleanupReportsQuerySchema = z.strictObject({
	superseded: z
		.literal("include", {
			error:
				"superseded is `include`, which lists superseded reports beside the current ones",
		})
		.optional(),
});
export type CleanupReportsQuery = z.infer<typeof cleanupReportsQuerySchema>;

/**
 * A cleanup window's newest fire (ISS-1058), from the schedule's own fire record: `running` since
 * `startedAt`, or how it ended, and whether a cleanup report names it. `error` is why it failed, as
 * the fire records it (a run that ended without its report says so there).
 */
export interface CleanupWindowRun {
	status: ScheduleRunStatus;
	startedAt: string;
	finishedAt: string | null;
	reported: boolean;
	error: string | null;
}

/** `GET /api/projects/:id/debts`: the ledger and the window. */
export interface DebtLedgerView {
	fast: boolean;
	open: DebtView[];
	cleared: DebtView[];
	window: {
		scheduleId: string;
		cron: string;
		timeZone: string | null;
		enabled: boolean;
		nextRunAt: string | null;
		lastRun: CleanupWindowRun | null;
	} | null;
	/** Where no window is on (none, or one disabled), that said plainly with who turns one on; null where it is on (ISS-1049). */
	windowOff: string | null;
}
