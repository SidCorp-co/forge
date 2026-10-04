// cm:why one declaration of the cross-project contract vocabulary (decisions E1-E4, ISS-61): core's
// table CHECKs, REST, MCP and the web import the codes, the request schemas and the views from here.

import { z } from "zod";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";

export const CONTRACT_REF_PATTERN =
	/^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})$/;

export const CHANGE_REQUEST_NUMBER_PATTERN = /^[A-Z][A-Z0-9]{1,5}-CR-[1-9][0-9]{0,5}$/;

export const CONTRACT_WAIT_LIMITS = { version: 40, reason: 1000 } as const;

export const CONTRACT_WAIT_AGENCIES = ["human", "agent"] as const;
export type ContractWaitAgency = (typeof CONTRACT_WAIT_AGENCIES)[number];

export const CONTRACT_WAIT_REFUSAL_CODES = [
	"CONTRACT_WAIT_CONTRACT_UNKNOWN",
	"CONTRACT_WAIT_NOT_SHARED",
	"CONTRACT_WAIT_OWN_CONTRACT",
	"CONTRACT_WAIT_VERSION_NOT_IN_SCHEME",
	"CONTRACT_WAIT_DUPLICATE",
	"CONTRACT_WAIT_REQUEST_MISMATCH",
	"CONTRACT_WAIT_RETRACTED",
	...PERMISSION_REFUSAL_CODES,
	"CONTRACT_REQUEST_PROVIDER_UNKNOWN",
] as const;
export type ContractWaitRefusalCode = (typeof CONTRACT_WAIT_REFUSAL_CODES)[number];

export const CONTRACT_WAIT_UNSETTLED = "CONTRACT_WAIT_UNSETTLED" as const;
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
	request: z.string().trim().regex(CHANGE_REQUEST_NUMBER_PATTERN).optional(),
});
export type AddContractWaitRequest = z.infer<typeof addContractWaitRequestSchema>;
export const ADD_CONTRACT_WAIT_SHAPE =
	"{ contract: <provider slug>/<publication slug>, minVersion: the version this issue needs, in the provider's versioning scheme, reason?, request?: the change request number it rides on, e.g. HOP-CR-3 }";

export const retractContractWaitRequestSchema = z.strictObject({
	reason: z.string().trim().min(1).max(CONTRACT_WAIT_LIMITS.reason),
});
export const RETRACT_CONTRACT_WAIT_SHAPE = "{ reason } says why the issue no longer waits";

export interface ContractRequestRef {
	number: string;
	requirement: string;
	requirementStatus: string;
}

export interface ContractWaitView {
	id: string;
	issue: string;
	contract: string;
	provider: { id: string; slug: string };
	minVersion: string;
	reason: string | null;
	settled: boolean;
	settledBy: string | null;
	settledAt: string | null;
	current: string | null;
	request: ContractRequestRef | null;
	createdBy: string;
	createdAgency: ContractWaitAgency;
	createdAt: string;
	retractedAt: string | null;
	retractReason: string | null;
}

export interface IssueContractWaits {
	waits: ContractWaitView[];
	dispatchable: boolean;
	refusal: { code: typeof CONTRACT_WAIT_UNSETTLED; detail: string } | null;
}

export interface ContractWaitResponse {
	wait: ContractWaitView;
}

export interface ContractWaitListResponse extends IssueContractWaits {}

export const CONTRACT_REQUEST_DIRECTIONS = ["outgoing", "incoming"] as const;
export type ContractRequestDirection = (typeof CONTRACT_REQUEST_DIRECTIONS)[number];

export interface ContractRequestView {
	id: string;
	number: string;
	direction: ContractRequestDirection;
	contract: string;
	consumer: { id: string; slug: string };
	provider: { id: string; slug: string };
	requirement: { key: string; title: string; status: string };
	requestedBy: string;
	requestedAgency: ContractWaitAgency;
	createdAt: string;
}

export interface ContractRequestListResponse {
	requests: ContractRequestView[];
}

/** A consumer issue whose wait the provider's production does not yet serve. */
export interface LiveShortfall {
	issueId: string;
	issue: string;
	contract: string;
	needed: string;
	live: string | null;
}

export function notLiveSentence(shortfalls: readonly LiveShortfall[]): string {
	const each = shortfalls
		.map(
			(s) =>
				`\`${s.issue}\` needs ${s.contract} >= ${s.needed}, and its provider's production serves ${s.live ?? "no version Forge could read"}`,
		)
		.join("; ");
	return `A production release of this project waits for each provider to serve the contract version its issues wait on: ${each}. Release once the provider has, or take the issue out of this release; the ecosystem's steward can set releases.providerLive to "off" where this gate is not wanted.`;
}
