/**
 * A project's reference sources (ISS-1252), through the app against real Postgres: a source added
 * is found by its area and no other; an address already held and a followed address that is no
 * github.com repository are refused by name; a followed source's release files an idea only where
 * the fast model judges it helps one of the open items nearest it by meaning. orca 1.4.255 and
 * Claude Code v2.1.323, each near an open item, stay silent; coolify v4.7.0 files ONE idea on the
 * ISS-1082-like issue carrying the model's why; three coolify versions read in one pass file one idea,
 * the newest named and every one recorded against it, a second read filing nothing again; with no
 * model or no embeddings a release stays silent and the pass names why; a source whose read throws is
 * settled with its error and the pass reads the next; a citation is counted on the
 * source's signals; and a source nobody cited for 90 days is flagged. The releases are fixtures
 * handed to the follow pass, the embedder a word-vector stand-in with issue copies written at a
 * chosen cosine, and the model a stand-in judge: no network.
 *
 * @direct-test-of packages/core/src/references/routes.ts
 * @direct-test-of packages/core/src/references/service.ts
 * @direct-test-of packages/core/src/references/read.ts
 * @direct-test-of packages/core/src/references/follow.ts
 * @direct-test-of packages/core/src/references/release-judge.ts
 * @direct-test-of packages/core/src/references/signals.ts
 * @direct-test-of packages/core/src/references/tool.ts
 * @direct-test-of packages/core/src/db/schema-references.ts
 * @direct-test-of packages/core/src/feedback/signal-filing.ts
 * @direct-test-of packages/core/src/memory/search.ts
 * @direct-test-of packages/core/src/knowledge/item-embeddings.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import type { FollowedRead } from '../../src/integrations/github/index.js';
import { env } from '../../src/lib/env.js';
import { followAllSources, followSource, type ReleaseReader } from '../../src/references/follow.js';
import { releaseLead } from '../../src/references/match.js';
import { activeSourcesOf, type SourceRow } from '../../src/references/read.js';
import { FORGE_OPEN_ITEMS, RELEASE_NOTES } from '../../src/references/releases.fixture.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestUser,
  rows,
  type TestProject,
} from '../helpers/factories.js';
import { modelLikeVector, vectorAt } from '../helpers/word-vector.js';

/** The embedder and the fast model as the test sets them: on by default, the judge strict. */
const llm = vi.hoisted(() => ({
  embeddings: true,
  judge: null as null | ((prompt: string) => unknown),
}));

vi.mock('../../src/integrations/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  embeddingsConfigured: () => llm.embeddings,
  embedWithModel: async (_s: unknown, text: string) => ({
    vector: modelLikeVector(text),
    model: env.EMBEDDINGS_MODEL,
  }),
  callFastModelObject: async (_s: unknown, prompt: string) =>
    (llm.judge as (p: string) => unknown)(prompt),
}));

const COOLIFY_WHY =
  'It cancels the older queued webhook deploys when a newer push arrives, so a push no longer waits behind stale rollouts.';

/** The model as it should judge: only coolify's queued-deploy cancel helps the ISS-1082-like issue. */
const strictJudge = (prompt: string) => ({
  ok: true,
  modelId: 'stand-in',
  value:
    prompt.includes('queued webhook deployments') && prompt.includes('recreates rather than rolls')
      ? { helps: true, why: COOLIFY_WHY }
      : { helps: false, why: 'It is about something else.' },
});
const judged: string[] = [];
/** The strict judge, keeping each prompt it was asked. */
const recordingJudge = (prompt: string) => {
  judged.push(prompt);
  return strictJudge(prompt);
};
llm.judge = recordingJudge;

