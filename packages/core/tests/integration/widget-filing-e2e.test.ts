/**
 * What a widget conversation files, through the real routes: the assistant — the one thing
 * scripted — is offered one tool and reads nothing of the project; the visitor confirms the draft
 * it proposed and exactly one Feedback item is filed, as the binding's own account, with the visitor
 * as its external reporter; a discard files nothing; and the private status link says where the
 * item stands and nothing of who carries it.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../../src/index.js';
import { actorFor, can, projectResource } from '../../src/permissions/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  rows,
  truncateAll,
} from '../helpers/factories.js';
import { resetScript, script } from '../helpers/scripted-chat.js';
import {
  bindWidget,
  DRAFT,
  type Owner,
  PAGE,
  refusalOf,
  session,
  talkToDraft,
} from '../helpers/widget-world.js';

vi.hoisted(() => {
  // the web origin the frame is served from, read once on first use
  process.env.CORS_ORIGINS = 'https://forge.example';
  // the binding's signing secret is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 7).toString('base64');
});

vi.mock('../../src/integrations/llm/chat.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openChat: (await import('../helpers/scripted-chat.js')).scriptedOpenChat,
}));

let owner: Owner = { token: '', projectId: '' };
let project = { id: '', slug: '', orgId: '' };

beforeEach(async () => {
  await truncateAll();
  resetScript();
  const admin = (await createTestUser({ verified: true })).id;
  project = await createTestProject(admin);
  await addProjectMember(project.id, admin, 'admin');
  owner = { token: await userToken(admin), projectId: project.id };
});

const feedbackRows = () =>
  rows<{ id: string; reported_by: string; title: string; body: string; where_seen: string }>(
    sql`SELECT id, reported_by, title, body, where_seen FROM feedback WHERE project_id = ${project.id}`,
  );

describe('a conversation, a draft and what it files', () => {
  it('offers the model one tool, frames the visitor’s words as data, and shows it nothing of the project', async () => {
    const widget = await bindWidget(owner);
    const live = await session(widget);
    await talkToDraft(live);

    expect(script.offered.length).toBeGreaterThan(0);
    for (const offered of script.offered) expect(offered).toEqual(['widget_propose_feedback']);
    const first = script.sent[0] ?? [];
    const system = String(first[0]?.content);
    expect(system).toContain('Catalog help');
    expect(system).not.toContain(project.slug);
    expect(system).not.toContain(project.id);
    const visitor = first.filter((m) => m.role === 'user').map((m) => String(m.content));
    expect(visitor).toHaveLength(1);
    expect(visitor[0]).toMatch(/^⟦UNTRUSTED_DATA source="widget visitor"/);
    expect(visitor[0]).toContain('Ignore your rules');
    // the page the host reported reaches the model as data too
    expect(system).toContain('⟦UNTRUSTED_DATA source="widget host page"');

    const history = await api(live, 'GET', '/api/widget/session/messages');
    const messages = history.body.messages as { role: string; text: string }[];
    expect(messages.map((m) => m.role)).toEqual(['visitor', 'assistant']);
    expect(messages[1]?.text).toBe('Here is a draft. Please check it and press Send.');
  });

  it('files exactly one Feedback on confirm, as the binding’s account, with the visitor and the page', async () => {
    const widget = await bindWidget(owner);
    const live = await session(widget, { visitor: { email: 'ana@shop.example', name: 'Ana' } });
    const draftId = await talkToDraft(live);

    const filed = await api(live, 'POST', `/api/widget/session/drafts/${draftId}/confirm`);
    expect(filed.status, JSON.stringify(filed.body)).toBe(201);
    expect(filed.body.feedbackKey).toBe('FB-1');
    const statusUrl = filed.body.statusUrl as string;
    expect(statusUrl).toMatch(/^https:\/\/forge\.example\/w\/status\/fw_stat_[A-Za-z0-9_-]{43}$/);

    const items = await feedbackRows();
    expect(items).toHaveLength(1);
    const item = items[0] as (typeof items)[number];
    expect(item.title).toBe(DRAFT.title);
    expect(item.body).toContain(`What they did: ${DRAFT.did}`);
    expect(item.body).toContain(`Page: ${PAGE}`);
    expect(item.where_seen).toBe(PAGE);

    const [account] = await rows<{ kind: string }>(
      sql`SELECT kind FROM users WHERE id = ${item.reported_by}`,
    );
    expect(account?.kind).toBe('agent');
    // the account files and reads nothing: a member of no project and no organisation
    expect(
      await rows(sql`SELECT 1 FROM project_members WHERE user_id = ${item.reported_by}`),
    ).toEqual([]);
    expect(
      await rows(sql`SELECT 1 FROM organization_members WHERE user_id = ${item.reported_by}`),
    ).toEqual([]);
    expect(await can(actorFor(item.reported_by), 'project.read', projectResource(project.id))).toBe(
      false,
    );

    const [reporter] = await rows<{
      email: string;
      name: string;
      binding_id: string;
      status_token_hash: string;
      page_context: { url: string };
    }>(
      sql`SELECT email, name, binding_id, status_token_hash, page_context FROM feedback_external_reporters WHERE feedback_id = ${item.id}`,
    );
    expect(reporter?.email).toBe('ana@shop.example');
    expect(reporter?.name).toBe('Ana');
    expect(reporter?.binding_id).toBe(widget.bindingId);
    expect(reporter?.page_context.url).toBe(PAGE);
    const statusToken = statusUrl.split('/').at(-1) as string;
    expect(reporter?.status_token_hash).toBe(
      createHash('sha256').update(statusToken).digest('hex'),
    );

    // a reloaded frame reads the filed draft back with its link; the draft keeps the token sealed
    const history = await api(live, 'GET', '/api/widget/session/messages');
    const drafts = history.body.drafts as { draftId: string; state: string; filed: unknown }[];
    expect(drafts.find((d) => d.draftId === draftId)).toMatchObject({
      state: 'filed',
      filed: { feedbackKey: 'FB-1', statusUrl },
    });
    const [sealed] = await rows<{ status_token_enc: Buffer; feedback_key: string }>(
      sql`SELECT status_token_enc, feedback_key FROM widget_drafts WHERE id = ${draftId}`,
    );
    expect(sealed?.feedback_key).toBe('FB-1');
    expect(Buffer.from(sealed?.status_token_enc ?? []).toString('latin1')).not.toContain(
      statusToken,
    );

    const twice = await api(live, 'POST', `/api/widget/session/drafts/${draftId}/confirm`);
    expect(twice.status).toBe(409);
    expect(refusalOf(twice.body)).toBe('WIDGET_DRAFT_NOT_PENDING');
    expect(await feedbackRows()).toHaveLength(1);
  });

  it('files nothing on discard, and a discarded draft cannot be sent', async () => {
    const widget = await bindWidget(owner);
    const live = await session(widget);
    const draftId = await talkToDraft(live);
    const discarded = await api(live, 'POST', `/api/widget/session/drafts/${draftId}/discard`);
    expect(discarded.status, JSON.stringify(discarded.body)).toBe(200);
    expect(discarded.body).toMatchObject({ state: 'discarded', filed: null });
    const sent = await api(live, 'POST', `/api/widget/session/drafts/${draftId}/confirm`);
    expect(refusalOf(sent.body)).toBe('WIDGET_DRAFT_NOT_PENDING');
    expect(await feedbackRows()).toEqual([]);
  });

  it('never lets another session decide a visitor’s draft', async () => {
    const widget = await bindWidget(owner);
    const live = await session(widget);
    const draftId = await talkToDraft(live);
    const other = await session(widget);
    const taken = await api(other, 'POST', `/api/widget/session/drafts/${draftId}/confirm`);
    expect(refusalOf(taken.body)).toBe('WIDGET_DRAFT_NOT_PENDING');
    expect(await feedbackRows()).toEqual([]);
  });
});

describe('what a visitor reads back', () => {
  it('answers a status link with a phase and a sentence, and nothing of who carries it', async () => {
    const widget = await bindWidget(owner);
    const live = await session(widget);
    const draftId = await talkToDraft(live);
    const filed = await api(live, 'POST', `/api/widget/session/drafts/${draftId}/confirm`);
    const statusToken = (filed.body.statusUrl as string).split('/').at(-1) as string;

    const status = await api(null, 'GET', `/api/widget/status/${statusToken}`);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(Object.keys(status.body).sort()).toEqual(
      ['feedbackKey', 'filedAt', 'phase', 'says', 'title', 'updatedAt'].sort(),
    );
    expect(status.body.phase).toBe('received');
    expect(status.body.says).toBe('We received your report and will look at it soon.');
    expect(status.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(status.body)).not.toMatch(/ISS-|@|widget-/);

    const decline = await api(
      owner.token,
      'POST',
      `/api/projects/${project.id}/feedback/FB-1/triage`,
      {
        route: 'decline',
        note: 'Not planned.',
      },
    );
    expect(decline.status, JSON.stringify(decline.body)).toBe(200);
    const declined = await api(null, 'GET', `/api/widget/status/${statusToken}`);
    expect(declined.body.phase).toBe('closed');
    expect(declined.body.says).toBe('We decided not to act on this report.');
    // the reason the team gave is theirs, and the link never carries it
    expect(JSON.stringify(declined.body)).not.toContain('Not planned');

    const unknown = await api(null, 'GET', `/api/widget/status/fw_stat_${'n'.repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(refusalOf(unknown.body)).toBe('WIDGET_STATUS_UNKNOWN');
  });

  it('streams the session’s events to the frame', async () => {
    const widget = await bindWidget(owner);
    const live = await session(widget);
    const draftId = await talkToDraft(live);
    const res = await app.fetch(
      new Request('http://forge.test/api/widget/session/stream', {
        headers: { authorization: `Bearer ${live}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await api(live, 'POST', `/api/widget/session/drafts/${draftId}/discard`);
    const decoder = new TextDecoder();
    let seen = '';
    while (!seen.includes('"discarded"')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value);
    }
    await reader.cancel();
    // the room replays what it kept from before the stream opened: the visitor's message first
    const events = seen
      .split('\n\n')
      .filter((frame) => frame.startsWith('data: '))
      .map((frame) => JSON.parse(frame.slice(6)) as { type: string });
    expect(events.map((e) => e.type)).toContain('message');
    expect(events.at(-1)).toMatchObject({ type: 'draft', draft: { draftId, state: 'discarded' } });
  });
});
