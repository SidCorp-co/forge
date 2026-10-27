/**
 * What a recorded landing says of its issues' verdicts (REQ-45 BC-14). The landing already happened,
 * so its verdicts never refuse the record (BC-11); they are read beside it instead. Each live
 * criterion stands on a pass at the recorded commit, on one at an earlier commit that commit holds,
 * on a runtime reading, on a pass the verified rule does not count (a builder's own), or on none.
 *
 * How a verdict counts is `landed-build.ts:weighOnLanded`'s, unchanged: a criterion counted there
 * reads as standing at the commit, and only what it does not count is placed further.
 */

import type { MergedHead } from '@forge/contracts/landing-artifacts';
import { verdictEarns } from '@forge/contracts/verdict-identity';
import { type StandingCriterion, standingCriteriaOf } from '../issues/index.js';
import { pairKey } from '../runners/index.js';
import type { JudgedBuildDeps } from './judged-build.js';
import { holdingPair, readHolding, weighOnLanded } from './landed-build.js';
import { ancestrySourceFor } from './shipped-earlier.js';

const WHOLE = /^[0-9a-f]{40}$/;
const short = (sha: string) => sha.slice(0, 12);

export type CoverageBasis = 'commit' | 'earlier' | 'runtime' | 'unverified' | 'none';

/** One live criterion placed against the recorded commit; `at` is the commit or runtime it stands on. */
export interface CriterionCoverage {
  criterion: number;
  basis: CoverageBasis;
  at: string | null;
  why: string | null;
}

type Placed = CriterionCoverage | { criterion: number; candidate: string };

function place(
  commit: string,
  c: StandingCriterion,
  head: MergedHead | null,
  judgedOn: string | null,
): Placed {
  const none = (why: string): CriterionCoverage => ({
    criterion: c.criterion,
    basis: 'none',
    at: null,
    why,
  });
  if (weighOnLanded(commit, c, null, head, judgedOn).counts) {
    return { criterion: c.criterion, basis: 'commit', at: commit, why: null };
  }
  const v = c.verdict;
  if (!v) return none('no verdict was recorded');
  if (!verdictEarns(v.verdict)) return none(`its verdict is \`${v.verdict}\``);
  if (v.unverified)
    return { criterion: c.criterion, basis: 'unverified', at: null, why: v.unverified };
  if (v.at?.kind === 'runtime') {
    return { criterion: c.criterion, basis: 'runtime', at: v.at.value, why: null };
  }
  const sha = v.at?.kind === 'source' ? v.at.value.trim().toLowerCase() : '';
  if (WHOLE.test(sha)) return { criterion: c.criterion, candidate: sha };
  return none(
    v.at
      ? `it was judged at ${v.at.kind} \`${v.at.value}\`, not at a commit`
      : 'it names nothing it was judged against',
  );
}

/** `c1, c2-4`: criterion numbers, consecutive runs folded. */
export function criteriaList(ns: readonly number[]): string {
  const sorted = [...new Set(ns)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j++;
    runs.push(i === j ? `c${sorted[i]}` : `c${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(', ');
}

/** How many commits `commit` adds after `from`, where a source host can list them; null otherwise. */
async function commitsAdded(
  projectId: string,
  from: string,
  commit: string,
): Promise<string | null> {
  try {
    const source = await ancestrySourceFor(projectId);
    if (source.kind !== 'host') return null;
    const range = await source.host.readRange(from, commit);
    if (!range.ok) return null;
    const n = range.commits.length;
    return `${range.complete ? '' : 'at least '}${n} commit${n === 1 ? '' : 's'}`;
  } catch {
    return null;
  }
}

/** The sentence one issue's coverage reads as, grouped by what each criterion stands on. */
function sentence(
  key: string,
  commit: string,
  owes: boolean,
  placed: readonly CriterionCoverage[],
  added: ReadonlyMap<string, string | null>,
): string {
  if (placed.length === 0) return `${key}: no live criteria`;
  const groups = new Map<string, number[]>();
  const add = (words: string, n: number) => groups.set(words, [...(groups.get(words) ?? []), n]);
  for (const p of placed) {
    if (p.basis === 'commit') add(`pass at \`${short(commit)}\``, p.criterion);
    else if (p.basis === 'earlier') {
      const at = p.at as string;
      const more = added.get(at);
      add(
        `pass at \`${short(at)}\`, which \`${short(commit)}\` holds${more ? ` (the recorded commit adds ${more})` : ''}`,
        p.criterion,
      );
    } else if (p.basis === 'runtime') add(`pass on runtime \`${p.at}\``, p.criterion);
    else if (p.basis === 'unverified')
      add(`only a pass the verified rule does not count: ${p.why}`, p.criterion);
    else add(`no pass: ${p.why}`, p.criterion);
  }
  const owed = owes ? '' : "the project's document says its issues owe no verdict; ";
  const parts = [...groups].map(([words, ns]) => `${criteriaList(ns)} ${words}`);
  return `${key}: ${owed}${placed.length} live criteria, ${parts.join('; ')}`;
}

/**
 * Each issue's live criteria placed against `commit`, and the reading each issue's line is. Reads
 * ancestry through the project's reader; a pair nobody could read is said, never guessed.
 */
export async function landingCoverage(
  projectId: string,
  issueIds: readonly string[],
  commit: string,
  shown: ReadonlyMap<string, string>,
  headOf: (issueId: string) => MergedHead | null,
  deps?: Pick<JudgedBuildDeps, 'ancestry'>,
): Promise<{ readings: string[]; coverage: Map<string, CriterionCoverage[]> }> {
  const standing = await standingCriteriaOf(issueIds);
  const placedOf = new Map<string, Placed[]>();
  for (const id of issueIds) {
    const s = standing.get(id);
    if (!s) continue;
    placedOf.set(
      id,
      s.criteria.map((c) => place(commit, c, headOf(id), s.judgedOn)),
    );
  }
  const candidates = [
    ...new Set(
      [...placedOf.values()].flat().flatMap((p) => ('candidate' in p ? [p.candidate] : [])),
    ),
  ];
  const held = await readHolding(
    projectId,
    candidates.map((sha) => holdingPair(sha, commit)),
    deps,
  );
  const coverage = new Map<string, CriterionCoverage[]>();
  for (const [id, placed] of placedOf) {
    coverage.set(
      id,
      placed.map((p): CriterionCoverage => {
        if (!('candidate' in p)) return p;
        const answer = held.get(pairKey(holdingPair(p.candidate, commit)));
        if (answer === true)
          return { criterion: p.criterion, basis: 'earlier', at: p.candidate, why: null };
        const why =
          answer === false
            ? `it was judged at \`${short(p.candidate)}\`, which \`${short(commit)}\` does not hold`
            : `it was judged at \`${short(p.candidate)}\`, and whether \`${short(commit)}\` holds it was not read: ${answer?.unread ?? 'it was not asked'}`;
        return { criterion: p.criterion, basis: 'none', at: null, why };
      }),
    );
  }
  const earlier = [
    ...new Set(
      [...coverage.values()].flat().flatMap((c) => (c.basis === 'earlier' && c.at ? [c.at] : [])),
    ),
  ];
  const added = new Map(
    await Promise.all(
      earlier.map(async (sha) => [sha, await commitsAdded(projectId, sha, commit)] as const),
    ),
  );
  const readings = issueIds.flatMap((id) => {
    const placed = coverage.get(id);
    if (!placed) return [];
    return [sentence(shown.get(id) ?? id, commit, standing.get(id)?.owes ?? true, placed, added)];
  });
  return { readings, coverage };
}
