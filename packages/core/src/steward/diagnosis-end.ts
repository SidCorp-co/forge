// What a stuck diagnosis ends in (REQ-48 BC-5, ISS-654): the item moved by the steward's own act, one
// ask of whoever owes its act, or a line on the item saying why nobody could be asked. A turn that
// ended on its note alone is finished here: Forge asks through the wake door, which picks whom from
// the standing (`ask-addressee.ts`), and where that asks nobody, the reason is logged on the item. A
// finished diagnosis counts for its basis only where it ended so (`runs-store.ts:ranOnBasis`), so one
// that ended on a note alone is diagnosed again once, never skipped forever.

import type { ItemStanding } from '@forge/contracts/steward';
import { inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { stewardActs } from '../db/schema-steward-runs.js';
import { endsDiagnosis, recordAct } from './acts-store.js';
import { askedAlready } from './asks.js';
import type { DoorContext } from './door-kit.js';
import { callStewardDoor } from './doors.js';

/** The act door a diagnosis that could ask nobody is logged under. */
const SAY_NOBODY_DOOR = 'SAY nobody asked';

/** The one question the ask puts, from the standing: who owes what since when, and the recommended act. */
export function askOfStanding(key: string, standing: ItemStanding): string {
  const w = standing.waitingOn;
  const since = (standing.stuck?.since ?? standing.since).slice(0, 10);
  const ask = `${key} has waited on ${w.who} to ${w.act} since ${since}. Recommended: ${w.act} now, or record on ${key} why it waits.`;
  return ask.length > 500 ? `${ask.slice(0, 499)}…` : ask;
}

async function doorsOf(actIds: readonly string[]): Promise<string[]> {
  if (actIds.length === 0) return [];
  const rows = await db
    .select({ door: stewardActs.door })
    .from(stewardActs)
    .where(inArray(stewardActs.id, [...actIds]));
  return rows.map((r) => r.door);
}

/** A reason without the instruction the door adds for a turn ("ask nothing; write the note"). */
const bare = (why: string) => why.replace(/[.:;]?\s*ask nothing\b.*$/is, '').trim();

/** Why the wake door asked nobody, from its answer to the turn. */
function whyOf(text: string): string {
  try {
    const error = (JSON.parse(text) as { error?: unknown }).error;
    if (typeof error === 'string') return bare(error.replace(/^steward_wake_master: /, ''));
  } catch {
    // not JSON: the text is the reason
  }
  return bare(text.slice(0, 300));
}

/**
 * End a stuck diagnosis whose turn moved nothing and asked nobody: ask whoever owes the item's act,
 * or log why nobody could be asked. A turn that acted or asked, an item already asked on the standing
 * it reads, an act other than a stuck diagnosis, and an item no longer stuck are left as they are.
 */
export async function endUnmovedDiagnosis(ctx: DoorContext): Promise<void> {
  const standing = ctx.standing;
  if (ctx.act !== 'stuck_diagnosis' || !standing?.stuck) return;
  if ((await doorsOf(ctx.acts)).some(endsDiagnosis)) return;
  // an ask already made on this standing still holds it, or a decision answered it: nothing to add
  if (await askedAlready(ctx.projectId, standing, new Date())) return;
  const key = ctx.subject.key.toUpperCase();
  const failed = ctx.refused.length + ctx.broken.length;
  const out = await callStewardDoor(
    'steward_wake_master',
    JSON.stringify({ about: key, ask: askOfStanding(key, standing) }),
    ctx,
  );
  if (out.ok) return;
  const why =
    ctx.refused.length + ctx.broken.length > failed
      ? `the wake door failed: ${[...ctx.refused, ...ctx.broken].at(-1)}`
      : whyOf(out.text);
  ctx.acts.push(
    await recordAct({
      runId: ctx.runId,
      projectId: ctx.projectId,
      act: ctx.act,
      door: SAY_NOBODY_DOOR,
      did: `Asked nobody about ${key}: ${why}`,
      wrote: null,
      undo: null,
    }),
  );
}
