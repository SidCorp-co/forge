import { and, eq, isNull, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { devices, projects, runners } from '../db/schema.js';
import { dispatchLivenessMs } from './dispatch-liveness.js';

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
      AND r.status     = 'online'
      AND r.last_seen_at IS NOT NULL
      AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
      AND NOT EXISTS (
        SELECT 1 FROM devices d WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL
      )
      ${excludeClause}
    ORDER BY
      (CASE WHEN (r.rate_limited_until IS NULL OR r.rate_limited_until <= now())
                 AND r.limit_reason IS DISTINCT FROM 'auth'
            THEN 0 ELSE 1 END) ASC,
      r.last_seen_at DESC
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

export async function findChatCapableDeviceForProject(
  projectId: string,
  deviceId: string,
  opts: { allowLimited?: boolean } = {},
): Promise<string | null> {
  const livenessSeconds = Math.floor(dispatchLivenessMs() / 1000);
  const healthClause = opts.allowLimited
    ? sql``
    : sql`AND (r.rate_limited_until IS NULL OR r.rate_limited_until <= now())
          AND r.limit_reason IS DISTINCT FROM 'auth'`;
  const rows = await db.execute<{ device_id: string }>(sql`
    SELECT r.device_id
    FROM runners r
    WHERE r.project_id = ${projectId}
      AND r.device_id  = ${deviceId}
      AND r.type       = 'claude-code'
      AND r.status     = 'online'
      AND r.last_seen_at IS NOT NULL
      AND r.last_seen_at > now() - (${livenessSeconds} || ' seconds')::interval
      AND NOT EXISTS (
        SELECT 1 FROM devices d WHERE d.id = r.device_id AND d.disabled_at IS NOT NULL
      )
      ${healthClause}
    LIMIT 1
  `);
  return rows[0]?.device_id ?? null;
}

/**
 * Why a device cannot be handed a working directory for a project: it has no runner row there.
 * The sentence names only acts that work from that state, in the order they work: `forge-runner
 * bind` refuses a device the project has not assigned, so the Runners page comes first.
 *
 * A checkout belongs to a device, not to a project (`runners.repoPath` per device × project), so a
 * device the project never bound has no checkout this core could name, and handing it the
 * project's own `repoPath` would run it in some other box's folder.
 */
export class DeviceNotBoundError extends HTTPException {
  readonly deviceId: string;
  readonly projectId: string;

  constructor(args: {
    deviceId: string;
    deviceName: string | null;
    projectId: string;
    projectSlug: string | null;
  }) {
    const device = args.deviceName ? `${args.deviceName} (${args.deviceId})` : args.deviceId;
    const project = args.projectSlug ?? args.projectId;
    super(409, {
      message:
        `Device ${device} is not bound to project ${project}, so it has no checkout of it to run in. ` +
        `Assign the device on ${project}'s Runners page, which binds it; ` +
        (args.projectSlug
          ? `to choose the folder it runs in, give the path there or, once it is assigned, run \`forge-runner bind ${args.projectSlug} --path <dir>\` on that device. `
          : 'the path it runs in can be given there too. ') +
        'Then try again.',
      cause: {
        code: 'DEVICE_NOT_BOUND',
        details: { deviceId: args.deviceId, projectId: args.projectId },
      },
    });
    this.name = 'DeviceNotBoundError';
    this.deviceId = args.deviceId;
    this.projectId = args.projectId;
  }
}

export interface DeviceBinding {
  runnerId: string;
  runnerType: string;
  /**
   * The device's checkout of the project as the server records it. `null` means the server holds
   * no path for this binding and the device answers from its own local binding for the slug,
   * refusing by name when it has none; the project's `repoPath` is never put in its place.
   */
  checkout: string | null;
}

/**
 * The one reader of where a device runs a project's work: its runner row for that project.
 */
export async function readDeviceBinding(
  projectId: string,
  deviceId: string,
): Promise<DeviceBinding> {
  const [row] = await db
    .select({ id: runners.id, type: runners.type, repoPath: runners.repoPath })
    .from(runners)
    .where(and(eq(runners.projectId, projectId), eq(runners.deviceId, deviceId)))
    .limit(1);
  if (!row) throw await deviceNotBound(projectId, deviceId);
  const checkout = (row.repoPath ?? '').trim();
  return { runnerId: row.id, runnerType: row.type, checkout: checkout.length ? checkout : null };
}

/**
 * The refusal for `deviceId`, naming the device only where the project itself names it as its
 * default: a caller may pass any device's id, and another tenant's box name is not this one's.
 */
async function deviceNotBound(projectId: string, deviceId: string): Promise<DeviceNotBoundError> {
  const [project] = await db
    .select({ slug: projects.slug, defaultDeviceId: projects.defaultDeviceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const [device] =
    project?.defaultDeviceId === deviceId
      ? await db
          .select({ name: devices.name })
          .from(devices)
          .where(eq(devices.id, deviceId))
          .limit(1)
      : [];
  return new DeviceNotBoundError({
    deviceId,
    deviceName: device?.name ?? null,
    projectId,
    projectSlug: project?.slug ?? null,
  });
}
