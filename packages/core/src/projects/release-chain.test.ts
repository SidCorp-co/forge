/**
 * ISS-1311 / ADR 0003 — the chain's own rule, away from HTTP and away from Postgres.
 *
 * Two things are proved here and nowhere else: the shapes the schema REFUSES, each planted with the
 * one value it exists to refuse and read back by its own code rather than by "it threw"; and the
 * projection that keeps `releaseModel`, `liveBranch` and `releaseStrategy` answerable on the way
 * out. The database holds the same shape rule itself — `projects_release_chain_chk`, exercised in
 * `tests/integration/release-chain-constraints-e2e.test.ts` — because a zod schema is a TypeScript
 * annotation the database never sees and raw SQL writes this table in several places.
 */

import { describe, expect, it } from 'vitest';
import {
  chainCrossesByCherryPick,
  chainLiveBranch,
  chainPromotes,
  chainShipsNothing,
  chainStartBranch,
  RELEASE_CHAIN_BASE_MISMATCH,
  RELEASE_CHAIN_BRANCH_REPEATED,
  RELEASE_CHAIN_EDGE_UNDECLARED,
  RELEASE_CHAIN_FIRST_CROSSES_NOTHING,
  RELEASE_CHAIN_MAX,
  type ReleaseChain,
  releaseChainGap,
  releaseChainSchema,
  retiredReleaseAxes,
  withRetiredReleaseAxes,
} from './release-chain.js';

/** The refusal codes a parse answered with, so a case names its rule rather than "it failed". */
function codes(value: unknown): string[] {
  const out = releaseChainSchema.safeParse(value);
  if (out.success) return [];
  return out.error.issues.map((i) => i.message.split(':')[0] ?? '');
}

const SHIPS_NOTHING: ReleaseChain = [];
const PUBLISHES: ReleaseChain = [{ branch: 'main' }];
const PROMOTES: ReleaseChain = [{ branch: 'dev' }, { branch: 'main', from: 'merge-branch' }];

describe('releaseChainSchema — the shapes it refuses by name', () => {
  it('accepts an empty chain, which is a declaration and not an absence', () => {
    expect(releaseChainSchema.safeParse(SHIPS_NOTHING).success).toBe(true);
  });

  it('accepts a chain of one, which crosses nothing and so carries no `from`', () => {
    expect(releaseChainSchema.safeParse(PUBLISHES).success).toBe(true);
  });

  it('accepts a chain of three, which the enum it replaced could not express at all', () => {
    const three = [
      { branch: 'dev' },
      { branch: 'stg', from: 'merge-branch' },
      { branch: 'main', from: 'cherry-pick' },
    ];
    expect(releaseChainSchema.safeParse(three).success).toBe(true);
  });

  it('refuses a first entry that declares a crossing, since nothing crosses into it', () => {
    expect(codes([{ branch: 'main', from: 'merge-branch' }])).toContain(
      RELEASE_CHAIN_FIRST_CROSSES_NOTHING,
    );
  });

  // The `releaseModelGap` this replaced wrote `merge-branch` into a promote project that named no
  // strategy, so a project could release by a crossing nobody chose. The same input is refused.
  it('refuses an entry after the first that declares no crossing, rather than defaulting it', () => {
    expect(codes([{ branch: 'dev' }, { branch: 'main' }])).toContain(RELEASE_CHAIN_EDGE_UNDECLARED);
  });

  it('names the branch it would have crossed FROM, so the reader sees the edge', () => {
    const out = releaseChainSchema.safeParse([{ branch: 'dev' }, { branch: 'main' }]);
    expect(out.success).toBe(false);
    expect(out.success === false && out.error.issues[0]?.message).toContain('`dev`');
  });

  it('refuses a branch named twice, since the release would re-enter a branch it left', () => {
    expect(codes([{ branch: 'main' }, { branch: 'main', from: 'merge-branch' }])).toContain(
      RELEASE_CHAIN_BRANCH_REPEATED,
    );
  });

  it('refuses a repeat that is not adjacent, which a pairwise check would miss', () => {
    const codesOut = codes([
      { branch: 'dev' },
      { branch: 'stg', from: 'merge-branch' },
      { branch: 'dev', from: 'merge-branch' },
    ]);
    expect(codesOut).toContain(RELEASE_CHAIN_BRANCH_REPEATED);
  });

  // ISS-1311 removed `tag-mr`: no behaviour, no document, no project. It is refused rather than
  // mapped, here as in the migration.
  it('refuses `tag-mr`, which is not a crossing any more', () => {
    expect(
      releaseChainSchema.safeParse([{ branch: 'dev' }, { branch: 'main', from: 'tag-mr' }]).success,
    ).toBe(false);
  });

  // The same value Postgres takes a separate clause to refuse: a present key whose value is not a
  // crossing is not the same thing as an absent one, on either side of the wire.
  it('refuses a crossing declared as null, which is a key and not an absence', () => {
    expect(
      releaseChainSchema.safeParse([{ branch: 'dev' }, { branch: 'main', from: null }]).success,
    ).toBe(false);
    expect(releaseChainSchema.safeParse([{ branch: 'main', from: null }]).success).toBe(false);
  });

  it('refuses a key the entry does not declare, rather than dropping it in silence', () => {
    const out = releaseChainSchema.safeParse([{ branch: 'main', strategy: 'merge-branch' }]);
    expect(out.success).toBe(false);
  });

  it('refuses an empty branch name and a branch name that is not a ref', () => {
    expect(releaseChainSchema.safeParse([{ branch: '' }]).success).toBe(false);
    expect(releaseChainSchema.safeParse([{ branch: 'has space' }]).success).toBe(false);
  });

  it(`accepts a chain of exactly ${RELEASE_CHAIN_MAX} and refuses one longer`, () => {
    const at = Array.from({ length: RELEASE_CHAIN_MAX }, (_, i) =>
      i === 0 ? { branch: `b${i}` } : { branch: `b${i}`, from: 'merge-branch' as const },
    );
    expect(releaseChainSchema.safeParse(at).success).toBe(true);
    expect(
      releaseChainSchema.safeParse([...at, { branch: 'one-too-many', from: 'merge-branch' }])
        .success,
    ).toBe(false);
  });
});

