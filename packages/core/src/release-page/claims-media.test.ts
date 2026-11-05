// @direct-test-of packages/core/src/release-page/claims.ts
// The clips and pictures a release page may show, off the claims its record weighed (ISS-1001).
import { describe, expect, it } from 'vitest';
import { BUILD, criterion, MERGED, readClaims, verdict } from './claims.fixture.js';
import { type IssueFile, mediaOf } from './claims.js';

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
    const media = mediaOf(readClaims([claimed, held], BUILD, null, null), files, BUILD);
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

  it('opens a clip on the still its verdict cites beside it, the one named after the clip first (BC-3)', () => {
    const stills: IssueFile[] = [
      {
        id: 'f-other-shot',
        issueId: 'issue-1',
        name: 'overview.png',
        mime: 'image/png',
        bytes: 900,
      },
      { id: 'f-switch', issueId: 'issue-1', name: 'switch.webm', mime: 'video/webm', bytes: 9000 },
      { id: 'f-still', issueId: 'issue-1', name: 'switch.png', mime: 'image/png', bytes: 900 },
    ];
    const judged = criterion(1, 'BC-1', [
      verdict('pass', BUILD, '2026-10-09T10:00:00.000Z', {
        evidence: ['overview.png', 'switch.webm', 'switch.png'],
      }),
    ]);
    const [clip] = mediaOf(readClaims([judged], BUILD, null, null), stills, BUILD);
    expect(clip).toMatchObject({
      kind: 'clip',
      attachmentId: 'f-switch',
      poster: { attachmentId: 'f-still', name: 'switch.png', mime: 'image/png' },
    });
    const alone = criterion(1, 'BC-1', [
      verdict('pass', BUILD, '2026-10-09T10:00:00.000Z', { evidence: ['switch.webm'] }),
    ]);
    expect(mediaOf(readClaims([alone], BUILD, null, null), stills, BUILD)[0]?.poster).toBeNull();
  });

  // the verdict door takes a clip cited by its id or download URL (adminhub-fe ISS-53); the page
  // shows the same file, or a citation the door took would show nothing
  it('shows a clip cited by its id or its download URL, as one cited by name', () => {
    const id = '0f6c2a1e-7b3d-4c5e-9a8f-1d2e3f4a5b6c';
    const byId: IssueFile[] = [
      { id, issueId: 'issue-1', name: 'flow.webm', mime: 'video/webm', bytes: 9000 },
    ];
    for (const cited of [
      id,
      `/api/attachments/${id}/download`,
      `https://forge.example/api/attachments/${id.toUpperCase()}/download`,
    ]) {
      const judged = criterion(1, 'BC-1', [
        verdict('pass', BUILD, '2026-10-09T10:00:00.000Z', { evidence: [cited] }),
      ]);
      expect(mediaOf(readClaims([judged], BUILD, null, null), byId, BUILD)).toMatchObject([
        { kind: 'clip', attachmentId: id },
      ]);
    }
  });

  it('shows nothing a pass on another build cites', () => {
    const elsewhere = criterion(1, 'BC-1', [
      verdict('pass', MERGED, '2026-10-09T10:00:00.000Z', { evidence: ['clip.webm'] }),
    ]);
    expect(mediaOf(readClaims([elsewhere], BUILD, null, null), files, BUILD)).toEqual([]);
  });

  // ISS-900: a release recorded by version names no build; a pass judged on it shows its media,
  // naming the release it judged, as one with a build names the commit
  it('shows what a pass judged on a release cites on a release that names no build, by version', () => {
    const onRelease = criterion(1, 'BC-1', [
      verdict('pass', null, '2026-10-09T10:00:00.000Z', {
        identityKind: 'release',
        releaseVersion: '0.76.0',
        evidence: ['clip.webm'],
      }),
    ]);
    const versions = new Set(['0.76.0']);
    const media = mediaOf(readClaims([onRelease], null, null, null, versions), files, null);
    expect(media).toMatchObject([
      { kind: 'clip', attachmentId: 'f-clip', releaseVersion: '0.76.0' },
    ]);
    expect(media[0]?.commitSha).toBeUndefined();
    // a pass naming no release, on a release with no build, still shows nothing
    const unplaced = criterion(1, 'BC-1', [
      verdict('pass', BUILD, '2026-10-09T10:00:00.000Z', { evidence: ['clip.webm'] }),
    ]);
    expect(mediaOf(readClaims([unplaced], null, null, null, versions), files, null)).toEqual([]);
  });
});
