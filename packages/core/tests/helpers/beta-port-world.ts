/**
 * forge-beta as the beta port reads and writes it (ISS-923), for `beta-port-e2e.test.ts`: a stub HTTP
 * server holding projects, their project documents, issues, comments, activity and merge marks,
 * answering a transition the way beta's issue machine does where a test asks it to (with the status
 * it stored, as beta's transition answers), refusing a mark whose shape is not the project's the way
 * beta's mark writer does (`landingMarkRefusal`), taking a release note and a release record the way
 * beta's record door does (ISS-1005: the issue at the release gate, marked and noted, every one or
 * none), and counting every request it took.
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
  /** Beta's merge mark on the row, as its list and issue reads carry it. */
  mergedAt?: string | null;
  mergedCommitSha?: string | null;
  mergedLanding?: string | null;
  /** Beta's release note on the row, as its issue read carries it. */
  releaseNotes?: Record<string, unknown> | null;
}

/** A release record beta was sent, and the code it refused it with, where it did. */
export interface StubRecord {
  projectId: string;
  body: Record<string, unknown>;
  refused: string | null;
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
  /**
   * Beta's release gate as an agent's close meets it (forge-beta 51939268, `resolveAgentCloseTarget`):
   * a close of an issue named here is stored as `awaiting_release` and answered 200, and a close asked
   * at the gate is `NO_OP`.
   */
  releaseGate: new Set<string>(),
  /** The code every release record is refused with, before any issue is read; null takes it. */
  refuseRecord: null as string | null,
  /** Every release record beta was sent, taken or refused. */
  records: [] as StubRecord[],
  /** Every release note written, by issue. */
  notes: new Map<string, Record<string, unknown>>(),
  /** Each project's document, as `GET /api/projects/:id/config` answers it; unset is undeclared. */
  configs: new Map<string, Record<string, unknown>>(),
  /** How many times each project's document was read. */
  configReads: new Map<string, number>(),
  /**
   * Projects as forge-beta 0.3.0 serves them (ISS-986): no `/config` route (404 ROUTE_ABSENT), the
   * project row at `GET /api/projects/:id`, and a mark judged by its `kind`.
   */
  legacy: new Map<string, { kind: string; baseBranch: string | null }>(),
  /** How many times each legacy project's row was read. */
  projectReads: new Map<string, number>(),
  /** Every mark beta took, by issue, as the body that was sent. */
  marks: new Map<string, Record<string, unknown>>(),
  /** Every mark beta refused, with its code. */
  refusedMarks: [] as { issueId: string; code: string; body: Record<string, unknown> }[],
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

/**
 * Beta's release-record door (`recordPerformedRelease` at forge-beta 51939268), as far as a port's
 * record meets it: the body's shape, then every issue named at the release gate unclaimed, merge-marked
 * and noted, refused by beta's codes; a record taken closes every issue it names.
 */
function recordRefusal(projectId: string, body: Record<string, unknown>): string | null {
  if (beta.refuseRecord) return beta.refuseRecord;
  const ids = Array.isArray(body.issueIds) ? (body.issueIds as string[]) : [];
  const account = typeof body.account === 'string' ? body.account.trim() : '';
  if (ids.length === 0 || typeof body.commit !== 'string' || account.length < 20) {
    return 'BAD_REQUEST';
  }
  const issues = ids.map((id) => (beta.issues.get(projectId) ?? []).find((i) => i.id === id));
  if (issues.some((i) => i === undefined)) return 'CLAIM_CONFLICT';
  const found = issues as StubIssue[];
  if (found.some((i) => !i.releaseNotes)) return 'RELEASE_RECORD_MISSING';
  if (found.some((i) => !i.mergedAt)) return 'RELEASE_WORK_UNMERGED';
  if (found.some((i) => i.status !== 'awaiting_release')) return 'CLAIM_CONFLICT';
  return null;
}

const projectOf = (issueId: string) => {
  for (const [projectId, list] of beta.issues) {
    if (list.some((i) => i.id === issueId)) return projectId;
  }
  return undefined;
};

/**
 * Beta's mark writer, as far as a port's mark meets it: the project's landing shape read from its
 * document, `landingMarkRefusal` over it, and a git mark naming no target refused as beta's
 * `markTargetRequired` does. A mark taken is stamped on the row; the first stamp wins.
 */
async function markRefusal(issueId: string, body: Record<string, unknown>): Promise<string | null> {
  const { landingMarkRefusal, landingShapeOf } = await import(
    '../../src/issues/landing-evidence.js'
  );
  const projectId = projectOf(issueId) ?? '';
  const row = beta.legacy.get(projectId);
  const document = beta.configs.get(projectId);
  const source = document?.source as { type?: string } | undefined;
  const type = row
    ? ({ standard: 'git', website: 'storefront' } as Record<string, string>)[row.kind]
    : source?.type;
  const shape = landingShapeOf(type ?? null);
  if (shape === null) return 'SOURCE_UNDECLARED';
  const landing = typeof body.landing === 'string' ? body.landing : null;
  const refusal = landingMarkRefusal({ shape, landing, observed: false });
  if (refusal) return refusal.code;
  if (shape === 'git' && !landing && typeof body.target !== 'string') return 'VALIDATION_FAILED';
  return null;
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
    if (req.method === 'GET' && parts[1] === 'projects' && beta.legacy.has(parts[2] as string)) {
      const id = parts[2] as string;
      if (parts.length === 3) {
        beta.projectReads.set(id, (beta.projectReads.get(id) ?? 0) + 1);
        return send(200, { id, ...beta.legacy.get(id) });
      }
      if (parts[3] === 'config') {
        return send(404, { code: 'ROUTE_ABSENT', message: `GET ${url.pathname}` });
      }
    }
    if (req.method === 'GET' && parts[1] === 'projects' && parts[3] === 'config') {
      const document = beta.configs.get(parts[2] as string);
      beta.configReads.set(parts[2] as string, (beta.configReads.get(parts[2] as string) ?? 0) + 1);
      return send(
        200,
        document
          ? { declared: true, revision: 1, document }
          : { declared: false, revision: null, document: null },
      );
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
      const id = parts[2] as string;
      const body = await readBody(req);
      const refusal = await markRefusal(id, body);
      if (refusal) {
        beta.refusedMarks.push({ issueId: id, code: refusal, body });
        return send(422, { code: refusal, message: 'refused, nothing was marked' });
      }
      beta.marks.set(id, body);
      const issue = findIssue(id);
      if (issue && !issue.mergedAt) {
        issue.mergedAt =
          typeof body.mergedAt === 'string' ? body.mergedAt : new Date().toISOString();
        issue.mergedCommitSha = typeof body.commit === 'string' ? body.commit : null;
        issue.mergedLanding = typeof body.landing === 'string' ? body.landing : null;
      }
      const mark = typeof body.landing === 'string' ? 'landed' : 'asserted';
      return send(200, { id, action: 'merged', mark });
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
      const issue = findIssue(id);
      const held =
        beta.releaseGate.has(id) && toStatus === 'closed' ? 'awaiting_release' : toStatus;
      const refusal =
        held === issue?.status && held !== toStatus ? 'NO_OP' : closeRefusal(id, held);
      if (refusal) {
        return send(refusal === 'NO_OP' ? 409 : 422, {
          code: refusal,
          message: 'refused, nothing written',
          error: { code: refusal, message: 'refused', refusals: [] },
        });
      }
      if (issue) issue.status = held;
      return send(200, { id, status: held, reopenCount: 0 });
    }
    if (req.method === 'PATCH' && parts[1] === 'issues' && parts.length === 3) {
      const id = parts[2] as string;
      const body = await readBody(req);
      const issue = findIssue(id);
      if (!issue) return send(404, { code: 'NOT_FOUND', message: 'no issue' });
      const note = body.releaseNotes as Record<string, unknown> | undefined;
      if (note) {
        beta.notes.set(id, note);
        issue.releaseNotes = note;
      }
      return send(200, issue);
    }
    if (req.method === 'POST' && parts[1] === 'projects' && parts[3] === 'release-records') {
      const projectId = parts[2] as string;
      const body = await readBody(req);
      const refused = recordRefusal(projectId, body);
      beta.records.push({ projectId, body, refused });
      if (refused) {
        return send(refused === 'BAD_REQUEST' ? 400 : 409, {
          code: refused,
          message: 'refused, nothing recorded',
          error: { code: refused, message: 'refused' },
        });
      }
      const ids = body.issueIds as string[];
      for (const id of ids) {
        const issue = findIssue(id);
        if (issue) issue.status = 'closed';
      }
      return send(201, { runId: randomUUID(), commit: body.commit, closed: ids, failed: [] });
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
    releaseNotes: null,
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

/** A beta project document whose work lands outside git: a mark there names its `landing`. */
export const outsideGitDocument = (): Record<string, unknown> => ({
  source: { type: 'none' },
  environments: {},
  promotions: [],
});

/** A beta project document whose work lands in git on `defaultBranch`, production deploying it. */
export const gitDocument = (defaultBranch: string): Record<string, unknown> => ({
  source: { type: 'git', git: { defaultBranch } },
  environments: {
    production: {
      tier: 'production',
      deploysFrom: defaultBranch,
      deployment: { binding: 'prod', trigger: 'on-land' },
    },
  },
  promotions: [],
});

/** A git project whose release promotes `from` into `to`, the branch production deploys from. */
export const promotedDocument = (from: string, to: string): Record<string, unknown> => ({
  source: { type: 'git', git: { defaultBranch: from } },
  environments: {
    production: {
      tier: 'production',
      deploysFrom: to,
      deployment: { binding: 'prod', trigger: 'on-request' },
    },
  },
  promotions: [{ from, to, via: 'merge' }],
});
