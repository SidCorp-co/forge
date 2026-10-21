/**
 * REQ-49 (ISS-600): a mockup is proposed, tried and discussed on the item it shapes. Through the REST
 * doors: a mockup is proposed on a requirement at a revision (BC-5, BC-7), commented on with a pin
 * to a point or a region of its frame (BC-2), returned and proposed again as its next revision that
 * answers or resolves those comments while the earlier one stays readable (BC-3), filed feedback
 * about (BC-4), listed in Approvals with its preview route and what accepting it does (BC-7), and,
 * accepted, pinned by the requirement's next agree or re-pin (BC-6). Each refusal is named.
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { type Doc, ok, refusal, refusedByDb } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import { openPictureWorld, pictureDoors } from '../helpers/requirement-picture-world.js';

const w = openPictureWorld();
const { as, read, requirement, agreeR1 } = pictureDoors(w);

const PAGE =
  '<!doctype html><title>Cart</title><button id="b">0</button><script>b.onclick=()=>b.textContent++</script>';
const html = (name = 'cart.html', page = PAGE) => ({
  kind: 'html',
  name,
  mime: 'text/html',
  contentBase64: Buffer.from(page).toString('base64'),
});

async function propose(body: Doc): Promise<Doc> {
  return ok(await as('owner', 'POST', '/mockups', body), 201).mockup as Doc;
}
const comment = async (key: string, body: Doc, who: 'owner' | 'member' = 'member') =>
  ok(await as(who, 'POST', `/mockups/${key}/comments`, body), 201).comment as Doc;
const commentsOf = async (key: string) => ok(await as('owner', 'GET', `/mockups/${key}/comments`));
const decide = (key: string, act: 'accept' | 'return', reason?: string) =>
  as('owner', 'POST', `/mockups/${key}/${act}`, reason ? { reason } : {});
/** The mockups each baseline pins, oldest baseline first. */
const pinsOf = async (key: string) =>
  [...((await read(key)).baselines as Doc[])]
    .sort((a, b) => a.revision - b.revision || a.seq - b.seq)
    .map((b) => (b.pins as Doc[]).filter((p) => p.kind === 'mockup').map((p) => p.mockupId));

describe('a mockup on a requirement (BC-5, BC-7)', () => {
  it('is proposed at the open draft when no revision is named, and at a named one', async () => {
    const key = await requirement('The cart shows its count', 'screen');
    const open = await propose({ target: { requirement: key }, ...html() });
    expect(open).toMatchObject({
      status: 'proposed',
      round: 1,
      revises: null,
      revisedBy: null,
      target: { type: 'requirement', key, revision: 1 },
      comments: { total: 0, open: 0 },
      can: { accept: true, return: true, comment: true, revise: false },
    });
    const named = await propose({ target: { requirement: key, revision: 1 }, ...html('b.html') });
    expect(named.target.revision).toBe(1);
  });

  it('refuses a revision the requirement does not have, by name', async () => {
    const key = await requirement('The cart lists lines', 'screen');
    const r = await as('owner', 'POST', '/mockups', {
      target: { requirement: key, revision: 9 },
      ...html(),
    });
    expect(refusal(r)).toEqual(['MOCKUP_TARGET_INVALID /target/revision']);
  });

  it('refuses a proposal naming no target and no mockup it revises', async () => {
    expect(refusal(await as('owner', 'POST', '/mockups', html()))).toEqual([
      'MOCKUP_TARGET_INVALID /target',
    ]);
  });
});

