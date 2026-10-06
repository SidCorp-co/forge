import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  acknowledgement,
  type ChannelWorld,
  changeNotice,
  decision,
  ok,
  openChannelWorld,
  type Reply,
  refusal,
  rfi,
  type Speaker,
  speaker,
} from '../helpers/channel-world.js';
import { closeWorld, type Doc, refusedByDb } from '../helpers/ecosystem-world.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const forge = () => `/api/projects/${w.project.forge}/channel`;
const plugin = () => `/api/projects/${w.project.plugin}/channel`;

async function publish(who: Speaker, base: string, draft: Doc): Promise<Doc> {
  const made = ok(await say(who, 'POST', `${base}/drafts`, draft));
  return ok(await say(who, 'POST', `${base}/documents/${made.id}/submit`));
}

const ids: Record<string, string> = {};

/** A body the route's shape refuses before any rule reads it: a 400 naming the missing field. */
const badBody = (r: Reply): string[] => {
  expect(r.status, JSON.stringify(r.json)).toBe(400);
  return (r.json.error?.refusals ?? []).map((x: Doc) => `${x.code} ${x.path}`);
};

describe('a master writes a change notice, and the channel numbers and publishes it', () => {
  it('writes a draft with no number, authored by the master', async () => {
    const draft = ok(await say('masterForge', 'POST', `${forge()}/drafts`, changeNotice(w)));
    expect(draft.document).toMatchObject({
      state: 'draft',
      number: null,
      from: w.project.forge,
      authoredBy: { kind: 'agent', id: w.agent.forge, via: 'master' },
    });
    ids.cn = draft.id;
  });

  it('refuses a draft whose shape is wrong, by name', async () => {
    const memo = { ...changeNotice(w), type: 'memo' };
    expect(refusal(await say('masterForge', 'POST', `${forge()}/drafts`, memo))).toContain(
      'DOCUMENT_TYPE_UNKNOWN /type',
    );
    const loose = changeNotice(w);
    loose.body.chat = 'hi';
    expect(refusal(await say('masterForge', 'POST', `${forge()}/drafts`, loose))).toContain(
      'UNKNOWN_KEY /body/chat',
    );
  });

  it('publishes at submit as FP-CN-1 under the publish gate', async () => {
    const res = ok(await say('masterForge', 'POST', `${forge()}/documents/${ids.cn}/submit`));
    expect(res.document).toMatchObject({ state: 'published', number: 'FP-CN-1' });
    expect(res.document.gate).toEqual({ mode: 'publish' });
    expect(res.events.map((e: Doc) => e.verb)).toEqual(['draft', 'submit', 'publish']);
  });

  it('refuses a second submit of a published document', async () => {
    expect(
      refusal(await say('masterForge', 'POST', `${forge()}/documents/${ids.cn}/submit`)),
    ).toEqual(['DOCUMENT_STATE_NOT_ALLOWED /state']);
  });

  it('reaches the recipient inbox, owing a reply, and nobody else', async () => {
    const inbox = ok(await say('masterPlugin', 'GET', `${plugin()}/inbox`));
    expect(inbox.documents.map((d: Doc) => d.document.number)).toEqual(['FP-CN-1']);
    expect(inbox.documents[0]).toMatchObject({ owesReply: true, answered: false, overdue: false });
    expect(ok(await say('platform', 'GET', `${forge()}/inbox`)).returned).toBe(0);
    const store = `/api/projects/${w.project.store}/channel/documents/FP-CN-1`;
    expect((await say('store', 'GET', store)).status).toBe(404);
  });

  it('refuses a notice whose recipients core did not derive', async () => {
    const wrong = { ...changeNotice(w), to: [w.project.store] };
    const made = ok(await say('masterForge', 'POST', `${forge()}/drafts`, wrong));
    expect(
      refusal(await say('masterForge', 'POST', `${forge()}/documents/${made.id}/submit`)),
    ).toEqual(
      expect.arrayContaining(['RECIPIENT_NOT_COUNTERPARTY /to/0', 'RECIPIENTS_NOT_DERIVED /to']),
    );
  });
});

