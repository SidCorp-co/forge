/**
 * ISS-1064: a knowledge entry carried no source, scope or re-check condition, so nothing said what it
 * rested on or when it stopped being true. A reference, guide, workflow or rule, and every org entry,
 * is now written with `source`, `scope` and `recheckWhen` or refused `KNOWLEDGE_PROVENANCE_MISSING`
 * naming each one left out; the read, the list and the search answer them; the guide index line
 * shows an entry's source; and a lesson, written by the lessons module, owes none. Against real
 * Postgres.
 *
 * @direct-test-of packages/core/src/knowledge/provenance.ts
 * @direct-test-of packages/core/src/knowledge/upsert.ts
 * @direct-test-of packages/core/src/knowledge/routes.ts
 * @direct-test-of packages/core/src/knowledge/org-knowledge.ts
 * @direct-test-of packages/core/src/knowledge/org-knowledge-routes.ts
 * @direct-test-of packages/core/src/knowledge/service.ts
 * @direct-test-of packages/core/src/knowledge/search.ts
 * @direct-test-of packages/core/src/knowledge/lesson-entries.ts
 * @direct-test-of packages/core/src/prompt/facts/guide-index.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { putLessonEntry } from '../../src/knowledge/lesson-entries.js';
import { servedCheckoutOrientation } from '../../src/prompt/checkout-orientation.js';
import { loadProjectFactInputs, renderStageFactsText } from '../../src/prompt/facts/resolve.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

const SOURCED = {
  source: 'packages/core/src/knowledge/upsert.ts:upsertKnowledgeEntries, ISS-1064',
  scope: 'every knowledge write of this project',
  recheckWhen: 'upsertKnowledgeEntries moves or the knowledge kinds change',
};

const w = { orgId: '', projectId: '', slug: '', admin: '' };
const own = (slug: string) => `/api/projects/${w.projectId}/knowledge/${slug}`;
const org = (slug: string) => `/api/orgs/${w.orgId}/knowledge/${slug}`;
type Refused = { error?: { refusals?: { code: string; path: string }[] } };
const codesOf = (body: unknown): string[] =>
  ((body as Refused).error?.refusals ?? []).map((r) => r.code);
const pathsOf = (body: unknown): string[] =>
  ((body as Refused).error?.refusals ?? []).map((r) => r.path);

beforeAll(async () => {
  const admin = await createTestUser({ verified: true });
  const project = await createTestProject(admin.id);
  w.orgId = project.orgId;
  w.projectId = project.id;
  w.slug = project.slug;
  await addProjectMember(w.projectId, admin.id, 'owner');
  w.admin = await userToken(admin.id);
});

describe('a project entry owes its source, scope and re-check condition (criterion 1)', () => {
  it('refuses a reference with none of the three, naming each, and writes nothing', async () => {
    const put = await api(w.admin, 'PUT', own('zz-unsourced-reference'), {
      kind: 'reference',
      title: 'Unsourced',
      body: 'The knowledge door writes one entry per slug.',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(422);
    const said = JSON.stringify(put.body);
    expect(codesOf(put.body)).toEqual(Array(3).fill('KNOWLEDGE_PROVENANCE_MISSING'));
    expect(pathsOf(put.body)).toEqual(['/source', '/scope', '/recheckWhen']);
    expect(said).toContain('`zz-unsourced-reference` is a reference and names no `source`, `scope`, `recheckWhen`');
    expect(said).toContain('recheckWhen: string (1-1000)');
    expect((await api(w.admin, 'GET', own('zz-unsourced-reference'))).status).toBe(404);
  });

  it('names only the field left out, and counts a blank one as left out', async () => {
    const put = await api(w.admin, 'PUT', own('zz-half-sourced'), {
      kind: 'reference',
      title: 'Half',
      body: 'Half sourced.',
      source: SOURCED.source,
      scope: '   ',
      recheckWhen: SOURCED.recheckWhen,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(422);
    const said = JSON.stringify(put.body);
    expect(pathsOf(put.body)).toEqual(['/scope']);
    expect(said).toContain('names no `scope`:');
  });

  it('refuses a kindless write too, since the door files it as a guide', async () => {
    const put = await api(w.admin, 'PUT', own('zz-kindless'), { title: 'Kindless', body: 'x' });
    expect(put.status, JSON.stringify(put.body)).toBe(422);
    expect(JSON.stringify(put.body)).toContain('`zz-kindless` is a guide and names no');
  });

  it.each(['guide', 'workflow', 'rule'] as const)('refuses a %s the same way', async (kind) => {
    const put = await api(w.admin, 'PUT', own(`zz-unsourced-${kind}`), {
      kind,
      title: kind,
      body: `An unsourced ${kind}.`,
      source: SOURCED.source,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(422);
    expect(JSON.stringify(put.body)).toContain(`is a ${kind} and names no \`scope\`, \`recheckWhen\``);
  });

  it('stores a reference carrying all three, and reads, lists and finds them back', async () => {
    const body = 'Provenance-marker-zq7 one entry per slug.';
    const put = await api(w.admin, 'PUT', own('zz-sourced-reference'), {
      kind: 'reference',
      title: 'Sourced',
      body,
      ...SOURCED,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const read = await api(w.admin, 'GET', own('zz-sourced-reference'));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ origin: 'project', kind: 'reference', body, ...SOURCED });
    const list = await api(w.admin, 'GET', `/api/projects/${w.projectId}/knowledge`);
    expect(
      (list.body as { rows: { slug: string }[] }).rows.find((r) => r.slug === 'zz-sourced-reference'),
    ).toMatchObject(SOURCED);
    const found = await api(w.admin, 'POST', `/api/projects/${w.projectId}/knowledge/search`, {
      query: 'Provenance-marker-zq7',
      strategy: 'keyword',
    });
    expect(found.status, JSON.stringify(found.body)).toBe(200);
    expect(
      (found.body as { knowledge: { slug: string }[] }).knowledge.find(
        (h) => h.slug === 'zz-sourced-reference',
      ),
    ).toMatchObject(SOURCED);
  });

  it('takes an overview, scenario or glossary with none of the three', async () => {
    for (const kind of ['overview', 'scenario', 'glossary']) {
      const put = await api(w.admin, 'PUT', own(`zz-free-${kind}`), {
        kind,
        title: kind,
        body: `A ${kind}.`,
      });
      expect(put.status, `${kind}: ${JSON.stringify(put.body)}`).toBe(200);
      const read = await api(w.admin, 'GET', own(`zz-free-${kind}`));
      expect(read.body).toMatchObject({ source: null, scope: null, recheckWhen: null });
    }
  });

  it('reads a row written before the fields existed, with null in each', async () => {
    await db.execute(sql`
      INSERT INTO knowledge_entries (project_id, slug, kind, title, body)
      VALUES (${w.projectId}, 'zz-legacy-guide', 'guide', 'Legacy', 'Written before ISS-1064.')`);
    const read = await api(w.admin, 'GET', own('zz-legacy-guide'));
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ kind: 'guide', source: null, scope: null, recheckWhen: null });
  });
});

describe('an org entry owes the same three (criterion 2)', () => {
  it('refuses an org entry left without them, naming each, and writes nothing', async () => {
    const put = await api(w.admin, 'PUT', org('zz-org-unsourced'), {
      title: 'Voice',
      body: 'The agent is the only voice.',
      scope: SOURCED.scope,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(422);
    const said = JSON.stringify(put.body);
    expect(pathsOf(put.body)).toEqual(['/source', '/recheckWhen']);
    expect(codesOf(put.body)).toEqual(Array(2).fill('KNOWLEDGE_PROVENANCE_MISSING'));
    expect(said).toContain('org entry `zz-org-unsourced` names no `source`, `recheckWhen`');
    expect((await api(w.admin, 'GET', org('zz-org-unsourced'))).status).toBe(404);
  });

  it('stores one carrying all three, and reads them back at the org and the project door', async () => {
    const put = await api(w.admin, 'PUT', org('zz-org-sourced'), {
      title: 'Voice',
      body: 'The agent is the only voice.',
      injection: 'on_demand',
      ...SOURCED,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body).toMatchObject(SOURCED);
    expect((await api(w.admin, 'GET', org('zz-org-sourced'))).body).toMatchObject(SOURCED);
    expect((await api(w.admin, 'GET', own('zz-org-sourced'))).body).toMatchObject({
      origin: 'org',
      ...SOURCED,
    });
  });
});

describe("the guide index line shows an entry's source", () => {
  it('in the stage prompt and the served orientation, for a project and an org entry', async () => {
    const put = await api(w.admin, 'PUT', own('zz-indexed-guide'), {
      kind: 'guide',
      title: 'Indexed',
      body: 'A guide the index names.',
      injection: 'on_demand',
      ...SOURCED,
      source: 'scripts/check-memory-anchors.mjs:knowledgeAnchors',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const preamble = renderStageFactsText(
      await loadProjectFactInputs(w.projectId),
      w.projectId,
      'plan',
    );
    expect(preamble).toContain(
      '- zz-indexed-guide — source: scripts/check-memory-anchors.mjs:knowledgeAnchors',
    );
    expect(preamble).toContain(`- zz-org-sourced (org) — source: ${SOURCED.source}`);
    const orientation = await servedCheckoutOrientation(w.projectId, w.slug);
    expect(orientation).toContain(
      '- zz-indexed-guide — source: scripts/check-memory-anchors.mjs:knowledgeAnchors',
    );
    // a row with no source is named as owing one rather than shown as if it rested on nothing
    expect(preamble).toContain('- zz-legacy-guide — source: none recorded');
  });
});

describe('a lesson entry is unaffected (criterion 4)', () => {
  it('is written by the lessons module with none of the three, and the door still refuses it as a lesson', async () => {
    await db.transaction((tx) =>
      putLessonEntry(tx, {
        projectId: w.projectId,
        sentence: 'Keep ward names short.',
        injection: 'on_demand',
        meta: {
          lessonId: '00000000-0000-4000-8000-000000001064',
          number: 1064,
          scope: { kind: 'project', areaId: null, areaName: null, itemKind: null },
        },
      }),
    );
    const read = await api(w.admin, 'GET', own('lesson-1064'));
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body).toMatchObject({
      kind: 'lesson',
      body: 'Keep ward names short.',
      source: null,
      scope: null,
      recheckWhen: null,
    });
    const named = await api(w.admin, 'PUT', own('zz-my-lesson'), {
      kind: 'lesson',
      title: 'x',
      body: 'y',
    });
    expect(codesOf(named.body)).toEqual(['KNOWLEDGE_LESSON_OWNED']);
    const over = await api(w.admin, 'PUT', own('lesson-1064'), {
      kind: 'rule',
      title: 'x',
      body: 'rewritten',
    });
    expect(codesOf(over.body)).toEqual(['KNOWLEDGE_LESSON_OWNED']);
    expect(pathsOf(over.body)).not.toContain('/source');
  });
});
