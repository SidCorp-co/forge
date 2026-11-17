// ISS-1281 (FB-709, gwork 0.19.0 with #126): the projection a promotion cut reads is filled by the
// source host's webhooks, so a request opened seconds before the cut is not there yet, and the cut
// refused it as if none were open. A cut naming `promotion.request` the projection holds no such
// request across the promotion for reads that one request from the host, once, through the writer a
// refresh takes (`projectReadChangeRequest`), before anything refuses it. The reading is handed to the
// refusals, which say which it was: re-read, not on the host, or the host unread.

import {
  projectReadChangeRequest,
  resolveSourceHost,
  SourceHostCallError,
} from '../integrations/source-host/index.js';
import { resolveReleaseDeclaration } from './gate.js';
import type { NamedPromotionRead } from './promotion-named.js';
import { requestsAcross } from './promotion-standing.js';

function notOnHost(err: unknown): boolean {
  return err instanceof SourceHostCallError && err.phase === 'request' && err.status === 404;
}

/**
 * Request `number` read from the host and written onto the projection, where the cut names it on a
 * promotion project and the projection holds no such request across the promotion; null where nothing
 * was read: no promotion declared, or the request already held. Never throws: a declaration that cannot
 * be read is the blocker pass's to report, and a host that cannot be read is the reading.
 */
export async function rereadNamedPromotion(
  projectId: string,
  number: number,
): Promise<NamedPromotionRead | null> {
  const decl = await resolveReleaseDeclaration(projectId).catch(() => null);
  if (decl?.kind !== 'promotion') return null;
  const held = await requestsAcross(projectId, decl.promotion);
  if (held.some((r) => r.number === number)) return null;
  let label = `#${number}`;
  try {
    const host = await resolveSourceHost(projectId);
    label = `${host.words.sigil}${number}`;
    const read = await host.readChangeRequest(number).catch((err: unknown) => {
      if (notOnHost(err)) return null;
      throw err;
    });
    if (!read) return { number, label, outcome: 'absent', on: host.fullName };
    await projectReadChangeRequest({ projectId, host, read });
    return {
      number,
      label,
      outcome: 'read',
      state: read.state,
      from: read.headRef,
      into: read.baseRef,
    };
  } catch (err) {
    return {
      number,
      label,
      outcome: 'unread',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