describe('the content checks are the only reader before a document crosses', () => {
  const planted: [string, (d: Doc) => void, string][] = [
    [
      'code',
      (d) => {
        d.body.question = 'Is it `open({ policyVersion })` => ok?';
      },
      'CONTENT_CODE /body/question',
    ],
    [
      'an issue key',
      (d) => {
        d.body.reason = 'ISS-1303 depends on the answer.';
      },
      'CONTENT_INTERNAL_REF /body/reason',
    ],
    [
      'an internal module',
      (d) => {
        d.body.reason = 'The runner reads it on every dispatch.';
      },
      'CONTENT_INTERNAL_REF /body/reason',
    ],
    [
      'a secret',
      (d) => {
        d.body.reason = `Call it with ghp_${'b'.repeat(36)} to see.`;
      },
      'CONTENT_SECRET /body/reason',
    ],
    [
      'a prescription',
      (d) => {
        d.body.question = 'You should change your code in the parser, agreed?';
      },
      'CONTENT_PRESCRIBES_IMPLEMENTATION /body/question',
    ],
  ];

  it.each(planted)('refuses %s at submit and nothing reaches the inbox', async (_n, mut, want) => {
    const d = rfi(w);
    mut(d);
    const made = ok(await say('masterForge', 'POST', `${forge()}/drafts`, d));
    const res = await say('masterForge', 'POST', `${forge()}/documents/${made.id}/submit`);
    expect(refusal(res)).toContain(want);
    const inbox = ok(await say('masterPlugin', 'GET', `${plugin()}/inbox`));
    expect(inbox.documents.some((x: Doc) => x.document.type === 'rfi')).toBe(false);
    const draft = ok(await say('masterForge', 'GET', `${forge()}/documents/${made.id}`));
    expect(draft.document).toMatchObject({ state: 'draft', number: null });
  });

  it('spent no number on a refused submit', async () => {
    const res = await publish('masterForge', forge(), rfi(w));
    expect(res.document.number).toBe('FP-RFI-1');
  });
});

describe('the conversation protocol holds at submit', () => {
  it('lets the recipient acknowledge, and marks the notice answered', async () => {
    const res = await publish('masterPlugin', plugin(), acknowledgement(w, 'FP-CN-1'));
    expect(res.document).toMatchObject({ number: 'FP-ACK-1', inReplyTo: 'FP-CN-1' });
    ids.ack = res.id;
    const inbox = ok(await say('masterPlugin', 'GET', `${plugin()}/inbox`));
    const cn = inbox.documents.find((d: Doc) => d.document.number === 'FP-CN-1');
    expect(cn).toMatchObject({ answered: true });
  });

  it('refuses a reply of the wrong type, from a non-recipient, or to nothing', async () => {
    const wrongType = { ...acknowledgement(w, 'FP-RFI-1'), to: [w.project.forge] };
    const made = ok(await say('masterPlugin', 'POST', `${plugin()}/drafts`, wrongType));
    expect(
      refusal(await say('masterPlugin', 'POST', `${plugin()}/documents/${made.id}/submit`)),
    ).toContain('REPLY_TYPE_NOT_ALLOWED /inReplyTo');
    const own = { ...acknowledgement(w, 'FP-CN-1'), to: [w.project.plugin] };
    const mine = ok(await say('masterForge', 'POST', `${forge()}/drafts`, own));
    expect(
      refusal(await say('masterForge', 'POST', `${forge()}/documents/${mine.id}/submit`)),
    ).toContain('REPLY_FROM_NON_RECIPIENT /from');
    const ghost = ok(
      await say('masterPlugin', 'POST', `${plugin()}/drafts`, acknowledgement(w, 'FP-CN-77')),
    );
    expect(
      refusal(await say('masterPlugin', 'POST', `${plugin()}/documents/${ghost.id}/submit`)),
    ).toContain('REF_UNRESOLVED /inReplyTo');
  });

  it('refuses an RFI decided anything but answered', async () => {
    const d = { ...decision(w, 'FP-RFI-1'), to: [w.project.forge] };
    const made = ok(await say('masterPlugin', 'POST', `${plugin()}/drafts`, d));
    expect(
      refusal(await say('masterPlugin', 'POST', `${plugin()}/documents/${made.id}/submit`)),
    ).toContain('DISPOSITION_NOT_FOR_TYPE /body/disposition');
  });
});

describe('a published document is changed only by withdrawing or superseding it', () => {
  it('asks a withdrawal for its reason, then ends the document once', async () => {
    const path = `${plugin()}/documents/${ids.ack}/withdraw`;
    expect(badBody(await say('masterPlugin', 'POST', path, {}))).toEqual([
      'WITHDRAW_WITHOUT_REASON /reason',
    ]);
    const res = ok(await say('masterPlugin', 'POST', path, { reason: 'the date was wrong' }));
    expect(res.document).toMatchObject({
      state: 'withdrawn',
      withdrawnReason: 'the date was wrong',
    });
    expect(refusal(await say('masterPlugin', 'POST', path, { reason: 'again' }))).toEqual([
      'DOCUMENT_STATE_NOT_ALLOWED /state',
    ]);
    const inbox = ok(await say('masterPlugin', 'GET', `${plugin()}/inbox`));
    const cn = inbox.documents.find((d: Doc) => d.document.number === 'FP-CN-1');
    expect(cn).toMatchObject({ answered: false });
  });

  it('supersedes an acknowledgement with a later one, and keeps both numbers', async () => {
    const first = await publish('masterPlugin', plugin(), acknowledgement(w, 'FP-CN-1'));
    const second = await publish('masterPlugin', plugin(), acknowledgement(w, 'FP-CN-1'));
    expect([first.document.number, second.document.number]).toEqual(['FP-ACK-2', 'FP-ACK-3']);
    const path = `${plugin()}/documents/${first.id}/supersede`;
    expect(badBody(await say('masterPlugin', 'POST', path, { by: 'FP-ACK-3' }))).toEqual([
      'SUPERSEDE_WITHOUT_REASON /reason',
    ]);
    expect(
      refusal(await say('masterPlugin', 'POST', path, { by: 'FP-CN-1', reason: 'newer' })),
    ).toEqual(['SUPERSEDE_NOT_A_REPLACEMENT /by']);
    const res = ok(
      await say('masterPlugin', 'POST', path, { by: 'FP-ACK-3', reason: 'newer date' }),
    );
    expect(res.document).toMatchObject({ state: 'superseded', supersededBy: 'FP-ACK-3' });
  });

  it('refuses an edit of a published document', async () => {
    const { ecosystem: _e, ...input } = changeNotice(w);
    expect(
      refusal(await say('masterForge', 'PUT', `${forge()}/documents/${ids.cn}`, input)),
    ).toEqual(['DOCUMENT_STATE_NOT_ALLOWED /state']);
  });
});

