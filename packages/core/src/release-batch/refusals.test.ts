import type { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { releaseBlockerSentence } from './blocker-sentences.js';
import { blocker, releaseBlockerError } from './blockers.js';
import {
  type AbortAccount,
  NoReleaseGateError,
  ReleaseBatchAbortedError,
  ReleaseFinishedForOtherCommitError,
  ReleaseFinishInFlightError,
  ReleaseProbesUnreadableError,
  ReleaseVersionMissingError,
} from './errors.js';
import { ReleaseTargetUndeclaredError } from './gate.js';
import {
  declarationRefusal,
  finishRefusal,
  issuesUnnamed,
  recordRefusal,
  reportedRefusal,
  unreadableProbes,
} from './refusals.js';

function body(err: HTTPException): string {
  return JSON.stringify(err.cause) + err.message;
}

/**
 * `declarationRefusal` answers its code with `releaseBlockerSentence`'s
 * own text, the same function `GET /release-readiness` composes its entry
 * from — asserted as an equality, not a substring: a `toContain` would still
 * pass on a second literal that happened to overlap (ISS-1127 criterion 9).
 */
describe('declarationRefusal — one sentence, whichever door', () => {
  it("answers RELEASE_TARGET_UNDECLARED with releaseBlockerSentence's own text", () => {
    const reason = 'production environment `beta` is deployed outside Forge';
    const err = new ReleaseTargetUndeclaredError('proj-1', reason);

    const refusal = declarationRefusal(err);

    expect(refusal).not.toBeNull();
    expect(refusal?.message).toBe(releaseBlockerSentence('RELEASE_TARGET_UNDECLARED', { reason }));
    // The bypassed literal named the project id; the shared sentence does not,
    // because every door that reads it is already scoped to one project.
    expect(refusal?.message).not.toContain('proj-1');
  });

  it('answers null for an error the code does not name', () => {
    expect(declarationRefusal(new Error('unrelated'))).toBeNull();
  });
});

describe('unreadableProbes', () => {
  const refused = new ReleaseProbesUnreadableError([], ['coolify b-1']);

  it('answers 409 under the code the routes translate, naming the binding', () => {
    const err = unreadableProbes(refused);
    expect(err.status).toBe(409);
    expect(err.cause).toEqual({
      code: 'RELEASE_PROBES_UNREADABLE',
      details: { urls: [], bindings: ['coolify b-1'] },
    });
    expect(err.message).toContain('Production coolify b-1 declares');
  });

  it('says production declaring only artifact probes proves no release', () => {
    expect(body(unreadableProbes(refused))).toMatch(/all identify the artifact/);
  });

  it('names the probe a release can read, and what removing them leaves', () => {
    const text = body(unreadableProbes(refused));
    expect(text).toContain('`"identifies": "source"`');
    expect(text).toContain('verification.runtime');
    expect(text).toContain('recorded unverified');
  });

  it('keeps the url sentence for a url that is not a url, with no binding clause', () => {
    const err = unreadableProbes(new ReleaseProbesUnreadableError(['not a url']));
    expect(err.cause).toEqual({
      code: 'RELEASE_PROBES_UNREADABLE',
      details: { urls: ['not a url'] },
    });
    expect(err.message).toBe(
      releaseBlockerSentence('RELEASE_PROBES_UNREADABLE', { urls: ['not a url'] }),
    );
    expect(err.message).not.toContain('binding');
  });

  it('is what both the finish and the record door answer it with', () => {
    expect(finishRefusal(refused)?.cause).toEqual(unreadableProbes(refused).cause);
    expect(recordRefusal(refused).cause).toEqual(unreadableProbes(refused).cause);
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

/**
 * ISS-1190: a finish on an aborted batch said its claims were released whatever the abort did,
 * and the finish record stored that sentence. Each account now says only what happened.
 */
describe('finishRefusal — what the abort did to this batch', () => {
  const said = (account: AbortAccount) =>
    finishRefusal(new ReleaseBatchAbortedError(account, 'proj-7'))?.message ?? '';

  it('answers every account under RELEASE_BATCH_ABORTED, carrying the account', () => {
    for (const account of ['shipped', 'held', 'returning', 'released', 'unrecorded'] as const) {
      const refusal = finishRefusal(new ReleaseBatchAbortedError(account, 'proj-7'));
      expect(refusal?.status).toBe(409);
      expect(refusal?.cause).toEqual({ code: 'RELEASE_BATCH_ABORTED', details: { account } });
    }
  });

  it('says a held promoted roster stays at releasing, claimed, with the routes to settle it', () => {
    expect(said('held')).toMatch(/kept its claims\. Its issues stay at `releasing`, still claimed/);
    expect(said('held')).toContain('POST /api/projects/proj-7/release-records');
    expect(said('held')).toContain('"return-to-gate"');
    expect(said('held')).not.toMatch(/claims were released/);
  });

  it('says a batch that shipped before the abort keeps the issues its finish closed', () => {
    expect(said('shipped')).toMatch(/already shipped, so the issues its finish closed stay closed/);
    expect(said('shipped')).not.toMatch(/claims were released/);
  });

  it('says a roster the abort is still returning has not been released yet', () => {
    expect(said('returning')).toMatch(/had not finished putting its roster back/);
    expect(said('returning')).not.toMatch(/claims were released/);
  });

  it('says a released roster had its claims released', () => {
    expect(said('released')).toMatch(/its claims were released/);
  });

  it('names each issue a finish closed before the abort beside a released roster', () => {
    const refusal = finishRefusal(
      new ReleaseBatchAbortedError('released', 'proj-7', ['iss-a', 'iss-b']),
    );
    expect(refusal?.cause).toEqual({
      code: 'RELEASE_BATCH_ABORTED',
      details: { account: 'released', closed: ['iss-a', 'iss-b'] },
    });
    expect(refusal?.message).toMatch(
      /already closed iss-a, iss-b before the abort, and they stay closed/,
    );
    expect(refusal?.message).toMatch(/the rest of its roster is back/);
  });

  // The judge at 93e2f8e: a person settling the batch had to look each uuid up before acting.
  it('names each closed issue by its key in the sentence, keeping the ids in the details', () => {
    const shown = new Map([
      ['u-12', 'ISS-12'],
      ['u-9', 'ISS-9'],
    ]);
    const refusal = finishRefusal(
      new ReleaseBatchAbortedError('held', 'proj-7', ['u-12', 'u-9'], shown),
    );
    expect(refusal?.message).toMatch(
      /already closed ISS-9, ISS-12 before the abort, and they stay/,
    );
    expect(refusal?.message).not.toMatch(/u-12|u-9/);
    expect(refusal?.cause).toEqual({
      code: 'RELEASE_BATCH_ABORTED',
      details: { account: 'held', closed: ['u-12', 'u-9'] },
    });
  });

  it('names a closed issue whose key was not read by its id, never dropping it', () => {
    const shown = new Map([['u-1', 'ISS-1']]);
    const message =
      finishRefusal(new ReleaseBatchAbortedError('released', 'proj-7', ['u-1', 'u-gone'], shown))
        ?.message ?? '';
    expect(message).toMatch(/already closed ISS-1, u-gone before the abort/);
  });

  it('names the one issue a finish closed beside a held roster, and the rest at releasing', () => {
    const message =
      finishRefusal(new ReleaseBatchAbortedError('held', 'proj-7', ['iss-a']))?.message ?? '';
    expect(message).toMatch(/closed iss-a before the abort, and it stays closed/);
    expect(message).toMatch(/closed iss-a before the abort, and it stays closed\. Every other/);
  });

  // release-records takes only unclaimed issues at the gate, so offering it beside the
  // return-to-gate abort sent a person to a 409 (the judge at 06bf45b90).
  it('gives a held roster the return-to-gate abort first and release-records after it', () => {
    const message = said('held');
    const abortAt = message.indexOf('"return-to-gate"');
    expect(abortAt).toBeGreaterThan(-1);
    expect(message.indexOf('/release-records')).toBeGreaterThan(abortAt);
    expect(message).not.toMatch(/release-records, or abort/);
  });

  it('keeps the whole-roster sentence and carries an empty list where nothing had closed', () => {
    const refusal = finishRefusal(new ReleaseBatchAbortedError('released', 'proj-7', []));
    expect(refusal?.cause).toEqual({
      code: 'RELEASE_BATCH_ABORTED',
      details: { account: 'released', closed: [] },
    });
    expect(refusal?.message).toBe(said('released'));
  });

  it('names no destination for a roster when no abort recorded one', () => {
    expect(said('unrecorded')).not.toMatch(/released|`releasing`|closed|gate/);
    expect(said('unrecorded')).toMatch(/each issue’s own status and notes are the account/);
  });
});

describe('finishRefusal — a release row carrying no version', () => {
  it('names RELEASE_VERSION_MISSING once, in the code', () => {
    const refusal = finishRefusal(new ReleaseVersionMissingError('run-7'));
    expect(refusal?.cause).toEqual({ code: 'RELEASE_VERSION_MISSING' });
    expect(refusal?.message).not.toContain('RELEASE_VERSION_MISSING');
    expect(refusal?.message).toMatch(/^Release run run-7 carries no version/);
  });

  it('names no internal function its reader could not act on', () => {
    const message = finishRefusal(new ReleaseVersionMissingError('run-7'))?.message ?? '';
    expect(message).not.toMatch(/createReleaseBatch|`[a-z]+[A-Z]\w*`/);
    expect(message).toMatch(/Abort this run and cut a new release\.$/);
  });
});

describe('issuesUnnamed — the path it sends is real', () => {
  it('names the project’s roster path', () => {
    const message = issuesUnnamed('proj-7').message;
    expect(message).toContain('GET /api/projects/proj-7/release-batches/roster');
    expect(message).not.toMatch(/\{projectId\}/);
  });
});

describe('finishRefusal — a finish already in flight', () => {
  it('names the batch’s real state path, not placeholders', () => {
    const refusal = finishRefusal(
      new ReleaseFinishInFlightError('r-1', 'a'.repeat(40), null, {
        projectId: 'proj-7',
        runId: 'run-7',
      }),
    );
    expect(refusal?.message).toContain('GET /api/projects/proj-7/release-batches/run-7/state');
    expect(refusal?.message).not.toMatch(/\{projectId\}|\{runId\}/);
  });
});

describe('finishRefusal — a finished batch asked about another commit', () => {
  const asked = 'b'.repeat(40);

  it('names the commit the batch finished for, the one asked, and the real state path', () => {
    const finished = 'a'.repeat(40);
    const refusal = finishRefusal(
      new ReleaseFinishedForOtherCommitError('r-1', finished, asked, {
        projectId: 'proj-7',
        runId: 'run-7',
      }),
    ) as HTTPException;

    expect(refusal.status).toBe(409);
    expect(refusal.cause).toEqual({
      code: 'RELEASE_FINISHED_FOR_OTHER_COMMIT',
      details: { requestId: 'r-1', finishedCommit: finished },
    });
    expect(refusal.message).toContain(`already finished for ${finished}`);
    expect(refusal.message).toContain(`this call names ${asked}`);
    expect(refusal.message).toContain('GET /api/projects/proj-7/release-batches/run-7/state');
  });

  it('says a claimless finish verified no commit at all', () => {
    const refusal = finishRefusal(
      new ReleaseFinishedForOtherCommitError('r-1', null, asked, {
        projectId: 'proj-7',
        runId: 'run-7',
      }),
    ) as HTTPException;

    expect(refusal.message).toContain('already finished with no named commit');
    expect(refusal.message).not.toContain('finished for null');
  });
});

describe('recordRefusal — a project with no release step', () => {
  it('answers with the one NO_RELEASE_GATE sentence every door reads, not a copy of its own', () => {
    const refused = recordRefusal(new NoReleaseGateError());
    expect(refused.status).toBe(409);
    expect(refused.message).toBe(releaseBlockerSentence('NO_RELEASE_GATE'));
    expect((refused.cause as { code?: string }).code).toBe('NO_RELEASE_GATE');
  });
});
