// @direct-test-of packages/contracts/src/release-page.ts
// @direct-test-of packages/core/src/release-batch/release-facts.ts
// The page reads each criterion as its release record weighed it (`criterionReadingsAt`, ISS-1001):
// these cases weigh through that one reading and list it through `claimsOf`.
import { describe, expect, it } from 'vitest';
import { BUILD, type Carried, criterion, MERGED, readClaims, verdict } from './claims.fixture.js';
import { claimableByRequirement, knownIssuesOf, requirementsOf, untracedOf } from './claims.js';

describe('the truth rule over the carried criteria', () => {
  const pass = criterion(1, 'BC-1', [verdict('pass', BUILD, '2026-10-09T10:00:00.000Z')]);
  const short = criterion(2, 'BC-2', [
    verdict('short', BUILD, '2026-10-09T10:00:00.000Z', { reason: 'only on desktop' }),
  ]);
  const mergedOnly = criterion(3, 'BC-3', [verdict('pass', MERGED, '2026-10-09T09:00:00.000Z')]);
  const failLater = criterion(4, 'BC-4', [
    verdict('pass', BUILD, '2026-10-09T09:00:00.000Z'),
    verdict('fail', BUILD, '2026-10-09T11:00:00.000Z', { reason: 'broke on reload' }),
  ]);
  const never = criterion(5, null, []);
  const claims = readClaims([pass, short, mergedOnly, failLater, never], BUILD, null, null);

  it('claims only the criterion whose newest verdict on the build is a pass', () => {
    expect(claims.map((c) => c.claim.claimed)).toEqual([true, false, false, false, false]);
  });

  it('lists every other carried criterion as a known issue, as its verdict on the build reads', () => {
    expect(knownIssuesOf(claims)).toEqual([
      expect.objectContaining({ bc: 'BC-2', standing: 'short', reason: 'only on desktop' }),
      expect.objectContaining({
        bc: 'BC-3',
        standing: 'not_judged',
        reason: null,
        elsewhere: { verdict: 'pass', commitSha: MERGED },
      }),
      expect.objectContaining({ bc: 'BC-4', standing: 'fail', reason: 'broke on reload' }),
      expect.objectContaining({ bc: null, standing: 'not_judged', elsewhere: null }),
    ]);
  });

  it('claims nothing where the release has no build', () => {
    expect(readClaims([pass], null, null, null).every((c) => !c.claim.claimed)).toBe(true);
  });

  it('proves a requirement criterion by a pass only, and counts the rest, a short among them, as unproven', () => {
    const reqs = requirementsOf(
      [
        {
          key: 'REQ-1',
          title: 'Reminders',
          completes: false,
          criteria: new Map([
            ['BC-1', 'A nurse sees the reminder'],
            ['BC-2', 'A doctor sees the report'],
          ]),
        },
      ],
      claims,
    );
    expect(reqs).toEqual([
      {
        key: 'REQ-1',
        title: 'Reminders',
        completes: false,
        proven: [
          {
            code: 'BC-1',
            statement: 'criterion 1',
            short: false,
            issueKey: 'ISS-1',
            n: 1,
            countedUnderCutover: false,
          },
        ],
        unproven: 3,
        business: {
          total: 2,
          proven: [{ code: 'BC-1', statement: 'A nurse sees the reminder' }],
        },
      },
    ]);
  });

  it('reads seven criteria proving one requirement criterion apart, and counts the requirement in its own criteria', () => {
    // J7 on 0.4.0-dev.222: REQ-34 drew `BC-18 A refusal says…` seven times, one row per ISS-451
    // criterion tracing it, and read 10 proven plus 30 unproven for a requirement of 26 criteria
    const traced = Array.from({ length: 7 }, (_, i) => ({
      ...criterion(i + 1, 'BC-18', [verdict('pass', BUILD, '2026-10-09T10:00:00.000Z')]),
      issueKey: 'ISS-451',
      requirementKey: 'REQ-34',
      statement: `field refusal ${i + 1} names what to fix`,
    }));
    const open = {
      ...criterion(8, 'BC-19', [verdict('fail', BUILD, '2026-10-09T10:00:00.000Z')]),
      issueKey: 'ISS-451',
      requirementKey: 'REQ-34',
    };
    const live = new Map<string, string>(
      Array.from({ length: 26 }, (_, i) => [`BC-${i + 1}`, `business criterion ${i + 1}`]),
    );
    live.set('BC-18', 'A refusal says in plain words what to fix, on that field.');
    const [req34] = requirementsOf(
      [{ key: 'REQ-34', title: 'Refusals', completes: false, criteria: live }],
      readClaims([...traced, open], BUILD, null, null),
    );
    const rows = req34?.proven ?? [];
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((p) => p.statement)).size).toBe(7);
    expect(new Set(rows.map((p) => `${p.issueKey}:${p.n}`)).size).toBe(7);
    expect(rows.every((p) => p.code === 'BC-18')).toBe(true);
    expect(req34?.business).toEqual({
      total: 26,
      proven: [
        { code: 'BC-18', statement: 'A refusal says in plain words what to fix, on that field.' },
      ],
    });
  });

  it('lists the carried criteria under no requirement apart, so the list sums to every carried criterion', () => {
    const reqs = [
      { key: 'REQ-1', title: 'Reminders', completes: false, criteria: new Map<string, string>() },
    ];
    const listed = requirementsOf(reqs, claims);
    const rest = untracedOf(reqs, claims);
    expect(rest).toEqual({ proven: [], unproven: 1 });
    const sum = [...listed, ...(rest ? [rest] : [])].reduce(
      (n, g) => n + g.proven.length + g.unproven,
      0,
    );
    expect(sum).toBe(claims.length);
    expect(untracedOf(reqs, claims.slice(0, 4))).toBeNull();
  });
});

