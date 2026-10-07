import { beforeEach, describe, expect, it } from 'vitest';
import { GitHubReadError, type GitHubRepoClient } from '../integrations/github/client.js';
import { githubRepositoryReader } from '../integrations/github/repository-reader.js';
import { carriageOf, changedPathsOf, forgetCarriage } from './carriage.js';

const J = '655cc09cebfc9eb07840dfed6bccd04aaf7f1728';
const S = '420d3a80aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const P = '1111111111111111111111111111111111111111';

type Answer = unknown | ((path: string) => unknown);

/** A client answering each path from `answers`, counting every request it was asked. */
function client(answers: Record<string, Answer>): GitHubRepoClient & { asked: string[] } {
  const asked: string[] = [];
  return {
    bindingId: 'b',
    appId: '1',
    owner: 'o',
    repo: 'r',
    fullName: 'o/r',
    asked,
    async get<T>(path: string): Promise<T> {
      asked.push(path);
      const answer = answers[path];
      if (answer === undefined) throw new GitHubReadError(404, `GET ${path} returned HTTP 404`);
      return (
        typeof answer === 'function' ? (answer as (p: string) => unknown)(path) : answer
      ) as T;
    },
    async publish<T>(): Promise<T> {
      throw new Error('a carriage read never publishes');
    },
  };
}

const cmp = (base: string, head: string) => `/repos/o/r/compare/${base}...${head}`;
const files = (...names: string[]) => names.map((filename) => ({ filename }));

beforeEach(() => forgetCarriage());

describe('carriageOf', () => {
  it('reads a served descendant, or the same commit, as carrying the judged one in one request', async () => {
    for (const status of ['ahead', 'identical']) {
      forgetCarriage();
      const c = client({ [cmp(J, S)]: { status, files: files('a.ts') } });
      expect(await carriageOf(githubRepositoryReader(c), J, S)).toEqual({ kind: 'descends' });
      expect(c.asked).toHaveLength(1);
    }
  });

  it('names the files on both sides where the served commit is behind or diverged', async () => {
    const c = client({
      [cmp(J, S)]: { status: 'diverged', files: files('b.ts') },
      [cmp(S, J)]: {
        status: 'diverged',
        files: [{ filename: 'c.ts', previous_filename: 'old.ts' }],
      },
    });
    expect(await carriageOf(githubRepositoryReader(c), J, S)).toEqual({
      kind: 'differs',
      paths: ['b.ts', 'c.ts', 'old.ts'],
    });
  });

  it('reads a behind commit differing in nothing as differing in nothing, never as descending', async () => {
    const c = client({
      [cmp(J, S)]: { status: 'behind', files: [] },
      [cmp(S, J)]: { status: 'ahead', files: [] },
    });
    expect(await carriageOf(githubRepositoryReader(c), J, S)).toEqual({
      kind: 'differs',
      paths: [],
    });
  });

  it.each([
    ['a failed request (no common ancestor)', {}, 'returned HTTP 404'],
    ['a compare answering no status', { [cmp(J, S)]: { files: [] } }, 'answered no compare status'],
    [
      'a reverse compare answering files and no status',
      {
        [cmp(J, S)]: { status: 'behind', files: [] },
        [cmp(S, J)]: { files: files('outside-the-runtime.md') },
      },
      'answered no compare status',
    ],
    [
      'a file entry with no name',
      {
        [cmp(J, S)]: { status: 'behind', files: [] },
        [cmp(S, J)]: { status: 'ahead', files: [{}] },
      },
      'a file entry with no name',
    ],
    [
      'a rename whose old name is empty',
      {
        [cmp(J, S)]: { status: 'behind', files: [] },
        [cmp(S, J)]: { status: 'ahead', files: [{ filename: 'a.ts', previous_filename: '' }] },
      },
      'a file entry with no name',
    ],
    [
      'a compare answering no file list',
      { [cmp(J, S)]: { status: 'behind' }, [cmp(S, J)]: { status: 'ahead', files: [] } },
      'answered no file list',
    ],
    [
      'a file list at the ceiling',
      {
        [cmp(J, S)]: { status: 'behind', files: [] },
        [cmp(S, J)]: {
          status: 'ahead',
          files: files(...Array.from({ length: 300 }, (_, i) => `f${i}`)),
        },
      },
      '300 or more files differ',
    ],
  ])('is unread, with its reason, for %s', async (_shape, answers, why) => {
    const read = await carriageOf(
      githubRepositoryReader(client(answers as Record<string, Answer>)),
      J,
      S,
    );
    expect(read.kind).toBe('unread');
    expect(read.kind === 'unread' && read.why).toContain(why);
  });

  it('asks the repository once for a pair while the cache holds it', async () => {
    const c = client({ [cmp(J, S)]: { status: 'ahead', files: [] } });
    await carriageOf(githubRepositoryReader(c), J, S);
    await carriageOf(githubRepositoryReader(c), J.toUpperCase(), S);
    expect(c.asked).toHaveLength(1);
  });

  it('charges the budget only on a cache miss, and answers its reason without asking', async () => {
    const c = client({ [cmp(J, S)]: { status: 'ahead', files: [] } });
    let charged = 0;
    const spend = () => (charged++ === 0 ? null : 'spent');
    expect(await carriageOf(githubRepositoryReader(c), J, S, spend)).toEqual({ kind: 'descends' });
    expect(await carriageOf(githubRepositoryReader(c), J, S, spend)).toEqual({ kind: 'descends' });
    expect(charged).toBe(1);
    expect(await carriageOf(githubRepositoryReader(c), J, P, spend)).toEqual({
      kind: 'unread',
      why: 'spent',
    });
    expect(c.asked).toHaveLength(1);
  });

  it('does not keep a failed read, so the next weighing asks again', async () => {
    let fail = true;
    const c = client({
      [cmp(J, S)]: () => {
        if (fail) throw new GitHubReadError(502, 'bad gateway');
        return { status: 'ahead', files: [] };
      },
    });
    expect((await carriageOf(githubRepositoryReader(c), J, S)).kind).toBe('unread');
    fail = false;
    expect(await carriageOf(githubRepositoryReader(c), J, S)).toEqual({ kind: 'descends' });
    expect(c.asked).toHaveLength(2);
  });
});

