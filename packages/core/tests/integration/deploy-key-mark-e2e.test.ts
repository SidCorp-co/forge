// @gate-input whole-tree — it serves a real repository through a fake ssh on PATH, which the root-walk guard cannot see into.
/**
 * ISS-1398 — on a project hosted on GitLab, with no GitHub binding and a deploy key attached, an
 * agent's commit mark is checked against the repository itself, read with git as that key, through
 * the real mark path and a real Postgres. The repository is a real bare one behind a fake `ssh`
 * (`tests/helpers/git-host-fixture.ts`), so every answer is what git says about it.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.JWT_SECRET ??= 'integration-test-secret-padded-to-32-chars-long';
process.env.DEVICE_TOKEN_PEPPER ??= 'integration-test-pepper-padded-to-32-chars-long';

import {
  GITHUB_NOT_FOUND,
  GITLAB_NO_ACCESS,
  type HostAnswer,
  keyUnknown,
  NO_REPOSITORY,
  unreachable,
} from '../../src/git/host-answers.fixture.js';
import { refusal, SEQ, useCommitLandingWorld } from '../helpers/commit-landing-fixture.js';
import {
  attachDeployKey,
  GITLAB_URL,
  type GitHost,
  startGitHost,
} from '../helpers/git-host-fixture.js';

vi.mock('node:dns', async (importOriginal) =>
  (await import('../helpers/git-host-fixture.js')).publicDns(await importOriginal()),
);

const { seed, mark, advance, row, comments, withLiveBranch, current } = useCommitLandingWorld();

let host: GitHost;
const at: Record<string, string> = {};

beforeAll(() => {
  host = startGitHost();
  at.root = host.commit('main', 'chore: root');
  host.branch('production', at.root);
  at.own = host.commit('main', `fix(core): mark by commit (ISS-${SEQ})`);
  at.foreign = host.commit('main', 'fix(core): something else (ISS-1316)');
  at.spaced = host.commit('main', 'fix(core):  keeps  its spacing (ISS-1316)');
  at.undeclared = host.commit('main', `chore: tidy, see ISS-${SEQ}`);
  host.branch(`ISS-${SEQ}-wip`, at.undeclared);
  at.offBase = host.commit(`ISS-${SEQ}-wip`, `ISS-${SEQ}: work in progress`);
  at.onLive = host.commit('production', `hotfix: straight to production (ISS-${SEQ})`);
  host.publish();
});

afterAll(() => host.close());

beforeEach(async () => {
  host.answering(null);
  const { db, projectId } = current();
  await attachDeployKey(db, projectId, GITLAB_URL);
});

const own = () => at.own as string;

describe('ISS-1398 — a commit mark on a GitLab project, read through its deploy key (real Postgres)', () => {
  it('accepts the landing observed, storing the full sha, and lets the issue reach developed (criterion 1)', async () => {
    const issue = await seed();

    const res = await mark(issue, own());

    expect(res.mark).toBe('observed');
    expect(res.markDetail).toContain(`, on main of ${GITLAB_URL}.`);
    expect((await row(issue.id)).merged_commit_sha).toBe(own());
    await advance(issue.id, 'in_progress', 'developed');
    expect((await row(issue.id)).status).toBe('developed');
  }, 60_000);

  it('stores an abbreviated commit as the full sha the repository resolves (criterion 2)', async () => {
    const issue = await seed();
    await mark(issue, own().slice(0, 9));
    expect((await row(issue.id)).merged_commit_sha).toBe(own());
  }, 60_000);

  it('accepts a commit the live branch holds and the base does not (criterion 1)', async () => {
    await withLiveBranch();
    const issue = await seed();
    const res = await mark(issue, at.onLive as string);
    expect(res.mark).toBe('observed');
    expect((await row(issue.id)).merged_commit_sha).toBe(at.onLive);
  }, 60_000);

  it.each([
    [
      'COMMIT_NOT_IN_REPOSITORY',
      () => 'f'.repeat(40),
      [`${GITLAB_URL} holds no commit ${'f'.repeat(12)}.`],
    ],
    [
      'COMMIT_NOT_THIS_ISSUE',
      () => at.foreign as string,
      ['\n> fix(core): something else (ISS-1316)', `does not name ISS-${SEQ}`, /\(ISS-1316\)$/],
    ],
    ['COMMIT_NOT_THIS_ISSUE', () => at.undeclared as string, [`\n> chore: tidy, see ISS-${SEQ}`]],
    // ISS-1421 r8: a subject is quoted as the commit holds it, its spacing kept.
    [
      'COMMIT_NOT_THIS_ISSUE',
      () => at.spaced as string,
      [/\n> fix\(core\): {2}keeps {2}its spacing \(ISS-1316\)$/],
    ],
    ['COMMIT_NOT_LANDED', () => at.offBase as string, ['main does not contain it']],
    // ISS-1398 r4: git resolves a packed commit's 40 digits plus any tail, so these were accepted.
    ...[`a`, 'abcdef0123456789abcdef0', 'abcdef0123456789abcdef01'].map(
      (tail) =>
        [
          'COMMIT_NOT_IN_REPOSITORY',
          () => `${own()}${tail}`,
          [`it is ${40 + tail.length} hex digits`, 'named by its 40-digit sha or a prefix of it'],
        ] as const,
    ),
    [
      'COMMIT_NOT_IN_REPOSITORY',
      () => `${own()}ABC`.toUpperCase(),
      ['it is 43 hex digits', 'Mark with the full 40-character sha'],
    ],
  ] as const)(
    'refuses %s by what the repository holds, and writes nothing (criteria 3-5)',
    async (code, commit, says) => {
      const issue = await seed();
      const before = await comments(issue.id);

      const refused = await refusal(() => mark(issue, commit()));

      expect(refused.code).toBe(code);
      for (const s of says) {
        if (typeof s === 'string') expect(refused.message).toContain(s);
        else expect(refused.message).toMatch(s);
      }
      expect(await row(issue.id)).toMatchObject({ merged_at: null, merged_commit_sha: null });
      expect(await comments(issue.id)).toEqual(before);
    },
    60_000,
  );

  it("records a claim's commit by the full sha the repository resolves (criterion 6)", async () => {
    const branched = await seed({ sessionContext: { branch: `ISS-${SEQ}-elsewhere` } });
    const res = await mark(branched, (at.foreign as string).slice(0, 10));
    expect(res.mark).toBe('asserted');
    expect(res.markDetail).toContain(
      `Commit ${(at.foreign as string).slice(0, 7)} is in ${GITLAB_URL}, and is noted in the comment only.`,
    );
    expect(res.namedCommit).toBe(at.foreign);

    const person = await seed({ sessionContext: {}, seq: SEQ + 1 });
    const human = await mark(person, (at.foreign as string).slice(0, 10), 'human');
    expect(human.markDetail).toContain((at.foreign as string).slice(0, 7));
    // ISS-1300 r3 — a person's commit the repository holds is the mark's own, by its full sha.
    expect(human.issue.mergedCommitSha).toBe(at.foreign);
    const refused = await refusal(() => mark(person, 'e'.repeat(40), 'human'));
    expect(refused.code).toBe('COMMIT_NOT_IN_REPOSITORY');
    const overlong = await refusal(() => mark(person, `${at.foreign}a`, 'human'));
    expect(overlong.code).toBe('COMMIT_NOT_IN_REPOSITORY');
    expect(overlong.message).toContain('it is 41 hex digits');
  }, 60_000);

  const GIT_ACCESS = "the project's Settings → Runners → Git access";
  const REPO_URL_AT = "the project's Settings → Shape & release → Repository";
  const HOST_ANSWERS: Array<[HostAnswer, string[]]> = [
    [
      GITLAB_NO_ACCESS,
      [
        `the git host took this project's deploy key but will not let it read ${GITLAB_URL}.`,
        `give that key read access to ${GITLAB_URL}, which is all Forge needs; devices that push with it need write access.`,
      ],
    ],
    [
      GITHUB_NOT_FOUND,
      [`the git host took this project's deploy key but will not let it read ${GITLAB_URL}.`],
    ],
    [NO_REPOSITORY, [`if none lives there, fix the SSH clone URL under ${REPO_URL_AT}.`]],
    [
      keyUnknown('gitlab.com'),
      [
        "the git host refused this project's deploy key.",
        `give the key read access to ${GITLAB_URL}, which is all Forge needs; devices that push with it need write access.`,
        `it is under ${GIT_ACCESS}.`,
      ],
    ],
    [
      unreachable('172.65.251.78'),
      [
        'the git host gitlab.com could not be reached, so the deploy key was never offered.',
        'ssh: connect to host gitlab.com',
        `check that the SSH clone URL ${GITLAB_URL} names the right host, and that the host is up.`,
      ],
    ],
  ];

  it.each(HOST_ANSWERS.map(([answer, says]) => [answer.name, answer, says] as const))(
    'records an unverified claim naming the cause in the words of %s, and keeps the commit out of merged_commit_sha (criteria 11, 16; ISS-1409)',
    async (_name, answer, says) => {
      host.answering(answer);
      const issue = await seed();

      const res = await mark(issue, own());

      expect(res.mark).toBe('asserted');
      expect(res.markDetail).toMatch(/(did not|could not) check it/);
      expect(res.markDetail).toContain(answer.said);
      // ISS-1421 — the host's step opens a sentence of its own, so it is read whatever its case.
      for (const s of says) expect(res.markDetail.toLowerCase()).toContain(s.toLowerCase());
      // ISS-1421 r8: our step ends our sentences, and the host's reason stands quoted beneath.
      expect(res.markDetail).toMatch(
        /(, then mark it again|Mark it again once Forge can read the repository)\.\n> /,
      );
      expect(res.markDetail).not.toMatch(/remote:\s*(\.|\))/);
      expect(res.markDetail).not.toContain('172.65.251.78');
      expect(res.markDetail).not.toMatch(/GitHub binding|Integrations/);
      expect(await row(issue.id)).toMatchObject({ merged_commit_sha: null });
      expect((await row(issue.id)).merged_at).not.toBeNull();
      const person = await refusal(() => mark(issue, own(), 'human'));
      expect(person.code).toBe('COMMIT_UNVERIFIED');
    },
    60_000,
  );

  it('records an unverified claim, never a landing, where the live branch is not in the repository (criterion 11; ISS-1409)', async () => {
    const { db, projectId } = current();
    await db.execute(sql`
      UPDATE projects SET release_chain = ${JSON.stringify([
        { branch: 'main' },
        { branch: 'staging', from: 'merge-branch' },
      ])}::jsonb WHERE id = ${projectId}
    `);
    const issue = await seed();
    const res = await mark(issue, at.offBase as string);
    expect(res.mark).toBe('asserted');
    expect(res.markDetail).toContain(`${GITLAB_URL} has no branch staging`);
    expect(res.markDetail).toContain(`Mark it again once ${GITLAB_URL} has a branch staging.`);
    expect(res.markDetail).not.toContain('with the deploy key attached');
    expect(await row(issue.id)).toMatchObject({ merged_commit_sha: null });
  }, 60_000);
});

describe('ISS-1409 — a project whose deploy key cannot be used to read it, or is absent (real Postgres)', () => {
  it('records the commit as an unverified claim, naming the SSH URL and deploy key to attach and never GitHub, where the project has neither (criteria 13, 16; ISS-1409)', async () => {
    const { db, projectId } = current();
    await db.execute(sql`DELETE FROM project_git_credentials WHERE project_id = ${projectId}`);
    const issue = await seed();

    const res = await mark(issue, own());

    expect(res.mark).toBe('asserted');
    expect(res.markDetail).toMatch(/(did not|could not) check it/);
    expect(res.markDetail).toContain("Forge has no way to read this project's repository");
    expect(res.markDetail).toContain('Attach a deploy key, then mark it again.');
    expect(res.markDetail).toContain(
      `Attach a deploy key with read access to ${GITLAB_URL} under the project's Settings → Runners → Git access. Read access is all Forge needs; devices that push with it need write access.`,
    );
    expect(res.markDetail).not.toMatch(
      /bind (a|the) repository|Integrations|through a GitHub binding/,
    );
    expect((await row(issue.id)).merged_commit_sha).toBeNull();
  }, 60_000);

  it('records the claim naming the cause where a deploy key is attached but the repository URL is no SSH remote (criterion 6; ISS-1409)', async () => {
    const { db, projectId } = current();
    await db.execute(
      sql`UPDATE projects SET repo_url = 'https://gitlab.com/org/repo.git' WHERE id = ${projectId}`,
    );
    const issue = await seed();

    const res = await mark(issue, own());

    expect(res.mark).toBe('asserted');
    expect(res.markDetail).toContain('is not an SSH remote');
    expect((await row(issue.id)).merged_commit_sha).toBeNull();
  }, 60_000);
});
