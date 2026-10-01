/**
 * ISS-23 — a person acts in the ecosystem channel through assistant chat, under their own authority.
 *
 * Each call is made through the toolset a chat turn builds: the person's authority resolved, a
 * turn token minted for them, `forge_channel` executed under it. Only the model is replaced.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ChannelWorld,
  changeRequest,
  decision,
  ok,
  openChannelWorld,
  refusal,
  rfi,
  speaker,
} from '../helpers/channel-world.js';
import { type Doc, example } from '../helpers/ecosystem-world.js';
import { createTestProjectMember } from '../helpers/factories.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;

type Toolset = import('../../src/assistant/tools/mcp-adapter.js').ChatToolset;

async function chatAs(userId: string, projectId: string): Promise<Toolset> {
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
    buildChatToolContext({ credential, projectSlug: 'chat', turn: undefined }),
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

let owner: Toolset;
let ownerAsAssistant: Doc;

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
  owner = await chatAs(w.user.platform, w.project.forge);
  ownerAsAssistant = { kind: 'person', id: w.user.platform, via: 'assistant' };
  const id = ok(
    await say('masterPlugin', 'POST', `/api/projects/${w.project.plugin}/channel/drafts`, {
      ...changeRequest(w),
    }),
  ).id;
  ok(
    await say(
      'masterPlugin',
      'POST',
      `/api/projects/${w.project.plugin}/channel/documents/${id}/submit`,
    ),
  );
}, 120_000);

afterAll(async () => {
  await w.harness.cleanup();
});

describe('the owner holds and answers a conversation with chat alone', () => {
  it('reads the register and the inbox of this side', async () => {
    const reg = done(await call(owner, { action: 'register' }));
    expect(reg.ecosystem).toBe(w.eco);
    expect(reg.documents.map((d: Doc) => [d.number, d.owner])).toEqual([
      ['FP-CR-1', [w.project.forge]],
    ]);
    const inbox = done(await call(owner, { action: 'inbox' }));
    expect(inbox.documents.map((d: Doc) => d.document.number)).toEqual(['FP-CR-1']);
  });

  it('holds FP-CR-1 as the person, via assistant, and the master cannot answer it', async () => {
    const held = done(
      await call(owner, { action: 'hold', thread: 'FP-CR-1', reason: 'scope first' }),
    );
    expect(held).toMatchObject({
      held: true,
      hold: { by: ownerAsAssistant, side: w.project.forge },
    });
    const base = `/api/projects/${w.project.forge}/channel`;
    const id = ok(await say('masterForge', 'POST', `${base}/drafts`, decision(w, 'FP-CR-1'))).id;
    expect(refusal(await say('masterForge', 'POST', `${base}/documents/${id}/submit`))).toEqual([
      'THREAD_HELD /inReplyTo',
    ]);
  });

  it('replies and submits, and the published decision is authored by the person via assistant', async () => {
    const { inReplyTo, ecosystem: _e, to: _t, ...rest } = decision(w, 'FP-CR-1');
    const draft = done(await call(owner, { action: 'reply', inReplyTo, ...rest }));
    expect(draft.document).toMatchObject({
      state: 'draft',
      to: [w.project.plugin],
      authoredBy: ownerAsAssistant,
    });
    const sent = done(await call(owner, { action: 'submit', ref: draft.id }));
    expect(sent.document).toMatchObject({
      number: 'FP-DEC-1',
      state: 'published',
      authoredBy: ownerAsAssistant,
    });
    expect(sent.events.map((e: Doc) => e.by)).toEqual([
      ownerAsAssistant,
      ownerAsAssistant,
      ownerAsAssistant,
    ]);
    const theirs = ok(
      await say('plugin', 'GET', `/api/projects/${w.project.plugin}/channel/documents/FP-DEC-1`),
    );
    expect(theirs.document.authoredBy).toEqual(ownerAsAssistant);
  });

  it('releases, supersedes and withdraws through chat, each event under the person', async () => {
    done(await call(owner, { action: 'release', thread: 'FP-CR-1' }));
    const { inReplyTo, ecosystem: _e, to: _t, ...rest } = decision(w, 'FP-CR-1');
    const second = done(
      await call(owner, {
        action: 'reply',
        inReplyTo,
        ...rest,
        subject: 'FP-CR-1 accepted, revised',
      }),
    );
    expect(done(await call(owner, { action: 'submit', ref: second.id })).document.number).toBe(
      'FP-DEC-2',
    );
    const replaced = done(
      await call(owner, {
        action: 'supersede',
        ref: 'FP-DEC-1',
        by: 'FP-DEC-2',
        reason: 'revised',
      }),
    );
    expect(replaced.document.state).toBe('superseded');
    expect(replaced.events.at(-1)).toMatchObject({ verb: 'supersede', by: ownerAsAssistant });
    const gone = done(
      await call(owner, { action: 'withdraw', ref: 'FP-DEC-2', reason: 'wrong date' }),
    );
    expect(gone.document.state).toBe('withdrawn');
    const rows = await w.harness.db.execute(sql`
      SELECT DISTINCT e.user_id, e.actor_via FROM channel_document_events e
      JOIN channel_documents d ON d.id = e.document_id WHERE d.number IN ('FP-DEC-1', 'FP-DEC-2')`);
    expect([...rows]).toEqual([{ user_id: w.user.platform, actor_via: 'assistant' }]);
  });

  it('refuses a call missing what its action needs, by name', async () => {
    expect(refusedAs(await call(owner, { action: 'hold', thread: 'FP-CR-1' }))).toEqual([
      'CHANNEL_ARGUMENT_INVALID /reason',
    ]);
    expect(refusedAs(await call(owner, { action: 'read', ref: 'FP-CR-1', reason: 'x' }))).toEqual([
      'CHANNEL_ARGUMENT_INVALID /reason',
    ]);
  });
});

describe('the assistant can do no more than the person', () => {
  it('refuses a viewer who asks it to write, and to hold', async () => {
    const viewer = await chatAs(w.user.viewer, w.project.plugin);
    expect(done(await call(viewer, { action: 'outbox' })).documents.length).toBeGreaterThan(0);
    const { ecosystem: _e, ...ack } = decision(w, 'FP-CR-1');
    expect(
      refusedAs(await call(viewer, { action: 'draft', ...ack, type: 'acknowledgement' })),
    ).toEqual(['CHANNEL_WRITE_NOT_AUTHORISED /from']);
    expect(
      refusedAs(await call(viewer, { action: 'hold', thread: 'FP-CR-1', reason: 'stop' })),
    ).toEqual(['HOLD_NOT_AUTHORISED /by']);
  });

  it('refuses a person with no role, at the turn and at the call', async () => {
    const { resolveTurnAuthority } = await import('../../src/auth/turn-credential.js');
    const none = await resolveTurnAuthority({
      userId: w.user.store,
      projectId: w.project.forge,
      viaTokenId: null,
    });
    expect(none.ok ? null : none.refusal.code).toBe('TURN_NO_ROLE');
    const member = await chatAs(w.forgeMember, w.project.forge);
    await w.harness.db.execute(
      sql`DELETE FROM project_members WHERE user_id = ${w.forgeMember} AND project_id = ${w.project.forge}`,
    );
    expect(refusedAs(await call(member, { action: 'register' }))).toEqual([
      'CHANNEL_NO_ROLE /from',
    ]);
  });

  it('records the person every tool call ran as', async () => {
    const { runTurnEvents } = await import('../../src/assistant/run-turn-core.js');
    let round = 0;
    const provider = {
      id: 'fake',
      defaultModel: 'fake',
      async *stream() {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool_call' as const,
            id: 'c1',
            name: 'forge_channel',
            arguments: '{"action":"outbox"}',
          };
        } else {
          yield { type: 'chunk' as const, text: 'done' };
        }
        yield { type: 'done' as const };
      },
    };
    const gen = runTurnEvents({ provider, model: 'fake', messages: [], tools: owner });
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    expect(next.value.toolCalls.map((c) => [c.name, c.ranAs, c.isError])).toEqual([
      ['forge_channel', w.user.platform, false],
    ]);
  });

  it('records the code a real refusal carried on its audited call', async () => {
    const { runTurnEvents } = await import('../../src/assistant/run-turn-core.js');
    const viewer = await chatAs(w.user.viewer, w.project.plugin);
    let round = 0;
    const provider = {
      id: 'fake',
      defaultModel: 'fake',
      async *stream() {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool_call' as const,
            id: 'c1',
            name: 'forge_channel',
            arguments: JSON.stringify({ action: 'withdraw', ref: 'FP-CR-1', reason: 'x' }),
          };
        } else {
          yield { type: 'chunk' as const, text: 'done' };
        }
        yield { type: 'done' as const };
      },
    };
    const gen = runTurnEvents({ provider, model: 'fake', messages: [], tools: viewer });
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    expect(next.value.toolCalls.map((c) => [c.isError, c.refusalCode, c.ranAs])).toEqual([
      [true, 'CHANNEL_WRITE_NOT_AUTHORISED', w.user.viewer],
    ]);
  });
});

describe('in ecosystem scope nothing internal of a counterparty is read', () => {
  let draftId = '';

  beforeAll(async () => {
    await createTestProjectMember(w.harness.db, {
      userId: w.user.platform,
      projectId: w.project.plugin,
      role: 'member',
    });
    const { ecosystem: _e, ...cr } = changeRequest(w);
    draftId = ok(
      await say('masterPlugin', 'POST', `/api/projects/${w.project.plugin}/channel/drafts`, {
        ecosystem: w.eco,
        ...cr,
        subject: 'An unsent plugin draft',
      }),
    ).id;
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
    ok(await say('store', 'POST', `${base}/documents/${asked.id}/submit`));
  });

  it('lists in the register only what this side is a party to, though the person belongs to the counterparty', async () => {
    const all = ok(await say('platform', 'GET', `/api/ecosystems/${w.eco}/register`));
    const between = all.documents.find((d: Doc) => d.from === w.project.store);
    expect(between?.to).toEqual([w.project.plugin]);
    const fenced = done(await call(owner, { action: 'register' }));
    expect(fenced.documents.length).toBeGreaterThan(0);
    expect(
      fenced.documents.filter(
        (d: Doc) => d.from !== w.project.forge && !d.to.includes(w.project.forge),
      ),
    ).toEqual([]);
  });

  it('reads a counterparty draft only by the REST door the person holds, never through a forge chat', async () => {
    expect(
      (
        await say(
          'platform',
          'GET',
          `/api/projects/${w.project.plugin}/channel/documents/${draftId}`,
        )
      ).status,
    ).toBe(200);
    expect(refusedAs(await call(owner, { action: 'read', ref: draftId }))).toEqual([
      'CHANNEL_NOT_A_PARTY /ref',
    ]);
  });

  it('reads the counterparty API page as a party, not as its member', async () => {
    const page = done(await call(owner, { action: 'contracts', project: w.project.plugin }));
    expect(page.reader.access).toBe('party');
    const own = done(await call(owner, { action: 'contracts' }));
    expect(own.reader.access).toBe('project');
  });

  it('refuses a project the forge side has no edge with', async () => {
    expect(refusedAs(await call(owner, { action: 'contracts', project: w.project.store }))).toEqual(
      ['CHANNEL_NOT_A_PARTY /project'],
    );
  });
});

describe('the owner decides an approve gate with chat alone', () => {
  const base = () => `/api/projects/${w.project.forge}/channel`;
  const setGate = async (mode: 'approve' | 'publish') => {
    const now = ok(await say('platform', 'GET', `/api/ecosystems/${w.eco}`));
    now.document.gate.rfi = mode;
    ok(
      await say('platform', 'PUT', `/api/ecosystems/${w.eco}`, {
        baseRevision: now.revision,
        document: now.document,
      }),
    );
  };
  let waiting = '';
  let number = '';

  beforeAll(async () => {
    await setGate('approve');
    const id = ok(await say('masterForge', 'POST', `${base()}/drafts`, rfi(w))).id;
    const res = ok(await say('masterForge', 'POST', `${base()}/documents/${id}/submit`));
    expect(res.document.state).toBe('submitted');
    waiting = id;
    number = res.document.number;
  });

  afterAll(async () => {
    await setGate('publish');
  });

  it("refuses a viewer deciding it, by the gate question's own authority", async () => {
    await createTestProjectMember(w.harness.db, {
      userId: w.user.viewer,
      projectId: w.project.forge,
      role: 'viewer',
    });
    const viewer = await chatAs(w.user.viewer, w.project.forge);
    expect(
      refusedAs(await call(viewer, { action: 'gate', ref: number, decision: 'approve' })),
    ).toEqual(['QUESTION_AUTHORITY_REQUIRED /decision']);
    const inbox = ok(
      await say('masterPlugin', 'GET', `/api/projects/${w.project.plugin}/channel/inbox`),
    );
    expect(inbox.documents.some((d: Doc) => d.document.number === number)).toBe(false);
  });

  it('refuses a return without a note, and a document not waiting at the gate', async () => {
    expect(
      refusedAs(await call(owner, { action: 'gate', ref: waiting, decision: 'return' })),
    ).toEqual(['GATE_RETURN_WITHOUT_NOTE /gate/note']);
    expect(
      refusedAs(await call(owner, { action: 'gate', ref: 'FP-CR-1', decision: 'approve' })),
    ).toEqual(['GATE_NOT_PENDING /ref']);
  });

  it('approves it as the person, via assistant, and it reaches the other side', async () => {
    const res = done(
      await call(owner, {
        action: 'gate',
        ref: waiting,
        decision: 'approve',
        note: 'fine to send',
      }),
    );
    expect(res.document).toMatchObject({
      state: 'published',
      gate: {
        mode: 'approve',
        decision: 'approved',
        decidedBy: w.user.platform,
        note: 'fine to send',
      },
    });
    expect(res.events.slice(-2).map((e: Doc) => [e.verb, e.by])).toEqual([
      ['approve', ownerAsAssistant],
      ['publish', ownerAsAssistant],
    ]);
    const inbox = ok(
      await say('masterPlugin', 'GET', `/api/projects/${w.project.plugin}/channel/inbox`),
    );
    expect(inbox.documents.some((d: Doc) => d.document.number === number)).toBe(true);
    expect(
      refusedAs(await call(owner, { action: 'gate', ref: waiting, decision: 'approve' })),
    ).toEqual(['GATE_NOT_PENDING /ref']);
  });
});
