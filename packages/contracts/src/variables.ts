// A project's environment variables (REQ-80, design `environment-variables`): held in Forge per
// environment the way GitLab holds CI/CD variables, changed only by a holder of `env.manage`,
// audited by fingerprint and never by value, handed to the runs that target an environment, and
// referenced from testing profiles. Forge manages them; it never writes a deploy target (owner,
// 2026-10-30).

import { z } from "zod";
import { REASON_TEXT_MAX } from "./reason-text.js";
import type { RefusalStatuses } from "./refusal.js";

/** plain: shown to a holder of env.manage; secret: masked, revealed one at a time; file: a file's content. */
export const VARIABLE_TYPES = ["plain", "secret", "file"] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

/** The types whose value is masked in a list and scrubbed from what a run prints. */
export const MASKED_VARIABLE_TYPES: readonly VariableType[] = ["secret", "file"];

/** An environment variable's name, as a shell and a container runtime take it. */
export const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

/** A value's cap: a certificate or a key file fits, a database dump does not. */
export const VARIABLE_VALUE_MAX = 65_536;

/** The permission that adds, edits, deletes, reveals and decides proposals (admin's by default). */
export const ENV_MANAGE = "env.manage" as const;

/** A testing profile's reference to a stored variable, in place of a `secret://` copy (BC-7). */
export const VARIABLE_REF = /^var:\/\/([A-Za-z_][A-Za-z0-9_]{0,254})$/;

/** The key a `var://KEY` reference names, or null when the text is not one. */
export function parseVariableRef(ref: string): string | null {
	return VARIABLE_REF.exec(ref)?.[1] ?? null;
}

export const variableRefOf = (key: string) => `var://${key}`;

export const VARIABLE_REFUSAL_CODES = [
	/** The answer's own code where a write is refused for several reasons at once. */
	"VARIABLE_REFUSED",
	/** The key is not an environment variable name. */
	"VARIABLE_KEY_SHAPE",
	/** The scope names an environment the project document does not declare. */
	"VARIABLE_ENVIRONMENT_UNKNOWN",
	/** A protected variable scoped to an environment whose tier is not production (BC-2). */
	"VARIABLE_PROTECTED_NOT_PRODUCTION",
	/** A secret or file value shorter than the log scrubber replaces. */
	"VARIABLE_SECRET_TOO_SHORT",
	/** The project already holds that key at that scope. */
	"VARIABLE_EXISTS",
	/** The version sent is not the one stored: re-read and retry. */
	"VARIABLE_STALE",
	/** No variable of that id, or no variable of that key, on this project. */
	"VARIABLE_NOT_FOUND",
	/** An agent credential writes no variable directly: it proposes (BC-6). */
	"VARIABLE_AGENT_PROPOSES",
	/** An agent credential reads no value outside a run (BC-6). */
	"VARIABLE_VALUE_AGENT_REFUSED",
	/** A run asked for a key no variable effective on that environment holds (BC-8). */
	"VARIABLE_KEY_UNKNOWN",
	/** A run asked for a protected key it is not given (BC-8). */
	"VARIABLE_PROTECTED_WITHHELD",
	/** A stored value does not decrypt under this core's key. */
	"VARIABLE_VALUE_UNREADABLE",
	/** The vault key is not set, so nothing can be encrypted or decrypted. */
	"VARIABLE_VAULT_NOT_CONFIGURED",
	/** A proposal names an issue this project does not hold. */
	"VARIABLE_PROPOSAL_ISSUE_UNKNOWN",
	/** A proposal to set a value carries none, or one to delete carries one. */
	"VARIABLE_PROPOSAL_SHAPE",
	/** No proposal of that id on this project. */
	"VARIABLE_PROPOSAL_NOT_FOUND",
	/** The proposal was already approved or rejected. */
	"VARIABLE_PROPOSAL_DECIDED",
] as const;
export type VariableRefusalCode = (typeof VARIABLE_REFUSAL_CODES)[number];

export const VARIABLE_REFUSAL_STATUSES = {
	VARIABLE_EXISTS: 409,
	VARIABLE_STALE: 409,
	VARIABLE_NOT_FOUND: 404,
	VARIABLE_AGENT_PROPOSES: 403,
	VARIABLE_VALUE_AGENT_REFUSED: 403,
	VARIABLE_PROTECTED_WITHHELD: 403,
	VARIABLE_VAULT_NOT_CONFIGURED: 503,
	VARIABLE_PROPOSAL_NOT_FOUND: 404,
	VARIABLE_PROPOSAL_DECIDED: 409,
} as const satisfies RefusalStatuses<VariableRefusalCode>;

