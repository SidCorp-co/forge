/**
 * ISS-1256 criterion 4 (live judge on 0.4.0-dev.701): an opened find hit counts as a read, whoever
 * opens it. The judge opened a reference three times and a capability twice, from Cmd-K and from the
 * REST find with a box credential naming no run, and the module tree's Reads stayed 0: a read was
 * kept only against a run session, and the map counted only term and rule reaches. Here a person's
 * web open, a box credential's open naming no run and a personal token's MCP `fetch` each count on
 * the node they opened, for a term, a requirement, a reference and a capability alike. A run's own
 * reads (its run context, the door use's reads by agent kind, a lesson kept in use by an agent's
 * open) keep to rows with a session, so a person's open never reads as a run's.
 *
 * @direct-test-of packages/core/src/run-context/record.ts
 * @direct-test-of packages/core/src/run-context/hook.ts
 * @direct-test-of packages/core/src/run-context/read.ts
 * @direct-test-of packages/core/src/find/routes.ts
 * @direct-test-of packages/core/src/mcp/find-records.ts
 * @direct-test-of packages/core/src/labels/module-map-read.ts
 * @direct-test-of packages/core/src/metrics/door-use.ts
 * @direct-test-of packages/core/src/db/schema-run-context.ts
 */

import type { ModuleMapNode, ModuleTreeResponse } from '@forge/contracts/module-map';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mintPat } from '../../src/credentials/pat.js';
import { PAT_GRANT_EPOCH } from '../../src/credentials/pat-permissions.js';
import { db } from '../../src/db/client.js';
import { lastOpenedOf, readRunContext } from '../../src/run-context/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestRequirement,
  createTestUser,
  rows,
} from '../helpers/factories.js';
import { pairTestBox } from '../helpers/paired-box.js';

/** A card whose door's code lives in `schedules/`, so the map places it under Execution. */
const CARD = 'POST /api/schedules/:id/run';
const w = {
  projectId: '',
  owner: '',
  jwt: '',
  pat: '',
  pane: '',
  termId: '',
  requirementId: '',
  referenceId: '',
};

beforeAll(async () => {
  const owner = await createTestUser({ verified: true });
  const project = await createTestProject(owner.id);
  await addProjectMember(project.id, owner.id, 'owner');
  w.projectId = project.id;
  w.owner = owner.id;
  w.jwt = await userToken(owner.id);
  w.pat = (
    await mintPat({
      permissions: ['*'],
      userId: owner.id,
      name: 'opens',
      projectIds: [project.id],
      grantEpoch: PAT_GRANT_EPOCH,
    })
  ).plaintext;
  const [execution] = await rows<{ id: string }>(sql`
    INSERT INTO labels (project_id, name, color, kind, slug)
    VALUES (${project.id}, 'Execution', '#1f6f4a', 'module', 'execution') RETURNING id`);
  const moduleId = execution?.id as string;
  await db.execute(sql`
    INSERT INTO labels (project_id, name, color, kind, slug, parent_id)
    VALUES (${project.id}, 'schedules', '#1f6f4a', 'module', 'schedules', ${moduleId})`);
  const [term] = await rows<{ id: string }>(sql`
    INSERT INTO knowledge_entries (project_id, kind, slug, title, body, entry_type, module_id)
    VALUES (${project.id}, 'glossary', 'run-slots', 'Run slots',
            'How a box shares its runs between projects.', 'convention', ${moduleId})
    RETURNING id`);
  w.termId = term?.id as string;
  const req = await createTestRequirement(project.id, 7, 'A box shares its slots fairly');
  w.requirementId = req.id;
  await db.execute(sql`UPDATE requirements SET module_id = ${moduleId} WHERE id = ${req.id}`);
  const [ref] = await rows<{ id: string }>(sql`
    INSERT INTO reference_sources (org_id, project_id, kind, url, title, why, areas, priority,
                                   origin, added_by, added_agency, module_id)
    VALUES ((SELECT org_id FROM projects WHERE id = ${project.id}), ${project.id}, 'repo',
            'https://github.com/stablyai/orca', 'stablyai/orca', 'How a peer runs agents',
            ARRAY['agents'], 1, 'added', ${owner.id}, 'human', ${moduleId})
    RETURNING id`);
  w.referenceId = ref?.id as string;
  // a paired box with no live run: its credential's reads name no single run
  w.pane = (await pairTestBox(project.id, { pairedBy: owner.id, actsAs: owner.id }))
    .paneToken as string;
});

