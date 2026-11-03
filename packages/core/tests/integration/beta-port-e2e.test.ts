/**
 * ISS-923 (owner ruling 2026-11-03, `beta-issues-are-worked-on-dev`): a `beta_port` schedule's fire
 * ports each forge-beta issue not yet ported to the same-slug project here, open, with the beta key
 * and id on its first line and the dev key commented back on beta; it never ports one twice; it
 * mirrors a dev status move onto beta once, and comments a move beta refuses once; it names a beta
 * project with no twin and a missing secret, creating nothing for them; and the token never leaves.
 * forge-beta is a stub HTTP server this file starts and stops. Against real Postgres.
 *
 * @direct-test-of packages/core/src/beta-port/run.ts
 * @direct-test-of packages/core/src/beta-port/store.ts
 * @direct-test-of packages/core/src/schedules/beta-port-dispatch.ts
 * @direct-test-of packages/core/src/integrations/peer-forge/client.ts
 * @direct-test-of packages/core/src/project-config/secret-read.ts
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { createTestProject, createTestUser, rows } from '../helpers/factories.js';

const TOKEN = 'beta-token-0123456789abcdef-NEVER-LEAVES';

interface StubIssue {
  id: string;
  displayId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
}

/** forge-beta as far as the port reads and writes it, with every request it took. */
const beta = {
  projects: [] as { id: string; slug: string }[],
  issues: new Map<string, StubIssue[]>(),
  comments: new Map<string, string[]>(),
  /** The statuses a transition is refused into, by code. */
  refuseInto: new Map<string, string>(),
  transitions: [] as { issueId: string; toStatus: string; reason: string }[],
  unauthorised: 0,
};

let server: Server;
let baseUrl = '';
let say: (who: 'owner', method: string, path: string, body?: unknown) => Promise<Reply>;
let ownerId = '';
let scheduleProjectId = '';
let twin = { id: '', slug: '' };
let betaProjectId = '';
const logged: string[] = [];

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function startBeta(): Promise<void> {
  server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      beta.unauthorised += 1;
      return send(401, { code: 'UNAUTHORIZED', message: 'no' });
    }
    const url = new URL(req.url ?? '/', 'http://beta');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/api/projects') return send(200, beta.projects);
    if (req.method === 'GET' && parts[1] === 'projects' && parts[3] === 'issues') {
      const items = beta.issues.get(parts[2] as string) ?? [];
      return send(200, { items, returned: items.length, total: items.length, hasMore: false });
    }
    if (parts[1] === 'issues' && parts[3] === 'comments') {
      const id = parts[2] as string;
      if (req.method === 'GET') {
        const items = (beta.comments.get(id) ?? []).map((body, i) => ({ id: `c${i}`, body }));
        return send(200, { items, nextCursor: null, hasMore: false });
      }
      const body = await readBody(req);
      beta.comments.set(id, [...(beta.comments.get(id) ?? []), String(body.body)]);
      return send(201, { id: randomUUID() });
    }
    if (req.method === 'POST' && parts[1] === 'issues' && parts[3] === 'transition') {
      const id = parts[2] as string;
      const body = await readBody(req);
      const toStatus = String(body.toStatus);
      beta.transitions.push({ issueId: id, toStatus, reason: String(body.reason) });
      const refusal = beta.refuseInto.get(toStatus);
      if (refusal) {
        return send(422, {
          code: refusal,
          message: 'refused, nothing written',
          error: { code: refusal, message: 'refused', refusals: [] },
        });
      }
      for (const list of beta.issues.values()) {
        const issue = list.find((i) => i.id === id);
        if (issue) issue.status = toStatus;
      }
      return send(200, { ok: true });
    }
    return send(404, { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    }),
  );
}

function betaIssue(seq: number, over: Partial<StubIssue> = {}): StubIssue {
  return {
    id: randomUUID(),
    displayId: `ISS-${seq}`,
    title: `Beta issue ${seq}`,
    description: `What beta issue ${seq} asks for.`,
    status: 'open',
    priority: 'high',
    category: 'bug',
    ...over,
  };
}

