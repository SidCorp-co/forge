/**
 * The write-side refusals, planted one at a time.
 *
 * This is the first thing Forge ever writes to GitHub, so not one of these
 * failures has been met on a real project: "it worked for reads" is evidence
 * about a different set of status codes. Every case below exists because GitHub
 * answers it and nothing in this repo had ever seen it answered.
 */

import { describe, expect, it } from 'vitest';
import { describeRefusal, describeThrown } from './check-refusal.js';
import { GitHubPublishError, type GitHubPublishOp } from './client.js';

const headers = (map: Record<string, string>) => ({
  get: (name: string) => map[name.toLowerCase()] ?? null,
});

const err = (over: Partial<ConstructorParameters<typeof GitHubPublishError>[0]> = {}) =>
  new GitHubPublishError({ op: 'create', message: 'boom', ...over });

describe('403 is three different things and is never guessed between', () => {
  it('reads an exhausted quota off the headers and prescribes no permission', () => {
    const refusal = describeRefusal(
      err({
        status: 403,
        headers: headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1789000000' }),
      }),
    );
    expect(refusal.cause).toBe('rate-limited');
    expect(refusal.message).toContain('rate-limited');
    expect(refusal.message).toContain('2026-09-10T00:26:40.000Z');
    // The whole point: an operator must not be sent to grant a permission they hold.
    expect(refusal.message).not.toContain('checks: write');
  });

  it('reads a secondary limit off retry-after, and still prescribes no permission', () => {
    const refusal = describeRefusal(
      err({ status: 403, headers: headers({ 'retry-after': '60' }) }),
    );
    expect(refusal.cause).toBe('rate-limited');
    expect(refusal.message).toContain('60s');
    expect(refusal.message).not.toContain('checks: write');
  });

  it('names checks: write only when GitHub says the resource is not accessible', () => {
    const refusal = describeRefusal(
      err({
        status: 403,
        headers: headers({ 'x-ratelimit-remaining': '4999' }),
        detail: '{"message":"Resource not accessible by integration"}',
      }),
    );
    expect(refusal.cause).toBe('permission-missing');
    expect(refusal.message).toContain('`checks: write`');
    expect(refusal.message).toContain('approve');
    expect(refusal.message).toContain('reconnecting will not change this');
  });

  it('refuses a 403 carrying none of the three tells as exactly that', () => {
    const refusal = describeRefusal(err({ status: 403, headers: headers({}) }));
    expect(refusal.cause).toBe('access-refused');
    expect(refusal.message).toContain('sent nothing saying which of the two it was');
    expect(refusal.message).toContain('not guessing');
  });
});

describe('404 means two different things one operation apart', () => {
  it("keeps app-auth's own words for a 404 raised while minting", () => {
    const refusal = describeRefusal(
      err({
        op: 'mint',
        status: 404,
        message: 'installation 42 does not exist for this App — it was removed, or the App was never installed on that account',
      }),
    );
    expect(refusal.cause).toBe('installation-missing');
    expect(refusal.message).toContain('installation 42 does not exist');
    // The repository sentence would be a history that did not happen.
    expect(refusal.message).not.toContain('no longer reaches');
  });

  it('reads a 404 on a repository request as the App no longer reaching it', () => {
    const refusal = describeRefusal(err({ op: 'create', status: 404 }));
    expect(refusal.cause).toBe('repository-unreachable');
    expect(refusal.message).toContain('no longer reaches that repository');
  });
});

describe('a timeout says whether anything was written', () => {
  it.each<[GitHubPublishOp, string]>([
    ['mint', 'minting the installation token'],
    ['lookup', 'looking up the existing check run'],
  ])('reports a %s timeout as a publication not attempted', (op, where) => {
    const refusal = describeRefusal(err({ op, timedOut: true }));
    expect(refusal.cause).toBe('timed-out-before-write');
    expect(refusal.message).toContain(where);
    expect(refusal.message).toContain('no check run was written');
  });

  it.each<GitHubPublishOp>(['create', 'update'])(
    'reports a %s timeout as an unknown outcome, never a confirmed non-write',
    (op) => {
      const refusal = describeRefusal(err({ op, timedOut: true }));
      expect(refusal.cause).toBe('timed-out-mid-write');
      expect(refusal.message).toContain('may or may not have taken that write');
      expect(refusal.message).toContain('not a confirmed failure to write');
    },
  );
});

describe('the rest of the write-side set', () => {
  it('reads a 429 as a rate limit and names the retry window it was given', () => {
    const refusal = describeRefusal(
      err({ status: 429, headers: headers({ 'retry-after': '12' }) }),
    );
    expect(refusal.cause).toBe('rate-limited');
    expect(refusal.message).toContain('12s');
  });

  it('reads a 429 with no retry window as a rate limit that gave none', () => {
    const refusal = describeRefusal(err({ status: 429, headers: headers({}) }));
    expect(refusal.cause).toBe('rate-limited');
    expect(refusal.message).toContain('no retry window was given');
  });

  it('reads a 401 as a credential GitHub does not recognise, naming the operation', () => {
    const refusal = describeRefusal(
      err({ op: 'update', status: 401, message: 'GitHub rejected the App JWT' }),
    );
    expect(refusal.cause).toBe('credential-rejected');
    expect(refusal.message).toContain('updating the check run');
    expect(refusal.message).toContain('GitHub rejected the App JWT');
  });

  it('reads a 422 as a refused payload and names the commonest cause', () => {
    const refusal = describeRefusal(
      err({ status: 422, detail: '{"message":"No commit found for SHA"}' }),
    );
    expect(refusal.cause).toBe('rejected-payload');
    expect(refusal.message).toContain('No commit found for SHA');
    expect(refusal.message).toContain('head SHA this repository does not hold');
  });

  it('names the operation on every refusal, whatever the cause', () => {
    const ops: GitHubPublishOp[] = ['mint', 'lookup', 'create', 'update'];
    for (const op of ops) {
      expect(describeRefusal(err({ op, status: 500 })).op).toBe(op);
    }
  });

  it('describes something thrown that is not a publish error at all', () => {
    const refusal = describeThrown(new Error('socket hang up'), 'lookup');
    expect(refusal.cause).toBe('unknown');
    expect(refusal.op).toBe('lookup');
    expect(refusal.message).toContain('looking up the existing check run');
    expect(refusal.message).toContain('socket hang up');
  });
});
