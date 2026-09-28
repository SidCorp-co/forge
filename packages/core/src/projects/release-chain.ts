import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { type ReleaseCrossing, releaseCrossings } from '../db/release-axes.js';
import { projects } from '../db/schema.js';

/** One branch on a release path, and how the release crosses INTO it. The first entry crosses from
 *  nothing and carries no `from`; every entry after it declares one, and the last entry is live. */
export interface ReleaseChainEntry {
  branch: string;
  from?: ReleaseCrossing | undefined;
}

/** Ordered: first is where work merges, last is live. Empty means the project ships nothing. */
export type ReleaseChain = ReleaseChainEntry[];

export interface ReleaseChainGap {
  code: string;
  message: string;
}

export const RELEASE_CHAIN_FIRST_CROSSES_NOTHING = 'RELEASE_CHAIN_FIRST_CROSSES_NOTHING';
export const RELEASE_CHAIN_EDGE_UNDECLARED = 'RELEASE_CHAIN_EDGE_UNDECLARED';
export const RELEASE_CHAIN_BRANCH_REPEATED = 'RELEASE_CHAIN_BRANCH_REPEATED';
export const RELEASE_CHAIN_BASE_MISMATCH = 'RELEASE_CHAIN_BASE_MISMATCH';

/** The longest chain this accepts. Nothing needs more, and an unbounded list is a jsonb nobody reads. */
export const RELEASE_CHAIN_MAX = 8;

const branchSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._/-]+$/, 'a branch name, e.g. `main` or `release/stg`');

const entrySchema = z
  .object({ branch: branchSchema, from: z.enum(releaseCrossings).optional() })
  .strict();

function edgeIssues(chain: ReleaseChain, ctx: z.RefinementCtx): void {
  chain.forEach((entry, i) => {
    if (i === 0 && entry.from !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [0, 'from'],
        message: `${RELEASE_CHAIN_FIRST_CROSSES_NOTHING}: the first entry of a release chain is where work merges, so nothing crosses into it and it carries no \`from\`. Entry 0 names \`${entry.branch}\` and declares \`from: "${entry.from}"\`. Drop the \`from\`, or put \`${entry.branch}\` later in the chain.`,
      });
    }
    if (i > 0 && entry.from === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'from'],
        message: `${RELEASE_CHAIN_EDGE_UNDECLARED}: entry ${i} names \`${entry.branch}\` and does not say how the release crosses into it from \`${chain[i - 1]?.branch}\`. Declare \`from\`: ${releaseCrossings.join(' or ')}. It is not defaulted — a project releasing by a crossing nobody chose is the defect this field replaced.`,
      });
    }
  });
}

function repeatIssues(chain: ReleaseChain, ctx: z.RefinementCtx): void {
  const seen = new Map<string, number>();
  chain.forEach((entry, i) => {
    const first = seen.get(entry.branch);
    if (first === undefined) {
      seen.set(entry.branch, i);
      return;
    }
    ctx.addIssue({
      code: 'custom',
      path: [i, 'branch'],
      message: `${RELEASE_CHAIN_BRANCH_REPEATED}: \`${entry.branch}\` is entry ${first} and entry ${i} of the same chain, so the release would cross into a branch it has already left. Name a different branch, or shorten the chain.`,
    });
  });
}

export const releaseChainSchema = z
  .array(entrySchema)
  .max(RELEASE_CHAIN_MAX)
  .superRefine((chain, ctx) => {
    edgeIssues(chain, ctx);
    repeatIssues(chain, ctx);
  });

/** The one PATCH field this rule judges, declared beside it rather than in the route. */
export const releaseChainPatchFields = {
  releaseChain: releaseChainSchema.optional(),
} as const;

/** True where the project declares no release at all. */
export function chainShipsNothing(chain: ReleaseChain): boolean {
  return chain.length === 0;
}

/** True where a release crosses at least one edge before it deploys. */
export function chainPromotes(chain: ReleaseChain): boolean {
  return chain.length >= 2;
}

/** Where the last edge lands, or `null` where the chain crosses nothing. */
export function chainLiveBranch(chain: ReleaseChain): string | null {
  return chainPromotes(chain) ? (chain[chain.length - 1]?.branch ?? null) : null;
}

/** The branch a release starts from, or `null` where the project ships nothing. */
export function chainStartBranch(chain: ReleaseChain): string | null {
  return chain[0]?.branch ?? null;
}

/** True where ANY edge copies commits rather than moving a branch. One is enough: every commit
 *  below it has a new sha further down, so reaching live stops being readable from the branches. */
export function chainCrossesByCherryPick(chain: ReleaseChain): boolean {
  return chain.some((entry) => entry.from === 'cherry-pick');
}

