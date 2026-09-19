import type { HealthKey } from '@/design';
import type { Project, ProjectMember } from '@forge/contracts';

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
  /** null for the read-only viewer tier (execution-grade key is withheld). */
  apiKey: string | null;
  /** Non-null when the project is archived (rows appear via `?archived=1`). */
  archivedAt: string | null;
  createdAt: string;
}

export interface ProjectDetail extends Project {
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
  totalActive: number;
  statusDistribution: Record<string, number>;
  blockers: Array<{ issueId: string; documentId: string; status: string }>;
  pendingEscalations: number;
  avgCycleTimeDays: number;
  /** Pipeline runs currently running or paused. */
  liveRuns: number;
  /** Runners in the `online` state. */
  runnerCount: number;
  /** Trailing-24h spend (USD). */
  spend24hUsd: number;
  /** True total membership count. */
  memberCount: number;
  /** Up to 5 email-derived avatar initials. */
  members: string[];
  /** ISO timestamp of the most recent issue/run activity, or `null`. */
  lastActivityAt: string | null;
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
  apiKey: string;
  createdAt: string;
}

export interface OnboardResult {
  sessionId: string;
}

/** Sort options for the projects console toolbar. */
export type ProjectSort = 'recent' | 'name' | 'health';

/** Cards ⇄ List view toggle. */
export type ProjectView = 'cards' | 'list';

/**
 * One fully-hydrated console row: the list item joined with its health rollup,
 * a client-derived `health` enum, and the client-only `pinned` flag.
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
  health: HealthKey;
  liveRuns: number;
  openIssues: number;
  runnerCount: number;
  spend24hUsd: number;
  memberCount: number;
  members: string[];
  lastActivityAt: string | null;
  pinned: boolean;
}

/** Workspace summary totals for the stats band. */
export interface WorkspaceTotals {
  projects: number;
  liveRuns: number;
  openIssues: number;
  runners: number;
  spend24hUsd: number;
}
