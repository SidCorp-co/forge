/**
 * The module map (ISS-1256), through the app against real Postgres. The owner's own example is the
 * fixture: the term Run slots (vi "chia slot", industry "fair-share scheduling", code "run slots"),
 * anchored at `packages/core/src/devices/run-slots.ts:slotsFor`. An agent writes the term with its
 * module, aliases, provenance and anchor in one knowledge write, a rule under a child module, and the
 * relations between them; a requirement and an issue are placed by the placement door. The pillar
 * rolls each up to its business module with open issues as the only health figure, and lists what
 * nobody placed as Unplaced: an entry anchored in a module's code is NOT placed by core (c6). The
 * tree carries each node's relations both ways, its re-check and its reads. A relation of any other
 * kind, or between ends its kind does not join, is refused by name (c1). A landing that changes the
 * anchored file flags the term owing a re-check, by the knowledge re-check every entry is weighed by,
 * and a change elsewhere does not (c8). The capabilities read narrows to one module's cards (c7).
 *
 * @direct-test-of packages/core/src/labels/module-map-read.ts
 * @direct-test-of packages/core/src/labels/module-map-write.ts
 * @direct-test-of packages/core/src/labels/module-map-nodes.ts
 * @direct-test-of packages/core/src/labels/routes.ts
 * @direct-test-of packages/core/src/knowledge/module-fields.ts
 * @direct-test-of packages/core/src/knowledge/recheck.ts
 * @direct-test-of packages/core/src/knowledge/upsert.ts
 * @direct-test-of packages/core/src/issues/module-field.ts
 * @direct-test-of packages/core/src/requirements/module-field.ts
 * @direct-test-of packages/core/src/metrics/capabilities.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { flagKnowledgeForChange } from '../../src/knowledge/index.js';
import { api, type Body, userToken } from '../helpers/api.js';
import {
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  type TestProject,
} from '../helpers/factories.js';

let project: TestProject;
let jwt: string;
const base = () => `/api/projects/${project.id}`;
const codeOf = (b: Body) =>
  ((b.error as { refusals?: { code: string }[]; code?: string } | undefined)?.refusals?.[0]?.code ??
    (b.error as { code?: string } | undefined)?.code ??
    b.code) as string | undefined;

const ANCHOR = 'packages/core/src/devices/run-slots.ts:slotsFor';

async function moduleLabel(name: string, slug: string, parentId: string | null): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO labels (id, project_id, name, color, kind, slug, parent_id, description)
    VALUES (${id}, ${project.id}, ${name}, '#1f6f4a', 'module', ${slug}, ${parentId},
            ${parentId ? null : 'agent, run, master, runner'})`);
  return id;
}

beforeAll(async () => {
  const owner = await createTestUser({ verified: true });
  project = await createTestProject(owner.id);
  jwt = await userToken(owner.id);
  const execution = await moduleLabel('Execution', 'execution', null);
  await moduleLabel('devices', 'devices', execution);
  // the module map's own doors live in `labels`, so its cards sit under Execution in this project
  await moduleLabel('labels', 'labels', execution);
  await moduleLabel('Knowledge', 'knowledge-2', null);
  await createTestRequirement(project.id, 48, 'An agent stands at every handoff');
  await createTestRequirement(project.id, 2, 'Nobody placed this one');
  await createTestIssue(project.id, owner.id, 12, { status: 'open', createdAt: new Date() });
  await createTestIssue(project.id, owner.id, 13, { status: 'open', createdAt: new Date() });
}, 120_000);

describe('a term written with its module, aliases, provenance and anchor (c1, c6)', () => {
  it('is written in one knowledge write and read back on its module tree', async () => {
    const put = await api(jwt, 'PUT', `${base()}/knowledge/run-slots`, {
      kind: 'glossary',
      title: 'Run slots',
      body: 'How Forge shares the runs a runner box may run at once between projects.',
      module: 'execution',
      term: {
        aliases: { vi: ['chia slot'], code: ['run slots'], industry: ['fair-share scheduling'] },
        namedBy: { who: 'owner', quote: 'cái này gọi là run slots' },
      },
      anchor: ANCHOR,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    const rule = await api(jwt, 'PUT', `${base()}/knowledge/project-keeps-one-slot`, {
      kind: 'rule',
      title: 'A project with work keeps at least one slot',
      body: 'A project with work always keeps at least one run slot.',
      module: 'devices',
      source: 'owner 2026-11-16',
      scope: 'every runner box',
      recheckWhen: 'devices/run-slots.ts changes',
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);
  });

  it('refuses a term on another kind, an unknown module and a malformed anchor by name', async () => {
    const onRule = await api(jwt, 'PUT', `${base()}/knowledge/not-a-term`, {
      kind: 'rule',
      title: 'x rule',
      body: 'x',
      source: 's',
      scope: 's',
      recheckWhen: 'r',
      term: { aliases: { vi: ['x'] } },
    });
    expect(codeOf(onRule.body)).toBe('MODULE_MAP_TERM_NOT_GLOSSARY');
    const unknown = await api(jwt, 'PUT', `${base()}/knowledge/stray-term`, {
      kind: 'glossary',
      title: 'Stray',
      body: 'x',
      module: 'nowhere',
    });
    expect(codeOf(unknown.body)).toBe('MODULE_MAP_MODULE_UNKNOWN');
    const anchor = await api(jwt, 'PUT', `${base()}/knowledge/stray-term`, {
      kind: 'glossary',
      title: 'Stray',
      body: 'x',
      anchor: 'devices/run-slots',
    });
    expect(codeOf(anchor.body)).toBe('MODULE_MAP_ANCHOR_SHAPE');
  });
});

describe('relations are of five kinds only (c1)', () => {
  it('writes used_in and governs once each, the same write twice standing once', async () => {
    const used = {
      kind: 'used_in',
      from: { type: 'term', ref: 'run-slots' },
      to: { type: 'rule', ref: 'project-keeps-one-slot' },
    };
    const first = await api(jwt, 'POST', `${base()}/modules/relations`, used);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.created).toBe(true);
    const again = await api(jwt, 'POST', `${base()}/modules/relations`, used);
    expect(again.body).toMatchObject({ id: first.body.id, created: false });
    const governs = await api(jwt, 'POST', `${base()}/modules/relations`, {
      kind: 'governs',
      from: { type: 'rule', ref: 'project-keeps-one-slot' },
      to: { type: 'capability', ref: 'module.get' },
    });
    expect(governs.status, JSON.stringify(governs.body)).toBe(201);
    const from = await api(jwt, 'POST', `${base()}/modules/relations`, {
      kind: 'from',
      from: { type: 'rule', ref: 'project-keeps-one-slot' },
      to: { type: 'requirement', ref: 'REQ-48' },
    });
    expect(from.status, JSON.stringify(from.body)).toBe(201);
  });

  it('refuses a generic "related" kind and ends a kind does not join, by name', async () => {
    const related = await api(jwt, 'POST', `${base()}/modules/relations`, {
      kind: 'related',
      from: { type: 'term', ref: 'run-slots' },
      to: { type: 'rule', ref: 'project-keeps-one-slot' },
    });
    expect(related.status).toBe(422);
    expect(codeOf(related.body)).toBe('MODULE_MAP_RELATION_KIND_UNKNOWN');
    const ends = await api(jwt, 'POST', `${base()}/modules/relations`, {
      kind: 'governs',
      from: { type: 'term', ref: 'run-slots' },
      to: { type: 'capability', ref: 'module.get' },
    });
    expect(codeOf(ends.body)).toBe('MODULE_MAP_RELATION_ENDS');
    const missing = await api(jwt, 'POST', `${base()}/modules/relations`, {
      kind: 'from',
      from: { type: 'term', ref: 'run-slots' },
      to: { type: 'requirement', ref: 'REQ-999' },
    });
    expect(codeOf(missing.body)).toBe('MODULE_MAP_NODE_NOT_FOUND');
  });
});

describe('placement is a field an agent sets (c1, c6)', () => {
  it('places a requirement and an issue, and refuses an unknown module by name', async () => {
    const req = await api(jwt, 'PUT', `${base()}/modules/placements`, {
      type: 'requirement',
      ref: 'REQ-48',
      module: 'execution',
    });
    expect(req.body, JSON.stringify(req.body)).toMatchObject({
      module: 'execution',
      previous: null,
    });
    const issue = await api(jwt, 'PUT', `${base()}/modules/placements`, {
      type: 'issue',
      ref: 'ISS-12',
      module: 'devices',
    });
    expect(issue.body).toMatchObject({ module: 'devices', previous: null });
    const unknown = await api(jwt, 'PUT', `${base()}/modules/placements`, {
      type: 'issue',
      ref: 'ISS-12',
      module: 'nowhere',
    });
    expect(codeOf(unknown.body)).toBe('MODULE_MAP_MODULE_UNKNOWN');
  });

  it("places nothing by itself: a term anchored in a module's code and written with no module stays Unplaced", async () => {
    const put = await api(jwt, 'PUT', `${base()}/knowledge/device-lease`, {
      kind: 'glossary',
      title: 'Device lease',
      body: 'A box holds an issue while it works it.',
      anchor: 'packages/core/src/devices/lease.ts:holdLease',
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const pillar = await api(jwt, 'GET', `${base()}/modules/map`);
    const unplaced = pillar.body.unplaced as { items: { type: string; ref: string }[] };
    expect(unplaced.items).toContainEqual(
      expect.objectContaining({ type: 'term', ref: 'device-lease' }),
    );
  });
});

describe('the pillar and the tree (c2, c3 reads)', () => {
  it('rolls each record up to its business module, open issues the only health figure', async () => {
    const pillar = await api(jwt, 'GET', `${base()}/modules/map`);
    expect(pillar.status).toBe(200);
    const rows = pillar.body.modules as {
      module: { slug: string };
      counts: Body;
      openIssues: number;
    }[];
    const execution = rows.find((r) => r.module.slug === 'execution');
    expect(execution?.counts).toMatchObject({ term: 1, rule: 1, requirement: 1 });
    expect(execution?.counts.capability).toBeGreaterThan(0);
    expect(execution?.openIssues).toBe(1);
    expect(Object.keys(execution ?? {})).not.toContain('score');
    const unplaced = pillar.body.unplaced as { counts: Body; openIssues: number; items: Body[] };
    expect(unplaced.openIssues).toBe(1);
    expect(unplaced.items).toContainEqual(
      expect.objectContaining({ type: 'requirement', ref: 'REQ-2' }),
    );
    expect(unplaced.items).toContainEqual(
      expect.objectContaining({ type: 'issue', ref: expect.stringMatching(/-13$/) }),
    );
  });

  it("reads a module's tree over its subtree, each node with its relations both ways and its reads", async () => {
    const tree = await api(jwt, 'GET', `${base()}/modules/execution/map`);
    expect(tree.status, JSON.stringify(tree.body)).toBe(200);
    const branches = tree.body.branches as Record<string, Body[]>;
    const term = branches.term?.find((n) => n.ref === 'run-slots');
    expect(term).toMatchObject({
      title: 'Run slots',
      module: 'execution',
      aliases: { vi: ['chia slot'], code: ['run slots'], industry: ['fair-share scheduling'] },
      namedBy: { who: 'owner', quote: 'cái này gọi là run slots' },
      recheck: null,
      reads: 0,
    });
    const rels = term?.relations as { kind: string; direction: string; other: Body }[];
    expect(rels).toContainEqual(
      expect.objectContaining({
        kind: 'anchored_at',
        direction: 'out',
        other: expect.objectContaining({ type: 'code', ref: ANCHOR }),
      }),
    );
    expect(rels).toContainEqual(
      expect.objectContaining({
        kind: 'used_in',
        other: expect.objectContaining({
          ref: 'project-keeps-one-slot',
          title: 'A project with work keeps at least one slot',
        }),
      }),
    );
    expect(rels).toContainEqual(
      expect.objectContaining({
        kind: 'belongs_to',
        other: expect.objectContaining({ ref: 'execution' }),
      }),
    );
    const rule = branches.rule?.find((n) => n.ref === 'project-keeps-one-slot');
    expect(rule?.module).toBe('execution/devices');
    const ruleRels = rule?.relations as { kind: string; direction: string }[];
    expect(ruleRels).toContainEqual(expect.objectContaining({ kind: 'used_in', direction: 'in' }));
    expect(ruleRels).toContainEqual(expect.objectContaining({ kind: 'governs', direction: 'out' }));
    expect(branches.requirement?.map((n) => n.ref)).toEqual(['REQ-48']);
    expect(branches.capability?.map((n) => n.ref)).toContain('module.get');
    expect((tree.body.inFlight as Body[]).map((i) => i.module)).toEqual(['execution/devices']);
  });

  it("narrows the capabilities read to the module's cards (c7)", async () => {
    const caps = await api(jwt, 'GET', `${base()}/metrics/capabilities?module=execution`);
    expect(caps.status, JSON.stringify(caps.body)).toBe(200);
    expect((caps.body.module as { cards: string[] }).cards).toContain('module.place');
    const other = await api(jwt, 'GET', `${base()}/metrics/capabilities?module=knowledge-2`);
    expect((other.body.module as { cards: string[] }).cards).toEqual([]);
  });
});

describe('freshness: a change to the anchored code owes the term a re-check (c8)', () => {
  it('flags the term a landing changing its anchored file meets, and no term for a change elsewhere', async () => {
    const elsewhere = await flagKnowledgeForChange(project.id, {
      by: 'ISS-70',
      paths: ['packages/core/src/issues/routes.ts'],
      text: '',
      rules: [],
    });
    const before = await api(jwt, 'GET', `${base()}/modules/execution/map`);
    const untouched = (before.body.branches as Record<string, Body[]>).term?.find(
      (n) => n.ref === 'run-slots',
    );
    expect(untouched?.recheck).toBeNull();
    expect(elsewhere).toBe(0);

    await flagKnowledgeForChange(project.id, {
      by: 'ISS-77',
      paths: ['packages/core/src/devices/run-slots.ts'],
      text: '',
      rules: [],
    });
    const after = await api(jwt, 'GET', `${base()}/modules/execution/map`);
    const flagged = (after.body.branches as Record<string, Body[]>).term?.find(
      (n) => n.ref === 'run-slots',
    );
    expect(flagged?.recheck).toMatchObject({
      by: 'ISS-77',
      matched: ['packages/core/src/devices/run-slots.ts'],
    });
  });
});
