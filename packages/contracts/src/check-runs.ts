// The checks a run makes, each with its kind and its duration (REQ-36 BC-14; Issue to release r20
// `act-build` "records each check's duration on the issue", `rule-merge` "checks run with their
// durations, recorded on the issue"; ISS-474). A project's own check scripts time each check and
// write it in this shape (`scripts/lib/direct-test-run.mjs` here); `POST /api/issues/:id/checks`
// and the merge check's record (`./merge-check.ts`) keep it once per check, on the run session that
// made it, and `GET /api/issues/:id/checks` answers the time spent per kind.

import { z } from "zod";

/**
 * What a check is, in the order the issue page lists them. `conformance` is the project's
 * conformance gate (`pnpm verify` here); `base` is the check that the change contains its base's
 * latest commit. `probes` and `review` are kinds a run records when it made one: no script here
 * runs either yet (ISS-469, ISS-473).
 */
export const CHECK_KINDS = [
	"tests",
	"typecheck",
	"probes",
	"review",
	"conformance",
	"base",
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

/** `none`: the selection held nothing to run, which the check says rather than skipping silently. */
export const CHECK_RUN_RESULTS = ["pass", "fail", "none"] as const;
export type CheckRunResult = (typeof CHECK_RUN_RESULTS)[number];

/** How a check reached core: posted on its own, or inside a merge check's report. */
export const CHECK_RUN_VIAS = ["report", "merge-check"] as const;
export type CheckRunVia = (typeof CHECK_RUN_VIAS)[number];

export const CHECK_RUN_LIMITS = {
	checks: 200,
	files: 2000,
	file: 1000,
	name: 64,
	scope: 120,
	text: 500,
	/** A day: a check that ran longer was not timed, it was left running. */
	durationMs: 86_400_000,
} as const;

/** A whole git sha: what a check ran against is never a prefix that may stop naming one commit. */
export const wholeShaSchema = (what: string) =>
	z
		.string()
		.trim()
		.regex(/^[0-9a-f]{40}$/i, `${what} is a whole git sha: 40 hex characters`);

/** One check as the script that ran it timed it. `id` is the script's, so a resend is the same check. */
export const checkRunSchema = z.strictObject({
	id: z.uuid("id is the uuid the script gave this check, so sending it again adds nothing"),
	kind: z.enum(CHECK_KINDS, {
		error: `kind is one of ${CHECK_KINDS.join(", ")}`,
	}),
	name: z.string().trim().min(1).max(CHECK_RUN_LIMITS.name),
	scope: z.string().trim().max(CHECK_RUN_LIMITS.scope),
	command: z.string().max(CHECK_RUN_LIMITS.text),
	files: z.array(z.string().min(1).max(CHECK_RUN_LIMITS.file)).max(CHECK_RUN_LIMITS.files),
	result: z.enum(CHECK_RUN_RESULTS),
	durationMs: z
		.number({ error: "durationMs is how long the check ran, in whole milliseconds" })
		.int()
		.nonnegative()
		.max(CHECK_RUN_LIMITS.durationMs),
	startedAt: z.iso.datetime({ offset: true, error: "startedAt is an ISO 8601 date-time" }),
	note: z.string().max(CHECK_RUN_LIMITS.text).optional(),
});
export type CheckRun = z.infer<typeof checkRunSchema>;

const CHECK_RUN_SHAPE =
	"{ id: uuid, kind: tests | typecheck | probes | review | conformance | base, name, scope, command, files, result: pass | fail | none, durationMs, startedAt, note? }";

/** Each check's id once per list: a list naming one twice would record one check twice. */
export function checkRunsSchema(max: number) {
	return z
		.array(checkRunSchema)
		.min(1)
		.max(max)
		.superRefine((checks, ctx) => {
			const seen = new Set<string>();
			checks.forEach((check, i) => {
				if (seen.has(check.id)) {
					ctx.addIssue({
						code: "custom",
						path: [i, "id"],
						message: `check ${check.id} is sent twice in this list, and one check is recorded once`,
					});
				}
				seen.add(check.id);
			});
		});
}

export const recordChecksRequestSchema = z.strictObject({
	/** The commit the checks ran on. */
	head: wholeShaSchema("head"),
	/** The run making the call, where the box sending it holds no lease on the issue. */
	run: z.uuid().optional(),
	checks: checkRunsSchema(CHECK_RUN_LIMITS.checks),
});
export type RecordChecksRequest = z.infer<typeof recordChecksRequestSchema>;
export const RECORD_CHECKS_SHAPE = `{ head, run?: uuid, checks: [${CHECK_RUN_SHAPE}] }`;
export { CHECK_RUN_SHAPE };

export const CHECK_RUN_REFUSAL_CODES = [
	"CHECK_RUNS_REFUSED",
	"CHECK_RUN_CONFLICT",
	"CHECK_RUN_UNKNOWN",
] as const;
export type CheckRunRefusalCode = (typeof CHECK_RUN_REFUSAL_CODES)[number];

/** An id already recorded as another check is a conflict the sender resolves (409). */
export const CHECK_RUN_REFUSAL_STATUSES = {
	CHECK_RUN_CONFLICT: 409,
} as const satisfies Partial<Record<CheckRunRefusalCode, 409>>;

/** One recorded check, as the issue's read answers it. */
export interface IssueCheckRunView {
	id: string;
	kind: CheckKind;
	name: string;
	scope: string;
	command: string;
	files: string[];
	result: CheckRunResult;
	durationMs: number;
	startedAt: string;
	head: string;
	note: string | null;
	/** The run session that made it; null where the call came from no run (a person, or a box holding none). */
	runSessionId: string | null;
	via: CheckRunVia;
	recordedAt: string;
}

/** The time spent on one kind of check, and the slowest check of that kind. */
export interface CheckKindTime {
	kind: CheckKind;
	checks: number;
	totalMs: number;
	slowest: { id: string; name: string; scope: string; durationMs: number } | null;
}

export interface IssueChecksView {
	issueId: string;
	totalMs: number;
	/** Every kind of `CHECK_KINDS`, in its order, a kind nothing recorded included at zero. */
	kinds: CheckKindTime[];
	/** Newest first. */
	checks: IssueCheckRunView[];
}

export interface RecordChecksResponse {
	issueId: string;
	/** The checks this call wrote. */
	recorded: number;
	/** The checks this call sent that were already recorded as they are, so it wrote nothing for them. */
	alreadyRecorded: number;
	runSessionId: string | null;
}

/** The time per kind, every kind listed: the one summary the read answers and the page shows. */
export function checkTimeByKind(
	checks: readonly Pick<IssueCheckRunView, "id" | "kind" | "name" | "scope" | "durationMs">[],
): CheckKindTime[] {
	return CHECK_KINDS.map((kind) => {
		const ofKind = checks.filter((c) => c.kind === kind);
		let slowest: CheckKindTime["slowest"] = null;
		for (const c of ofKind) {
			if (!slowest || c.durationMs > slowest.durationMs) {
				slowest = { id: c.id, name: c.name, scope: c.scope, durationMs: c.durationMs };
			}
		}
		return {
			kind,
			checks: ofKind.length,
			totalMs: ofKind.reduce((sum, c) => sum + c.durationMs, 0),
			slowest,
		};
	});
}
