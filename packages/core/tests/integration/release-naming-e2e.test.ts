/**
 * A release is named once it is drafted and keeps its name through the cut (REQ-40 BC-14).
 * catalog-api 0.1.0 waited at the gate as a draft with no run, so the one place a name could be
 * written refused it, and its page and peek opened on a bare version. Through the app's own routes,
 * against real Postgres: naming the draft, the cut carrying it, a cut's own name winning, a version
 * that is neither refused by name, and the master's nudge reading drafts as well as cuts.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { unnamedReleases } from '../../src/release-batch/index.js';
import { api, userToken } from '../helpers/api.js';
import { createTestProject, createTestUser, truncateAll } from '../helpers/factories.js';
import { declareProductionDocument, releaseWorld } from '../helpers/release-world.js';

let projectId: string;
let ownerId: string;
let token: string;
const fx = releaseWorld(() => ({ projectId, ownerId }));

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  projectId = (await createTestProject(ownerId)).id;
  token = await userToken(ownerId);
  await fx.seedReleaseRunner();
  const bindingId = await fx.declareProduction({}, 'none');
  await declareProductionDocument({ projectId, ownerId, bindingId, probes: 'none' });
});

const call = (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${projectId}${path}`, body);

const EPOD = {
  name: 'ePOD deploy',
  summary:
    'Catalog giờ deploy được thiết kế lên cửa hàng ePOD. Trang cài đặt cửa hàng kiểm tra được kết nối.',
};

async function draftVersion(): Promise<string> {
  const r = await call('GET', '/releases');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const draft = (r.body.releases as { version: string; state: string }[]).find(
    (x) => x.state === 'draft',
  );
  expect(draft, 'a release is drafted').toBeDefined();
  return String(draft?.version);
}

async function named(version: string): Promise<{ name: unknown; summary: unknown }> {
  const r = await call('GET', `/releases/${version}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const release = r.body.release as { name: unknown; summary: unknown };
  return { name: release.name, summary: release.summary };
}

async function runNaming(runId: string): Promise<unknown> {
  const [row] = [
    ...(await db.execute(
      sql`SELECT metadata->'naming' AS naming FROM pipeline_runs WHERE id = ${runId}`,
    )),
  ];
  return (row as { naming: { name: string; summary: string } | null }).naming;
}

const pending = async () => [
  ...(await db.execute(sql`SELECT version, name FROM release_draft_namings`)),
];

describe('a drafted release is named before it is cut (REQ-40 BC-14)', () => {
  it('holds the name a draft was given, and reads it on the draft', async () => {
    await fx.insertIssue();
    const version = await draftVersion();
    expect(await named(version)).toEqual({ name: null, summary: null });

    const r = await call('PUT', `/releases/${version}/naming`, EPOD);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ version, state: 'draft', runId: null, ...EPOD });
    expect(await named(version)).toEqual(EPOD);
  });

  it('keeps it through the cut: the cut carries it onto its run and the draft row goes', async () => {
    const roster = [await fx.insertIssue()];
    const version = await draftVersion();
    expect((await call('PUT', `/releases/${version}/naming`, EPOD)).status).toBe(200);

    const cut = await call('POST', '/release-batches', { issueIds: roster });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    expect(cut.body.version).toBe(version);
    expect(await runNaming(String(cut.body.runId))).toMatchObject({ ...EPOD, by: ownerId });
    expect(await pending()).toEqual([]);
    expect(await named(version)).toEqual(EPOD);
  });

  it('lets a cut that names the release override what the draft was given', async () => {
    const roster = [await fx.insertIssue()];
    const version = await draftVersion();
    expect((await call('PUT', `/releases/${version}/naming`, EPOD)).status).toBe(200);
    const given = {
      name: 'Store deploys',
      summary: 'Designs deploy to ePOD. Store settings test the connection.',
    };

    const cut = await call('POST', '/release-batches', { issueIds: roster, ...given });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    expect(await runNaming(String(cut.body.runId))).toMatchObject(given);
    expect(await pending()).toEqual([]);
  });

  it('renames a release already cut on its run', async () => {
    const cut = await call('POST', '/release-batches', { issueIds: [await fx.insertIssue()] });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    const r = await call('PUT', `/releases/${cut.body.version}/naming`, EPOD);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ state: 'cut', runId: cut.body.runId });
    expect(await runNaming(String(cut.body.runId))).toMatchObject(EPOD);
  });

  it('refuses by name a version neither drafted nor cut, saying which is drafted, and writes nothing', async () => {
    await fx.insertIssue();
    const version = await draftVersion();
    const r = await call('PUT', '/releases/9.9.9/naming', EPOD);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).toContain('RELEASE_VERSION_UNKNOWN');
    expect(JSON.stringify(r.body)).toContain(`the release drafted is ${version}`);
    expect(await pending()).toEqual([]);
  });

  it('refuses a name for a project with nothing drafted, saying so', async () => {
    const r = await call('PUT', '/releases/0.1.0/naming', EPOD);
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).toContain('nothing waits at the release gate');
  });

  it('owes the master a name for an unnamed draft, and stops once it is named', async () => {
    await fx.insertIssue();
    const version = await draftVersion();
    expect(await unnamedReleases(projectId)).toEqual([{ version }]);
    expect((await call('PUT', `/releases/${version}/naming`, EPOD)).status).toBe(200);
    expect(await unnamedReleases(projectId)).toEqual([]);
  });
});
