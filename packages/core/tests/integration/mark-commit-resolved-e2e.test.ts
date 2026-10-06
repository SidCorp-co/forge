/**
 * ISS-1350 — on a git project every commit a merge mark records is one the project's repository
 * holds, resolved there to its full sha, whoever marks it and whatever evidence the issue carries;
 * against a real Postgres and the repository stand-in in `tests/helpers/commit-landing-fixture.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  FABRICATED,
  OWN,
  refusal,
  repo,
  useCommitLandingWorld,
} from '../helpers/commit-landing-fixture.js';

vi.mock('../../src/issues/merge-record.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeMergeRecord(await importOriginal()),
);
vi.mock('../../src/integrations/github/client.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeGitHubClient(await importOriginal()),
);

const { seed, mark, row, comments, handoff } = useCommitLandingWorld();

/** sid-desk ISS-578's mark: a real commit's first eight characters, then a tail no commit has. */
const ISS_578_PAIR = `${OWN.slice(0, 8)}0e1cf5dadf2b1b3be9ba1b81c5e9cb40`;

describe("ISS-1350 — every git mark's commit is one the repository holds (real Postgres)", () => {
  it.each([
    ['a person, on an issue with no branch', 'human', {}],
    ['a person, on an issue with a branch', 'human', { branch: 'ISS-1350-x' }],
    ['an agent, on an issue with a branch', 'agent', { branch: 'ISS-1350-x' }],
  ] as const)(
    'refuses the ISS-578 pair marked by %s, naming it and the repository, and writes nothing (criteria 1, 2)',
    async (_who, agency, sessionContext) => {
      const issue = await seed({ sessionContext });
      const refused = await refusal(() => mark(issue, ISS_578_PAIR, agency));
      expect(refused.code).toBe('COMMIT_NOT_IN_REPOSITORY');
      expect(refused.message).toContain(
        `GitHub finds no commit ${ISS_578_PAIR} in ${repo.fullName}`,
      );
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
      expect(await comments(issue.id)).toEqual([]);
    },
  );

  it('refuses a commit the repository lacks beside a merged pull request, rather than keeping it as an overruled claim (criterion 3)', async () => {
    repo.pullRequest = {
      commitSha: '0123456789abcdef0123456789abcdef01234567',
      mergedAt: new Date('2026-09-30T08:00:00Z'),
    };
    const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
    const refused = await refusal(() => mark(issue, FABRICATED, 'human'));
    expect(refused.code).toBe('COMMIT_NOT_IN_REPOSITORY');
    expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
  });

  it('does not re-read a commit that is the merged pull request it stands beside', async () => {
    const pr = '0123456789abcdef0123456789abcdef01234567';
    repo.pullRequest = { commitSha: pr, mergedAt: new Date('2026-09-30T08:00:00Z') };
    const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
    const res = await mark(issue, pr.toUpperCase(), 'human');
    expect(res.mark).toBe('observed');
    expect(repo.reads).toEqual([]);
  });

  it.each([
    ['no_binding', 'no active GitHub binding'],
    ['read', 'HTTP 502'],
    ['mint', 'minting an installation token: HTTP 404'],
  ] as const)(
    "refuses a person's mark COMMIT_UNVERIFIED when the repository cannot be read (%s) (criterion 4)",
    async (down, says) => {
      repo.down = down;
      const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
      const refused = await refusal(() => mark(issue, OWN, 'human'));
      expect(refused.code).toBe('COMMIT_UNVERIFIED');
      expect(refused.message).toContain(says);
      expect(refused.message).toContain('not recorded naming it unchecked');
      expect(refused.message).toContain(
        'mark it naming no commit, which records a claim that names none',
      );
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
    },
  );

  it('records an abbreviated commit by the full sha the repository resolves, in the answer and the audit comment (criterion 5)', async () => {
    const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
    const short = OWN.slice(0, 9);
    const res = await mark(issue, short, 'human');
    expect(res.markDetail).toContain(`commit ${OWN} is recorded here as this call's claim`);
    const audit = (await comments(issue.id)).at(-1) ?? '';
    expect(audit).toContain(`commit=${OWN}`);
    expect(audit).not.toContain(`commit=${short} `);
  });

  it("keeps a person's resolved commit a claim, and says the repository holds it (criteria 6, 7)", async () => {
    const issue = await seed({ sessionContext: {} });
    const res = await mark(issue, OWN, 'human');
    expect(res.mark).toBe('asserted');
    expect((await row(issue.id)).merged_commit_sha).toBeNull();
    expect(res.markDetail).toContain(`${repo.fullName} holds commit ${OWN}`);
  });

  it.each([
    [
      'the repository does not hold it',
      null,
      FABRICATED,
      'SidCorp-co/specimen does not resolve it',
    ],
    ['the repository cannot be read', 'read', OWN, 'the repository could not be read'],
  ] as const)(
    'leaves out a handoff commit when %s, and says which and why (criterion 8)',
    async (_case, down, recorded, why) => {
      const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
      await handoff(issue.id, recorded);
      repo.down = down;
      const res = await mark(issue, undefined, 'human');
      expect(res.mark).toBe('asserted');
      expect(res.markDetail).toContain('no commit is recorded in `merged_commit_sha`');
      expect(res.markDetail).toContain(
        `commit ${recorded} this issue's implementation handoff recorded`,
      );
      expect(res.markDetail).toContain(why);
      const audit = (await comments(issue.id)).at(-1) ?? '';
      expect(audit).not.toContain(`commit=${recorded}`);
      expect(audit).toContain(why);
    },
  );

  it('records a handoff commit the repository holds by its full sha (criterion 9)', async () => {
    const issue = await seed({ sessionContext: { branch: 'ISS-1350-x' } });
    await handoff(issue.id, OWN.slice(0, 10));
    const res = await mark(issue, undefined, 'human');
    expect(res.markDetail).toContain(`commit ${OWN} is recorded here as this call's claim`);
    expect((await comments(issue.id)).at(-1)).toContain(`commit=${OWN}`);
  });

  it('reads nothing from the repository on an outside_git project (criterion 10)', async () => {
    const issue = await seed({ kind: 'website', sessionContext: { branch: 'ISS-1350-x' } });
    await mark(issue, ISS_578_PAIR, 'human', { landing: 'https://shop.example/p/1350' });
    expect(repo.reads).toEqual([]);
  });
});
