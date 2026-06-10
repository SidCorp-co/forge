// web-v2 feature module: projects. Types come from `@forge/contracts` where a
// shared shape exists; the hand-rolled server projections (list row, detail,
// health) are re-typed here to match the exact `core` route responses — see
// `packages/core/src/projects/routes.ts` + `health-routes.ts`. Verified against
// those routes for ISS-288 (do not guess field names).
import type { HealthKey } from '@/design';
import type { Project, ProjectMember } from '@forge/contracts';

export type { Project, ProjectMember } from '@forge/contracts';

/**
 * Row shape returned by `GET /api/projects` (the project console list). This is
 * a server-side projection — NOT the full `Project` row — joining the caller's
 * membership `role` and exposing `apiKey` (ADR 0013).
 */
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
  apiKey: string;
  createdAt: string;
}

/**
 * Response of `GET /api/projects/:id` — the full project row plus embedded
 * members + labels + devicePool arrays.
 */
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

/**
 * One row of `GET /api/projects/health` (mirrors
 * `packages/core/src/projects/health-routes.ts` — extended additively in
 * ISS-290 with the per-project console rollups; do not guess field names).
 */
export interface ProjectHealthRow {
  /** Project UUID — join key against `ProjectListItem.id`. */
  id: string;
  projectName: string;
  projectSlug: string;
  projectMeta: Record<string, unknown>;
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

/**
 * Body of `POST /api/projects` — mirrors `createProjectSchema` in
 * `packages/core/src/projects/routes.ts` (slug: 3–64 lowercase/digits/hyphens;
 * name: 1–200; description optional). Do not loosen these without updating the
 * server schema.
 */
export interface CreateProjectInput {
  slug: string;
  name: string;
  description?: string | null;
  /** Target org — omitted = the caller's personal org. */
  orgId?: string;
}

/**
 * `201` response of `POST /api/projects` — the inserted row projection (no
 * membership `role`, which the caller always owns on create).
 */
export interface CreatedProject {
  id: string;
  slug: string;
  name: string;
  orgId: string;
  createdBy: string;
  apiKey: string;
  createdAt: string;
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