const open = async (token: string, id: string) => {
  const res = await api(
    token,
    'GET',
    `/api/projects/${w.projectId}/find/open?id=${encodeURIComponent(id)}`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};

async function readsOf(): Promise<Record<string, number>> {
  const res = await api(w.jwt, 'GET', `/api/projects/${w.projectId}/modules/execution/map`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const tree = res.body as unknown as ModuleTreeResponse;
  const node = (branch: ModuleMapNode[], ref: string) => branch.find((n) => n.ref === ref)?.reads;
  return {
    term: node(tree.branches.term, 'run-slots') ?? -1,
    requirement: node(tree.branches.requirement, 'REQ-7') ?? -1,
    reference: node(tree.branches.reference, w.referenceId) ?? -1,
    capability: node(tree.branches.capability, CARD) ?? -1,
  };
}

/** Waits for the reads the opens write off the request's path. */
const settle = (want: Record<string, number>) =>
  vi.waitFor(async () => expect(await readsOf()).toMatchObject(want), { timeout: 5000 });

const outsideAnyRun = () =>
  rows<{ kind: string; ref: string; user_id: string | null }>(sql`
    SELECT kind, ref, user_id FROM run_context_reaches
     WHERE project_id = ${w.projectId} AND agent_session_id IS NULL ORDER BY created_at`);

describe('criterion 4: an opened hit counts as a read, whoever opens it', () => {
  it("counts a person's Cmd-K opens of a term, a requirement, a reference and a capability", async () => {
    // the capability's door calls count beside its opens; none were made here
    expect(await readsOf()).toEqual({ term: 0, requirement: 0, reference: 0, capability: 0 });
    await open(w.jwt, `term:${w.termId}`);
    await open(w.jwt, `requirement:${w.requirementId}`);
    await open(w.jwt, `reference:${w.referenceId}`);
    await open(w.jwt, `capability:${CARD}`);
    await settle({ term: 1, requirement: 1, reference: 1, capability: 1 });
    // a person reads in no run: the read is kept outside any, naming who read
    expect(await outsideAnyRun()).toEqual(
      expect.arrayContaining([
        { kind: 'knowledge', ref: 'run-slots', user_id: w.owner },
        { kind: 'requirement', ref: w.requirementId, user_id: w.owner },
        { kind: 'reference', ref: w.referenceId, user_id: w.owner },
        { kind: 'capability', ref: CARD, user_id: w.owner },
      ]),
    );
  });

  it("counts an agent's open whose box credential names no run, over REST and MCP fetch", async () => {
    await open(w.pane, `reference:${w.referenceId}`);
    await settle({ reference: 2 });
    const res = await api(
      w.pat,
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'fetch', arguments: { id: `reference:${w.referenceId}` } },
      },
      { accept: 'application/json, text/event-stream' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(JSON.stringify(res.body)).toContain('stablyai/orca');
    await settle({ reference: 3 });
  });

  it("keeps a run's own reads to rows with a session", async () => {
    const since = new Date(Date.now() - 86_400_000);
    // the term was opened above outside any run: no agent session opened it, so no lesson-like read
    expect(await lastOpenedOf(w.projectId, ['run-slots'], since)).toEqual(new Map());
    const doors = await api(w.jwt, 'GET', `/api/projects/${w.projectId}/metrics/doors?days=30`);
    expect(doors.status, JSON.stringify(doors.body)).toBe(200);
    expect((doors.body as { reads: unknown[] }).reads).toEqual([]);
    const issue = await readRunContext(w.projectId, { issue: crypto.randomUUID() });
    expect(issue.reached).toEqual([]);
  });

  it('refuses a row outside any run that is not an open, or names an issue', async () => {
    const issue = await createTestIssue(w.projectId, w.owner, 9, {
      status: 'open',
      createdAt: new Date(),
    });
    for (const [how, issueId] of [
      ['prompt', null],
      ['search', null],
      ['get', issue.id],
    ] as const) {
      const refused = await db
        .execute(sql`
          INSERT INTO run_context_reaches (project_id, kind, ref, how, issue_id)
          VALUES (${w.projectId}, 'knowledge', 'run-slots', ${how}, ${issueId})`)
        .then(
          () => 'written',
          (err: unknown) => String((err as { cause?: unknown }).cause ?? err),
        );
      expect(refused, `${how} with issue ${issueId}`).toMatch(/run_context_reaches_reader_chk/);
    }
  });
});
