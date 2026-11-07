// The release acts a project's releases wait on its master for (ISS-1058): each release's own standing
// (`release-view.ts:turnOf`) names who owes its act by the one rule, and a routine one names the
// master. This reads those standings, never a second rule, so the master's owed work counts exactly
// the acts the release page names it for, and a project owing one gets a master placed.

import type { Said } from '@forge/contracts/said';
import { type OwedActKind, owedActOfSaid } from '@forge/contracts/who-owes';
import { waitingIssueIds } from './queries.js';
import { listReleases } from './release-list-read.js';
import { readReleaseOwes } from './release-owes.js';

export interface ReleaseActOwed {
  version: string;
  kind: OwedActKind;
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

export async function releaseActsOwed(projectId: string): Promise<ReleaseActOwed[]> {
  const { releases } = await listReleases(projectId, null);
  return releases.flatMap((r) => {
    const w = r.waitingOn;
    if (w.kind !== 'agent' || w.says.who.key !== 'standing.who.master') return [];
    const kind = owedActOfSaid(firstAct(w.says.act).key);
    return kind ? [{ version: r.version, kind, act: w.act }] : [];
  });
}
