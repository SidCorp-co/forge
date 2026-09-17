/**
 * Which branch names an issue, and which only looks as if it does.
 *
 * The db half is exercised through the reader the resolver takes, so the rule —
 * a prefix this project has held, a row that belongs to it — is asserted against
 * the query that was actually built rather than against a mock's return value.
 */

import { describe, expect, it } from 'vitest';
import type { IssueRefReader } from '../../issues/issue-prefix-read.js';
import { referenceInHeadRef, resolveIssueForHeadRef } from './issue-link.js';

describe('the reference a branch opens with', () => {
  it('takes the key a runner`s branch begins with', () => {
    expect(referenceInHeadRef('ISS-1062-github-integration')).toEqual({
      prefix: 'ISS',
      issSeq: 1062,
    });
  });

  it('takes a bare key with nothing after it', () => {
    expect(referenceInHeadRef('FD-7')).toEqual({ prefix: 'FD', issSeq: 7 });
  });

  it('upper-cases the prefix, because git refs are case sensitive and issue keys are not', () => {
    expect(referenceInHeadRef('iss-1062-x')).toEqual({ prefix: 'ISS', issSeq: 1062 });
  });

  // cm:why the separator class is the whole rule: without it `ISS-10` would also match the branch `ISS-1062-...` under a lazier digit bound, and one issue's branch would link to another's row.
  it('does not take a key that is only mentioned in the middle of a branch', () => {
    expect(referenceInHeadRef('feature/not-ISS-1062')).toBeNull();
    expect(referenceInHeadRef('revert-ISS-1062-github')).toBeNull();
  });

  it('takes the whole number, never a prefix of it', () => {
    expect(referenceInHeadRef('ISS-1062-x')?.issSeq).toBe(1062);
  });

  it('refuses a sequence outside int4, which is a 500 on a caller`s typo otherwise', () => {
    expect(referenceInHeadRef('ISS-9999999999-x')).toBeNull();
  });

  it('refuses a branch that names no key at all', () => {
    expect(referenceInHeadRef('main')).toBeNull();
    expect(referenceInHeadRef('dependabot/npm_and_yarn/vite-5.0.0')).toBeNull();
  });
});

// cm:guard this stub DISCARDS the predicate, so nothing below can prove the `project_id` in the
// WHERE. That is deliberate and it is the whole reason
// `tests/integration/repo-projection-e2e.test.ts` plants two projects against Postgres: a stub whose
// `where` returns itself makes a scoping test pass whatever the query asks for, which is the
// proof-by-absence ISS-1071's own F2 was filed for. What these cases prove is the ORDER of the two
// reads and the short-circuit, which is a property of this function and not of the database.
/** A reader that records what it was asked and answers from a fixed set. */
function reader(opts: { heldPrefixes?: string[]; issue?: { id: string } | undefined }): {
  dbi: IssueRefReader;
  issueLookups: number;
} {
  const state = { issueLookups: 0 };
  const dbi = {
    select(cols: Record<string, unknown>) {
      const isPrefixRead = 'prefix' in cols;
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => (opts.issue ? [opts.issue] : []),
        then(resolve: (rows: unknown[]) => void) {
          resolve((opts.heldPrefixes ?? []).map((prefix) => ({ prefix })));
        },
      };
      if (!isPrefixRead) state.issueLookups += 1;
      return chain;
    },
  } as unknown as IssueRefReader;
  return {
    dbi,
    get issueLookups() {
      return state.issueLookups;
    },
  };
}

describe('resolving a branch to an issue', () => {
  it('resolves the legacy prefix without asking for held prefixes at all', async () => {
    const r = reader({ heldPrefixes: [], issue: { id: 'issue-1' } });
    await expect(
      resolveIssueForHeadRef({ projectId: 'p', headRef: 'ISS-1062-x' }, r.dbi),
    ).resolves.toBe('issue-1');
  });

  // cm:why the aliases table's own CHECK refuses `ISS`, so a project that never renamed holds NO alias row — reading only the aliases would stop every ordinary branch on every ordinary project from resolving.
  it('resolves a prefix this project has held', async () => {
    const r = reader({ heldPrefixes: ['FD'], issue: { id: 'issue-2' } });
    await expect(
      resolveIssueForHeadRef({ projectId: 'p', headRef: 'FD-7-x' }, r.dbi),
    ).resolves.toBe('issue-2');
  });

  it('is case-insensitive about a held prefix', async () => {
    const r = reader({ heldPrefixes: ['fd'], issue: { id: 'issue-2' } });
    await expect(resolveIssueForHeadRef({ projectId: 'p', headRef: 'FD-7' }, r.dbi)).resolves.toBe(
      'issue-2',
    );
  });

  it('refuses a prefix belonging to another project, without looking the row up', async () => {
    const r = reader({ heldPrefixes: ['FD'], issue: { id: 'wrong-project-issue' } });
    await expect(
      resolveIssueForHeadRef({ projectId: 'p', headRef: 'XY-7-x' }, r.dbi),
    ).resolves.toBeNull();
    expect(r.issueLookups).toBe(0);
  });

  it('answers null for a branch naming no key, and spends no query on it', async () => {
    const r = reader({ heldPrefixes: ['FD'], issue: { id: 'nope' } });
    await expect(
      resolveIssueForHeadRef({ projectId: 'p', headRef: 'dependabot/x' }, r.dbi),
    ).resolves.toBeNull();
    expect(r.issueLookups).toBe(0);
  });

  it('answers null where the key is well formed and no such issue exists', async () => {
    const r = reader({ heldPrefixes: [], issue: undefined });
    await expect(
      resolveIssueForHeadRef({ projectId: 'p', headRef: 'ISS-999999-x' }, r.dbi),
    ).resolves.toBeNull();
  });
});
