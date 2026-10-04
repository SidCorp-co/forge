// The refusal vocabulary of the project document, its bindings, its policy and its testing secrets.

import { CONTENT_LANGUAGE_REFUSAL_CODES } from "./content-language.js";
import { TEMPLATE_REFUSAL_CODES } from "./workflow-template-schema.js";
import type { RefusalStatuses } from "./refusal.js";

export const PURE_REFUSAL_CODES = [
	"DEFAULT_BRANCH_UNDECLARED",
	"PROMOTIONS_NEED_GIT",
	"PROMOTION_REF_UNDECLARED",
	"PROMOTION_CYCLE",
	"DEPLOYS_FROM_MISSING",
	"DEPLOYS_FROM_UNDECLARED",
	"DEPLOYS_FROM_NEEDS_GIT",
	"PRODUCTION_NOT_UNIQUE",
	"ISOLATION_UNSUPPORTED",
	"GATE_UNSUPPORTED",
	"BINDING_NOT_FOUND",
	"BINDING_ROLE_MISMATCH",
	"BINDING_IN_USE",
	"BINDING_PROVIDER_MISMATCH",
	"GITLESS_BINDING_ON_GIT_SOURCE",
	"TRIGGER_UNSUPPORTED",
	"TESTING_PROFILE_NOT_FOUND",
	"PERMISSION_PROFILE_UNDEFINED",
	"TOOL_PATTERN_INVALID",
	"APPROVER_POLICY_RETIRED",
] as const;

/** A project's own diagram templates are refused in the template resolver's vocabulary, plus one. */
export const WORKFLOW_TEMPLATE_CONFIG_REFUSAL_CODES = [
	...TEMPLATE_REFUSAL_CODES,
	"WORKFLOW_TEMPLATE_IN_USE",
] as const;

/** Refusals that need storage, a registry or the request. UNKNOWN_KEY is the strict schema's own. */
export const STORED_REFUSAL_CODES = [
	"UNKNOWN_KEY",
	"VERSION_UNSUPPORTED",
	"STALE_BASE",
	"PROJECT_ID_IMMUTABLE",
	"SLUG_TAKEN",
	"CONNECTION_NOT_FOUND",
	"CONNECTION_PROVIDER_MISMATCH",
	"SECRET_NOT_FOUND",
] as const;

export const CONFIG_REFUSAL_CODES = [
	...PURE_REFUSAL_CODES,
	...STORED_REFUSAL_CODES,
	...WORKFLOW_TEMPLATE_CONFIG_REFUSAL_CODES,
	...CONTENT_LANGUAGE_REFUSAL_CODES,
] as const;

export type ConfigRefusalCode = (typeof CONFIG_REFUSAL_CODES)[number];

/** What a deploy provider answers when it checks a binding's target. */
export const BINDING_TARGET_REFUSAL_CODES = [
	"COOLIFY_APPLICATION_UNKNOWN",
	"COOLIFY_UNREACHABLE",
	"SOURCE_HOST_MISMATCH",
] as const;

/** Every code a project-config document write answers with. */
export const PROJECT_CONFIG_REFUSAL_CODES = [
	...CONFIG_REFUSAL_CODES,
	"SCHEMA_VIOLATION",
	"TESTING_PROFILE_ID_MISMATCH",
	"TESTING_PROFILE_IN_USE",
	"BINDING_ID_MISMATCH",
	"BINDING_TARGET_UNSUPPORTED",
	"BINDING_NOT_REPRESENTABLE",
	"BINDING_LABEL_UNSUPPORTED",
	"BINDING_ROLLBACK_MOVED",
	"AGENT_ACCESS_UNSUPPORTED",
	"AGENT_ACCESS_NEEDS_ORG_ADMIN",
	...BINDING_TARGET_REFUSAL_CODES,
] as const;

