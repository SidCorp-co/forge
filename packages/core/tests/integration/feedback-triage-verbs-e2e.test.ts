/**
 * Triage in four verbs and messages to reporters (feedback-triage `decide`, feedback-lifecycle
 * `new`): accept, decline, duplicate and snooze are each a transition refused by name where it does
 * not apply; a decline and a merge each tell their reporters once; a message goes to the audience its
 * preview named, with the text the preview showed; an internal note is kept for members and never
 * becomes a notice.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  settleOutbox,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

type Who = 'owner' | 'ann' | 'bo';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
const people = {} as Record<Who, string>;

const at = (path: string) => `/api/projects/${projectId}${path}`;
const item = (fb: string, act = '') => at(`/feedback/${fb}${act ? `/${act}` : ''}`);
const DAY = 86_400_000;
const later = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function refusal(r: Reply): Doc {
  expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
  const [first] = r.json.error?.refusals ?? [];
  expect(first, JSON.stringify(r.json)).toBeDefined();
  return { code: first.code, path: first.path, detail: first.detail };
}

async function file(who: Who, title: string): Promise<string> {
  const made = ok(
    await say(who, 'POST', at('/feedback'), { kind: 'bug', title, screen: '/projects/hop/board' }),
    201,
  );
  return made.feedback.key as string;
}

const read = async (fb: string, who: Who = 'owner'): Promise<Doc> =>
  ok(await say(who, 'GET', item(fb))).feedback;

/** What a person's bell holds of feedback updates, oldest first. */
async function bell(who: Who): Promise<{ title: string; body: string }[]> {
  await settleOutbox();
  return (await db.execute(sql`
    SELECT n.title, n.body
      FROM notification_deliveries d
      JOIN notification_delivery_members m ON m.delivery_id = d.id
      JOIN notifications n ON n.id = m.notification_id
     WHERE d.user_id = ${people[who]} AND n.type = 'feedback_message' AND n.project_id = ${projectId}
     ORDER BY n.created_at
  `)) as unknown as { title: string; body: string }[];
}

const told = async () =>
  (await db.execute(sql`
    SELECT count(*)::int AS n FROM pipeline_outbox
     WHERE type = 'feedback.reporterTold' AND payload ->> 'projectId' = ${projectId}
  `)) as unknown as { n: number }[];

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const tokens = {} as Record<Who, string>;
  for (const who of ['owner', 'ann', 'bo'] as const) {
    people[who] = (await createTestUser({ verified: true })).id;
    tokens[who] = await signUserToken(people[who]);
  }
  projectId = (await createTestProject(people.owner)).id;
  await addProjectMember(projectId, people.ann, 'member');
  await addProjectMember(projectId, people.bo, 'member');
  say = requester(app, tokens);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('accept: a new item is triaged with no route, and a reporter cannot accept', () => {
  it('moves new to triaged, writes no route, and waits on a person to route it', async () => {
    const fb = await file('ann', 'The board loses my filter');
    const out = ok(await say('owner', 'POST', item(fb, 'accept'), {})).feedback;
    expect(out).toMatchObject({ status: 'triaged', route: null });
    expect(out.waitingOn).toMatchObject({ act: 'route it to work' });
    expect((out.decisions as Doc[]).at(-1)).toMatchObject({ decision: 'accepted', route: null });
  });

  it('refuses a second accept, and a decision by a member without feedback.approve', async () => {
    const fb = await file('ann', 'Accept only once');
    ok(await say('owner', 'POST', item(fb, 'accept'), {}));
    expect(refusal(await say('owner', 'POST', item(fb, 'accept'), {}))).toMatchObject({
      code: 'FEEDBACK_STATUS_INVALID',
    });
    const other = await file('ann', 'A member cannot accept');
    const r = refusal(await say('bo', 'POST', item(other, 'accept'), {}));
    expect(r.code).toBe('PERMISSION_FORBIDDEN');
    expect((await read(other)).status).toBe('new');
  });

  it('links the requirement it names, and refuses one that is not there without accepting', async () => {
    const req = ok(
      await say('owner', 'POST', at('/requirements'), {
        title: 'The board keeps its filter',
        reason: 'a filter is the reader’s own',
        criteria: [{ body: 'A reload keeps the filter.' }],
      }),
      201,
    ).key as string;
    const fb = await file('ann', 'Filter gone after reload');
    const unknown = refusal(
      await say('owner', 'POST', item(fb, 'accept'), { requirement: 'REQ-999' }),
    );
    expect(unknown.code).toBe('FEEDBACK_TARGET_UNKNOWN');
    expect((await read(fb)).status, 'a refused accept must leave the item new').toBe('new');
    const out = ok(await say('owner', 'POST', item(fb, 'accept'), { requirement: req })).feedback;
    expect(out).toMatchObject({ status: 'triaged', target: { type: 'requirement', key: req } });
  });
});

