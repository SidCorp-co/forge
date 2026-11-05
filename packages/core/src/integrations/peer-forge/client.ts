// A client for another Forge instance's REST API (ISS-923): forge-beta, read and written by the
// `beta_port` schedule. The peer may run an older release, so every answer is read for the few
// fields the port needs and a shape it cannot read is refused by name. Every call has a timeout,
// never follows a redirect, and answers a refusal with the peer's own code instead of throwing. The
// token is added here and scrubbed out of every detail that leaves.

import { scrubLogText } from '@forge/observability';
import { type PeerLanding, peerLandingOf, peerLandingOfProject } from './landing.js';

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
  /** Undefined where the list row carries no description (a projection): read it from the issue. */
  description: string | null | undefined;
  status: string;
  priority: string | null;
  category: string | null;
  /** When it was filed on the peer. */
  createdAt: Date;
  /** How many times it moved into `reopen`; null where the peer's row carries no count. */
  reopenCount: number | null;
  /** Whether the peer holds a merge mark on it; null where its row carries no merge fields. */
  marked: boolean | null;
}

const CALL_TIMEOUT_MS = 15_000;
const ISSUE_PAGE = 200;
const MAX_ISSUE_PAGES = 25;
const COMMENT_PAGE = 100;
const MAX_COMMENT_PAGES = 10;

