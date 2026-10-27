// one declaration of the storefront-draft verdict identity (ISS-91, FB-47): core's table
// CHECKs, the REST and MCP verdict doors and the web all read the kind, the field shapes, the
// corroboration words and the refusal codes from here.

import { z } from "zod";
import type { CriterionStanding } from "./issue-vocabulary.js";

const STOREFRONT_DRAFT_KIND = "storefront_draft" as const;

export const VERDICT_CORROBORATIONS = [
	"corroborated",
	"uncorroborated",
] as const;
export type VerdictCorroboration = (typeof VERDICT_CORROBORATIONS)[number];

export const VERDICT_DRAFT_READINGS = [
	...VERDICT_CORROBORATIONS,
	"superseded",
] as const;
export type VerdictDraftReading = (typeof VERDICT_DRAFT_READINGS)[number];

export const STOREFRONT_WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
export const STOREFRONT_DRAFT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const STOREFRONT_ENVIRONMENT = /^[a-z][a-z0-9-]{0,62}$/u;

/** The most workflow drafts one storefront_draft verdict names. */
export const STOREFRONT_DRAFT_PARTS_MAX = 50;

export const STOREFRONT_DRAFT_SHAPE =
	'{ kind: "storefront_draft", workflows: [{ workflowId: <the provider\'s workflow id>, draftVersion: <the draft version id the storefront target route reports> }, ...one per workflow the criterion rests on, each workflow once, at most 50], environment: <a non-production environment the project document declares, e.g. preview> }, or for one workflow { kind: "storefront_draft", workflowId, draftVersion, environment }';

export const STOREFRONT_DRAFT_REFUSAL_CODES = [
	"VERDICT_STOREFRONT_DRAFT_SHAPE",
	"VERDICT_ENVIRONMENT_UNKNOWN",
] as const;

/** One workflow draft a storefront_draft verdict was judged on. */
export interface StorefrontDraftPart {
	readonly workflowId: string;
	readonly draftVersion: string;
}

// every field is optional here and a free string, so the verdict door refuses a wrong one by name
// (`verdict-input.ts:storefrontDraftFault`, VERDICT_STOREFRONT_DRAFT_SHAPE) rather than a schema's
// generic 400: an empty list, a repeated workflow, a part with no version, both forms or neither
const storefrontDraftPartSchema = z.strictObject({
	workflowId: z.string().max(200).optional(),
	draftVersion: z.string().max(200).optional(),
});

export const storefrontDraftIdentitySchema = z.strictObject({
	kind: z.literal(STOREFRONT_DRAFT_KIND),
	workflows: z.array(storefrontDraftPartSchema).optional(),
	workflowId: z.string().max(200).optional(),
	draftVersion: z.string().max(200).optional(),
	environment: z.string().trim().min(1).max(100),
});

/** How a verdict names its storefront drafts: `<workflow>@<version>` each, in the order written. */
export const storefrontDraftsPhrase = (
	parts: readonly StorefrontDraftPart[] | null,
	versionChars = 12,
): string =>
	parts && parts.length > 0
		? parts
				.map((p) => `${p.workflowId}@${p.draftVersion.slice(0, versionChars)}`)
				.join(", ")
		: "—";

export interface StorefrontDraftVerdictView {
	/** Every workflow draft the verdict was judged on, in the order written; null on another kind. */
	storefrontDrafts: readonly StorefrontDraftPart[] | null;
	storefrontEnvironment: string | null;
	corroboration: VerdictDraftReading | null;
	corroborationNote: string | null;
}

export const VERDICT_VALUES = ["pass", "short", "fail", "skipped"] as const;
type VerdictValueName = (typeof VERDICT_VALUES)[number];

/**
 * The verdicts that met a criterion, a `pass` or a `short` (met, short of its wording): what an
 * issue's merge check, its probes and its passing count read. Proof is a different, narrower word:
 * every count of what is proven reads `verified-rule.ts:verifiedOf`, where a short never counts
 * (REQ-35 decision 7b261fca).
 */
export const EARNING_VERDICTS = [
	"pass",
	"short",
] as const satisfies readonly VerdictValueName[];

/** The verdicts that exercised a criterion: every judged outcome but `skipped`. */
export const EXERCISED_VERDICTS = [
	"pass",
	"short",
	"fail",
] as const satisfies readonly VerdictValueName[];

/** Whether a verdict earns its criterion (`EARNING_VERDICTS`). */
export const verdictEarns = (verdict: string | null | undefined): boolean =>
	(EARNING_VERDICTS as readonly (string | null | undefined)[]).includes(
		verdict,
	);

