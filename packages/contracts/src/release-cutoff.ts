// When the automatic release cuts a batch (REQ-71 BC-13, the owner's release cutoff of 2026-11-07,
// FB-578): the first of the project's triggers met. Policy data in the project document
// (`release.cutoff`), with Forge's default where a project declares none, never a code constant a
// project cannot change. Read by core's release sweep (`release-batch/release-cutoff.ts`).
//
// - `time`: the oldest eligible outcome has waited `minutes` at the gate.
// - `count`: `outcomes` eligible outcomes wait, or the oldest has waited `maxWaitMinutes`.
// - `target`: the named outcome (`REQ-n` or `FB-n`) is eligible, or the oldest has waited
//   `maxWaitMinutes`.
// - `request`: a person, or an agent allowed to release, cuts now (`POST
//   /api/projects/:id/release-batches`): the hotfix lane, which no project turns off.

import { z } from "zod";

export const RELEASE_TRIGGER_KINDS = [
	"time",
	"count",
	"target",
	"request",
] as const;

/**
 * How a project-document write naming `release.cutoff` is refused: a `kind` that is no trigger, or a
 * trigger whose number or name is not one the sweep can read (`releaseCutoffRefusalCode`).
 */
export const RELEASE_CUTOFF_REFUSAL_CODES = [
	"RELEASE_TRIGGER_UNKNOWN",
	"RELEASE_TRIGGER_INVALID",
] as const;
export type ReleaseCutoffRefusalCode =
	(typeof RELEASE_CUTOFF_REFUSAL_CODES)[number];

/**
 * The code a schema issue under `release.cutoff` is refused by, or null for an issue elsewhere: an
 * unmatched `kind` is an unknown trigger, anything else a trigger declared wrongly.
 */
export function releaseCutoffRefusalCode(issue: {
	code: string;
	path: readonly PropertyKey[];
}): ReleaseCutoffRefusalCode | null {
	if (issue.path[0] !== "release" || issue.path[1] !== "cutoff") return null;
	return issue.code === "invalid_union" && issue.path.at(-1) === "kind"
		? "RELEASE_TRIGGER_UNKNOWN"
		: "RELEASE_TRIGGER_INVALID";
}

/** How long a count or target trigger waits for its last outcome before it cuts what is eligible. */
export const RELEASE_MAX_WAIT_DEFAULT_MINUTES = 30;

/** A week: no trigger waits longer, so a typo in a number never parks a release for good. */
const MINUTES_MAX = 10_080;
const OUTCOMES_MAX = 200;

const minutes = (field: string, min: number) =>
	z
		.number({
			error: `\`${field}\` is a whole number of minutes, from ${min} to ${MINUTES_MAX}`,
		})
		.int(
			`\`${field}\` is a whole number of minutes, from ${min} to ${MINUTES_MAX}`,
		)
		.min(min, `\`${field}\` is at least ${min}`)
		.max(
			MINUTES_MAX,
			`\`${field}\` is at most ${MINUTES_MAX} minutes (a week)`,
		);

const maxWait = minutes("maxWaitMinutes", 1).optional();

const timeTrigger = z.strictObject({
	kind: z.literal("time"),
	// 0 cuts as soon as an outcome is eligible, the sweep's behaviour before ISS-1126
	minutes: minutes("minutes", 0),
});

const countTrigger = z.strictObject({
	kind: z.literal("count"),
	outcomes: z
		.number({
			error: `\`outcomes\` is a whole number of eligible outcomes, from 1 to ${OUTCOMES_MAX}`,
		})
		.int(
			`\`outcomes\` is a whole number of eligible outcomes, from 1 to ${OUTCOMES_MAX}`,
		)
		.min(1, "`outcomes` is at least 1")
		.max(OUTCOMES_MAX, `\`outcomes\` is at most ${OUTCOMES_MAX}`),
	maxWaitMinutes: maxWait,
});

const targetTrigger = z.strictObject({
	kind: z.literal("target"),
	outcome: z
		.string({
			error:
				"`outcome` names a requirement or a feedback item, such as `REQ-90` or `FB-12`",
		})
		.regex(
			/^(REQ|FB)-[1-9]\d{0,8}$/,
			"`outcome` names a requirement or a feedback item, such as `REQ-90` or `FB-12`",
		),
	maxWaitMinutes: maxWait,
});

const requestTrigger = z.strictObject({ kind: z.literal("request") });

const KNOWN = RELEASE_TRIGGER_KINDS.map((k) => `\`${k}\``).join(", ");

const releaseTriggerSchema = z.discriminatedUnion(
	"kind",
	[timeTrigger, countTrigger, targetTrigger, requestTrigger],
	{
		error: (issue) =>
			issue.code === "invalid_union"
				? `${JSON.stringify((issue.input as { kind?: unknown } | undefined)?.kind)} is not a release trigger: \`kind\` is one of ${KNOWN}`
				: undefined,
	},
);

export type ReleaseTrigger = z.infer<typeof releaseTriggerSchema>;

export const releaseCutoffSchema = z
	.strictObject({
		triggers: z
			.array(releaseTriggerSchema)
			.min(1)
			.max(RELEASE_TRIGGER_KINDS.length),
	})
	.superRefine((cutoff, ctx) => {
		const seen = new Set<string>();
		cutoff.triggers.forEach((t, i) => {
			if (seen.has(t.kind)) {
				ctx.addIssue({
					code: "custom",
					path: ["triggers", i, "kind"],
					message: `a second \`${t.kind}\` trigger: each kind is declared once`,
				});
			}
			seen.add(t.kind);
		});
		if (!seen.has("request")) {
			ctx.addIssue({
				code: "custom",
				path: ["triggers"],
				message:
					'the triggers name no `request`: a direct request is the hotfix lane, which every project keeps, so the list names `{ "kind": "request" }`',
			});
		}
	});

export type ReleaseCutoff = z.infer<typeof releaseCutoffSchema>;

/** Forge's default, read by every project whose document declares no `release.cutoff`. */
export const RELEASE_CUTOFF_DEFAULT: ReleaseCutoff = {
	triggers: [{ kind: "time", minutes: 10 }, { kind: "request" }],
};

/** The cutoff a project's release sweep runs on, and whether its document or Forge's default said it. */
export function releaseCutoffOf(
	document:
		| { release?: { cutoff?: ReleaseCutoff | undefined } | undefined }
		| null
		| undefined,
): { cutoff: ReleaseCutoff; from: "project" | "default" } {
	const declared = document?.release?.cutoff;
	return declared
		? { cutoff: declared, from: "project" }
		: { cutoff: RELEASE_CUTOFF_DEFAULT, from: "default" };
}
