import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ChannelWorld,
  changeRequest,
  ok,
  openChannelWorld,
  rfi,
  speaker,
} from '../helpers/channel-world.js';
import { type Doc, example } from '../helpers/ecosystem-world.js';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
} from '../helpers/factories.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;

type Toolset = import('../../src/assistant/tools/mcp-adapter.js').ChatToolset;

async function chatAs(
  userId: string,
  projectId: string,
  ecosystemId: string | null,
): Promise<Toolset> {
  const { resolveTurnAuthority, mintTurnCredential, CHAT_TURN_MENU } = await import(
    '../../src/auth/turn-credential.js'
  );
  const { buildChatToolContext } = await import('../../src/assistant/tools/principal.js');
  const { buildProjectToolset } = await import('../../src/assistant/tools/registry.js');
  const outcome = await resolveTurnAuthority({ userId, projectId, viaTokenId: null });
  if (!outcome.ok) throw new Error(`${outcome.refusal.code}: ${outcome.refusal.message}`);
  const credential = await mintTurnCredential({
    authority: outcome.authority,
    menu: CHAT_TURN_MENU,
    ttlMs: 600_000,
  });
  return buildProjectToolset(
    buildChatToolContext({
      credential,
      projectSlug: 'chat',
      turn: { conversationId: null, speakerUserId: userId, handleUserId: null, ecosystemId },
    }),
  );
}

async function call(t: Toolset, args: Doc): Promise<{ isError: boolean; json: Doc }> {
  const res = await t.execute('forge_channel', JSON.stringify(args));
  const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return { isError: res.isError === true, json: JSON.parse(text) };
}

const done = (r: { isError: boolean; json: Doc }): Doc => {
  expect(r.isError, JSON.stringify(r.json)).toBe(false);
  return r.json;
};

const refusedAs = (r: { isError: boolean; json: Doc }): string[] => {
  expect(r.isError, JSON.stringify(r.json)).toBe(true);
  return (r.json.error?.refusals ?? []).map((x: Doc) => `${x.code} ${x.path}`);
};

let between = '';
let pluginDraft = '';
let pluginSent = { id: '', number: '' };

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
  await createTestProjectMember(w.harness.db, {
    userId: w.user.platform,
    projectId: w.project.plugin,
    role: 'member',
  });
  const store = example('forge-plugin.interface.json');
  store.project = w.project.store;
  store.publishes = {};
  store.consumes = [
    { contract: 'forge-plugin/driver-skill', ecosystem: w.eco, builtAgainst: '2026-09-28' },
  ];
  ok(
    await say('store', 'PUT', `/api/projects/${w.project.store}/interface`, {
      baseRevision: null,
      document: store,
    }),
  );
  const base = `/api/projects/${w.project.store}/channel`;
  const asked = ok(
    await say('store', 'POST', `${base}/drafts`, { ...rfi(w), to: [w.project.plugin] }),
  );
  between = ok(await say('store', 'POST', `${base}/documents/${asked.id}/submit`)).document.number;
  const { ecosystem: _e, ...cr } = changeRequest(w);
  pluginDraft = ok(
    await say('masterPlugin', 'POST', `/api/projects/${w.project.plugin}/channel/drafts`, {
      ecosystem: w.eco,
      ...cr,
      subject: 'A plugin draft the forge side did not write',
    }),
  ).id;
  const plugin = `/api/projects/${w.project.plugin}/channel`;
  const sent = ok(
    await say('masterPlugin', 'POST', `${plugin}/drafts`, { ...rfi(w), to: [w.project.store] }),
  );
  pluginSent = {
    id: sent.id,
    number: ok(await say('masterPlugin', 'POST', `${plugin}/documents/${sent.id}/submit`)).document
      .number,
  };
}, 180_000);

afterAll(async () => {
  await w.harness.cleanup();
});

describe('a read at ecosystem scope widens to the person’s other member projects', () => {
  it('reads a document between two other members when the person holds a role on one of them', async () => {
    const project = await chatAs(w.user.platform, w.project.forge, null);
    expect(refusedAs(await call(project, { action: 'read', ref: between }))).toEqual([
      'CHANNEL_NOT_A_PARTY /ref',
    ]);
    const eco = await chatAs(w.user.platform, w.project.forge, w.eco);
    const read = done(await call(eco, { action: 'read', ref: between }));
    expect(read.document).toMatchObject({ number: between, from: w.project.store });
    // Read as the plugin project the person holds a role on, which is the document's recipient.
    expect(read.side).toBe('recipient');
  });

  it('lists that document in the register at ecosystem scope, and not at project scope', async () => {
    const numbers = async (t: Toolset) =>
      done(await call(t, { action: 'register' })).documents.map((d: Doc) => d.number);
    expect(await numbers(await chatAs(w.user.platform, w.project.forge, null))).not.toContain(
      between,
    );
    expect(await numbers(await chatAs(w.user.platform, w.project.forge, w.eco))).toContain(between);
  });
});

