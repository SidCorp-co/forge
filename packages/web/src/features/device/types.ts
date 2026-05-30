import type { Device as DeviceRow } from '@forge/contracts';

/**
 * `GET /api/me/devices` returns a curated subset of the `devices` row —
 * sensitive fields like `tokenHash`/`tokenPrefix` are stripped server-side.
 */
export type MyDevice = Pick<
  DeviceRow,
  | 'id'
  | 'name'
  | 'platform'
  | 'agentVersion'
  | 'status'
  | 'lastSeenAt'
  | 'pairedAt'
  | 'capabilities'
  | 'createdAt'
>;

/**
 * One row of `GET /api/devices/:id/runners` (ISS-273) — a (device × project)
 * runner assignment, owner-scoped for the device-management page. `repoPath`/
 * `branch` are this device's per-project checkout; `projectDefaultRepoPath`/
 * `baseBranch` are the project-level defaults the UI prefills from.
 */
export interface DeviceRunnerAssignment {
  runnerId: string;
  projectId: string;
  slug: string;
  name: string;
  repoPath: string | null;
  branch: string | null;
  status: string;
  lastSeenAt: string | null;
  projectDefaultRepoPath: string | null;
  baseBranch: string | null;
}
