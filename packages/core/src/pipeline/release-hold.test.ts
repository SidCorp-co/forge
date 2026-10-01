import { describe, expect, it } from 'vitest';
import { standingSentence, verdictStanding } from '../issues/verdict-standing.js';
import { runnerHoldClause } from '../release-batch/blocker-sentences.js';
import type { ServingReading } from '../release-batch/serving-reading.js';
import type { RunnerHold } from '../runners/ineligible.js';
import { PipelineConfigUnreadable } from './pipeline-config-unreadable.js';
import {
  cutFailedHold,
  readReleaseHold,
  refusalHold,
  releaseHoldComment,
  runtimeUnroutedHold,
  saidKey,
  saidOf,
  sameReleaseHold,
  unreadableHoldOf,
  withoutAges,
  withoutReadingTimes,
  withoutResetDrift,
} from './release-hold.js';
import { criteriaHold } from './release-hold-criteria.js';

const SERVING = '33637c612ef15be6f924520c0d201a0889d8ed7e';
const HOST = 'https://app.test/build-info';
const READ_AT = '2026-09-26T23:55:00.000Z';
const NO_BINDING_ROUTE =
  'bind a deploy binding Forge deploys through whose provider reports the commit a deployment ' +
  'built (Coolify does), or declare `verify.probes` on the live deploy binding';
const PROBE_ROUTE =
  'declare `verify.probes` on the live deploy binding, naming an address of this project that ' +
  'answers with the commit it is serving';

const live = (readAt = READ_AT): ServingReading => ({
  kind: 'serving',
  served: [{ commit: SERVING, where: HOST }],
  unread: [],
  readAt,
});

const REPORT = {
  issueId: 'iss-1',
  broken: [],
  serving: live(),
  owed: { deployment: true, declared: [], unread: null },
  uncorroborated: [],
  unearned: [
    {
      criterion: 1,
      verdict: 'pass',
      standing: 'unwitnessed' as const,
      why: 'no runtime witnessed it',
    },
    { criterion: 3, verdict: null, standing: null, why: 'no verdict was recorded for it' },
  ],
};

