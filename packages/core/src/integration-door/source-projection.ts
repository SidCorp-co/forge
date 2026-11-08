/**
 * What the source door's projection routes do once the host has answered: roll a commit's checks up,
 * and write a change request the host answered for onto Forge's record. Kept out of the route file,
 * which reads and writes nothing itself.
 */

import {
  type HostCheck,
  projectReadChangeRequest,
  type ReadChangeRequest,
  rollupOf,
  type SourceHost,
} from '../integrations/source-host/index.js';
import { logger } from '../lib/logger.js';

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

/** Project what the host answered; throws where it cannot write. */
export async function project(host: SourceHost, projectId: string, read: ReadChangeRequest) {
  return projectReadChangeRequest({ projectId, host, read });
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
