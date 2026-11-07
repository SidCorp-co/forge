// Who a park's question is owed by, read from what the park waits on (ISS-1127). A park's question was
// opened as `human` whatever it waited on, so a park on a resource, or on another issue's delivery,
// landed in the owner's Needs you though no person owed an act: epod ISS-63, parked at
// `needs_resource` on forge ISS-1125's production monitor. Only an answer or a decision a person owes
// is `human`; a merge mark answers its own question (`machine`); a resource, or another issue named in
// what the park needs, is the project's master's to supply or to follow (`master_or_peer`), and the
// master's pass lists it (`questions/owed-to-agents.ts`).

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
}

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

/** Who owes the question a park mints, and why where it is not a person. */
export function parkOwedBy(f: ParkWaitFacts): {
  blockerKind: ParkBlockerKind;
  because: string | null;
} {
  if (f.awaitsMerge) return { blockerKind: 'machine', because: 'its own merge mark answers it' };
  if (f.waitingKind === 'needs_resource') {
    return {
      blockerKind: 'master_or_peer',
      because: 'it waits on a resource, which the master supplies or gets',
    };
  }
  const named = issuesNamedBy(f.needs ?? '', f.prefixes, f.ownSeq);
  if (named.length > 0) {
    return {
      blockerKind: 'master_or_peer',
      because: `it waits on ${named.join(', ')}, another issue's delivery, which the master follows`,
    };
  }
  return { blockerKind: 'human', because: null };
}
