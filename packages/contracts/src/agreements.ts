// Working agreements (REQ-90): the rules a project's work runs under, each read as its Forge default,
// the project's explicit change and the effective result. Forge's defaults ship in core's code; a
// project's change is written once, into the place it governs: an agreement of its own for the
// defaults and additions, the gates for a gate profile, the project document for its content
// language, a ruling for who agrees to an act. Core resolves them in one place
// (`core/src/agreements/resolve.ts`), the page and the agents read that one answer, and a run records
// the revisions it was given.
//
// Doors:
// - `GET  /api/projects/:id/agreements[?issue=<uuid> | ?labels=a,b&category=c]` → `AgreementsView`
// - `GET  /api/projects/:id/agreements/:slug` → `AgreementDetailView` (with its history)
// - `PUT  /api/projects/:id/agreements/:slug` `AgreementWrite` → `AgreementDetailView` (project.admin)
// - `POST /api/projects/:id/agreements/:slug/restore` `AgreementRestore` → `AgreementDetailView` (project.admin)
// - a run's received agreements: `GET /api/projects/:id/run-context?session=|issue=`, rows of kind
//   `agreement`, `ref` the slug and `revision` the `AgreementView.effective.revision` it was given.

import { z } from "zod";

/**
 * How an agreement stands on a project: `inherited` (the Forge default holds), `overridden` (the
 * project's explicit change holds), `project_only` (the project's own addition), `conflict` (a newer
 * Forge default than the one the project's change was written over: the change still holds and both
 * are named until an editor re-affirms or restores it).
 */
export const AGREEMENT_STATES = [
	"inherited",
	"overridden",
	"project_only",
	"conflict",
] as const;
export type AgreementState = (typeof AGREEMENT_STATES)[number];

/** What one project revision did: override a default, add one of its own, restore the default, retire its addition. */
export const AGREEMENT_CHANGES = [
	"override",
	"addition",
	"restore",
	"retire",
] as const;
export type AgreementChange = (typeof AGREEMENT_CHANGES)[number];

/**
 * Where an agreement is written: `agreement` (this door), `gates` (`PUT /api/projects/:id/gates`),
 * `content_language` (the project document, `PUT /api/projects/:id/config`), `ruling` (a project
 * knowledge rule naming deciders, `PUT /api/projects/:id/knowledge/:slug`), `kernel` (nowhere: a
 * locked guarantee).
 */
export const AGREEMENT_AUTHORITIES = [
	"agreement",
	"gates",
	"content_language",
	"ruling",
	"kernel",
] as const;
export type AgreementAuthority = (typeof AGREEMENT_AUTHORITIES)[number];

/** What an agreement restates or rests on: a requirement, a project or org rule, a feedback, a VISION principle, a kernel rule. */
export const AGREEMENT_LINK_KINDS = [
	"requirement",
	"rule",
	"feedback",
	"vision",
	"kernel",
] as const;
export type AgreementLinkKind = (typeof AGREEMENT_LINK_KINDS)[number];

export interface AgreementLink {
	kind: AgreementLinkKind;
	/** `REQ-12`, a rule's slug, `FB-570`, `state-never-lies`, a kernel rule id. */
	ref: string;
	title: string;
}

export const AGREEMENT_SLUG = /^[a-z0-9][a-z0-9-]*$/;
export const AGREEMENT_SLUG_MAX = 80;
export const AGREEMENT_NAME_MAX = 80;
export const AGREEMENT_RULE_MAX = 600;
export const AGREEMENT_DETAIL_MAX = 8000;
export const AGREEMENT_REASON_MAX = 500;
export const AGREEMENT_CONDITION_VALUES_MAX = 20;

const conditionValue = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/,
		"a label or category as the issue carries it",
	);

/**
 * When an agreement applies to a task: the task's issue carries one of `labels`, or is of one of
 * `categories`. Absent, it applies to every task.
 */
export const agreementConditionSchema = z
	.strictObject({
		labels: z
			.array(conditionValue)
			.min(1)
			.max(AGREEMENT_CONDITION_VALUES_MAX)
			.optional(),
		categories: z
			.array(conditionValue)
			.min(1)
			.max(AGREEMENT_CONDITION_VALUES_MAX)
			.optional(),
	})
	.refine((c) => c.labels !== undefined || c.categories !== undefined, {
		message:
			"a condition names labels, categories or both; send null for an agreement that always applies",
	});
export type AgreementCondition = z.infer<typeof agreementConditionSchema>;

/** The task an agreement set is resolved for: its issue's labels and category. */
export interface AgreementTask {
	issueId: string | null;
	labels: string[];
	category: string | null;
}

/** The Forge default as core ships it now. */
export interface AgreementForgeLayer {
	revision: number;
	rule: string;
	/** Explanation, examples and anti-patterns, opened on demand; never carried always-on. */
	detail: string | null;
	/** Whose decision it is, and when. */
	source: string;
	restates: AgreementLink[];
	at: string;
}

/** Who wrote a project revision; null fields where the writer is gone. */
export interface AgreementActor {
	id: string | null;
	name: string | null;
}

/** The project's current explicit change: an override of a default, or its own addition. */
export interface AgreementProjectLayer {
	revision: number;
	change: "override" | "addition";
	rule: string;
	detail: string | null;
	condition: AgreementCondition | null;
	reason: string;
	actor: AgreementActor;
	at: string;
	/** The Forge default revision an override was written over; null for an addition. */
	baseRevision: number | null;
}

