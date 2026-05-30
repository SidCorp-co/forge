// web-v2 feature module: projects. Types come from `@forge/contracts` where a
// shared shape exists; the hand-rolled server projections (list row, detail,
// health) are re-typed here to match the exact `core` route responses — see
// `packages/core/src/projects/routes.ts` + `health-routes.ts`. Verified against
// those routes for ISS-288 (do not guess field names).
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
  ownerId: string;
  role: ProjectMember['role'];
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
 * `packages/core/src/projects/health-routes.ts`).
 */
export interface ProjectHealthRow {
  projectName: string;
  projectSlug: string;
  projectMeta: Record<string, unknown>;
  throughput: number;
  totalActive: number;
  statusDistribution: Record<string, number>;
  blockers: Array<{ issueId: string; documentId: string; status: string }>;
  pendingEscalations: number;
  avgCycleTimeDays: number;
}
