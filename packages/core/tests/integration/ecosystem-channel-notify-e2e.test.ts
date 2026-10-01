import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  acknowledgement,
  type ChannelWorld,
  changeNotice,
  ok,
  openChannelWorld,
  refusal,
  rfi,
  type Speaker,
  speaker,
} from '../helpers/channel-world.js';
import type { Doc } from '../helpers/ecosystem-world.js';
import { bindTestRunner, createTestDevice } from '../helpers/factories.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;
let publish: MockInstance;
const box = { forge: '', plugin: '' };

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
  for (const side of ['forge', 'plugin'] as const) {
    box[side] = (await createTestDevice(w.harness.db, w.user.platform)).id;
    await bindTestRunner(w.harness.db, { projectId: w.project[side], deviceId: box[side] });
  }
  const { roomManager } = await import('../../src/ws/server.js');
  publish = vi.spyOn(roomManager, 'publish');
}, 120_000);

afterAll(async () => {
  publish?.mockRestore();
  await w.harness.cleanup();
});

const forge = () => `/api/projects/${w.project.forge}/channel`;
const plugin = () => `/api/projects/${w.project.plugin}/channel`;

async function send(who: Speaker, base: string, d: Doc) {
  const id = ok(await say(who, 'POST', `${base}/drafts`, d)).id;
  return say(who, 'POST', `${base}/documents/${id}/submit`);
}

function wakes(): { room: string; data: unknown }[] {
  return publish.mock.calls
    .map(([room, envelope]) => ({ room, ...(envelope as { event: string; data: unknown }) }))
    .filter((e) => e.event === 'master.wake')
    .map(({ room, data }) => ({ room, data }));
}

async function bell(userId: string, type: string) {
  const rows = await w.harness.db.execute<{
    title: string;
    project_id: string;
    resolved_at: string | null;
  }>(sql`
    SELECT n.title, n.project_id, n.resolved_at FROM notifications n
    JOIN notification_delivery_members m ON m.notification_id = n.id
    JOIN notification_deliveries d ON d.id = m.delivery_id
    WHERE d.user_id = ${userId} AND n.type = ${type} AND d.resolved_notice = false
    ORDER BY n.created_at`);
  return [...rows];
}

const room = (deviceId: string) => `device:${deviceId}`;

describe('a change notice goes from forge to forge-plugin, end to end', () => {
  it('publishes FP-CN-1 and wakes only the receiving side, with no content', async () => {
    publish.mockClear();
    const res = ok(await send('masterForge', forge(), changeNotice(w)));
    expect(res.document).toMatchObject({ number: 'FP-CN-1', state: 'published' });
    expect(wakes()).toEqual([
      { room: room(box.plugin), data: { projectId: w.project.plugin, source: 'channel' } },
    ]);
  });

  it('tells the people of both sides under their own project, and no agent and no outsider', async () => {
    const theirs = await bell(w.user.plugin, 'channel_document_published');
    expect(theirs).toEqual([
      expect.objectContaining({
        project_id: w.project.plugin,
        title: expect.stringMatching(/^FP-CN-1 published: /),
      }),
    ]);
    expect(await bell(w.user.viewer, 'channel_document_published')).toHaveLength(1);
    expect(await bell(w.user.platform, 'channel_document_published')).toEqual([
      expect.objectContaining({ project_id: w.project.forge }),
    ]);
    expect(await bell(w.user.store, 'channel_document_published')).toEqual([]);
    expect(await bell(w.agent.plugin, 'channel_document_published')).toEqual([]);
    expect(await bell(w.agent.forge, 'channel_document_published')).toEqual([]);
  });

  it('lets the receiving master read it from its inbox, owing a reply, not held', async () => {
    const inbox = ok(await say('masterPlugin', 'GET', `${plugin()}/inbox`));
    expect(inbox.documents).toEqual([
      expect.objectContaining({
        document: expect.objectContaining({ number: 'FP-CN-1' }),
        owesReply: true,
        answered: false,
        hold: null,
      }),
    ]);
  });
});

