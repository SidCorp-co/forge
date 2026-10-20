import type { IssueStatus } from '../db/schema.js';
import type { IssueCut } from '../pipeline/runs-cascade.js';
import { actorAgency, type TransitionActor } from './actor-agency.js';

/** An agent spares the jobs its own step runs (ISS-352): its box's, or every one from an account. */
function issueCutBy(actor: TransitionActor, toStatus: IssueStatus): IssueCut {
  const cause = toStatus === 'dropped' ? 'issue_dropped' : 'issue_closed';
  if (actor.type === 'device') return { cause, spares: { deviceId: actor.id } };
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
