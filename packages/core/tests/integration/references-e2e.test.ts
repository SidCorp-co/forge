/**
 * A project's reference sources (ISS-1252), through the app against real Postgres: a source added
 * is found by its area and no other; an address already held and a followed address that is no
 * github.com repository are refused by name; a followed source's release that shares distinctive
 * words with an open issue files ONE idea on that issue, naming the release, and a release about
 * nothing open stays silent on the timeline and files nothing, a second read filing nothing again;
 * a source whose read throws is settled with its error and the pass reads the next; a citation is
 * counted on the source's signals; and a source nobody cited for 90 days is flagged.
 * The releases are fixtures handed to the follow pass: no network.
 *
 * @direct-test-of packages/core/src/references/routes.ts
 * @direct-test-of packages/core/src/references/service.ts
 * @direct-test-of packages/core/src/references/read.ts
 * @direct-test-of packages/core/src/references/follow.ts
 * @direct-test-of packages/core/src/references/signals.ts
 * @direct-test-of packages/core/src/references/tool.ts
 * @direct-test-of packages/core/src/db/schema-references.ts
 * @direct-test-of packages/core/src/feedback/signal-filing.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import type { FollowedRead } from '../../src/integrations/github/index.js';
import { followAllSources, followSource, type ReleaseReader } from '../../src/references/follow.js';
import { activeSourcesOf } from '../../src/references/read.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  type TestProject,
} from '../helpers/factories.js';

let project: TestProject;
let jwt: string;
let issueId: string;
const base = () => `/api/projects/${project.id}/reference-sources`;
const codeOf = (b: Body) => (b.error as { code?: string } | undefined)?.code ?? b.code;

beforeAll(async () => {
  const owner = await createTestUser({ verified: true });
  project = await createTestProject(owner.id);
  jwt = await userToken(owner.id);
  const issue = await createTestIssue(project.id, owner.id, 12, {
    status: 'open',
    createdAt: new Date(),
  });
  issueId = issue.id;
  await db.execute(
    sql`UPDATE issues SET title = 'Parallel runs collide in one worktree when two agents share a branch' WHERE id = ${issueId}`,
  );
}, 120_000);

const orca = {
  kind: 'repo',
  url: 'https://github.com/stablyai/orca',
  why: 'parallel CLI agents in isolated git worktrees',
  areas: ['parallel agents', 'worktrees'],
  followReleases: true,
};

describe('a reference source added (c1)', () => {
  it('is found by its area, and a source of another area is not', async () => {
    const added = await api(jwt, 'POST', base(), orca);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect((added.body.source as Body).title).toBe('stablyai/orca');
    const mem = await api(jwt, 'POST', base(), {
      kind: 'project',
      url: 'https://github.com/getzep/graphiti',
      why: 'validity intervals on what an agent learned',
      areas: ['memory'],
    });
    expect(mem.status, JSON.stringify(mem.body)).toBe(201);

    const found = await api(jwt, 'GET', `${base()}?area=worktrees`);
    expect(found.status).toBe(200);
    expect((found.body.sources as Body[]).map((s) => s.title)).toEqual(['stablyai/orca']);
    const byWords = await api(jwt, 'GET', `${base()}?q=validity`);
    expect((byWords.body.sources as Body[]).map((s) => s.title)).toEqual(['getzep/graphiti']);
  });

  it('refuses an address already held, and a followed address that is no repository, by name', async () => {
    const twice = await api(jwt, 'POST', base(), {
      ...orca,
      url: 'https://github.com/stablyai/orca/',
    });
    expect(twice.status).toBe(422);
    expect(codeOf(twice.body)).toBe('REFERENCE_SOURCE_DUPLICATE');
    const site = await api(jwt, 'POST', base(), {
      kind: 'doc',
      url: 'https://modelcontextprotocol.io/specification',
      why: 'MCP changes',
      areas: ['tools'],
      followReleases: true,
    });
    expect(site.status).toBe(422);
    expect(codeOf(site.body)).toBe('REFERENCE_FOLLOW_UNSUPPORTED');
  });
});

const fixture =
  (releases: { tag: string; body: string }[]): ReleaseReader =>
  async () =>
    ({
      ok: true,
      repo: { archived: false, pushedAt: new Date().toISOString() },
      unchanged: false,
      etag: 'W/"fixture"',
      from: 'releases',
      releases: releases.map((r) => ({
        tag: r.tag,
        name: r.tag,
        url: `https://github.com/stablyai/orca/releases/tag/${r.tag}`,
        body: r.body,
        publishedAt: new Date().toISOString(),
      })),
    }) satisfies FollowedRead;

describe("a followed source's releases digested (c2)", () => {
  it('files one idea on the open issue a release may help, and keeps the other silent', async () => {
    const [source] = (await activeSourcesOf(db, project.id, project.orgId)).filter(
      (s) => s.title === 'stablyai/orca',
    );
    if (!source) throw new Error('orca was not added');
    const read = fixture([
      { tag: 'v0.9.0', body: 'Dark mode and a faster font loader.' },
      {
        tag: 'v1.0.0',
        body: 'Each parallel task gets its own worktree, so branches no longer collide.',
      },
    ]);
    const out = await followSource(source, read);
    expect(out.act).toBe('digested');
    expect(out.ideas).toHaveLength(1);
    expect(out.silent).toBe(1);

    const ideas = await rows<{ kind: string; issue_id: string; body: string }>(
      sql`SELECT kind, issue_id, body FROM feedback WHERE project_id = ${project.id}`,
    );
    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.kind).toBe('idea');
    expect(ideas[0]?.issue_id).toBe(issueId);
    expect(ideas[0]?.body).toContain('https://github.com/stablyai/orca/releases/tag/v1.0.0');

    const timeline = await api(jwt, 'GET', `${base()}/${source.id}/timeline`);
    expect(timeline.status).toBe(200);
    const byTag = Object.fromEntries((timeline.body.releases as Body[]).map((r) => [r.tag, r]));
    expect(byTag['v1.0.0']?.outcome).toBe('idea');
    expect(byTag['v1.0.0']?.matched).toMatchObject({ ref: 'ISS-12' });
    expect(byTag['v0.9.0']?.outcome).toBe('silent');
    expect(byTag['v0.9.0']?.idea).toBeNull();

    // the same releases read again file nothing
    const [after] = (await activeSourcesOf(db, project.id, project.orgId)).filter(
      (s) => s.id === source.id,
    );
    if (!after) throw new Error('orca is gone');
    await followSource({ ...after, lastSeenTag: null }, read);
    const again = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${project.id}`,
    );
    expect(again[0]?.n).toBe(1);
  });
});

describe('a source whose read throws, in the scheduled pass', () => {
  it('is settled with its error, and the source behind it is still read', async () => {
    for (const name of ['broken', 'healthy']) {
      const added = await api(jwt, 'POST', base(), {
        kind: 'repo',
        url: `https://github.com/acme-${name}/lib`,
        why: `a ${name} source`,
        areas: ['follow pass'],
        followReleases: true,
      });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
    }
    // the broken source is read first (never checked), the healthy one next
    await db.execute(
      sql`UPDATE reference_sources SET last_checked_at = '2000-01-01T00:00:00Z' WHERE title = 'acme-healthy/lib'`,
    );
    const asked: string[] = [];
    const read: ReleaseReader = async (repo) => {
      asked.push(repo);
      if (repo === 'acme-broken/lib') throw new Error('The operation was aborted due to timeout');
      return { ok: true, repo: { archived: false, pushedAt: null }, unchanged: true, etag: null };
    };
    const now = new Date();
    const tally = await followAllSources(read, now);
    expect(asked.slice(0, 2)).toEqual(['acme-broken/lib', 'acme-healthy/lib']);
    expect(tally.failed).toBe(1);
    expect(tally.stopped).toBeNull();

    const settled = await rows<{ title: string; follow_error: string | null; checked: boolean }>(
      sql`SELECT title, follow_error, last_checked_at = ${now.toISOString()}::timestamptz AS checked
          FROM reference_sources WHERE title LIKE 'acme-%' ORDER BY title`,
    );
    expect(settled).toEqual([
      {
        title: 'acme-broken/lib',
        follow_error: 'The operation was aborted due to timeout',
        checked: true,
      },
      { title: 'acme-healthy/lib', follow_error: null, checked: true },
    ]);
  });
});

describe('signals (c4)', () => {
  it('count a citation, taken, on its source', async () => {
    const cited = await api(
      jwt,
      'POST',
      `${base()}/${encodeURIComponent('stablyai/orca')}/citations`,
      {
        ref: 'src/worktrees/create.ts',
        verdict: 'take',
        why: 'one worktree per task under the repo',
        about: 'ISS-12',
      },
    );
    expect(cited.status, JSON.stringify(cited.body)).toBe(201);
    const signals = await api(jwt, 'GET', `${base()}/signals`);
    expect(signals.status).toBe(200);
    const orcaSignals = (signals.body.sources as Body[]).find((s) => s.title === 'stablyai/orca');
    expect(orcaSignals?.citations).toMatchObject({ total: 1, recent: 1, taken: 1, rejected: 0 });
    expect(orcaSignals?.ideas).toMatchObject({ filed: 1 });
    expect(orcaSignals?.flags).toEqual([]);
  });

  it('flag a source nobody cited for 90 days, for keep, replace or remove', async () => {
    await db.execute(
      sql`UPDATE reference_sources SET added_at = now() - interval '91 days' WHERE title = 'getzep/graphiti' AND project_id = ${project.id}`,
    );
    const signals = await api(jwt, 'GET', `${base()}/signals`);
    const graphiti = (signals.body.sources as Body[]).find((s) => s.title === 'getzep/graphiti');
    expect(graphiti?.flags).toEqual([expect.objectContaining({ kind: 'uncited' })]);
    expect(signals.body.review).toEqual(['keep', 'replace', 'remove']);
  });
});
