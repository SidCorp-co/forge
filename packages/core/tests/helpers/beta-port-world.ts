/**
 * forge-beta as the beta port reads and writes it (ISS-923), for `beta-port-e2e.test.ts`: a stub HTTP
 * server holding projects, issues, comments, activity and merge marks, answering a transition the way
 * beta's issue machine does where a test asks it to, and counting every request it took.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { rows } from './factories.js';

export const TOKEN = 'beta-token-0123456789abcdef-NEVER-LEAVES';

export interface StubIssue {
  id: string;
  displayId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  category: string | null;
  createdAt: string;
  /** Left off a row to stand for a beta whose rows carry no count. */
  reopenCount?: number;
}

export interface StubActivity {
  action: string;
  payload: unknown;
  createdAt: string;
}

/** forge-beta as far as the port reads and writes it, with every request it took. */
export const beta = {
  projects: [] as { id: string; slug: string }[],
  issues: new Map<string, StubIssue[]>(),
  comments: new Map<string, string[]>(),
  activity: new Map<string, StubActivity[]>(),
  /** Issues whose list row carries no description (a projection), read from the issue instead. */
  bare: new Set<string>(),
  /** Issues whose own read (`GET /api/issues/:id`) is refused, by code. */
  refuseRead: new Map<string, string>(),
  /** The statuses a transition is refused into, by code. */
  refuseInto: new Map<string, string>(),
  /** A close is refused CLOSE_REQUIRES_SHIPPED until a merge mark is recorded, as beta's machine does. */
  closeNeedsMark: false,
  /** The code a close of an issue is refused with once its mark is recorded (beta's release rule). */
  closeAfterMark: new Map<string, string>(),
  marks: new Map<string, { landing: string; note: string }>(),
  transitions: [] as { issueId: string; toStatus: string; reason: string }[],
  /** How long the project list takes to answer: a slow beta. */
  delayMs: 0,
  requests: 0,
  unauthorised: 0,
};

const findIssue = (id: string) => {
  for (const list of beta.issues.values()) {
    const issue = list.find((i) => i.id === id);
    if (issue) return issue;
  }
  return undefined;
};

function closeRefusal(id: string, toStatus: string): string | null {
  const plain = beta.refuseInto.get(toStatus);
  if (plain) return plain;
  if (toStatus !== 'closed' || !beta.closeNeedsMark) return null;
  if (!beta.marks.has(id)) return 'CLOSE_REQUIRES_SHIPPED';
  return beta.closeAfterMark.get(id) ?? null;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

let server: Server | undefined;

/** Starts the stub on a free port; its base URL. */
export function startBeta(): Promise<string> {
  server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    beta.requests += 1;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      beta.unauthorised += 1;
      return send(401, { code: 'UNAUTHORIZED', message: 'no' });
    }
    const url = new URL(req.url ?? '/', 'http://beta');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      if (beta.delayMs > 0) await new Promise((r) => setTimeout(r, beta.delayMs));
      return send(200, beta.projects);
    }
    if (req.method === 'GET' && parts[1] === 'projects' && parts[3] === 'issues') {
      const items = (beta.issues.get(parts[2] as string) ?? []).map((i) => {
        if (!beta.bare.has(i.id)) return i;
        const { description: _left, ...row } = i;
        return row;
      });
      return send(200, { items, returned: items.length, total: items.length, hasMore: false });
    }
    if (req.method === 'GET' && parts[1] === 'issues' && parts.length === 3) {
      const refusal = beta.refuseRead.get(parts[2] as string);
      if (refusal) return send(503, { code: refusal, message: 'beta cannot read it now' });
      const issue = findIssue(parts[2] as string);
      return issue ? send(200, issue) : send(404, { code: 'NOT_FOUND', message: 'no issue' });
    }
    if (req.method === 'GET' && parts[1] === 'issues' && parts[3] === 'activity') {
      const items = [...(beta.activity.get(parts[2] as string) ?? [])].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      );
      return send(200, { items, nextBefore: null });
    }
    if (req.method === 'POST' && parts[1] === 'issues' && parts[3] === 'merge') {
      const body = await readBody(req);
      beta.marks.set(parts[2] as string, {
        landing: String(body.landing),
        note: String(body.note),
      });
      return send(200, { id: parts[2], action: 'merged', mark: 'landing' });
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
      const refusal = closeRefusal(id, toStatus);
      if (refusal) {
        return send(422, {
          code: refusal,
          message: 'refused, nothing written',
          error: { code: refusal, message: 'refused', refusals: [] },
        });
      }
      const issue = findIssue(id);
      if (issue) issue.status = toStatus;
      return send(200, { ok: true });
    }
    return send(404, { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` });
  });
  const listening = server;
  return new Promise((resolve) =>
    listening.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(listening.address() as AddressInfo).port}`);
    }),
  );
}

export function stopBeta(): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}

/** The owner's ruling: an hour ago, so "now" is after it and a day ago before it. */
export const RULING_AT = new Date(Date.now() - 60 * 60 * 1000);
export const afterRuling = () => new Date().toISOString();
export const beforeRuling = () => new Date(RULING_AT.getTime() - 24 * 60 * 60 * 1000).toISOString();

export function betaIssue(seq: number, over: Partial<StubIssue> = {}): StubIssue {
  return {
    id: randomUUID(),
    displayId: `ISS-${seq}`,
    title: `Beta issue ${seq}`,
    description: `What beta issue ${seq} asks for.`,
    status: 'open',
    priority: 'high',
    category: 'bug',
    createdAt: afterRuling(),
    reopenCount: 0,
    ...over,
  };
}

export interface FireRow {
  id: string;
  status: string;
  reason: string | null;
  refusal: string | null;
  output: string | null;
  error: string | null;
}

export const fireRow = async (fireId: string) =>
  (
    await rows<FireRow>(
      sql`SELECT id, status, reason, refusal, output, error FROM schedule_runs WHERE id = ${fireId}`,
    )
  )[0];

/** A fire's row once it is no longer running: a fire run after its answer settles on its own. */
export async function settledFire(fireId: string): Promise<FireRow> {
  for (let i = 0; i < 300; i += 1) {
    const row = await fireRow(fireId);
    if (row && row.status !== 'running') return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`fire ${fireId} did not settle within 15 s`);
}

/** The owner's ruling, written into the org knowledge of `projectId`'s org at `at`. */
export async function writeRuling(projectId: string, at: Date) {
  const [org] = await rows<{ org_id: string }>(
    sql`SELECT org_id FROM projects WHERE id = ${projectId}`,
  );
  await rows(
    sql`INSERT INTO org_knowledge_entries (org_id, slug, title, body, injection, created_at, updated_at)
        VALUES (${org?.org_id as string}, 'beta-issues-are-worked-on-dev', 'Beta issues are worked on dev',
                'Issues filed on forge-beta are worked on forge-dev from now on.', 'always', ${at.toISOString()}::timestamptz, now())`,
  );
}