describe('the hold a row carries (ISS-1215)', () => {
  it('names every held criterion by number and why', () => {
    const hold = criteriaHold(REPORT);
    expect(hold.code).toBe('RELEASE_CRITERIA_UNEARNED');
    expect(hold.reason).toContain('criterion 1: no runtime witnessed it');
    expect(hold.reason).toContain('criterion 3: no verdict was recorded for it');
  });

  it('owes a person, since nothing dispatched claims a row at awaiting_release', () => {
    expect(criteriaHold(REPORT).owes).toBe('human');
  });

  it('states each reason once, with every criterion it holds', () => {
    const never = 'no verdict was recorded for it';
    const unearned = [1, 2, 3, 5].map((criterion) => ({
      criterion,
      verdict: null,
      standing: null,
      why: never,
    }));
    const witnessed = {
      criterion: 4,
      verdict: 'pass',
      standing: 'unwitnessed' as const,
      why: 'no runtime',
    };
    const { reason } = criteriaHold({ ...REPORT, unearned: [...unearned, witnessed] });
    expect(reason.split(never)).toHaveLength(2);
    expect(reason).toContain(`each of criteria 1, 2, 3 and 5: ${never}`);
    expect(reason).toContain('criterion 4: no runtime');
  });

  // ISS-1286 — the sentence is built from a reading, never from a commit stored on the issue.
  it('names the host asked, the commit it answered and the moment it was asked', () => {
    const reason = criteriaHold(REPORT).reason;
    expect(reason).toContain(`\`${SERVING}\``);
    expect(reason).toContain(HOST);
    expect(reason).toContain(`read at ${READ_AT}`);
    expect(reason).not.toContain('records as serving it');
  });

  it('says what is missing where nothing can be read, and the route the reading names, and no commitUrl', () => {
    const missing = 'this project has no active deploy binding';
    const serving = { kind: 'undeclared', missing, route: NO_BINDING_ROUTE } as const;
    const reason = criteriaHold({ ...REPORT, serving }).reason;
    expect(reason).toContain(`nothing here can read what this project is serving: ${missing}`);
    expect(reason).toContain(NO_BINDING_ROUTE);
    expect(reason).not.toContain('commitUrl');
    expect(reason).not.toContain(SERVING);
  });

  // ISS-1346 judge finding 4 — an epodsystem project was told to deploy through Coolify.
  it('offers a project bound through a provider that reports nothing no Coolify binding', () => {
    const missing =
      'its deploy bindings go through epodsystem, and none of them reports the commit';
    const serving = { kind: 'undeclared', missing, route: PROBE_ROUTE } as const;
    const reason = criteriaHold({ ...REPORT, serving }).reason;
    expect(reason).toContain(PROBE_ROUTE);
    expect(reason).not.toMatch(/Coolify/);
  });

  it('says why nothing could be read, and that the verdict still earns the criterion', () => {
    const reason = criteriaHold({
      ...REPORT,
      serving: {
        kind: 'unreadable',
        why: 'https://app.test/build-info is unreachable (ECONNREFUSED)',
        hosts: [HOST],
        readAt: READ_AT,
      },
    }).reason;
    expect(reason).toContain('ECONNREFUSED');
    expect(reason).toContain('still earns the criterion');
  });

  // ISS-1346 judge finding 2 — staging and production on two commits is between releases, not a fault.
  it('pairs each served commit with where it runs, and calls two commits no fault', () => {
    const staging = 'da74b598bcae5a53a1c0f2b9e3d7a41f6c8b2d90';
    const app =
      "Coolify target `App` (preview), Forge's deployment k8kw finished 2026-09-29T18:00:00.000Z";
    const web =
      "Coolify target `Web` (live), Forge's deployment w80k finished 2026-09-29T17:00:00.000Z";
    const home =
      "Coolify target `Home` (live), Forge's deployment k0co finished 2026-09-29T17:01:00.000Z";
    const reason = criteriaHold({
      ...REPORT,
      serving: {
        kind: 'serving',
        served: [
          { commit: staging, where: app },
          { commit: SERVING, where: web },
          { commit: SERVING, where: home },
        ],
        unread: [],
        readAt: READ_AT,
      },
    }).reason;
    expect(reason).toContain(`\`${staging}\` at ${app}; \`${SERVING}\` at ${web} and ${home}`);
    expect(reason).not.toContain('more than one commit is running');
  });

  it('reads back what was stored, and refuses a shape it cannot read', () => {
    const hold = criteriaHold(REPORT);
    expect(
      readReleaseHold({ ...hold, at: '2026-09-24T00:00:00Z', status: 'awaiting_release' }),
    ).toEqual(hold);
    expect(readReleaseHold(null)).toBeNull();
    expect(readReleaseHold({ code: 'X', reason: 'r', waitingFor: 'w', owes: 'nobody' })).toBeNull();
    expect(readReleaseHold(['not', 'a', 'hold'])).toBeNull();
  });

  it('treats a hold written at another moment as the same hold, and a new reason as a new one', () => {
    const hold = criteriaHold(REPORT);
    expect(sameReleaseHold(readReleaseHold({ ...hold, at: 'earlier' }), hold)).toBe(true);
    const moved = criteriaHold({ ...REPORT, unearned: REPORT.unearned.slice(1) });
    expect(sameReleaseHold(hold, moved)).toBe(false);
    expect(sameReleaseHold(null, hold)).toBe(false);
  });

  /**
   * ISS-1286 over ISS-1215 — the reading's clock value moves on every sweep tick while the answer
   * stands still. A rewritten hold is a re-commented hold, so a tick that read the same answer an
   * hour later must not count as a new reason.
   */
  it('reads a later reading of the same answer as the same hold', () => {
    const first = criteriaHold(REPORT);
    const anHourLater = criteriaHold({ ...REPORT, serving: live('2026-09-27T00:55:00.000Z') });
    expect(first.reason).not.toBe(anHourLater.reason);
    expect(sameReleaseHold(first, anHourLater)).toBe(true);
  });

  it('reads a reading that answered a different commit as a different hold', () => {
    const moved = criteriaHold({
      ...REPORT,
      serving: {
        kind: 'serving',
        served: [{ commit: 'da74b598bcae5a53a1c0f2b9e3d7a41f6c8b2d90', where: HOST }],
        unread: [],
        readAt: READ_AT,
      },
    });
    expect(sameReleaseHold(criteriaHold(REPORT), moved)).toBe(false);
  });

  it('reads a reading taken at another host as a different hold', () => {
    const elsewhere = criteriaHold({
      ...REPORT,
      serving: {
        kind: 'serving',
        served: [{ commit: SERVING, where: 'https://other.test/h' }],
        unread: [],
        readAt: READ_AT,
      },
    });
    expect(sameReleaseHold(criteriaHold(REPORT), elsewhere)).toBe(false);
  });

  it('takes out the reading time and nothing else', () => {
    expect(withoutReadingTimes(`serving ${SERVING}, read at ${READ_AT}, at ${HOST}`)).toBe(
      `serving ${SERVING}, read at a moment, at ${HOST}`,
    );
    expect(withoutReadingTimes('no reading in this one')).toBe('no reading in this one');
  });

  it('owes a self-clearing refusal to the release path and every other to a person', () => {
    expect(refusalHold('BATCH_IN_FLIGHT', ['in flight']).owes).toBe('agent');
    expect(refusalHold('CLAIM_CONFLICT', ['claimed']).owes).toBe('agent');
    expect(refusalHold('NO_RUNNER_ONLINE', ['none online']).owes).toBe('human');
  });

  it('says a failed cut left the row untouched', () => {
    expect(cutFailedHold(['lock timeout']).reason).toContain('not claimed, not moved');
  });

  it('writes a comment carrying the reason, who owes it and the code', () => {
    const body = releaseHoldComment(criteriaHold(REPORT));
    expect(body).toContain('criterion 3: no verdict was recorded for it');
    expect(body).toContain('which a person owes');
    expect(body).toContain('`release-hold: RELEASE_CRITERIA_UNEARNED`');
    expect(body).not.toContain('oldest of them alone');
  });

  it('says a shared hold is commented on the oldest of the rows it holds alone', () => {
    const body = releaseHoldComment(refusalHold('NO_RUNNER_ONLINE', ['none online']), true);
    expect(body).toContain('on every issue of this project it holds');
    expect(body).toContain('oldest of them alone');
  });

  // ISS-1346 judge r2 finding 2: a comment standing for several rows named none of them.
  it('names each row a shared hold stands for, in the order it was given them', () => {
    const hold = refusalHold('NO_RUNNER_ONLINE', ['none online']);
    const body = releaseHoldComment(hold, true, ['ISS-5', 'ISS-3', 'ISS-4']);
    expect(body).toContain(
      'When this was written it held 3 issues of this project, oldest merge first: `ISS-5`, `ISS-3`, `ISS-4`.',
    );
    expect(releaseHoldComment(hold, false, ['ISS-5'])).not.toContain('When this was written');
  });
});