/** What agents are given for the agreement, and which revision of which layer it is. */
export interface AgreementEffective {
	rule: string;
	detail: string | null;
	/** Null where it always applies. */
	condition: AgreementCondition | null;
	from: "forge" | "project" | "config";
	/** `forge@<n>`, `project@<n>` or `config@<n>`: what a run records it received. */
	revision: string;
}

/** A newer Forge default than the one the project's override was written over: both named. */
export interface AgreementConflict {
	forge: { revision: number; rule: string };
	project: { revision: number; baseRevision: number | null; rule: string };
	says: string;
}

export interface AgreementView {
	slug: string;
	name: string;
	/** A core guarantee no project changes: access and state honesty. */
	locked: boolean;
	authority: AgreementAuthority;
	/** The door that changes it, as `METHOD /api/...`; null for a locked guarantee. */
	door: string | null;
	state: AgreementState;
	forge: AgreementForgeLayer | null;
	project: AgreementProjectLayer | null;
	effective: AgreementEffective;
	conflict: AgreementConflict | null;
	/**
	 * Whether it applies to the task resolved for: true or false where a task was given, null where
	 * none was and the agreement is conditional.
	 */
	applies: boolean | null;
}

export interface AgreementsView {
	projectId: string;
	task: AgreementTask | null;
	agreements: AgreementView[];
	counts: Record<AgreementState, number> & { locked: number };
}

/** One revision of an agreement, newest first in a history. */
export interface AgreementRevisionView {
	layer: "forge" | "project" | "config";
	revision: number;
	change: "default" | AgreementChange | "config";
	rule: string | null;
	detail: string | null;
	condition: AgreementCondition | null;
	reason: string | null;
	actor: AgreementActor | null;
	at: string;
}

export interface AgreementDetailView extends AgreementView {
	history: AgreementRevisionView[];
}

/**
 * A project's change to an agreement: over a Forge default's slug it overrides that default, under a
 * new slug it adds an agreement of the project's own (and then `name` is required). `projectRevision`
 * is the project revision read, 0 where the project holds none: a stale one is refused by name.
 */
export const agreementWriteSchema = z.strictObject({
	name: z.string().trim().min(3).max(AGREEMENT_NAME_MAX).optional(),
	rule: z.string().trim().min(3).max(AGREEMENT_RULE_MAX),
	detail: z.string().trim().min(1).max(AGREEMENT_DETAIL_MAX).nullish(),
	condition: agreementConditionSchema.nullish(),
	reason: z.string().trim().min(3).max(AGREEMENT_REASON_MAX),
	projectRevision: z.number().int().min(0),
});
export type AgreementWrite = z.infer<typeof agreementWriteSchema>;
export const AGREEMENT_WRITE_SHAPE = `{ name?: 3-${AGREEMENT_NAME_MAX} chars (required for a project-only agreement), rule: one sentence, 3-${AGREEMENT_RULE_MAX} chars, detail?: on-demand text or null, condition?: { labels?: string[], categories?: string[] } or null, reason: why, 3-${AGREEMENT_REASON_MAX} chars, projectRevision: the project revision you read, 0 where none }`;

/** Restore a default (drop the project's override) or retire the project's own addition. */
export const agreementRestoreSchema = z.strictObject({
	reason: z.string().trim().min(3).max(AGREEMENT_REASON_MAX),
	projectRevision: z.number().int().min(1),
});
export type AgreementRestore = z.infer<typeof agreementRestoreSchema>;
export const AGREEMENT_RESTORE_SHAPE = `{ reason: why, 3-${AGREEMENT_REASON_MAX} chars, projectRevision: the project revision you read }`;

/** The task to resolve for: one issue by id, or labels and a category named directly. */
export const agreementsQuerySchema = z
	.strictObject({
		issue: z.uuid().optional(),
		labels: z.string().max(1000).optional(),
		category: z.string().max(64).optional(),
	})
	.refine(
		(q) => !(q.issue && (q.labels !== undefined || q.category !== undefined)),
		{
			message: "name the task by issue, or by labels and category, not both",
		},
	);
export type AgreementsQuery = z.infer<typeof agreementsQuerySchema>;
export const AGREEMENTS_QUERY_SHAPE =
	"none (every agreement, conditions unresolved), issue=<issue uuid>, or labels=<a,b>&category=<c>";

export const AGREEMENT_REFUSAL_CODES = [
	"AGREEMENT_NOT_FOUND",
	"AGREEMENT_LOCKED",
	"AGREEMENT_AUTHORITY_ELSEWHERE",
	"AGREEMENT_NAME_REQUIRED",
	"AGREEMENT_NAME_OF_DEFAULT",
	"AGREEMENT_NOTHING_TO_RESTORE",
	"AGREEMENT_REVISION_STALE",
	"AGREEMENT_SLUG_INVALID",
	"AGREEMENT_ISSUE_NOT_FOUND",
] as const;
export type AgreementRefusalCode = (typeof AGREEMENT_REFUSAL_CODES)[number];

/** `forge@3` → `{ layer: 'forge', revision: 3 }`; null for anything else. */
export function parseAgreementRevision(
	s: string,
): { layer: "forge" | "project" | "config"; revision: number } | null {
	const m = /^(forge|project|config)@(\d+)$/.exec(s);
	if (!m) return null;
	return {
		layer: m[1] as "forge" | "project" | "config",
		revision: Number(m[2]),
	};
}
