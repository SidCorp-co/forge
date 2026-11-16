// ISS-1252 c2: a followed source's release becomes an idea only where the fast model judges that it
// helps one of the open items nearest it; a release about nothing open stays silent however near it
// sits and whatever words it shares; one no vector or no model can read is not judged, and says why;
// only what is new since the last read is digested, and a first read takes only the recent releases.

import { describe, expect, it, vi } from 'vitest';
import {
  freshReleases,
  type JudgeRelease,
  matchRelease,
  type NearestOpen,
  type OpenItem,
  RELEASE_LEAD_CHARS,
  releaseLead,
  SHORTLIST_FLOOR,
} from './match.js';
import { FORGE_OPEN_ITEMS, RELEASE_NOTES } from './releases.fixture.js';

const release = (key: keyof typeof RELEASE_NOTES, source: string) => {
  const r = RELEASE_NOTES[key];
  return { tag: r.name, name: r.name, body: r.body, source };
};

/** Every open item at `similarity` to any release: the stored vectors as a fixture. */
const allAt =
  (similarity: number): NearestOpen =>
  async (_p, _lead, items) => ({ ok: true, near: items.map((item) => ({ item, similarity })) });

/** The model as it should judge: coolify's queued-deploy cancel helps ISS-1082, nothing else helps. */
const strictJudge = vi.fn<JudgeRelease>(async (_p, r, item) =>
  r.body.includes('queued webhook deployments') && item.ref === 'ISS-1082'
    ? {
        ok: true,
        helps: true,
        why: 'It cancels older queued webhook deploys, so a push no longer waits behind stale ones.',
      }
    : { ok: true, helps: false, why: 'It is about something else.' },
);

const ports = (nearest: NearestOpen, judge: JudgeRelease = strictJudge) => ({ nearest, judge });

describe('matchRelease', () => {
  it('keeps orca 1.4.255 and Claude Code v2.1.323 silent, though they sit near forge open items and share their words', async () => {
    for (const r of [release('orca', 'stablyai/orca'), release('claudeCode', 'Claude Code CLI')]) {
      strictJudge.mockClear();
      const m = await matchRelease('p', r, FORGE_OPEN_ITEMS, ports(allAt(0.66)));
      expect(m, r.source).toEqual({ kind: 'none' });
      // near enough to be shortlisted: the cosine let them through, the judgement kept them out
      expect(strictJudge).toHaveBeenCalled();
    }
  });

  it('files coolify v4.7.0 on the ISS-1082-like item, with the why the model gave', async () => {
    const m = await matchRelease(
      'p',
      release('coolify', 'coollabsio/coolify'),
      FORGE_OPEN_ITEMS,
      ports(allAt(0.652)),
    );
    expect(m).toMatchObject({ kind: 'helps', item: { ref: 'ISS-1082' }, similarity: 0.652 });
    expect(m.kind === 'helps' && m.why).toMatch(/queued webhook deploys/);
  });

  it(`asks the model nothing about an item under the shortlist floor ${SHORTLIST_FLOOR}`, async () => {
    const judge = vi.fn<JudgeRelease>(async () => ({ ok: true, helps: true, why: 'yes' }));
    const m = await matchRelease(
      'p',
      release('coolify', 'coollabsio/coolify'),
      FORGE_OPEN_ITEMS,
      ports(allAt(SHORTLIST_FLOOR - 0.01), judge),
    );
    expect(m).toEqual({ kind: 'none' });
    expect(judge).not.toHaveBeenCalled();
  });

  it('judges the three nearest items, nearest first', async () => {
    const items: OpenItem[] = [0.61, 0.7, 0.65, 0.68].map((s, i) => ({
      kind: 'issue',
      id: `i-${i}`,
      ref: `ISS-${i}`,
      title: String(s),
      areas: [],
    }));
    const nearest: NearestOpen = async (_p, _l, list) => ({
      ok: true,
      near: list.map((item) => ({ item, similarity: Number(item.title) })),
    });
    const asked: string[] = [];
    const judge: JudgeRelease = async (_p, _r, item) => {
      asked.push(item.ref);
      return { ok: true, helps: false, why: 'no' };
    };
    await matchRelease('p', release('orca', 'o'), items, ports(nearest, judge));
    expect(asked).toEqual(['ISS-1', 'ISS-3', 'ISS-2']);
  });

  it('is not judged, by name, where no vector can be had, and never matches by its words', async () => {
    const judge = vi.fn<JudgeRelease>();
    const m = await matchRelease(
      'p',
      release('orca', 'stablyai/orca'),
      FORGE_OPEN_ITEMS,
      ports(
        async () => ({ ok: false, why: 'no vector for the release (provider_not_configured)' }),
        judge,
      ),
    );
    expect(m).toEqual({
      kind: 'unjudged',
      why: 'no vector for the release (provider_not_configured)',
    });
    expect(judge).not.toHaveBeenCalled();
  });

  it('is not judged, by name, where the model gives no answer', async () => {
    const m = await matchRelease(
      'p',
      release('coolify', 'coollabsio/coolify'),
      FORGE_OPEN_ITEMS,
      ports(allAt(0.7), async () => ({
        ok: false,
        why: 'not judged: no fast model is set up to judge it',
      })),
    );
    expect(m).toEqual({ kind: 'unjudged', why: 'not judged: no fast model is set up to judge it' });
  });

  it('shortlists by the release name and the first part of its notes', () => {
    const body = `${'a'.repeat(RELEASE_LEAD_CHARS)}TAIL`;
    expect(releaseLead({ tag: 'v1', name: null, body })).toBe(
      `v1\n\n${'a'.repeat(RELEASE_LEAD_CHARS)}`,
    );
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
