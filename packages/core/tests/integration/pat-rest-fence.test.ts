import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

/**
 * The PAT fence on the REST data plane, against the whole mounted app.
 *
 * Two halves, and they defend different things. The sweep walks every route
 * Hono has registered and proves a scoped PAT reaches nothing outside
 * `PAT_ALLOWED_PREFIXES` — that is what makes the allowlist trustworthy
 * without reading 73 route modules, and it is what fails when someone mounts
 * a new router later. The fence cases prove that inside the allowlist a token
 * bound to project A cannot see project B, including where the project is
 * resolved indirectly from an issue id the caller supplies.
 *
 * Both halves now walk WRITE routes too, and the inside half substitutes every
 * path param rather than only routes that have exactly one.
 *
 * What a green run still does NOT prove, so it is not read as wider than it
 * is: a write probe sends an EMPTY body, so a route whose body validator runs
 * before its project lookup answers 400 — the fence question is undecided
 * there, and those routes are counted and named rather than scored clean. The
 * count is asserted to be less than the whole set, because a sweep where every
 * write is undecided has stopped measuring and would otherwise stay green.
 */

type AppVars = { Variables: import('../../src/middleware/request-id.js').RequestIdVars };

let harness: TestDatabase;
let app: Hono<AppVars>;
let projectA: string;
let projectB: string;
let projectArchived: string;
let issueA: string;
let issueB: string;
let boundToA: string;
let sessionTokenForA: string;
let listScopedToA: string;
let unscoped: string;
let readOnlyBoundToA: string;
let patAllowedFor: (path: string) => boolean;
let resetRateLimitStore: () => void;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV = 'test';
  // cm:guard this raises `patPerToken` ONLY, and it is not the whole defence — the IP-keyed limiters are untouched, `authRegister` at 3/hour among them, so a second probe of an IP-limited route still 429s and it is the throw in `get()` that catches it rather than this line. What it does buy: at the stock 60/minute the two sweeps — 205 probes on one token — spend most of their run refused, and both loops read a 429 as "the route refused me", so the assertion that makes the allowlist trustworthy quietly stops touching the routes it names (measured 2026-09-01: 3.1s and 96 rate-limited log lines, against 8.4s and none, on the same route set). Three breaches in an hour also auto-revoke the token, after which the rest of the file passes on 401s. Set BEFORE `src/index.js` is imported, because `config/env.ts` reads it once at module load.
  process.env.RATE_LIMIT_PAT_MAX = '100000';

  await truncateAll(harness.db);

  const user = await createTestUser(harness.db);
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${user.id}`);
  const org = await seedOrg(harness.db, user.id);

  const a = await createTestProject(harness.db, user.id, { orgId: org.id });
  const b = await createTestProject(harness.db, user.id, { orgId: org.id });
  projectA = a.id;
  projectB = b.id;
  await createTestProjectMember(harness.db, { projectId: projectA, userId: user.id });
  await createTestProjectMember(harness.db, { projectId: projectB, userId: user.id });

  const archived = await createTestProject(harness.db, user.id, { orgId: org.id });
  projectArchived = archived.id;
  await createTestProjectMember(harness.db, { projectId: projectArchived, userId: user.id });
  await harness.db.execute(
    sql`UPDATE projects SET archived_at = now() WHERE id = ${projectArchived}`,
  );

  issueA = await seedIssue(projectA, user.id);
  issueB = await seedIssue(projectB, user.id);

  const { mintPat } = await import('../../src/auth/pat.js');
  const { mintSessionToken } = await import('../../src/agent-sessions/session-token.js');
  boundToA = (await mintPat({ userId: user.id, name: 'bound-a', boundProjectId: projectA }))
    .plaintext;
  sessionTokenForA = (await mintSessionToken({
    id: randomUUID(),
    projectId: projectA,
    userId: user.id,
  })) as string;
  listScopedToA = (await mintPat({ userId: user.id, name: 'list-a', projectIds: [projectA] }))
    .plaintext;
  unscoped = (await mintPat({ userId: user.id, name: 'unscoped' })).plaintext;
  readOnlyBoundToA = (
    await mintPat({
      userId: user.id,
      name: 'ro-a',
      boundProjectId: projectA,
      scopes: ['read'],
    })
  ).plaintext;

  ({ app } = await import('../../src/index.js'));
  ({ patAllowedFor } = await import('../../src/middleware/pat-rest-surface.js'));
  ({ __resetRateLimitStore: resetRateLimitStore } = await import(
    '../../src/middleware/rate-limit.js'
  ));
});

afterAll(async () => {
  await harness.cleanup();
});

async function seedIssue(projectId: string, createdBy: string): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, title, status, created_by_id)
    VALUES (${id}, ${projectId}, 'fence probe', 'open', ${createdBy})
  `);
  return id;
}

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

