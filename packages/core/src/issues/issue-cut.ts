import type { IssueStatus } from '../db/schema.js';
import type { IssueCut } from '../pipeline/runs-cascade.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';

/** The mover spares the jobs its own step runs (ISS-352): those on the box its credential names, or
 *  every one where an agent account that names no box moved it; a person spares none. */
function issueCutBy(actor: TransitionActor, toStatus: IssueStatus): IssueCut {
  const cause = toStatus === 'dropped' ? 'issue_dropped' : 'issue_closed';
  const box = actor.type === 'device' ? actor.id : actor.deviceId;
  if (box) return { cause, spares: { deviceId: box } };
  return { cause, spares: actorAgency(actor) === 'agent' ? 'every' : 'none' };
}

/** A dropped issue's run reads stopped whoever dropped it (ISS-1228); a hold cuts no job. */
export function runCloseFor(
  actor: TransitionActor,
  toStatus: IssueStatus,
  held: boolean,
): ['cancelled' | 'completed', IssueCut | undefined] {
  if (held) return ['completed', undefined];
  return [toStatus === 'dropped' ? 'cancelled' : 'completed', issueCutBy(actor, toStatus)];
}
