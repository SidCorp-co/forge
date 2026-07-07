import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { devices, projects, runners } from '../db/schema.js';
import { dispatchLivenessMs } from './dispatch-liveness.js';

/**
 * Pick a device for a new interactive agent session for `projectId`.
 *
 * Resolution order:
 *  1. The freshest online `claude-code` runner row for this project (mirrors
 *     `selectRunnerForJob` filters: status='online', host='device',
 *     last_seen_at within the dispatch-liveness window).
 *  2. The project's `defaultDeviceId` if it points to an online device.
 *  3. `null` — caller must surface "no device available" to the user.
 *
 * ISS-172 Slice A: the source of truth is the `runners` table, not the
 * deprecated `project_devices` pool. A device may be a runner for N projects
 * simultaneously; this query returns the device id for THIS project only.
 *
 * `excludeDeviceIds` (ISS-584 B) skips devices already tried — used by the
 * schedule cross-runner failover so a dead-on-arrival runner is not re-picked
 * on the retry. The default-device fallback honours the exclude list too.
 */
export async function findAvailableDeviceForProject(
  projectId: string,
  opts: { excludeDeviceIds?: string[] } = {},
): Promise<string | null> {
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const exclude = (opts.excludeDeviceIds ?? []).filter((id): id is string => !!id);
  // Build a parenthesised parameter list and use `NOT IN (...)`. Interpolating a
  // JS array directly (`<> ALL(${exclude}::uuid[])`) expands as a record tuple
  // ($1,$2,…) → malformed array literal at query time. Same idiom as
  // mcp/tools/forge-metrics.ts.
  const excludeClause = exclude.length
    ? sql`AND r.device_id NOT IN (${sql.join(
        exclude.map((id) => sql`${id}`),
        sql`, `,
      )})`
    : sql``;
  const rows = await db.execute<{ device_id: string }>(sql`
    SELECT r.device_id
    FROM runners r
    WHERE r.project_id = ${projectId}
      AND r.type       = 'claude-code'
      AND r.host       = 'device'
      AND r.status     = 'online'
      AND r.device_id IS NOT NULL
      AND r.last_seen_at IS NOT NULL
      AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
      AND NOT EXISTS (
        SELECT 1 FROM devices d WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL
      )
      ${excludeClause}
    ORDER BY r.last_seen_at DESC
    LIMIT 1
  `);
  if (rows[0]) return rows[0].device_id;

  const [project] = await db
    .select({ defaultDeviceId: projects.defaultDeviceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project?.defaultDeviceId || exclude.includes(project.defaultDeviceId)) return null;

  const [defaultDevice] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.id, project.defaultDeviceId),
        eq(devices.status, 'online'),
        isNull(devices.disabledAt),
      ),
    )
    .limit(1);

  return defaultDevice?.id ?? null;
}

/**
 * Verify that `deviceId` is a chat-capable runner for `projectId` and return it
 * when eligible, else `null`. "Chat-capable" mirrors the primary
 * `findAvailableDeviceForProject` filters (type='claude-code', host='device',
 * status='online', within the dispatch-liveness window, device not disabled) —
 * so an explicit runner pick from the UI is validated against the exact same
 * gate the auto-pick uses, and a stale/offline/foreign choice is rejected rather
 * than silently dispatched to a dead cwd (ISS-420). Used by the chat runner
 * picker (`resolveChatDevice` override path).
 */
export async function findChatCapableDeviceForProject(
  projectId: string,
  deviceId: string,
): Promise<string | null> {
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const rows = await db.execute<{ device_id: string }>(sql`
    SELECT r.device_id
    FROM runners r
    WHERE r.project_id = ${projectId}
      AND r.device_id  = ${deviceId}
      AND r.type       = 'claude-code'
      AND r.host       = 'device'
      AND r.status     = 'online'
      AND r.last_seen_at IS NOT NULL
      AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
      AND NOT EXISTS (
        SELECT 1 FROM devices d WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL
      )
    LIMIT 1
  `);
  return rows[0]?.device_id ?? null;
}

/**
 * Resolve the working repo path for a session.
 *
 * The web client may pass an explicit `repoPath` override; otherwise we fall
 * back to `projects.repoPath`. We do NOT fall back to a per-device override
 * — that's a Strapi-era concept (`device.projectPaths[slug]`) that does not
 * exist in core's device schema yet. Add it back if the desktop client needs
 * per-device path overrides.
 */
export function resolveRepoPath(
  override: string | null | undefined,
  projectRepoPath: string | null,
): string | null {
  const v = (override ?? projectRepoPath ?? '').trim();
  return v.length === 0 ? null : v;
}

/**
 * Working dir for an interactive/schedule session dispatched to `deviceId`.
 *
 * Chat & schedule run `claude` with this as cwd ON THE CHOSEN RUNNER'S box, so
 * it must be that runner's local binding path — NOT `projects.repoPath`, which
 * is only a default hint valid on the owner's own machine. Sending the project
 * path to a remote runner makes `claude` spawn in a non-existent cwd and fail
 * with "No such file or directory"; the session then hangs `running` forever.
 *
 * Returns the runner binding `repo_path` for (project, device) when set, else
 * `null` so the caller falls back to the project default — correct for the
 * desktop client, which has no binding and runs on the owner's box. Mirrors the
 * job path (`daemon/dispatch.rs resolve_repo`), keeping chat/schedule + jobs in
 * lockstep.
 */
export async function resolveRunnerRepoPath(
  projectId: string,
  deviceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ repoPath: runners.repoPath })
    .from(runners)
    .where(and(eq(runners.projectId, projectId), eq(runners.deviceId, deviceId)))
    .limit(1);
  const v = (row?.repoPath ?? '').trim();
  return v.length === 0 ? null : v;
}
