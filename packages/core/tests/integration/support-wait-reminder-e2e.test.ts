import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { namespaceFromServerUrl } from '../../src/integrations/rocketchat/namespace.js';
import { fireWaitReminders, forgetSettledMornings } from '../../src/support/wait-reminder.js';
import { warmRoomsOfDevice } from '../../src/support/warm.js';
import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  bindTestRunner,
  createTestIssue,
  createTestProject,
  rows,
} from '../helpers/factories.js';
import { AgentWorld, OWNER_ID } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { Turn } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/wait-reminder.ts
// @direct-test-of packages/core/src/support/wait-reminder-waits.ts
// @direct-test-of packages/core/src/support/wait-reminder-post.ts
// @direct-test-of packages/core/src/support/checks.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/technical-channel.ts
// @direct-test-of packages/core/src/messaging/internal-codes.ts
// @direct-test-of packages/core/src/timer-registry.ts
//
// ISS-1343 (owner 2026-11-19): each morning every wait of a project open 12 hours or more is listed
// in one post in the project's own thread of the operations room its organization shares (a direct
// message to its owner where it binds none), written by that room's agent from what core hands it,
// every morning until the record settles it. A wait that can be written nowhere is refused by name
// on the bell of whoever it waits on.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const BABO = {
  name: 'babo',
  persona: 'You are Babo. You coordinate Forge and delivery for the team.',
  grants: ['read'],
};
const DM = 'D-alice';
const HOUR = 3_600_000;

const w = new AgentWorld();
let ops = '';
let opsBinding = '';
let slug = '';
let issueId = '';
/** 08:00 in Ho Chi Minh City (01:00 UTC) on the latest morning already past. */
let morning = new Date();

const ask = async (prompt: string, at: Date): Promise<string> => {
  const asked = await api(w.owner, 'POST', '/api/questions', {
    issueId,
    prompt,
    options: [
      { id: 'yes', label: 'Ship it', authority: 'writer', bindsTo: 'project', executedBy: 'agent' },
      { id: 'no', label: 'Hold it', authority: 'writer', bindsTo: 'project', executedBy: 'agent' },
    ],
    recommendedOptionId: 'yes',
  });
  expect(asked.status, JSON.stringify(asked.body)).toBe(201);
  const id = String(asked.body.id);
  // asked at `at`: its round and its row carry the time the Needs you read ages it by
  await db.execute(sql`
    UPDATE agent_questions
       SET created_at = ${at.toISOString()}::timestamptz,
           steps = (SELECT jsonb_agg(CASE WHEN s ? 'askedAt'
                      THEN jsonb_set(s, '{askedAt}', to_jsonb(${at.toISOString()}::text)) ELSE s END)
                      FROM jsonb_array_elements(steps) s)
     WHERE id = ${id}::uuid`);
  return id;
};

const answer = (id: string) =>
  api(w.owner, 'POST', `/api/questions/${id}/answer`, { round: 1, optionId: 'yes' });

type Handed = { thread: string; text: string };

/** Run one morning: the agent answers each reminder handed with `write(note)`, its outcomes kept. */
async function runMorning(
  at: Date,
  write: (note: Handed, turn: Turn) => Promise<Record<string, unknown> | null>,
): Promise<{ handed: Handed[]; outs: Record<string, unknown>[] }> {
  await w.settleWarm();
  const handed: Handed[] = [];
  const outs: Record<string, unknown>[] = [];
  let done = 0;
  w.box.model = async (turn, act) => {
    for (const m of turn.messages) {
      if (m.from !== 'forge' || !m.thread.startsWith('check:waits-')) continue;
      handed.push({ thread: m.thread, text: m.text });
      const finding = await write({ thread: m.thread, text: m.text }, turn);
      if (finding) outs.push(await act({ action: 'check_result', check: m.thread, ...finding }));
      done += 1;
    }
  };
  forgetSettledMornings();
  const fired = await fireWaitReminders(at);
  await expect.poll(() => done, { timeout: 20_000 }).toBe(fired);
  return { handed, outs };
}

/** The thread the shared room's binding records for the project. */
async function projectThread(): Promise<string> {
  const [row] = await rows<{ thread: string | null }>(sql`
    SELECT config #>> ${`{operations,threads,${ops},${slug}}`}::text[] AS thread
      FROM integration_bindings WHERE id = ${opsBinding}::uuid`);
  return String(row?.thread);
}