let project: TestProject;
let jwt: string;
let issueId: string;
let coolifyIssueId: string;
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
  // forge's open items as the pass read them, each copy written near the release it was filed from
  const near: [number, string, string][] = [
    [1082, 'ISS-1082', lead('coolify', 'v4.7.0')],
    [1070, 'ISS-1070', lead('claudeCode', 'v2.1.323')],
    [89, 'REQ-89', lead('orca', 'v1.4.255')],
  ];
  for (const [seq, like, to] of near) {
    const made = await createTestIssue(project.id, owner.id, seq, {
      status: 'open',
      createdAt: new Date(),
    });
    const title = FORGE_OPEN_ITEMS.find((i) => i.ref === like)?.title ?? '';
    await db.execute(sql`UPDATE issues SET title = ${title} WHERE id = ${made.id}`);
    await db.execute(sql`
      INSERT INTO memories (project_id, source, source_ref, text_content, embedding)
      VALUES (${project.id}, 'issue', ${made.id}, ${title}, ${vectorAt(to, 0.66, seq)}::vector)`);
    if (seq === 1082) coolifyIssueId = made.id;
  }
}, 120_000);

/** A release's lead text as the pass embeds it, read off the fixture. */
function lead(key: keyof typeof RELEASE_NOTES, tag: string): string {
  return releaseLead({ tag, name: tag, body: RELEASE_NOTES[key].body });
}

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
  (repo: string, releases: { tag: string; body: string }[]): ReleaseReader =>
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
        url: `https://github.com/${repo}/releases/tag/${r.tag}`,
        body: r.body,
        publishedAt: new Date().toISOString(),
      })),
    }) satisfies FollowedRead;

async function sourceNamed(title: string): Promise<SourceRow> {
  const [source] = (await activeSourcesOf(db, project.id, project.orgId)).filter(
    (s) => s.title === title,
  );
  if (!source) throw new Error(`${title} was not added`);
  return source;
}

async function followed(repo: string, why: string): Promise<SourceRow> {
  const added = await api(jwt, 'POST', base(), {
    kind: 'repo',
    url: `https://github.com/${repo}`,
    why,
    areas: ['deploys'],
    followReleases: true,
  });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  return sourceNamed(repo);
}