describe('the owner holds the thread, and the other master sees the hold and cannot reply', () => {
  const reason = 'I want to read the migration with the plugin side first';

  it('holds FP-CN-1 for forge and wakes both sides, with no content', async () => {
    publish.mockClear();
    const res = ok(await say('platform', 'POST', `${forge()}/threads/FP-CN-1/hold`, { reason }));
    expect(res).toMatchObject({ held: true });
    expect(wakes()).toEqual([
      { room: room(box.forge), data: { projectId: w.project.forge, source: 'channel' } },
      { room: room(box.plugin), data: { projectId: w.project.plugin, source: 'channel' } },
    ]);
  });

  it('tells the other side’s people, and not the person who held it', async () => {
    const held = await bell(w.user.plugin, 'channel_thread_held');
    expect(held).toEqual([
      expect.objectContaining({ project_id: w.project.plugin, resolved_at: null }),
    ]);
    expect(held[0]?.title).toMatch(/^FP-CN-1 is held/);
    expect(await bell(w.user.viewer, 'channel_thread_held')).toHaveLength(1);
    expect(await bell(w.user.platform, 'channel_thread_held')).toEqual([]);
    expect(await bell(w.agent.plugin, 'channel_thread_held')).toEqual([]);
  });

  it('marks the hold on the receiving inbox and on the sending outbox', async () => {
    const inbox = ok(await say('masterPlugin', 'GET', `${plugin()}/inbox`));
    expect(inbox.documents[0].hold).toMatchObject({
      action: 'hold',
      side: w.project.forge,
      reason,
      by: { kind: 'person', id: w.user.platform },
    });
    const outbox = ok(await say('masterForge', 'GET', `${forge()}/outbox`));
    expect(outbox.documents[0].hold).toMatchObject({ action: 'hold', reason });
  });

  it('refuses the plugin master’s reply with THREAD_HELD', async () => {
    expect(refusal(await send('masterPlugin', plugin(), acknowledgement(w, 'FP-CN-1')))).toEqual([
      'THREAD_HELD /inReplyTo',
    ]);
  });

  it('resolves the held notice on release, and the reply then crosses, waking forge', async () => {
    ok(await say('plugin', 'POST', `${plugin()}/threads/FP-CN-1/release`, {}));
    expect(await bell(w.user.plugin, 'channel_thread_held')).toEqual([
      expect.objectContaining({ resolved_at: expect.stringMatching(/^\d{4}-/) }),
    ]);
    publish.mockClear();
    const ack = ok(await send('masterPlugin', plugin(), acknowledgement(w, 'FP-CN-1')));
    expect(ack.document.number).toBe('FP-ACK-1');
    expect(wakes()).toEqual([
      { room: room(box.forge), data: { projectId: w.project.forge, source: 'channel' } },
    ]);
    expect(await bell(w.user.platform, 'channel_document_published')).toHaveLength(2);
  });
});

describe('a gated type tells the sending admins, and the answer clears it', () => {
  let id = '';
  let question = '';

  it('notifies the sending project’s admins that FP-RFI-1 waits, and wakes nobody', async () => {
    const now = ok(await say('platform', 'GET', `/api/ecosystems/${w.eco}`));
    now.document.gate.rfi = 'approve';
    ok(
      await say('platform', 'PUT', `/api/ecosystems/${w.eco}`, {
        baseRevision: now.revision,
        document: now.document,
      }),
    );
    publish.mockClear();
    const res = ok(await send('masterForge', forge(), rfi(w)));
    id = res.id;
    expect(res.document.state).toBe('submitted');
    expect(wakes()).toEqual([]);
    expect(await bell(w.user.platform, 'channel_gate_pending')).toEqual([
      expect.objectContaining({ project_id: w.project.forge, resolved_at: null }),
    ]);
    expect(await bell(w.forgeMember, 'channel_gate_pending')).toEqual([]);
    expect(await bell(w.user.plugin, 'channel_gate_pending')).toEqual([]);
  });

  it('resolves the pending notice on approval, and then publishes as any document does', async () => {
    const page = ok(
      await say('platform', 'GET', `/api/questions?projectId=${w.project.forge}&status=open`),
    );
    question = page.questions.find((q: Doc) => q.origin?.documentId === id).id;
    publish.mockClear();
    ok(
      await say('platform', 'POST', `/api/questions/${question}/answer`, {
        round: 1,
        optionId: 'approve',
      }),
    );
    expect(await bell(w.user.platform, 'channel_gate_pending')).toEqual([
      expect.objectContaining({ resolved_at: expect.stringMatching(/^\d{4}-/) }),
    ]);
    expect(await bell(w.user.plugin, 'channel_document_published')).toHaveLength(3);
    expect(wakes()).toContainEqual({
      room: room(box.plugin),
      data: { projectId: w.project.plugin, source: 'channel' },
    });
  });

  it('refuses a note on a question that carries none somewhere, by name', async () => {
    const { askQuestion } = await import('../../src/questions/write.js');
    const asked = await askQuestion({
      id: randomUUID(),
      projectId: w.project.forge,
      prompt: 'Which branch should the release cut from?',
      blockerKind: 'human',
      answer: {
        shape: 'choice',
        recommendedOptionId: 'dev',
        options: [
          { id: 'dev', label: 'dev', authority: 'writer', bindsTo: 'session', executedBy: 'agent' },
        ],
      },
    });
    const res = await say('platform', 'POST', `/api/questions/${asked.id}/answer`, {
      round: 1,
      optionId: 'dev',
      note: 'and tag it',
    });
    expect([res.status, res.json.code]).toEqual([400, 'QUESTION_NOTE_NOT_TAKEN']);
  });
});