describe('decline: the reporter is told the reason once', () => {
  it('refuses a decline with no reason, and an already declined item', async () => {
    const fb = await file('ann', 'Decline needs a reason');
    const none = refusal(await say('owner', 'POST', item(fb, 'triage'), { route: 'decline' }));
    expect(none.code).toBe('FEEDBACK_DECLINE_REASON_REQUIRED');
    ok(await say('owner', 'POST', item(fb, 'triage'), { route: 'decline', note: 'Not planned.' }));
    const again = refusal(
      await say('owner', 'POST', item(fb, 'triage'), { route: 'decline', note: 'Twice' }),
    );
    expect(again.code).toBe('FEEDBACK_STATUS_INVALID');
  });

  it('tells the reporter, and only the reporter, one notice naming the reason', async () => {
    const before = (await bell('ann')).length;
    const bystander = (await bell('bo')).length;
    const fb = await file('ann', 'Make the board blue');
    const out = ok(
      await say('owner', 'POST', item(fb, 'triage'), {
        route: 'decline',
        note: 'The palette is fixed by the brand guide.',
      }),
    ).feedback;
    expect(out.status).toBe('declined');
    const notices = (await bell('ann')).slice(before);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toContain(fb);
    expect(notices[0]?.body).toContain('Reason: The palette is fixed by the brand guide.');
    expect(await bell('bo')).toHaveLength(bystander);
  });
});

describe('duplicate: the reporters and evidence read on the original, each told once', () => {
  it('refuses itself and a declined original by name', async () => {
    const fb = await file('ann', 'Duplicate of itself');
    expect(
      refusal(
        await say('owner', 'POST', item(fb, 'triage'), { route: 'duplicate', duplicateOf: fb }),
      ),
    ).toMatchObject({ code: 'FEEDBACK_DUPLICATE_SELF' });
    const gone = await file('bo', 'Declined original');
    ok(
      await say('owner', 'POST', item(gone, 'triage'), { route: 'decline', note: 'Out of scope.' }),
    );
    const r = refusal(
      await say('owner', 'POST', item(fb, 'triage'), { route: 'duplicate', duplicateOf: gone }),
    );
    expect(r).toMatchObject({ code: 'FEEDBACK_DUPLICATE_OF_DECLINED', path: '/duplicateOf' });
    expect((await read(fb)).status, 'a refused duplicate must leave the item new').toBe('new');
  });

  it('moves the reporter and the screenshot to the original, keeps the record, and tells the reporter', async () => {
    const original = await file('ann', 'Export drops the last row');
    const dup = await file('bo', 'CSV export is missing a line');
    const attachment = randomUUID();
    await db.execute(sql`
      INSERT INTO feedback_attachments (id, project_id, feedback_id, name, mime, size, storage_path, flagged, uploaded_by)
      SELECT ${attachment}, project_id, id, 'export.png', 'image/png', 12, ${`feedback/${projectId}/${attachment}`}, false, reported_by
        FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${Number(dup.slice(3))}
    `);
    const before = (await bell('bo')).length;
    const out = ok(
      await say('owner', 'POST', item(dup, 'triage'), {
        route: 'duplicate',
        duplicateOf: original,
      }),
    ).feedback;
    expect(out).toMatchObject({ duplicateOf: original, status: 'triaged' });

    const notices = (await bell('bo')).slice(before);
    expect(notices, 'each moved reporter gets exactly one notice').toHaveLength(1);
    expect(notices[0]?.title).toContain(original);
    expect(notices[0]?.body).toContain(original);

    const root = await read(original);
    expect((root.reporters as Doc[]).map((r) => [r.id, r.from])).toEqual([
      [people.ann, null],
      [people.bo, dup],
    ]);
    expect(
      (root.attachments as Doc[]).map((a) => [a.name, a.from]),
      'the duplicate’s evidence reads on the original, marked with where it came from',
    ).toEqual([['export.png', dup]]);
    const kept = await read(dup);
    expect(kept.title).toBe('CSV export is missing a line');
    expect(
      (kept.attachments as Doc[]).map((a) => a.name),
      'its own record keeps its evidence',
    ).toEqual(['export.png']);
  });
});

