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
    expect(res.markDetail).toContain(`, on main of ${repo.fullName}.`);
    expect(res.markDetail).not.toContain('pull request');
    expect((await row(issue.id)).merged_commit_sha).toBe(OWN);
    expect((await comments(issue.id)).at(-1)).toContain(`, on main of ${repo.fullName}.`);

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
      [`The repository SidCorp-co/specimen holds no commit ${FABRICATED}.`],
    ],
    [
      'COMMIT_NOT_THIS_ISSUE',
      FOREIGN,
      [FOREIGN.slice(0, 7), '\n> fix(core): something else (ISS-1316)', `does not name ISS-${SEQ}`],
    ],
    [
      'COMMIT_NOT_THIS_ISSUE',
      UNDECLARED,
      [UNDECLARED.slice(0, 7), `\n> chore: tidy, see ISS-${SEQ}`],
    ],
    ['COMMIT_NOT_LANDED', OFF_BASE, [OFF_BASE.slice(0, 7), 'main does not contain it']],
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

  // A reader that is configured and fails leaves the agent's commit as a claim that names the cause
  // (ISS-1409's ruling of 2026-10-08); a person's mark naming a commit is still refused.
  it.each([
    ['read', 'HTTP 502'],
    ['mint', 'Minting an installation token: HTTP 404.'],
  ] as const)(
    'records an unverified claim naming the cause and its fix when the repository cannot be read (%s) (criteria 7, 8)',
    async (down, says) => {
      repo.down = down;
      const issue = await seed();
      const res = await mark(issue, OWN);
      expect(res.action).toBe('merged');
      expect(res.mark).toBe('asserted');
      // ISS-1421 r8: three short sentences of ours, the host's reason quoted on its own line.
      expect(res.markDetail).toMatch(
        new RegExp(
          `^Commit ${OWN.slice(0, 7)} was named and is kept as a claim\\. Forge could not check it against the repository\\. Mark it again once Forge can read the repository\\.\\n> `,
        ),
      );
      expect(res.markDetail).toContain(says);
      expect(await row(issue.id)).toMatchObject({ merged_commit_sha: null });

      // Criterion 123: on the issue now marked, a person's commit Forge cannot read is answered with
      // where the mark stays, and a comment says so; nothing is refused and nothing is written.
      const said = await comments(issue.id);
      const repeat = await mark({ ...issue, mergedAt: new Date() }, OWN, 'human');
      expect(repeat.action).toBe('already_merged');
      expect(repeat.markDetail.split('\n')[0]).toBe(
        `The mark stays a claim naming commit ${OWN.slice(0, 7)}. Forge could not check commit ${OWN.slice(0, 7)} against the repository. Mark it again once it can.`,
      );
      expect(repeat.markDetail).toContain(says);
      expect(repeat.markDetail).not.toContain('naming no commit');
      expect(await comments(issue.id)).toHaveLength(said.length + 1);
      expect((await comments(issue.id)).at(-1)).toContain('The mark stays a claim naming commit');
      expect(await row(issue.id)).toMatchObject({ merged_commit_sha: null });

      // Criterion 124: only an issue not yet marked is refused, and only there is no commit offered.
      const fresh = await seed({ seq: SEQ + 1 });
      const refused = await refusal(() => mark(fresh, OWN, 'human'));
      expect(refused.code).toBe('COMMIT_UNVERIFIED');
      expect(refused.message).toContain(says);
      expect(refused.message).toContain('Or mark it naming no commit, which records a claim.');
    },
  );

  it('still refuses NO_WORK_EVIDENCE, naming the commit route, for a mark with no commit (criteria 10, 12)', async () => {
    const issue = await seed({ sessionContext: { branch: 'main' } });
    const refused = await refusal(() => mark(issue, undefined));
    expect(refused.code).toBe('NO_WORK_EVIDENCE');
    // ISS-1421 r9: this door is REST's, so the step names REST's own field.
    expect(refused.message).toContain('on the base branch in `commit`.');
    expect(refused.message).not.toContain('data.commit');
    expect(repo.reads).toEqual([]);
  });

  it('resolves the commit and keeps it a claim, not held to the landing check, where the issue already has a branch (criterion 13; ISS-1350)', async () => {
    const issue = await seed({ sessionContext: { branch: 'ISS-1318-mark-landed-base' } });
    const res = await mark(issue, FOREIGN);
    expect(res.mark).toBe('asserted');
    expect(res.markDetail).toContain(
      `Commit ${FOREIGN.slice(0, 7)} is in ${repo.fullName}, and is noted in the comment only.`,
    );
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
    expect(res.markDetail).not.toContain(`, on main of ${repo.fullName}.`);
    expect((await comments(issue.id)).at(-1)).not.toContain(`, on main of ${repo.fullName}.`);
  });

  it('takes no commit route on an outside_git project, naming the landing route (criterion 15, ISS-1384)', async () => {
    const issue = await seed({ kind: 'website' });
    const refused = await refusal(() => mark(issue, OWN));
    expect(refused.code).toBe('NO_WORK_EVIDENCE');
    expect(refused.message).toContain('this mark names no landing and no branch is recorded');
    expect(refused.message).toContain('Send `landing` naming the live URL');
    expect(refused.message).not.toContain('commit`');
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
      // The commit as it was typed, whole: a shorter prefix of it could name a commit after all.
      expect(refused.message).toContain(
        `The repository SidCorp-co/specimen resolves no single commit from ${short}.`,
      );
      expect(refused.message).toContain('Mark it with the full sha the work landed at.');
      expect(refused.message).not.toContain('holds no commit');
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
  it('records the claim and names the base branch to set, where the project names none', async () => {
    await setBaseBranch(null);
    // With no base branch to discard, a recorded `main` would itself count, so none is recorded.
    const issue = await seed({ sessionContext: {} });
    const res = await mark(issue, OWN);
    expect(res.mark).toBe('asserted');
    expect(res.markDetail).toContain('The project names no base branch to look for it on');
    expect(res.markDetail).toContain('Mark it again once the project names its base branch.');
    expect(repo.reads).toEqual([]);
  });

  it("carries the issue to testing on the agent's claim where the reader fails, and holds a person's mark naming a commit refused", async () => {
    repo.down = 'read';
    const issue = await seed();
    expect((await mark(issue, OWN)).mark).toBe('asserted');
    await advance(issue.id, 'in_progress', 'developed');
    await advance(issue.id, 'developed', 'testing');
    expect((await row(issue.id)).status).toBe('testing');
    expect((await refusal(() => mark(issue, OWN, 'human'))).code).toBe('COMMIT_UNVERIFIED');
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

  it('tells a person held by the declared work_evidence criterion the landing route, which clears it (website, ISS-1384)', async () => {
    await declareWorkEvidence();
    const issue = await seed({ kind: 'website' });
    const refused = await refusal(() => advance(issue.id, 'in_progress', 'developed', 'human'));
    expect(refused.code).toBe('ENTRY_CRITERIA_UNMET');
    expect(refused.message).not.toContain('does not hold them to');
    expect(refused.message).toContain('`mark_merged` carrying `data.landing`');
    expect(refused.message).toContain('`statusEntryCriteria`');

    await mark(issue, undefined, 'human', { landing: 'https://shop.example/p/1318' });
    await advance(issue.id, 'in_progress', 'developed', 'human');
    expect((await row(issue.id)).status).toBe('developed');
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
