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

export const STOREFRONT_DRAFT_SHAPE =
	'{ kind: "storefront_draft", workflowId: <the provider\'s workflow id>, draftVersion: <the draft version id forge_storefront_target reports>, environment: <a non-production environment the project document declares, e.g. preview> }';

export const STOREFRONT_DRAFT_REFUSAL_CODES = [
	"VERDICT_STOREFRONT_DRAFT_SHAPE",
	"VERDICT_ENVIRONMENT_UNKNOWN",
] as const;
export const storefrontDraftIdentitySchema = z.strictObject({
	kind: z.literal(STOREFRONT_DRAFT_KIND),
	workflowId: z.string().trim().min(1).max(200),
	draftVersion: z.string().trim().min(1).max(200),
	environment: z.string().trim().min(1).max(100),
});

export interface StorefrontDraftVerdictView {
	storefrontWorkflowId: string | null;
	storefrontDraftVersion: string | null;
	storefrontEnvironment: string | null;
	corroboration: VerdictDraftReading | null;
	corroborationNote: string | null;
}

export const VERDICT_VALUES = ["pass", "short", "fail", "skipped"] as const;
type VerdictValueName = (typeof VERDICT_VALUES)[number];

export const VERDICT_IDENTITY_KINDS = [
	"commit",
	"runtime",
	"design",
	"contract",
	"storefront_draft",
	"commit_unresolved",
] as const;
type VerdictIdentityKindName = (typeof VERDICT_IDENTITY_KINDS)[number];

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

// `short` is a judged pass, and a backfilled abbreviated commit that never resolved reads Unresolved whatever it said, so every screen folds a verdict the way the release gate reads it
export function criterionStandingOf(
	latest: Pick<VerdictReading, "verdict" | "identityKind"> | null,
): CriterionStanding {
	if (!latest) return "unjudged";
	if (latest.identityKind === "commit_unresolved") return "unresolved";
	if (latest.verdict === "pass" || latest.verdict === "short") return "pass";
	return latest.verdict;
}

export function identityPhraseOf(v: VerdictReading): string {
	switch (v.identityKind) {
		case "commit":
			return `commit ${v.commitSha?.slice(0, 12)}`;
		case "commit_unresolved":
			return `abbreviated commit ${v.commitSha} (backfilled, never resolved)`;
		case "runtime":
			return `runtime ${v.runtimeRef?.slice(0, 12)}`;
		case "design":
			return `design ${v.designFlow ?? v.designWorkflowId} rev ${v.designRevision}`;
		case "contract":
			return `contract ${v.contractRef}@${v.contractVersion}`;
		case "storefront_draft":
			return `storefront draft ${v.storefrontWorkflowId}@${v.storefrontDraftVersion?.slice(0, 12)} on ${v.storefrontEnvironment}${v.corroboration === "corroborated" ? "" : ` (${v.corroboration ?? "uncorroborated"}: ${v.corroborationNote})`}`;
		default:
			return "no identity";
	}
}
