/**
 * What an operator is told when GitHub refuses a merge.
 *
 * Every case here is a sentence rather than a code path, because the sentence
 * is the deliverable: it must name the permissions the refused call actually
 * needs, and assert of no cause that it is ruled out (ISS-1151).
 */

import { describe, expect, it } from 'vitest';
import { GitHubPublishError } from './client.js';
import { describeMergeRefusal } from './merge-refusal.js';

const headers = (map: Record<string, string>) => ({
  get: (name: string) => map[name.toLowerCase()] ?? null,
});

const refused = (over: Partial<ConstructorParameters<typeof GitHubPublishError>[0]> = {}) =>
  describeMergeRefusal(
    new GitHubPublishError({ op: 'merge', status: 403, message: 'forbidden', ...over }),
    553,
  );

const NOT_ACCESSIBLE = '{"message":"Resource not accessible by integration"}';

describe('a merge refused on permissions names what a merge needs', () => {
  it('names `pull_requests: write` and `contents: write`', () => {
    const refusal = refused({ detail: NOT_ACCESSIBLE });
    expect(refusal.cause).toBe('permission-missing');
    expect(refusal.message).toContain('`pull_requests: write`');
    expect(refusal.message).toContain('`contents: write`');
    expect(refusal.message).toContain('merging the pull request');
  });

  it('names no `checks` permission at all', () => {
    expect(refused({ detail: NOT_ACCESSIBLE }).message).not.toContain('checks');
  });

  it('keeps the way out on the reading the body established', () => {
    const refusal = refused({ detail: NOT_ACCESSIBLE });
    expect(refusal.message).toContain('approve the resulting request on the installation');
    expect(refusal.message).toContain('reconnecting will not change this');
  });
});

describe('a merge 403 GitHub did not explain rules nothing out', () => {
  const unexplained = () => refused({ headers: headers({ 'x-ratelimit-remaining': '4999' }) });

  it('names a branch protection rule or a repository ruleset among the readings', () => {
    const refusal = unexplained();
    expect(refusal.cause).toBe('access-refused');
    expect(refusal.message).toContain('branch protection rule');
    expect(refusal.message).toContain('ruleset');
  });

  it('names no `checks` permission', () => {
    expect(unexplained().message).not.toContain('checks');
  });

  it('says nothing is ruled out, and rules nothing out', () => {
    const refusal = unexplained();
    expect(refusal.message).toContain('nothing here is ruled out');
    expect(refusal.message).not.toContain('which of the two');
    expect(refusal.message).not.toContain('is not what is wrong');
  });
});

describe('the reads a merge makes are not the reads a check run makes', () => {
  const lookup = (over: Partial<ConstructorParameters<typeof GitHubPublishError>[0]> = {}) =>
    describeMergeRefusal(
      new GitHubPublishError({ op: 'lookup', status: 403, message: 'forbidden', ...over }),
      553,
    );

  it('says what the merge path was reading, not what the check path reads', () => {
    const refusal = lookup({ detail: NOT_ACCESSIBLE });
    expect(refusal.message).toContain('reading the pull request and the checks on its head');
    expect(refusal.message).not.toContain('looking up the existing check run');
  });

  it('names the read permissions that read needs', () => {
    const refusal = lookup({ detail: NOT_ACCESSIBLE });
    expect(refusal.message).toContain('`pull_requests: read`');
    expect(refusal.message).toContain('`checks: read`');
    expect(refusal.message).not.toContain('checks: write');
  });

  it('does not answer a read that timed out with the unknown outcome a merge has', () => {
    const refusal = lookup({ status: null, timedOut: true });
    expect(refusal.cause).toBe('timed-out-before-write');
    expect(refusal.message).toContain('the merge was never sent');
    expect(refusal.message).not.toContain('one merge becomes two attempts');
  });
});

describe('a 422 names no cause the status itself rules out', () => {
  it('does not blame the merge method, which GitHub answers 405 for', () => {
    const refusal = refused({ status: 422, detail: 'Validation Failed' });
    expect(refusal.cause).toBe('rejected-payload');
    expect(refusal.message).toContain('Validation Failed');
    expect(refusal.message).not.toContain('a merge method this repository does not allow');
    expect(refusal.message).toContain('405');
  });

  it('points at what GitHub said rather than naming one commonest cause', () => {
    expect(refused({ status: 422, detail: 'Validation Failed' }).message).toContain(
      'Nothing here names a cause beyond what GitHub sent',
    );
  });

  it('rules out only what the status itself rules out, on the reads', () => {
    const refusal = describeMergeRefusal(
      new GitHubPublishError({
        op: 'lookup',
        status: 422,
        message: 'unprocessable',
        detail: 'Validation Failed',
      }),
      553,
    );
    expect(refusal.message).not.toContain('commonest cause is a pull request number');
    expect(refusal.message).toContain('404');
  });
});

describe('the statuses the merge path answers for itself are unchanged', () => {
  it('still refuses a 405 as a state that moved under the read', () => {
    const refusal = refused({ status: 405, detail: 'Pull Request is not mergeable' });
    expect(refusal.status).toBe(405);
    expect(refusal.message).toContain('#553');
    expect(refusal.message).toContain('not mergeable at the moment Forge asked');
  });

  it('still refuses a 409 as a head that moved', () => {
    expect(refused({ status: 409 }).message).toContain('head branch was modified');
  });

  it('still refuses a merge that timed out without re-sending it', () => {
    const refusal = refused({ status: null, timedOut: true });
    expect(refusal.cause).toBe('timed-out-mid-write');
    expect(refusal.message).toContain('one merge becomes two attempts');
  });

  it('still describes something thrown that is not a publish error at all', () => {
    const refusal = describeMergeRefusal(new Error('socket hang up'), 553);
    expect(refusal.op).toBe('merge');
    expect(refusal.message).toContain('merging the pull request');
    expect(refusal.message).toContain('socket hang up');
  });
});
