import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, type Body } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { ago, issue, requirement, type World, world } from '../helpers/forecast-world.js';

// The HOP journey walk (2026-10-08): 371 of HOP's 470 decision records were a master's pass logs
// ("Decision (master, …): not dispatched this pass, because the wave is full"), so a BA reading
// the decisions feed or a requirement's Decisions tab could not find what a person decided. Both
// reads default to decisions a person made and say how many records agents kept are folded away;
// a record whose text dates itself after it was written is flagged with the time it states.

const HOUR = 3_600_000;

describe('decisions a person made, apart from what agents kept', () => {
  let w: World;
  let agentId = '';
  let req = { id: '', key: '' };
  let ahead = { id: '', stated: '' };
  let behind = '';
  let personOnIssue = '';
  let personOnReq = '';

  const decide = async (
    on: { issueId?: string; requirementId?: string },
    author: string,
    body: string,
    createdAt: Date,
    decision: object | null = null,
  ) => {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO comments (id, issue_id, requirement_id, author_id, body, intent, decision, created_at, updated_at)
      VALUES (${id}, ${on.issueId ?? null}, ${on.requirementId ?? null}, ${author}, ${body}, 'decision',
              ${decision ? JSON.stringify(decision) : null}::jsonb, ${createdAt.toISOString()}, ${createdAt.toISOString()})
    `);
    return id;
  };
  const read = async (path: string) => {
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}${path}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Body & { decisions: Body[] };
  };
  const ids = (b: { decisions: Body[] }) => b.decisions.map((d) => d.id).sort();

  beforeAll(async () => {
    w = await world();
    const agent = await createTestUser({ kind: 'agent' });
    agentId = agent.id;
    await addProjectMember(w.projectId, agent.id, 'member');
    req = await requirement(w, 'Referrals keep their consent');
    const work = await issue(w, { status: 'open', createdAt: ago(5), requirementId: req.id });

    personOnReq = await decide(
      { requirementId: req.id },
      w.userId,
      'Referrals keep their own consent purpose.',
      ago(3),
      { decision: 'Referrals keep their own consent purpose', reason: 'the clinic owner said so' },
    );
    personOnIssue = await decide(
      { issueId: work.id },
      w.userId,
      'We launch referrals on 2099-01-01, after the clinic signs.',
      ago(2),
      { decision: 'Launch referrals after the clinic signs', reason: 'contract first' },
    );
    const written = ago(1);
    const stated = new Date(written.getTime() + 20 * HOUR);
    const stamp = `${stated.toISOString().slice(0, 10)} ${stated.toISOString().slice(11, 16)}Z`;
    ahead = {
      id: await decide(
        { issueId: work.id },
        agentId,
        `**Decision (master, ${stamp}): not dispatched this pass, because the wave is full (width 2).**`,
        written,
      ),
      stated: `${stated.toISOString().slice(0, 16)}:00.000Z`,
    };
    const past = new Date(written.getTime() - 2 * HOUR);
    behind = await decide(
      { issueId: work.id },
      agentId,
      `**Decision (master, ${past.toISOString().slice(0, 10)} ${past.toISOString().slice(11, 16)}Z): folded.**`,
      written,
    );
  }, 120_000);

  it('lists only what a person decided in the feed, and counts what agents kept as folded', async () => {
    const feed = await read('/decisions');
    expect(ids(feed)).toEqual([personOnReq, personOnIssue].sort());
    expect(feed).toMatchObject({ by: 'people', folded: 2 });
  });

  it('lists what agents kept, or everything, when asked', async () => {
    expect(ids(await read('/decisions?by=agents'))).toEqual([ahead.id, behind].sort());
    const all = await read('/decisions?by=all');
    expect(ids(all)).toEqual([personOnReq, personOnIssue, ahead.id, behind].sort());
    expect(all).toMatchObject({ by: 'all', folded: 0 });
  });

  it("defaults a requirement's Decisions tab to what a person decided, its issues' included", async () => {
    const tab = await read(`/requirements/${req.key}/decisions`);
    expect(ids(tab)).toEqual([personOnReq, personOnIssue].sort());
    expect(tab).toMatchObject({ by: 'people', folded: 2 });
    expect(ids(await read(`/requirements/${req.key}/decisions?by=all`))).toHaveLength(4);
  });

  it('flags a record whose text dates itself after it was written, with the time it states', async () => {
    const all = (await read('/decisions?by=all')).decisions;
    const flag = (id: string) => all.find((d) => d.id === id)?.datedAhead;
    expect(flag(ahead.id)).toBe(ahead.stated);
    expect(flag(behind)).toBeNull();
    expect(flag(personOnIssue)).toBeNull();
  });

  it('refuses a maker it does not know, naming the valid ones', async () => {
    const res = await api(w.token, 'GET', `/api/projects/${w.projectId}/decisions?by=bots`);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(JSON.stringify(res.body)).toContain('people | agents | all');
  });
});