async function get(path: string, token?: string) {
  return send('GET', path, token);
}

// cm:guard a 429 must never reach a sweep loop, which would score it as a refusal and skip the route. Throwing here is what turns "the limiter ate the sweep" from a silent green into a named failure — RATE_LIMIT_PAT_MAX and the store reset in `sweep` are what keep it from firing, and this is what happens when they stop working.
async function send(method: string, path: string, token?: string) {
  const res = await app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'GET' ? {} : { body: '{}' }),
  });
  if (res.status === 429)
    throw new Error(`rate-limited on ${method} ${path} — the sweep proves nothing`);
  return res;
}

// cm:guard the probes run CONCURRENTLY and that is a correctness property, not a speed one: serially the sweeps take ~14s on their own and blow the 30s timeout once the rest of the integration suite is competing for the same Postgres, and a sweep that dies half-way has asserted nothing about the routes it never reached. The store reset per batch is the other half: RATE_LIMIT_PAT_MAX lifts `patPerToken` only, so the IP-keyed limiters — `authRegister` at 3/hour among them, which the write sweep now walks into — would otherwise accumulate across batches and 429 the run.
async function sweep<T>(paths: Iterable<string>, probe: (path: string) => Promise<T | null>) {
  const all = [...paths];
  const hits: T[] = [];
  for (let i = 0; i < all.length; i += 20) {
    resetRateLimitStore();
    const batch = await Promise.all(all.slice(i, i + 20).map(probe));
    for (const hit of batch) if (hit !== null) hits.push(hit);
  }
  return hits;
}

/** Substitute every path param: project-ish → B, issue-ish → B's issue, else a nil uuid. */
function foreignise(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, (m) => {
    if (/project/i.test(m)) return projectB;
    if (/issue/i.test(m)) return issueB;
    return '00000000-0000-4000-8000-000000000000';
  });
}

