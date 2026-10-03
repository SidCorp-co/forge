// How a person reads enums whose values are declared outside contracts (core's db schema, its
// ecosystem and pipeline modules): one label and one legend tone per value, so a screen draws them
// through the shared badge and never prints the stored token. An enum that moves into contracts
// takes its reading with it (domain-entities.md, "Badges"); until then this file is its one reading.

import type { IssueStatusTone } from "./issue-vocabulary.js";

/** A state value's reading: sentence-case label, legend tone, and the glyph drawn for its dot. */
export type Reading = readonly [label: string, tone: IssueStatusTone, glyph?: string];

/** Each state family keyed by its stored values. */
export const STATE_READINGS = {
	/** A pipeline run's per-step rollup (web `pipeline/types.ts:PipelineStepStatus`). */
	runStep: {
		pending: ["Pending", "neutral", "○"],
		running: ["Running", "run", "●"],
		completed: ["Completed", "ready", "✓"],
		failed: ["Failed", "err", "×"],
		skipped: ["Skipped", "done", "–"],
	},
	/** An agent session (core `db/session-vocabulary.ts:agentSessionStatuses`). */
	session: {
		idle: ["Idle", "neutral", "○"],
		queued: ["Queued", "neutral", "○"],
		running: ["Running", "run", "●"],
		completed: ["Completed", "done", "✓"],
		failed: ["Failed", "err", "×"],
		completed_via_recovery: ["Completed by recovery", "done", "✓"],
		cancelled_stale: ["Cancelled as stale", "done", "–"],
		cancelled: ["Cancelled", "done", "–"],
	},
	/** A builder run step (web `ecosystem/bus.ts:StepStatus`). */
	builderStep: {
		pending: ["Pending", "neutral", "○"],
		running: ["Running", "run", "●"],
		succeeded: ["Succeeded", "ready", "✓"],
		failed: ["Failed", "err", "×"],
		skipped: ["Skipped", "done", "–"],
		superseded: ["Superseded", "done", "–"],
	},
	/** A consumer's link to a contract (core `ecosystem/link-schema.ts`). */
	link: {
		building: ["Building", "run", "●"],
		current: ["Current", "ready", "✓"],
		behind: ["Behind", "you", "!"],
		breaking: ["Breaking", "err", "×"],
		unverified: ["Unverified", "neutral", "○"],
	},
	/** A check of a consumer against a version (web `ecosystem/bus.ts`). */
	check: {
		breaks: ["Breaks", "err", "×"],
		passes: ["Passes", "ready", "✓"],
		unchecked: ["Unchecked", "neutral", "○"],
	},
	/** A contract version's measured diff (core `ecosystem/contract/diff.ts:MEASURED_CLASSIFICATIONS`). */
	classification: {
		breaking: ["Breaking", "err", "!"],
		"non-breaking": ["Non-breaking", "ready", "✓"],
		unknown: ["Unknown", "neutral", "?"],
		initial: ["Initial", "neutral", "○"],
	},
	/** One change's level in a diff (core `ecosystem/contract/diff.ts:CHANGE_LEVELS`). */
	changeLevel: {
		breaking: ["Breaking", "err", "!"],
		warning: ["Warning", "you", "!"],
		info: ["Info", "neutral", "○"],
	},
	/** A recorded measurement of a contract (core `ecosystem/contract/store.ts`). */
	measurement: {
		pending: ["Pending", "neutral", "○"],
		recorded: ["Recorded", "ready", "✓"],
		unchanged: ["Unchanged", "done", "–"],
		stale: ["Stale", "neutral", "↻"],
		refused: ["Refused", "err", "×"],
	},
	/** A channel document (core `ecosystem/channel-schema.ts`). */
	document: {
		draft: ["Draft", "neutral", "○"],
		submitted: ["Submitted", "you", "●"],
		returned: ["Returned", "err", "↺"],
		published: ["Published", "ready", "✓"],
		withdrawn: ["Withdrawn", "done", "×"],
		superseded: ["Superseded", "done", "–"],
	},
	/** A release attempt's health and its verdict (web `releases/types.ts`). */
	health: {
		up: ["Up", "ready", "●"],
		down: ["Down", "err", "●"],
	},
	attemptVerdict: {
		ok: ["Verified", "ready", "✓"],
		failed: ["Failed", "err", "×"],
		unverified: ["Unverified", "neutral", "○"],
	},
	/** An operator alert (core `admin/types.ts:AdminAlertStatus`). */
	alert: {
		ok: ["OK", "ready", "✓"],
		warn: ["Warning", "you", "!"],
		crit: ["Critical", "err", "!"],
	},
	/** A memory reindex (contracts `status-sets.ts:MEMORY_REINDEX_STATES`). */
	reindex: {
		queued: ["Queued", "neutral", "○"],
		running: ["Running", "run", "●"],
		completed: ["Completed", "ready", "✓"],
		failed: ["Failed", "err", "×"],
		cancelled: ["Cancelled", "done", "–"],
	},
	/** An environment's deployment reading (web `project-settings/config-types.ts`). */
	deployment: {
		deployed: ["Deployed", "ready", "✓"],
		deploying: ["Deploying", "run", "●"],
		failed: ["Failed", "err", "×"],
		cancelled: ["Cancelled", "done", "–"],
		unknown: ["Unknown", "neutral", "?"],
		queued: ["Queued", "neutral", "○"],
		running: ["Running", "run", "●"],
		succeeded: ["Succeeded", "ready", "✓"],
	},
	/** A runtime probe (web `project-settings/config-types.ts`). */
	probe: {
		confirmed: ["Confirmed", "ready", "✓"],
		mismatch: ["Mismatch", "err", "×"],
		uncompared: ["Not compared", "neutral", "○"],
		unreachable: ["Unreachable", "blocked", "!"],
	},
	/** A run's question (web `questions/types.ts:QuestionStatus`). */
	question: {
		open: ["Open", "you", "?"],
		answered: ["Answered", "done", "✓"],
		void: ["Void", "done", "–"],
		expired: ["Expired", "done", "–"],
		needs_info: ["Needs info", "you", "?"],
	},
	/** A skill-update run and its verdict (contracts `reconcile.ts`). */
	reconcileVerdict: {
		"no-op": ["No change", "done", "–"],
		apply: ["Apply", "ready", "✓"],
		"apply-with-adaptation": ["Apply with changes", "ready", "✓"],
		escalate: ["Escalate", "you", "!"],
	},
	vote: {
		pass: ["Pass", "ready", "✓"],
		fail: ["Fail", "err", "×"],
	},
	/** A runner device (web `runners/types.ts`) and a runner (core `db/schema.ts`). */
	device: {
		online: ["Online", "ready", "●"],
		offline: ["Offline", "blocked", "○"],
		revoked: ["Revoked", "done", "×"],
		draining: ["Draining", "you", "◐"],
		disabled: ["Disabled", "done", "–"],
	},
	/** An integration connection test (contracts `integrations.ts`). */
	connection: {
		ok: ["OK", "ready", "✓"],
		degraded: ["Degraded", "you", "!"],
		error: ["Error", "err", "×"],
		needs_reauth: ["Needs sign-in again", "you", "!"],
		needs_scope: ["Needs more access", "you", "!"],
	},
	/** A release approval's decision (web `releases/types.ts`). */
	release: {
		approved: ["Approved", "ready", "✓"],
		returned: ["Returned", "err", "↺"],
	},
} as const satisfies Record<string, Record<string, Reading>>;

