// The refusal vocabulary of the project document, its bindings, its policy and its testing secrets.

import { CONTENT_LANGUAGE_REFUSAL_CODES } from "./content-language.js";
import { JUDGED_ON_REFUSAL_CODES } from "./delivery-policy.js";
import { GATE_PROFILE_REFUSAL_CODES } from "./gate-profiles.js";
import type { RefusalStatuses } from "./refusal.js";
import { TEMPLATE_REFUSAL_CODES } from "./workflow-template-schema.js";

const PURE_REFUSAL_CODES = [
	"DEFAULT_BRANCH_UNDECLARED",
	"PROMOTIONS_NEED_GIT",
	"PROMOTION_REF_UNDECLARED",
	"PROMOTION_CYCLE",
	"PROMOTION_CHAIN_UNSUPPORTED",
	"DEPLOYS_FROM_MISSING",
	"DEPLOYS_FROM_UNDECLARED",
	"DEPLOYS_FROM_NEEDS_GIT",
	"PRODUCTION_NOT_UNIQUE",
	/** A preview setting names an environment the project does not declare, or one whose tier is production. */
	"PREVIEW_SETTINGS_INVALID",
	"PREVIEW_PRODUCTION_ENVIRONMENT",
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
	/** `requirements.readinessGate` is written; the ready checklist replaced it (REQ-34 r2). */
	"READINESS_GATE_RETIRED",
	/** `release.changeRequests` on a document that cannot release by merging change requests (REQ-63 BC-1). */
	"CHANGE_REQUEST_RELEASE_UNSUPPORTED",
] as const;

/** A project's own diagram templates are refused in the template resolver's vocabulary, plus one. */
const WORKFLOW_TEMPLATE_CONFIG_REFUSAL_CODES = [
	...TEMPLATE_REFUSAL_CODES,
	"WORKFLOW_TEMPLATE_IN_USE",
] as const;

/** Refusals that need storage, a registry or the request. UNKNOWN_KEY is the strict schema's own. */
const STORED_REFUSAL_CODES = [
	"UNKNOWN_KEY",
	"VERSION_UNSUPPORTED",
	"STALE_BASE",
	"PROJECT_ID_IMMUTABLE",
	"SLUG_TAKEN",
	"PROJECT_SLUG_RESERVED",
	"CONNECTION_NOT_FOUND",
	"CONNECTION_PROVIDER_MISMATCH",
	"SECRET_NOT_FOUND",
	/** A testing profile's `var://KEY` names no variable of this project (REQ-80 BC-7). */
	"VARIABLE_REF_UNKNOWN",
	/** `secret://var/…` is the variables' own store, reached only through a variable (REQ-80). */
	"SECRET_SCOPE_RESERVED",
] as const;

export const CONFIG_REFUSAL_CODES = [
	...PURE_REFUSAL_CODES,
	...STORED_REFUSAL_CODES,
	...WORKFLOW_TEMPLATE_CONFIG_REFUSAL_CODES,
	...CONTENT_LANGUAGE_REFUSAL_CODES,
	/** `delivery.judgedOn` names no declared environment, or production (REQ-36 BC-18). */
	...JUDGED_ON_REFUSAL_CODES,
] as const;

export type ConfigRefusalCode = (typeof CONFIG_REFUSAL_CODES)[number];

