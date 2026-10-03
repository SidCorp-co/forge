// cm:why one declaration of the storefront-draft verdict identity (ISS-91, FB-47): core's table
// CHECKs, the REST and MCP verdict doors and the web all read the kind, the field shapes, the
// corroboration words and the refusal codes from here.

import { z } from "zod";

export const STOREFRONT_DRAFT_KIND = "storefront_draft" as const;

export const VERDICT_CORROBORATIONS = [
	"corroborated",
	"uncorroborated",
] as const;
export type VerdictCorroboration = (typeof VERDICT_CORROBORATIONS)[number];

export const STOREFRONT_WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;
export const STOREFRONT_DRAFT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const STOREFRONT_ENVIRONMENT = /^[a-z][a-z0-9-]{0,62}$/u;

export const STOREFRONT_DRAFT_SHAPE =
	'{ kind: "storefront_draft", workflowId: <the provider\'s workflow id>, draftVersion: <the draft version id forge_storefront_target reports>, environment: <a non-production environment the project document declares, e.g. preview> }';

export const STOREFRONT_DRAFT_REFUSAL_CODES = [
	"VERDICT_STOREFRONT_DRAFT_SHAPE",
	"VERDICT_ENVIRONMENT_UNKNOWN",
] as const;
export type StorefrontDraftRefusalCode =
	(typeof STOREFRONT_DRAFT_REFUSAL_CODES)[number];

export const storefrontDraftIdentitySchema = z.strictObject({
	kind: z.literal(STOREFRONT_DRAFT_KIND),
	workflowId: z.string().trim().min(1).max(200),
	draftVersion: z.string().trim().min(1).max(200),
	environment: z.string().trim().min(1).max(100),
});
export type StorefrontDraftIdentity = z.infer<
	typeof storefrontDraftIdentitySchema
>;

export interface StorefrontDraftVerdictView {
	storefrontWorkflowId: string | null;
	storefrontDraftVersion: string | null;
	storefrontEnvironment: string | null;
	corroboration: VerdictCorroboration | null;
	corroborationNote: string | null;
}