/** Whether a verdict exercised its criterion (`EXERCISED_VERDICTS`). */
export const verdictExercised = (verdict: string | null | undefined): boolean =>
	(EXERCISED_VERDICTS as readonly (string | null | undefined)[]).includes(
		verdict,
	);

export const VERDICT_IDENTITY_KINDS = [
	"commit",
	"runtime",
	"design",
	"contract",
	"storefront_draft",
	"commit_unresolved",
] as const;
export type VerdictIdentityKindName = (typeof VERDICT_IDENTITY_KINDS)[number];

interface VerdictReading extends StorefrontDraftVerdictView {
	verdict: VerdictValueName;
	identityKind: VerdictIdentityKindName | null;
	commitSha: string | null;
	runtimeRef: string | null;
	designFlow: string | null;
	designWorkflowId: string | null;
	designRevision: number | null;
	contractRef: string | null;
	contractVersion: string | null;
}

// a backfilled abbreviated commit that never resolved reads Unresolved whatever it said; `short` reads Short on every screen and is never proven (`verified-rule.ts:verifiedOf`)
export function criterionStandingOf(
	latest: Pick<VerdictReading, "verdict" | "identityKind"> | null,
): CriterionStanding {
	if (!latest) return "unjudged";
	if (latest.identityKind === "commit_unresolved") return "unresolved";
	return latest.verdict;
}

/** How a verdict judged on one commit names it. */
export const commitIdentityPhrase = (sha: string | null): string =>
	`commit ${sha?.slice(0, 12)}`;

export function identityPhraseOf(v: VerdictReading): string {
	switch (v.identityKind) {
		case "commit":
			return commitIdentityPhrase(v.commitSha);
		case "commit_unresolved":
			return `abbreviated commit ${v.commitSha} (backfilled, never resolved)`;
		case "runtime":
			return `runtime ${v.runtimeRef?.slice(0, 12)}`;
		case "design":
			return `design ${v.designFlow ?? v.designWorkflowId} rev ${v.designRevision}`;
		case "contract":
			return `contract ${v.contractRef}@${v.contractVersion}`;
		case "storefront_draft":
			return `storefront draft ${storefrontDraftsPhrase(v.storefrontDrafts)} on ${v.storefrontEnvironment}${v.corroboration === "corroborated" ? "" : ` (${v.corroboration ?? "uncorroborated"}: ${v.corroborationNote})`}`;
		default:
			return "no identity";
	}
}

/**
 * Where a verdict on an issue is judged by default (REQ-6 BC-2, BC-4), as core reads it
 * (`GET /api/issues/:id/judged-build`). `live`: the commit production serves now, which carries the
 * issue's work. `shipped`: the commit the release that shipped the work was verified live at, where
 * the live build could not be read or could not be shown to carry it. `merged`: the commit the
 * issue merged as, where no release shipped it. `landed`: on a project that declares no production
 * environment, the build its landing on the working branch is (core `release-batch/landed-build.ts`).
 * `sha` is null where Forge names no build.
 */
/**
 * Under release mode `none`, why a verdict of identity `kind` naming `value` earns no criterion, or
 * null where it is a commit. Only a commit identity at the very commit a landing records earns one
 * there (kernel input, coordinator ruling 2026-10-22): a runtime ref, even one spelling the whole
 * landed sha, a design, a contract or a storefront draft names no landed commit. The record door,
 * the steward and a requirement's coverage all read this one sentence.
 */
export function landedIdentityWhy(
	kind: string,
	value: string,
	judgedOn: string | null,
): string | null {
	if (kind === "commit") return null;
	// on a project naming its testing environment (`delivery.judgedOn`, REQ-36 BC-18), a runtime ref
	// that is a whole commit names that commit as it ran there, weighed at it as a commit verdict is
	if (kind === "runtime" && judgedOn !== null && /^[0-9a-f]{40}$/i.test(value.trim())) {
		return null;
	}
	const there =
		kind === "runtime"
			? ", or, where the project names its testing environment (`delivery.judgedOn`), one judged on the whole commit it serves"
			: "";
	return `judged against ${kind} \`${value}\`, not a commit: with no production environment only a verdict whose identity is the commit its landing records counts${there}`;
}

export const JUDGED_BUILD_SOURCES = ["live", "shipped", "merged", "landed", "change-request"] as const;
export type JudgedBuildSource = (typeof JUDGED_BUILD_SOURCES)[number];

export interface JudgedBuild {
	sha: string | null;
	source: JudgedBuildSource | null;
	/** The release whose build `sha` is, where one is: the live one, or the one that shipped it. */
	version: string | null;
	/** How core knows, or why it could not say more, in one sentence. */
	basis: string;
}