const ideaCount = async () =>
  (
    await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM feedback WHERE project_id = ${project.id} AND kind = 'idea'`,
    )
  )[0]?.n;

async function timeline(source: SourceRow): Promise<Record<string, Body>> {
  const read = await api(jwt, 'GET', `${base()}/${source.id}/timeline`);
  expect(read.status).toBe(200);
  return Object.fromEntries((read.body.releases as Body[]).map((r) => [r.tag as string, r]));
}

const coolify = (...tags: string[]) =>
  fixture(
    'coollabsio/coolify',
    tags.map((tag) => ({ tag, body: RELEASE_NOTES.coolify.body })),
  );

describe("a followed source's releases digested (c2)", () => {
  it('keeps orca 1.4.255 and Claude Code v2.1.323 silent, near an open item though each sits', async () => {
    const orca = await sourceNamed('stablyai/orca');
    const claude = await followed('anthropics/claude-code', 'the coding agent every run drives');
    for (const [source, read] of [
      [orca, fixture('stablyai/orca', [{ tag: 'v1.4.255', body: RELEASE_NOTES.orca.body }])],
      [
        claude,
        fixture('anthropics/claude-code', [
          { tag: 'v2.1.323', body: RELEASE_NOTES.claudeCode.body },
        ]),
      ],
    ] as const) {
      judged.length = 0;
      const out = await followSource(source, read);
      expect(out, source.title).toMatchObject({
        act: 'digested',
        ideas: [],
        silent: 1,
        unjudged: 0,
      });
      // shortlisted by its cosine, kept out by the judgement
      expect(judged.length, source.title).toBeGreaterThan(0);
    }
    expect(await ideaCount()).toBe(0);
    expect((await timeline(orca))['v1.4.255']).toMatchObject({
      outcome: 'silent',
      matched: null,
      notJudged: null,
      idea: null,
    });
  });

  it("files coolify v4.7.0 as one idea on the ISS-1082-like issue, carrying the model's why", async () => {
    const source = await followed('coollabsio/coolify', 'how forge-dev is deployed');
    const out = await followSource(source, coolify('v4.7.0'));
    expect(out).toMatchObject({ act: 'digested', silent: 0, unjudged: 0 });
    expect(out.ideas).toHaveLength(1);

    const ideas = await rows<{ issue_id: string; title: string; body: string }>(
      sql`SELECT issue_id, title, body FROM feedback WHERE project_id = ${project.id} AND kind = 'idea'`,
    );
    expect(ideas).toHaveLength(1);
    expect(ideas[0]?.issue_id).toBe(coolifyIssueId);
    expect(ideas[0]?.title).toMatch(/^coollabsio\/coolify v4\.7\.0 may help with ISS-1082: /);
    expect(ideas[0]?.body).toContain(COOLIFY_WHY);
    expect(ideas[0]?.body).not.toContain('Both name');
    expect((await timeline(source))['v4.7.0']).toMatchObject({
      outcome: 'idea',
      matched: { ref: 'ISS-1082', why: COOLIFY_WHY },
      idea: out.ideas[0],
    });
  });

  it('files ONE idea for three versions of one source that help the same item, the newest named', async () => {
    const source = await sourceNamed('coollabsio/coolify');
    const read = coolify('v4.7.3', 'v4.7.2', 'v4.7.1', 'v4.7.0');
    const out = await followSource(source, read);
    expect(out.ideas).toHaveLength(1);
    expect(await ideaCount()).toBe(2);

    const [idea] = await rows<{ title: string; body: string }>(
      sql`SELECT title, body FROM feedback WHERE project_id = ${project.id} AND kind = 'idea' ORDER BY fb_seq DESC LIMIT 1`,
    );
    expect(idea?.title).toMatch(/^coollabsio\/coolify v4\.7\.3 may help with ISS-1082/);
    expect(idea?.body).toContain('releases/tag/v4.7.1');
    expect(idea?.body).toContain('releases/tag/v4.7.2');
    const byTag = await timeline(source);
    for (const tag of ['v4.7.1', 'v4.7.2', 'v4.7.3']) {
      expect(byTag[tag], tag).toMatchObject({ outcome: 'idea', idea: out.ideas[0] });
    }

    // the same releases read again file nothing
    await followSource({ ...(await sourceNamed('coollabsio/coolify')), lastSeenTag: null }, read);
    expect(await ideaCount()).toBe(2);
  });

  it('keeps a release silent where no model can judge it, and the pass says why by name', async () => {
    const source = await sourceNamed('coollabsio/coolify');
    llm.judge = () => ({ ok: false, miss: 'unconfigured', detail: 'LITELLM_API_URL is not set' });
    try {
      const out = await followSource(source, coolify('v4.7.4', 'v4.7.3'));
      expect(out).toMatchObject({ ideas: [], silent: 1, unjudged: 1 });
      expect(out.said).toMatch(/v4\.7\.4: not judged: no fast model is set up to judge it/);
      expect((await timeline(source))['v4.7.4']).toMatchObject({
        outcome: 'silent',
        notJudged: expect.stringMatching(/no fast model is set up/),
      });
    } finally {
      llm.judge = recordingJudge;
    }
    expect(await ideaCount()).toBe(2);
  });

  it('keeps a release silent where no vector can be had, and never matches it by its words', async () => {
    const source = await sourceNamed('coollabsio/coolify');
    llm.embeddings = false;
    try {
      const out = await followSource(source, coolify('v4.7.5', 'v4.7.4'));
      expect(out).toMatchObject({ ideas: [], silent: 1, unjudged: 1 });
      expect(out.said).toMatch(/v4\.7\.5: no vector for the release \(provider_not_configured\)/);
    } finally {
      llm.embeddings = true;
    }
    expect(await ideaCount()).toBe(2);
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
    expect(orcaSignals?.ideas).toMatchObject({ filed: 0 });
    // three releases recorded against one idea count it once
    const coolifySignals = (signals.body.sources as Body[]).find(
      (s) => s.title === 'coollabsio/coolify',
    );
    expect(coolifySignals?.ideas).toMatchObject({ filed: 2 });
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