const linkOf = (note: string, n: number) =>
  note
    .split('\n')
    .find((l) => l.startsWith(`${n}. `))
    ?.match(/link: (\S+)/)?.[1] ?? '';

beforeAll(async () => {
  await w.openAgent();
  ops = w.stand.rid3;
  [{ slug } = { slug: '' }] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const [home] = await rows<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  // the organization's shared operations room, bound by a sibling as forge binds Forge-Communicate
  const sibling = await createTestProject(w.ownerId, { orgId: String(home?.org_id) });
  await addProjectMember(sibling.id, w.ownerId, 'owner');
  // the sibling's room session runs on the world's box, as forge's Forge-Communicate session does
  const [device] = await rows<{ device_id: string }>(
    sql`SELECT device_id FROM runners WHERE project_id = ${w.projectId}::uuid LIMIT 1`,
  );
  const deviceId = String(device?.device_id);
  await bindTestRunner(sibling.id, deviceId);
  await db.execute(sql`UPDATE runners SET last_seen_at = now() WHERE device_id = ${deviceId}`);
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Babo',
    config: { serverUrl: w.stand.serverUrl, role: BABO },
    secrets: { authToken: w.stand.bot.authToken, userId: w.stand.bot.userId },
    bindings: [
      {
        projectId: sibling.id,
        role: 'service',
        target: { provider: 'rocketchat', rids: [ops], operations: { scope: 'forge' } },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  const connection = String((rc.body.connection as { id: string }).id);
  const [b] = await rows<{ id: string }>(
    sql`SELECT id FROM integration_bindings WHERE connection_id = ${connection}::uuid`,
  );
  opsBinding = String(b?.id);
  await settleOutbox();
  await warmRoomsOfDevice(deviceId);
  await w.settleWarm();
  await db.execute(
    sql`UPDATE project_config_documents SET document = document - 'technicalChannel', revision = revision + 1 WHERE project_id = ${w.projectId}`,
  );
  // the project's owner is alice on the chat server, by a confirmed link: the reminder mentions her
  await db.execute(sql`
    INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
    VALUES ('rocketchat', ${namespaceFromServerUrl(w.stand.serverUrl)}, ${OWNER_ID}, 'alice', ${w.ownerId}, 'channel_email_match')`);
  const now = new Date();
  morning = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1));
  if (morning > now) morning = new Date(morning.getTime() - 24 * HOUR);
  issueId = (
    await createTestIssue(w.projectId, w.ownerId, 7901, {
      status: 'in_progress',
      createdAt: new Date(morning.getTime() - 48 * HOUR),
    })
  ).id;
}, 120_000);

afterAll(() => w.stop());

beforeEach(() => {
  w.box.model = async () => {};
});