beforeAll(async () => {
  testEnv();
  await startBeta();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { logger } = await import('../../src/lib/logger.js');
  for (const level of ['info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    }) as never);
  }
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  ownerId = (await createTestUser({ verified: true })).id;
  scheduleProjectId = (await createTestProject(ownerId)).id;
  const t = await createTestProject(ownerId);
  twin = { id: t.id, slug: t.slug };
  say = requester(app, { owner: await signUserToken(ownerId) }) as typeof say;
  betaProjectId = randomUUID();
  beta.projects = [
    { id: betaProjectId, slug: twin.slug },
    { id: randomUUID(), slug: `no-twin-${randomUUID().slice(0, 8)}` },
  ];
}, 120_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeWorld();
});

async function betaPortSchedule(): Promise<string> {
  const created = ok(
    await say('owner', 'POST', '/api/schedules', {
      projectId: scheduleProjectId,
      name: 'Beta port',
      cron: '*/15 * * * *',
      kind: 'beta_port',
    }),
    201,
  );
  return created.id as string;
}

async function setSecret(name: string, value: string) {
  ok(
    await say('owner', 'PUT', `/api/projects/${scheduleProjectId}/secrets/integration/${name}`, {
      value,
    }),
  );
}

async function fire(scheduleId: string) {
  const run = await say('owner', 'POST', `/api/schedules/${scheduleId}/run`);
  const [settled] = await rows<{
    status: string;
    reason: string | null;
    refusal: string | null;
    output: string | null;
    error: string | null;
  }>(
    sql`SELECT status, reason, refusal, output, error FROM schedule_runs WHERE schedule_id = ${scheduleId} ORDER BY started_at DESC LIMIT 1`,
  );
  if (!settled) throw new Error('the run pressed recorded no fire');
  return { http: run.status, body: run.json, ...settled };
}

const devIssues = () =>
  rows<{
    id: string;
    iss_seq: number;
    status: string;
    description: string | null;
    title: string;
    priority: string;
    category: string | null;
    created_via: string;
    created_by_id: string;
    schedule_run_id: string | null;
  }>(
    sql`SELECT id, iss_seq, status, description, title, priority, category, created_via, created_by_id, schedule_run_id FROM issues WHERE project_id = ${twin.id} ORDER BY iss_seq`,
  );

let scheduleId = '';