describe('snooze: parked out of New until a date, returned by the clock', () => {
  it('refuses a past date, a date beyond a year, no reason, and a triaged item', async () => {
    const fb = await file('ann', 'Snooze me');
    expect(
      refusal(
        await say('owner', 'POST', item(fb, 'snooze'), { until: later(-1), reason: 'later' }),
      ),
    ).toMatchObject({ code: 'FEEDBACK_SNOOZE_PAST', path: '/until' });
    expect(
      refusal(
        await say('owner', 'POST', item(fb, 'snooze'), { until: later(400), reason: 'later' }),
      ).code,
    ).toBe('FEEDBACK_SNOOZE_TOO_FAR');
    expect(
      refusal(await say('owner', 'POST', item(fb, 'snooze'), { until: later(3), reason: '  ' }))
        .code,
    ).toBe('FEEDBACK_SNOOZE_REASON_REQUIRED');
    expect((await read(fb)).snoozed, 'a refused snooze must park nothing').toBeNull();
    const triaged = await file('ann', 'Already accepted');
    ok(await say('owner', 'POST', item(triaged, 'accept'), {}));
    expect(
      refusal(
        await say('owner', 'POST', item(triaged, 'snooze'), { until: later(3), reason: 'later' }),
      ).code,
    ).toBe('FEEDBACK_STATUS_INVALID');
  });

  it('shows snoozed until its date, leaves the viewer’s Needs you, and returns on its own', async () => {
    const fb = await file('ann', 'Revisit after the release');
    const until = later(5);
    const out = ok(
      await say('owner', 'POST', item(fb, 'snooze'), { until, reason: 'Wait for the 0.5 release' }),
    ).feedback;
    expect(out.snoozed).toMatchObject({ until, reason: 'Wait for the 0.5 release' });
    expect(out.status).toBe('new');
    expect(out.attentionGroup, 'a snoozed item is not owed a triage').not.toBe('needs_you');
    const { owedTriages } = await import('../../src/feedback/owed-triage.js');
    expect((await owedTriages(projectId)).map((o) => o.key)).not.toContain(fb);

    await db.execute(sql`
      UPDATE feedback SET snoozed_until = now() - interval '1 minute'
       WHERE project_id = ${projectId} AND fb_seq = ${Number(fb.slice(3))}
    `);
    const back = await read(fb);
    expect(back.snoozed, 'a snooze that ran out reads as none').toBeNull();
    expect(back.attentionGroup).toBe('needs_you');
    expect((await owedTriages(projectId)).map((o) => o.key)).toContain(fb);
  });

  it('is lifted by the act that triages it', async () => {
    const fb = await file('ann', 'Snoozed then declined');
    ok(await say('owner', 'POST', item(fb, 'snooze'), { until: later(5), reason: 'Waiting' }));
    const out = ok(
      await say('owner', 'POST', item(fb, 'triage'), {
        route: 'decline',
        note: 'Not now, not ever.',
      }),
    ).feedback;
    expect(out).toMatchObject({ status: 'declined', snoozed: null });
  });
});