/** What a deploy provider answers when it checks a binding's target. */
const BINDING_TARGET_REFUSAL_CODES = [
	"COOLIFY_APPLICATION_UNKNOWN",
	"COOLIFY_UNREACHABLE",
	"SOURCE_HOST_MISMATCH",
	"SOURCE_REPOSITORY_LOCAL",
	"GITHUB_INSTALLATION_NOT_RECORDED",
	"WIDGET_SITE_KEY_MINTED",
	"WIDGET_SITE_KEY_TAKEN",
	"SUPPORT_ROOM_NOT_ONE_GROUP",
	"SUPPORT_ROOM_TWO_KINDS",
	"SUPPORT_GRANT_TARGET_UNKNOWN",
	/** `owner_mode` granted on a block other than a channel agent's (REQ-77 BC-20). */
	"SUPPORT_OWNER_MODE_NOT_AGENT",
	/** Scheduled checks on a block other than a channel agent's (REQ-77 BC-13). */
	"SUPPORT_CHECK_NOT_AGENT",
	/** A scheduled check names a group the binding does not answer (REQ-77 BC-13). */
	"SUPPORT_CHECK_ROOM_UNKNOWN",
	/** A channel agent's `ownerRoom` is no group the binding answers, or sits on another block (ISS-872). */
	"SUPPORT_OWNER_ROOM_UNKNOWN",
	/** A group an outside bot answers joins the channel agent before its switch may run (REQ-77 BC-16). */
	"AGENT_SWITCH_NOT_READY",
	/** A channel agent's `agent.projects` names no sibling project of its home's organization, or names its home (ISS-874). */
	"SUPPORT_AGENT_PROJECT_UNKNOWN",
	/** The writer adds a project to `agent.projects` they are not an admin of (ISS-874). */
	"SUPPORT_AGENT_PROJECT_NOT_ADMIN",
	/** `projects` on a block other than a channel agent's (ISS-874). */
	"SUPPORT_AGENT_PROJECTS_NOT_AGENT",
	/** A group another active binding already answers: two sessions would answer it (ISS-874). */
	"SUPPORT_ROOM_ANSWERED_TWICE",
	/** A channel agent's `rooms` names a group the binding does not answer, sits on another block, or makes the owner's room a users' room (ISS-874). */
	"SUPPORT_ROOM_OVERRIDE_UNKNOWN",
	/** A support-api binding grants a tool name another active support-api binding of the project grants (ISS-1011). */
	"SUPPORT_TOOL_NAME_TAKEN",
] as const;

/** Every code a project-config document write answers with. */
/** A person's declaration of a review run (`POST /api/projects/:id/review-runs`), refused by name. */
const REVIEW_RUN_REFUSAL_CODES = [
	/** The caller is an agent account: a review run is declared by a person; an agent's runs are its master's. */
	"REVIEW_RUN_NOT_A_PERSON",
	/** The profile named is no testing profile this project declares. */
	"REVIEW_RUN_PROFILE_UNKNOWN",
] as const;

export const PROJECT_CONFIG_REFUSAL_CODES = [
	...CONFIG_REFUSAL_CODES,
	"SCHEMA_VIOLATION",
	"TESTING_PROFILE_ID_MISMATCH",
	"TESTING_PROFILE_IN_USE",
	/** A secret a testing profile still names is not deleted (ISS-847). */
	"SECRET_IN_USE",
	/** A testing profile's actor secret whose environment answered its sign-in with no session (ISS-937). */
	"SECRET_DOES_NOT_SIGN_IN",
	"BINDING_ID_MISMATCH",
	"BINDING_TARGET_UNSUPPORTED",
	"BINDING_NOT_REPRESENTABLE",
	"BINDING_LABEL_UNSUPPORTED",
	"BINDING_ROLLBACK_MOVED",
	"AGENT_ACCESS_UNSUPPORTED",
	"AGENT_ACCESS_NEEDS_ORG_ADMIN",
	"PROJECT_NOT_ADMINISTERED",
	"TARGETS_NOT_LISTED",
	...REVIEW_RUN_REFUSAL_CODES,
	...BINDING_TARGET_REFUSAL_CODES,
	...GATE_PROFILE_REFUSAL_CODES,
] as const;

export type ProjectConfigRefusalCode =
	(typeof PROJECT_CONFIG_REFUSAL_CODES)[number];
