// How a person reads enums whose values are declared outside contracts (core's db schema, its
// ecosystem and pipeline modules): one label and one legend tone per value, so a screen draws them
// through the shared badge and never prints the stored token. An enum that moves into contracts
// takes its reading with it (domain-entities.md, "Badges"); until then this file is its one reading.

import type { AgentReportTriage } from "./agent-reports.js";
import type { ScheduleState } from "./automation-standing.js";
import type { IssueStatusTone } from "./issue-vocabulary.js";
import type { JobStatus } from "./job-machine.js";
import type { MasterState, MasterVerb } from "./master-standing.js";
import type {
	RunActorType,
	RunEventEntity,
	RunExpirySource,
	RunHandbackClose,
	RunLane,
	RunState,
} from "./run-standing.js";
import type {
	ScheduleKind,
	ScheduleRunSkipReason,
	ScheduleRunStatus,
	ScheduleRunTrigger,
} from "./schedules.js";

/** A state value's reading: sentence-case label, legend tone, and the glyph drawn for its dot. */
export type Reading = readonly [
	label: string,
	tone: IssueStatusTone,
	glyph?: string,
];

/** Each state family keyed by its stored values. */
export const STATE_READINGS = {
	/** A pipeline run's per-step rollup (web `pipeline/types.ts:PipelineStepStatus`). */
	runStep: {
		pending: ["Pending", "neutral", "○"],
		running: ["Running", "run", "●"],
		completed: ["Completed", "ready", "✓"],
		failed: ["Failed", "err", "×"],
		cancelled: ["Cancelled", "done", "–"],
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
	/** A channel document (core `ecosystem/channel-schema.ts`). */
	document: {
		draft: ["Draft", "neutral", "○"],
		submitted: ["Submitted", "you", "●"],
		returned: ["Returned", "err", "↺"],
		published: ["Published", "ready", "✓"],
		withdrawn: ["Withdrawn", "done", "×"],
		superseded: ["Superseded", "done", "–"],
	},
	/** A release attempt's health and its verdict (contracts `releases.ts:ReleaseAttemptView`). */
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
	/** What an ecosystem builder made of one outbound call (web `ecosystem/bus.ts:Finding`). */
	finding: {
		matched: ["Matched", "ready", "✓"],
		outside_ecosystem: ["Outside the ecosystem", "neutral", "↗"],
		unknown: ["Unknown", "you", "?"],
	},
	/** Whether a reply a document is owed has come (core `ecosystem/channel-register.ts:RecipientStatus`). */
	replyOwed: {
		awaiting: ["Awaiting a reply", "you", "●"],
		answered: ["Answered", "done", "✓"],
		overdue: ["Overdue", "err", "!"],
		"not-owed": ["Owes no reply", "neutral", "–"],
	},
	/** A webhook or dispatch delivery (core `db/schema-integration-types.ts:integrationDeliveryStatuses`). */
	delivery: {
		pending: ["Pending", "neutral", "○"],
		ok: ["Delivered", "ready", "✓"],
		failed: ["Failed", "err", "×"],
		refused: ["Refused", "err", "×"],
	},
	/** One action a steward run reports (web `schedules/types.ts:StewardRunReportAction`). */
	stewardAction: {
		applied: ["Applied", "ready", "✓"],
		proposed: ["Proposed", "you", "●"],
		feedback: ["Feedback", "neutral", "○"],
		skipped: ["Skipped", "done", "–"],
	},
	/** A fire's status (contracts `schedules.ts:SCHEDULE_RUN_STATUSES`). */
	scheduleRun: {
		success: ["Succeeded", "ready", "✓"],
		failed: ["Failed", "err", "×"],
		running: ["Running", "run", "●"],
		skipped: ["Skipped", "done", "–"],
	} satisfies Record<ScheduleRunStatus, Reading>,
	/** A schedule's standing (contracts `automation-standing.ts:SCHEDULE_STATES`). */
	scheduleStanding: {
		on: ["On", "ready", "●"],
		firing: ["Firing", "run", "●"],
		failing: ["Failing", "err", "×"],
		owner_gone: ["Owner gone", "you", "!"],
		off: ["Off", "done", "–"],
	} satisfies Record<ScheduleState, Reading>,
	/** What a person decided an agent report is (contracts `agent-reports.ts:AGENT_REPORT_TRIAGES`). */
	reportTriage: {
		new: ["New", "you", "●"],
		filed: ["Filed", "ready", "✓"],
		dismissed: ["Dismissed", "done", "–"],
		duplicate: ["Duplicate", "done", "="],
	} satisfies Record<AgentReportTriage, Reading>,
	/** Whether a C4 design names an outside system's integration as settled (web `workflows/c4/geometry.ts:IntegrationState`). */
	integration: {
		confirmed: ["Confirmed", "ready", "✓"],
		unconfirmed: ["Unconfirmed", "you", "?"],
	},
	/** How an issue's shipped claim was recorded (web `issues/types.ts:MergeMarkKind`). */
	mergeMark: {
		landed: ["Landed", "ready", "✓"],
		observed: ["Observed", "ready", "✓"],
		asserted: ["Claimed", "you", "!"],
	},
	/** A release approval's decision (contracts `releases.ts:ReleaseApprovalView`). */
	release: {
		pending: ["Awaiting approval", "you", "●"],
		approved: ["Approved", "ready", "✓"],
		returned: ["Returned", "err", "↺"],
	},
	buildGate: {
		open: ["Open", "ready", "✓"],
		held: ["Held", "blocked", "○"],
	},
	runStanding: {
		queued: ["Queued", "ready", "○"],
		claimed: ["Claimed", "run", "◔"],
		running: ["Running", "run", "●"],
		waiting_person: ["Waiting on a person", "you", "?"],
		waiting_gate: ["Waiting on a gate", "blocked", "‖"],
		stuck: ["Stuck", "err", "!"],
		done: ["Done", "done", "✓"],
		failed: ["Failed", "err", "✕"],
		cancelled: ["Cancelled", "done", "–"],
		handed_back: ["Handed back", "neutral", "↩"],
	} satisfies Record<RunState, Reading>,
	job: {
		queued: ["Queued", "neutral", "○"],
		dispatched: ["Dispatched", "run", "◔"],
		held: ["Held", "blocked", "‖"],
		done: ["Done", "done", "✓"],
		failed: ["Failed", "err", "✕"],
		cancelled: ["Cancelled", "done", "–"],
	} satisfies Record<JobStatus, Reading>,
	pipelineRun: {
		running: ["Running", "run", "●"],
		paused: ["Paused", "blocked", "‖"],
		completed: ["Completed", "done", "✓"],
		failed: ["Failed", "err", "✕"],
		cancelled: ["Cancelled", "done", "–"],
	},
	masterState: {
		in_pass: ["In a pass", "run", "●"],
		idle: ["Idle", "neutral", "○"],
		silent: ["Silent", "err", "!"],
		none: ["No master", "you", "?"],
	} satisfies Record<MasterState, Reading>,
} as const satisfies Record<string, Record<string, Reading>>;
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
		smoke: "Smoke",
		release_batch: "Release batch",
		drive: "Drive",
		onboarding: "Onboarding",
	},
	changeKind: {
		added: "Added",
		removed: "Removed",
		changed: "Changed",
		deprecated: "Deprecated",
	},
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
	lifecycle: {
		experimental: "Experimental",
		production: "Production",
		deprecated: "Deprecated",
	},
	versioning: { dated: "Dated", semver: "SemVer" },
	visibility: { counterparties: "counterparties", all: "everyone" },
	platform: { macos: "macOS", linux: "Linux", windows: "Windows" },
	role: { viewer: "Viewer", member: "Member", admin: "Admin", owner: "Owner" },
	trigger: {
		manual: "Manual",
		scheduled: "Scheduled",
		joined: "Joined",
		push: "Push",
	},
	sessionKind: {
		master: "Master",
		run_session: "Run session",
		pipeline: "Pipeline",
		chat: "Chat",
	},
	blockerKind: {
		machine: "Machine",
		master_or_peer: "Master or peer",
		human: "Person",
	},
	dependencyKind: {
		blocks: "Blocks",
		relates: "Relates to",
		duplicates: "Duplicates",
		parent: "Parent of",
		decomposes: "Decomposes",
	},
	direction: { outbound: "Outbound", inbound: "Inbound" },
	gate: { auto: "Automatic", human: "Person" },
	pauseKind: { stage_stalled: "a stalled stage" },
	/** Where a published contract's document comes from (core `ecosystem/schema.ts` `artifact`). */
	artifact: {
		none: "No artifact",
		repository: "From the repository",
		upload: "Uploaded",
	},
	/** What a document event did (core `ecosystem/channel-*.ts` event `verb`), past tense on the timeline. */
	documentVerb: {
		draft: "Drafted",
		edit: "Edited",
		submit: "Submitted",
		approve: "Approved",
		return: "Returned",
		publish: "Published",
		withdraw: "Withdrew",
		supersede: "Superseded",
		invite: "Invited",
	},
	/** Why an agent session failed (contracts `failure-causes.ts:FAILURE_CAUSES`). */
	failureCause: {
		provider_spend_cap: "Provider spend cap",
		provider_usage_limit: "Provider usage limit",
		provider_subscription_disabled: "Provider subscription disabled",
		provider_auth_expired: "Provider sign-in expired",
		provider_overloaded: "Provider overloaded",
		provider_refused_request: "Provider refused the request",
		agent_startup_failed: "Agent failed to start",
		agent_skill_missing: "Agent skill missing",
		agent_exited_without_result: "Agent exited without a result",
		agent_killed: "Agent killed",
		skill_not_synced: "Skill not synced",
		workspace_preflight_failed: "Workspace preflight failed",
		workspace_disk_full: "Workspace disk full",
		repo_root_contention: "Repository busy",
		box_session_saturated: "Box at its session limit",
		runner_unreachable: "Runner unreachable",
		duplex_channel_failed: "Duplex channel failed",
		session_lost: "Session lost",
		heartbeat_timeout: "Heartbeat timed out",
		queue_timeout: "Queue timed out",
		turn_never_reported: "Turn never reported",
		no_client_ack: "No client acknowledgement",
		checkout_unbound: "No checkout bound",
		credential_mint_failed: "Credential not minted",
		attachment_unreadable: "Attachment unreadable",
		dispatch_failed: "Not dispatched",
		forge_budget_exhausted: "Project budget exhausted",
		runner_unsupported_type: "Runner cannot run this job type",
		resume_failed: "Resume failed",
		residency_expired: "Residency expired",
		park_unanswered: "Question unanswered",
		audit_ran_blind: "Ran without evidence",
		session_authority_refused: "Not allowed to act as its owner",
		orphan_under_terminal_run: "Orphaned under a finished run",
		pipeline_cancelled: "Pipeline cancelled",
		pipeline_completed: "Pipeline completed",
		pipeline_failed: "Pipeline failed",
		migration_zombie_cleanup: "Cleaned up by a migration",
		manual_ops_stale_chat_schedule: "Stale chat schedule cleaned up",
		user_cancelled: "Cancelled by a person",
		unclassified: "Unclassified",
	},
	/** What an environment reading stands on (web `project-settings/config-types.ts`). */
	environmentEvidence: {
		"runtime-confirmed": "Confirmed at runtime",
		"runtime-mismatch": "Runtime mismatch",
		"runtime-unreachable": "Runtime unreachable",
		"deployment-record": "Deployment record",
		none: "None",
	},
	/** Why an environment's state is unknown (web `project-settings/config-types.ts`). */
	environmentCause: {
		external: "Deployed outside Forge",
		"no-record": "No deployment record",
		"adapter-error": "Platform adapter error",
		"binding-refused": "Binding refused",
	},
	/** What a deployment delivered (web `project-settings/config-types.ts`). */
	artifactKind: {
		"container-image": "Container image",
		theme: "Theme",
		bundle: "Bundle",
	},
	/** A connection binding's role (core `project-config/schema.ts:BINDING_ROLES`). */
	bindingRole: { deploy: "Deploy", source: "Source", service: "Service" },
	/** An agent report's kind and target (core `db/schema-agent-reports.ts:agentReportKinds`). */
	agentReportKind: {
		friction: "Friction",
		bug: "Bug",
		skill_gap: "Skill gap",
		unclear_step: "Unclear step",
		redundant_step: "Redundant step",
		learning: "Learning",
		suggestion: "Suggestion",
	},
	agentReportTarget: {
		skill: "Skill",
		prompt: "Prompt",
		tool: "Tool",
		doc: "Doc",
		orientation: "Orientation",
		pipeline: "Pipeline",
		other: "Other",
	},
	/** The model tier a run used (core `db/schema.ts:modelTiers`). */
	modelTier: { haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" },
	runStuckRule: {
		silent: "Silent",
		lease_expired: "Claim expired",
		lease_abandoned: "Claim abandoned",
		disagreement: "Box and core disagree",
		stranded: "Stranded",
		overdue: "Gate overdue",
	},
	runLane: {
		issue: "Issue run",
		release: "Release",
		deploy: "Deploy",
		job: "Job",
	} satisfies Record<RunLane, string>,
	masterVerb: {
		triage: "Triage",
		dispatch: "Dispatch",
		fold: "Fold",
		judge: "Judge",
		release: "Release",
		park: "Park",
	} satisfies Record<MasterVerb, string>,
	runExpirySource: {
		claim: "Claim",
		silence_reap: "Silence reap",
		deploy_lock: "Deploy lock",
	} satisfies Record<RunExpirySource, string>,
	runHandbackClose: {
		ended: "Ended",
		killed_idle: "Killed idle",
		died: "Died",
	} satisfies Record<RunHandbackClose, string>,
	/** What a run waits on when no person does (core `runs/standing-live.ts` gate arms). */
	runGate: {
		all_devices_exhausted: "All devices busy",
		verify_unavailable: "Verify unavailable",
		retry_cooldown: "Retry cooldown",
		issue_busy: "Issue busy",
		runner_stale: "Runner stale",
		runner_too_old: "Runner too old",
		blocked_on_machine: "Blocked on a machine",
		blocked_on_master_or_peer: "Blocked on another agent",
		blocked_on_nobody: "Blocked on nobody",
		paused: "Paused",
	},
	runEventEntity: {
		run: "Run",
		session: "Session",
		job: "Job",
	} satisfies Record<RunEventEntity, string>,
	runActorType: {
		user: "Person",
		system: "Core",
		runner: "Runner",
		sweeper: "Sweeper",
	} satisfies Record<RunActorType, string>,
	/** What a schedule runs (contracts `schedules.ts:SCHEDULE_KINDS`). */
	scheduleKind: {
		prompt: "Prompt",
		script: "Script",
		release_batch: "Release batch",
		sentry_pull: "Sentry pull",
	} satisfies Record<ScheduleKind, string>,
	/** How a fire started (contracts `schedules.ts:SCHEDULE_RUN_TRIGGERS`). */
	fireTrigger: {
		manual: "Manual",
		scheduled: "Scheduled",
	} satisfies Record<ScheduleRunTrigger, string>,
	/** Why a fire ran nothing (contracts `schedules.ts:SCHEDULE_RUN_SKIP_REASONS`). */
	fireSkipReason: {
		"no-device": "No box could take it",
		"project-not-found": "Its target project is gone",
		"nothing-to-do": "Nothing to do",
		"gate-refused": "The gate refused it",
	} satisfies Record<ScheduleRunSkipReason, string>,
} as const satisfies Record<string, Record<string, string>>;
