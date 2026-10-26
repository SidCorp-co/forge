/**
 * What the source door's projection routes do once the host has answered: roll a commit's checks up,
 * and write a change request the host answered for onto Forge's record, emitting the merge it
 * reports (`source.merged`) for the stamp's own consumer. Kept out of the route file, which reads
 * and writes nothing itself.
 */

import { db } from '../db/client.js';
import type { InboundFact } from '../integrations/index.js';
import {
  type HostCheck,
  projectReadChangeRequest,
  type ReadChangeRequest,
  rollupOf,
  type SourceHost,
} from '../integrations/source-host/index.js';
import { logger } from '../lib/logger.js';
import { emitEvents } from '../outbox/index.js';

/**
 * What a commit's checks say together: `failure` once any latest run failed, `pending` while any
 * is unfinished, `success` when every one passed, and `none` where nothing ran — never a green.
 */
export function checksAt(sha: string, checks: HostCheck[]) {
  const rollup = rollupOf(Object.fromEntries(checks.map((c) => [c.id, c])), sha);
  const state =
    rollup.total === 0
      ? 'none'
      : rollup.failure > 0
        ? 'failure'
        : rollup.pending > 0
          ? 'pending'
          : 'success';
  return { sha, state, rollup, checks };
}

async function emit(facts: InboundFact[]): Promise<void> {
  if (facts.length > 0) await db.transaction((tx) => emitEvents(tx, facts));
}

/** Project what the host answered and emit the merge it reports; throws where it cannot write. */
export async function project(host: SourceHost, projectId: string, read: ReadChangeRequest) {
  const { projection, facts } = await projectReadChangeRequest({ projectId, host, read });
  await emit(facts);
  return projection;
}

/** After a write the host accepted: the projection, or why it was not written, never a throw. */
export async function projectAfterWrite(
  host: SourceHost,
  projectId: string,
  read: ReadChangeRequest,
  verb: 'edit' | 'close',
): Promise<unknown> {
  try {
    return { ...read, projection: await project(host, projectId, read) };
  } catch (err) {
    logger.error(
      { projectId, number: read.number, bindingId: host.bindingId, err },
      `source ${verb}: the host accepted it and the projection row did not take it`,
    );
    const ref = `${host.words.sigil}${read.number}`;
    return {
      ...read,
      projection: {
        outcome: 'not-recorded',
        reason:
          `${err instanceof Error ? err.message : String(err)}. The ${verb} STANDS on ${host.provider}; ` +
          `\`POST …/change-requests/${read.number}/refresh\` re-reads ${ref} and writes the record.`,
      },
    };
  }
}