describe('proven is the rule a requirement counts by: requirements:unverifiedWhy (BC-5)', () => {
  // QA 0.4.0-dev.218 read the header and the list by one rule; the owner's ruling of 2026-10-14 makes
  // that rule the requirement's own (REQ-35 decision 7b261fca): a short is met short of its wording
  // and is never verified, and under an independent judge only the judge's pass is
  const rows = [
    criterion(1, 'BC-1', [verdict('pass', BUILD, '2026-10-09T10:00:00.000Z')]),
    criterion(2, 'BC-2', [verdict('short', BUILD, '2026-10-09T10:00:00.000Z')]),
    criterion(3, 'BC-3', [verdict('fail', BUILD, '2026-10-09T10:00:00.000Z')]),
    criterion(4, 'BC-4', []),
  ];
  const claims = readClaims(rows, BUILD, null, null);
  const req = {
    key: 'REQ-1',
    title: 'r',
    completes: false,
    criteria: new Map(rows.map((r) => [r.bc as string, r.statement])),
  };

  it('lists a pass as proven and counts a short with the rest as unproven', () => {
    const [listed] = requirementsOf([req], claims);
    expect(
      listed?.proven.map((p) => [p.code, p.short]),
      'REQ-35 decision 7b261fca: a short is never verified',
    ).toEqual([['BC-1', false]]);
    expect(listed?.unproven).toBe(3);
    expect(listed?.business?.proven.map((p) => p.code)).toEqual(['BC-1']);
  });

  it('keeps highlights and media pass-only: a short is not claimed', () => {
    expect([...(claimableByRequirement(claims).get('REQ-1') ?? [])]).toEqual(['BC-1']);
  });

  it('counts a pass on an earlier build as not proven on this one, the earlier verdict kept as where it was judged', () => {
    const earlier = readClaims(
      [criterion(1, 'BC-1', [verdict('pass', MERGED, '2026-10-09T12:00:00.000Z')])],
      BUILD,
      null,
      null,
    );
    expect(requirementsOf([req], earlier)[0]).toMatchObject({ proven: [], unproven: 1 });
    expect(knownIssuesOf(earlier)[0]).toMatchObject({
      standing: 'not_judged',
      elsewhere: { verdict: 'pass', commitSha: MERGED },
    });
  });

  it('reads a release nobody cut by its newest verdicts and claims nothing, a short not proven', () => {
    const none = readClaims(rows, null, null, null);
    expect(requirementsOf([req], none)[0]?.proven.map((p) => [p.code, p.short])).toEqual([
      ['BC-1', false],
    ]);
    expect(claimableByRequirement(none).size).toBe(0);
  });

  // catalog-api 0.1.0 on dev: a draft listed its 133 criteria as proven and again as "not yet judged"
  it('lists a draft criterion the page counts proven never also as a known issue', () => {
    const none = readClaims(rows, null, null, null);
    expect(
      knownIssuesOf(none).map((k) => [k.bc, k.standing, k.elsewhere?.verdict ?? null]),
    ).toEqual([
      ['BC-2', 'not_judged', 'short'],
      ['BC-3', 'not_judged', 'fail'],
      ['BC-4', 'not_judged', null],
    ]);
  });
});

