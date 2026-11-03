// A client for another Forge instance's REST API (ISS-923): forge-beta, read and written by the
// `beta_port` schedule. The peer may run an older release, so every answer is read for the few
// fields the port needs and a shape it cannot read is refused by name. Every call has a timeout,
// never follows a redirect, and answers a refusal with the peer's own code instead of throwing. The
// token is added here and scrubbed out of every detail that leaves.

import { scrubLogText } from '@forge/observability';

/** Where the peer is, and the token it is read and written with. */
export interface PeerForge {
  baseUrl: string;
  token: string;
  /** How long one call waits before it is refused `PEER_FORGE_TIMEOUT`. */
  timeoutMs?: number;
}

/** A refusal: the peer's own code where it answered one, else one of this client's. */
export interface PeerRefusal {
  code: string;
  status: number;
  detail: string;
}

export type PeerAnswer<T> = { ok: true; value: T } | { ok: false; refusal: PeerRefusal };

export interface PeerProject {
  id: string;
  slug: string;
}

export interface PeerIssue {
  id: string;
  /** Its human key on the peer (`ISS-12`). */
  key: string;
  title: string;
  description: string | null;
  status: string;
  priority: string | null;
  category: string | null;
}

const CALL_TIMEOUT_MS = 15_000;
const ISSUE_PAGE = 200;
const MAX_ISSUE_PAGES = 25;
const COMMENT_PAGE = 100;
const MAX_COMMENT_PAGES = 10;

