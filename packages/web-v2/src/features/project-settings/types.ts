import { buildDocumentPatch } from "@forge/contracts/document-patch";
import { MEMORY_REINDEX_STATES, type MemoryReindexState } from "@forge/contracts/status-sets";

/** A settings write: the keys being changed, and the values they were read against.
 *  `patch` is sparse — a key it does not name is untouched at any depth, `null` deletes
 *  one — and `base` is compared at the paths `patch` writes and nowhere else. */
export interface DocumentWrite {
	base: Record<string, unknown>;
	patch: Record<string, unknown>;
}

/** The write one section sends, from the slice it seeded with and the slice it holds now.
 *  A section names its own keys and no others, so two sections of one page load overlap at
 *  no path and both land (ISS-1170). */
export function sectionWrite(before: unknown, after: unknown): DocumentWrite {
	const { patch, base } = buildDocumentPatch(before, after);
	return { base, patch };
}

/** Patch body accepted by `PATCH /api/projects/:id` (basics + repo + testing).
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
	/** The ordered release path. Sent WHOLE — it replaces the stored list rather
	 *  than patching it — and its first entry must name `baseBranch`. */
	releaseChain?: ReleaseChainEntry[];
	/** NOT `environments`: that document is written through
	 *  `PATCH /api/projects/:id/environments`, which refuses it here by name. */
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

/** One `environments.preview.urls` row — mirrors `testingUrlSchema` in core. */
export interface TestingUrl {
	label: string;
	url: string;
}

/** One `environments.testCredentials` row — mirrors `testCredentialSchema`. */
export interface TestCredential {
	label: string;
	username: string;
	password: string;
}

/** The preview side — `null` on the column means this project HAS no preview side. */
export interface PreviewEnvironmentConfig {
	url?: string | null;
	apiUrl?: string | null;
	urls?: TestingUrl[];
	[key: string]: unknown;
}

/**
 * The live side — the address a release ships to.
 *
 * `commitUrl` is a SEPARATE address from `url`: it is the endpoint that reports the running
 * commit, and `commitPath` is the dot path to it inside that endpoint's JSON body. Neither is
 * derivable from `url`, which is why all three are stored (ISS-1069).
 */
export interface LiveEnvironmentConfig {
	url?: string | null;
	apiUrl?: string | null;
	commitUrl?: string | null;
	commitPath?: string | null;
	[key: string]: unknown;
}

export interface EnvironmentsConfig {
	preview?: PreviewEnvironmentConfig | null;
	live?: LiveEnvironmentConfig | null;
	testCredentials?: TestCredential[];
	/** ISS-1069 — what this environment does NOT have. Read by agents before they plan a live
	 *  walk. Never a secret. Replaced `notes`, which invited anything and was set on 4 of 32. */
	limits?: string | null;
	[key: string]: unknown;
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

/** How a release crosses ONE edge of the chain, declared on the entry it enters. */
export type ReleaseCrossing = "merge-branch" | "cherry-pick";

/** One branch on the release path. The first entry crosses from nothing. */
export interface ReleaseChainEntry {
	branch: string;
	from?: ReleaseCrossing;
}

/** What a project still has to declare — mirrors `ReleaseReadiness` in core
 *  `release-batch/readiness.ts`. `gaps` is what settings says out loud. */
export interface ReleaseReadiness {
	/** The project declares a release chain AND has an active live deploy binding. */
	hasReleaseGate: boolean;
	/** The ordered release path. Empty means this project ships nothing. */
	releaseChain: ReleaseChainEntry[];
	/** Derived from the chain by core, not stored. ISS-1311 / ADR 0003. */
	releaseModel: "none" | "promote" | "publish";
	releaseStrategy: ReleaseCrossing | null;
	baseBranch: string;
	/** Non-null only where the chain names two or more branches. */
	liveBranch: string | null;
	targetUndeclared: boolean;
	/** Providers of EVERY live deploy binding; core never picks one. */
	providers: string[];
	releaseRunnerLabel: string | null;
	rollback: string | null;
	rollbackMode: "manual" | "coolify-image" | "unrepresentable" | null;
	hasVerify: boolean;
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
		| "release-runner-ambiguous"
		| "release-multi-channel"
		| "release-target"
		| "rollback"
		| "rollback-prose"
		| "verify-probes"
		| "live-commit-endpoint"
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