export type StateReadingFamily = keyof typeof STATE_READINGS;

/** Non-state enums: a label only; their badge is neutral. A value a map does not name reads
 *  sentence-cased. */
export const ENUM_LABELS = {
	/** Job types (contracts `pipeline-registry.ts:REGISTRY_JOB_TYPES`). */
	jobType: {
		triage: "Triage",
		clarify: "Clarify",
		plan: "Plan",
		code: "Code",
		review: "Review",
		test: "Test",
		staging: "Staging",
		release: "Release",
		fix: "Fix",
		custom: "Custom",
		pm: "PM",
		smoke: "Smoke",
		release_batch: "Release batch",
		reconcile: "Reconcile",
		verify_skill: "Verify skill",
		drive: "Drive",
	},
	/** A contract change's kind (core `ecosystem/contract/diff.ts:CHANGE_KINDS`). */
	changeKind: { added: "Added", removed: "Removed", changed: "Changed", deprecated: "Deprecated" },
	/** An interface's document type (core `ecosystem/schema.ts`). */
	interfaceType: {
		openapi: "OpenAPI",
		asyncapi: "AsyncAPI",
		"mcp-tools": "MCP tools",
		"json-schema": "JSON Schema",
		graphql: "GraphQL",
		protobuf: "Protobuf",
		opaque: "Opaque",
	},
	lifecycle: { experimental: "Experimental", production: "Production", deprecated: "Deprecated" },
	versioning: { dated: "Dated", semver: "SemVer" },
	visibility: { counterparties: "counterparties", all: "everyone" },
	platform: { macos: "macOS", linux: "Linux", windows: "Windows" },
	role: { viewer: "Viewer", member: "Member", admin: "Admin", owner: "Owner" },
	trigger: { manual: "Manual", scheduled: "Scheduled", joined: "Joined", push: "Push" },
	sessionKind: { master: "Master", run_session: "Run session", pipeline: "Pipeline", pm: "PM", chat: "Chat" },
	blockerKind: { machine: "Machine", master_or_peer: "Master or peer", human: "Person" },
	dependencyKind: { blocks: "Blocks", relates: "Relates to", duplicates: "Duplicates", parent: "Parent of", decomposes: "Decomposes" },
	mode: { propose: "Propose", auto: "Automatic" },
	direction: { outbound: "Outbound", inbound: "Inbound" },
	gate: { auto: "Automatic", human: "Person" },
	pauseKind: { stage_stalled: "a stalled stage" },
} as const satisfies Record<string, Record<string, string>>;

export type EnumLabelFamily = keyof typeof ENUM_LABELS;
