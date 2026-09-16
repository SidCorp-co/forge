/**
 * ISS-1051 — the deployment as the runner sees it: one method per route the benchmark reads or
 * writes, over an injected `fetch` so a test can script the whole deployment. Every non-2xx is a
 * refusal naming the route, the status and the body's first line; nothing here returns a guess.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class DeploymentRefusal extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    readonly firstLine: string,
  ) {
    super(`${route} answered ${status}: ${firstLine}`);
    this.name = 'DeploymentRefusal';
  }
}

export interface Project {
  id: string;
  slug: string;
  name: string;
}

export interface IssueCounts {
  openCount: number;
  closedCount: number;
  draftCount: number;
}

export interface MemoryNote {
  id: string;
  sourceRef: string;
  text: string;
}

export interface IssueRef {
  id: string;
  key: string;
  title: string;
}

export interface RoomMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  silenceReason: string | null;
  createdAt: string;
}

export interface SendResult {
  seq: number;
  decision: string | null;
  messages: RoomMessage[];
}

export interface Preferences {
  answerStyle: string;
  assistantInstructions: string | null;
}

export interface PreferenceChange {
  id: string;
  field: string;
  previousValue: string | null;
  newValue: string | null;
  conversationId: string | null;
  changedAt: string;
}

export interface TrailQuery {
  projectSlug: string;
  dateFrom: string;
  dateTo: string;
  /** One door's rows only, as GET /api/chat-logs?source= filters them. */
  source?: string;
}

interface ListEnvelope<T> {
  items: T[];
  returned: number;
  total: number;
  offset: number;
}

export interface ClientOptions {
  api: string;
  fetch: FetchLike;
  /** Bound on one request; a send that runs past it is a refusal, never a hang. */
  timeoutMs?: number;
  /** The wait before the one retry of a GET or DELETE whose fetch threw (ISS-1065); default 5000. */
  retryDelayMs?: number;
}

/** A fetch that threw: no response reached the client. Names the request and the cause. */
export class FetchFailure extends Error {
  constructor(
    public readonly method: string,
    public readonly path: string,
    cause: unknown,
  ) {
    super(`fetch failed (cause: ${causeText(cause)}) on ${method} ${path}`);
    this.name = 'FetchFailure';
  }
}

