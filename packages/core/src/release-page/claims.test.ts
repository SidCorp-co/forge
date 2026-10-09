import { describe, expect, it } from 'vitest';
import {
  type CarriedCriterion,
  type CarriedVerdict,
  type IssueFile,
  knownIssuesOf,
  mediaOf,
  readClaims,
  requirementsOf,
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

  it('proves a requirement criterion live only by a claimed pass, and counts the rest as unproven', () => {
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
        proven: [{ code: 'BC-1', statement: 'A nurse sees the reminder' }],
        unproven: 3,
      },
    ]);
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