describe('what core reads off a chain instead of an enum', () => {
  it('reads "ships nothing" from an empty chain and from nothing else', () => {
    expect(chainShipsNothing(SHIPS_NOTHING)).toBe(true);
    expect(chainShipsNothing(PUBLISHES)).toBe(false);
    expect(chainShipsNothing(PROMOTES)).toBe(false);
  });

  it('reads "crosses a branch" from a chain of two or more', () => {
    expect(chainPromotes(SHIPS_NOTHING)).toBe(false);
    expect(chainPromotes(PUBLISHES)).toBe(false);
    expect(chainPromotes(PROMOTES)).toBe(true);
  });

  it('reads the live branch as the LAST entry, and null where nothing is crossed', () => {
    expect(chainLiveBranch(SHIPS_NOTHING)).toBeNull();
    expect(chainLiveBranch(PUBLISHES)).toBeNull();
    expect(chainLiveBranch(PROMOTES)).toBe('main');
    expect(
      chainLiveBranch([
        { branch: 'dev' },
        { branch: 'stg', from: 'merge-branch' },
        { branch: 'live', from: 'merge-branch' },
      ]),
    ).toBe('live');
  });

  it('reads where a release starts as the first entry', () => {
    expect(chainStartBranch(SHIPS_NOTHING)).toBeNull();
    expect(chainStartBranch(PROMOTES)).toBe('dev');
  });

  // One cherry-pick anywhere gives every commit below it a new sha, so a later merge-branch edge
  // does not restore the ancestry the reading needs. The enum carried one strategy per project and
  // could not express the case this covers.
  it('reads "crosses by cherry-pick" from ANY edge, not only the last', () => {
    expect(chainCrossesByCherryPick(PROMOTES)).toBe(false);
    expect(
      chainCrossesByCherryPick([
        { branch: 'dev' },
        { branch: 'stg', from: 'cherry-pick' },
        { branch: 'main', from: 'merge-branch' },
      ]),
    ).toBe(true);
  });
});

