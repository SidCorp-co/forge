// The release acts a project's releases wait on its master for (ISS-1058): each release's own standing
// (`release-view.ts:turnOf`) names who owes its act by the one rule, and a routine one names the
// master. This reads those standings, never a second rule, so the master's owed work counts exactly
// the acts the release page names it for, and a project owing one gets a master placed.

import type { Said } from '@forge/contracts/said';
import { type OwedActKind, owedActOfSaid } from '@forge/contracts/who-owes';
import { listReleases } from './release-read.js';

export interface ReleaseActOwed {
  version: string;
  kind: OwedActKind;
  /** The act as the release page says it to the master, in English. */
  act: string;
}

/** The act a gated release names first, read through "… and N more". */
function firstAct(act: Said): Said {
  const inner = act.key === 'standing.act.andMore' ? act.vars?.act : undefined;
  return inner && typeof inner === 'object' && 'key' in inner ? (inner as Said) : act;
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
