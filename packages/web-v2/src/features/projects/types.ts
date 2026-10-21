import type { StuckIssueKind } from "@forge/contracts/notifications";
import type { HealthKey } from '@/design';
import type { QueryRead } from '@/design/patterns/badge-read';
import type { Project, ProjectMember } from '@forge/contracts';
import type { WorkState } from '@forge/contracts/work-state';

export type { Project, ProjectMember } from '@forge/contracts';

export interface ProjectListItem {
  id: string;
  slug: string;
  name: string;
  orgId: string;
  orgName: string;
  orgIsPersonal: boolean;
  createdBy: string;
  /** Effective role (org owner/admin surface as 'admin'). */
  role: ProjectMember['role'] | null;
  /** Caller's role in the project's org — null when not an org member. */
  orgRole: 'owner' | 'admin' | 'member' | null;
  /** Non-null when the project is archived (rows appear via `?archived=1`). */
  archivedAt: string | null;
  createdAt: string;
}

/** No project read answers the webhook secret: the inbound webhook check is its one reader. */
export interface ProjectDetail extends Omit<Project, 'webhookSecret'> {
  members: Array<Pick<ProjectMember, 'userId' | 'role'>>;
  labels: Array<{ id: string; name: string; color: string | null }>;
  devicePool: Array<{
    id: string;
    name: string;
    platform: string;
    status: string;
    lastSeenAt: string | null;
    runnerId: string;
  }>;
}

export interface ProjectHealthRow {
  /** Project UUID — join key against `ProjectListItem.id`. */
  id: string;
  projectName: string;
  projectSlug: string;
  description: string | null;
  repoPath: string | null;
  throughput: number;
  /** Open work: the four open states of `work` summed. */
  totalActive: number;
  /** Issues in each work state, counted by core's one fold. */
  work: Record<WorkState, number>;
  /** The most recently updated parked issues, a capped list. */
  blockers: Array<{
    issueId: string;
    documentId: string;
    title: string;
    status: string;
    /** The reason a stuck-issue notice tells this parked issue by, where one stands. */
    stuckKind?: StuckIssueKind;
    /** `waiting_on_others` only: the person the park waits for. */
    stuckOwedBy?: string;
    /** The reader owns the park; another person's is theirs to act on only once a notice stands for it. */
    readerOwns?: true;
  }>;
  /** Every parked issue: the count behind the capped `blockers`. */
  blockersTotal: number;
  pendingEscalations: number;
  avgCycleTimeDays: number;
  /** Pipeline runs currently running or paused: open runs, not proof anything works them. */
  liveRuns: number;
  /** Agent sessions live by the condition the Pipeline page lists them by; what "live" counts everywhere. */
  liveSessions: number;
  /** Runners in the `online` state. */
  runnerCount: number;
  /** Every runner the project has, online or not, the figure Overview counts runners out of. */
  runnerTotal: number;
  /** Trailing-24h spend (USD). */
  spend24hUsd: number;
  /** True total membership count. */
  memberCount: number;
  /** Up to 5 avatar initials, from each member's name as core calls them, never their address. */
  members: string[];
  /** ISO timestamp of the most recent issue/run activity, or `null`. */
  lastActivityAt: string | null;
  /** Issues with a stuck-issue notice standing, each counted once whichever sweep raised it. */
  stuckIssues: number;
  /** Up to five of them, longest-standing first. */
  /** The same issues, each once under its most specific reason, so the kinds add up to `stuckIssues`. */
  stuckIssuesByKind: Partial<Record<StuckIssueKind, number>>;
  stuckIssueRefs: Array<{
    issueId: string;
    documentId: string;
    title: string;
    kind: StuckIssueKind;
    /** `waiting_on_others` only: the person the park waits for. */
    owedBy?: string;
  }>;
}

export interface CreateProjectInput {
  slug: string;
  name: string;
  description?: string | null;
  /** Target org — omitted = the caller's personal org. */
  orgId?: string;
}

export interface CreatedProject {
  id: string;
  slug: string;
  name: string;
  orgId: string;
  createdBy: string;
  createdAt: string;
}

export interface OnboardResult {
  sessionId: string;
}

/** Sort options for the projects console toolbar. */
export type ProjectSort = 'recent' | 'name' | 'health';

/** One sort and the way round it runs. */
export interface ProjectSortState {
  id: ProjectSort;
  desc: boolean;
}

/** Cards ⇄ List view toggle. */
export type ProjectView = 'cards' | 'list';

/**
 * One fully-hydrated console row: the list item joined with its health rollup,
 * a client-derived `health` enum, and the client-only `pinned` flag. Every figure taken from the
 * rollup is `null`, and `health` is `null`, until `healthRead` is `read`: a zero here is a count of
 * nothing only where the rollup was read, so a reader says pending or failed instead of drawing one.
 */
export interface ProjectConsoleItem {
  id: string;
  slug: string;
  name: string;
  orgId: string;
  orgName: string;
  orgIsPersonal: boolean;
  role: ProjectListItem['role'];
  createdAt: string;
  description: string | null;
  repoPath: string | null;
  /** What `GET /api/projects/health` answered; the rollup's figures below are stated only where `read`. */
  healthRead: QueryRead;
  health: HealthKey | null;
  liveSessions: number | null;
  openIssues: number | null;
  runnerCount: number | null;
  runnerTotal: number | null;
  spend24hUsd: number | null;
  memberCount: number | null;
  members: string[];
  lastActivityAt: string | null;
  pinned: boolean;
}

/** Workspace summary totals for the stats band. */
export interface WorkspaceTotals {
  projects: number;
  healthRead: QueryRead;
  liveSessions: number | null;
  openIssues: number | null;
  /** Runners online, out of `runnersTotal`, read "1/2 runners online" as Overview reads it (ISS-1229 r25). */
  runners: number | null;
  runnersTotal: number | null;
  spend24hUsd: number | null;
}