describe('PAT fence — which projects a token may name', () => {
  it('a token bound to A cannot read project B', async () => {
    expect((await get(`/api/projects/${projectA}`, boundToA)).status).toBe(200);
    expect((await get(`/api/projects/${projectB}`, boundToA)).status).toBe(404);
  });

  // cm:guard the INDIRECT case, and it is the one a URL-param middleware would have missed — nothing in this path names a project, the route resolves it from the issue row, and the fence only fires because it sits in `effectiveProjectRole` rather than in a middleware reading `:projectId`. Rewrite the fence anywhere higher and this is the test that goes red.
  it('a token bound to A cannot read an issue that lives in B', async () => {
    expect((await get(`/api/issues/${issueA}`, boundToA)).status).toBe(200);
    expect((await get(`/api/issues/${issueB}`, boundToA)).status).toBe(404);
  });

  // cm:guard ISS-927 — a session token is a `boundProjectId` PAT and is fenced by the same code, but "the same code" is the assumption worth testing rather than stating. An unattended session runs unwatched on a box, so if the fence ever moved to somewhere that reads a `job:` name or a `jobs` row, this token would be the one that silently stopped being fenced.
  it('a session token is fenced to its own project, like any other bound token', async () => {
    expect((await get(`/api/issues/${issueA}`, sessionTokenForA)).status).toBe(200);
    expect((await get(`/api/issues/${issueB}`, sessionTokenForA)).status).toBe(404);
    expect((await get(`/api/projects/${projectB}`, sessionTokenForA)).status).toBe(404);
  });

  it('an allowlist token (projectIds, no binding) is fenced the same way', async () => {
    expect((await get(`/api/projects/${projectA}`, listScopedToA)).status).toBe(200);
    expect((await get(`/api/projects/${projectB}`, listScopedToA)).status).toBe(404);
  });

  it('a user-level token stays unfenced', async () => {
    expect((await get(`/api/projects/${projectA}`, unscoped)).status).toBe(200);
    expect((await get(`/api/projects/${projectB}`, unscoped)).status).toBe(200);
  });

  // cm:guard the list endpoints are the half `effectiveProjectRole` cannot defend — they name no project, so the per-project gate never fires and only the `loadVisibleProjectIds` intersection stands between a scoped token and every project id its owner can see
  it('the project list returns only the fenced project', async () => {
    const body = (await (await get('/api/projects', boundToA)).json()) as
      | { projects?: Array<{ id: string }> }
      | Array<{ id: string }>;
    const rows = Array.isArray(body) ? body : (body.projects ?? []);
    const ids = rows.map((p) => p.id);
    expect(ids).toContain(projectA);
    expect(ids).not.toContain(projectB);
  });

  // cm:guard this case is here, in the fence file, because it defends the SAME predicate: `visibleProjectsWhere` carries both the archived filter and the fence as sibling conditions, so the unparenthesised `OR` that annulled one would have annulled the other. Nothing else in the suite asserts the list excludes an archived project, which is how that shape survived to 2026-09-01.
  it('the project list still excludes an archived project the caller is a member of', async () => {
    const body = (await (await get('/api/projects', unscoped)).json()) as
      | { projects?: Array<{ id: string }> }
      | Array<{ id: string }>;
    const rows = Array.isArray(body) ? body : (body.projects ?? []);
    expect(rows.map((p) => p.id)).not.toContain(projectArchived);
  });
});

