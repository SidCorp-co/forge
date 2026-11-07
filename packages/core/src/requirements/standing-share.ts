// A read that lists every requirement of a project with its standing offers each one's state and
// coverage to the reads after it in the same request (`db/read-memo.ts:offerRead`): Needs you lists
// the requirements and weighs the releases in play, whose requirements the release facts would
// otherwise derive a second time from every statement of the standing read (ISS-1070).

import type { RequirementStanding } from '@forge/contracts/requirements';
import { heldRead, offerRead } from '../db/read-memo.js';
import { type StandingRow, standingsOf } from './standing-read.js';

/** What a release reads of a requirement's standing; neither depends on who views it. */
export type CompletionStanding = Pick<RequirementStanding, 'state' | 'coverage'>;

const keyOf = (projectId: string) => `requirementStandings:${projectId}`;

/** Offers each listed requirement's state and coverage, read by `list`, to the rest of this read. */
export function offerStandings<L extends { id: string; standing: RequirementStanding }>(
  projectId: string,
  list: () => Promise<L[]>,
): Promise<L[]> {
  let listed: Promise<L[]> | undefined;
  const offered = offerRead(keyOf(projectId), async () => {
    listed = list();
    const read = await listed;
    return new Map<string, CompletionStanding>(
      read.map((r) => [r.id, { state: r.standing.state, coverage: r.standing.coverage }]),
    );
  });
  return offered.then(() => listed as Promise<L[]>);
}

/**
 * Each of `rows`' state and coverage: from a list this read already made of the project's
 * requirements where it holds them, the rest from their own standing read.
 */
export async function completionStandingsOf(
  projectId: string,
  rows: readonly StandingRow[],
): Promise<Map<string, CompletionStanding>> {
  const held = await heldRead<Map<string, CompletionStanding>>(keyOf(projectId))?.catch(
    () => undefined,
  );
  const missing = rows.filter((r) => !held?.has(r.id));
  const read = missing.length > 0 ? await standingsOf(projectId, missing, null) : new Map();
  return new Map(
    rows.flatMap((r) => {
      const s = held?.get(r.id) ?? read.get(r.id);
      // each reader gets its own copy, as a memoized read hands one (`db/read-memo.ts`)
      return s ? [[r.id, structuredClone(s)] as const] : [];
    }),
  );
}
