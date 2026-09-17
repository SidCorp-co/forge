/**
 * Every way one publish does not happen, and the row that says so.
 *
 * ISS-1072's fifth outcome is that a repository with no binding, a branch that
 * resolves to no issue and a project that turned the check off are each refused
 * or skipped BY NAME in the delivery log. So the assertions here are mostly
 * about `integration_deliveries` rows: what status they carry, and whether the
 * reason on them tells an operator what to do next.
 *
 * A skip and a refusal are held apart on purpose. "Forge deliberately did not
 * publish" recorded as `failed` is a red row for a project that turned the check
 * off, and a log that cries wolf is one nobody opens.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

/** Rows the next `db.select(...)` chains answer with, oldest first. */
let selectQueue: unknown[][] = [];
const takeRows = () => selectQueue.shift() ?? [];
const select = vi.fn(() => ({
  from: () => ({
    where: () => ({
      limit: async () => takeRows(),
      orderBy: async () => takeRows(),
    }),
  }),
}));
vi.mock('../../db/client.js', () => ({ db: { select } }));

const recordDelivery = vi.fn(async () => 'delivery-1');
const updateDelivery = vi.fn(async () => undefined);
vi.mock('../deliveries.js', () => ({
  recordDelivery: (...args: unknown[]) => recordDelivery(...(args as [])),
  updateDelivery: (...args: unknown[]) => updateDelivery(...(args as [])),
}));

let connection: { active: boolean } | null = { active: true };
let secrets: Record<string, unknown> = { appId: '7', privateKey: 'pk' };
vi.mock('../store.js', () => ({
  findConnectionById: async () => connection,
  decryptConnectionSecrets: () => secrets,
}));

const publish = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
  outcome: 'created',
  checkRunId: 9,
  conclusion: 'success',
  answerKind: 'judged',
}));
vi.mock('./check-run.js', () => ({
  publishContractCheck: (...args: unknown[]) => publish(...args),
}));

const { GitHubPublishError } = await import('./client.js');
const { CHECK_PUBLISH_EVENT, noteNotPublished, publishForStoredPullRequest } = await import(
  './contract-check.js'
);

const PR_ID = '33333333-3333-4333-8333-333333333333';
const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const BINDING_ID = '44444444-4444-4444-8444-444444444444';

const storedRow = (over: Record<string, unknown> = {}) => ({
  id: PR_ID,
  bindingId: BINDING_ID,
  issueId: ISSUE_ID,
  headSha: 'a'.repeat(40),
  headRef: 'ISS-1072',
  number: 481,
  ...over,
});

const bindingRow = (
  config: Record<string, unknown> = { owner: 'o', repo: 'r', installationId: '42' },
) => ({
  connectionId: 'c1',
  config,
});

/** The queue for the happy path: the pull request, then its binding. */
const queue = (row = storedRow(), binding: unknown = bindingRow()) => {
  selectQueue = [[row], binding === null ? [] : [binding]];
};

const lastUpdate = (): Record<string, unknown> => {
  const call = updateDelivery.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
  return call?.[1] ?? {};
};
const skipReason = () => ((lastUpdate().response ?? {}) as { reason?: string }).reason ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  connection = { active: true };
  secrets = { appId: '7', privateKey: 'pk' };
  publish.mockResolvedValue({
    outcome: 'created',
    checkRunId: 9,
    conclusion: 'success',
    answerKind: 'judged',
  });
  queue();
});

describe('a publish that happens', () => {
  it('records an outbound delivery for the pull request and closes it ok', async () => {
    const outcome = await publishForStoredPullRequest(PR_ID);
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: BINDING_ID,
        direction: 'outbound',
        eventName: CHECK_PUBLISH_EVENT,
        status: 'pending',
      }),
    );
    expect(lastUpdate()).toMatchObject({ status: 'ok' });
    expect(outcome).toMatchObject({ kind: 'published', outcome: 'created', checkRunId: 9 });
  });

  it('answers null for a pull request this projection does not hold, writing nothing', async () => {
    selectQueue = [[]];
    expect(await publishForStoredPullRequest(PR_ID)).toBeNull();
    expect(recordDelivery).not.toHaveBeenCalled();
  });
});

