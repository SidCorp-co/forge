/**
 * REQ-35 (ISS-459 round 2), Requirement lifecycle r14 `picture_shown`: a new revision of the head's
 * kind carries the head's picture until it is redrawn itself. The judge at 302271db7 found the carry
 * copied once: a member replaced the agreed head's picture while r2 was open, r2 kept the old one,
 * and accepting r2 lost the replacement silently. Both orders are here: replace then accept, and
 * accept then replace.
 */

import { describe, expect, it } from 'vitest';
import { type Doc, ok, refusal } from '../helpers/ecosystem-world.js';
import { openPictureWorld, PICTURES, pictureDoors } from '../helpers/requirement-picture-world.js';

const w = openPictureWorld();
const { as, read, requirement, revision, history, picture, kindOf, agreeR1 } = pictureDoors(w);

describe('an open revision follows the head picture until it is redrawn itself (criterion 14)', () => {
  const REDRAWN = { ...PICTURES.rule, alt: 'Redrawn on r1 while r2 is open.' };
  const BC1 = [{ code: 'BC-1', body: 'A buyer sees what shipping costs before paying.' }];

  /** A rule REQ agreed at r1, drawn there when `drawn`, with r2 of the same kind written open on it. */
  async function openOnAgreed(title: string, drawn = true): Promise<string> {
    const key = await requirement(title, 'rule');
    if (drawn) ok(await picture(key, 1, PICTURES.rule));
    await agreeR1(key);
    ok(
      await as('owner', 'POST', `/requirements/${key}/revisions`, {
        baseRevision: 1,
        reason: 'r2 on the agreed head',
        criteria: BC1,
      }),
    );
    return key;
  }

  async function acceptR2(key: string): Promise<void> {
    ok(await as('owner', 'POST', `/requirements/${key}/revisions/2/propose`, {}));
    ok(await as('owner', 'POST', `/requirements/${key}/revisions/2/accept`, { reason: 'ok' }));
  }

  it('replace then accept: r2 shows the replaced head picture, and so does the requirement once r2 is accepted', async () => {
    const key = await openOnAgreed('Shipping follows the head picture');
    ok(await picture(key, 1, REDRAWN, 'member'));
    const head = (await revision(key, 1)).picture as Doc;
    expect(head).toMatchObject({ alt: REDRAWN.alt, writtenBy: w.memberId, drawnFor: 1 });
    expect((await revision(key, 2)).picture).toMatchObject({ id: head.id, drawnFor: 1 });
    await acceptR2(key);
    const done = await read(key);
    expect(done.currentRevision).toBe(2);
    expect((await revision(key, 2)).picture).toMatchObject({ id: head.id, alt: REDRAWN.alt });
    expect(await history(key)).toContain(
      `Picture: Replaced the picture of r1, a rough sketch: ${REDRAWN.alt}`,
    );
  });

  it('accept then replace: the old head is evidence, and a replace on the new head changes only it', async () => {
    const key = await openOnAgreed('Shipping is accepted, then redrawn');
    const first = (await revision(key, 1)).picture.id as string;
    await acceptR2(key);
    expect(refusal(await picture(key, 1, REDRAWN))).toEqual([
      'REQUIREMENT_REVISION_NOT_CURRENT /revision',
    ]);
    ok(await picture(key, 2, { ...REDRAWN, alt: 'Redrawn on r2, now the head.' }, 'member'));
    expect((await revision(key, 2)).picture).toMatchObject({
      alt: 'Redrawn on r2, now the head.',
      drawnFor: 2,
    });
    expect((await revision(key, 1)).picture.id).toBe(first);
  });

  it('a picture drawn on the open revision itself is kept when the head is replaced', async () => {
    const key = await openOnAgreed('Shipping is redrawn on the draft');
    ok(await picture(key, 2, { ...PICTURES.rule, alt: 'Drawn on r2 itself.' }));
    ok(await picture(key, 1, REDRAWN, 'member'));
    expect((await revision(key, 2)).picture).toMatchObject({
      alt: 'Drawn on r2 itself.',
      drawnFor: 2,
    });
    expect((await revision(key, 1)).picture.alt).toBe(REDRAWN.alt);
  });

  it('an open revision of another kind is not touched by the head picture', async () => {
    const key = await openOnAgreed('Shipping becomes a process');
    ok(await kindOf(key, 2, 'process'));
    ok(await picture(key, 1, REDRAWN));
    expect(await revision(key, 2)).toMatchObject({ kind: 'process', picture: null });
  });

  it('an open revision that carried no picture shows the one first drawn on the head', async () => {
    const key = await openOnAgreed('Shipping is drawn after r2 was written', false);
    expect((await revision(key, 2)).picture).toBeNull();
    ok(await picture(key, 1, REDRAWN));
    const head = (await revision(key, 1)).picture as Doc;
    expect((await revision(key, 2)).picture).toMatchObject({ id: head.id, drawnFor: 1 });
  });
});
