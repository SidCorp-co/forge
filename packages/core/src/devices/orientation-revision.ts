import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, runners } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { devicesPorts } from './ports.js';

/**
 * The revision of an orientation core serves a checkout: the sha256 of its composed body. Anything
 * the body is composed from (a knowledge entry or rule of the project or its org, a lesson, the
 * affordances table, the build's own text) moves it, and nothing else does, so a box compares it
 * with the revision it last wrote instead of composing or diffing the body (ISS-1066).
 */
export function orientationRevision(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * The orientation revision of every project this device is assigned, by project id, for its
 * heartbeat. `null` where it could not be composed: the heartbeat is the box's liveness, so a
 * failure here is logged and the beat answered without it, which the box reads as "nothing said".
 */
export async function deviceOrientationRevisions(
  deviceId: string,
): Promise<Record<string, string> | null> {
  try {
    const assigned = await db
      .select({ projectId: runners.projectId, slug: projects.slug })
      .from(runners)
      .innerJoin(projects, eq(projects.id, runners.projectId))
      .where(and(eq(runners.deviceId, deviceId), eq(runners.type, 'claude-code')));
    const revisions = await Promise.all(
      assigned.map(
        async (a) =>
          [
            a.projectId,
            orientationRevision(await devicesPorts().checkoutOrientation(a.projectId, a.slug)),
          ] as const,
      ),
    );
    return Object.fromEntries(revisions);
  } catch (err) {
    logger.error(
      { err: (err as Error).message, deviceId },
      'heartbeat: the orientation revisions could not be composed, so this beat carries none and the box keeps what it holds',
    );
    return null;
  }
}
