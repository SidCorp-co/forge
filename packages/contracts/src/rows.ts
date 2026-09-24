import type { schema } from '@forge/core/public';

export type User = Pick<
  typeof schema.users.$inferSelect,
  'id' | 'email' | 'emailVerifiedAt' | 'createdAt'
>;

export type Project = typeof schema.projects.$inferSelect;

export type PipelineWaitingReason =
  | 'issue_busy'
  | 'job_held'
  | 'run_not_running'
  | 'retry_cooldown'
  | 'runner_stale'
  | 'runner_too_old';

export type WaitingCause = 'needs_decision' | 'needs_resource';

export interface PipelineHealth {
  stage: schema.IssueStatus;
  activeSession?: { id: string; status: 'queued' | 'running'; skill: string };
  waitingOn?: {
    reason: PipelineWaitingReason;
    since: string;
    details: Record<string, unknown>;
  };
  queuedAt?: string;
  /** Only set when `stage === 'waiting'`. */
  waitingCause?: { kind: WaitingCause };
}

export type ModelTier = schema.ModelTier;

export type ProjectMember = typeof schema.projectMembers.$inferSelect;

export type Label = typeof schema.labels.$inferSelect;

export type LabelKind = schema.LabelKind;

export interface ModuleAttribution {
  labelId: string;
  name: string;
  color: string;
  isPrimary: boolean;
}

export interface ModuleDriftNode {
  labelId: string;
  name: string;
  slug: string | null;
  knowledgeEntryId: string | null;
}

export interface ModuleDriftEdge {
  a: ModuleDriftNode;
  b: ModuleDriftNode;
  /** Distinct issues carrying both modules — the weight of the edge. */
  issueCount: number;
  /** Of those, the ones where either module is the issue's primary. The rest are secondary×secondary. */
  primaryAnchoredIssueCount: number;
  recentIssueSeqs: number[];
  nearestCommonAncestor: ModuleDriftNode | null;
}

export interface ModuleDriftResponse {
  generatedAt: string;
  layer: 'module-taxonomy';
  minCoOccurrence: number;
  declaration: { state: 'present' | 'absent'; source: 'label-hierarchy'; edgeCount: number };
  observed: { moduleCount: number; edgeCount: number; belowThresholdEdgeCount: number };
  undeclared: ModuleDriftEdge[];
  unobserved: Array<{ a: ModuleDriftNode; b: ModuleDriftNode; issueCount: number }>;
  agreedEdgeCount: number;
}

export interface ModuleCounts {
  total: number;
  open: number;
  closed: number;
  recentlyActive: number;
}

/** ISS-949 — primary and secondary attributions, counted apart and never summed. */
export interface ModuleAttributionCounts {
  primary: ModuleCounts;
  secondary: ModuleCounts;
}

export interface ModuleRollupRow {
  id: string;
  name: string;
  slug: string | null;
  color: string;
  parentId: string | null;
  depth: number;
  /** Issues attributed to this module itself. */
  own: ModuleAttributionCounts;
  /** Issues attributed to a descendant, minus what `own` already counts for that kind. */
  inherited: ModuleAttributionCounts;
  /** `own + inherited`, which is addition exactly because `inherited` excluded the overlap. */
  rollup: ModuleAttributionCounts;
}

export interface ModuleRollupResponse {
  activeWithinDays: number;
  generatedAt: string;
  modules: ModuleRollupRow[];
  /** Issues carrying no module attribution at all. */
  unassigned: ModuleCounts;
}

export type Issue = typeof schema.issues.$inferSelect & {
  displayId: string;
  agentSessions?: Array<{
    id: string;
    status: string;
    metadata: Record<string, unknown> | null;
    createdAt: Date | string;
    updatedAt: Date | string;
    title: string | null;
  }>;
  agentStatus?: 'running' | 'queued' | 'completed' | 'failed' | null;
  /** ISS-1213 — search endpoint only, under `?withAgentSessions`: is anything on the issue now. */
  held?: boolean;
  lastCheckInAt?: string | null;
  /** ISS-437 — search endpoint only, under `?withCost=1`: per-issue usage rollup in USD,
   *  0 when the issue never produced any. */
  estimatedCost?: number;
  /** ISS-594 — search endpoint only, under `?withModules=1`: the issue's `kind='module'`
   *  attributions, primary first, `[]` when it has none. */
  modules?: ModuleAttribution[];
  pipelineHealth: PipelineHealth;
} & IssueCreatorFields;

/**
 * Who filed the issue, as every REST issue payload has answered since ISS-756 —
 * declared here at last (ISS-1093). No database row carries these three: they are
 * derived per response by `issues/creator.ts:hydrateCreatorsForIssues`.
 */
export type IssueCreatorFields = {
  creatorEmail: string | null;
  creatorIsAgent: boolean;
  creatorLabel: string;
};

/** ISS-1016 — one row of `GET /api/projects/:id/issues` or `…/issues/search`: an `Issue` without the
 *  six body columns or the generated search vector, none of which a list reads off disk. */
export type IssueListRow = Omit<
  Issue,
  | 'description'
  | 'descriptionFormat'
  | 'plan'
  | 'acceptanceCriteria'
  | 'sessionContext'
  | 'releaseNotes'
  | 'identSearch'
> & {
  /** ISS-960 — present only when the query carried `q`; `[]` on an identifier-only match. */
  matchedFields?: Array<'title' | 'description' | 'plan' | 'acceptanceCriteria'>;
};

export type Comment = typeof schema.comments.$inferSelect;

export type Job = typeof schema.jobs.$inferSelect;

export type JobEvent = typeof schema.jobEvents.$inferSelect;

export type Device = typeof schema.devices.$inferSelect;

export type DeviceLoginCode = typeof schema.deviceLoginCodes.$inferSelect;

// ISS-271 — runner row now carries the per (device × project) repo checkout
// (`repoPath`/`branch`), the server source of truth for the runner working dir.
export type Runner = typeof schema.runners.$inferSelect;

export type ActivityLog = typeof schema.activityLog.$inferSelect;

export type SkillActivityEventRow = typeof schema.skillActivityEvents.$inferSelect;

export type UpdatePacketRow = typeof schema.updatePackets.$inferSelect;

export type KnowledgeEntry = typeof schema.knowledgeEntries.$inferSelect;

// ISS-546/ISS-556 — improvement-message registry type (cross-app parity).
// Pure data shape; no DB import needed — the registry is a git-committed module.
export type ImprovementMessageCategory =
  | 'code-quality'
  | 'testing'
  | 'documentation'
  | 'performance'
  | 'security'
  | 'dx'
  | 'ops'
  | 'pipeline-correctness'
  | 'quality'
  | 'steward'
  | 'general';

export interface ImprovementMessage {
  key: string;
  title: string;
  message: string;
  rationale: string;
  appliesToSkills?: readonly string[];
  appliesWhen?: string;
  category: ImprovementMessageCategory;
  version: number;
  recommended: boolean;
  defaultMode: 'propose' | 'auto';
  /** When true, the dispatch engine bypasses the appliedMessageVersions gate and fires every run. */
  standing?: boolean;
}

export interface ImprovementMessageEntry extends ImprovementMessage {
  enablement: {
    enabled: boolean;
    scheduleId: string;
    mode: string;
    cron: string;
  } | null;
}

export type DivergenceCharterRow = typeof schema.divergenceCharters.$inferSelect;
