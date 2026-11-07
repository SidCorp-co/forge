// The deploys core already sent through one Coolify binding, read from core's own delivery log
// (ISS-1116): each target's outbound `release.requested` delivery names the run, the commit the
// door read for it and who asked, and Coolify's deployment once it was accepted; the confirm poller
// (`release-batch/coolify-confirm.ts`) asks Coolify `GET /deployments/{uuid}` and writes the
// inbound `deploy.succeeded` / `deploy.failed` row that settles it. Nothing here asks Coolify: an
// accepted deploy with no settling row is still running, until the confirm window that poller fails
// it at has passed.

import { DEPLOY_CONFIRM_WINDOW_MS } from '@forge/contracts/pipeline';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '../../../db/client.js';
import { integrationDeliveries } from '../../../db/schema.js';

/** The event a deploy is sent under, by every caller of the door. */
const DEPLOY_EVENT = 'release.requested';
const SETTLED = ['deploy.succeeded', 'deploy.failed'] as const;
/** How far back a sent deploy is read: past the confirm window every one has settled or expired. */
const LOOKBACK_MS = 24 * 60 * 60_000;

/** Who asked core for a deploy, as the door recorded it. */
export interface DeployCaller {
  userId: string;
  agency: string;
  /** The credential the call came on: a token by its name, a box, or a browser session. */
  via: string;
}

/** One deploy core sent, and where it stands in core's own record. */
export interface SentDeploy {
  deliveryId: string;
  runId: string | null;
  targetLabel: string;
  /** Coolify's deployment; null while the send is still waiting for Coolify's answer. */
  deploymentUuid: string | null;
  /** The commit the door read for it, from the branch its environment deploys; null where unread. */
  commit: string | null;
  sentAt: Date;
  sentBy: DeployCaller | null;
  /**
   * `queued`: sent, Coolify has not named the deployment yet. `running`: accepted and not settled.
   * `succeeded` / `failed`: settled by the confirm poller. `expired`: past the confirm window with
   * no settling row, so nothing says it still runs.
   */
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'expired';
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function callerOf(raw: unknown): DeployCaller | null {
  const c = raw as Partial<DeployCaller> | null;
  return c && typeof c.userId === 'string' && typeof c.agency === 'string'
    ? { userId: c.userId, agency: c.agency, via: typeof c.via === 'string' ? c.via : 'unknown' }
    : null;
}

/** Every deploy sent through `bindingId` in the last day, newest first. */
export async function sentDeploysOf(
  bindingId: string,
  now: Date = new Date(),
): Promise<SentDeploy[]> {
  const sent = await db
    .select()
    .from(integrationDeliveries)
    .where(
      and(
        eq(integrationDeliveries.bindingId, bindingId),
        eq(integrationDeliveries.direction, 'outbound'),
        eq(integrationDeliveries.eventName, DEPLOY_EVENT),
        inArray(integrationDeliveries.status, ['pending', 'ok']),
        gte(integrationDeliveries.createdAt, new Date(now.getTime() - LOOKBACK_MS)),
      ),
    )
    .orderBy(desc(integrationDeliveries.createdAt));
  const uuidOf = (r: (typeof sent)[number]) =>
    text((r.response as { deployment_uuid?: unknown } | null)?.deployment_uuid);
  const uuids = sent.flatMap((r) => uuidOf(r) ?? []);
  const settled =
    uuids.length === 0
      ? []
      : await db
          .select({
            requestId: integrationDeliveries.requestId,
            eventName: integrationDeliveries.eventName,
          })
          .from(integrationDeliveries)
          .where(
            and(
              eq(integrationDeliveries.bindingId, bindingId),
              eq(integrationDeliveries.direction, 'inbound'),
              inArray(integrationDeliveries.eventName, [...SETTLED]),
              inArray(integrationDeliveries.requestId, uuids),
            ),
          );
  const outcome = new Map(settled.map((s) => [s.requestId, s.eventName]));
  return sent.map((r) => {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const deploymentUuid = uuidOf(r);
    const open = r.createdAt.getTime() + DEPLOY_CONFIRM_WINDOW_MS > now.getTime();
    const settledAs = deploymentUuid ? outcome.get(deploymentUuid) : undefined;
    const state: SentDeploy['state'] =
      settledAs === 'deploy.succeeded'
        ? 'succeeded'
        : settledAs === 'deploy.failed'
          ? 'failed'
          : !open
            ? 'expired'
            : deploymentUuid
              ? 'running'
              : 'queued';
    return {
      deliveryId: r.id,
      runId: text(payload.runId),
      targetLabel: text(payload.targetLabel) ?? '',
      deploymentUuid,
      commit: text(payload.commit)?.toLowerCase() ?? null,
      sentAt: r.createdAt,
      sentBy: callerOf(payload.sentBy),
      state,
    };
  });
}