export type ProjectConfigRefusalCode = (typeof PROJECT_CONFIG_REFUSAL_CODES)[number];
export const PROJECT_CONFIG_REFUSAL_STATUSES = {
	STALE_BASE: 409,
	AGENT_ACCESS_NEEDS_ORG_ADMIN: 403,
} as const satisfies RefusalStatuses<ProjectConfigRefusalCode>;

/** Reading an environment's deployed state through its binding. */
export const ENVIRONMENT_STATE_REFUSAL_CODES = [
	"BINDING_NOT_FOUND",
	"BINDING_ROLE_MISMATCH",
	"DEPLOY_HISTORY_UNSUPPORTED",
] as const;

export type EnvironmentStateRefusalCode = (typeof ENVIRONMENT_STATE_REFUSAL_CODES)[number];

/** Dispatch refused because the project's policy cannot say how this work runs. */
export const POLICY_REFUSAL_CODES = [
	"POLICY_UNDECLARED",
	"POLICY_STATE_UNDECLARED",
] as const;

export type PolicyRefusalCode = (typeof POLICY_REFUSAL_CODES)[number];

export const TESTING_SECRETS_REFUSAL_CODES = [
	"TESTING_SECRETS_NOT_A_JOB_CREDENTIAL",
	"TESTING_SECRETS_JOB_AMBIGUOUS",
	"TESTING_SECRETS_FOREIGN_JOB",
	"TESTING_SECRETS_JOB_NOT_JUDGING",
	"TESTING_SECRETS_NO_PROJECT_DOCUMENT",
	"TESTING_SECRETS_NOT_LANDED",
	"TESTING_SECRETS_NO_ENVIRONMENT_FOR_TARGET",
	"TESTING_SECRETS_ENVIRONMENT_AMBIGUOUS",
	"TESTING_SECRETS_NO_TESTING_PROFILE",
	"TESTING_PROFILE_NOT_NAMED",
	"TESTING_PROFILE_NOT_DECLARED",
	"SECRET_NOT_NAMED",
	"SECRET_VALUE_MISSING",
	"SECRET_VALUE_UNREADABLE",
	"SECRET_TOO_SHORT_TO_SCRUB",
	"VAULT_NOT_CONFIGURED",
] as const;

export type TestingSecretsRefusalCode = (typeof TESTING_SECRETS_REFUSAL_CODES)[number];

/** A `secret://<scope>/<name>` reference into the project's vault, or null when the text is not one. */
export function parseSecretRef(
	ref: string,
): { scope: string; name: string } | null {
	const m = /^secret:\/\/([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})$/.exec(
		ref,
	);
	return m?.[1] && m[2] ? { scope: m[1], name: m[2] } : null;
}

export const secretRefOf = (scope: string, name: string) =>
	`secret://${scope}/${name}`;

export const POLICY_QA_MODES = ["self", "independent"] as const;
export type PolicyQaMode = (typeof POLICY_QA_MODES)[number];
export const POLICY_MODELS = ["opus", "sonnet", "haiku", "fable"] as const;
export type PolicyModel = (typeof POLICY_MODELS)[number];

/** How the state a job runs under was chosen. */
export type PolicyStateSource = "stamped" | "issue" | "entry";

/** The policy state one dispatch runs under, read from the project's policy document. */
export interface DispatchState {
	revision: number;
	qa: PolicyQaMode;
	status: string;
	from: PolicyStateSource;
	model: PolicyModel;
	profile: string;
	deniedTools: string[];
}

/**
 * The job types that log in to judge a deployment and so read its testing secrets. `drive` is here
 * because an autonomous project's driver walks the judging phase in the same job that builds.
 */
export const JUDGING_JOB_TYPES = ["test", "smoke", "staging", "drive"] as const;

/** The job id a running job's credential names itself by. */
export const SELF_JOB = "self";

// The base every Forge document schema id hangs off.
export const SCHEMA_BASE = "https://forge.sidcorp.co/schemas";
