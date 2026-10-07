/**
 * The one writer of a week's What's new digest: an agent's short summary over the entries that
 * week released. A digest names only entries of its own week, is at most 120 words, and a second
 * write for the week replaces the first.
 */

import type { ActorAgency } from '@forge/contracts/permissions';
import {
  type PutWhatsNewDigestRequest,
  type WhatsNewDigestView,
  weekRange,
} from '@forge/contracts/whats-new';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { whatsNewDigests } from '../db/schema-whats-new.js';
import { lockXact } from '../lib/advisory-lock.js';
import type { Refusal } from '../lib/refusal.js';
import { digestOf, releasedEntries } from './read.js';
import { digestRefusals } from './rules.js';

export type DigestOutcome =
  | { ok: true; act: 'written' | 'replaced'; digest: WhatsNewDigestView }
  | { ok: false; refusals: Refusal[] };

export async function writeWhatsNewDigest(args: {
  projectId: string;
  week: string;
  request: PutWhatsNewDigestRequest;
  actor: { userId: string; agency: ActorAgency };
  now?: Date;
}): Promise<DigestOutcome> {
  const { projectId, week, request, actor } = args;
  const now = args.now ?? new Date();
  const range = weekRange(week);
  if (!range) throw new Error(`whats-new: ${week} reached the digest write without resolving`);
  const entries = await releasedEntries(projectId, range.from, range.to, null);
  const refusals = digestRefusals({
    week,
    from: range.from,
    now,
    request,
    weekKeys: entries.map((e) => e.key).sort(),
  });
  if (refusals.length > 0) return { ok: false, refusals };
  const entryKeys = [...new Set(request.entryKeys)];
  const act = await db.transaction(async (tx) => {
    await lockXact(tx, 'whatsNewDigests', `${projectId}:${week}`);
    const [row] = await tx
      .insert(whatsNewDigests)
      .values({
        projectId,
        week,
        title: request.title,
        body: request.body,
        entryKeys,
        writtenBy: actor.userId,
        writtenAgency: actor.agency,
        writtenAt: now,
      })
      .onConflictDoUpdate({
        target: [whatsNewDigests.projectId, whatsNewDigests.week],
        set: {
          title: request.title,
          body: request.body,
          entryKeys,
          writtenBy: actor.userId,
          writtenAgency: actor.agency,
          writtenAt: now,
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (!row) throw new Error('whats_new_digests: upsert returned no row');
    return row.inserted ? ('written' as const) : ('replaced' as const);
  });
  const digest = await digestOf(projectId, week);
  if (!digest) throw new Error(`whats_new_digests: ${week} written but not read back`);
  return { ok: true, act, digest };
}
