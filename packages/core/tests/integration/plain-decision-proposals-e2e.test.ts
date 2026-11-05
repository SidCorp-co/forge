// ISS-1006, owner 2026-11-05: a chat's held write is decided from one plain line its agent writes. An
// Assistant turn sends it as the held call's `plain` argument, which never reaches the write; an Agent
// session sends it to the proposal its request was held as. A card without one is held all the same,
// its `plain` null, which the card shows as "the agent wrote no summary" (owner ruling: teach, never
// block). Only the proposing session writes the line, and only while the card waits.
//
// @direct-test-of packages/core/src/assistant/agreement/turn-gate.ts
// @direct-test-of packages/core/src/assistant/agreement/plain-arg.ts
// @direct-test-of packages/core/src/assistant/agreement/plain-door.ts
// @direct-test-of packages/core/src/assistant/agreement/rest-hold.ts
// @direct-test-of packages/core/src/assistant/agreement/routes.ts

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgreementWorld, openAgreementWorld } from '../helpers/chat-agreement-world.js';
import { closeWorld, type Doc, type Reply } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';

const QUESTION = 'Record what I asked, please.';
const PLAIN = 'People see a saved mark on a kept draft. I recommend recording it.';
let w: AgreementWorld;
let projectId = '';
let roomId = '';
let say: AgreementWorld['say'];
const at = (path: string) => `/api/projects/${projectId}${path}`;
const codeOf = (r: Reply) => r.json?.error?.refusals?.[0]?.code ?? r.json?.code;
const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((b) => b.text ?? '').join('\n');
const heldId = (said: string) => /proposal ([0-9a-f-]{36})/.exec(said)?.[1] ?? '';
const cardOf = async (id: string) =>
  (
    ((await say('owner', 'GET', `/api/conversations/${roomId}/proposals`)).json.proposals ??
      []) as Doc[]
  ).find((p) => p.id === id);
const heldCall = async (id: string) =>
  (await rows<{ call: Doc }>(sql`SELECT call FROM chat_proposals WHERE id = ${id}`))[0]?.call;

beforeAll(async () => {
  w = await openAgreementWorld(QUESTION);
  ({ projectId, roomId, say } = w);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe("an Assistant turn's held call carries its plain line beside the write", () => {
  it('offers `plain` on every tool a held write is made through', () => {
    const offered = w.gate().tools.tools.filter((t) => t.function.name === 'project_feedback');
    expect(offered).toHaveLength(1);
    const properties = offered[0]?.function.parameters.properties as Record<string, unknown>;
    expect(properties.plain).toMatchObject({ type: 'string' });
  });

  it('stores the line on the card and leaves it out of the call the press makes', async () => {
    const r = await w.gate().tools.execute(
      'project_feedback',
      JSON.stringify({
        kind: 'bug',
        title: 'A kept draft shows no mark',
        target: { kind: 'requirement', ref: w.reqKey },
        plain: PLAIN,
      }),
    );
    expect(text(r)).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(text(r)).not.toContain('you wrote no `plain` line');
    const id = heldId(text(r));
    expect((await cardOf(id))?.summary.plain).toBe(PLAIN);
    const call = await heldCall(id);
    expect(JSON.parse(String(call?.arguments))).not.toHaveProperty('plain');
    // the card's technical lines are the write's own fields, never the plain line
    const card = await cardOf(id);
    expect((card?.summary.lines as string[]).join('\n')).not.toContain(PLAIN);
  });

  it('holds a call sent without `plain`, says so to the turn, and its card reads null', async () => {
    const r = await w.gate().tools.execute(
      'project_feedback',
      JSON.stringify({
        kind: 'bug',
        title: 'A second draft shows no mark',
        target: { kind: 'requirement', ref: w.reqKey },
      }),
    );
    expect(text(r)).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(text(r)).toContain('you wrote no `plain` line');
    expect((await cardOf(heldId(text(r))))?.summary.plain).toBeNull();
  });
});

describe("an Agent session writes its held request's plain line to the proposal", () => {
  let held = '';

  beforeAll(async () => {
    const r = await say('agent', 'POST', at('/requirements'), {
      title: 'The dock shows a saved mark',
      reason: 'People cannot tell a draft was kept.',
      criteria: [{ body: 'A kept draft shows a saved mark.' }],
    });
    expect(codeOf(r)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    const said = String(r.json?.error?.refusals?.[0]?.detail ?? JSON.stringify(r.json));
    held = heldId(said);
    expect(said).toContain(`conversations/${roomId}/proposals/${held}/plain -X POST`);
  });

  it('holds the card with no line until the session writes one', async () => {
    expect((await cardOf(held))?.summary.plain).toBeNull();
  });

  it('refuses the line from anyone but the proposing session', async () => {
    const r = await say('owner', 'POST', `/api/conversations/${roomId}/proposals/${held}/plain`, {
      plain: PLAIN,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(codeOf(r)).toBe('CHAT_PROPOSAL_NOT_YOURS');
    expect((await cardOf(held))?.summary.plain).toBeNull();
  });

  it("takes the session's own line, and the card reads it", async () => {
    const r = await say('agent', 'POST', `/api/conversations/${roomId}/proposals/${held}/plain`, {
      plain: PLAIN,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await cardOf(held))?.summary.plain).toBe(PLAIN);
  });

  it('refuses the line once the card is decided', async () => {
    const declined = await say(
      'owner',
      'POST',
      `/api/conversations/${roomId}/proposals/${held}/decline`,
      {},
    );
    expect(declined.status, JSON.stringify(declined.json)).toBe(200);
    const r = await say('agent', 'POST', `/api/conversations/${roomId}/proposals/${held}/plain`, {
      plain: 'too late',
    });
    expect(codeOf(r)).toBe('CHAT_PROPOSAL_SETTLED');
    expect((await cardOf(held))?.summary.plain).toBe(PLAIN);
  });
});