const refuse = (code: string, status: number, detail: string): { ok: false; refusal: PeerRefusal } => ({
  ok: false,
  refusal: { code, status, detail },
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The rows of a list answer: a bare array, or the `items` of a list envelope. */
function rowsOf(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (isRecord(body) && Array.isArray(body.items)) return body.items;
  return null;
}

/** The code a refusal body names: top-level `code`, else `error.code`. */
function codeOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const top = str(body.code);
  if (top) return top;
  return isRecord(body.error) ? str(body.error.code) : null;
}

function messageOf(body: unknown): string | null {
  if (!isRecord(body)) return null;
  return str(body.detail) ?? str(body.message) ?? (isRecord(body.error) ? str(body.error.message) : null);
}

async function call(
  peer: PeerForge,
  method: 'GET' | 'POST',
  route: string,
  body?: Record<string, unknown>,
): Promise<PeerAnswer<unknown>> {
  const secrets = [peer.token];
  const scrub = (text: string) => scrubLogText(text, secrets);
  let url: URL;
  try {
    url = new URL(`${peer.baseUrl.replace(/\/+$/, '')}/api${route}`);
  } catch {
    return refuse('PEER_FORGE_URL_INVALID', 0, 'the peer base URL is not a URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return refuse('PEER_FORGE_URL_INVALID', 0, `the peer base URL is ${url.protocol}, not http(s)`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), peer.timeoutMs ?? CALL_TIMEOUT_MS);
  const where = `${method} ${url.pathname}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${peer.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (res.status >= 300 && res.status < 400) {
      return refuse(
        'PEER_FORGE_REDIRECT',
        res.status,
        `${where} answered ${res.status}, and a redirect is never followed`,
      );
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const code = codeOf(parsed) ?? `PEER_FORGE_HTTP_${res.status}`;
      const said = messageOf(parsed);
      return refuse(code, res.status, scrub(`${where} answered ${res.status}${said ? `: ${said}` : ''}`));
    }
    return { ok: true, value: parsed };
  } catch (err) {
    if (controller.signal.aborted) {
      return refuse('PEER_FORGE_TIMEOUT', 0, `${where} did not answer within ${peer.timeoutMs ?? CALL_TIMEOUT_MS} ms`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    return refuse('PEER_FORGE_UNREACHABLE', 0, scrub(`${where} could not be sent: ${reason}`));
  } finally {
    clearTimeout(timer);
  }
}

const shape = (route: string, what: string) =>
  refuse('PEER_FORGE_SHAPE', 200, `GET ${route} answered no ${what} this client can read`);

/** Every project the token can read on the peer. */
export async function listPeerProjects(peer: PeerForge): Promise<PeerAnswer<PeerProject[]>> {
  const got = await call(peer, 'GET', '/projects');
  if (!got.ok) return got;
  const rows = rowsOf(got.value);
  if (!rows) return shape('/api/projects', 'project list');
  const projects: PeerProject[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    const slug = str(row.slug);
    if (id && slug) projects.push({ id, slug });
  }
  return { ok: true, value: projects };
}

function issueOf(row: unknown): PeerIssue | null {
  if (!isRecord(row)) return null;
  const id = str(row.id);
  const key = str(row.displayId) ?? str(row.key);
  const title = str(row.title);
  const status = str(row.status);
  if (!id || !key || title === null || !status) return null;
  return {
    id,
    key,
    title,
    description: str(row.description),
    status,
    priority: str(row.priority),
    category: str(row.category),
  };
}

/** Every issue of one peer project, page by page, up to a bound that is refused by name. */
export async function listPeerIssues(
  peer: PeerForge,
  projectId: string,
): Promise<PeerAnswer<PeerIssue[]>> {
  const route = `/projects/${encodeURIComponent(projectId)}/issues`;
  const issues: PeerIssue[] = [];
  for (let page = 0; page < MAX_ISSUE_PAGES; page += 1) {
    const got = await call(peer, 'GET', `${route}?limit=${ISSUE_PAGE}&offset=${page * ISSUE_PAGE}`);
    if (!got.ok) return got;
    const rows = rowsOf(got.value);
    if (!rows) return shape(`/api${route}`, 'issue list');
    for (const row of rows) {
      const issue = issueOf(row);
      if (!issue) return shape(`/api${route}`, 'issue row (id, displayId, title, status)');
      issues.push(issue);
    }
    const more = isRecord(got.value) && got.value.hasMore === true;
    if (!more || rows.length === 0) return { ok: true, value: issues };
  }
  return refuse(
    'PEER_FORGE_TOO_MANY',
    200,
    `GET /api${route} holds more than ${MAX_ISSUE_PAGES * ISSUE_PAGE} issues; this client reads no further`,
  );
}

function commentBodies(rows: unknown[], into: string[]): void {
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const body = str(row.body);
    if (body !== null) into.push(body);
    for (const nested of [row.replies, row.children]) {
      if (Array.isArray(nested)) commentBodies(nested, into);
    }
  }
}

/** The body of every comment on one peer issue, replies included. */
export async function listPeerCommentBodies(
  peer: PeerForge,
  issueId: string,
): Promise<PeerAnswer<string[]>> {
  const route = `/issues/${encodeURIComponent(issueId)}/comments`;
  const bodies: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    const query = `?limit=${COMMENT_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const got = await call(peer, 'GET', `${route}${query}`);
    if (!got.ok) return got;
    const rows = rowsOf(got.value);
    if (!rows) return shape(`/api${route}`, 'comment list');
    commentBodies(rows, bodies);
    cursor = isRecord(got.value) ? str(got.value.nextCursor) : null;
    if (!cursor) return { ok: true, value: bodies };
  }
  return refuse(
    'PEER_FORGE_TOO_MANY',
    200,
    `GET /api${route} holds more than ${MAX_COMMENT_PAGES * COMMENT_PAGE} comments; this client reads no further`,
  );
}

export async function postPeerComment(
  peer: PeerForge,
  issueId: string,
  body: string,
): Promise<PeerAnswer<null>> {
  const got = await call(peer, 'POST', `/issues/${encodeURIComponent(issueId)}/comments`, { body });
  return got.ok ? { ok: true, value: null } : got;
}

export async function transitionPeerIssue(
  peer: PeerForge,
  issueId: string,
  toStatus: string,
  reason: string,
): Promise<PeerAnswer<null>> {
  const got = await call(peer, 'POST', `/issues/${encodeURIComponent(issueId)}/transition`, {
    toStatus,
    reason,
  });
  return got.ok ? { ok: true, value: null } : got;
}
