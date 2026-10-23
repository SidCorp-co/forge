/**
 * REQ-35 slice 1 (ISS-459), built to Requirement lifecycle r14 (picture, picture_none,
 * picture_shown, kind.corrected, agreed) and Requirement to delivery r15 (pins, ready, turn): a
 * requirement revision names its kind and holds one picture fitting it, written by anyone who may edit
 * the requirement and shown at once with no accept; each replace stays in the history; and nothing
 * gates on it. REQ-35's criteria 10 and 11 (no baseline pins a mockup, no mockup is proposed about a
 * requirement) were reversed by REQ-49, whose suite is `mockups-on-the-item-e2e.test.ts`.
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { type Doc, ok, refusal, refusedByDb } from '../helpers/ecosystem-world.js';
import { rows, seedIssueStatus } from '../helpers/factories.js';
import { plantLiveBuild } from '../helpers/live-build.js';
import {
  openPictureWorld,
  PICTURES,
  pictureDoors,
  TABLE,
} from '../helpers/requirement-picture-world.js';

const w = openPictureWorld();
const { as, read, requirement, revision, history, picture, kindOf, agreeR1, ready } =
  pictureDoors(w);

describe('a revision names its kind, and its picture fits it (criteria 1, 6)', () => {
  it.each(Object.entries(PICTURES))('a %s requirement holds its picture', async (kind, body) => {
    const key = await requirement(`A ${kind} requirement`, kind);
    expect(await revision(key, 1)).toMatchObject({ kind, picture: null });
    const shown = (ok(await picture(key, 1, body)).revisions as Doc[])[0] as Doc;
    expect(shown.picture).toMatchObject({ kind: body.kind, alt: body.alt, content: body.content });
  });

  it('refuses a picture of another kind, naming the one the kind takes', async () => {
    const key = await requirement('A rule drawn as a flow', 'rule');
    expect(refusal(await picture(key, 1, PICTURES.process))).toEqual([
      'REQUIREMENT_PICTURE_KIND_MISMATCH /kind',
    ]);
    expect((await revision(key, 1)).picture).toBeNull();
  });

  it('refuses any picture on a revision that names no kind', async () => {
    const key = await requirement('A requirement with no kind');
    expect((await revision(key, 1)).kind).toBeNull();
    expect(refusal(await picture(key, 1, PICTURES.screen))).toEqual([
      'REQUIREMENT_PICTURE_KIND_MISMATCH /kind',
    ]);
  });

  it('refuses a kind outside the four by its shape', async () => {
    const key = await requirement('A requirement of a made-up kind');
    expect((await kindOf(key, 1, 'story')).status).toBe(400);
  });
});

describe("a rule's example table (criterion 2)", () => {
  it('stores inputs and expected results, and refuses a row lacking either by name', async () => {
    const key = await requirement('Shipping is free from three items', 'rule');
    const r = await picture(key, 1, {
      ...PICTURES.rule,
      content: { rows: [TABLE.rows[0], { input: 'A cart of 2 items' }, { expected: 'Free' }] },
    });
    expect(refusal(r)).toEqual([
      'REQUIREMENT_PICTURE_ROW_INCOMPLETE /content/rows/1',
      'REQUIREMENT_PICTURE_ROW_INCOMPLETE /content/rows/2',
    ]);
    expect((await revision(key, 1)).picture).toBeNull();
    ok(await picture(key, 1, PICTURES.rule));
    expect((await revision(key, 1)).picture.content).toEqual(TABLE);
  });
});

describe('a picture shows at once and anyone who can edit replaces it (criteria 3, 7, 9)', () => {
  let key = '';
  beforeAll(async () => {
    key = await requirement('The cart shows shipping', 'screen');
  });

  it('is shown on the next read with no accept, as a rough sketch, and queues no mockup', async () => {
    ok(await picture(key, 1, PICTURES.screen));
    const r1 = await revision(key, 1);
    expect(r1.state).toBe('draft');
    expect(r1.picture).toMatchObject({ roughSketch: true, drawnFor: 1, writtenBy: w.ownerId });
    const listed = ok(await as('owner', 'GET', `/mockups?requirement=${key}`));
    expect(listed.mockups).toEqual([]);
  });

  it('a member who did not write it replaces it in place; the earlier one stays in the history', async () => {
    const first = (await revision(key, 1)).picture.id as string;
    ok(
      await picture(key, 1, { ...PICTURES.screen, alt: 'The checkout frame, redrawn.' }, 'member'),
    );
    const now = (await revision(key, 1)).picture as Doc;
    expect(now.id).not.toBe(first);
    expect(now).toMatchObject({ writtenBy: w.memberId, alt: 'The checkout frame, redrawn.' });
    const lines = await history(key);
    expect(lines).toContain('Picture: Drew the picture of r1, a rough sketch: One checkout frame.');
    expect(lines).toContain(
      'Picture: Replaced the picture of r1, a rough sketch: The checkout frame, redrawn.',
    );
  });

  it('a viewer, who cannot edit the project, is refused a picture and a kind', async () => {
    const pic = await picture(key, 1, PICTURES.screen, 'viewer');
    expect(pic.status, JSON.stringify(pic.json)).toBe(403);
    expect(JSON.stringify(pic.json)).toContain('PERMISSION_FORBIDDEN');
    const k = await kindOf(key, 1, 'rule', 'viewer');
    expect(k.status).toBe(403);
    expect((await revision(key, 1)).kind).toBe('screen');
  });
});

describe('a text alternative is required (criterion 4)', () => {
  it.each(['', '   '])('refuses %j by name', async (alt) => {
    const key = await requirement('A picture with no words', 'screen');
    expect(refusal(await picture(key, 1, { ...PICTURES.screen, alt }))).toEqual([
      'REQUIREMENT_PICTURE_ALT_REQUIRED /alt',
    ]);
  });

  it('the database refuses a blank one written past the service', async () => {
    const key = await requirement('A picture written by hand', 'screen');
    const [req] = await rows<{ id: string }>(
      sql`SELECT id FROM requirements WHERE project_id = ${w.projectId} AND req_seq = ${Number(key.slice(4))}`,
    );
    await refusedByDb(
      rows(sql`INSERT INTO requirement_pictures (requirement_id, drawn_for, kind, content, alt, written_by, written_agency)
               VALUES (${req?.id}, 1, 'wireframe', '{}'::jsonb, '  ', ${w.ownerId}, 'human')`),
      /requirement_pictures_alt_chk/,
    );
  });
});

describe('a new revision carries the picture of its kind; a correction drops it (criteria 8, 9)', () => {
  let key = '';
  let drawn = '';
  beforeAll(async () => {
    key = await requirement('Free shipping from three items', 'rule');
    drawn = (ok(await picture(key, 1, PICTURES.rule)).revisions as Doc[])[0]?.picture.id as string;
    await agreeR1(key);
    ok(
      await as('owner', 'POST', `/requirements/${key}/revisions`, {
        baseRevision: 1,
        reason: 'the threshold is two items',
        criteria: [{ code: 'BC-1', body: 'A buyer sees what shipping costs before paying.' }],
      }),
    );
  });

  it('r2, of the head kind, shows the head picture', async () => {
    expect(await revision(key, 2)).toMatchObject({ kind: 'rule', picture: { id: drawn } });
  });

  it('correcting r2 to another kind leaves it no picture; r1 and the history keep it', async () => {
    ok(await kindOf(key, 2, 'process'));
    expect(await revision(key, 2)).toMatchObject({ kind: 'process', picture: null });
    expect((await revision(key, 1)).picture.id).toBe(drawn);
    expect(await history(key)).toContain(
      'Picture: Drew the picture of r1, a rough sketch: Three items ship free; one pays.',
    );
  });

  it('a draft rewritten with another kind drops its picture too', async () => {
    ok(await picture(key, 2, PICTURES.process));
    ok(
      await as('owner', 'PUT', `/requirements/${key}/revisions/2`, {
        reason: 'it is a screen after all',
        kind: 'screen',
        criteria: [{ code: 'BC-1', body: 'A buyer sees what shipping costs before paying.' }],
      }),
    );
    expect(await revision(key, 2)).toMatchObject({ kind: 'screen', picture: null });
  });

  it('a superseded revision takes neither a picture nor a kind', async () => {
    await ready(key);
    ok(await as('owner', 'POST', `/requirements/${key}/revisions/2/propose`, {}));
    ok(await as('owner', 'POST', `/requirements/${key}/revisions/2/accept`, { reason: 'ok' }));
    expect(refusal(await picture(key, 1, PICTURES.rule))).toEqual([
      'REQUIREMENT_REVISION_NOT_CURRENT /revision',
    ]);
    expect(refusal(await kindOf(key, 1, 'report'))).toEqual([
      'REQUIREMENT_REVISION_NOT_CURRENT /revision',
    ]);
  });
});

describe('no picture gates the requirement (criterion 5)', () => {
  it('a requirement with no kind and no picture is agreed, delivered and accepted', async () => {
    // production serves the commit the pass below names, so coverage can check it (ISS-489 r3)
    onTestFinished(plantLiveBuild('a'.repeat(40)));
    const key = await requirement('The board keeps its cards');
    await agreeR1(key);
    expect(await read(key)).toMatchObject({ status: 'agreed' });
    const proposed = ok(
      await as('owner', 'POST', '/suggestions', {
        kind: 'breakdown',
        requirement: key,
        baseRevision: 1,
        payload: {
          issues: [
            {
              title: 'Save every card',
              criteria: [{ body: 'a reload shows every card', tracesTo: 'BC-1' }],
              complexity: 's',
              builds: null,
            },
          ],
        },
      }),
      201,
    );
    ok(
      await as('owner', 'POST', `/suggestions/${proposed.suggestion.id}/accept`, {
        reason: 'one slice',
      }),
    );
    const [filed] = await rows<{ issue_id: string; criterion_id: string }>(sql`
      SELECT c.issue_id, c.id AS criterion_id FROM issue_criteria c
        JOIN issues i ON i.id = c.issue_id
        JOIN requirements r ON r.id = i.requirement_id
       WHERE r.project_id = ${w.projectId} AND r.req_seq = ${Number(key.slice(4))}
         AND c.requirement_criterion_id IS NOT NULL`);
    if (!filed) throw new Error('the breakdown accept filed no traced criterion');
    await rows(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, identity_kind, commit_sha, author_agency, evidence)
      VALUES (${filed.criterion_id}, ${filed.issue_id}, 'pass', 'commit', ${'a'.repeat(40)}, 'human', ARRAY['board-reload.png'])`);
    await rows(sql`UPDATE issues SET merged_at = now() WHERE id = ${filed.issue_id}`);
    await seedIssueStatus(filed.issue_id, 'closed');
    // moved by its acts, never read off the evidence (REQ-74 BC-8)
    expect((await read(key)).status).toBe('agreed');
    ok(await as('owner', 'POST', `/requirements/${key}/start-delivery`, {}));
    ok(await as('owner', 'POST', `/requirements/${key}/mark-delivered`, {}));
    expect((await read(key)).status).toBe('delivered');
    ok(
      await as('owner', 'POST', `/requirements/${key}/accept`, {
        revision: 1,
        reason: 'UAT passed',
      }),
    );
    const done = await read(key);
    expect(done.status).toBe('accepted');
    expect((done.revisions as Doc[]).every((r) => r.kind === null && r.picture === null)).toBe(
      true,
    );
  });
});