describe('a reason said once per hold (ISS-1346 judge r2 finding 4)', () => {
  const offline = refusalHold('NO_RUNNER_ONLINE', ['`sid-xeon-1` reported itself offline.']);
  const cloning = refusalHold('NO_RUNNER_ONLINE', ['`sid-xeon-1` has not finished provisioning.']);

  it('keys two holds alike where only a reading time moves, and apart where the words do', () => {
    const at = (t: string) => ({ ...offline, reason: `${offline.reason} read at ${t}` });
    expect(saidKey(at('2026-09-30T01:00:00.000Z'))).toBe(saidKey(at('2026-09-30T02:00:00.000Z')));
    expect(saidKey(offline)).not.toBe(saidKey(cloning));
  });

  it('reads what a stored hold says it has said, and nothing from one stored before it said any', () => {
    expect(saidOf({ ...offline, said: [saidKey(offline)] })).toEqual([saidKey(offline)]);
    expect(saidOf({ ...offline })).toEqual([]);
    expect(saidOf(null)).toEqual([]);
  });
});

// ISS-1346 criterion 25: the reading is the report's, so the hold says it once whatever each
// criterion's reason is — the reasons below are the ones `standingSentence` writes, not stand-ins.
describe('a criteria hold names what is served once', () => {
  const JUDGED_A = 'dce6f354c727baa81c681f144cbadf30050eabfc';
  const JUDGED_B = '72b94aff846279e6bfb4f6d347586ee67a3cd5f1';
  const times = (text: string, what: string) => text.split(what).length - 1;
  const unearnedAt = (criterion: number, value: string, serving: ServingReading) => {
    const standing = verdictStanding({ kind: 'source', value }, serving, { source: JUDGED_A });
    return {
      criterion,
      verdict: 'pass',
      standing,
      why: standingSentence(standing, { kind: 'source', value }, serving, { source: JUDGED_A }),
    };
  };

  it('names the served commits once where criteria were judged at two commits it is not serving', () => {
    const reading = live();
    const unearned = [unearnedAt(1, JUDGED_A, reading), unearnedAt(2, JUDGED_B, reading)];
    const { reason } = criteriaHold({ ...REPORT, serving: reading, unearned });
    expect(reason).toContain(`criterion 1: judged at ${JUDGED_A}`);
    expect(reason).toContain(`criterion 2: judged at ${JUDGED_B}`);
    expect(times(reason, `\`${SERVING}\``)).toBe(1);
    expect(times(reason, HOST)).toBe(1);
    expect(times(reason, READ_AT)).toBe(1);
  });

  it('names each commit a disagreeing fleet answered once, beside where it runs, and what answered nothing', () => {
    const other = '1d1d63492f0ab8c5e5c3d1c6f6bb0b3b0c6a9f11';
    const reading: ServingReading = {
      kind: 'serving',
      served: [
        { commit: SERVING, where: HOST },
        { commit: other, where: 'https://second.test/health' },
      ],
      unread: ['https://third.test/health is unreachable (ECONNREFUSED)'],
      readAt: READ_AT,
    };
    const unearned = [unearnedAt(1, JUDGED_A, reading), unearnedAt(2, JUDGED_B, reading)];
    const { reason } = criteriaHold({ ...REPORT, serving: reading, unearned });
    expect(reason).toContain(
      `\`${SERVING}\` at ${HOST}; \`${other}\` at https://second.test/health`,
    );
    expect(times(reason, other)).toBe(1);
    expect(times(reason, 'ECONNREFUSED')).toBe(1);
    expect(reason).not.toContain('more than one commit is running');
  });

  it('still names the served commits where no criterion was judged anywhere', () => {
    const { reason } = criteriaHold(REPORT);
    expect(times(reason, `\`${SERVING}\``)).toBe(1);
  });

  it('says once what is missing where a source verdict stands unwitnessed and nothing can be read', () => {
    const missing = 'this project has no active deploy binding';
    const serving = { kind: 'undeclared', missing, route: NO_BINDING_ROUTE } as const;
    const unearned = [unearnedAt(1, JUDGED_A, serving)];
    expect(unearned[0]?.standing).toBe('unwitnessed');
    const { reason } = criteriaHold({ ...REPORT, serving, unearned });
    expect(reason).toContain('never that the code was running');
    expect(times(reason, missing)).toBe(1);
  });

  it('says once what could not be read, where and when, where a source verdict stands unwitnessed', () => {
    const why = 'https://x.test/h is unreachable (getaddrinfo ENOTFOUND)';
    const serving = { kind: 'unreadable', why, hosts: [HOST], readAt: READ_AT } as const;
    const unearned = [unearnedAt(1, JUDGED_A, serving)];
    expect(unearned[0]?.standing).toBe('unwitnessed');
    const { reason } = criteriaHold({ ...REPORT, serving, unearned });
    expect(times(reason, why)).toBe(1);
    expect(times(reason, HOST)).toBe(1);
    expect(times(reason, READ_AT)).toBe(1);
  });
});

