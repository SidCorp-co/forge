// The beta port's one-time body backfill (ISS-923): the first fire read issue bodies from beta's list,
// which carries none, so each dev issue it made holds only its provenance line. Each fire, before it
// ports, reads the beta issue of every pair whose dev description is still exactly that line and
// writes beta's body under it, through the issue update the issues route writes with and as the
// actor the port creates as. A description that is anything else may be a person's edit and is never
// touched. A pair is backfilled once: recorded on it whether a body was written or beta's was empty;
// a beta read that is refused is reported and tried again next fire.

import { readPeerIssueDescription } from '../integrations/peer-forge/index.js';
import { type Actor, updateIssueFields } from '../issues/index.js';
import { isRefusal } from '../lib/refusal.js';
import { writtenLangFor } from '../lib/written-lang.js';
import { isPortStub, portedDescription } from './markers.js';
import type { MirrorContext } from './mirror.js';
import { devDescriptionOf, recordBackfill, type StubPair, stubPairCandidates } from './store.js';

/** At most this many pairs are backfilled by one fire; the rest are named and left for the next. */
export const MAX_BACKFILLS_PER_FIRE = 25;

/** What the backfill reads and writes: beta, the report, and the fire it is made by. */
export type BackfillContext = Pick<MirrorContext, 'peer' | 'report'> & { fireId: string };

const lineOf = (pair: StubPair) => `${pair.betaProjectSlug}: ${pair.devKey} ← beta ${pair.betaKey}`;

export async function backfillBodies(ctx: BackfillContext): Promise<void> {
  const owed = (await stubPairCandidates()).filter((p) =>
    isPortStub(p.description, p.betaKey, p.betaIssueId),
  );
  const now = owed.slice(0, MAX_BACKFILLS_PER_FIRE);
  ctx.report.backfillOwed.push(...owed.slice(MAX_BACKFILLS_PER_FIRE).map(lineOf));
  for (const pair of now) {
    try {
      await backfillOne(ctx, pair);
    } catch (err) {
      const code = isRefusal(err)
        ? (err.refusals[0]?.code ?? err.fallbackCode)
        : 'BETA_PORT_BACKFILL_FAILED';
      const said = err instanceof Error ? err.message : String(err);
      ctx.report.refused.push(`${lineOf(pair)} body: ${code} (${said}); tried again next fire`);
    }
  }
}

async function backfillOne(ctx: BackfillContext, pair: StubPair): Promise<void> {
  const read = await readPeerIssueDescription(ctx.peer, pair.betaIssueId);
  if (!read.ok) {
    ctx.report.refused.push(
      `${lineOf(pair)} body: ${read.refusal.code} (${read.refusal.detail}); tried again next fire`,
    );
    return;
  }
  if (!read.value?.trim()) {
    await recordBackfill(pair.betaIssueId, ctx.fireId);
    ctx.report.backfillEmpty.push(lineOf(pair));
    return;
  }
  // read again after beta answered: a person who edited it meanwhile owns it, and it is left
  const current = await devDescriptionOf(pair.devIssueId);
  if (!isPortStub(current, pair.betaKey, pair.betaIssueId)) {
    ctx.report.skipped.push(`${lineOf(pair)} (edited while beta was read: left as it stands)`);
    return;
  }
  const description = portedDescription(pair.betaKey, pair.betaIssueId, read.value);
  // the twin's owner, as an agent: the actor the port creates the issue as
  const actor: Actor = { type: 'user', id: pair.devProjectOwner, agency: 'agent' };
  await updateIssueFields({
    issueId: pair.devIssueId,
    updates: {
      description,
      updatedAt: new Date(),
      writtenLang: await writtenLangFor(
        { userId: actor.id, agency: actor.agency },
        pair.devProjectId,
        null,
        undefined,
        [pair.title, description].join('\n'),
      ),
    },
    actor,
    changes: {
      fields: ['description'],
      before: { description: current },
      after: { description },
    },
  });
  await recordBackfill(pair.betaIssueId, ctx.fireId);
  ctx.report.backfilled.push(lineOf(pair));
}
