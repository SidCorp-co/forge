import type { QuestionnaireItem } from '@forge/contracts/onboarding';
import { describe, expect, it } from 'vitest';
import { citeRefusals, landingsOf, linkItems, type SeriesItem } from './design-items.js';

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const S1 = '33333333-3333-4333-8333-333333333333';
const T = (n: number) => new Date(Date.UTC(2026, 9, n));

const item = (id: string, over: Partial<QuestionnaireItem> = {}): QuestionnaireItem => ({
  id,
  group: 'question',
  control: 'choice',
  prompt: `what is ${id}?`,
  why: 'the code cannot tell',
  evidence: ['src/a.ts:a'],
  affects: [W1],
  ...over,
});

const row = (id: string, over: Partial<SeriesItem> = {}): SeriesItem => ({
  questionId: `q-${id}`,
  round: 1,
  createdAt: T(1),
  state: 'answered',
  decision: null,
  item: item(id),
  landedIn: null,
  ...over,
});

const D1 = { workflowId: W1, flow: 'system-context', revision: 3 };
const D2 = { workflowId: W2, flow: 'orders', revision: 1 };
const designs = [D1, D2];

describe('project-onboarding designs: each design names the items that shaped it', () => {
  it('links by affects, by flow slug and by a cited revision, latest round only', () => {
    const items = [
      row('a'),
      row('b', { item: item('b', { affects: ['orders'] }) }),
      row('c', {
        item: item('c', { affects: [] }),
        landedIn: [{ workflowId: W2, revision: 1, by: 'u', at: 'x' }],
      }),
      row('d', { state: 'open' }),
      row('d', { round: 2, createdAt: T(2), state: 'answered', questionId: 'q-d2' }),
    ];
    expect(linkItems(D1, items, 2).linkedItems.map((i) => i.questionId)).toEqual(['q-a', 'q-d2']);
    const orders = linkItems(D2, items, 2).linkedItems;
    expect(orders.map((i) => [i.itemId, i.citedRevision])).toEqual([
      ['b', null],
      ['c', 1],
    ]);
  });

  it('drops void items', () => {
    expect(linkItems(D1, [row('a', { state: 'void' })], 1).linkedItems).toEqual([]);
  });
});

describe('project-onboarding what-next: after 3 rounds open items stay on their designs', () => {
  const items = [row('a', { state: 'open' }), row('b')];
  it('lists no open questions while a round is left', () => {
    expect(linkItems(D1, items, 2).openQuestions).toEqual([]);
  });
  it('lists the open linked items once every round is sent', () => {
    expect(linkItems(D1, items, 3).openQuestions.map((i) => i.itemId)).toEqual(['a']);
  });
});

describe('project-onboarding answer-lands and revise: an update cites the items it came from', () => {
  const codes = (cites: Parameters<typeof citeRefusals>[0], items: SeriesItem[]) =>
    citeRefusals(cites, items, designs, new Set([S1])).map((r) => r.code);

  it('accepts an answered item at a revision the design holds, and an accepted recommendation as a suggestion', () => {
    const rec = row('r', {
      item: item('r', { group: 'recommendation', control: 'accept_reject' }),
      decision: 'accept',
    });
    expect(
      codes(
        [
          { itemId: 'a', workflowId: W1, revision: 3 },
          { itemId: 'r', suggestionId: S1 },
        ],
        [row('a'), rec],
      ),
    ).toEqual([]);
  });

  it('refuses each wrong cite by name', () => {
    const items = [
      row('a'),
      row('open', { state: 'open' }),
      row('rej', { item: item('rej', { control: 'accept_reject' }), decision: 'reject' }),
    ];
    expect(codes([{ itemId: 'zz', workflowId: W1, revision: 1 }], items)).toEqual([
      'QUESTIONNAIRE_ITEM_UNKNOWN',
    ]);
    expect(codes([{ itemId: 'open', workflowId: W1, revision: 1 }], items)).toEqual([
      'ONBOARDING_CITE_UNANSWERED',
    ]);
    expect(codes([{ itemId: 'rej', suggestionId: S1 }], items)).toEqual([
      'QUESTIONNAIRE_RECOMMENDATION_REJECTED',
    ]);
    expect(codes([{ itemId: 'a', workflowId: S1, revision: 1 }], items)).toEqual([
      'ONBOARDING_DESIGN_UNKNOWN',
    ]);
    expect(codes([{ itemId: 'a', workflowId: W1, revision: 4 }], items)).toEqual([
      'ONBOARDING_CITE_REVISION_UNKNOWN',
    ]);
    expect(codes([{ itemId: 'a', suggestionId: W2 }], items)).toEqual([
      'ONBOARDING_CITE_SUGGESTION_UNKNOWN',
    ]);
  });

  it('holds one revision per design per update', () => {
    expect(
      codes(
        [
          { itemId: 'a', workflowId: W1, revision: 2 },
          { itemId: 'b', workflowId: W1, revision: 3 },
        ],
        [row('a'), row('b')],
      ),
    ).toEqual(['ONBOARDING_CITE_REVISION_TWICE']);
  });

  it('records each landing once on the item, keeping what it held', () => {
    const had = row('a', { landedIn: [{ workflowId: W1, revision: 2, by: 'u0', at: 'x' }] });
    const out = landingsOf(
      [
        { itemId: 'a', workflowId: W1, revision: 2 },
        { itemId: 'a', workflowId: W2, revision: 1 },
      ],
      [had],
      'u1',
      T(3),
    );
    expect(
      out.get('q-a')?.map((l) => ('workflowId' in l ? `${l.workflowId}:${l.revision}` : '')),
    ).toEqual([`${W1}:2`, `${W2}:1`]);
  });
});
