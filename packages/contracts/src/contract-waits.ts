// One declaration of the contract-wait vocabulary (REQ-9, decisions E1 and E4): an issue waits on
// `contract >= version`, never on another project's issue. Core's table CHECKs, the REST doors and
// the web import the codes, request schemas and views from here.

import { z } from "zod";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";

/** `<provider project slug>/<contract slug>`, as an interface publishes or consumes it. */
export const CONTRACT_REF_PATTERN =
	/^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})$/;

export const CONTRACT_WAIT_LIMITS = { version: 40, reason: 1000 } as const;

export const CONTRACT_WAIT_REFUSAL_CODES = [
	"CONTRACT_WAIT_CONTRACT_UNKNOWN",
	"CONTRACT_WAIT_VERSION_NOT_IN_SCHEME",
	"CONTRACT_WAIT_DUPLICATE",
	"CONTRACT_WAIT_RETRACTED",
	"CONTRACT_WAIT_ISSUE_FINISHED",
	"CONTRACT_WAIT_DUE_MALFORMED",
	"CONTRACT_WAIT_DUE_PAST",
	...PERMISSION_REFUSAL_CODES,
] as const;
export type ContractWaitRefusalCode =
	(typeof CONTRACT_WAIT_REFUSAL_CODES)[number];

/** A dispatch door refuses an issue whose live wait no approved version has settled. */
export const CONTRACT_WAIT_UNSETTLED = "CONTRACT_WAIT_UNSETTLED" as const;

/** A production release refuses a consumer issue whose provider does not serve the version it waits on. */
export const CONTRACT_PROVIDER_NOT_LIVE = "CONTRACT_PROVIDER_NOT_LIVE" as const;

/** The ecosystem's `releases.providerLive`: absent is `required` (E4). */
export const PROVIDER_LIVE_MODES = ["required", "off"] as const;
export type ProviderLiveMode = (typeof PROVIDER_LIVE_MODES)[number];

export interface ContractWaitRefusal {
	code: ContractWaitRefusalCode;
	path: string;
	detail: string;
}

export const addContractWaitRequestSchema = z.strictObject({
	contract: z.string().trim().regex(CONTRACT_REF_PATTERN),
	minVersion: z.string().trim().min(1).max(CONTRACT_WAIT_LIMITS.version),
	reason: z.string().trim().min(1).max(CONTRACT_WAIT_LIMITS.reason).optional(),
	/** The deadline the wait is worked to; checked by core, so a malformed or past one is refused by name. */
	dueAt: z.string().trim().min(1).max(40).optional(),
});
export type AddContractWaitRequest = z.infer<
	typeof addContractWaitRequestSchema
>;
export const ADD_CONTRACT_WAIT_SHAPE =
	"{ contract: <provider slug>/<contract slug>, a contract this project publishes or consumes; minVersion: the version this issue needs, in the provider's versioning scheme; reason?; dueAt?: an ISO 8601 date-time with its zone, in the future }";

export const retractContractWaitRequestSchema = z.strictObject({
	reason: z.string().trim().min(1).max(CONTRACT_WAIT_LIMITS.reason),
});
export type RetractContractWaitRequest = z.infer<
	typeof retractContractWaitRequestSchema
>;
export const RETRACT_CONTRACT_WAIT_SHAPE =
	"{ reason } says why the issue no longer waits";

/** The version a consumer needs beside the version its provider's production serves (step provider-live). */
export interface ProviderLiveView {
	needed: string;
	live: string | null;
	/** Why no live version could be placed; null where one was. */
	unread: string | null;
	gate: ProviderLiveMode;
}

export interface ContractWaitView {
	id: string;
	issue: string;
	contract: string;
	provider: { id: string; slug: string };
	/** The provider is this issue's own project: a contract written first inside it (step contract-first). */
	inProject: boolean;
	minVersion: string;
	reason: string | null;
	settled: boolean;
	settledVersion: string | null;
	settledAt: string | null;
	/** The provider's newest approved version, whether or not it settles this wait. */
	current: string | null;
	createdBy: string;
	createdAt: string;
	retractedAt: string | null;
	retractReason: string | null;
	/** The deadline the wait is worked to: the provider's commitment window where a breaking version's feedback wrote it, or the one it was added with. */
	dueAt: string | null;
	/** Null for an in-project or retracted wait, which no release gate reads. */
	providerLive: ProviderLiveView | null;
}

export interface IssueContractWaits {
	waits: ContractWaitView[];
	dispatchable: boolean;
	refusal: { code: typeof CONTRACT_WAIT_UNSETTLED; detail: string } | null;
}

export interface ContractWaitResponse {
	wait: ContractWaitView;
}

/** A consumer issue whose wait its provider's production does not serve yet. */
export interface LiveShortfall {
	issueId: string;
	issue: string;
	contract: string;
	needed: string;
	live: string | null;
	unread: string | null;
}

/** The release gate's reading of a roster (E4): the waits it refuses on, and those the ecosystem's off switch let through. */
export interface ProviderLiveGate {
	shortfalls: LiveShortfall[];
	/** Recorded on the release as gate off: the provider did not serve the version, and the gate was off. */
	gateOff: LiveShortfall[];
}

export function notLiveSentence(shortfalls: readonly LiveShortfall[]): string {
	const each = shortfalls
		.map(
			(s) =>
				`\`${s.issue}\` needs ${s.contract} >= ${s.needed}, and its provider's production serves ${s.live ?? `no version Forge could place${s.unread ? ` (${s.unread})` : ""}`}`,
		)
		.join("; ");
	return `${CONTRACT_PROVIDER_NOT_LIVE}: a production release waits for each provider to serve the contract version its issues wait on: ${each}. Release once the provider does, or take the issue out of this release; the ecosystem's steward can set releases.providerLive to "off" where this gate is not wanted.`;
}
