/**
 * Whether a wait names the project's master as who owes its act, the one test every owed-work read
 * of the master applies (ISS-1278): a release's standing (`release-batch/master-owed-acts.ts`) and an
 * issue's, requirement's, feedback item's or workflow's (`standing/master-owed.ts`). Placement and
 * retirement count what passes it, so no wait naming the Master reads `nothing_owed` beside it.
 */

import type { Said } from '@forge/contracts/said';
import type { WaitingOn } from '@forge/contracts/standing';

/** The names a wait gives the project's master: "Master", and "The project's master" on feedback and designs. */
const MASTER_WHO: ReadonlySet<string> = new Set([
  'standing.who.master',
  'standing.who.projectMaster',
]);

export function waitNamesMaster(w: Pick<WaitingOn, 'kind' | 'says'>): boolean {
  if (w.kind === 'master') return true;
  return w.kind === 'agent' && MASTER_WHO.has(w.says.who.key);
}

/** The wrappers a wait's act may sit in: an issue's act on a requirement or feedback, "… and N more", nobody holding it. */
const WRAPS: ReadonlySet<string> = new Set([
  'standing.act.andMore',
  'standing.act.onIssue',
  'standing.act.noHolder',
]);

/** A wait's act and every act it wraps, outermost first: the last is the act's identity. */
export function actChain(act: Said): Said[] {
  const inner = WRAPS.has(act.key) ? act.vars?.act : undefined;
  return inner && typeof inner === 'object' && 'key' in inner
    ? [act, ...actChain(inner as Said)]
    : [act];
}

/** The act a wait names, read through what wraps it. */
export const innermostAct = (act: Said): Said => actChain(act).at(-1) ?? act;
