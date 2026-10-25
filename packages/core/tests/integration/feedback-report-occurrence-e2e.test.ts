/**
 * REQ-66 BC-1, BC-3, BC-7 (ISS-694): anyone reports from any page, as themselves, with one sentence and
 * a screenshot; the agent fills the kind and severity and names the open item a repeat joins as an
 * occurrence, never a new item; and on a sensitive project the agent reads the sentence scrubbed, the
 * screenshot only once its reporter marks it redacted, and at no_egress neither.
 *
 * The model is a stand-in that answers what each test sets, behind the real egress gate, and keeps
 * the prompt it was sent; the embedder is a word bag, so the nearest item shares the sentence's words.
 *
 * @direct-test-of packages/core/src/feedback/report.ts
 * @direct-test-of packages/core/src/feedback/occurrences.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';

const DIM = 1536;

function wordBag(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 7;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % DIM;
    v[h] = (v[h] ?? 0) + 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

vi.mock('../../src/integrations/llm/embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embeddingsConfigured: () => true,
  embedWithModel: async (_scope: unknown, text: string) => ({
    vector: wordBag(text),
    model: 'word-bag',
  }),
}));

const model = vi.hoisted(() => ({
  answer: { kind: 'bug', severity: 'high', sameAs: null as string | null },
  sent: [] as string[],
}));

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/integrations/llm/index.js')>();
  const { egressScoped } = await import('../../src/lib/data-egress.js');
  return {
    ...real,
    callFastModelObject: async (scope: { surface: string }, prompt: string, ...rest: unknown[]) => {
      if (scope.surface !== 'feedback') {
        return (real.callFastModelObject as (...a: unknown[]) => unknown)(scope, prompt, ...rest);
      }
      const sent = await egressScoped(scope as never, prompt);
      if (!sent.ok) return { ok: false, miss: 'withheld', detail: sent.refusal.code };
      model.sent.push(sent.text);
      return { ok: true, value: { ...model.answer }, modelId: 'test-fast' };
    },
  };
});

/** A 1x1 PNG, the smallest screenshot the attachment sniffer stores as an image. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const shot = (redacted: boolean) => ({
  name: 'screenshot.png',
  mime: 'image/png',
  contentBase64: PNG,
  redacted,
});

let say: (who: string, method: string, path: string, body?: unknown) => Promise<Reply>;
const p = { open: '', redact: '', closed: '' };
let ownerId = '';

async function project(level: 'off' | 'redact' | 'no_egress'): Promise<string> {
  const id = (await createTestProject(ownerId)).id;
  if (level !== 'off') {
    const { seedProjectDocument } = await import('../helpers/release-world.js');
    await seedProjectDocument(id, ownerId, { environments: {}, extra: { sensitiveData: level } });
  }
  return id;
}

const report = (who: string, projectId: string, body: Record<string, unknown>) =>
  say(who, 'POST', `/api/projects/${projectId}/feedback/report`, body);

/** The item's vector is written after its filing commits: read until it is. */
async function embedded(projectId: string, key: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const [row] = await rows<{ status: string }>(
      sql`SELECT e.status FROM item_embeddings e JOIN feedback f ON f.id = e.feedback_id
        WHERE f.project_id = ${projectId} AND f.fb_seq = ${Number(key.slice(3))}`,
    );
    if (row?.status === 'embedded') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${key} was never embedded`);
}

const itemCount = async (projectId: string) =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${projectId}`,
    )
  )[0]?.n;

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { PAT_GRANT_EPOCH } = await import('../../src/credentials/pat-permissions.js');
  ownerId = (await createTestUser({ verified: true })).id;
  const viewer = (await createTestUser({ verified: true })).id;
  const other = (await createTestUser({ verified: true })).id;
  const agent = (await createTestUser({ kind: 'agent' })).id;
  p.open = await project('off');
  p.redact = await project('redact');
  p.closed = await project('no_egress');
  for (const id of [p.open, p.redact, p.closed]) {
    await addProjectMember(id, viewer, 'viewer');
    await addProjectMember(id, other, 'member');
    await addProjectMember(id, agent, 'member');
  }
  const agentPat = (
    await mintPat({
      permissions: ['*'],
      userId: agent,
      name: 'box',
      projectIds: [p.open, p.redact, p.closed],
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;
  say = requester(app, {
    owner: await signUserToken(ownerId),
    viewer: await signUserToken(viewer),
    other: await signUserToken(other),
    agent: agentPat,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('anyone files from any page as themselves, with one sentence and a screenshot (BC-1)', () => {
  it('files a viewer’s sentence with the kind and severity the agent read, about the page, with its screenshot', async () => {
    model.answer = { kind: 'bug', severity: 'high', sameAs: null };
    const filed = ok(
      await report('viewer', p.open, {
        said: 'The board scrolls to the top by itself every few seconds',
        whereSeen: '/projects/demo/board',
        screenshot: shot(false),
      }),
      201,
    );
    expect(filed).toMatchObject({
      created: true,
      filledBy: 'agent',
      screenshot: { state: 'kept' },
    });
    const item = filed.feedback as Doc;
    expect(item).toMatchObject({
      title: 'The board scrolls to the top by itself every few seconds',
      kind: 'bug',
      severity: 'high',
      target: { type: 'screen', key: '/projects/demo/board' },
      reporter: { name: expect.any(String), agency: 'human' },
    });
    expect(item.attachments).toEqual([
      expect.objectContaining({ mime: 'image/png', redacted: false }),
    ]);
    expect(model.sent.at(-1)).toContain('Page: /projects/demo/board');
  });

  it('is about the issue the page shows, where its path names one', async () => {
    model.answer = { kind: 'question', severity: 'low', sameAs: null };
    const made = ok(
      await say('owner', 'POST', `/api/projects/${p.open}/issues`, { title: 'Export the board' }),
      201,
    );
    const key = String(made.displayId);
    const filed = ok(
      await report('viewer', p.open, {
        said: 'Which columns does the export keep',
        whereSeen: `/projects/demo/issues/${key}`,
      }),
      201,
    );
    expect(filed.feedback).toMatchObject({ kind: 'question', target: { type: 'issue', key } });
    expect(filed.screenshot).toEqual({ state: 'none' });
  });

  it('refuses a sentence that is empty, naming the field', async () => {
    const res = await report('viewer', p.open, { said: '   ', whereSeen: '/projects/demo/board' });
    expect(res.status, JSON.stringify(res.json)).toBe(400);
    expect(JSON.stringify(res.json)).toMatch(/said/);
  });
});

describe('a repeat joins the open item as an occurrence, never a new item (BC-3)', () => {
  it('joins the item the agent names, with what was said and the screenshot, and its reporter is told as one of its own', async () => {
    model.answer = { kind: 'bug', severity: 'medium', sameAs: null };
    const first = ok(
      await report('owner', p.open, {
        said: 'Saving the card drops the due date',
        whereSeen: '/projects/demo/board',
      }),
      201,
    ).feedback as Doc;
    const key = String(first.key);
    await embedded(p.open, key);
    const before = await itemCount(p.open);

    model.answer = { kind: 'bug', severity: 'medium', sameAs: key };
    const joined = ok(
      await report('other', p.open, {
        said: 'The due date is gone after saving a card',
        whereSeen: '/projects/demo/board?card=4',
        screenshot: shot(true),
      }),
    );
    expect(joined).toMatchObject({ created: false, screenshot: { state: 'kept' } });
    const item = joined.feedback as Doc;
    expect(item.key, 'the open item, not a new one').toBe(key);
    expect(await itemCount(p.open), 'no row was filed for the repeat').toBe(before);
    expect(
      (
        await rows<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${p.open} AND duplicate_of IS NOT NULL`,
        )
      )[0]?.n,
      'no duplicate row either',
    ).toBe(0);
    const occurrences = item.occurrences as Doc[];
    expect(occurrences).toHaveLength(1);
    const attachment = (item.attachments as Doc[]).find((a) => a.redacted === true);
    expect(occurrences[0]).toMatchObject({
      said: 'The due date is gone after saving a card',
      attachmentId: attachment?.id,
      reporter: { agency: 'human' },
    });
    expect((item.reporters as Doc[]).map((r) => r.id)).toContain(occurrences[0]?.reporter.id);
    expect(model.sent.at(-1), 'the agent was shown the open item to judge against').toContain(
      `${key}: Saving the card drops the due date`,
    );
  });

  it('files a new item where the agent names a key that is no open item near the sentence', async () => {
    model.answer = { kind: 'idea', severity: 'low', sameAs: 'FB-999' };
    const before = await itemCount(p.open);
    const filed = ok(
      await report('viewer', p.open, {
        said: 'A dark theme for the timeline would help at night',
        whereSeen: '/projects/demo/timeline',
      }),
      201,
    );
    expect(filed.created).toBe(true);
    expect(await itemCount(p.open)).toBe((before ?? 0) + 1);
  });
});

describe('personal data is removed before a model reads feedback on a sensitive project (BC-7)', () => {
  it('sends the agent the sentence scrubbed where the project redacts', async () => {
    model.answer = { kind: 'bug', severity: 'medium', sameAs: null };
    ok(
      await report('viewer', p.redact, {
        said: 'Mail to ann.lee@example.com bounces from the invite page',
        whereSeen: '/projects/demo/invite',
      }),
      201,
    );
    expect(model.sent.at(-1)).not.toContain('ann.lee@example.com');
  });

  it('keeps an attachment filed through the item’s own door from an agent where the project redacts, until it is marked redacted', async () => {
    const made = ok(
      await say('owner', 'POST', `/api/projects/${p.redact}/feedback`, {
        kind: 'bug',
        title: 'The ward board is blank',
        screen: '/projects/demo/wards',
      }),
      201,
    ).feedback as Doc;
    const { redacted: _r, ...unmarked } = shot(false);
    const attached = ok(
      await say(
        'owner',
        'POST',
        `/api/projects/${p.redact}/feedback/${String(made.key)}/attachments`,
        unmarked,
      ),
    ).feedback as Doc;
    const [a] = attached.attachments as Doc[];
    const res = await say(
      'agent',
      'GET',
      `/api/projects/${p.redact}/feedback/${String(made.key)}/attachments/${String(a?.id)}`,
    );
    expect(res.status, 'no scrubber read the image, so no model may').toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.json)).toContain('EGRESS_BYTES_UNREDACTED');
  });

  it('hands an agent a screenshot’s bytes only once its reporter marked it redacted, and a person always', async () => {
    model.answer = { kind: 'bug', severity: 'medium', sameAs: null };
    const filed = ok(
      await report('viewer', p.redact, {
        said: 'The patient list shows the wrong ward',
        whereSeen: '/projects/demo/wards',
        screenshot: shot(false),
      }),
      201,
    ).feedback as Doc;
    const bytesOf = (who: string, aid: string) =>
      say(who, 'GET', `/api/projects/${p.redact}/feedback/${String(filed.key)}/attachments/${aid}`);
    const [unredacted] = filed.attachments as Doc[];
    const refused = await bytesOf('agent', String(unredacted?.id));
    expect(refused.status, JSON.stringify(refused.json)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refused.json)).toContain('EGRESS_BYTES_UNREDACTED');
    expect((await bytesOf('owner', String(unredacted?.id))).status, 'a person reads it whole').toBe(
      200,
    );

    const marked = ok(
      await say(
        'owner',
        'POST',
        `/api/projects/${p.redact}/feedback/${String(filed.key)}/attachments`,
        {
          ...shot(true),
        },
      ),
    ).feedback as Doc;
    const redacted = (marked.attachments as Doc[]).find((a) => a.redacted === true);
    expect((await bytesOf('agent', String(redacted?.id))).status).toBe(200);
  });

  it('asks the reporter for the kind where the project keeps feedback from models, and keeps the screenshot from every agent', async () => {
    const sent = model.sent.length;
    const asked = await report('viewer', p.closed, {
      said: 'The ward list will not load',
      whereSeen: '/projects/demo/wards',
    });
    expect(asked.status, JSON.stringify(asked.json)).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(asked.json)).toContain('FEEDBACK_KIND_NEEDED');
    expect(model.sent.length, 'nothing reached the model').toBe(sent);

    const filed = ok(
      await report('viewer', p.closed, {
        said: 'The ward list will not load',
        whereSeen: '/projects/demo/wards',
        kind: 'bug',
        screenshot: shot(true),
      }),
      201,
    );
    expect(filed).toMatchObject({
      filledBy: 'reporter',
      feedback: { kind: 'bug', severity: 'medium' },
    });
    const [a] = (filed.feedback as Doc).attachments as Doc[];
    const res = await say(
      'agent',
      'GET',
      `/api/projects/${p.closed}/feedback/${String((filed.feedback as Doc).key)}/attachments/${String(a?.id)}`,
    );
    expect(JSON.stringify(res.json)).toContain('CONTENT_EGRESS_FORBIDDEN');
  });
});

// last in the file: it names this world's home project for good
describe('a repeat through the Forge door is one of the item’s reporters (BC-3)', () => {
  it('names the second reporter of a signal among the item’s reporters, so a step and the ship reach them', async () => {
    await rows(sql`
      INSERT INTO instance_settings (id, forge_home_project_id) VALUES (1, ${p.open})
      ON CONFLICT (id) DO UPDATE SET forge_home_project_id = ${p.open}
    `);
    const body = {
      kind: 'bug',
      title: 'forge claim refuses a free lease',
      whereSeen: 'cli:forge claim',
      signalKey: 'cli:forge claim:lease-refused',
    };
    const first = ok(await say('viewer', 'POST', '/api/forge/feedback', body), 201);
    const again = await say('other', 'POST', '/api/forge/feedback', body);
    expect(again.status, JSON.stringify(again.json)).toBeLessThan(300);
    const key = String(first.key ?? first.feedback?.key);
    const item = ok(await say('owner', 'GET', `/api/projects/${p.open}/feedback/${key}`))
      .feedback as Doc;
    const reporters = (item.reporters as Doc[]).map((r) => r.id);
    expect(reporters, 'both reporters of the signal').toHaveLength(2);
    expect((item.occurrences as Doc[] | undefined)?.length).toBe(1);
  });
});