const key = z.string().regex(VARIABLE_KEY, "a key is a letter or underscore, then letters, digits or underscores, at most 255 characters");
const value = z.string().max(VARIABLE_VALUE_MAX);
/** null: every environment; a name: the one environment the project document declares under it. */
const environment = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).nullable();

/** `POST /api/projects/:id/variables`. */
export const createVariableRequestSchema = z.strictObject({
	key,
	value,
	environment,
	type: z.enum(VARIABLE_TYPES),
	protected: z.boolean(),
});
export type CreateVariableRequest = z.infer<typeof createVariableRequestSchema>;

/** `PUT /api/projects/:id/variables/:variable`: what changes, against the version read. Key and scope stay. */
export const updateVariableRequestSchema = z.strictObject({
	baseVersion: z.number().int().min(1),
	value: value.optional(),
	type: z.enum(VARIABLE_TYPES).optional(),
	protected: z.boolean().optional(),
});
export type UpdateVariableRequest = z.infer<typeof updateVariableRequestSchema>;

export const VARIABLE_PROPOSAL_ACTS = ["set", "delete"] as const;
export type VariableProposalAct = (typeof VARIABLE_PROPOSAL_ACTS)[number];

/** `POST /api/projects/:id/variables/proposals`: a change an issue needs, held until decided (BC-6). */
export const proposeVariableRequestSchema = z.strictObject({
	issue: z.string().trim().min(1).max(200),
	act: z.enum(VARIABLE_PROPOSAL_ACTS),
	key,
	environment,
	type: z.enum(VARIABLE_TYPES).optional(),
	protected: z.boolean().optional(),
	value: value.optional(),
	reason: z.string().trim().min(1).max(REASON_TEXT_MAX),
});
export type ProposeVariableRequest = z.infer<typeof proposeVariableRequestSchema>;

export const VARIABLE_DECISIONS = ["approve", "reject"] as const;
export type VariableDecision = (typeof VARIABLE_DECISIONS)[number];

export const decideVariableProposalRequestSchema = z.strictObject({
	decision: z.enum(VARIABLE_DECISIONS),
	reason: z.string().trim().min(1).max(REASON_TEXT_MAX),
});
export type DecideVariableProposalRequest = z.infer<typeof decideVariableProposalRequestSchema>;

/** One variable as a list answers it: the value only where the reader may see it (BC-1, BC-6). */
export interface VariableView {
	id: string;
	key: string;
	environment: string | null;
	type: VariableType;
	protected: boolean;
	/** A keyed digest of the value: equal values read equal, and no value can be read back from it. */
	fingerprint: string;
	version: number;
	/** The value, for a plain or file variable read by a person holding env.manage; null otherwise. */
	value: string | null;
	updatedAt: string;
	updatedBy: string | null;
}

export const VARIABLE_EVENT_ACTS = [
	"created",
	"updated",
	"deleted",
	"revealed",
	"proposed",
	"approved",
	"rejected",
	"delivered",
] as const;
export type VariableEventAct = (typeof VARIABLE_EVENT_ACTS)[number];

/** One audit row: who did what to which key, by fingerprint; never a value (BC-2). */
export interface VariableEventView {
	id: string;
	act: VariableEventAct;
	key: string;
	environment: string | null;
	actor: string | null;
	agency: "human" | "agent" | null;
	oldFingerprint: string | null;
	newFingerprint: string | null;
	detail: Record<string, unknown>;
	at: string;
}

export const VARIABLE_PROPOSAL_STATUSES = ["proposed", "approved", "rejected"] as const;
export type VariableProposalStatus = (typeof VARIABLE_PROPOSAL_STATUSES)[number];

export interface VariableProposalView {
	id: string;
	issueId: string;
	act: VariableProposalAct;
	key: string;
	environment: string | null;
	type: VariableType | null;
	protected: boolean | null;
	/** The proposed value's fingerprint; the value itself is never answered. */
	fingerprint: string | null;
	status: VariableProposalStatus;
	reason: string;
	proposedBy: string | null;
	decidedBy: string | null;
	decisionReason: string | null;
	createdAt: string;
	decidedAt: string | null;
}

/** What a run receives for the environment it targets (BC-8). */
export interface RunVariablesView {
	environment: string;
	run: { kind: "job"; id: string } | { kind: "run"; id: string; session: string };
	variables: { key: string; type: VariableType; value: string }[];
	/** Protected keys this run is not given, said rather than silently left out. */
	withheld: string[];
}