describe('a standing refusal is one reason however long it stands (ISS-1215)', () => {
  const box = (over: Partial<RunnerHold>): RunnerHold => ({
    deviceName: 'dev1',
    reason: 'stale',
    lastSeenSeconds: 60,
    reporting: false,
    ...over,
  });
  const refusal = (hold: RunnerHold) => refusalHold('NO_RUNNER_ONLINE', [runnerHoldClause(hold)]);

  it.each([
    ['stale', false],
    ['disconnected', false],
    ['auth', true],
    ['auth', false],
  ] as const)('drops the heartbeat age from a %s box (reporting: %s)', (reason, reporting) => {
    const first = refusal(box({ reason, reporting, lastSeenSeconds: 60 }));
    const later = refusal(box({ reason, reporting, lastSeenSeconds: 120 }));
    expect(first.reason).not.toMatch(/\d+s ago/);
    expect(sameReleaseHold(first, later)).toBe(true);
  });

  it('still reads a different box or a different reading as a new reason', () => {
    const first = refusal(box({}));
    expect(sameReleaseHold(first, refusal(box({ deviceName: 'dev2' })))).toBe(false);
    expect(sameReleaseHold(first, refusal(box({ reason: 'disconnected' })))).toBe(false);
  });

  // ISS-1346 judge finding 5 — ISS-596 took nine comments in 80 minutes from one standing limit.
  it('reads a rate limit whose reset moved by milliseconds as the same reason', () => {
    const at = (until: string) => refusal(box({ reason: 'rate-limited', detail: until }));
    const first = at('2026-09-30T00:00:09.790Z');
    const drifted = at('2026-09-30T00:00:09.375Z');
    expect(first.reason).not.toBe(drifted.reason);
    expect(sameReleaseHold(first, drifted)).toBe(true);
  });

  it('reads a quarantine whose reset moved inside the minute as the same reason', () => {
    const at = (until: string) => refusal(box({ reason: 'quarantined', detail: until }));
    expect(sameReleaseHold(at('2026-09-30T01:05:02.000Z'), at('2026-09-30T01:05:41.912Z'))).toBe(
      true,
    );
  });

  it('reads a reset that moved by a minute or more as a new reason', () => {
    const at = (until: string) => refusal(box({ reason: 'rate-limited', detail: until }));
    expect(sameReleaseHold(at('2026-09-30T00:00:09.790Z'), at('2026-09-30T05:00:09.790Z'))).toBe(
      false,
    );
    expect(sameReleaseHold(at('2026-09-30T00:00:59.000Z'), at('2026-09-30T00:01:00.000Z'))).toBe(
      false,
    );
  });

  it('reads the reset to the minute and leaves every other time alone', () => {
    expect(withoutResetDrift('is rate limited until 2026-09-30T00:00:09.790Z. Wait.')).toBe(
      'is rate limited until 2026-09-30T00:00Z. Wait.',
    );
    expect(withoutResetDrift('finished 2026-09-30T00:00:09.790Z')).toBe(
      'finished 2026-09-30T00:00:09.790Z',
    );
    expect(withoutResetDrift('held until 2026-09-30T00:00:09.790Z')).toBe(
      'held until 2026-09-30T00:00:09.790Z',
    );
  });

  it('reads any other time that moved inside the minute as a new reason', () => {
    const at = (until: string) => refusalHold('RELEASE_CUT_REFUSED', [`held until ${until}.`]);
    expect(sameReleaseHold(at('2026-09-30T00:00:09.790Z'), at('2026-09-30T00:00:09.375Z'))).toBe(
      false,
    );
  });

  it('keeps text that carries no age exactly as it was', () => {
    expect(withoutAges('No runner is online. Pair a box.')).toBe(
      'No runner is online. Pair a box.',
    );
  });
});