describe('changedPathsOf', () => {
  it('reads what a landing changed against its first parent', async () => {
    const c = client({
      [`/repos/o/r/commits/${J}`]: { sha: J, parents: [{ sha: P }, { sha: S }] },
      [cmp(P, J)]: {
        status: 'ahead',
        files: files('packages/runner/a.rs', 'packages/runner/a.rs'),
      },
    });
    expect(await changedPathsOf(githubRepositoryReader(c), J)).toEqual({
      kind: 'read',
      paths: ['packages/runner/a.rs'],
    });
    await changedPathsOf(githubRepositoryReader(c), J);
    expect(c.asked).toHaveLength(2);
  });

  it('is unread, and not kept, where the landing cannot be read', async () => {
    const c = client({});
    const read = await changedPathsOf(githubRepositoryReader(c), J);
    expect(read.kind).toBe('unread');
    expect(read.kind === 'unread' && read.why).toContain(`could not read what ${J} changed`);
    await changedPathsOf(githubRepositoryReader(c), J);
    expect(c.asked).toHaveLength(2);
  });

  it('is unread where the landing compare names a file entry with no name', async () => {
    const c = client({
      [`/repos/o/r/commits/${J}`]: { sha: J, parents: [{ sha: P }] },
      [cmp(P, J)]: { status: 'ahead', files: [{ filename: '' }] },
    });
    expect((await changedPathsOf(githubRepositoryReader(c), J)).kind).toBe('unread');
  });

  it('is unread where the landing compare answers files and no status', async () => {
    const c = client({
      [`/repos/o/r/commits/${J}`]: { sha: J, parents: [{ sha: P }] },
      [cmp(P, J)]: { files: files('packages/runner/a.rs') },
    });
    const read = await changedPathsOf(githubRepositoryReader(c), J);
    expect(read.kind).toBe('unread');
    expect(read.kind === 'unread' && read.why).toContain('answered no compare status');
  });

  it('is unread for a root commit, which has no parent to diff against', async () => {
    const c = client({ [`/repos/o/r/commits/${J}`]: { sha: J, parents: [] } });
    expect(await changedPathsOf(githubRepositoryReader(c), J)).toEqual({
      kind: 'unread',
      why: `${J} has no parent to diff it against`,
    });
  });
});