/**
 * The three names the read API keeps answering, derived one way out of the chain: the expand half
 * of the amnesty ADR 0003 prices, ended by the forge-plugin issue closing. No write accepts them.
 */
export interface RetiredReleaseAxes {
  releaseModel: 'none' | 'promote' | 'publish';
  liveBranch: string | null;
  releaseStrategy: ReleaseCrossing | null;
}

export function retiredReleaseAxes(chain: ReleaseChain): RetiredReleaseAxes {
  if (chainShipsNothing(chain)) {
    return { releaseModel: 'none', liveBranch: null, releaseStrategy: null };
  }
  const last = chain[chain.length - 1];
  if (!chainPromotes(chain) || !last) {
    return { releaseModel: 'publish', liveBranch: null, releaseStrategy: null };
  }
  return { releaseModel: 'promote', liveBranch: last.branch, releaseStrategy: last.from ?? null };
}

/** A row carrying a chain, answered with the three retired names beside it. */
export function withRetiredReleaseAxes<T extends { releaseChain: ReleaseChain }>(
  row: T,
): T & RetiredReleaseAxes {
  return { ...row, ...retiredReleaseAxes(row.releaseChain) };
}

/**
 * The one door a chain and a base branch are written through. Two facts: 28 of 37 projects measured
 * on 2026-09-27 declare no release while carrying a base branch. A release starting on a branch
 * work never lands on carries no work, so THAT is refused here, and neither field moves the other.
 */
export function releaseChainGap(
  row: { baseBranch: string | null; releaseChain: ReleaseChain },
  updates: { baseBranch?: string | null | undefined; releaseChain?: ReleaseChain | undefined },
): ReleaseChainGap | null {
  const chain = updates.releaseChain ?? row.releaseChain;
  const base = 'baseBranch' in updates ? (updates.baseBranch ?? null) : row.baseBranch;
  const start = chainStartBranch(chain);
  if (start === null || start === base) return null;
  return {
    code: RELEASE_CHAIN_BASE_MISMATCH,
    message: `${RELEASE_CHAIN_BASE_MISMATCH}: this project's release chain starts at \`${start}\` and its base branch would be ${base === null ? '`null`' : `\`${base}\``}. A release starting on a branch that work never lands on cannot carry any work, so the two are not stored apart from each other by accident. Send \`baseBranch\` and \`releaseChain\` together, with the chain's first entry naming the same branch — \`baseBranch\` is where an ISS-* branch is cut from, the chain is where the release goes, and this is the one place they have to agree.`,
  };
}

/** The two PATCH keys the mismatch rule judges; a body naming neither is not its business. */
const RELEASE_CHAIN_KEYS = ['releaseChain', 'baseBranch'] as const;

/** `releaseChainGap` against the row as it WILL be: a PATCH may carry either key, or both. */
export async function releaseChainGapFor(
  projectId: string,
  updates: { baseBranch?: string | null | undefined; releaseChain?: ReleaseChain | undefined },
): Promise<ReleaseChainGap | null> {
  if (!RELEASE_CHAIN_KEYS.some((k) => k in updates)) return null;
  const [row] = await db
    .select({ baseBranch: projects.baseBranch, releaseChain: projects.releaseChain })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  return releaseChainGap(row, updates);
}

/** The three names a WRITE refuses: ADR 0003 prices the READ side alone, and a write taking
 *  `releaseModel` is a second way to say what the chain already says. */
export const RETIRED_RELEASE_AXIS_MESSAGE: Record<string, string> = {
  releaseModel:
    '`releaseModel` was retired by ISS-1311: a project\'s release shape is `releaseChain`, an ordered list of branches whose first entry is where work merges and whose last is live. `none` is `releaseChain: []`, `publish` with base B is `[{"branch":"B"}]`, and `promote` with base B, live L and strategy S is `[{"branch":"B"},{"branch":"L","from":"S"}]`. Send `releaseChain`. A read still answers `releaseModel` derived from the chain, and that derivation ends when the forge-plugin issue closes.',
  liveBranch:
    '`liveBranch` was retired by ISS-1311: where a release lands is the LAST entry of `releaseChain`, and the crossing into it is that entry\'s `from`. Send the whole chain — `[{"branch":"<base>"},{"branch":"<live>","from":"merge-branch"}]` — rather than one end of it. A read still answers `liveBranch` derived from the chain.',
  releaseStrategy:
    '`releaseStrategy` was retired by ISS-1311: a crossing is a fact about ONE edge and not about a project, so it is the `from` of the chain entry it crosses into. `tag-mr` is gone with it — it had no behaviour, no document and no project. Send `releaseChain`.',
};