const causeText = (err: unknown): string => {
  const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  return cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const firstLine = (text: string): string => text.split('\n')[0]?.slice(0, 200) ?? '';

/** The benchmark's view of one deployment, bound to one bearer after `signIn` or `useToken`. */
type JsonFn = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** ISS-1061 — what the capability fixtures read from the project, over every page the deployment serves. */
function projectReaders(json: JsonFn) {
  /** Every page of a `listResponse` envelope, by limit and offset, until the total is read. */
  async function listAll<T>(pathWithQuery: string): Promise<T[]> {
    const rows: T[] = [];
    const limit = 100;
    const join = pathWithQuery.includes('?') ? '&' : '?';
    for (let offset = 0; ; ) {
      const env = await json<ListEnvelope<T>>(
        'GET',
        `${pathWithQuery}${join}limit=${limit}&offset=${offset}`,
      );
      rows.push(...env.items);
      if (env.offset + env.returned >= env.total) return rows;
      if (env.returned === 0)
        throw new DeploymentRefusal(
          `GET ${pathWithQuery}`,
          200,
          `offset ${offset} returned nothing of ${env.total}`,
        );
      offset = env.offset + env.returned;
    }
  }

  return {
    /** Every issue of the project, every page, counted by status. */
    async issueCounts(projectId: string): Promise<IssueCounts> {
      const counts = { openCount: 0, closedCount: 0, draftCount: 0 };
      for (const row of await listAll<{ status: string }>(`/api/projects/${projectId}/issues`)) {
        if (row.status === 'open') counts.openCount += 1;
        else if (row.status === 'closed') counts.closedCount += 1;
        else if (row.status === 'draft') counts.draftCount += 1;
      }
      return counts;
    },
    /** The first issue waiting on information; refused by name where the project has none. */
    async waitingIssue(projectId: string): Promise<IssueRef> {
      const path = `/api/projects/${projectId}/issues?status=needs_info&limit=1`;
      const env = await json<ListEnvelope<{ id: string; displayId: string; title: string }>>(
        'GET',
        path,
      );
      const row = env.items[0];
      if (!row)
        throw new DeploymentRefusal(
          `GET ${path}`,
          200,
          'the project holds no issue waiting on information',
        );
      return { id: row.id, key: row.displayId, title: row.title };
    },
    /** The pipeline's state names in the order the project's config declares them. */
    async pipelineStates(projectId: string): Promise<string[]> {
      const path = `/api/projects/${projectId}/pipeline-config`;
      const res = await json<{ pipelineConfig?: { states?: Record<string, unknown> } }>(
        'GET',
        path,
      );
      const names = Object.keys(res.pipelineConfig?.states ?? {});
      if (names.length === 0)
        throw new DeploymentRefusal(`GET ${path}`, 200, 'the pipeline config names no state');
      return names;
    },
    /** Every memory note of the project, every page, archived included (codex F1 on ISS-1061). */
    async listNotes(projectId: string): Promise<MemoryNote[]> {
      const rows = await listAll<{ id: string; sourceRef: string; textContent: string }>(
        `/api/memory?projectId=${projectId}&source=note&includeArchived=true`,
      );
      return rows.map((r) => ({ id: r.id, sourceRef: r.sourceRef, text: r.textContent }));
    },
    async deleteNote(projectId: string, sourceRef: string): Promise<number> {
      const qs = new URLSearchParams({ projectId, source: 'note', sourceRef });
      const res = await json<{ deleted: number }>('DELETE', `/api/memory/by-source?${qs}`);
      return res.deleted;
    },
  };
}

export function createClient(opts: ClientOptions) {
  const api = opts.api.replace(/\/+$/, '');
  let token: string | null = null;

  let retries = 0;

  async function attempt(
    method: string,
    path: string,
    init: RequestInit,
  ): Promise<{ status: number; text: string }> {
    try {
      // cm:guard a fresh timeout signal per attempt: one made in `call` is already aborted by the time a timed-out first attempt is retried, and the retry would die at once without reaching the server (codex F1 on the ISS-1065 diff)
      const timed: RequestInit = opts.timeoutMs
        ? { ...init, signal: AbortSignal.timeout(opts.timeoutMs) }
        : init;
      const res = await opts.fetch(`${api}${path}`, timed);
      return { status: res.status, text: await res.text() };
    } catch (err) {
      throw new FetchFailure(method, path, err);
    }
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      return await attempt(method, path, init);
    } catch (first) {
      // cm:guard only a read is re-sent: a POST that threw may have reached the room before the connection dropped, and a second send would be answered twice and graded as one turn (ISS-1065 D1); a non-2xx never reaches here, it is a response
      if (!(first instanceof FetchFailure) || (method !== 'GET' && method !== 'DELETE'))
        throw first;
      retries += 1;
      await sleep(opts.retryDelayMs ?? 5000);
      try {
        return await attempt(method, path, init);
      } catch (second) {
        if (second instanceof FetchFailure) second.message += `; first attempt: ${first.message}`;
        throw second;
      }
    }
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, text } = await call(method, path, body);
    if (status < 200 || status >= 300)
      throw new DeploymentRefusal(`${method} ${path}`, status, firstLine(text));
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    /** How many retries `call` has spent so far; a trial reads it before and after. */
    retries: (): number => retries,
    useToken(value: string): void {
      token = value;
    },
    async signIn(email: string, password: string): Promise<void> {
      const res = await json<{ token: string }>('POST', '/api/auth/local', { email, password });
      token = res.token;
    },
    version: () => json<{ version: string; sourceCommit: string | null }>('GET', '/version'),
    async projectBySlug(slug: string): Promise<Project> {
      const rows = await json<Project[]>('GET', '/api/projects');
      const hits = rows.filter((r) => r.slug === slug);
      if (hits.length !== 1)
        throw new DeploymentRefusal(
          'GET /api/projects',
          200,
          `${hits.length} projects carry slug ${slug}`,
        );
      return { id: hits[0]?.id ?? '', slug, name: hits[0]?.name ?? '' };
    },
    async firstOpenIssue(projectId: string): Promise<IssueRef> {
      const path = `/api/projects/${projectId}/issues?status=open&limit=1`;
      const env = await json<ListEnvelope<{ id: string; displayId: string; title: string }>>(
        'GET',
        path,
      );
      const row = env.items[0];
      if (!row) throw new DeploymentRefusal(`GET ${path}`, 200, 'the project holds no open issue');
      return { id: row.id, key: row.displayId, title: row.title };
    },
    ...projectReaders(json),
    async issueExists(id: string): Promise<'resolves' | 'dead'> {
      const path = `/api/issues/${id}`;
      const { status, text } = await call('GET', path);
      if (status === 200) return 'resolves';
      if (status === 404) return 'dead';
      throw new DeploymentRefusal(`GET ${path}`, status, firstLine(text));
    },
    openRoom: (projectId: string, title: string) =>
      json<{ id: string }>('POST', '/api/conversations', { projectId, title }),
    send: (roomId: string, message: string) =>
      json<SendResult>('POST', `/api/conversations/${roomId}/messages`, { content: message }),
    async readRoom(
      roomId: string,
    ): Promise<{ status: 200; messages: RoomMessage[] } | { status: 404 }> {
      const path = `/api/conversations/${roomId}`;
      const { status, text } = await call('GET', path);
      if (status === 200)
        return { status, messages: (JSON.parse(text) as { messages: RoomMessage[] }).messages };
      if (status === 404) return { status };
      throw new DeploymentRefusal(`GET ${path}`, status, firstLine(text));
    },
    /**
     * Whether the room is gone: 404 is gone, 200 and 403 (someone else's room, still there) are not.
     * A bench room is deleted with a read-back at the end of every trial, so a gone room is the one
     * lifecycle mark it leaves (ISS-1065 D2).
     */
    async roomGone(roomId: string): Promise<boolean> {
      const path = `/api/conversations/${roomId}`;
      const { status, text } = await call('GET', path);
      if (status === 404) return true;
      if (status === 200 || status === 403) return false;
      throw new DeploymentRefusal(`GET ${path}`, status, firstLine(text));
    },
    async deleteRoom(roomId: string): Promise<void> {
      const path = `/api/conversations/${roomId}`;
      const { status, text } = await call('DELETE', path);
      if (status !== 204) throw new DeploymentRefusal(`DELETE ${path}`, status, firstLine(text));
    },
    async trail<T>(q: TrailQuery): Promise<T[]> {
      const rows: T[] = [];
      const pageSize = 100;
      for (let page = 1; ; page += 1) {
        const qs = new URLSearchParams({
          projectSlug: q.projectSlug,
          dateFrom: q.dateFrom,
          dateTo: q.dateTo,
          page: String(page),
          pageSize: String(pageSize),
        });
        if (q.source) qs.set('source', q.source);
        const env = await json<ListEnvelope<T>>('GET', `/api/chat-logs?${qs}`);
        rows.push(...env.items);
        // cm:why the envelope's own offset, not page × the size asked for: the route caps pageSize, and a page smaller than asked would otherwise end the read early
        if (env.offset + env.returned >= env.total) return rows;
        if (env.returned === 0)
          throw new DeploymentRefusal(
            'GET /api/chat-logs',
            200,
            `page ${page} returned nothing of ${env.total}`,
          );
      }
    },
    readPreferences: () => json<Preferences>('GET', '/api/auth/preferences'),
    writePreferences: (patch: Partial<Preferences>) =>
      json<Preferences>('PATCH', '/api/auth/preferences', patch),
    async preferenceChanges(): Promise<PreferenceChange[]> {
      const res = await json<{ items: PreferenceChange[] }>('GET', '/api/auth/preferences/changes');
      return res.items;
    },
  };
}

export type BenchClient = ReturnType<typeof createClient>;
