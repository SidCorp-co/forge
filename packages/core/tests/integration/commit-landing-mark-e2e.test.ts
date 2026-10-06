/**
 * ISS-1318 — an agent whose change landed on the base branch itself marks it merged with the
 * commit it landed at, and advances, against a real Postgres and a stand-in for the project's
 * repository (`tests/helpers/commit-landing-fixture.ts`).
 */

import { describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  FABRICATED,
  FOREIGN,
  OFF_BASE,
  ON_LIVE,
  OWN,
  refusal,
  repo,
  SEQ,
  UNDECLARED,
  useCommitLandingWorld,
} from '../helpers/commit-landing-fixture.js';

vi.mock('../../src/issues/merge-record.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeMergeRecord(await importOriginal()),
);
vi.mock('../../src/integrations/github/client.js', async (importOriginal) =>
  (await import('../helpers/commit-landing-fixture.js')).fakeGitHubClient(await importOriginal()),
);

const { seed, mark, advance, row, comments, withLiveBranch, declareWorkEvidence, setBaseBranch } =
  useCommitLandingWorld();

describe('ISS-1318 — a base-branch landing marked by its commit (real Postgres)', () => {
  it('accepts the commit, stores it observed, and lets the issue reach developed then testing (criteria 1-3)', async () => {
    const issue = await seed();

    const res = await mark(issue, OWN);

    expect(res.action).toBe('merged');
    expect(res.mark).toBe('observed');
    expect(res.markDetail).toContain(`read from ${repo.fullName} itself`);
    expect(res.markDetail).not.toContain('pull request');
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
    expect((await comments(issue.id)).at(-1)).toContain(`read from ${repo.fullName} itself`);

    await advance(issue.id, 'in_progress', 'developed');
    await advance(issue.id, 'developed', 'testing');
    expect((await row(issue.id)).status).toBe('testing');
  });

  it('resolves an abbreviated commit to the full sha the repository holds (criterion 9)', async () => {
    const issue = await seed();
    await mark(issue, OWN.slice(0, 9));
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
  });

  it('accepts a commit the live branch holds and the base does not (criterion 1)', async () => {
    await withLiveBranch();
    const issue = await seed();
    const res = await mark(issue, ON_LIVE);
    expect(res.mark).toBe('observed');
    expect(res.markDetail).toContain('on production');
  });

  it.each([
    [
      'COMMIT_NOT_IN_REPOSITORY',
      FABRICATED,
      [`GitHub finds no commit ${FABRICATED} in SidCorp-co/specimen`],
    ],
    [
      'COMMIT_NOT_THIS_ISSUE',
      FOREIGN,
      [FOREIGN, '"fix(core): something else (ISS-1316)"', `does not declare ISS-${SEQ}`],
    ],
    ['COMMIT_NOT_THIS_ISSUE', UNDECLARED, [UNDECLARED, `"chore: tidy, see ISS-${SEQ}"`]],
    ['COMMIT_NOT_LANDED', OFF_BASE, [OFF_BASE, 'main does not contain it']],
  ] as const)(
    'refuses %s for %s, naming it, and writes nothing (criteria 4-6, 8)',
    async (code, commit, says) => {
      const issue = await seed();
      const before = await comments(issue.id);

      const refused = await refusal(() => mark(issue, commit));

      expect(refused.code).toBe(code);
      for (const s of says) expect(refused.message).toContain(s);
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
      expect(await comments(issue.id)).toEqual(before);
      const blocked = await refusal(() => advance(issue.id, 'in_progress', 'developed'));
      expect(blocked.code).toBe('NO_WORK_EVIDENCE');
    },
  );

  it.each([
    ['no_binding', 'no active GitHub binding'],
    ['read', 'HTTP 502'],
    ['mint', 'minting an installation token: HTTP 404'],
  ] as const)(
    'refuses COMMIT_UNVERIFIED when the repository cannot be read (%s) (criteria 7, 8)',
    async (down, says) => {
      repo.down = down;
      const issue = await seed();
      const refused = await refusal(() => mark(issue, OWN));
      expect(refused.code).toBe('COMMIT_UNVERIFIED');
      expect(refused.message).toContain(says);
      expect(refused.message).toContain('not taken as evidence unchecked');
      expect(refused.message).toContain(
        "Two routes clear it: mark again once the tracker can read the project's repository, through a GitHub binding whose installation can read it; or have a person mark it merged naming no commit and move it through `developed` and `testing`",
      );
      expect(refused.message).toContain("a branch recorded under the base branch's name");
      expect(refused.message).not.toContain('record the branch the work was done on');
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
    },
  );

  it('still refuses NO_WORK_EVIDENCE, naming the commit route, for a mark with no commit (criteria 10, 12)', async () => {
    const issue = await seed({ sessionContext: { branch: 'main' } });
    const refused = await refusal(() => mark(issue, undefined));
    expect(refused.code).toBe('NO_WORK_EVIDENCE');
    expect(refused.message).toContain('`mark_merged` carrying `data.commit`');
    expect(repo.reads).toEqual([]);
  });

  it('resolves the commit and keeps it a claim, not held to the landing check, where the issue already has a branch (criterion 13; ISS-1350)', async () => {
    const issue = await seed({ sessionContext: { branch: 'ISS-1318-mark-landed-base' } });
    const res = await mark(issue, FOREIGN);
    expect(res.mark).toBe('asserted');
    expect(res.markDetail).toContain(`commit ${FOREIGN} is recorded here as this call's claim`);
    expect((await row(issue.id)).merged_commit_sha).toBeNull();
    expect(repo.reads).toEqual([`/repos/${repo.fullName}/commits/${FOREIGN}`]);
  });

  it("reads only the commit for a human's mark, with or without evidence (criterion 14; ISS-1350)", async () => {
    const bare = await seed({ sessionContext: {} });
    expect((await mark(bare, FOREIGN, 'human')).mark).toBe('asserted');
    const branched = await seed({ sessionContext: { branch: 'ISS-1319-x' }, seq: SEQ + 1 });
    const res = await mark(branched, OFF_BASE, 'human');
    expect(res.action).toBe('merged');
    expect(res.mark).toBe('asserted');
    expect(repo.reads).toEqual([
      `/repos/${repo.fullName}/commits/${FOREIGN}`,
      `/repos/${repo.fullName}/commits/${OFF_BASE}`,
    ]);
  });

  it("names a pull request's merge as its own, not the repository commit this call checked", async () => {
    const pr = '0123456789abcdef0123456789abcdef01234567';
    repo.pullRequest = { commitSha: pr, mergedAt: new Date('2026-09-30T08:00:00Z') };
    const issue = await seed();
    const res = await mark(issue, OWN);
    expect((await row(issue.id)).merged_commit_sha).toBe(pr);
    expect(res.markDetail).not.toContain(`read from ${repo.fullName} itself`);
    expect((await comments(issue.id)).at(-1)).not.toContain(`read from ${repo.fullName} itself`);
  });

  it('takes no commit route on an outside_git project (criterion 15)', async () => {
    const issue = await seed({ kind: 'website' });
    const refused = await refusal(() => mark(issue, OWN));
    expect(refused.code).toBe('NO_WORK_EVIDENCE');
    expect(refused.message).toContain("This project's work lands outside git");
    expect(refused.message).toContain('a person may mark it merged');
    expect(refused.message).not.toContain('`mark_merged` carrying `data.commit`');
    expect(repo.reads).toEqual([]);
  });
});