const refuse = (
  code: string,
  status: number,
  detail: string,
): { ok: false; refusal: PeerRefusal } => ({
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
  return (
    str(body.detail) ?? str(body.message) ?? (isRecord(body.error) ? str(body.error.message) : null)
  );
}

async function call(
  peer: PeerForge,
  method: 'GET' | 'POST' | 'PATCH',
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
      return refuse(
        code,
        res.status,
        scrub(`${where} answered ${res.status}${said ? `: ${said}` : ''}`),
      );
    }
    return { ok: true, value: parsed };
  } catch (err) {
    if (controller.signal.aborted) {
      return refuse(
        'PEER_FORGE_TIMEOUT',
        0,
        `${where} did not answer within ${peer.timeoutMs ?? CALL_TIMEOUT_MS} ms`,
      );
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

const dateOf = (v: unknown): Date | null => {
  const text = str(v);
  if (!text) return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at;
};

function issueOf(row: unknown): PeerIssue | null {
  if (!isRecord(row)) return null;
  const id = str(row.id);
  const key = str(row.displayId) ?? str(row.key);
  const title = str(row.title);
  const status = str(row.status);
  const createdAt = dateOf(row.createdAt);
  if (!id || !key || title === null || !status || !createdAt) return null;
  return {
    id,
    key,
    title,
    description: 'description' in row ? str(row.description) : undefined,
    status,
    priority: str(row.priority),
    category: str(row.category),
    createdAt,
    reopenCount:
      typeof row.reopenCount === 'number' && Number.isInteger(row.reopenCount)
        ? row.reopenCount
        : null,
    marked: 'mergedAt' in row ? str(row.mergedAt) !== null : null,
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
      if (!issue) {
        return shape(`/api${route}`, 'issue row (id, displayId, title, status, createdAt)');
      }
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

/** One peer issue's description, read from the issue itself (a list row may not carry it). */
export async function readPeerIssueDescription(
  peer: PeerForge,
  issueId: string,
): Promise<PeerAnswer<string | null>> {
  const route = `/issues/${encodeURIComponent(issueId)}`;
  const got = await call(peer, 'GET', route);
  if (!got.ok) return got;
  if (!isRecord(got.value)) return shape(`/api${route}`, 'issue');
  return { ok: true, value: str(got.value.description) };
}

const ACTIVITY_PAGE = 100;
const MAX_ACTIVITY_PAGES = 5;

/**
 * When one peer issue last moved into `status` at or after `since`, read from its activity feed
 * (`issue.statusChanged` rows, newest first) until a row older than `since`; null where it did not.
 */
export async function peerMovedIntoSince(
  peer: PeerForge,
  issueId: string,
  status: string,
  since: Date,
): Promise<PeerAnswer<Date | null>> {
  const route = `/issues/${encodeURIComponent(issueId)}/activity`;
  let before: string | null = null;
  for (let page = 0; page < MAX_ACTIVITY_PAGES; page += 1) {
    const query = `?limit=${ACTIVITY_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const got = await call(peer, 'GET', `${route}${query}`);
    if (!got.ok) return got;
    const rows = rowsOf(got.value);
    if (!rows) return shape(`/api${route}`, 'activity list');
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const at = dateOf(row.createdAt);
      if (!at) return shape(`/api${route}`, 'activity row (createdAt)');
      if (at < since) return { ok: true, value: null };
      const payload = isRecord(row.payload) ? row.payload : null;
      if (row.action === 'issue.statusChanged' && payload?.to === status) {
        return { ok: true, value: at };
      }
    }
    before = isRecord(got.value) ? str(got.value.nextBefore) : null;
    if (!before) return { ok: true, value: null };
  }
  return refuse(
    'PEER_FORGE_TOO_MANY',
    200,
    `GET /api${route} holds more than ${MAX_ACTIVITY_PAGES * ACTIVITY_PAGE} rows since ${since.toISOString()}; this client reads no further`,
  );
}

/**
 * A peer merge mark, in the shape the peer project's landing takes: `commit` and `target` where its
 * work lands in git, `landing` where it lands outside git (`landing-evidence.ts:landingMarkRefusal`).
 */
export type PeerMergeMark =
  | { commit: string; target: string; mergedAt: string | null; note: string }
  | { landing: string; note: string };

/**
 * How a peer project's work lands, read from its project document; refused by name where unread. A
 * peer that answers 404 there serves no project document (forge-beta 0.3.0, ISS-986), so its landing
 * is read from its project row, by the rule that peer judges a mark with (`peerLandingOfProject`).
 */
export async function readPeerLanding(
  peer: PeerForge,
  projectId: string,
): Promise<PeerAnswer<PeerLanding>> {
  const project = `/projects/${encodeURIComponent(projectId)}`;
  const route = `${project}/config`;
  const got = await call(peer, 'GET', route);
  if (!got.ok && got.refusal.status !== 404) return got;
  if (!got.ok) {
    const row = await call(peer, 'GET', project);
    if (!row.ok) return row;
    const read = peerLandingOfProject(row.value);
    if (!read.ok) {
      return refuse(read.code, 200, `GET /api${project} (it serves no /config): ${read.detail}`);
    }
    return { ok: true, value: read.landing };
  }
  const read = peerLandingOf(got.value);
  if (!read.ok) return refuse(read.code, 200, `GET /api${route}: ${read.detail}`);
  return { ok: true, value: read.landing };
}

/** Record on a peer issue that its work landed, naming where: the peer's merge mark. */
export async function markPeerIssueLanded(
  peer: PeerForge,
  issueId: string,
  mark: PeerMergeMark,
): Promise<PeerAnswer<null>> {
  const body: Record<string, unknown> =
    'landing' in mark
      ? { landing: mark.landing, note: mark.note }
      : {
          commit: mark.commit,
          target: mark.target,
          ...(mark.mergedAt ? { mergedAt: mark.mergedAt } : {}),
          note: mark.note,
        };
  const got = await call(peer, 'POST', `/issues/${encodeURIComponent(issueId)}/merge`, body);
  return got.ok ? { ok: true, value: null } : got;
}

export async function postPeerComment(
  peer: PeerForge,
  issueId: string,
  body: string,
): Promise<PeerAnswer<null>> {
  const got = await call(peer, 'POST', `/issues/${encodeURIComponent(issueId)}/comments`, { body });
  return got.ok ? { ok: true, value: null } : got;
}

/**
 * A peer issue moved, and the status the peer stored: a peer may store another than the one asked
 * (a release gate holds an agent's close at `awaiting_release` and answers 200), so the answer's
 * `status` is read, never assumed; null where the peer's answer names none.
 */
export async function transitionPeerIssue(
  peer: PeerForge,
  issueId: string,
  toStatus: string,
  reason: string,
): Promise<PeerAnswer<{ stored: string | null }>> {
  const got = await call(peer, 'POST', `/issues/${encodeURIComponent(issueId)}/transition`, {
    toStatus,
    reason,
  });
  if (!got.ok) return got;
  return { ok: true, value: { stored: isRecord(got.value) ? str(got.value.status) : null } };
}

/**
 * Whether one peer issue holds a release note, read from the issue itself (a list row never carries
 * it); null where the peer's issue carries no `releaseNotes` field.
 */
export async function readPeerReleaseNoted(
  peer: PeerForge,
  issueId: string,
): Promise<PeerAnswer<boolean | null>> {
  const route = `/issues/${encodeURIComponent(issueId)}`;
  const got = await call(peer, 'GET', route);
  if (!got.ok) return got;
  if (!isRecord(got.value)) return shape(`/api${route}`, 'issue');
  if (!('releaseNotes' in got.value)) return { ok: true, value: null };
  return { ok: true, value: got.value.releaseNotes !== null };
}

/** A release note as a peer issue holds one: its section, the line a user reads, and the technical one. */
export interface PeerReleaseNote {
  section: string;
  userFacing: string;
  technical: string | null;
}

/** Write a peer issue's release note, which the peer's release record requires of every issue it closes. */
export async function writePeerReleaseNote(
  peer: PeerForge,
  issueId: string,
  note: PeerReleaseNote,
): Promise<PeerAnswer<null>> {
  const got = await call(peer, 'PATCH', `/issues/${encodeURIComponent(issueId)}`, {
    releaseNotes: {
      section: note.section,
      userFacing: note.userFacing,
      ...(note.technical ? { technical: note.technical } : {}),
    },
  });
  return got.ok ? { ok: true, value: null } : got;
}

/** A release already performed, as a peer project's release-record door takes it. */
export interface PeerReleaseRecord {
  issueIds: string[];
  /** The commit production serves, as the release that shipped it names it. */
  commit: string;
  /** How it was released: at least twenty characters, as the door requires. */
  account: string;
  /** The handle on the act: here the version the release shipped as. */
  providerRef: string;
}

/** What a peer's release record closed, and what it could not, by issue id. */
export interface PeerRecorded {
  runId: string | null;
  closed: string[];
  failed: { id: string; reason: string }[];
}

/**
 * Record on a peer project a release already performed (`POST /api/projects/:id/release-records`,
 * the door forge-beta serves for one): the peer closes each issue it carries from its release gate.
 * An answer naming no `closed` list is refused by name: whether anything closed is never guessed.
 */
export async function recordPeerRelease(
  peer: PeerForge,
  projectId: string,
  record: PeerReleaseRecord,
): Promise<PeerAnswer<PeerRecorded>> {
  const route = `/projects/${encodeURIComponent(projectId)}/release-records`;
  const got = await call(peer, 'POST', route, { ...record });
  if (!got.ok) return got;
  const body = isRecord(got.value) ? got.value : null;
  if (!body || !Array.isArray(body.closed)) {
    return refuse(
      'PEER_FORGE_SHAPE',
      200,
      `POST /api${route} answered no \`closed\` list this client can read`,
    );
  }
  const failed: { id: string; reason: string }[] = [];
  for (const row of Array.isArray(body.failed) ? body.failed : []) {
    const id = isRecord(row) ? str(row.id) : null;
    if (id)
      failed.push({ id, reason: (isRecord(row) ? str(row.reason) : null) ?? 'no reason given' });
  }
  return {
    ok: true,
    value: {
      runId: str(body.runId),
      closed: body.closed.filter((id): id is string => typeof id === 'string'),
      failed,
    },
  };
}