describe('messages: an audience, an exact preview, and notes that never reach a reporter', () => {
  let original = '';
  let dup = '';

  beforeAll(async () => {
    original = await file('ann', 'Search ignores accents');
    dup = await file('bo', 'Accented names are not found');
    ok(
      await say('owner', 'POST', item(dup, 'triage'), {
        route: 'duplicate',
        duplicateOf: original,
      }),
    );
  });

  it('previews the exact notice and who gets it, and writes nothing', async () => {
    const sent = (await told())[0]?.n ?? 0;
    const p = ok(
      await say('owner', 'POST', item(original, 'messages/preview'), {
        audience: 'all_reporters',
        text: '  We are fixing accents this week.  ',
      }),
    ).preview;
    expect(p.title).toBe(`A message about ${original}: Search ignores accents`);
    expect(p.body).toBe('We are fixing accents this week.');
    expect((p.recipients as Doc[]).map((r) => r.id)).toEqual([people.ann, people.bo]);
    expect((await told())[0]?.n).toBe(sent);
    expect((await read(original)).messages).toEqual([]);
  });

  it('sends to this reporter only, or to every reporter merged in, the text the preview showed', async () => {
    const annBefore = (await bell('ann')).length;
    const boBefore = (await bell('bo')).length;
    const text = 'Thanks, we can reproduce it.';
    const preview = ok(
      await say('owner', 'POST', item(original, 'messages/preview'), {
        audience: 'reporter',
        text,
      }),
    ).preview;
    ok(await say('owner', 'POST', item(original, 'messages'), { audience: 'reporter', text }), 201);
    const first = (await bell('ann')).slice(annBefore);
    expect(first).toEqual([{ title: preview.title, body: preview.body }]);
    expect(await bell('bo')).toHaveLength(boBefore);

    ok(
      await say('owner', 'POST', item(original, 'messages'), {
        audience: 'all_reporters',
        text: 'Fixed in the next release.',
      }),
      201,
    );
    expect((await bell('ann')).slice(annBefore)).toHaveLength(2);
    const second = (await bell('bo')).slice(boBefore);
    expect(second).toHaveLength(1);
    expect(second[0]?.body).toBe('Fixed in the next release.');
    const thread = (await read(original)).messages as Doc[];
    expect(thread.map((m) => m.audience)).toEqual(['reporter', 'all_reporters']);
  });

  it('refuses an empty message, a member without feedback.approve, and an internal preview', async () => {
    expect(
      refusal(
        await say('owner', 'POST', item(original, 'messages'), {
          audience: 'reporter',
          text: '   ',
        }),
      ).code,
    ).toBe('FEEDBACK_MESSAGE_EMPTY');
    expect(
      refusal(
        await say('bo', 'POST', item(original, 'messages'), { audience: 'reporter', text: 'hi' }),
      ).code,
    ).toBe('PERMISSION_FORBIDDEN');
    expect(
      refusal(
        await say('owner', 'POST', item(original, 'messages/preview'), {
          audience: 'internal',
          text: 'hi',
        }),
      ).path,
    ).toBe('/audience');
  });

  it('names a reporter with no bell instead of messaging nobody', async () => {
    const agentItem = await file('ann', 'Reported by an agent');
    await db.execute(sql`
      UPDATE feedback SET reporter_agency = 'agent' WHERE project_id = ${projectId} AND fb_seq = ${Number(agentItem.slice(3))}
    `);
    const r = refusal(
      await say('owner', 'POST', item(agentItem, 'messages'), {
        audience: 'reporter',
        text: 'hello',
      }),
    );
    expect(r.code).toBe('FEEDBACK_MESSAGE_NO_RECIPIENT');
  });

  it('keeps an internal note for members: marked, read back, and never a notice', async () => {
    const annBefore = (await bell('ann')).length;
    const boBefore = (await bell('bo')).length;
    const sent = (await told())[0]?.n ?? 0;
    const out = ok(
      await say('owner', 'POST', item(original, 'messages'), {
        audience: 'internal',
        text: 'Ann has asked twice; call her before replying.',
      }),
      201,
    ).feedback;
    const note = (out.messages as Doc[]).find((m) => m.audience === 'internal');
    expect(note).toMatchObject({
      text: 'Ann has asked twice; call her before replying.',
      recipients: [],
    });
    expect((await told())[0]?.n, 'an internal note must not reach the outbox as a notice').toBe(
      sent,
    );
    expect(await bell('ann'), 'an internal note must not reach the reporter').toHaveLength(
      annBefore,
    );
    expect(await bell('bo')).toHaveLength(boBefore);
    const asReporter = (await read(original, 'ann')).messages as Doc[];
    expect(
      asReporter.some((m) => m.audience === 'internal'),
      'the reporter the note is about does not read it',
    ).toBe(false);
    const asMergedReporter = (await read(original, 'bo')).messages as Doc[];
    expect(
      asMergedReporter.some((m) => m.audience === 'internal'),
      'a reporter merged in by a duplicate is a reporter too',
    ).toBe(false);
    const asTriager = (await read(original, 'owner')).messages as Doc[];
    expect(asTriager.some((m) => m.audience === 'internal')).toBe(true);
  });

  it('cannot be stored with a recipient: the row refuses it', async () => {
    const insert = db.execute(sql`
      INSERT INTO feedback_messages (project_id, feedback_id, audience, body, recipients, sent_by, sent_agency)
      SELECT project_id, id, 'internal', 'sneaky', ARRAY[reported_by], reported_by, 'human'
        FROM feedback WHERE project_id = ${projectId} AND fb_seq = ${Number(original.slice(3))}
    `);
    const err = await insert.then(
      () => null,
      (e: Error & { cause?: Error }) => e,
    );
    expect(err?.cause?.message ?? err?.message).toMatch(/feedback_messages_internal_chk/);
  });
});
