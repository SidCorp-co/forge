import { commentMockupRequestSchema, mockupPinSchema } from '@forge/contracts/mockups';
import { describe, expect, it } from 'vitest';
import {
  commentClosedRefusal,
  commentsFullRefusal,
  revisesRefusal,
  revisesTargetRefusal,
  revisionRefusal,
  settleRefusals,
  settlesWithoutRevisesRefusal,
} from './rules.js';

// REQ-49: where a comment may point, which mockup a next revision revises, which comments it settles
const codes = (r: { code: string; path: string }[]) => r.map((x) => `${x.code} ${x.path}`);

describe('a pin is a point or a region inside the frame (BC-2)', () => {
  it('takes a point, a region, and the frame edges', () => {
    for (const pin of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.2, y: 0.3, w: 0.8, h: 0.7 },
    ])
      expect(mockupPinSchema.safeParse(pin).success, JSON.stringify(pin)).toBe(true);
  });

  it('refuses a point outside, a region past an edge, one side alone and a zero side', () => {
    for (const pin of [
      { x: -0.01, y: 0 },
      { x: 0.5, y: 1.01 },
      { x: 0.6, y: 0, w: 0.5, h: 0.1 },
      { x: 0, y: 0, w: 0.5 },
      { x: 0, y: 0, w: 0, h: 0.2 },
    ])
      expect(mockupPinSchema.safeParse(pin).success, JSON.stringify(pin)).toBe(false);
  });

  it('a comment says something', () => {
    expect(commentMockupRequestSchema.safeParse({ body: '   ' }).success).toBe(false);
  });
});

describe('a requirement mockup goes on a revision that can still be agreed (BC-5)', () => {
  it('takes a draft, proposed or current revision', () => {
    for (const s of ['draft', 'proposed', 'current'] as const)
      expect(revisionRefusal('REQ-1', 1, s, 1)).toBeNull();
  });

  it('refuses a superseded or withdrawn one naming the head, and a missing one', () => {
    expect(revisionRefusal('REQ-1', 1, 'superseded', 2)).toMatchObject({
      code: 'MOCKUP_REVISION_SUPERSEDED',
      path: '/target/revision',
    });
    expect(revisionRefusal('REQ-1', 1, 'superseded', 2)?.detail).toContain('head is revision 2');
    expect(revisionRefusal('REQ-1', 3, null, 2)?.code).toBe('MOCKUP_TARGET_INVALID');
  });
});

describe('a next revision (BC-3)', () => {
  it('revises a returned mockup with no next revision, and nothing else', () => {
    expect(revisesRefusal('MK-1', 'returned', null)).toBeNull();
    for (const s of ['proposed', 'accepted', 'withdrawn'] as const)
      expect(revisesRefusal('MK-1', s, null)?.code).toBe('MOCKUP_REVISES_INVALID');
    expect(revisesRefusal('MK-1', 'returned', 'MK-2')?.detail).toContain('MK-2');
  });

  it('stays on the item of the mockup it revises', () => {
    expect(revisesTargetRefusal('MK-1', 'a', 'a')).toBeNull();
    expect(revisesTargetRefusal('MK-1', 'a', 'b')?.path).toBe('/target');
  });

  it('settles comments only when it names what it revises', () => {
    expect(
      settlesWithoutRevisesRefusal({ kind: 'html', answers: [{ comment: 'c' }] }),
    ).toMatchObject({
      code: 'MOCKUP_REVISES_INVALID',
    });
    expect(settlesWithoutRevisesRefusal({ kind: 'html' })).toBeNull();
  });

  it('settles each open comment of its chain once, and names every other', () => {
    const chain = new Map([
      ['open', { id: 'open', settled: null }],
      ['done', { id: 'done', settled: 'answered' }],
    ]);
    expect(settleRefusals('MK-1', chain, ['open'], [])).toEqual([]);
    expect(codes(settleRefusals('MK-1', chain, ['open', 'nope'], ['open', 'done']))).toEqual([
      'MOCKUP_COMMENT_UNKNOWN /answers/1/comment',
      'MOCKUP_COMMENT_SETTLED /resolves/0/comment',
      'MOCKUP_COMMENT_SETTLED /resolves/1/comment',
    ]);
  });
});

describe('a comment goes on a mockup still discussed (BC-2)', () => {
  it('takes a proposed one and a returned one with no next revision', () => {
    expect(commentClosedRefusal('MK-1', 'proposed', null)).toBeNull();
    expect(commentClosedRefusal('MK-1', 'returned', null)).toBeNull();
  });

  it('sends a revised one to its next revision, and refuses a decided one', () => {
    expect(commentClosedRefusal('MK-1', 'returned', 'MK-2')?.detail).toContain('comment on MK-2');
    expect(commentClosedRefusal('MK-1', 'accepted', null)?.code).toBe('MOCKUP_COMMENT_CLOSED');
    expect(commentsFullRefusal('MK-1', 200)?.code).toBe('MOCKUP_COMMENTS_FULL');
    expect(commentsFullRefusal('MK-1', 199)).toBeNull();
  });
});