describe('comments pinned to the frame (BC-2)', () => {
  let key = '';
  beforeAll(async () => {
    const req = await requirement('The checkout button is obvious', 'screen');
    key = (await propose({ target: { requirement: req }, ...html() })).key as string;
  });

  it('keeps a point, a region and an unpinned comment, each where it points', async () => {
    const point = await comment(key, { body: 'Make this green', pin: { x: 0.25, y: 0.5 } });
    const region = await comment(key, {
      body: 'This block is cramped',
      pin: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
    });
    const loose = await comment(key, { body: 'Overall fine' });
    expect([point.pin, region.pin, loose.pin]).toEqual([
      { x: 0.25, y: 0.5 },
      { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
      null,
    ]);
    const read = await commentsOf(key);
    expect(read.open).toBe(3);
    expect(read.comments.map((c: Doc) => [c.on, c.body, c.settled])).toEqual([
      [key, 'Make this green', null],
      [key, 'This block is cramped', null],
      [key, 'Overall fine', null],
    ]);
    const listed = ok(await as('owner', 'GET', `/mockups/${key}`)).mockup as Doc;
    expect(listed.comments).toEqual({ total: 3, open: 3 });
  });

  it('refuses a pin outside the frame and a region with one side, by its shape', async () => {
    for (const pin of [
      { x: 1.2, y: 0 },
      { x: 0.8, y: 0.1, w: 0.5, h: 0.1 },
      { x: 0.1, y: 0.1, w: 0.2 },
    ]) {
      const r = await as('member', 'POST', `/mockups/${key}/comments`, { body: 'off', pin });
      expect(r.status, JSON.stringify(pin)).toBe(400);
    }
  });

  it('refuses a viewer, and a comment on an accepted mockup by name', async () => {
    expect((await as('viewer', 'POST', `/mockups/${key}/comments`, { body: 'hi' })).status).toBe(
      403,
    );
    const req = await requirement('A settled screen', 'screen');
    const done = (await propose({ target: { requirement: req }, ...html() })).key as string;
    ok(await decide(done, 'accept'));
    expect(
      refusal(await as('member', 'POST', `/mockups/${done}/comments`, { body: 'late' })),
    ).toEqual(['MOCKUP_COMMENT_CLOSED ']);
  });

  it('keeps what a comment says: the database refuses an edit and a second settle', async () => {
    const c = await comment(key, { body: 'Kept as said' });
    await refusedByDb(
      rows(sql`UPDATE mockup_comments SET body = 'rewritten' WHERE id = ${c.id}`),
      /MOCKUP_COMMENT_IMMUTABLE/,
    );
  });
});

describe('a returned mockup proposed again as its next revision (BC-3)', () => {
  let req = '';
  let first = '';
  let answered: Doc;
  let resolved: Doc;
  beforeAll(async () => {
    req = await requirement('The cart badge is red', 'screen');
    first = (await propose({ target: { requirement: req }, ...html() })).key as string;
    answered = await comment(first, { body: 'Badge red', pin: { x: 0.9, y: 0.05 } });
    resolved = await comment(first, { body: 'Add a logo' });
  });

  it('refuses revising one still proposed, and settling comments without revises', async () => {
    expect(refusal(await as('owner', 'POST', '/mockups', { ...html(), revises: first }))).toEqual([
      'MOCKUP_REVISES_INVALID /revises',
    ]);
    expect(
      refusal(
        await as('owner', 'POST', '/mockups', {
          target: { requirement: req },
          ...html(),
          answers: [{ comment: answered.id }],
        }),
      ),
    ).toEqual(['MOCKUP_REVISES_INVALID /revises']);
  });

  it('answers and resolves the comments it names; the earlier revision stays readable', async () => {
    ok(await decide(first, 'return', 'the badge colour'));
    const unknown = '00000000-0000-4000-8000-000000000000';
    expect(
      refusal(
        await as('owner', 'POST', '/mockups', {
          ...html(),
          revises: first,
          answers: [{ comment: unknown }],
        }),
      ),
    ).toEqual(['MOCKUP_COMMENT_UNKNOWN /answers/0/comment']);
    const next = await propose({
      ...html('cart-2.html', PAGE.replace('<button', '<button style="background:red"')),
      revises: first,
      answers: [{ comment: answered.id, note: 'now red' }],
      resolves: [{ comment: resolved.id, note: 'the logo is out of scope' }],
    });
    expect(next).toMatchObject({
      round: 2,
      revises: first,
      status: 'proposed',
      target: { type: 'requirement', key: req, revision: 1 },
    });
    const thread = await commentsOf(next.key as string);
    expect(thread.open).toBe(0);
    expect(
      thread.comments.map((c: Doc) => [c.on, c.settled?.as, c.settled?.by, c.settled?.note]),
    ).toEqual([
      [first, 'answered', next.key, 'now red'],
      [first, 'resolved', next.key, 'the logo is out of scope'],
    ]);
    const listed = ok(await as('owner', 'GET', `/mockups?requirement=${req}`)).mockups as Doc[];
    expect(listed.map((m) => [m.key, m.status, m.round, m.revises, m.revisedBy])).toEqual([
      [first, 'returned', 1, null, next.key],
      [next.key, 'proposed', 2, first, null],
    ]);
    expect(listed[0]?.can).toMatchObject({ revise: false, comment: false });
    const bytes = await as('owner', 'GET', `/mockups/${first}/content`);
    expect(bytes.status).toBe(200);
  });

  it('refuses a second next revision of the same mockup, and a comment settled twice', async () => {
    expect(
      refusal(
        await as('owner', 'POST', '/mockups', {
          ...html(),
          revises: first,
          answers: [{ comment: answered.id }],
        }),
      ),
    ).toEqual(['MOCKUP_REVISES_INVALID /revises']);
  });

  it('a revision stays on the item of the mockup it revises', async () => {
    const other = await requirement('Another screen', 'screen');
    const m = (await propose({ target: { requirement: other }, ...html() })).key as string;
    ok(await decide(m, 'return', 'try again'));
    const r = await as('owner', 'POST', '/mockups', {
      target: { requirement: req },
      ...html(),
      revises: m,
    });
    expect(refusal(r)).toEqual(['MOCKUP_REVISES_INVALID /target']);
  });
});

describe('feedback about a mockup (BC-4)', () => {
  it('is filed with the mockup as its one target, and an unknown key is refused by name', async () => {
    const req = await requirement('A screen people report on', 'screen');
    const mk = (await propose({ target: { requirement: req }, ...html() })).key as string;
    const filed = ok(
      await as('member', 'POST', '/feedback', {
        kind: 'bug',
        title: 'The button does nothing',
        mockup: mk,
      }),
      201,
    );
    const fb = (filed.feedback ?? filed) as Doc;
    expect(fb.target).toMatchObject({ type: 'mockup', key: mk, title: 'cart.html' });
    expect(
      refusal(
        await as('member', 'POST', '/feedback', { kind: 'bug', title: 'Nope', mockup: 'MK-9999' }),
      ),
    ).toEqual(['FEEDBACK_TARGET_UNKNOWN /mockup']);
    expect(
      refusal(
        await as('member', 'POST', '/feedback', {
          kind: 'bug',
          title: 'Two',
          mockup: mk,
          requirement: req,
        }),
      )[0],
    ).toMatch(/^FEEDBACK_TARGET_NOT_ONE/);
  });
});

describe("a feedback item's reporter data, while another item is about one of its mockups", () => {
  it('is refused by name, naming the item that still targets the mockup; nothing is deleted', async () => {
    const reported = ok(
      await as('member', 'POST', '/feedback', {
        kind: 'bug',
        title: 'The cart double charges',
        screen: 'Cart',
      }),
      201,
    );
    const fbA = ((reported.feedback ?? reported) as Doc).key as string;
    const mk = (await propose({ target: { feedback: fbA }, ...html() })).key as string;
    const about = ok(
      await as('member', 'POST', '/feedback', { kind: 'bug', title: 'Pay is hidden', mockup: mk }),
      201,
    );
    const fbB = ((about.feedback ?? about) as Doc).key as string;
    const res = await as('owner', 'DELETE', `/feedback/${fbA}/reporter-data`);
    expect(refusal(res)).toEqual(['FEEDBACK_REDACT_MOCKUP_TARGETED /mockups']);
    expect(JSON.stringify(res.json)).toContain(`${mk} is the target of ${fbB}`);
    // nothing went: the item keeps its words and the mockup still stands
    const still = ok(await as('owner', 'GET', `/feedback/${fbA}`));
    expect(((still.feedback ?? still) as Doc).redactedAt ?? null).toBeNull();
    ok(await as('owner', 'GET', `/mockups/${mk}`));
  });
});

describe('Approvals lists a proposed mockup with its preview and what accepting does (BC-7)', () => {
  it('a requirement mockup waits there, its accept pinning it in the next baseline', async () => {
    const req = await requirement('A screen waiting on a decision', 'screen');
    const mk = (await propose({ target: { requirement: req }, ...html() })).key as string;
    const inbox = ok(await as('owner', 'GET', '/approvals'));
    const row = (inbox.items as Doc[]).find((i) => i.key === mk);
    expect(row).toMatchObject({
      kind: 'mockup',
      mockupKind: 'html',
      opens: { kind: 'requirement', key: req },
      mockup: {
        url: `/api/projects/${w.projectId}/mockups/${mk}/content`,
        round: 1,
        revises: null,
        openComments: 0,
        consequence: 'pinned_next_baseline',
      },
      approve: { act: 'mockup.accept' },
    });
  });
});

describe('an accepted requirement mockup is pinned into its baseline (BC-6)', () => {
  it('the agree pins one accepted before it; one accepted after makes a re-pin due that pins it', async () => {
    const req = await requirement('The receipt lists every line', 'screen');
    const before = await propose({ target: { requirement: req }, ...html() });
    ok(await decide(before.key as string, 'accept'));
    await agreeR1(req);
    expect(await pinsOf(req)).toEqual([[before.id]]);
    const after = await propose({ target: { requirement: req }, ...html('later.html') });
    ok(await decide(after.key as string, 'accept'));
    const repinned = ok(
      await as('owner', 'POST', `/requirements/${req}/repin`, {
        revision: 1,
        reason: 'Agreed with the owner for this test.',
      }),
    );
    expect(repinned.key).toBe(req);
    const pins = await pinsOf(req);
    expect(pins.at(-1)?.sort()).toEqual([before.id, after.id].sort());
    expect(
      refusal(
        await as('owner', 'POST', `/requirements/${req}/repin`, {
          revision: 1,
          reason: 'Agreed with the owner for this test.',
        }),
      ),
    ).toEqual(['REQUIREMENT_PINS_CURRENT /revision']);
    const shown = ok(await as('owner', 'GET', `/mockups/${after.key}`)).mockup as Doc;
    expect(shown.pinned).toMatchObject({ revision: 1 });
  });
});