describe('the database holds the channel write-once, whatever the code does', () => {
  it('refuses UPDATE and DELETE of a published document', async () => {
    await refusedByDb(
      db.execute(sql`UPDATE channel_documents SET document = '{}'::jsonb WHERE id = ${ids.cn}`),
      /FP-CN-1 is published and write-once/,
    );
    await refusedByDb(
      db.execute(sql`DELETE FROM channel_documents WHERE id = ${ids.cn}`),
      /holds number FP-CN-1, and a numbered document is never deleted/,
    );
  });

  it('refuses a second end, an edit of an event, and ending a draft', async () => {
    await refusedByDb(
      db.execute(sql`
        INSERT INTO channel_document_events (document_id, verb, to_state, actor_kind, actor_id, actor_via, user_id, reason)
        VALUES (${ids.ack}, 'withdraw', 'withdrawn', 'person', 'x', 'web', ${w.user.plugin}, 'twice')`),
      /channel_document_events_ends_once_uq/,
    );
    await refusedByDb(
      db.execute(
        sql`UPDATE channel_document_events SET reason = 'x' WHERE document_id = ${ids.cn}`,
      ),
      /channel_document_events is write-once/,
    );
    const [draft] = (await db.execute(
      sql`SELECT id FROM channel_documents WHERE state = 'draft' LIMIT 1`,
    )) as unknown as { id: string }[];
    await refusedByDb(
      db.execute(sql`
        INSERT INTO channel_document_events (document_id, verb, to_state, actor_kind, actor_id, actor_via, user_id, reason)
        VALUES (${draft?.id}, 'withdraw', 'withdrawn', 'person', 'x', 'web', ${w.user.plugin}, 'early')`),
      /ends only a published document/,
    );
  });

  it('refuses a counter that goes back, and a reserved number that moves', async () => {
    await refusedByDb(
      db.execute(
        sql`UPDATE channel_counters SET last_number = 1 WHERE ecosystem_id = ${w.eco} AND type = 'acknowledgement'`,
      ),
      /only counts up/,
    );
    await refusedByDb(
      db.execute(sql`DELETE FROM channel_counters WHERE ecosystem_id = ${w.eco}`),
      /is never deleted/,
    );
  });
});

describe('every document records who wrote it, and through what', () => {
  it.each([
    ['platform', 'web'],
    ['platformCli', 'cli'],
    ['platformTurn', 'assistant'],
  ] as const)('%s writes via %s', async (who, via) => {
    const made = ok(await say(who, 'POST', `${forge()}/drafts`, rfi(w)));
    expect(made.document.authoredBy).toEqual({ kind: 'person', id: w.user.platform, via });
  });

  it('refuses a viewer, and a master writing for a project it is fenced from, each by name', async () => {
    const viewer = await say('viewer', 'POST', `${plugin()}/drafts`, acknowledgement(w, 'FP-CN-1'));
    expect([viewer.status, viewer.json.error.code]).toEqual([403, 'PERMISSION_FORBIDDEN']);
    expect(viewer.json.detail).toMatch(/project\.write/);
    const fenced = await say(
      'masterForge',
      'POST',
      `${plugin()}/drafts`,
      acknowledgement(w, 'FP-CN-1'),
    );
    expect(fenced.status).toBe(403);
    expect(fenced.json.detail).toMatch(/holds no role on project/);
  });
});

describe('the two schemas are served publicly', () => {
  it.each(['document-v1.json', 'hold-v1.json'])('%s', async (file) => {
    const res = await w.app.request(`/api/schemas/${file}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { $id: string }).$id).toBe(
      `https://forge.sidcorp.co/schemas/${file}`,
    );
  });
});