describe('a counterparty’s documents stay hidden', () => {
  it('does not widen for a person who holds no role on either side of a document', async () => {
    const eco = await chatAs(w.forgeMember, w.project.forge, w.eco);
    expect(refusedAs(await call(eco, { action: 'read', ref: between }))).toEqual([
      'CHANNEL_NOT_A_PARTY /ref',
    ]);
    const reg = done(await call(eco, { action: 'register' }));
    expect(
      reg.documents.filter(
        (d: Doc) => d.from !== w.project.forge && !d.to.includes(w.project.forge),
      ),
    ).toEqual([]);
  });
});

describe('a write at ecosystem scope acts from the home project only', () => {
  it('refuses to submit or withdraw a document another member project holds', async () => {
    const eco = await chatAs(w.user.platform, w.project.forge, w.eco);
    expect(refusedAs(await call(eco, { action: 'submit', ref: pluginDraft }))).toEqual([
      'CHANNEL_NOT_A_PARTY /ref',
    ]);
    const still = ok(
      await say(
        'platform',
        'GET',
        `/api/projects/${w.project.plugin}/channel/documents/${pluginDraft}`,
      ),
    );
    expect(still.document.state).toBe('draft');
    expect(
      refusedAs(await call(eco, { action: 'withdraw', ref: between, reason: 'not ours' })),
    ).toEqual(['CHANNEL_NOT_A_PARTY /ref']);
    // A document the plugin project sent, which the person could withdraw from a chat there: from
    // forge's chat it is still refused, and it stays published.
    expect(
      refusedAs(
        await call(eco, { action: 'withdraw', ref: pluginSent.number, reason: 'not ours' }),
      ),
    ).toEqual(['CHANNEL_NOT_A_PARTY /ref']);
    const kept = ok(
      await say(
        'platform',
        'GET',
        `/api/projects/${w.project.plugin}/channel/documents/${pluginSent.id}`,
      ),
    );
    expect(kept.document.state).toBe('published');
  });

  it('drafts from the home project into the scope’s ecosystem', async () => {
    const eco = await chatAs(w.user.platform, w.project.forge, w.eco);
    const { ecosystem: _e, ...cr } = changeRequest(w);
    const draft = done(await call(eco, { action: 'draft', ...cr, to: [w.project.plugin] }));
    expect(draft.document).toMatchObject({
      from: w.project.forge,
      ecosystem: w.eco,
      state: 'draft',
    });
  });

  it('refuses a draft naming an ecosystem outside the chat’s scope', async () => {
    const eco = await chatAs(w.user.platform, w.project.forge, w.eco);
    const { ecosystem: _e, ...cr } = changeRequest(w);
    expect(
      refusedAs(
        await call(eco, { action: 'draft', ...cr, ecosystem: w.otherEco, to: [w.project.plugin] }),
      ),
    ).toEqual(['CHANNEL_NOT_A_PARTY /ecosystem']);
  });
});

describe('a home project outside the ecosystem', () => {
  it('cannot open a chat at that ecosystem’s scope, refused by name', async () => {
    const res = await say('platform', 'POST', '/api/conversations', {
      projectId: w.project.internal,
      scope: { kind: 'ecosystem', ecosystemId: w.eco },
    });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('ECOSYSTEM_NOT_MEMBER');
  });

  it('reads and writes nothing through a turn whose home project is not a member', async () => {
    const eco = await chatAs(w.user.platform, w.project.internal, w.eco);
    expect(refusedAs(await call(eco, { action: 'register' }))).toEqual(['ECOSYSTEM_NOT_MEMBER /']);
  });

  it('opens a member project’s chat at ecosystem scope, and refuses changing that scope after', async () => {
    const opened = await say('platform', 'POST', '/api/conversations', {
      projectId: w.project.forge,
      scope: { kind: 'ecosystem', ecosystemId: w.eco },
    });
    expect(opened.status, JSON.stringify(opened.json)).toBe(201);
    expect(opened.json.ecosystemId).toBe(w.eco);
    const changed = await say('platform', 'PATCH', `/api/conversations/${opened.json.id}`, {
      scope: { kind: 'project' },
    });
    expect(changed.status).toBe(409);
    expect(changed.json.code).toBe('CONVERSATION_SCOPE_FIXED');
  });
});

// ISS-34 — a project whose handle agent carries no handle is a named state of that project, not a
// server crash: the conversation door refuses it 409 under its own code.
describe('a project whose handle agent has no name', () => {
  it('refuses opening its chat 409 HANDLE_HAS_NO_NAME', async () => {
    const db = w.harness.db;
    const project = await createTestProject(db, w.user.platform, { orgId: w.org.platform });
    await createTestProjectMember(db, {
      userId: w.user.platform,
      projectId: project.id,
      role: 'admin',
    });
    const nameless = (await createTestUser(db, { kind: 'agent' })).id;
    await createTestProjectMember(db, { userId: nameless, projectId: project.id, role: 'member' });

    const res = await say('platform', 'POST', '/api/conversations', { projectId: project.id });

    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(res.json.code).toBe('HANDLE_HAS_NO_NAME');
    expect(res.json.message).toContain(nameless);
  });
});
