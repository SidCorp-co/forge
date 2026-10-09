import { describe, expect, it } from 'vitest';
import {
  type CarriedCriterion,
  type CarriedVerdict,
  claimableByRequirement,
  type IssueFile,
  knownIssuesOf,
  mediaOf,
  readClaims,
  requirementsOf,
  untracedOf,
} from './claims.js';

const BUILD = 'a'.repeat(40);
const MERGED = 'b'.repeat(40);

let seq = 0;
function verdict(
  v: CarriedVerdict['verdict'],
  commitSha: string | null,
  at: string,
  extra: Partial<CarriedVerdict> = {},
): CarriedVerdict {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    verdict: v,
    identityKind: commitSha ? 'commit' : null,
    commitSha,
    at,
    reason: null,
    evidence: [],
    ...extra,
  };
}

function criterion(n: number, bc: string | null, verdicts: CarriedVerdict[]): CarriedCriterion {
  return {
    issueId: 'issue-1',
    issueKey: 'ISS-1',
    requirementKey: bc ? 'REQ-1' : null,
    n,
    statement: `criterion ${n}`,
    bc,
    verdicts,
  };
}

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
  const claims = readClaims([pass, short, mergedOnly, failLater, never], BUILD);

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
    expect(readClaims([pass], null).every((c) => !c.claim.claimed)).toBe(true);
  });

  it('proves a requirement criterion by a pass or a short, marks the short, and counts the rest as unproven', () => {
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
          { code: 'BC-1', statement: 'A nurse sees the reminder', short: false, issueKey: 'ISS-1' },
          { code: 'BC-2', statement: 'A doctor sees the report', short: true, issueKey: 'ISS-1' },
        ],
        unproven: 2,
      },
    ]);
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

describe('the media a highlight may show', () => {
  const files: IssueFile[] = [
    { id: 'f-shot', issueId: 'issue-1', name: 'shot.png', mime: 'image/png', bytes: 2048 },
    { id: 'f-clip', issueId: 'issue-1', name: 'clip.webm', mime: 'video/webm', bytes: 900_000 },
    { id: 'f-log', issueId: 'issue-1', name: 'judge.log', mime: 'text/plain', bytes: 10 },
    {
      id: 'f-huge',
      issueId: 'issue-1',
      name: 'huge.webm',
      mime: 'video/webm',
      bytes: 11 * 1024 * 1024,
    },
    { id: 'f-other', issueId: 'issue-2', name: 'clip.webm', mime: 'video/webm', bytes: 10 },
    { id: 'f-short', issueId: 'issue-1', name: 'short.webm', mime: 'video/webm', bytes: 10 },
  ];
  const claimed = criterion(1, 'BC-1', [
    verdict('pass', BUILD, '2026-10-09T10:00:00.000Z', {
      evidence: ['shot.png', 'clip.webm', 'judge.log', 'huge.webm'],
    }),
  ]);
  const held = criterion(2, 'BC-2', [
    verdict('short', BUILD, '2026-10-09T10:00:00.000Z', { evidence: ['short.webm'] }),
  ]);

  it('takes what a claimed pass on the build cites, on its own issue, clips first, within the ceiling', () => {
    const media = mediaOf(readClaims([claimed, held], BUILD), files, BUILD);
    expect(media.map((m) => [m.attachmentId, m.kind])).toEqual([
      ['f-clip', 'clip'],
      ['f-shot', 'picture'],
    ]);
    expect(media[0]).toMatchObject({
      issueKey: 'ISS-1',
      criterion: { n: 1, bc: 'BC-1' },
      commitSha: BUILD,
      verdictId: claimed.verdicts[0]?.id,
    });
  });

  it('shows nothing a pass on another build cites', () => {
    const elsewhere = criterion(1, 'BC-1', [
      verdict('pass', MERGED, '2026-10-09T10:00:00.000Z', { evidence: ['clip.webm'] }),
    ]);
    expect(mediaOf(readClaims([elsewhere], BUILD), files, BUILD)).toEqual([]);
  });
});

describe('proven is one rule: criterionCountsAsPass (BC-5)', () => {
  // QA 0.4.0-dev.218: the header read 9 of 26 (a short counts as a pass, as the gate and the release
  // record count) while the list showed 6; both now read the one rule, and a short is marked
  const rows = [
    criterion(1, 'BC-1', [verdict('pass', BUILD, '2026-10-09T10:00:00.000Z')]),
    criterion(2, 'BC-2', [verdict('short', BUILD, '2026-10-09T10:00:00.000Z')]),
    criterion(3, 'BC-3', [verdict('fail', BUILD, '2026-10-09T10:00:00.000Z')]),
    criterion(4, 'BC-4', []),
  ];
  const claims = readClaims(rows, BUILD);
  const req = {
    key: 'REQ-1',
    title: 'r',
    completes: false,
    criteria: new Map(rows.map((r) => [r.bc as string, r.statement])),
  };

  it('lists a pass and a short as proven, the short marked, and counts the rest unproven', () => {
    const [listed] = requirementsOf([req], claims);
    expect(listed?.proven.map((p) => [p.code, p.short])).toEqual([
      ['BC-1', false],
      ['BC-2', true],
    ]);
    expect(listed?.unproven).toBe(2);
  });

  it('keeps highlights and media pass-only: a short is not claimed', () => {
    expect([...(claimableByRequirement(claims).get('REQ-1') ?? [])]).toEqual(['BC-1']);
  });

  it('counts a pass on an earlier build as not proven on this one, the earlier verdict kept as where it was judged', () => {
    const earlier = readClaims(
      [criterion(1, 'BC-1', [verdict('pass', MERGED, '2026-10-09T12:00:00.000Z')])],
      BUILD,
    );
    expect(requirementsOf([req], earlier)[0]).toMatchObject({ proven: [], unproven: 1 });
    expect(knownIssuesOf(earlier)[0]).toMatchObject({
      standing: 'not_judged',
      elsewhere: { verdict: 'pass', commitSha: MERGED },
    });
  });

  it('reads a release nobody cut by its newest verdicts, as its record counts it, and claims nothing', () => {
    const none = readClaims(rows, null);
    expect(requirementsOf([req], none)[0]?.proven.map((p) => [p.code, p.short])).toEqual([
      ['BC-1', false],
      ['BC-2', true],
    ]);
    expect(claimableByRequirement(none).size).toBe(0);
  });
});
