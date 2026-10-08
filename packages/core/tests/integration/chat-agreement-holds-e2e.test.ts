/**
 * REQ-30 BC-4, ISS-439 round 2: the writes the independent judge found a chat still made with no
 * card at e03f141 — an Agent-mode draft's design and a requirement's design link (probes G, H), an
 * issue change from an Agent session or the assistant's own turn token (probes C, D), `forge issue`
 * and `forge project` from the Assistant, a project archive and a report save — each held now and,
 * where pressed, landing exactly as proposed. A refused press is told in a sentence (probe F).
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgreementWorld, openAgreementWorld } from '../helpers/chat-agreement-world.js';
import { closeWorld, type Doc, type Reply, requester } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';

const QUESTION = 'Record what I asked, please.';
let w: AgreementWorld;
let projectId = '';
let roomId = '';
let workflowId = '';
let turnToken = '';
let projectSlug = '';
let say: AgreementWorld['say'];
let app: AgreementWorld['app'];
const at = (path: string) => `/api/projects/${projectId}${path}`;
const codeOf = (r: Reply) => r.json?.error?.refusals?.[0]?.code ?? r.json?.code;
const text = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((b) => b.text ?? '').join('\n');
const proposals = async () =>
  ((await say('owner', 'GET', `/api/conversations/${roomId}/proposals`)).json.proposals ??
    []) as Doc[];
const count = async (table: 'requirements' | 'chat_proposals') =>
  Number(
    (
      await rows<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM ${sql.raw(table)} WHERE project_id = ${projectId}`,
      )
    )[0]?.n,
  );
const gateFor = async (_message: string) => w.gate();

beforeAll(async () => {
  w = await openAgreementWorld(QUESTION);
  ({ projectId, roomId, workflowId, turnToken, projectSlug, say, app } = w);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a design link, an issue change, a project change and a report save wait for the card', () => {
  const press = (id: string) =>
    say('owner', 'POST', `/api/conversations/${roomId}/proposals/${id}/agree`, {});
  const pendingOf = async (kind: string) =>
    (await proposals()).filter((p) => p.status === 'pending' && p.kind === kind);
  const thread = async () =>
    ((await say('owner', 'GET', `/api/conversations/${roomId}`)).json.messages as Doc[]).map((m) =>
      String(m.content),
    );
  let issueId = '';

  beforeAll(async () => {
    const issue = await say('owner', 'POST', at('/issues'), {
      title: 'Probe issue',
      status: 'draft',
      priority: 'low',
    });
    expect(issue.status, JSON.stringify(issue.json)).toBe(201);
    issueId = String(issue.json.id);
  });

  it('holds an Agent-mode draft carrying its design; the card shows it and the press links it (probe H)', async () => {
    const before = await count('requirements');
    const r = await say('agent', 'POST', at('/requirements'), {
      title: 'The dock shows a saved mark',
      reason: 'People cannot tell a draft was kept.',
      criteria: [{ body: 'A kept draft shows a saved mark.' }],
      designs: ['chat-turn'],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(codeOf(r)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(await count('requirements')).toBe(before);
    const [card] = await pendingOf('requirement_draft');
    expect(card?.summary).toMatchObject({
      title: 'New requirement: The dock shows a saved mark',
      relates: ['design chat-turn'],
    });
    const done = await press(String(card?.id));
    expect(done.json.proposal?.status, JSON.stringify(done.json)).toBe('recorded');
    const req = (await say('owner', 'GET', at(`/requirements/${done.json.proposal.record.ref}`)))
      .json;
    expect((req.workflows as Doc[]).map((wf) => wf.id ?? wf.workflowId)).toContain(workflowId);
  });

  it("holds an Agent session's design link on a requirement, and the press makes it (probe G)", async () => {
    const other = (
      await say('owner', 'POST', at('/requirements'), {
        title: 'A second wish',
        reason: 'r',
        criteria: [{ body: 'It holds.' }],
      })
    ).json.key as string;
    const r = await say('agent', 'POST', at(`/requirements/${other}/workflows`), { workflowId });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(codeOf(r)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    const linked = async () =>
      ((await say('owner', 'GET', at(`/requirements/${other}`))).json.workflows as Doc[]).map(
        (wf) => wf.id ?? wf.workflowId,
      );
    expect(await linked()).not.toContain(workflowId);
    const [card] = await pendingOf('requirement_link');
    expect(card?.summary).toMatchObject({
      title: `Link ${other} to design ${workflowId}`,
      relates: [other, `design ${workflowId}`],
    });
    expect((await press(String(card?.id))).json.proposal?.status).toBe('recorded');
    expect(await linked()).toContain(workflowId);
  });

  it("holds an Agent session's issue change with every field on its card (probe D), and the press makes it", async () => {
    const r = await say('agent', 'PATCH', `/api/issues/${issueId}`, {
      priority: 'high',
      title: 'Renamed by the Agent chat',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(codeOf(r)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    const read = async () => (await say('owner', 'GET', `/api/issues/${issueId}`)).json;
    expect(await read()).toMatchObject({ priority: 'low', title: 'Probe issue' });
    const [card] = await pendingOf('issue_change');
    expect(card?.summary.lines).toEqual(['priority: high', 'title: Renamed by the Agent chat']);
    expect((await press(String(card?.id))).json.proposal?.status).toBe('recorded');
    expect(await read()).toMatchObject({ priority: 'high', title: 'Renamed by the Agent chat' });
  });

  it("refuses the assistant's turn token an issue change outright (probe C), changing nothing", async () => {
    const r = await requester(app as never, { turn: turnToken })(
      'turn',
      'PATCH',
      `/api/issues/${issueId}`,
      { priority: 'low', title: 'Renamed by the turn token' },
    );
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(codeOf(r)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    expect((await say('owner', 'GET', `/api/issues/${issueId}`)).json).toMatchObject({
      priority: 'high',
      title: 'Renamed by the Agent chat',
    });
  });

  it('holds an Agent session edge on the issue', async () => {
    const other = await say('owner', 'POST', at('/issues'), { title: 'Blocker', status: 'draft' });
    const r = await say('agent', 'POST', `/api/issues/${issueId}/dependencies`, {
      dependsOnId: String(other.json.id),
      kind: 'blocks',
    });
    expect(codeOf(r), JSON.stringify(r.json)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    const edges = (await say('owner', 'GET', `/api/issues/${issueId}/dependencies`)).json;
    expect(JSON.stringify(edges)).not.toContain(String(other.json.id));
  });

  it("holds the Assistant's forge issue --set and forge project --set before the CLI runs", async () => {
    const gate = await gateFor('Raise it and rename the project.');
    const before = await count('chat_proposals');
    for (const argv of [
      ['issue', issueId, '--set', 'priority=urgent', '--why', 'asked in chat'],
      ['project', projectSlug, '--set', 'name=Renamed in chat'],
    ]) {
      const r = await gate.tools.execute('forge', JSON.stringify({ argv }));
      expect(text(r), argv.join(' ')).toContain('CHAT_WRITE_AWAITS_AGREEMENT');
    }
    expect(await count('chat_proposals')).toBe(before + 2);
    expect((await say('owner', 'GET', `/api/issues/${issueId}`)).json.priority).toBe('high');
  });

  it("holds an Agent session's project archive and report save", async () => {
    const archived = await say('agent', 'POST', `/api/projects/${projectId}/archive`);
    expect(codeOf(archived), JSON.stringify(archived.json)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    expect(
      (await say('owner', 'GET', `/api/projects/${projectId}`)).json.archivedAt ?? null,
    ).toBeNull();
    const saved = await say('agent', 'POST', at('/status/reports'), {});
    expect(codeOf(saved), JSON.stringify(saved.json)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    expect((await say('owner', 'GET', at('/status/reports'))).json.reports).toEqual([]);
    expect((await pendingOf('report_save')).length).toBe(1);
  });

  it('tells a refused press in a sentence naming what failed, never the JSON (probe F)', async () => {
    const doomed = await say('owner', 'POST', at('/issues'), {
      title: 'Soon gone',
      status: 'draft',
    });
    const doomedId = String(doomed.json.id);
    const r = await say('agent', 'PATCH', `/api/issues/${doomedId}`, { priority: 'high' });
    expect(codeOf(r)).toBe('CHAT_WRITE_AWAITS_AGREEMENT');
    const card = (await pendingOf('issue_change')).find((p) =>
      (p.summary.relates as string[]).includes(doomedId),
    );
    const gone = await say('owner', 'DELETE', `/api/issues/${doomedId}`);
    expect(gone.status, JSON.stringify(gone.json)).toBeLessThan(300);
    const done = await press(String(card?.id));
    expect(done.json.proposal?.status, JSON.stringify(done.json)).toBe('failed');
    const told = (await thread()).find((m) => m.startsWith(`Not recorded: Change ${doomedId}.`));
    expect(told).toMatch(/^Not recorded: Change \S+\. It was refused: .+\. Nothing was written\.$/);
    expect(told).not.toMatch(/[{}"]|urn:forge/);
  });
});