describe('ISS-1318 — the live branch and an abbreviated sha, named for what they are (real Postgres)', () => {
  it.each([
    ['nothing starts with', 'f6071829'],
    ['two commits start with', OWN.slice(0, 7)],
  ] as const)(
    'refuses an abbreviated commit %s it as unresolved, never as absent (criterion 4)',
    async (_case, short) => {
      const issue = await seed();
      const refused = await refusal(() => mark(issue, short));
      expect(refused.code).toBe('COMMIT_NOT_IN_REPOSITORY');
      expect(refused.message).toContain(
        `GitHub resolves no single commit from ${short} in SidCorp-co/specimen`,
      );
      expect(refused.message).toContain('or more than one does');
      expect(refused.message).toContain('the full 40-character sha');
      expect(refused.message).not.toContain('finds no commit');
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
    },
  );

  it.each([
    ['sessionContext.branch', { branch: 'production' }],
    ['sessionContext.worklog.branch', { worklog: { branch: 'production' } }],
  ])(
    'still refuses NO_WORK_EVIDENCE for a mark with no commit when %s names only the live branch (criterion 10)',
    async (_where, sessionContext) => {
      await withLiveBranch();
      const issue = await seed({ sessionContext });
      const refused = await refusal(() => mark(issue, undefined));
      expect(refused.code).toBe('NO_WORK_EVIDENCE');
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
      expect(repo.reads).toEqual([]);
    },
  );

  it('still refuses developed and testing with only the live branch recorded and no merged commit (criterion 11)', async () => {
    await withLiveBranch();
    const live = { worklog: { branch: 'production' } };
    const issue = await seed({ sessionContext: live });
    expect((await refusal(() => advance(issue.id, 'in_progress', 'developed'))).code).toBe(
      'NO_WORK_EVIDENCE',
    );
    const atDeveloped = await seed({ status: 'developed', seq: SEQ + 1, sessionContext: live });
    expect((await refusal(() => advance(atDeveloped.id, 'developed', 'testing'))).code).toBe(
      'NO_WORK_EVIDENCE',
    );
  });

  it('still refuses developed and testing with the base branch recorded and no merged commit (criterion 11)', async () => {
    const issue = await seed();
    expect((await refusal(() => advance(issue.id, 'in_progress', 'developed'))).code).toBe(
      'NO_WORK_EVIDENCE',
    );
    const atDeveloped = await seed({ status: 'developed', seq: SEQ + 1 });
    expect((await refusal(() => advance(atDeveloped.id, 'developed', 'testing'))).code).toBe(
      'NO_WORK_EVIDENCE',
    );
  });
});