describe('retiredReleaseAxes — the one-way projection with an expiry', () => {
  it('answers `none` and no branch for an empty chain', () => {
    expect(retiredReleaseAxes(SHIPS_NOTHING)).toEqual({
      releaseModel: 'none',
      liveBranch: null,
      releaseStrategy: null,
    });
  });

  it('answers `publish` and no branch for a chain of one, as the enum did', () => {
    expect(retiredReleaseAxes(PUBLISHES)).toEqual({
      releaseModel: 'publish',
      liveBranch: null,
      releaseStrategy: null,
    });
  });

  it('answers `promote` with the last branch and the last crossing', () => {
    expect(retiredReleaseAxes(PROMOTES)).toEqual({
      releaseModel: 'promote',
      liveBranch: 'main',
      releaseStrategy: 'merge-branch',
    });
  });

  it('answers the LAST crossing of a long chain, which is the one that reaches live', () => {
    expect(
      retiredReleaseAxes([
        { branch: 'dev' },
        { branch: 'stg', from: 'merge-branch' },
        { branch: 'live', from: 'cherry-pick' },
      ]),
    ).toMatchObject({
      releaseModel: 'promote',
      liveBranch: 'live',
      releaseStrategy: 'cherry-pick',
    });
  });

  it('puts the three beside the chain on a row without displacing anything else', () => {
    expect(withRetiredReleaseAxes({ id: 'p1', releaseChain: PROMOTES })).toEqual({
      id: 'p1',
      releaseChain: PROMOTES,
      releaseModel: 'promote',
      liveBranch: 'main',
      releaseStrategy: 'merge-branch',
    });
  });
});

/**
 * `base_branch` is the work branch and the chain is the release path: two facts, not one. The only
 * place they have to agree is a release's first step, and that is refused HERE rather than held by
 * a CHECK — a constraint whose whole job is keeping two columns in step is the shape of defect ADR
 * 0003 removes.
 */
describe('releaseChainGap — where a work branch and a release path have to agree', () => {
  const stored = { baseBranch: 'main', releaseChain: PUBLISHES };

  it('passes a patch that names neither', () => {
    expect(releaseChainGap(stored, {})).toBeNull();
  });

  it('passes a base branch moving on a project whose chain is empty', () => {
    expect(
      releaseChainGap({ baseBranch: 'main', releaseChain: [] }, { baseBranch: 'dev' }),
    ).toBeNull();
  });

  it('refuses a base branch that would leave the stored chain starting elsewhere', () => {
    const gap = releaseChainGap(stored, { baseBranch: 'dev' });
    expect(gap?.code).toBe(RELEASE_CHAIN_BASE_MISMATCH);
    expect(gap?.message).toContain('`main`');
    expect(gap?.message).toContain('`dev`');
  });

  it('refuses a chain that would start somewhere the stored base branch is not', () => {
    const gap = releaseChainGap(stored, { releaseChain: [{ branch: 'dev' }] });
    expect(gap?.code).toBe(RELEASE_CHAIN_BASE_MISMATCH);
  });

  it('passes the two sent together and agreeing, which is how a work branch moves', () => {
    expect(
      releaseChainGap(stored, { baseBranch: 'dev', releaseChain: [{ branch: 'dev' }] }),
    ).toBeNull();
  });

  it('refuses the two sent together and disagreeing, rather than letting one win', () => {
    const gap = releaseChainGap(stored, {
      baseBranch: 'dev',
      releaseChain: [{ branch: 'trunk' }],
    });
    expect(gap?.code).toBe(RELEASE_CHAIN_BASE_MISMATCH);
    expect(gap?.message).toContain('`trunk`');
  });

  it('refuses a chain declared against a null base branch, naming the null', () => {
    const gap = releaseChainGap(
      { baseBranch: null, releaseChain: [] },
      { releaseChain: [{ branch: 'main' }] },
    );
    expect(gap?.code).toBe(RELEASE_CHAIN_BASE_MISMATCH);
    expect(gap?.message).toContain('`null`');
  });

  it('passes an empty chain replacing a declared one, which parts from nothing', () => {
    expect(releaseChainGap(stored, { releaseChain: [] })).toBeNull();
  });
});