describe('ISS-1343: the morning reminder of what waits on a person', () => {
  let evening = '';
  let night = '';
  const EVENING = 'Ship the size-M print rule before the catalog sync?';
  const NIGHT = 'Move the nightly import to 02:00?';

  it('lists a wait asked at 20:00 the next morning and not one asked at 03:00, nor two the record settled, in the project thread of the shared room', async () => {
    evening = await ask(EVENING, new Date(morning.getTime() - 12 * HOUR));
    night = await ask(NIGHT, new Date(morning.getTime() - 5 * HOUR));
    const answered = await ask(
      'Rotate the relay key this week?',
      new Date(morning.getTime() - 30 * HOUR),
    );
    const voided = await ask('Keep the old export?', new Date(morning.getTime() - 30 * HOUR));
    expect((await answer(answered)).status).toBe(200);
    const v = await api(w.owner, 'POST', `/api/questions/${voided}/void`, { reason: 'replaced' });
    expect(v.status, JSON.stringify(v.body)).toBe(200);

    const { handed, outs } = await runMorning(morning, async (note) => ({
      finding: `@alice còn một việc chờ anh từ tối qua: [in size M trước khi sync](${linkOf(note.text, 1)}). Em đề xuất: ship luôn.`,
    }));
    expect(handed).toHaveLength(1);
    const note = handed[0]?.text ?? '';
    expect(note).toContain(EVENING);
    expect(note).toContain('waited 12 hours');
    expect(note).toContain('recommended: "Ship it"');
    expect(note).toContain('owed by: @alice');
    expect(linkOf(note, 1)).toMatch(new RegExp(`/projects/${slug}/issues/${issueId}$`));
    for (const absent of [NIGHT, 'Rotate the relay key', 'Keep the old export']) {
      expect(note).not.toContain(absent);
    }
    expect(outs, JSON.stringify(outs)).toHaveLength(1);
    expect(code(outs[0]), JSON.stringify(outs[0])).toBeUndefined();
    // one post, in the project's own thread of the shared room, the link behind words: the screen admits it
    const thread = await projectThread();
    const posted = w.threadLines(ops, thread).filter((l) => l.text.includes('size M'));
    expect(posted).toHaveLength(1);
    expect(posted[0]?.text).toContain(`(${linkOf(note, 1)})`);
    expect(w.stand.linesIn(DM).some((l) => l.text.includes('size M'))).toBe(false);
    // once a morning: the same morning hands nothing again
    expect((await runMorning(morning, async () => null)).handed).toEqual([]);
  });

  it('lists the unanswered wait every morning, the 03:00 one the morning after, and drops each once answered', async () => {
    const next = new Date(morning.getTime() + 24 * HOUR);
    const second = await runMorning(next, async () => ({ finding: null }));
    const note = second.handed[0]?.text ?? '';
    expect(note.indexOf(EVENING)).toBeGreaterThan(-1);
    expect(note.indexOf(NIGHT)).toBeGreaterThan(note.indexOf(EVENING));
    expect(second.outs.map(code)).toEqual([undefined]);
    expect((await answer(evening)).status).toBe(200);
    const third = await runMorning(new Date(next.getTime() + 24 * HOUR), async () => ({
      finding: null,
    }));
    expect(third.handed[0]?.text).toContain(NIGHT);
    expect(third.handed[0]?.text).not.toContain(EVENING);
  });

  it('refuses a post naming a wait the record settled after it was handed, and takes the rest', async () => {
    const day = new Date(morning.getTime() + 72 * HOUR);
    const { outs } = await runMorning(day, async (note) => {
      expect((await answer(night)).status).toBe(200);
      return { finding: `@alice [giờ chạy import](${linkOf(note.text, 1)}) vẫn chờ anh.` };
    });
    expect(outs.map(code)).toEqual(['SUPPORT_REMINDER_SETTLED']);
    expect(JSON.stringify(outs[0])).toContain(NIGHT);
    const thread = await projectThread();
    expect(w.threadLines(ops, thread).some((l) => l.text.includes('giờ chạy import'))).toBe(false);
  });

  it('is turned off and its hour set in the project document', async () => {
    const pending = await ask(
      'Publish the spring catalog?',
      new Date(morning.getTime() - 36 * HOUR),
    );
    const set = (value: unknown) =>
      db.execute(sql`
        UPDATE project_config_documents
           SET document = jsonb_set(document, '{waitReminder}', ${JSON.stringify(value)}::jsonb), revision = revision + 1
         WHERE project_id = ${w.projectId}`);
    const day = new Date(morning.getTime() + 96 * HOUR);
    await set({ on: false });
    expect((await runMorning(day, async () => null)).handed).toEqual([]);
    await set({ hour: 9 });
    expect((await runMorning(day, async () => null)).handed).toEqual([]);
    const nine = await runMorning(new Date(day.getTime() + HOUR), async () => ({ finding: null }));
    expect(nine.handed[0]?.text).toContain('Publish the spring catalog?');
    await db.execute(
      sql`UPDATE project_config_documents SET document = document - 'waitReminder', revision = revision + 1 WHERE project_id = ${w.projectId}`,
    );
    expect((await answer(pending)).status).toBe(200);
  });

  it('writes a direct message to the owner where the organization binds no shared room', async () => {
    await ask('Turn on the weekend sale banner?', new Date(morning.getTime() - 20 * HOUR));
    await db.execute(
      sql`UPDATE integration_bindings SET active = false WHERE id = ${opsBinding}::uuid`,
    );
    try {
      const day = new Date(morning.getTime() + 120 * HOUR);
      const { handed, outs } = await runMorning(day, async (note) => ({
        finding: `@alice [banner cuối tuần](${linkOf(note.text, 1)}) đang chờ anh.`,
      }));
      expect(handed[0]?.text).toContain("a direct message to the project's owner");
      expect(outs.map(code)).toEqual([undefined]);
      expect(w.stand.linesIn(DM).at(-1)?.text).toContain(
        `${w.projectName} · @alice [banner cuối tuần](`,
      );
    } finally {
      await db.execute(
        sql`UPDATE integration_bindings SET active = true WHERE id = ${opsBinding}::uuid`,
      );
    }
  });

  it('takes the morning result only once its post went out: a refused channel or a failed post leaves it to answer again', async () => {
    const contract = await ask(
      'Renew the shipping contract?',
      new Date(morning.getTime() - 20 * HOUR),
    );
    const channel = (value: unknown) =>
      db.execute(
        value === null
          ? sql`UPDATE project_config_documents SET document = document - 'technicalChannel', revision = revision + 1 WHERE project_id = ${w.projectId}`
          : sql`UPDATE project_config_documents SET document = jsonb_set(document, '{technicalChannel}', ${JSON.stringify(value)}::jsonb), revision = revision + 1 WHERE project_id = ${w.projectId}`,
      );
    await db.execute(
      sql`UPDATE integration_bindings SET active = false WHERE id = ${opsBinding}::uuid`,
    );
    // a direct message to a person the chat server's directory does not hold: refused before any claim
    await channel({ kind: 'dm', user: 'u-nobody' });
    try {
      await w.settleWarm();
      const outs: Record<string, unknown>[] = [];
      let done = 0;
      w.box.model = async (turn, act) => {
        for (const m of turn.messages) {
          if (m.from !== 'forge' || !m.thread.startsWith('check:waits-')) continue;
          const finding = `@alice [hợp đồng vận chuyển](${linkOf(m.text, 1)}) đang chờ anh.`;
          const once = async () =>
            outs.push(await act({ action: 'check_result', check: m.thread, finding }));
          await once();
          await channel(null);
          w.stand.topLevelRefused = true;
          await once();
          w.stand.topLevelRefused = false;
          await once();
          await once();
          done += 1;
        }
      };
      forgetSettledMornings();
      const fired = await fireWaitReminders(new Date(morning.getTime() + 168 * HOUR));
      await expect.poll(() => done, { timeout: 20_000 }).toBe(fired);
      const codes = outs.map(code);
      expect(codes[0], JSON.stringify(outs[0])).toBe('SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE');
      // the chat server refused the line: the act fails, and the claim is given back
      expect(outs[1], JSON.stringify(outs[1])).toMatchObject({ isError: true });
      expect(JSON.stringify(outs[1])).toContain('chat.postMessage failed');
      expect(codes.slice(2), JSON.stringify(outs.slice(2))).toEqual([
        undefined,
        'SUPPORT_CHECK_ANSWERED',
      ]);
      const sent = w.stand.linesIn(DM).filter((l) => l.text.includes('hợp đồng vận chuyển'));
      expect(sent).toHaveLength(1);
    } finally {
      w.stand.topLevelRefused = false;
      await channel(null);
      await db.execute(
        sql`UPDATE integration_bindings SET active = true WHERE id = ${opsBinding}::uuid`,
      );
      expect((await answer(contract)).status).toBe(200);
    }
  });

  it('refuses by name, on the bell of whoever it waits on, a project whose waits can be written nowhere', async () => {
    const alone = await createTestProject(w.ownerId);
    await addProjectMember(alone.id, w.ownerId, 'owner');
    const lone = await createTestIssue(alone.id, w.ownerId, 11, {
      status: 'in_progress',
      createdAt: new Date(morning.getTime() - 72 * HOUR),
    });
    const asked = await api(w.owner, 'POST', '/api/questions', {
      issueId: lone.id,
      prompt: 'Approve the new supplier?',
      options: [
        { id: 'yes', label: 'Yes', authority: 'writer', bindsTo: 'project', executedBy: 'agent' },
      ],
      recommendedOptionId: 'yes',
    });
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    await db.execute(
      sql`UPDATE agent_questions SET created_at = now() - interval '2 days', steps = (SELECT jsonb_agg(s - 'askedAt') FROM jsonb_array_elements(steps) s) WHERE id = ${String(asked.body.id)}::uuid`,
    );
    forgetSettledMornings();
    await fireWaitReminders(new Date(morning.getTime() + 144 * HOUR));
    const alerts = await rows<{ title: string; body: string }>(sql`
      SELECT n.title, n.body FROM notifications n
       WHERE n.project_id = ${alone.id}::uuid AND n.type = 'ops_alert'`);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.title).toContain('reminder not sent');
    expect(alerts[0]?.body).toContain('SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE');
  });
});
