/**
 * REQ-30 BC-4 (workflow chat-turn r2, steps restate 	 confirm 	 write 	 recorded): a chat writes
 * nothing until the person agrees. Before ISS-439 the agreement was an instruction to the model,
 * and forge_feedback, the requirement tools and an Agent session's REST POST wrote the moment they
 * were called. Here the real routes, the real toolset and the real database answer: a held write
 * leaves no row; only the person's press on the card writes exactly the held call, once, as them,
 * linked to what it named. A typed reply, yes or no, writes nothing (ISS-439 round 2: the judge's
 * probe A had a typed "No" bound as agreement, and core wrote it).
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgreementGate } from '../../src/assistant/agreement/turn-gate.js';
import { type AgreementWorld, openAgreementWorld } from '../helpers/chat-agreement-world.js';
import { closeWorld, type Doc, type Reply, requester } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';

let projectId = '';
let owner = '';
let roomId = '';
let workflowId = '';
let reqKey = '';
let say: AgreementWorld['say'];
let app: AgreementWorld['app'];
let tokens: Record<string, string>;
let turnToken = '';
// the person's message is the turn's, and nothing in the gate reads it: a typed reply agrees to nothing
let gateFor: (message: string) => Promise<AgreementGate>;
let agentTurn: AgreementWorld['agentTurn'];
const QUESTION = 'The dock loses my draft when I switch tabs. Record it, please.';
const at = (path: string) => `/api/projects/${projectId}${path}`;
const count = async (table: 'feedback' | 'requirements' | 'comments' | 'chat_proposals') =>
  Number(
    (
      await rows<{ n: number }>(
        table === 'comments'
          ? sql`SELECT count(*)::int AS n FROM comments c JOIN issues i ON i.id = c.issue_id WHERE i.project_id = ${projectId}`
          : sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE project_id = ${projectId}`,
      )
    )[0]?.n,
  );
const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((b) => b.text ?? '').join('\n');
const proposals = async (who: 'owner' | 'member' = 'owner') =>
  ((await say(who, 'GET', `/api/conversations/${roomId}/proposals`)).json.proposals ?? []) as Doc[];
const codeOf = (r: Reply) => r.json?.error?.refusals?.[0]?.code ?? r.json?.code;
const heldId = (said: string) => /proposal ([0-9a-f-]{36})/.exec(said)?.[1] ?? '';

beforeAll(async () => {
  const w = await openAgreementWorld(QUESTION);
  ({ projectId, owner, roomId, workflowId, reqKey, say, app, tokens, turnToken, agentTurn } = w);
  gateFor = async (_message) => w.gate();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('an Assistant write is held, and the card writes it as the person', () => {
  let held = '';

  it('refuses forge_feedback by name and writes no Feedback', async () => {
    const gate = await gateFor(QUESTION);
    const before = await count('feedback');
    const r = await gate.tools.execute(
      'forge_feedback',
      JSON.stringify({
        kind: 'bug',
        title: 'The dock loses a draft on a tab switch',
        requirement: reqKey,
      }),
    );
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('CHAT_WRITE_AWAITS_AGREEMENT: nothing was written');
    held = heldId(text(r));
    expect(await count('feedback')).toBe(before);
    expect(gate.heldThisTurn()).toBe(1);
  });

  it('shows the card to the room, with the decision only for the person it waits on', async () => {
    const mine = (await proposals('owner')).find((p) => p.id === held);
    expect(mine).toMatchObject({
      kind: 'feedback',
      status: 'pending',
      canDecide: true,
      summary: {
        title: 'Feedback (bug): The dock loses a draft on a tab switch',
        relates: [reqKey],
      },
      proposedTo: { userId: owner },
    });
    expect((await proposals('member')).find((p) => p.id === held)?.canDecide).toBe(false);
  });

  it('refuses a press by anyone else, and writes nothing', async () => {
    const r = await say(
      'member',
      'POST',
      `/api/conversations/${roomId}/proposals/${held}/agree`,
      {},
    );
    expect(r.status).toBe(403);
    expect(codeOf(r)).toBe('CHAT_PROPOSAL_NOT_YOURS');
    expect(await count('feedback')).toBe(0);
  });

  it("writes the held call on the person's press, linked to the requirement, and tells the thread", async () => {
    const r = await say(
      'owner',
      'POST',
      `/api/conversations/${roomId}/proposals/${held}/agree`,
      {},
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.proposal).toMatchObject({ status: 'recorded', agreedVia: 'card' });
    const ref = r.json.proposal.record.ref as string;
    expect(ref).toMatch(/^FB-\d+$/);
    const fb = (await say('owner', 'GET', at(`/feedback/${ref}`))).json.feedback;
    expect(fb.title).toBe('The dock loses a draft on a tab switch');
    expect(fb.target).toMatchObject({ type: 'requirement', key: reqKey });
    const thread = (await say('owner', 'GET', `/api/conversations/${roomId}`)).json
      .messages as Doc[];
    expect(thread.map((m) => m.content)).toContain(
      `Recorded as ${ref}: Feedback (bug): The dock loses a draft on a tab switch.`,
    );
  });

  it('refuses a second press by name and writes nothing more', async () => {
    const r = await say(
      'owner',
      'POST',
      `/api/conversations/${roomId}/proposals/${held}/agree`,
      {},
    );
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe('CHAT_PROPOSAL_SETTLED');
    expect(await count('feedback')).toBe(1);
  });

  it('declines a proposal, and a press after it writes nothing', async () => {
    const gate = await gateFor(QUESTION);
    const r = await gate.tools.execute(
      'forge_feedback',
      JSON.stringify({ kind: 'idea', title: 'Autosave the dock', requirement: reqKey }),
    );
    const id = heldId(text(r));
    const declined = await say(
      'owner',
      'POST',
      `/api/conversations/${roomId}/proposals/${id}/decline`,
    );
    expect(declined.json.proposal).toMatchObject({ status: 'declined', canDecide: false });
    const late = await say(
      'owner',
      'POST',
      `/api/conversations/${roomId}/proposals/${id}/agree`,
      {},
    );
    expect(codeOf(late)).toBe('CHAT_PROPOSAL_SETTLED');
    expect(await count('feedback')).toBe(1);
  });
});

describe('a typed reply agrees to nothing; only the press writes (REQ-30 BC-4)', () => {
  let held = '';
  const draft = {
    title: 'The dock autosaves a draft',
    reason: 'A tab switch loses what was typed.',
    criteria: [{ body: 'A draft typed in the dock is there after a tab switch.' }],
    designs: ['chat-turn'],
  };
  const press = (id: string) =>
    say('owner', 'POST', `/api/conversations/${roomId}/proposals/${id}/agree`, {});

  it('holds the draft requirement, which names its design', async () => {
    const before = await count('requirements');
    const r = await (await gateFor('Please draft it.')).tools.execute(
      'forge_requirement_draft',
      JSON.stringify(draft),
    );
    held = heldId(text(r));
    expect(held).not.toBe('');
    expect(await count('requirements')).toBe(before);
    expect((await proposals()).find((p) => p.id === held)?.summary.relates).toEqual([
      'design chat-turn',
    ]);
  });

  // the judge's probe A, and its mirror: neither a typed refusal nor a typed yes writes anything
  for (const typed of ["No. Do not record this, I don't want it.", 'Yes, draft it as you said.']) {
    it(`writes nothing on the typed reply "${typed}", in Assistant or Agent mode`, async () => {
      const before = await count('requirements');
      const gate = await gateFor(typed);
      expect(gate.tools.tools.map((t) => t.function.name)).not.toContain('forge_agree');
      const r = await gate.tools.execute(
        'forge_agree',
        JSON.stringify({ proposal: held, kind: 'requirement_draft', words: typed }),
      );
      expect(r.isError).toBe(true);

      await agentTurn(typed);
      const bound = await say(
        'agent',
        'POST',
        `/api/conversations/${roomId}/proposals/${held}/agree`,
        {
          words: typed,
          kind: 'requirement_draft',
        },
      );
      expect(bound.status).toBe(400);
      const bare = await say(
        'agent',
        'POST',
        `/api/conversations/${roomId}/proposals/${held}/agree`,
        {},
      );
      expect(bare.status).toBe(403);
      expect(codeOf(bare)).toBe('CHAT_AGREEMENT_DOOR');
      const asTurn = await requester(app as never, { turn: turnToken })(
        'turn',
        'POST',
        `/api/conversations/${roomId}/proposals/${held}/agree`,
        {},
      );
      // the assistant's turn token reaches no conversation route at all, so it is refused there first
      expect(asTurn.status).toBe(403);

      expect(await count('requirements')).toBe(before);
      expect((await proposals()).find((p) => p.id === held)?.status).toBe('pending');
    });
  }

  it("writes the draft on the person's press, linked to its design", async () => {
    const r = await press(held);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.proposal).toMatchObject({
      status: 'recorded',
      agreedVia: 'card',
      agreedWords: null,
    });
    const ref = r.json.proposal.record.ref as string;
    const req = (await say('owner', 'GET', at(`/requirements/${ref}`))).json;
    expect(req.title).toBe(draft.title);
    expect((req.workflows as Doc[]).map((wf) => wf.id ?? wf.workflowId)).toContain(workflowId);
  });
});

describe("an Agent-mode session's REST write is held the same way", () => {
  it('holds a Feedback POST, which the session cannot agree to, and the press writes it', async () => {
    const before = await count('feedback');
    const r = await say('agent', 'POST', at('/feedback'), {
      kind: 'bug',
      title: 'The dock drops pasted images',
      requirement: reqKey,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(codeOf(r)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(await count('feedback')).toBe(before);
    const id = heldId(JSON.stringify(r.json));
    await agentTurn('Yes, record both.');
    const bound = await say(
      'agent',
      'POST',
      `/api/conversations/${roomId}/proposals/${id}/agree`,
      {},
    );
    expect(codeOf(bound)).toBe('CHAT_AGREEMENT_DOOR');
    expect(await count('feedback')).toBe(before);
    const agreed = await say(
      'owner',
      'POST',
      `/api/conversations/${roomId}/proposals/${id}/agree`,
      {},
    );
    expect(agreed.status, JSON.stringify(agreed.json)).toBe(200);
    expect(agreed.json.proposal).toMatchObject({ status: 'recorded', agreedVia: 'card' });
    expect(await count('feedback')).toBe(before + 1);
    expect(JSON.parse(agreed.json.answered).feedback.target).toMatchObject({ key: reqKey });
  });

  it('holds a comment and an attachment, and the card writes them as the person', async () => {
    const issue = await say('owner', 'POST', at('/issues'), {
      title: 'Dock draft is lost',
      status: 'draft',
    });
    expect(issue.status, JSON.stringify(issue.json)).toBe(201);
    const issueId = String(issue.json.id);
    const comment = await say('agent', 'POST', `/api/issues/${issueId}/comments`, {
      body: 'Seen again on a tab switch.',
    });
    expect(codeOf(comment)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    const form = new FormData();
    form.set('file', new File(['the log'], 'dock.log', { type: 'text/plain' }));
    const attached = await app.request(`/api/issues/${issueId}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokens.agent}` },
      body: form,
    });
    expect(attached.status).toBe(409);
    const attachments = async () =>
      (await say('owner', 'GET', `/api/issues/${issueId}/attachments`)).json as unknown as Doc[];
    expect(await attachments()).toEqual([]);
    expect(await count('comments')).toBe(0);

    const waiting = (await proposals()).filter(
      (p) => p.status === 'pending' && p.kind !== 'feedback',
    );
    // each card names the issue by its key and title, never by the uuid the request carried
    const titles = waiting.map((p) => String(p.summary.title)).sort();
    expect(titles).toHaveLength(2);
    expect(titles[0]).toMatch(/^Attach to [A-Z]+-\d+ “.+”$/);
    expect(titles[1]).toMatch(/^Comment on [A-Z]+-\d+ “.+”$/);
    for (const title of titles) expect(title).not.toContain(issueId);
    for (const p of waiting) {
      const r = await say(
        'owner',
        'POST',
        `/api/conversations/${roomId}/proposals/${p.id}/agree`,
        {},
      );
      expect(r.json.proposal?.status, JSON.stringify(r.json)).toBe('recorded');
    }
    expect(await count('comments')).toBe(1);
    expect((await attachments()).map((a) => a.name)).toEqual(['dock.log']);
  });

  it('holds a memory note and a requirement revision, and the card writes them', async () => {
    const notes = async () =>
      Number(
        (
          await rows<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM memories WHERE project_id = ${projectId} AND source_ref = 'dock-draft'`,
          )
        )[0]?.n,
      );
    const note = await say('agent', 'POST', '/api/memory', {
      projectId,
      source: 'note',
      sourceRef: 'dock-draft',
      textContent: 'The dock keeps no draft across a tab switch.',
    });
    expect(codeOf(note), JSON.stringify(note.json)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(await notes()).toBe(0);
    // a revision opens on an accepted requirement: revision 1 is proposed and signed first
    for (const step of ['propose', 'accept']) {
      const r = await say('owner', 'POST', at(`/requirements/${reqKey}/revisions/1/${step}`), {});
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
    const revise = await say('agent', 'POST', at(`/requirements/${reqKey}/revisions`), {
      baseRevision: 1,
      reason: 'A draft also survives a reload.',
      criteria: [{ body: 'A draft survives a tab switch and a reload.' }],
    });
    expect(codeOf(revise), JSON.stringify(revise.json)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');

    const waiting = (await proposals()).filter(
      (p) => p.status === 'pending' && ['memory_note', 'requirement_revision'].includes(p.kind),
    );
    expect(waiting.map((p) => p.kind).sort()).toEqual(['memory_note', 'requirement_revision']);
    for (const p of waiting) {
      const r = await say(
        'owner',
        'POST',
        `/api/conversations/${roomId}/proposals/${p.id}/agree`,
        {},
      );
      expect(r.json.proposal?.status, JSON.stringify(r.json)).toBe('recorded');
    }
    expect(await notes()).toBe(1);
    const req = (await say('owner', 'GET', at(`/requirements/${reqKey}`))).json;
    expect((req.revisions as Doc[]).map((rev) => rev.reason)).toContain(
      'A draft also survives a reload.',
    );
  });

  it('refuses the assistant turn token a record route outright', async () => {
    const { CHAT_TURN_MENU, mintTurnCredential } = await import(
      '../../src/credentials/turn-credential.js'
    );
    const { resolveTurnAuthority } = await import('../../src/permissions/index.js');
    const resolved = await resolveTurnAuthority({ userId: owner, projectId, viaTokenId: null });
    if (!resolved.ok) throw new Error(resolved.refusal.message);
    const turn = await mintTurnCredential({
      authority: resolved.authority,
      menu: CHAT_TURN_MENU,
      ttlMs: 60_000,
    });
    const r = await requester(app as never, { turn: turn.token })('turn', 'POST', at('/feedback'), {
      kind: 'bug',
      title: 'From the CLI',
      requirement: reqKey,
    });
    expect(codeOf(r)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
  });
});