export const PROJECT_CONFIG_REFUSAL_STATUSES = {
	STALE_BASE: 409,
	AGENT_ACCESS_NEEDS_ORG_ADMIN: 403,
	PROJECT_NOT_ADMINISTERED: 403,
	GATE_PROFILE_RAISED: 403,
	GATES_NO_PROJECT_DOCUMENT: 409,
	REVIEW_RUN_NOT_A_PERSON: 403,
} as const satisfies RefusalStatuses<ProjectConfigRefusalCode>;

/** Reading an environment's deployed state through its binding. */
export const ENVIRONMENT_STATE_REFUSAL_CODES = [
	"BINDING_NOT_FOUND",
	"BINDING_ROLE_MISMATCH",
	"DEPLOY_HISTORY_UNSUPPORTED",
] as const;

export type EnvironmentStateRefusalCode =
	(typeof ENVIRONMENT_STATE_REFUSAL_CODES)[number];

/** Dispatch refused because the project's policy cannot say how this work runs. */
export const POLICY_REFUSAL_CODES = [
	"POLICY_UNDECLARED",
	"POLICY_STATE_UNDECLARED",
] as const;

export type PolicyRefusalCode = (typeof POLICY_REFUSAL_CODES)[number];

export const TESTING_SECRETS_REFUSAL_CODES = [
	"TESTING_SECRETS_NOT_A_JOB_CREDENTIAL",
	/** The run named is one this box declared, and it has ended. */
	"TESTING_SECRETS_RUN_ENDED",
	/** The run named is one this box declared, and core has not admitted it (its declaration is queued). */
	"TESTING_SECRETS_RUN_NOT_ADMITTED",
	/** A box credential names an id core holds no run of: a run declared moments ago that the box's sweep has not recorded at core yet, or no run of this box at all. */
	"TESTING_SECRETS_RUN_NOT_RECORDED",
	/** The run named works another project than the one the credential is bound to. */
	"TESTING_SECRETS_FOREIGN_RUN",
	"TESTING_SECRETS_JOB_AMBIGUOUS",
	"TESTING_SECRETS_FOREIGN_JOB",
	"TESTING_SECRETS_JOB_NOT_JUDGING",
	"TESTING_SECRETS_NO_PROJECT_DOCUMENT",
	"TESTING_SECRETS_NOT_LANDED",
	/** A judge run declared at a requirement, where nothing names the environment it judges: no delivering issue landed, no `delivery.judgedOn`, no production (ISS-975). */
	"TESTING_SECRETS_NO_JUDGED_ENVIRONMENT",
	"TESTING_SECRETS_NO_ENVIRONMENT_FOR_TARGET",
	"TESTING_SECRETS_ENVIRONMENT_AMBIGUOUS",
	"TESTING_SECRETS_NO_TESTING_PROFILE",
	"TESTING_PROFILE_NOT_NAMED",
	"TESTING_PROFILE_NOT_DECLARED",
	/** A read named no actor, service or ref: a run receives only the one secret it names (ISS-868). */
	"TESTING_SECRET_UNCHOSEN",
	/** A read named more than one of actor, service and ref: one secret per read (ISS-868). */
	"TESTING_SECRET_ONE_PER_READ",
	"SECRET_NOT_NAMED",
	"SECRET_VALUE_MISSING",
	"SECRET_VALUE_UNREADABLE",
	"SECRET_TOO_SHORT_TO_SCRUB",
	"VAULT_NOT_CONFIGURED",
	/** A profile's `var://KEY` has no variable effective on the environment judged (REQ-80 BC-7). */
	"VARIABLE_REF_UNRESOLVED",
] as const;

export type TestingSecretsRefusalCode =
	(typeof TESTING_SECRETS_REFUSAL_CODES)[number];

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

const POLICY_QA_MODES = ["self", "independent"] as const;
export type PolicyQaMode = (typeof POLICY_QA_MODES)[number];
const POLICY_MODELS = ["opus", "sonnet", "haiku", "fable"] as const;
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
