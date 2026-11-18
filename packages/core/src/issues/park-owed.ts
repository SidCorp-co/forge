// Who a park's question is owed by, read from what the park waits on (ISS-1127). A park's question was
// opened as `human` whatever it waited on, so a park on a resource, or on another issue's delivery,
// landed in the owner's Needs you though no person owed an act: epod ISS-63, parked at
// `needs_resource` on forge ISS-1125's production monitor. Only an answer or a decision a person owes
// is `human`; a merge mark answers its own question (`machine`); a resource, or another issue named in
// what the park needs that has not landed yet, is the project's master's to supply or to follow
// (`master_or_peer`), and the master's pass lists it (`questions/owed-to-agents.ts`). An issue named
// there that has landed, closed or been dropped is a reference, not a wait (ISS-1292): forge ISS-1291's
// decision park named ISS-1259, closed long before, as a runner version, and its question was minted
// for the master, so the person who owed the act was never asked.

import type { WaitingKind } from '../db/schema.js';

export type ParkBlockerKind = 'human' | 'machine' | 'master_or_peer';

export interface ParkWaitFacts {
  waitingKind?: WaitingKind | null | undefined;
  /** What the park says would settle it: an issue named there is what the park waits on. */
  needs?: string | undefined;
  /** The park waits on its own issue's merge mark, which answers its question. */
  awaitsMerge: boolean;
  /** Every issue prefix the parked issue answers to (its project's, held and active, and `ISS`). */
  prefixes: readonly string[];
  /** The parked issue's own sequence number: its own key is not another issue. */
  ownSeq: number;
  /** The sequence numbers of the issues `needs` names that have landed, closed or been dropped:
   *  each is a reference, never a delivery the park waits on (ISS-1292). */
  shipped: ReadonlySet<number>;
}

/** Who owes a park's question, and why: the transition's answer says both (ISS-1292). */
export interface ParkOwed {
  blockerKind: ParkBlockerKind;
  because: string;
}

const PERSON_OWES: Record<WaitingKind, string> = {
  needs_answer: 'it waits on an answer a person owes',
  needs_decision: 'it waits on a decision a person owes',
  needs_resource: 'it waits on a resource',
};

/** The sequence number of a key {@link issuesNamedBy} returned. */
export const seqOfNamed = (key: string): number => Number(key.slice(key.lastIndexOf('-') + 1));

/** The other issues a park's words name, by key, in the prefixes its project answers to. */
export function issuesNamedBy(text: string, prefixes: readonly string[], ownSeq: number): string[] {
  if (prefixes.length === 0) return [];
  // prefixes are `[A-Z][A-Z0-9]{1,5}` (`lib/issue-ref.ts:validateIssuePrefix`), so none needs escaping
  const key = new RegExp(`\\b(${[...new Set(prefixes)].join('|')})-([1-9]\\d{0,9})\\b`, 'g');
  const named = new Set<string>();
  for (const m of text.matchAll(key)) {
    if (Number(m[2]) !== ownSeq) named.add(`${m[1]}-${m[2]}`);
  }
  return [...named];
}

/** Who owes the question a park mints, and why. */
export function parkOwedBy(f: ParkWaitFacts): ParkOwed {
  if (f.awaitsMerge) return { blockerKind: 'machine', because: 'its own merge mark answers it' };
  if (f.waitingKind === 'needs_resource') {
    return {
      blockerKind: 'master_or_peer',
      because: 'it waits on a resource, which the master supplies or gets',
    };
  }
  const named = issuesNamedBy(f.needs ?? '', f.prefixes, f.ownSeq);
  const awaited = named.filter((key) => !f.shipped.has(seqOfNamed(key)));
  if (awaited.length > 0) {
    return {
      blockerKind: 'master_or_peer',
      because: `it waits on ${awaited.join(', ')}, another issue's delivery not yet landed, which the master follows`,
    };
  }
  const person = f.waitingKind ? PERSON_OWES[f.waitingKind] : 'it waits on a person';
  return {
    blockerKind: 'human',
    because:
      named.length > 0
        ? `${person}; ${named.join(', ')} named in its needs already landed or ended, a reference, not a wait`
        : person,
  };
}
