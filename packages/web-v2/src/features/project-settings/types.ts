import { MEMORY_REINDEX_STATES, type MemoryReindexState } from "@forge/contracts/status-sets";

/** Patch body accepted by `PATCH /api/projects/:id` (basics + repo).
 *  `orgId` moves the project to another org — requires org admin on BOTH the
 *  current and the destination org (403/404 otherwise). */
export interface ProjectUpdateInput {
	name?: string;
	description?: string | null;
	repoPath?: string | null;
	repoUrl?: string | null;
	/** Prose: how to bring this repo's workspace to a buildable state. Read by
	 *  the runner's setup agent; blank means it derives the procedure per job. */
	workspaceSetup?: string | null;
	/** Where an ISS-* branch is cut from. NOT a release fact. */
	baseBranch?: string | null;
	/** NOT where work lands, its environments or promotions: those are the project document,
	 *  written through `PUT /api/projects/:id/config`, and this patch refuses them by name. */
	orgId?: string;
	/** ISS-609 — chat/RC-bot reply-style knob; scoped server-side write into
	 *  `agentConfig.personaStyle`. null/'' clears it. */
	personaStyle?: string | null;
	rocketChatAnswerMode?: "fast" | "agent" | null;
	systemPrompt?: string | null;
	categories?: string[] | null;
	/** `agentConfig.assistantWeekly`, replaced whole; null clears it. */
	assistantWeekly?: AssistantWeekly | null;
}

/** One row of `GET /api/projects/:id/members` — includes the member email. */
export interface ProjectMemberRow {
	userId: string;
	email: string;
	role: "admin" | "member" | "viewer";
	createdAt: string;
}

/** One row of `GET /api/projects/:id/members/invitations` — a pending invite. */
export interface ProjectInvitationRow {
	email: string;
	role: "admin" | "member" | "viewer";
	expiresAt: string;
	createdAt: string;
	inviterEmail: string;
	expired: boolean;
}

/** A label's taxonomy role — a module IS a label carrying `kind: 'module'`. */
export type LabelKind = "label" | "module";

/** A project label (`GET /api/projects/:id/labels`), modules included. */
export interface ProjectLabel {
	id: string;
	name: string;
	color: string;
	kind: LabelKind;
	/** Modules only — the parent module, or null at the root of the taxonomy. */
	parentId: string | null;
	/** Modules only — the module's stable identity, derived from its name on create and never moved by a rename. */
	slug: string | null;
	/** Modules only — the module's knowledge node, or null when nobody has written one yet. */
	knowledgeEntryId: string | null;
	description: string | null;
}

/** Body for creating a label or a module. `color` may be omitted for a module — the server
 *  derives a stable one from the name; it is REQUIRED for a plain label. */
export interface LabelCreateInput {
	name: string;
	color?: string;
	kind?: LabelKind;
	parentId?: string | null;
	description?: string | null;
}

/** Body for `PATCH /api/labels/:id`. Every field optional; at least one required. */
export type LabelPatchInput = Partial<LabelCreateInput>;

/**
 * A Claude Code plugin the project designates (installed at DEVICE scope —
 * a device installs the union of every project it serves). Mirrors
 * `pluginDesignationSchema` in core `plugins/designation.ts`. Stored at
 * `agentConfig.plugins`, read via `GET /api/projects/:id`.
 */
export interface PluginDesignation {
	marketplace: string;
	name: string;
	pinnedRef?: string | null;
	autoUpdate?: boolean;
}

/** One reason a release will not start, and what to do about it — mirrors
 *  `ReleaseBlocker` in core `release-batch/blocker-sentences.ts`. */
export interface ReleaseBlocker {
	code: string;
	/** The one sentence an operator reads, carrying its own remedy. */
	message: string;
	details?: Record<string, unknown>;
	/** False when this check could not be run at all. */
	evaluated: boolean;
}

/** Something that changes how a release runs without being a reason it will not. */
export interface ReleaseWarning {
	code: string;
	message: string;
	details?: Record<string, unknown>;
}

/** One promotion of the project document — mirrors `promotions[]` in core `project-config/schema.ts`. */
export interface ReleasePromotion {
	from: string;
	to: string;
	via: "merge" | "cherry-pick";
}