describe('a beta port fire (ISS-923)', () => {
  it('(d) a missing secret is refused by name and nothing is created', async () => {
    scheduleId = await betaPortSchedule();
    beta.issues.set(betaProjectId, [betaIssue(1)]);
    const settled = await fire(scheduleId);
    expect(settled.http).toBe(422);
    expect(settled).toMatchObject({
      status: 'skipped',
      reason: 'gate-refused',
      refusal: 'BETA_PORT_SECRET_MISSING',
    });
    expect(settled.output).toContain('secret://integration/forge-beta-url');
    expect(await devIssues()).toHaveLength(0);
    expect(beta.comments.size).toBe(0);
  });

  it('(a) a new beta issue is ported open to the same-slug project, first line set, and beta is told the dev key', async () => {
    await setSecret('forge-beta-url', baseUrl);
    await setSecret('forge-beta-token', TOKEN);
    const settled = await fire(scheduleId);
    expect(settled.status, JSON.stringify(settled)).toBe('success');
    const [dev, ...more] = await devIssues();
    expect(more).toHaveLength(0);
    const source = (beta.issues.get(betaProjectId) as StubIssue[])[0] as StubIssue;
    expect(dev).toMatchObject({
      status: 'open',
      title: source.title,
      priority: 'high',
      category: 'bug',
      created_via: 'schedule',
      created_by_id: ownerId,
    });
    expect(dev?.schedule_run_id).not.toBeNull();
    const lines = (dev?.description ?? '').split('\n');
    expect(lines[0]).toBe(`Ported from forge-beta ISS-1 (${source.id}).`);
    expect(dev?.description).toContain('What beta issue 1 asks for.');
    const devKey = `ISS-${dev?.iss_seq}`;
    expect(beta.comments.get(source.id)).toEqual([`Ported to forge-dev: ${devKey}`]);
    expect(settled.output).toContain(`ISS-1 → ${devKey}`);
  });

  it('(d) a beta project with no dev twin is named in the report, and nothing is created for it', async () => {
    const settled = await fire(scheduleId);
    const lonely = beta.projects[1]?.slug as string;
    expect(settled.output).toContain('beta projects with no dev twin (1):');
    expect(settled.output).toContain(lonely);
    const elsewhere = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM issues WHERE description LIKE 'Ported from forge-beta%' AND project_id <> ${twin.id}`,
    );
    expect(elsewhere[0]?.n).toBe(0);
  });

  it('(b) a beta issue with the marker comment, or named on a dev issue, is never ported again', async () => {
    const marked = betaIssue(2);
    const named = betaIssue(3);
    beta.issues.get(betaProjectId)?.push(marked, named);
    // a hand port: beta carries the marker naming a key the twin does not hold
    beta.comments.set(marked.id, ['Ported to forge-dev: ISS-999 by hand']);
    // a port whose beta comment failed: the dev issue's first line names the beta id
    await say('owner', 'POST', `/api/projects/${twin.id}/issues`, {
      title: 'Hand ported',
      description: `Ported from forge-beta ISS-3 (${named.id}).\n\nby hand`,
      status: 'draft',
    });
    const before = (await devIssues()).length;
    const first = await fire(scheduleId);
    const second = await fire(scheduleId);
    expect(await devIssues()).toHaveLength(before);
    for (const settled of [first, second]) {
      expect(settled.output).toContain('ISS-2 (marked ported to ISS-999');
      expect(settled.output).not.toMatch(/ISS-[23] → /);
    }
    expect(first.output).toContain('ISS-3 (named on ');
    // the dev-named one is adopted as a pair, so the second fire does not read it again
    expect(beta.comments.get(named.id) ?? []).toEqual([]);
    const pairs = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM beta_port_pairs WHERE beta_issue_id IN (${named.id}, ${(beta.issues.get(betaProjectId) as StubIssue[])[0]?.id as string})`,
    );
    expect(pairs[0]?.n).toBe(2);
  });

  it('(c) a dev move is mirrored once, and a move beta refuses is commented once', async () => {
    const source = (beta.issues.get(betaProjectId) as StubIssue[])[0] as StubIssue;
    const [pair] = await rows<{ dev_issue_id: string }>(
      sql`SELECT dev_issue_id FROM beta_port_pairs WHERE beta_issue_id = ${source.id}`,
    );
    const devId = pair?.dev_issue_id as string;
    const [dev] = await rows<{ iss_seq: number }>(
      sql`SELECT iss_seq FROM issues WHERE id = ${devId}`,
    );
    const devKey = `ISS-${dev?.iss_seq}`;

    ok(
      await say('owner', 'POST', `/api/issues/${devId}/transition`, {
        toStatus: 'on_hold',
        reason: 'waiting on the owner',
      }),
    );
    beta.transitions.length = 0;
    const moved = await fire(scheduleId);
    expect(beta.transitions).toEqual([
      {
        issueId: source.id,
        toStatus: 'on_hold',
        reason: `Mirrored from forge-dev ${devKey}, which moved to on_hold.`,
      },
    ]);
    expect(source.status).toBe('on_hold');
    expect(moved.output).toContain(`${devKey}: open → on_hold`);
    await fire(scheduleId);
    expect(beta.transitions).toHaveLength(1);

    beta.refuseInto.set('dropped', 'BETA_REFUSES_THIS_EDGE');
    ok(
      await say('owner', 'POST', `/api/issues/${devId}/transition`, {
        toStatus: 'dropped',
        reason: 'not worth it',
      }),
    );
    const refused = await fire(scheduleId);
    expect(refused.output).toContain('BETA_REFUSES_THIS_EDGE');
    await fire(scheduleId);
    expect(beta.transitions.filter((t) => t.toStatus === 'dropped')).toHaveLength(1);
    const told = (beta.comments.get(source.id) ?? []).filter((b) => b.includes('refused'));
    expect(told).toEqual([
      `forge-dev ${devKey} moved to dropped; forge-beta refused the matching move: BETA_REFUSES_THIS_EDGE.`,
    ]);
  });

  it('(e) the token never appears in a report, a comment, an issue or a log', async () => {
    const outputs = await rows<{ text: string }>(
      sql`SELECT coalesce(output, '') || coalesce(error, '') || coalesce(refusal, '') AS text FROM schedule_runs WHERE schedule_id = ${scheduleId}`,
    );
    expect(outputs.length).toBeGreaterThan(3);
    const comments = [...beta.comments.values()].flat();
    const issues = (await devIssues()).map((i) => `${i.title}\n${i.description}`);
    for (const text of [...outputs.map((o) => o.text), ...comments, ...issues, ...logged]) {
      expect(text).not.toContain(TOKEN);
    }
    expect(beta.unauthorised).toBe(0);
  });
});