describe('PAT fence — the surface a token may reach', () => {
  // cm:guard named explicitly rather than left to the sweep: a scoped token that can mint an unscoped one has no scope, so this is the single refusal whose absence collapses every other assertion in this file
  it('no PAT can reach the PAT-minting surface', async () => {
    for (const token of [boundToA, unscoped]) {
      const res = await get('/api/pat', token);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe('PAT_NOT_PERMITTED');
    }
  });

  it('a read-scoped token cannot write', async () => {
    const res = await app.request(`/api/projects/${projectA}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${readOnlyBoundToA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'renamed by a read-only token' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('INSUFFICIENT_SCOPE');
  });

  // cm:guard `requireAnyAuth` is a SECOND auth entrypoint, and this case exists because it fenced nothing until 2026-09-01 — it read `userId` off the token row and went straight through, so a token bound to one project reached attachments and comments across every project its owner could see. The unit tests behind that router mock the middleware away; only a request through the real one shows the gate.
  it('a read-scoped token cannot write through requireAnyAuth either', async () => {
    const form = new FormData();
    form.append('file', new File(['x'], 'pic.png', { type: 'image/png' }));
    const res = await app.request(`/api/issues/${issueA}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${readOnlyBoundToA}` },
      body: form,
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('INSUFFICIENT_SCOPE');
  });

  /**
   * The inside half. The sweep below proves nothing OUTSIDE the allowlist
   * answers a PAT; this proves that inside it, a route handed an id belonging
   * to project B refuses — whichever entity the id names and whichever path
   * the handler takes to resolve its project.
   */
  it('no allowlisted route serves a foreign id to a fenced token', async () => {
    const attempts: string[] = [];
    for (const route of app.routes) {
      if (route.method !== 'GET') continue;
      if (!route.path.startsWith('/api/')) continue;
      if (route.path.includes('*')) continue;
      if (!patAllowedFor(route.path)) continue;
      if (!route.path.includes(':')) continue;
      attempts.push(foreignise(route.path));
      // cm:guard a single-param route is probed with BOTH a project id and an issue id, because which entity the id names decides which lookup the handler takes to a project — an issue-shaped route handed a project id 404s on the lookup and would score clean without ever reaching the fence.
      const params = route.path.match(/:[A-Za-z0-9_]+/g) ?? [];
      if (params.length === 1) {
        for (const foreign of [projectB, issueB]) {
          attempts.push(route.path.replace(/:[A-Za-z0-9_]+/, foreign));
        }
      }
    }
    expect(attempts.length).toBeGreaterThan(10);

    const served = await sweep(new Set(attempts), async (path) => {
      const res = await get(path, boundToA);
      return res.status >= 200 && res.status < 300 ? `${path} → ${res.status}` : null;
    });

    expect(
      served,
      'these allowlisted routes answered 2xx for an id that belongs to project B, with a token ' +
        'fenced to project A. Either the handler resolves its project without going through ' +
        'effectiveProjectRole, or it does not resolve one at all — and the second case means the ' +
        'prefix does not belong on PAT_ALLOWED_PREFIXES.',
    ).toEqual([]);
    // cm:guard keep this timeout ABOVE the 30s config default and do not "tidy" it back — this sweep probes every allowlisted param route against two foreign ids, so its cost grows with the route table and it measured 22s alone / >30s under a full parallel run on 2026-09-01. At the default it reports a slow pass as a fence breach, which is the one failure nobody re-reads.
  }, 90_000);

  /**
   * The sweep. Every GET route the app has registered outside the allowlist
   * must refuse a PAT — unless the route is public, which is decided by
   * asking it the same question with no credential at all rather than by a
   * hand-kept exemption list that would drift.
   */
  it('no registered route outside the allowlist answers a PAT', async () => {
    const paths = new Set<string>();
    for (const route of app.routes) {
      if (route.method !== 'GET' && route.method !== 'ALL') continue;
      if (!route.path.startsWith('/api/')) continue;
      if (route.path.includes('*')) continue;
      if (patAllowedFor(route.path)) continue;
      paths.add(
        route.path.replace(/:[A-Za-z0-9_]+/g, (m) =>
          /project/i.test(m) ? projectB : '00000000-0000-4000-8000-000000000000',
        ),
      );
    }
    expect(paths.size).toBeGreaterThan(15);

    const reachable = await sweep(paths, async (path) => {
      const withPat = await get(path, boundToA);
      if (withPat.status < 200 || withPat.status >= 300) return null;
      const anonymous = await get(path);
      if (anonymous.status >= 200 && anonymous.status < 300) return null;
      return `${path} → ${withPat.status}`;
    });

    expect(
      reachable,
      'these routes answered a project-scoped PAT and are NOT on PAT_ALLOWED_PREFIXES. Either ' +
        'the route resolves a project and belongs on the allowlist, or it does not — in which ' +
        'case a PAT there is an account-scoped credential wearing a project-scoped label, and ' +
        'the fence in lib/authz.ts has nothing to bite on.',
    ).toEqual([]);
  });

  /**
   * The write half of the outside sweep. A PAT reaching a non-allowlisted
   * WRITE route is the shape of the `requireAnyAuth` hole: the GET sweep saw
   * `GET /api/issues/:id/attachments` leak and could not reach the POST twin,
   * so the leak that mattered most was the one it could not look at.
   *
   * "Refused" here is 401/403, not "did not answer 2xx" — a write that reaches
   * body validation has already passed the fence, and an empty body would
   * otherwise let every unfenced write hide behind a 400.
   */
  it('no registered WRITE route outside the allowlist lets a PAT past the fence', async () => {
    const probes: string[] = [];
    for (const route of app.routes) {
      if (!(WRITE_METHODS as readonly string[]).includes(route.method)) continue;
      if (!route.path.startsWith('/api/')) continue;
      if (route.path.includes('*')) continue;
      if (patAllowedFor(route.path)) continue;
      probes.push(`${route.method} ${foreignise(route.path)}`);
    }
    expect(probes.length).toBeGreaterThan(20);

    const past = await sweep(new Set(probes), async (probe) => {
      const [method, path] = probe.split(' ') as [string, string];
      const withPat = await send(method, path, boundToA);
      if (withPat.status === 401 || withPat.status === 403) return null;
      // cm:guard a route that answers an ANONYMOUS caller the same way is public, and a public route has no fence to fail — deciding that by asking the route rather than by a hand-kept exemption list is what keeps this sweep from drifting as routes are added.
      const anonymous = await send(method, path);
      if (anonymous.status !== 401 && anonymous.status !== 403) return null;
      return `${probe} → ${withPat.status}`;
    });

    expect(
      past,
      'these WRITE routes are NOT on PAT_ALLOWED_PREFIXES and did not refuse a project-scoped ' +
        'PAT with 401/403 — they let it reach the handler. Either the route resolves a project ' +
        'and belongs on the allowlist, or a PAT must not reach it at all.',
    ).toEqual([]);
  });

  /**
   * The write half of the inside sweep: an allowlisted write route handed an
   * id from project B must not serve a token fenced to A.
   */
  it('no allowlisted WRITE route serves a foreign id to a fenced token', async () => {
    const probes: string[] = [];
    for (const route of app.routes) {
      if (!(WRITE_METHODS as readonly string[]).includes(route.method)) continue;
      if (!route.path.startsWith('/api/')) continue;
      if (route.path.includes('*')) continue;
      if (!patAllowedFor(route.path)) continue;
      if (!route.path.includes(':')) continue;
      probes.push(`${route.method} ${foreignise(route.path)}`);
    }
    expect(probes.length).toBeGreaterThan(10);

    const undecided: string[] = [];
    const served = await sweep(new Set(probes), async (probe) => {
      const [method, path] = probe.split(' ') as [string, string];
      const res = await send(method, path, boundToA);
      // cm:guard 204 is UNDECIDED, not served: a no-content response carries no evidence either way, and at least one route answers it deliberately for a caller it refuses — `DELETE /api/memory/:id` returns 204 for every unauthorised (id, caller) pair so that a 404 cannot be used to probe which ids exist. Scoring that as a leak would push someone to weaken the existence-hiding contract to make a sweep green; the named case below decides it properly instead, by seeding a row and checking it survived.
      if (res.status !== 204 && res.status >= 200 && res.status < 300) {
        return `${probe} → ${res.status}`;
      }
      if (res.status === 204 || res.status === 400 || res.status === 422) undecided.push(probe);
      return null;
    });

    expect(
      served,
      'these allowlisted WRITE routes accepted an id belonging to project B from a token fenced ' +
        'to project A. The handler either resolves its project without effectiveProjectRole, or ' +
        'does not resolve one at all.',
    ).toEqual([]);

    // cm:guard the empty body makes a 400 mean "the fence question never got asked", so those routes are counted rather than scored clean — and if EVERY probe lands there the sweep has stopped measuring while staying green, which is exactly what this comparison catches.
    expect(
      undecided.length,
      `every write probe was undecided (400/422/204) — the body validator now runs before the ` +
        `project lookup everywhere, so this sweep proves nothing: ${undecided.join(', ')}`,
    ).toBeLessThan(new Set(probes).size);
  }, 90_000);

  /**
   * The one route the sweep above cannot decide, decided by hand: seed a real
   * memory in project B, delete it with a token fenced to A, and look at the
   * row rather than at the status.
   */
  it('a 204 from the memory delete is a refusal, not a silent delete', async () => {
    const memoryId = randomUUID();
    await harness.db.execute(sql`
      INSERT INTO memories (id, project_id, source, source_ref, text_content)
      VALUES (${memoryId}, ${projectB}, 'note', 'fence-probe', 'survives a fenced delete')
    `);

    const res = await send('DELETE', `/api/memory/${memoryId}`, boundToA);
    expect(res.status).toBe(204);

    const rows = await harness.db.execute(sql`SELECT id FROM memories WHERE id = ${memoryId}`);
    expect(
      rows.length,
      'a token fenced to project A deleted a memory that lives in project B — the 204 the sweep ' +
        'reads as "no evidence" was a real delete all along.',
    ).toBe(1);
  });
});
