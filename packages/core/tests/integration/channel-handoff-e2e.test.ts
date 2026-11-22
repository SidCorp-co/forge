/**
 * ISS-1286 (REQ-102 BC-1, from FB-636): a master hands a finding to another project's intake through
 * one door, and the handoff is recorded on both projects. sidcorp-mail's master found its FB-13 was
 * sid-desk's code, was refused PAT_PROJECT_OUTSIDE_FENCE filing it on sid-desk, and carried it by a
 * message to sid-desk's pane that nothing in Forge recorded.
 * Here forge's master, fenced to forge, hands findings to forge-plugin (an ecosystem both are active
 * in): the plugin holds each as feedback naming forge, the item and who handed it, and the forge item
 * keeps the plugin's key; a project no ecosystem shows forge is refused by name with who links them.
 *
 * @direct-test-of packages/core/src/ecosystem/channel-handoff.ts
 * @direct-test-of packages/core/src/ecosystem/channel-routes.ts
 * @direct-test-of packages/core/src/feedback/handoff.ts
 * @direct-test-of packages/core/src/ecosystem/refusals.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ChannelWorld,
  openChannelWorld,
  type Reply,
  speaker,
} from '../helpers/channel-world.js';
import { closeWorld } from '../helpers/ecosystem-world.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const status = (r: Reply, want: number) => {
  expect(r.status, JSON.stringify(r.json)).toBe(want);
  return r.json;
};

const finding = {
  kind: 'bug',
  title: 'The plugin drops the phase field the drive job reports',
  whereSeen: 'forge-runner drive, phase report',
  body: 'The phase posted by a drive job never reaches the issue; the plugin sends an empty body.',
};

const handoff = (item: string, to = w.project.plugin) =>
  say('masterForge', 'POST', `/api/projects/${w.project.forge}/channel/handoffs`, {
    to,
    item,
    ...finding,
  });

const pluginFeedback = async (key: string) =>
  status(await say('masterPlugin', 'GET', `/api/projects/${w.project.plugin}/feedback/${key}`), 200)
    .feedback;

const notesOf = (item: { messages: { audience: string; text: string }[] }) =>
  item.messages.filter((m) => m.audience === 'internal').map((m) => m.text);

const pluginFeedbackCount = async () =>
  status(await say('masterPlugin', 'GET', `/api/projects/${w.project.plugin}/feedback`), 200)
    .total as number;

describe('a master hands a finding from its issue to a linked project (ISS-1286)', () => {
  let issue = { id: '', key: '' };
  let key = '';

  it('files it as the other project’s feedback, through the channel', async () => {
    const made = status(
      await say('masterForge', 'POST', `/api/projects/${w.project.forge}/issues`, {
        title: 'The drive job reports its phase',
        description: 'Each phase the drive job reaches is posted to its issue.',
      }),
      201,
    );
    issue = { id: made.id, key: made.displayId };
    const handed = status(await handoff(issue.key), 201).handoff;
    expect(handed).toMatchObject({
      ecosystem: { id: w.eco, slug: 'forge-platform' },
      from: { project: { id: w.project.forge, slug: 'forge' }, item: issue.key },
      to: { project: { id: w.project.plugin, slug: 'forge-plugin' } },
      created: true,
    });
    key = handed.to.feedback.key;
    expect(key).toMatch(/^FB-\d+$/);
  });

  it('the receiving project holds it as feedback naming its source: project, item and who handed it', async () => {
    const fb = await pluginFeedback(key);
    expect(fb).toMatchObject({ title: finding.title, kind: 'bug', body: finding.body });
    expect(fb.origin).toMatchObject({
      project: { id: w.project.forge, slug: 'forge' },
      issue: { id: issue.id, key: issue.key },
      reporter: { id: w.agent.forge, agency: 'agent' },
    });
    expect(notesOf(fb)).toEqual([
      `Handed from forge ${issue.key}, through ecosystem forge-platform.`,
    ]);
  });

  it('the source issue records the handoff with the receiving key', async () => {
    const thread = status(await say('masterForge', 'GET', `/api/issues/${issue.id}/comments`), 200);
    const bodies = (thread.items as { body: string }[]).map((c) => c.body);
    expect(bodies).toContain(
      `Handed to forge-plugin's intake as forge-plugin ${key}, through ecosystem forge-platform.`,
    );
  });

  it('handed again while it is open, it joins what it filed and writes nothing more', async () => {
    const before = await pluginFeedbackCount();
    const again = status(await handoff(issue.key), 200).handoff;
    expect(again.to.feedback.key).toBe(key);
    expect(again.created).toBe(false);
    expect(await pluginFeedbackCount()).toBe(before);
    const thread = status(await say('masterForge', 'GET', `/api/issues/${issue.id}/comments`), 200);
    expect(
      (thread.items as { body: string }[]).filter((c) => c.body.startsWith('Handed to ')),
    ).toHaveLength(1);
  });

  it('a different finding handed from the same issue joins what it filed as a further report, never dropped', async () => {
    const further = {
      kind: 'bug',
      title: 'The plugin retries a refused phase forever',
      whereSeen: 'forge-runner drive, phase retry',
      body: 'After a 409 the plugin posts the same phase every second until the job ends.',
      severity: 'high',
    };
    const before = await pluginFeedbackCount();
    const handed = status(
      await say('masterForge', 'POST', `/api/projects/${w.project.forge}/channel/handoffs`, {
        to: w.project.plugin,
        item: issue.key,
        ...further,
      }),
      200,
    ).handoff;
    expect([handed.to.feedback.key, handed.created]).toEqual([key, false]);
    expect(await pluginFeedbackCount()).toBe(before);
    // planted on the key ignoring content: the call answered the same and nothing was written
    const said = ((await pluginFeedback(key)).occurrences as { said: string | null }[]).map(
      (o) => o.said ?? '',
    );
    expect(said).toHaveLength(1);
    for (const part of [further.title, further.body, further.whereSeen, 'high'])
      expect(said[0]).toContain(part);
    const thread = status(await say('masterForge', 'GET', `/api/issues/${issue.id}/comments`), 200);
    expect((thread.items as { body: string }[]).map((c) => c.body)).toContain(
      `Handed a further finding to forge-plugin's intake, joining forge-plugin ${key}, through ecosystem forge-platform.`,
    );
    // the same further finding handed again is a retry: nothing more is written
    status(
      await say('masterForge', 'POST', `/api/projects/${w.project.forge}/channel/handoffs`, {
        to: w.project.plugin,
        item: issue.key,
        ...further,
      }),
      200,
    );
    expect((await pluginFeedback(key)).occurrences).toHaveLength(1);
  });
});

describe('a master hands its own feedback item, found to be another project’s part', () => {
  it('names the item on the receiving side and records the receiving key on it', async () => {
    const own = status(
      await say('masterForge', 'POST', `/api/projects/${w.project.forge}/feedback`, {
        kind: 'bug',
        title: 'Drive phases never show on the issue',
        screen: 'issue page, phase strip',
      }),
      201,
    ).feedback;
    const handed = status(await handoff(own.key), 201).handoff;
    const fb = await pluginFeedback(handed.to.feedback.key);
    expect(fb.origin).toMatchObject({
      project: { id: w.project.forge, slug: 'forge' },
      issue: null,
      reporter: { id: w.agent.forge },
    });
    expect(notesOf(fb)).toEqual([
      `Handed from forge ${own.key}, through ecosystem forge-platform.`,
    ]);
    const back = status(
      await say('masterForge', 'GET', `/api/projects/${w.project.forge}/feedback/${own.key}`),
      200,
    ).feedback;
    expect(notesOf(back)).toEqual([
      `Handed to forge-plugin's intake as forge-plugin ${handed.to.feedback.key}, through ecosystem forge-platform.`,
    ]);
  });
});

describe('a handoff no channel carries is refused by name, with nothing written', () => {
  it('refuses a project no ecosystem shows the sender, naming who links them', async () => {
    const r = await handoff('ISS-1', w.project.internal);
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    expect(r.json.error.code).toBe('HANDOFF_NOT_LINKED');
    expect(r.json.detail).toContain(
      `No ecosystem links forge to project ${w.project.internal}, so a finding cannot be handed to its intake`,
    );
    expect(r.json.detail).toContain(
      `a handoff reaches only a project shown to forge as a peer in an ecosystem it is active in (GET /api/projects/${w.project.forge}/ecosystems lists them under \`peers\`)`,
    );
    expect(r.json.detail).toContain('`POST /api/ecosystems/<ecosystem>/invitations`');
    expect(r.json.detail).toContain('`POST /api/memberships/<membership>/accept`');
    const listed = status(
      await say('platform', 'GET', `/api/projects/${w.project.internal}/feedback`),
      200,
    );
    expect(listed.total).toBe(0);
  });

  it('reads the same for a member it is not shown, and for a project that does not exist', async () => {
    const hidden = await handoff('ISS-1', w.project.store);
    const none = randomUUID();
    const absent = await handoff('ISS-1', none);
    expect([hidden.json.error.code, absent.json.error.code]).toEqual([
      'HANDOFF_NOT_LINKED',
      'HANDOFF_NOT_LINKED',
    ]);
    expect(String(hidden.json.detail).replaceAll(w.project.store, '<p>')).toBe(
      String(absent.json.detail).replaceAll(none, '<p>'),
    );
  });

  it('refuses an item this project does not hold, and its own project as the target', async () => {
    const before = await pluginFeedbackCount();
    const unknown = await handoff('ISS-99999');
    expect(unknown.status).toBe(422);
    expect(unknown.json.error.code).toBe('HANDOFF_ITEM_UNKNOWN');
    const self = await handoff('ISS-1', w.project.forge);
    expect(self.json.error.code).toBe('HANDOFF_TO_OWN_PROJECT');
    expect(await pluginFeedbackCount()).toBe(before);
  });

  // dev.721 judge and a master's first real handoff: `to` sent as a slug read "Invalid UUID" only
  it('refuses a receiving project named by slug, saying `to` takes its uuid and where it is read', async () => {
    const before = await pluginFeedbackCount();
    const slug = await handoff('ISS-1', 'forge-plugin');
    expect(slug.status, JSON.stringify(slug.json)).toBe(400);
    expect(slug.json.error.code).toBe('BAD_REQUEST');
    expect(slug.json.detail).toContain('`to` is the bare string "forge-plugin"');
    expect(slug.json.detail).toContain(`GET /api/projects/${w.project.forge}/ecosystems lists`);
    expect(slug.json.detail).toContain('`peers[].project.id`');
    expect(await pluginFeedbackCount()).toBe(before);
  });
});

// ISS-1409 (FB-818): adminhub-api's agent found a defect in another project's part that no contract
// covers (a shared MySQL left with binlog on) and was taught channel.draft, whose change request and
// RFI need a contract; the schema's refusal named no other door, so it read "invent a contract".
describe('a change request or RFI naming no contract is refused naming the handoff door, and that call is taken', () => {
  const ask = {
    need: 'Turn binlog off on the shared test MySQL the drive jobs write to.',
    rationale: 'Its binlog fills the shared box’s disk.',
    impactIfDeclined: 'The shared box runs out of disk and every test there fails.',
    urgency: 'normal',
  };
  const draft = (type: string, body: Record<string, unknown>) =>
    say('masterForge', 'POST', `/api/projects/${w.project.forge}/channel/drafts`, {
      ecosystem: w.eco,
      type,
      to: [w.project.plugin],
      subject: 'The shared test MySQL runs with binlog on',
      body,
    });
  const refusalsOf = (r: Reply) => {
    expect(r.status, JSON.stringify(r.json)).toBeGreaterThanOrEqual(400);
    return r.json.error.refusals as { code: string; path: string; detail: string }[];
  };
  it('refuses a change request with no contract, or a blank one, by name, naming the handoff door', async () => {
    for (const body of [ask, { ...ask, contract: '' }, { ...ask, contract: '  ' }]) {
      const [refusal] = refusalsOf(await draft('change-request', body));
      expect([refusal?.code, refusal?.path], JSON.stringify(body)).toEqual([
        'DOCUMENT_CONTRACT_MISSING',
        '/body/contract',
      ]);
      expect(refusal?.detail).toContain(`POST /api/projects/${w.project.forge}/channel/handoffs`);
      expect(refusal?.detail).toContain('outside any contract');
      expect(refusal?.detail).toContain('"kind": "bug" | "change_request" | "question" | "idea"');
    }
  });

  it('refuses an RFI with no reference, or a reference naming no contract, the same way', async () => {
    const question = { question: 'Is binlog on for a reason?', reason: 'It fills the disk.' };
    for (const [references, path] of [
      [undefined, '/body/references'],
      [[], '/body/references'],
      [[{ element: 'binlog' }], '/body/references/0/contract'],
    ] as const) {
      const [refusal] = refusalsOf(await draft('rfi', { ...question, references }));
      expect([refusal?.code, refusal?.path]).toEqual(['DOCUMENT_CONTRACT_MISSING', path]);
      expect(refusal?.detail).toContain(`/api/projects/${w.project.forge}/channel/handoffs`);
    }
  });

  it('keeps a malformed contract a schema refusal, and a change notice naming none is no handoff case', async () => {
    const [malformed] = refusalsOf(await draft('change-request', { ...ask, contract: 'binlog' }));
    expect(malformed?.code).toBe('SCHEMA_VIOLATION');
    const notice = refusalsOf(
      await draft('change-notice', { summary: 'binlog', changes: [], migration: 'none' }),
    );
    expect(notice.map((r) => r.code)).not.toContain('DOCUMENT_CONTRACT_MISSING');
  });

  it('following the refusal’s advice, the handoff with the sending item and no contract files feedback in the receiving project', async () => {
    const [refusal] = refusalsOf(await draft('change-request', ask));
    const advised = /POST (\/api\/projects\/[0-9a-f-]{36}\/channel\/handoffs)/.exec(
      refusal?.detail ?? '',
    )?.[1];
    expect(advised, refusal?.detail).toBe(`/api/projects/${w.project.forge}/channel/handoffs`);
    const issue = status(
      await say('masterForge', 'POST', `/api/projects/${w.project.forge}/issues`, {
        title: 'The drive job tests write to the shared MySQL',
        description: 'The integration tests of the drive job use the shared test MySQL.',
      }),
      201,
    );
    const before = await pluginFeedbackCount();
    const found = {
      kind: 'bug',
      title: 'The shared test MySQL runs with binlog on',
      whereSeen: 'shared box, MySQL eco-catalog-api-mysql-1',
    };
    const handed = status(
      await say('masterForge', 'POST', advised as string, {
        to: w.project.plugin,
        item: issue.displayId,
        ...found,
      }),
      201,
    ).handoff;
    expect(await pluginFeedbackCount()).toBe(before + 1);
    const fb = await pluginFeedback(handed.to.feedback.key);
    expect(fb).toMatchObject({ kind: 'bug', title: found.title });
    expect(fb.origin).toMatchObject({
      project: { id: w.project.forge, slug: 'forge' },
      issue: { id: issue.id, key: issue.displayId },
    });
  });
});
