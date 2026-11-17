// The release acts a project's releases wait on its master for (ISS-1058, ISS-1278): each release's own
// standing (`release-view.ts:turnOf`) names who owes its act, and this reads those standings, never a
// second rule. Every wait naming the master is its owed work, whatever the act, so the master is
// placed and kept exactly while the release page says a release waits on it.

import type { Said } from '@forge/contracts/said';
import { owedActOfSaid } from '@forge/contracts/who-owes';
import { waitingIssueIds } from './queries.js';
import { listReleases } from './release-list-read.js';
import { readReleaseOwes } from './release-owes.js';

export interface ReleaseActOwed {
  version: string;
  /** The said key of the act the release's wait names, read through what wraps it: the act's identity. */
  key: string;
  /** The act as the release page says it to the master, in English. */
  act: string;
}

/** The wrappers a wait's act may sit in: an issue's act on a requirement, "… and N more", nobody holding it. */
const WRAPS: ReadonlySet<string> = new Set([
  'standing.act.andMore',
  'standing.act.onIssue',
  'standing.act.noHolder',
]);

/** The act a wait names, read through what wraps it. */
function firstAct(act: Said): Said {
  const inner = WRAPS.has(act.key) ? act.vars?.act : undefined;
  return inner && typeof inner === 'object' && 'key' in inner ? firstAct(inner as Said) : act;
}

/**
 * Whether the project's master owes the release act a wait names, by the one rule read with the
 * project's policy and what the next release carries that cannot be undone, as the forecast reads it
 * (`forecast/release.ts:readReleaseFacts`); null where the wait names no release act. The steward
 * asks by this (`steward/ask-addressee.ts`, ISS-1058), so a routine cut or record is asked of the
 * master whoever the wait's words name.
 */
export async function masterTakesReleaseAct(projectId: string, act: Said): Promise<boolean | null> {
  const kind = owedActOfSaid(firstAct(act).key);
  if (!kind?.startsWith('release.')) return null;
  const owes = await readReleaseOwes(projectId, await waitingIssueIds(projectId));
  return owes(kind).by === 'master';
}

/**
 * Every release whose standing waits on the project's master, with the act it names. Placement and
 * retirement count each as owed work (`masters/verdict.ts:workWaits`), so no act the release page
 * gives the master — opening a promotion change request (ISS-1278), answering a return, a gate's act
 * on its issues — reads `nothing_owed` beside it.
 */
export async function releaseActsOwed(projectId: string): Promise<ReleaseActOwed[]> {
  const { releases } = await listReleases(projectId, null);
  return releases.flatMap((r) => {
    const w = r.waitingOn;
    if (w.kind !== 'agent' || w.says.who.key !== 'standing.who.master') return [];
    return [{ version: r.version, key: firstAct(w.says.act).key, act: w.act }];
  });
}