describe('the skips, each named in its own row', () => {
  it('names the branch when the head resolves to no issue', async () => {
    queue(storedRow({ issueId: null, headRef: 'chore/bump-deps' }));
    const outcome = await publishForStoredPullRequest(PR_ID);
    expect(outcome).toMatchObject({ kind: 'skipped' });
    expect(skipReason()).toContain('chore/bump-deps');
    expect(publish).not.toHaveBeenCalled();
  });

  it('names the setting when the binding turned the check off', async () => {
    queue(
      storedRow(),
      bindingRow({ owner: 'o', repo: 'r', installationId: '42', contractCheck: false }),
    );
    const outcome = await publishForStoredPullRequest(PR_ID);
    expect(outcome).toMatchObject({ kind: 'skipped' });
    expect(skipReason()).toContain('contractCheck: false');
    expect(publish).not.toHaveBeenCalled();
  });

  // cm:guard absent means ON. Reading an absent key as off would ship a feature that runs nowhere, and nobody finds that out until they ask why no check ever appeared.
  it('publishes where the binding has never been asked about the switch', async () => {
    queue(storedRow(), bindingRow({ owner: 'o', repo: 'r', installationId: '42' }));
    expect(await publishForStoredPullRequest(PR_ID)).toMatchObject({ kind: 'published' });
  });

  it('names a repository nobody picked', async () => {
    queue(storedRow(), bindingRow({ installationId: '42' }));
    expect(await publishForStoredPullRequest(PR_ID)).toMatchObject({ kind: 'skipped' });
    expect(skipReason()).toContain('no owner/repo');
  });

  it('names an App that is not installed for that binding', async () => {
    queue(storedRow(), bindingRow({ owner: 'o', repo: 'r' }));
    expect(await publishForStoredPullRequest(PR_ID)).toMatchObject({ kind: 'skipped' });
    expect(skipReason()).toContain('not installed');
  });

  it('names a connection that holds no App credential', async () => {
    secrets = {};
    expect(await publishForStoredPullRequest(PR_ID)).toMatchObject({ kind: 'skipped' });
    expect(skipReason()).toContain('no GitHub App credential');
  });

  it('names a connection that is gone or deactivated', async () => {
    connection = null;
    expect(await publishForStoredPullRequest(PR_ID)).toMatchObject({ kind: 'skipped' });
    expect(skipReason()).toContain('connection');
  });

  it('names a binding deactivated since the row was stored', async () => {
    queue(storedRow(), null);
    expect(await publishForStoredPullRequest(PR_ID)).toMatchObject({ kind: 'skipped' });
    expect(skipReason()).toContain(BINDING_ID);
  });

  // cm:guard a skip is `ok` and never `failed`. Each one names something an operator has not set up, and none of them is GitHub refusing Forge — recording them as failures is what trips a connection breaker on a binding nobody ever finished configuring.
  it('records every skip as `ok`, not as a failure', async () => {
    queue(storedRow({ issueId: null }));
    await publishForStoredPullRequest(PR_ID);
    expect(lastUpdate()).toMatchObject({ status: 'ok', response: { skipped: true } });
    expect(lastUpdate().errorMessage).toBeUndefined();
  });
});

describe('a refusal from GitHub itself', () => {
  it('records it FAILED, with the sentence `check-refusal.ts` wrote', async () => {
    publish.mockRejectedValue(
      new GitHubPublishError({
        op: 'create',
        status: 403,
        headers: { get: () => null },
        detail: '{"message":"Resource not accessible by integration"}',
        message: 'POST failed',
      }),
    );
    const outcome = await publishForStoredPullRequest(PR_ID);
    expect(outcome).toMatchObject({ kind: 'refused' });
    expect(lastUpdate()).toMatchObject({ status: 'failed' });
    expect(lastUpdate().errorMessage).toContain('`checks: write`');
    expect(lastUpdate().response).toMatchObject({ cause: 'permission-missing', op: 'create' });
  });

  it('keeps the operation a refusal failed at, rather than flattening it to the write', async () => {
    publish.mockRejectedValue(
      new GitHubPublishError({ op: 'lookup', status: 404, message: 'GET failed' }),
    );
    await publishForStoredPullRequest(PR_ID);
    expect(lastUpdate().response).toMatchObject({ op: 'lookup', cause: 'repository-unreachable' });
  });

  it('never throws at its caller, whatever GitHub did', async () => {
    publish.mockRejectedValue(new Error('socket hang up'));
    await expect(publishForStoredPullRequest(PR_ID)).resolves.toMatchObject({ kind: 'refused' });
  });
});

describe('a pull request the fan-out could not reach', () => {
  it('gets a row saying so rather than being dropped', async () => {
    selectQueue = [[storedRow()]];
    const outcome = await noteNotPublished(PR_ID, 'past the republication bound');
    expect(outcome).toMatchObject({ kind: 'skipped' });
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: CHECK_PUBLISH_EVENT, status: 'pending' }),
    );
    expect(skipReason()).toContain('past the republication bound');
    expect(publish).not.toHaveBeenCalled();
  });
});
