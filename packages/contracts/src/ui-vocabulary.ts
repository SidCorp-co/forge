// How a person reads enums whose values are declared outside contracts (core's db schema, its
// ecosystem and pipeline modules): one label and one legend tone per value, so a screen draws them
// through the shared badge and never prints the stored token. An enum that moves into contracts
// takes its reading with it (domain-entities.md, "Badges"); until then this file is its one reading.

import type { IssueStatusTone } from "./issue-vocabulary.js";

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
	/** Where a version stands at one stage of its release flow (web `releases/flow.ts:StepState`). */
	releaseStep: {
		current: ["In progress", "run", "●"],
		waiting: ["Waiting", "you", "●"],
		failed: ["Failed", "err", "×"],
		aborted: ["Aborted", "neutral", "–"],
		done: ["Done", "ready", "✓"],
		passed: ["Passed", "ready", "✓"],
		pending: ["Not reached", "neutral", "○"],
		untracked: ["Not recorded for a version", "neutral", "○"],
		skipped: ["Not asked", "neutral", "–"],
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
	/** A skill-update run (contracts `reconcile.ts:RECONCILE_RUN_STATUSES`). */
	reconcileRun: {
		pending: ["Pending", "neutral", "○"],
		running: ["Running", "run", "●"],
		verifying: ["Verifying", "run", "◐"],
		decided: ["Decided", "ready", "✓"],
		applied: ["Applied", "done", "✓"],
		escalated: ["Escalated", "you", "!"],
		failed: ["Failed", "err", "×"],
	},
	/** A schedule's last run, and a script schedule's run (web `schedules/types.ts:ScheduleLastStatus`). */
	scheduleRun: {
		success: ["Succeeded", "ready", "✓"],
		failed: ["Failed", "err", "×"],
		running: ["Running", "run", "●"],
	},
	/** How an issue's shipped claim was recorded (web `issues/types.ts:MergeMarkKind`). */
	mergeMark: {
		landed: ["Landed", "ready", "✓"],
		observed: ["Observed", "ready", "✓"],
		asserted: ["Claimed", "you", "!"],
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
		pm: "PM",
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
	mode: { propose: "Propose", auto: "Automatic" },
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
	/** One act of a release run (web `releases/types.ts:ReleaseAttemptStage`). */
	attemptStage: {
		promote: "Promote",
		deploy: "Deploy",
		verify: "Verify",
		repair: "Repair",
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
		ws_publish_failed: "Live publish failed",
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
	/** What woke the PM (core `pm/decisions-service.ts:PM_DECISION_CAUSES`). */
	pmCause: {
		"job-failed": "Job failed",
		"pipeline-stalled": "Pipeline stalled",
		"needs-info": "Issue needs info",
		"queue-pressure": "Queue pressure",
		"graph-changed": "Knowledge graph changed",
		operator: "Operator",
		"operator-reply": "Operator reply",
		tick: "Scheduled tick",
		"escalation-timeout": "Escalation timed out",
		"pm-failure": "PM failure",
	},
	/** An agent report's kind and target (web `agent-reports/types.ts`). */
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
	/** What a schedule runs (web `schedules/types.ts:ScheduleKind`, plus the PM and improve rows). */
	scheduleKind: {
		prompt: "Prompt",
		script: "Script",
		pm: "PM",
		improve: "Improve",
	},
} as const satisfies Record<string, Record<string, string>>;

export type EnumLabelFamily = keyof typeof ENUM_LABELS;
