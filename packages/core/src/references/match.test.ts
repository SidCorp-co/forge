// ISS-1252: a followed source's release becomes an idea only where it shares distinctive words with
// an open item; a release about nothing open stays silent; only what is new since the last read is
// digested, and a first read takes only the recent releases.

import { describe, expect, it } from 'vitest';
import { freshReleases, matchRelease, type OpenItem, wordsOf } from './match.js';

const items: OpenItem[] = [
  {
    kind: 'issue',
    id: 'i-1',
    ref: 'ISS-12',
    title: 'Parallel runs collide in one worktree when two agents share a branch',
    areas: ['runner'],
  },
  {
    kind: 'issue',
    id: 'i-2',
    ref: 'ISS-13',
    title: 'The agent answers the owner in the wrong language',
    areas: ['support'],
  },
  {
    kind: 'requirement',
    id: 'r-1',
    ref: 'REQ-4',
    title: 'Every agent run keeps its worktree isolated from the other runs',
    areas: ['runner'],
  },
  { kind: 'issue', id: 'i-3', ref: 'ISS-14', title: 'Agent session agent agent', areas: [] },
];

const release = (body: string, tag = 'v1.2.0') => ({ tag, name: null, body });

describe('matchRelease', () => {
  it('files on the open item the release shares two distinctive words with, naming them', () => {
    const m = matchRelease(
      release('Each parallel task now gets an isolated git worktree; branches no longer collide.'),
      items,
      ['worktrees'],
    );
    expect(m?.item.ref).toBe('ISS-12');
    expect(m?.terms).toEqual(['branch', 'collid', 'parallel', 'worktre']);
  });

  it('stays silent on a release that touches no open problem', () => {
    expect(
      matchRelease(release('Dark mode for the settings page and a faster font loader.'), items, []),
    ).toBeNull();
  });

  it('counts no word most open items share, so "agent" alone matches nothing', () => {
    expect(
      matchRelease(release('Agent improvements for every agent session.'), items, []),
    ).toBeNull();
  });

  it('needs two shared words: one is no evidence', () => {
    expect(matchRelease(release('A new worktree command.'), items, [])).toBeNull();
  });

  it('prefers the issue to the requirement on an equal score', () => {
    const m = matchRelease(release('worktree isolated parallel runs'), items, []);
    expect(m?.item.kind).toBe('issue');
  });

  it('reads a word in its shared form, plurals and tenses folded', () => {
    expect([...wordsOf('Worktrees collided matches')]).toEqual(['worktre', 'collid', 'match']);
    expect([...wordsOf('worktree collide')]).toEqual(['worktre', 'collid']);
  });
});

describe('freshReleases', () => {
  const now = new Date('2026-11-16T00:00:00Z');
  const list = [
    { tag: 'v3', name: null, url: 'u3', body: '', publishedAt: '2026-11-15T00:00:00Z' },
    { tag: 'v2', name: null, url: 'u2', body: '', publishedAt: '2026-11-10T00:00:00Z' },
    { tag: 'v1', name: null, url: 'u1', body: '', publishedAt: '2026-09-01T00:00:00Z' },
  ];

  it('takes only what is newer than the tag last seen, oldest first', () => {
    expect(freshReleases(list, 'v1', now).map((r) => r.tag)).toEqual(['v2', 'v3']);
    expect(freshReleases(list, 'v3', now)).toEqual([]);
  });

  it('takes, on a first read, only the releases of the last fourteen days', () => {
    expect(freshReleases(list, null, now).map((r) => r.tag)).toEqual(['v2', 'v3']);
  });
});