/** The production environment as the project document declares it. */
export interface ReleaseProduction {
	environment: string;
	/** The branch it deploys from where a promotion crosses into it; null where none does. */
	deploysFrom: string | null;
	bindingId: string;
	trigger: "on-land" | "on-request" | "provider";
}

/** What a project still has to declare — mirrors `ReleaseReadiness` in core
 *  `release-batch/readiness.ts`. `gaps` is what settings says out loud. */
export interface ReleaseReadiness {
	/** The project document declares a production environment with an active deploy binding. */
	hasReleaseGate: boolean;
	/** Where work lands (`source.git.defaultBranch`); null with no git source or no reading. */
	defaultBranch: string | null;
	/** Null where the project is not gated. */
	production: ReleaseProduction | null;
	/** The promotions a landed change crosses to reach production, in order. */
	promotions: ReleasePromotion[];
	targetUndeclared: boolean;
	/** Why nothing says where a release lands, where that is the case. */
	targetUndeclaredReason: string | null;
	/** The production deploy binding's provider; empty when the project is not gated. */
	providers: string[];
	releaseRunnerLabel: string | null;
	rollback: string | null;
	rollbackMode: "manual" | "coolify-image" | "unrepresentable" | null;
	hasVerify: boolean;
	verifySources: ("environment" | "declared-unusable" | "none")[];
	/** False where the declaration could not be READ, which makes every field
	 *  below a fallback rather than a reading (ISS-1127). */
	declarationRead: boolean;
	/** False where the live bindings could not be READ, which makes providers,
	 *  rollback, hasVerify and the runner label fallbacks (ISS-1127). */
	channelsRead: boolean;
	/** Every reason a release would be refused RIGHT NOW — the declarations, and
	 *  also the roster and the fleet, which `gaps` never looked at. Empty here
	 *  means a release over this roster starts (ISS-1127). */
	blockers: ReleaseBlocker[];
	/** What changes how the release runs without stopping it. */
	warnings: ReleaseWarning[];
	gaps: (
		| "build-commands"
		| "test-commands"
		| "release-procedure"
		| "release-target"
		| "rollback"
		| "rollback-prose"
		| "verify-probes"
	)[];
}

/** The assistant's weekly reading of this project — `agentConfig.assistantWeekly`, written
 *  through `PATCH /api/projects/:id`. */
export interface AssistantWeekly {
	enabled: boolean;
	pinnedIssue: string;
	judgeProviderId: string;
	judgeModel: string;
	source?: string;
}

/** A project's policy-v1 document as `GET /api/projects/:id/policy` returns it. The editor
 *  holds it as JSON text; core's schema is what refuses a wrong shape. */
export type PolicyDocument = Record<string, unknown>;

export type PolicyRead =
	| { declared: false; revision: null; document: null }
	| {
			declared: true;
			revision: number;
			document: PolicyDocument;
			updatedBy: string;
			updatedAt: string;
	  };

/** One reason core refused a policy write, at the JSON pointer it names. */
export interface PolicyRefusal {
	code: string;
	path: string;
	detail: string;
}

export interface ProjectAgentConfig {
	assistantWeekly?: AssistantWeekly;
	plugins?: PluginDesignation[];
	personaStyle?: string;
	systemPrompt?: string;
	rocketChatAnswerMode?: "fast" | "agent";
	categories?: string[];
}


export type MemoryModel = "flat" | "chunked";

export { MEMORY_REINDEX_STATES, type MemoryReindexState };

/** `app_config.memory_reindex` as `GET /api/app-config/:id/memory-model/reindex` returns it. */
export interface MemoryReindex {
	state: MemoryReindexState;
	total: number;
	done: number;
	remaining: number;
	requestedAt: string;
	startedAt?: string;
	finishedAt?: string;
	lastBatchAt?: string;
	lastError?: string;
}

export interface MemoryModelStatus {
	model: MemoryModel;
	reindex: MemoryReindex | null;
}

/** `GET /api/app-config/:id/memory-model/estimate` — CHUNKED_SOURCES rows only. */
export interface MemoryReindexEstimate {
	memories: number;
	totalChars: number;
	estimatedChunks: number;
	estimatedEmbedCalls: number;
	estimatedMinutes: number;
}