describe('under an independent judge, only the judge proves a criterion on the page', () => {
  const builders = criterion(1, 'BC-1', [
    verdict('pass', BUILD, '2026-10-09T10:00:00.000Z', { byBuilder: true }),
  ]);
  const nobodys = criterion(2, 'BC-2', [
    verdict('pass', BUILD, '2026-10-09T10:00:00.000Z', { authored: false }),
  ]);
  const judgeThenBuilder = criterion(3, 'BC-3', [
    verdict('pass', BUILD, '2026-10-09T09:00:00.000Z'),
    verdict('short', BUILD, '2026-10-09T11:00:00.000Z', { byBuilder: true }),
  ]);

  it("counts neither the builder's own pass nor one naming no author, and says why on the known issue", () => {
    const claims = readClaims([builders, nobodys], BUILD, 'independent', null);
    expect(
      claims.map((c) => c.proven),
      "REQ-35 decision 7b261fca: under an independent judge only the judge's pass is verified",
    ).toEqual([false, false]);
    expect(claims.map((c) => c.claim.claimed)).toEqual([false, false]);
    expect(knownIssuesOf(claims)).toEqual([
      expect.objectContaining({
        bc: 'BC-1',
        standing: 'not_judged',
        reason:
          "passed by the run that built it, and a builder's own pass never counts where gate builder_verdict is enforced (gates.overrides.builder_verdict relaxes it)",
      }),
      expect.objectContaining({
        bc: 'BC-2',
        standing: 'not_judged',
        reason: "passed with no recorded author, so nothing shows it is the independent judge's",
      }),
    ]);
  });

  it("reads the judge's pass past the builder's newer short, as coverage does", () => {
    const [claim] = readClaims([judgeThenBuilder], BUILD, 'independent', null);
    expect(claim).toMatchObject({ proven: true, claim: { claimed: true } });
  });

  it("does not count the builder's pass recorded after the cutover under any qa (REQ-74 BC-2)", () => {
    const late = criterion(1, 'BC-1', [
      verdict('pass', BUILD, '2026-10-26T10:00:00.000Z', { byBuilder: true }),
    ]);
    expect(readClaims([late], BUILD, 'self', null)[0]?.proven).toBe(false);
    expect(readClaims([late], BUILD, null, null)[0]?.proven).toBe(false);
  });

  it("lists the builder's pass recorded before the cutover as proven under self QA, marked as the builder's", () => {
    const claims = readClaims([builders], BUILD, 'self', null);
    expect(claims[0]).toMatchObject({ proven: true, underCutover: true });
    expect(untracedOf([], claims)?.proven).toEqual([
      expect.objectContaining({ n: 1, countedUnderCutover: true }),
    ]);
  });
});

// ISS-900: where production names no commit it serves, a release is its agent's record by version and
// names no build; a pass judged on that release is claimed on its own page, and on no other release's.
describe('a release recorded by version alone claims a pass judged on that version', () => {
  const onRelease = (version: string, at: string) =>
    verdict('pass', null, at, { identityKind: 'release', releaseVersion: version });

  it('claims a pass judged on its own version, with no build', () => {
    const own = criterion(1, 'BC-1', [onRelease('0.76.0', '2026-11-02T10:00:00.000Z')]);
    const [read] = readClaims([own], null, 'independent', null, new Set(['0.76.0']));
    expect(read?.claim).toEqual({ claimed: true, at: '2026-11-02T10:00:00.000Z' });
    expect(read?.proven).toBe(true);
  });

  it('claims nothing on another release, and nothing from a release verdict on a build', () => {
    const other = criterion(1, 'BC-1', [onRelease('0.75.0', '2026-11-02T10:00:00.000Z')]);
    const [unbuilt] = readClaims([other], null, 'independent', null, new Set(['0.76.0']));
    expect(unbuilt?.claim.claimed).toBe(false);
    expect(unbuilt?.proven).toBe(false);
    const [built] = readClaims([other], BUILD, 'independent', null, new Set(['0.76.0']));
    expect(built?.claim.claimed).toBe(false);
  });
});

// ISS-914: the page counts a code property by its review's commit pass, as the release record does
describe('a code-property criterion on a release judged on a testing environment', () => {
  const at = '2026-11-03T10:00:00.000Z';
  const reviewed = (cls: Carried['class'], reopenedAt: string | null = null) => ({
    ...criterion(1, 'BC-1', [verdict('pass', MERGED, at)]),
    class: cls,
    reopenedAt,
  });

  it("claims the review's commit pass at another commit", () => {
    const [read] = readClaims([reviewed('code_property')], BUILD, null, 'stg');
    expect(read).toMatchObject({ proven: true, claim: { claimed: true }, unverified: null });
    expect(knownIssuesOf(read ? [read] : [])).toEqual([]);
  });

  it('claims no observable one by it, nor a review before the last reopen', () => {
    const [observable] = readClaims([reviewed('observable')], BUILD, null, 'stg');
    expect(observable).toMatchObject({ proven: false, claim: { claimed: false } });
    expect(observable?.unverified).toMatch(/^Not judged on stg: /);
    const [stale] = readClaims(
      [reviewed('code_property', '2026-11-03T11:00:00.000Z')],
      BUILD,
      null,
      'stg',
    );
    expect(stale).toMatchObject({ proven: false, claim: { claimed: false } });
    expect(stale?.unverified).toBe(
      "Not reviewed: a code property is proven by the review's pass on the diff",
    );
  });
});
