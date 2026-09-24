import type { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { releaseBlockerSentence } from './blocker-sentences.js';
import { blocker, releaseBlockerError } from './blockers.js';
import { ReleaseRunnerAmbiguousError } from './channel.js';
import { ReleaseTargetUndeclaredError } from './gate.js';
import { declarationRefusal, reportedRefusal, undeclaredProbes } from './refusals.js';
import { ReleaseMultiChannelUnsupportedError } from './service.js';

function body(err: HTTPException): string {
  return JSON.stringify(err.cause) + err.message;
}

/**
 * `declarationRefusal` answers these three codes with `releaseBlockerSentence`'s
 * own text, the same function `GET /release-readiness` composes its entry
 * from — asserted as an equality, not a substring: a `toContain` would still
 * pass on a second literal that happened to overlap (ISS-1127 criterion 9).
 */
describe('declarationRefusal — one sentence, whichever door', () => {
  it("answers RELEASE_TARGET_UNDECLARED with releaseBlockerSentence's own text", () => {
    const err = new ReleaseTargetUndeclaredError('proj-1', 'promote');

    const refusal = declarationRefusal(err);

    expect(refusal).not.toBeNull();
    expect(refusal?.message).toBe(
      releaseBlockerSentence('RELEASE_TARGET_UNDECLARED', { releaseModel: 'promote' }),
    );
    // The bypassed literal named the project id; the shared sentence does not,
    // because every door that reads it is already scoped to one project.
    expect(refusal?.message).not.toContain('proj-1');
  });

  it("answers RELEASE_RUNNER_AMBIGUOUS with releaseBlockerSentence's own text", () => {
    const err = new ReleaseRunnerAmbiguousError('proj-1', ['box-a', 'box-b']);

    const refusal = declarationRefusal(err);

    expect(refusal?.message).toBe(
      releaseBlockerSentence('RELEASE_RUNNER_AMBIGUOUS', { labels: ['box-a', 'box-b'] }),
    );
  });

  it("answers RELEASE_MULTI_CHANNEL_UNSUPPORTED with releaseBlockerSentence's own text", () => {
    const err = new ReleaseMultiChannelUnsupportedError(2);

    const refusal = declarationRefusal(err);

    expect(refusal?.message).toBe(
      releaseBlockerSentence('RELEASE_MULTI_CHANNEL_UNSUPPORTED', { count: 2 }),
    );
  });

  it('answers null for an error none of the three codes names', () => {
    expect(declarationRefusal(new Error('unrelated'))).toBeNull();
  });
});

describe('undeclaredProbes', () => {
  it('answers 409 under the code the routes translate', () => {
    const err = undeclaredProbes();
    expect(err.status).toBe(409);
    expect(body(err)).toContain('RELEASE_PROBES_UNDECLARED');
  });

  it('names the project field as a way out', () => {
    const text = body(undeclaredProbes());
    expect(text).toContain('environments.live.commitUrl');
    expect(text).toContain('environments.live.commitPath');
  });

  it('names the binding field as the other way out', () => {
    expect(body(undeclaredProbes())).toContain('verify');
    expect(body(undeclaredProbes())).toContain('probes');
  });

  it('says what a commit path looks like, including the empty case', () => {
    const text = body(undeclaredProbes());
    expect(text).toContain('data.commit');
    expect(text).toMatch(/whole body/i);
  });

  it('says a binding declaring an unreadable verify takes no project default', () => {
    expect(body(undeclaredProbes())).toMatch(/takes NO project default/i);
  });
});

function thrown(...entries: ReturnType<typeof blocker>[]) {
  return releaseBlockerError({
    projectId: 'p',
    projectExists: true,
    declaration: null,
    channels: [],
    blockers: entries,
    warnings: [],
  });
}

/**
 * The create and record doors answer a report from its own first entry. Each
 * code below is one whose error class carries less than its entry — the
 * rebuild from that class is what lost the boxes and the run id (ISS-1127).
 */
describe('reportedRefusal — the entry readiness listed, not a rebuild of it', () => {
  const runners = [
    { deviceName: 'dev1', reason: 'never-connected', lastSeenSeconds: null, reporting: false },
  ];

  it.each([
    ['NO_RUNNER_ONLINE', { runners }],
    ['BATCH_IN_FLIGHT', { runId: 'run-9' }],
    ['RELEASE_ROSTER_OVERSIZE', { waiting: 51, limit: 50 }],
    ['RELEASE_ROSTER_EMPTY', { nearGate: 2 }],
    ['RELEASE_RUNNER_UNDECLARED', undefined],
  ] as const)('answers %s with its own status, message and details', (code, details) => {
    const entry = blocker(code, details as Record<string, unknown> | undefined);

    const refusal = reportedRefusal(thrown(entry)) as HTTPException;

    expect(refusal.status).toBe(entry.httpStatus);
    expect(refusal.message).toBe(entry.message);
    expect(refusal.cause).toEqual(details ? { code, details } : { code });
  });

  it('carries every later entry, whole, as alsoBlocking', () => {
    const head = blocker('RELEASE_RECORD_MISSING', { issueIds: ['a'] });
    const rest = [blocker('RELEASE_POOL_EMPTY'), blocker('BATCH_IN_FLIGHT', { runId: 'r' })];

    const refusal = reportedRefusal(thrown(head, ...rest)) as HTTPException;

    expect(refusal.cause).toEqual({
      code: 'RELEASE_RECORD_MISSING',
      details: { issueIds: ['a'], alsoBlocking: rest },
    });
  });

  it('answers null for an error no report rode on', () => {
    expect(reportedRefusal(new Error('claim race'))).toBeNull();
  });
});
