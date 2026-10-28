/**
 * An issue whose whole deliverable is adopting a contract version lands on that adoption record
 * (REQ-5 BC-17), and the record never stands in for a commit (BC-18).
 *
 * catalog-fe ISS-36, 2026-10-28: adopting admin-rest-v1 4.0.0 moved 21 links and the interface to
 * 4.0.0 with no code changed. The agent's mark was refused NO_WORK_EVIDENCE without a commit and
 * COMMIT_NOT_THIS_ISSUE with the base branch's head, and `awaiting_release` MERGE_NOT_RECORDED, so
 * finished work could not close. Here the same shape: a consumer adopts a version, then its agent
 * marks the issue on that record and closes it without a release.
 *
 * @direct-test-of packages/core/src/issues/adoption-mark.ts
 * @direct-test-of packages/core/src/issues/adoption-delivery.ts
 * @direct-test-of packages/core/src/ecosystem/adoption-record.ts
 * @direct-test-of packages/core/src/issues/merge-marker.ts
 * @direct-test-of packages/core/src/issues/merged-at.ts
 * @direct-test-of packages/core/src/issues/transition-guards.ts
 * @direct-test-of packages/core/src/issues/landing-evidence.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  example,
  formEcosystem,
  ok,
  openWorld,
  type Reply,
  requester,
  seedContractVersion,
  sender,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';
import { createTestDevice, createTestProject, rows } from '../helpers/factories.js';
import { boxToken } from '../helpers/preview-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const LIVE = { live: { tier: 'production' as const, deployment: { mode: 'external' as const } } };
const ADOPTED = 'forge/forge-api@2026-10-01';

let w: EcosystemWorld;
let say: ReturnType<typeof sender>;
let box: (method: string, path: string, body?: unknown) => Promise<Reply>;
let link = '';
let outsideGit = '';

let seq = 700;
async function issue(projectId: string): Promise<string> {
  const id = randomUUID();
  seq += 1;
  await rows(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`adopt ${seq}`}, 'in_progress', ${w.user.plugin})`);
  return id;
}

const mark = (id: string, body: Doc) => box('POST', `/api/issues/${id}/merge`, body);
const move = (id: string, toStatus: string) =>
  say('plugin', 'POST', `/api/issues/${id}/transition`, {
    toStatus,
    reason: `the adoption record moves it to ${toStatus}`,
  });

function refusalOf(r: Reply, status = 422): { code: string; path: string; detail: string } {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  const [first] = r.json.error?.refusals ?? [];
  return {
    code: first?.code ?? r.json.error?.code,
    path: first?.path ?? '',
    detail: first?.detail ?? r.json.error?.message ?? '',
  };
}

async function markOf(id: string): Promise<{ at: unknown; sha: unknown; artifacts: unknown }> {
  const [row] = await rows<{
    merged_at: unknown;
    merged_commit_sha: unknown;
    merged_artifacts: unknown;
  }>(sql`
    SELECT merged_at, merged_commit_sha, merged_artifacts FROM issues WHERE id = ${id}`);
  return {
    at: row?.merged_at ?? null,
    sha: row?.merged_commit_sha ?? null,
    artifacts: row?.merged_artifacts ?? null,
  };
}

async function statusOf(id: string): Promise<string> {
  const [row] = await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`);
  return row?.status ?? '';
}

async function pinLink(version: string): Promise<void> {
  await rows(sql`UPDATE ecosystem_links SET pinned_version = ${version} WHERE id = ${link}`);
}

beforeAll(async () => {
  w = await openWorld();
  await formEcosystem(w);
  await writeInterfaces(w);
  say = sender(w);
  const doc = example('forge-plugin.link.json');
  delete doc.id;
  delete doc.createdAt;
  delete doc.updatedAt;
  doc.ecosystem = w.eco;
  doc.consumer.project = w.project.plugin;
  doc.contract.provider = w.project.forge;
  link = ok(
    await say('plugin', 'POST', `/api/projects/${w.project.plugin}/links`, {
      baseRevision: null,
      document: doc,
    }),
  ).document.id;
  await seedContractVersion({
    providerId: w.project.forge,
    ref: 'forge/forge-api',
    version: '2026-10-01',
    previous: '2026-09-20',
    classification: 'non-breaking',
  });
  await rows(sql`
    UPDATE contract_versions SET elements = NULL
     WHERE provider_project_id = ${w.project.forge} AND contract_slug = 'forge-api'`);
  ok(
    await say('plugin', 'POST', `/api/projects/${w.project.plugin}/interface/adopt`, {
      contract: 'forge/forge-api',
      version: '2026-10-01',
    }),
  );
  await seedProjectDocument(w.project.plugin, w.user.plugin, {
    environments: LIVE,
    defaultBranch: 'dev',
  });
  outsideGit = (await createTestProject(w.user.plugin)).id;
  await seedProjectDocument(outsideGit, w.user.plugin, {
    environments: LIVE,
    source: { type: 'none' } as never,
  });
  const device = await createTestDevice(w.user.plugin);
  const call = requester(w.app, { box: await boxToken(w.user.plugin, device) });
  box = (method, path, body) => call('box', method, path, body);
}, 180_000);

afterAll(async () => {
  await closeWorld();
});

describe('an issue that only adopted a contract version lands on its adoption record (REQ-5 BC-17)', () => {
  it('is still refused NO_WORK_EVIDENCE when it names neither a commit nor an adoption, and the refusal names `adoptions`', async () => {
    const id = await issue(w.project.plugin);
    const refused = refusalOf(await mark(id, { target: 'dev' }));
    expect(refused.code).toBe('NO_WORK_EVIDENCE');
    expect(refused.detail).toContain('`adoptions`');
    expect((await markOf(id)).at).toBeNull();
  });

  it('marks on the record Forge read, moves to awaiting_release and closes without a release', async () => {
    const id = await issue(w.project.plugin);
    const marked = ok(await mark(id, { adoptions: [ADOPTED] }));
    expect(marked.action).toBe('merged');
    expect(marked.artifacts).toEqual([{ surface: 'adoption', ref: ADOPTED, change: 'changed' }]);
    expect(marked.detail).toContain('adoption record Forge read');
    expect(marked.detail).toContain(`${ADOPTED} (interface revision`);
    expect(marked.detail).toContain('1 link pinned there');
    const held = await markOf(id);
    expect(held.at).not.toBeNull();
    expect(held.sha).toBeNull();
    ok(await move(id, 'awaiting_release'));
    ok(await move(id, 'closed'));
    expect(await statusOf(id)).toBe('closed');
  });

  it('does not close once its links moved off the version: the merged rule names the record', async () => {
    const id = await issue(w.project.plugin);
    ok(await mark(id, { adoptions: [ADOPTED] }));
    await pinLink('2026-09-20');
    try {
      const refused = refusalOf(await move(id, 'awaiting_release'));
      expect(refused.code).toBe('MERGE_NOT_RECORDED');
      expect(refused.detail).toContain(`adoption record of ${ADOPTED}`);
      expect(refused.detail).toContain('not pinned at 2026-10-01');
    } finally {
      await pinLink('2026-10-01');
    }
    ok(await move(id, 'awaiting_release'));
    await pinLink('2026-09-20');
    try {
      const refused = refusalOf(await move(id, 'closed'));
      expect(['CLOSE_ONLY_BY_RELEASE', 'CLOSE_REQUIRES_SHIPPED']).toContain(refused.code);
      expect(await statusOf(id)).toBe('awaiting_release');
    } finally {
      await pinLink('2026-10-01');
    }
  });
});

describe('an adoption record never stands in for a commit (REQ-5 BC-18)', () => {
  it('refuses an issue carrying code evidence, naming it, and marks nothing', async () => {
    const id = await issue(w.project.plugin);
    ok(
      await box('PATCH', `/api/issues/${id}`, {
        workState: { step: 'plan', branch: 'feat/adopt-and-code', headSha: 'a'.repeat(40) },
      }),
    );
    const refused = refusalOf(await mark(id, { adoptions: [ADOPTED] }));
    expect([refused.code, refused.path]).toEqual(['ADOPTION_BESIDE_CODE', '/adoptions']);
    expect(refused.detail).toContain('branch feat/adopt-and-code');
    expect((await markOf(id)).at).toBeNull();
  });

  it('refuses a commit, a target or a landing sent beside the adoption', async () => {
    const id = await issue(w.project.plugin);
    for (const beside of [{ commit: 'b'.repeat(40) }, { target: 'dev' }]) {
      const refused = refusalOf(await mark(id, { adoptions: [ADOPTED], ...beside }));
      expect(refused.code).toBe('ADOPTION_BESIDE_CODE');
    }
    expect((await markOf(id)).at).toBeNull();
  });

  it('refuses a version the interface is not built against, naming what it is built against', async () => {
    const id = await issue(w.project.plugin);
    const refused = refusalOf(await mark(id, { adoptions: ['forge/forge-api@2026-09-20'] }));
    expect([refused.code, refused.path]).toEqual(['ADOPTION_NOT_RECORDED', '/adoptions']);
    expect(refused.detail).toContain('built against 2026-10-01, not 2026-09-20');
    expect((await markOf(id)).at).toBeNull();
  });

  it('refuses a version never recorded and a contract the project does not consume', async () => {
    const id = await issue(w.project.plugin);
    const never = refusalOf(await mark(id, { adoptions: ['forge/forge-api@2099-01-01'] }));
    expect(never.code).toBe('ADOPTION_NOT_RECORDED');
    expect(never.detail).toContain('never recorded');
    const unknown = refusalOf(await mark(id, { adoptions: ['nobody/forge-api@2026-10-01'] }));
    expect(unknown.code).toBe('ADOPTION_NOT_RECORDED');
    expect(unknown.detail).toContain('no project holds as its slug');
  });

  it('refuses an `adoption` artifact sent by hand, even by a person, so only the record Forge read is stamped', async () => {
    const id = await issue(outsideGit);
    const refused = refusalOf(
      await say('plugin', 'POST', `/api/issues/${id}/merge`, {
        landing: 'https://store.example.test/adopted',
        artifacts: [{ surface: 'adoption', ref: ADOPTED, change: 'changed' }],
      }),
    );
    expect(refused.code).toBe('ARTIFACTS_ADOPTION_BY_HAND');
    expect((await markOf(id)).at).toBeNull();
  });

  it('keeps an issue marked on a bare claim closing only through a release', async () => {
    const id = await issue(w.project.plugin);
    ok(await say('plugin', 'POST', `/api/issues/${id}/merge`, { target: 'dev' }));
    ok(await move(id, 'awaiting_release'));
    const refused = refusalOf(await move(id, 'closed'));
    expect(refused.code).toBe('CLOSE_ONLY_BY_RELEASE');
    expect(await statusOf(id)).toBe('awaiting_release');
  });
});
