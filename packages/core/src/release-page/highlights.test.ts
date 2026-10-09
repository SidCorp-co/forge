import type { ReleaseHighlightFacts, ReleaseMediaRef } from '@forge/contracts/release-page';
import { describe, expect, it } from 'vitest';
import type { ReleaseHighlightsRow } from '../db/schema.js';
import { judged } from './draft.js';
import { digestOf, shownHighlights } from './highlights.js';

const BUILD = 'a'.repeat(40);
const CLIP: ReleaseMediaRef = {
  kind: 'clip',
  attachmentId: '11111111-1111-4111-8111-111111111111',
  name: 'reminder.webm',
  mime: 'video/webm',
  bytes: 800_000,
  verdictId: '22222222-2222-4222-8222-222222222222',
  issueKey: 'ISS-1',
  criterion: { n: 1, bc: 'BC-1' },
  commitSha: BUILD,
};
const FACTS: ReleaseHighlightFacts = {
  version: '0.2.0',
  requirements: [
    {
      key: 'REQ-1',
      title: 'Reminders',
      text: 'Nurses are reminded 2 hours ahead.\nBC-1: A nurse sees the reminder',
      completes: true,
      claimable: ['BC-1'],
    },
  ],
  media: [CLIP],
};

const answer = (h: Record<string, unknown>) =>
  JSON.stringify({
    highlights: [
      {
        requirement: 'REQ-1',
        title: 'Reminders',
        body: 'Nurses see a reminder 2 hours ahead.',
        claims: ['BC-1'],
        ...h,
      },
    ],
  });

describe('a drafted answer judged before it is kept (BC-2, BC-3, BC-13)', () => {
  it('keeps a highlight that claims what the build proves, and gives it the clip of its claim', () => {
    const out = judged(answer({}), FACTS);
    expect(out).toEqual({
      ok: true,
      highlights: [
        expect.objectContaining({
          requirement: { key: 'REQ-1', title: 'Reminders' },
          claims: ['BC-1'],
          media: CLIP,
          mediaGap: null,
        }),
      ],
    });
  });

  it.each([
    ['a claim with no pass on the build', { claims: ['BC-2'] }, 'RELEASE_HIGHLIGHT_UNCLAIMED'],
    [
      'a figure the record does not state',
      { body: 'Nurses see 3 reminders a day.' },
      'RELEASE_HIGHLIGHT_FIGURE_UNBACKED',
    ],
    [
      'a requirement the release does not carry',
      { requirement: 'REQ-9' },
      'RELEASE_HIGHLIGHT_REQUIREMENT_FOREIGN',
    ],
    ['a body over the word cap', { body: 'word '.repeat(41) }, 'RELEASE_HIGHLIGHT_SHAPE'],
  ])('refuses %s by name', (_what, h, code) => {
    const out = judged(answer(h), FACTS);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusals.map((r) => r.code)).toContain(code);
  });

  it('refuses an answer that is not the highlights shape', () => {
    const out = judged('Here are your highlights!', FACTS);
    expect(out).toMatchObject({ ok: false, refusals: [{ code: 'RELEASE_HIGHLIGHT_SHAPE' }] });
  });

  it('refuses a fourth highlight', () => {
    const many = {
      ...FACTS,
      requirements: [1, 2, 3].map((n) => ({
        ...FACTS.requirements[0],
        key: `REQ-${n}`,
      })) as ReleaseHighlightFacts['requirements'],
    };
    const text = JSON.stringify({
      highlights: [1, 2, 3, 1].map((n) => ({
        requirement: `REQ-${n}`,
        title: 'T',
        body: 'B',
        claims: ['BC-1'],
      })),
    });
    const out = judged(text, many);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.refusals.map((r) => r.code)).toContain('RELEASE_HIGHLIGHT_COUNT');
  });
});

function row(over: Partial<ReleaseHighlightsRow>): ReleaseHighlightsRow {
  return {
    id: 'r-1',
    projectId: 'p-1',
    runId: 'run-1',
    version: '0.2.0',
    state: 'pending',
    highlights: null,
    model: null,
    sourceDigest: null,
    draftedAt: null,
    refusals: [],
    createdAt: new Date('2026-10-09T10:00:00Z'),
    updatedAt: new Date('2026-10-09T10:00:00Z'),
    ...over,
  };
}

describe('what the page shows of the highlights', () => {
  const digest = digestOf(FACTS);
  const kept = judged(answer({}), FACTS);
  const highlights = kept.ok ? kept.highlights : [];
  const drafted = row({
    state: 'drafted',
    highlights,
    model: 'gateway/model',
    sourceDigest: digest,
    draftedAt: new Date('2026-10-09T10:01:00Z'),
  });
  const now = new Date('2026-10-09T10:02:00Z');

  it('shows nothing claimed where the build proves no requirement criterion', () => {
    const shown = shownHighlights(
      null,
      { ...FACTS, requirements: [], media: [] },
      digest,
      BUILD,
      now,
    );
    expect(shown.highlights).toMatchObject({ state: 'none' });
  });

  it('shows the stored draft that answers today’s facts, owing nothing', () => {
    expect(shownHighlights(drafted, FACTS, digest, BUILD, now)).toEqual({
      highlights: expect.objectContaining({ state: 'drafted', highlights, model: 'gateway/model' }),
      owed: false,
    });
  });

  it('never shows a stored claim the build no longer proves: the draft is owed instead', () => {
    const later = {
      ...FACTS,
      requirements: [{ ...FACTS.requirements[0], claimable: ['BC-2'] }],
    } as ReleaseHighlightFacts;
    const shown = shownHighlights(drafted, later, digestOf(later), BUILD, now);
    expect(shown.highlights.state).toBe('pending');
    expect(shown.owed).toBe(true);
  });

  it('says the model is not configured where the last draft could not be asked', () => {
    const missed = row({
      state: 'failed',
      refusals: [
        { code: 'RELEASE_HIGHLIGHTS_MODEL_UNCONFIGURED', path: '', detail: 'no chat model' },
      ],
    });
    expect(shownHighlights(missed, FACTS, digest, BUILD, now).highlights).toMatchObject({
      state: 'failed',
      refusals: [{ code: 'RELEASE_HIGHLIGHTS_MODEL_UNCONFIGURED' }],
    });
  });

  it('owes no second draft while one for the same facts is in flight', () => {
    const inFlight = row({ state: 'pending', sourceDigest: digest, updatedAt: now });
    expect(shownHighlights(inFlight, FACTS, digest, BUILD, now)).toMatchObject({
      highlights: { state: 'pending' },
      owed: false,
    });
  });
});