describe('ISS-1318 r3 — each refusal names a route its reader can take (real Postgres)', () => {
  it('asks for a base branch, and a person, where the project names none', async () => {
    await setBaseBranch(null);
    // With no base branch to discard, a recorded `main` would itself count, so none is recorded.
    const issue = await seed({ sessionContext: {} });
    const refused = await refusal(() => mark(issue, OWN));
    expect(refused.code).toBe('COMMIT_UNVERIFIED');
    expect(refused.message).toContain('the project names no base branch to look for it on');
    expect(refused.message).toContain(
      'Two routes clear it: mark again once the project names its base branch; or have a person mark it merged naming no commit and move it',
    );
    expect(repo.reads).toEqual([]);
  });

  it("clears the agent's gate once a person marks it merged and moves it, as COMMIT_UNVERIFIED says", async () => {
    repo.down = 'no_binding';
    const issue = await seed();
    expect((await refusal(() => mark(issue, OWN))).code).toBe('COMMIT_UNVERIFIED');
    await mark(issue, undefined, 'human');
    expect((await refusal(() => advance(issue.id, 'in_progress', 'developed'))).code).toBe(
      'NO_WORK_EVIDENCE',
    );
    await advance(issue.id, 'in_progress', 'developed', 'human');
    await advance(issue.id, 'developed', 'testing', 'human');
    expect((await row(issue.id)).status).toBe('testing');
  });

  it("tells a person held by the declared work_evidence criterion that a person's mark does not clear it (git)", async () => {
    await declareWorkEvidence();
    const issue = await seed();
    await mark(issue, OWN, 'human');
    const refused = await refusal(() => advance(issue.id, 'in_progress', 'developed', 'human'));
    expect(refused.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(refused.message).toContain(
      "a person's mark naming a commit is checked only for the repository holding it, not read as this issue's landing, so it does not clear this",
    );
    expect(refused.message).toContain('`statusEntryCriteria`');
    expect(refused.message).not.toContain('the commit it landed at, which Forge checks');
  });

  it('never tells a person held by the declared work_evidence criterion that it does not hold them (website)', async () => {
    await declareWorkEvidence();
    const issue = await seed({ kind: 'website' });
    await mark(issue, undefined, 'human', { landing: 'https://shop.example/p/1318' });
    const refused = await refusal(() => advance(issue.id, 'in_progress', 'developed', 'human'));
    expect(refused.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(refused.message).not.toContain('does not hold them to');
    expect(refused.message).toContain('a landing it names is not evidence');
    expect(refused.message).toContain('`statusEntryCriteria`');
  });

  it.each(['agent', 'human'] as const)(
    "refuses a %s's mark by name on a project whose kind Forge does not know, writing nothing",
    async (agency) => {
      const issue = await seed({ kind: 'kiosk' });
      const refused = await refusal(() => mark(issue, OWN, agency));
      expect(refused.code).toBe('PROJECT_KIND_UNKNOWN');
      expect(refused.message).toContain('kind `kiosk` is not one of `standard`, `website`');
      expect(refused.message).toContain('`kind` on `PATCH /api/projects/:id`');
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
      expect(repo.reads).toEqual([]);
    },
  );
});
