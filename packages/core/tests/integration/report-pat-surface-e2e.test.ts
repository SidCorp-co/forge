import { randomUUID } from 'node:crypto';
import { ReportRunSchema } from '@forge/contracts/report-queries';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { turnTokenNameFor } from '../../src/credentials/pat-format.js';
import { AGENT_TURN_MENU, mintTurnCredential } from '../../src/credentials/turn-credential.js';
import { resolveTurnAuthority } from '../../src/permissions/index.js';
import { api, type Body } from '../helpers/api.js';
import { addProjectMember, createTestUser } from '../helpers/factories.js';
import { type World, world } from '../helpers/forecast-world.js';

// A token reaches the report routes the way it reaches every other project read, checked by
// membership as the person it acts for: an Agent-mode chat turn's token runs a report and posts a
// block of it (REQ-32), and a personal token not granted the project permissions is refused by name.

const code = (res: { body: Body }) => (res.body.error as Body | undefined)?.code;

describe('report routes under a personal or agent token', () => {
  let w: World;
  let roomId: string;
  let turnToken: string;
  const runPath = () => `/api/projects/${w.projectId}/report-queries/progress-by-requirement/runs`;

  beforeAll(async () => {
    w = await world();
    const opened = await api(w.token, 'POST', '/api/conversations', {
      projectId: w.projectId,
      title: 'agent mode report',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    roomId = String(opened.body.id);
    const resolved = await resolveTurnAuthority({
      userId: w.userId,
      projectId: w.projectId,
      viaTokenId: null,
    });
    if (!resolved.ok) throw new Error(resolved.refusal.message);
    turnToken = (
      await mintTurnCredential({
        authority: resolved.authority,
        menu: AGENT_TURN_MENU,
        name: turnTokenNameFor(randomUUID()),
        ttlMs: 10 * 60_000,
      })
    ).token;
  }, 120_000);

  it("runs progress-by-requirement on an Agent turn's token and posts a table block of the run", async () => {
    const ran = await api(turnToken, 'POST', runPath(), {});
    expect(ran.status, JSON.stringify(ran.body)).toBe(200);
    const run = ReportRunSchema.parse(ran.body);
    const read = await api(
      turnToken,
      'GET',
      `/api/projects/${w.projectId}/report-runs/${run.runId}`,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const posted = await api(turnToken, 'POST', `/api/conversations/${roomId}/blocks`, {
      projectId: w.projectId,
      block: { kind: 'table', columns: ['key'], source: { runId: run.runId } },
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
  });

  it('lists the registered queries to a member under a token, as the project read it is', async () => {
    const res = await api(turnToken, 'GET', `/api/projects/${w.projectId}/report-queries`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.queries as Body[]).map((q) => q.id)).toContain('progress-by-requirement');
  });

  it("checks a person's token as that person: a non-member is refused by name", async () => {
    const stranger = await createTestUser({ verified: true });
    const pat = await mintPat({
      permissions: ['projects:read', 'projects:write'],
      userId: stranger.id,
      name: 'stranger',
    });
    const res = await api(pat.plaintext, 'POST', runPath(), {});
    expect([res.status, code(res)]).toEqual([403, 'FORBIDDEN']);
  });

  it('runs for a member whose token is granted projects:write', async () => {
    const member = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, member.id, 'member');
    const pat = await mintPat({
      permissions: ['projects:write'],
      userId: member.id,
      name: 'member cli',
    });
    const res = await api(pat.plaintext, 'POST', runPath(), {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('refuses a token without the project permissions, by name, on every report route', async () => {
    const member = await createTestUser({ verified: true });
    await addProjectMember(w.projectId, member.id, 'member');
    const pat = await mintPat({
      permissions: ['issues:read'],
      userId: member.id,
      name: 'issues only',
    });
    const calls: ['GET' | 'POST', string, string][] = [
      ['POST', runPath(), 'projects:write'],
      ['GET', `/api/projects/${w.projectId}/report-queries`, 'projects:read'],
      ['GET', `/api/projects/${w.projectId}/report-runs/r1`, 'projects:read'],
    ];
    for (const [method, path, wanted] of calls) {
      const res = await api(pat.plaintext, method, path, method === 'POST' ? {} : undefined);
      expect([res.status, code(res)], path).toEqual([403, 'PAT_PERMISSION_REQUIRED']);
      expect(JSON.stringify(res.body), path).toContain(`'${wanted}'`);
    }
  });
});