/** ISS-1346 — where nothing can read what a project serves, the hold is the project's. */
describe('the hold a project with no runtime route carries', () => {
  const missing = 'its deploy bindings go through epodsystem, and none of them reports the commit';

  it('names the missing piece and the route it was given, and owes a person', () => {
    const hold = runtimeUnroutedHold(missing, PROBE_ROUTE);
    expect(hold.code).toBe('RELEASE_RUNTIME_UNROUTED');
    expect(hold.owes).toBe('human');
    expect(hold.reason).toContain(missing);
    expect(hold.reason).toContain(PROBE_ROUTE);
    expect(hold.reason).not.toMatch(/Coolify/);
  });

  it("says it is the project's to answer", () => {
    const reason = runtimeUnroutedHold(missing, PROBE_ROUTE).reason;
    expect(reason).toContain("the project's to answer and not this issue's");
  });
});

describe('no hold sentence names the retired commit endpoint (ISS-1346)', () => {
  const readings: ServingReading[] = [
    live(),
    { kind: 'undeclared', missing: 'no active deploy binding', route: NO_BINDING_ROUTE },
    { kind: 'unreadable', why: 'down', hosts: [HOST], readAt: READ_AT },
    { kind: 'unreadable', why: 'refused', hosts: [], readAt: READ_AT },
  ];

  it('the criteria hold carries no commitUrl, whichever reading it was written from', () => {
    for (const serving of readings) {
      expect(criteriaHold({ ...REPORT, serving }).reason).not.toMatch(/commitUrl|commit endpoint/);
    }
  });

  it('the unrouted hold carries no commitUrl', () => {
    expect(runtimeUnroutedHold('x', NO_BINDING_ROUTE).reason).not.toMatch(
      /commitUrl|commit endpoint/,
    );
  });
});

describe('a refused stored pipelineConfig holds on what is refused (ISS-1368)', () => {
  it('names the refused key, and does not send the person to releaseRuntimes', () => {
    const path = 'pipelineConfig.autoProdDeploy';
    const refused = [{ path, message: 'expected boolean', key: 'autoProdDeploy', stored: 'true' }];
    const hold = unreadableHoldOf(new PipelineConfigUnreadable('p-1', refused), 'declaration');

    expect(hold.code).toBe('RELEASE_CRITERIA_UNREADABLE');
    expect(hold.reason).toContain(path);
    expect(hold.reason).not.toContain('releaseRuntimes');
    expect(hold.waitingFor).toBe("this project's stored `pipelineConfig` to be corrected");
  });
});
