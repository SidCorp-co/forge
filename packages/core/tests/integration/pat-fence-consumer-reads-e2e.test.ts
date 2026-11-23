/**
 * A token fenced to its project still reads, read-only, what that project builds against: the
 * contract versions of a provider it consumes, and the bus of an ecosystem it is a member of (FB-320
 * on dev Forge, 2026-10-28). From 2026-10-27 a job pane went out on its project's checkout
 * credential, fenced to that project, and catalog-fe's builder runs were refused
 * PAT_PROJECT_OUTSIDE_FENCE on catalog-api's and adminhub-api's contract versions and
 * PAT_ACCOUNT_ROUTE on their ecosystem's bus. Anything wider stays fenced: another route of the
 * provider, a write, a contract published to no ecosystem its project is an active member of, an
 * ecosystem it is not in, a steward's whole sight, the account's ecosystem list (ISS-734). The
 * ecosystem-inbox guide also sends it to the provider's version artifact and API page, and those two
 * GETs pass the fence the same way, answered as the party read answers (ISS-1438, FB-835).
 *
 * @direct-test-of packages/core/src/middleware/pat-fence.ts
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type EcosystemWorld,
  formEcosystem,
  openWorld,
  type Reply,
  requester,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';

let w: EcosystemWorld;
let as: (
  who: 'plugin' | 'store' | 'internal',
  method: string,
  path: string,
  body?: unknown,
) => Promise<Reply>;

const ARTIFACT =
  '{"openapi":"3.1.0","info":{"title":"forge-api","version":"2026-09-20"},"paths":{}}';

const codeOf = (r: Reply): string | null =>
  (r.json?.code as string | undefined) ??
  (r.json?.error?.code as string | undefined) ??
  String(r.json?.message ?? r.json?.detail ?? '').match(/^([A-Z_]+):/)?.[1] ??
  null;

beforeAll(async () => {
  w = await openWorld();
  await formEcosystem(w);
  await writeInterfaces(w);
  // the plugin's admin also sits in the org that stewards the other ecosystem: a session reads it
  // as its steward, a token fenced to the plugin never does
  await db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role) VALUES (${w.org.store}, ${w.user.plugin}, 'member')
  `);
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { PAT_GRANT_EPOCH } = await import('../../src/credentials/pat-permissions.js');
  // minted now, as a pane's checkout credential is: at the grant epoch every surface has joined
  const fenced = async (userId: string, projectId: string, name: string) =>
    (
      await mintPat({
        userId,
        name,
        permissions: ['*'],
        projectIds: [projectId],
        grantEpoch: PAT_GRANT_EPOCH,
      })
    ).plaintext;
  as = requester(w.app, {
    plugin: await fenced(w.user.plugin, w.project.plugin, 'plugin master'),
    store: await fenced(w.user.store, w.project.store, 'store master'),
    // the provider's own admin, fenced to a project of theirs that is in no ecosystem
    internal: await fenced(w.user.platform, w.project.internal, 'internal master'),
  });
  // the version a consumer builds against holds its stored bytes, as a published upload does
  const sha = createHash('sha256').update(ARTIFACT).digest('hex');
  await db.execute(sql`
    INSERT INTO contract_artifacts (sha256, content, byte_length)
    VALUES (${sha}, ${ARTIFACT}, ${Buffer.byteLength(ARTIFACT)})`);
  await db.execute(sql`
    UPDATE contract_versions SET artifact_sha256 = ${sha}
     WHERE provider_project_id = ${w.project.forge} AND contract_slug = 'forge-api'`);
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('a fenced token reads what its project builds against', () => {
  it("reads a version of a contract its project consumes, with its elements, and the provider's version list", async () => {
    const version = await as(
      'plugin',
      'GET',
      `/api/projects/${w.project.forge}/contracts/forge-api/versions/2026-09-20`,
    );
    expect(version.status, JSON.stringify(version.json)).toBe(200);
    expect(version.json.reader).toMatchObject({ access: 'party' });

    const list = await as(
      'plugin',
      'GET',
      `/api/projects/${w.project.forge}/contracts/forge-api/versions`,
    );
    expect(list.status, JSON.stringify(list.json)).toBe(200);
  });

  it("reads the artifact of a version it builds against and the provider's API page, as a party", async () => {
    const art = await as(
      'plugin',
      'GET',
      `/api/projects/${w.project.forge}/contracts/forge-api/versions/2026-09-20/artifact`,
    );
    expect(art.status, JSON.stringify(art.json)).toBe(200);
    expect(art.json).toMatchObject({ openapi: '3.1.0' });

    const page = await as('plugin', 'GET', `/api/projects/${w.project.forge}/api-page`);
    expect(page.status, JSON.stringify(page.json)).toBe(200);
    expect(page.json.reader).toMatchObject({ access: 'party' });
    expect(page.json.publishes.map((p: { slug: string }) => p.slug)).toContain('forge-api');
  });

  it('reads the bus of the ecosystem its project is a member of', async () => {
    const bus = await as('plugin', 'GET', `/api/ecosystems/${w.eco}/bus`);
    expect(bus.status, JSON.stringify(bus.json)).toBe(200);
  });
});

// ISS-734 (FB-320's second ask): a builder run reads what its ecosystem's members publish BEFORE
// its project consumes anything (ecosystem-inbox guide, builder step 2), so a fenced token reads the
// approved versions of a contract published to an ecosystem one of its own projects is an active
// member of, consuming it or not yet, and nothing its user sees through a project outside the fence.
describe('a fenced token reads what its ecosystem publishes, as a member', () => {
  it('reads a contract its project does not consume yet, the ecosystem offering it', async () => {
    const r = await as(
      'store',
      'GET',
      `/api/projects/${w.project.forge}/contracts/forge-api/versions/2026-09-20`,
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.reader).toMatchObject({ access: 'party' });
  });

  it("reads that contract's artifact and the provider's API page the same way", async () => {
    const art = await as(
      'store',
      'GET',
      `/api/projects/${w.project.forge}/contracts/forge-api/versions/2026-09-20/artifact`,
    );
    expect(art.status, JSON.stringify(art.json)).toBe(200);
    expect(art.json).toMatchObject({ openapi: '3.1.0' });

    const page = await as('store', 'GET', `/api/projects/${w.project.forge}/api-page`);
    expect(page.status, JSON.stringify(page.json)).toBe(200);
    expect(page.json.reader).toMatchObject({ access: 'party' });
  });
});

describe('anything wider stays fenced', () => {
  it('refuses another route of the provider, and a write to its contract versions, by name', async () => {
    const read = await as('plugin', 'GET', `/api/projects/${w.project.forge}/interface`);
    expect(read.status).toBe(403);
    expect(codeOf(read)).toBe('PAT_PROJECT_OUTSIDE_FENCE');

    const write = await as(
      'plugin',
      'POST',
      `/api/projects/${w.project.forge}/contracts/forge-api/versions`,
      {
        version: '2026-10-28',
      },
    );
    expect(write.status).toBe(403);
    expect(codeOf(write)).toBe('PAT_PROJECT_OUTSIDE_FENCE');
  });

  it('refuses every write the provider serves beside those reads, by name', async () => {
    const forge = `/api/projects/${w.project.forge}`;
    for (const [method, path] of [
      ['POST', `${forge}/contracts/forge-api/versions/2026-09-20/decision`],
      ['PUT', `${forge}/interface`],
    ] as const) {
      const r = await as('plugin', method, path, {});
      expect(r.status, `${method} ${path}: ${JSON.stringify(r.json)}`).toBe(403);
      expect(codeOf(r), `${method} ${path}`).toBe('PAT_PROJECT_OUTSIDE_FENCE');
    }
  });

  it("reads as its fence alone: a project in no ecosystem is refused the provider's versions, artifact and page, though its user administers the provider", async () => {
    const base = `/api/projects/${w.project.forge}/contracts/forge-api/versions`;
    for (const path of [
      base,
      `${base}/2026-09-20`,
      `${base}/2026-09-20/artifact`,
      `/api/projects/${w.project.forge}/api-page`,
    ]) {
      const r = await as('internal', 'GET', path);
      expect(r.status, `${path}: ${JSON.stringify(r.json)}`).toBe(403);
      expect(codeOf(r), path).toBe('FORBIDDEN');
      expect(JSON.stringify(r.json), path).toMatch(/ecosystem/);
    }
  });

  it('refuses the bus of an ecosystem its project is not in, though its user stewards it', async () => {
    const r = await as('plugin', 'GET', `/api/ecosystems/${w.otherEco}/bus`);
    expect(r.status, JSON.stringify(r.json)).toBe(403);
  });

  it('refuses the account routes of ecosystems, as before', async () => {
    const list = await as('plugin', 'GET', '/api/ecosystems/mine');
    expect(list.status, JSON.stringify(list.json)).toBe(403);
    expect(codeOf(list)).toBe('PAT_ACCOUNT_ROUTE');
    const one = await as('plugin', 'GET', `/api/ecosystems/${w.eco}`);
    expect(one.status, JSON.stringify(one.json)).toBe(403);
    expect(codeOf(one)).toBe('PAT_ACCOUNT_ROUTE');
  });
});

// Last in the file: the store leaves the ecosystem, and a membership that left is not re-entered.
describe('a fenced token whose project left the ecosystem', () => {
  it("refuses it once its project is no member, though the token's user reads it through another", async () => {
    await db.execute(sql`
      UPDATE ecosystem_memberships SET state = 'left', ended_at = now(), ended_reason = 'test'
       WHERE ecosystem_id = ${w.eco} AND project_id = ${w.project.store}`);
    const r = await as(
      'store',
      'GET',
      `/api/projects/${w.project.forge}/contracts/forge-api/versions/2026-09-20`,
    );
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    for (const path of [
      `/api/projects/${w.project.forge}/contracts/forge-api/versions/2026-09-20/artifact`,
      `/api/projects/${w.project.forge}/api-page`,
    ]) {
      const left = await as('store', 'GET', path);
      expect(left.status, `${path}: ${JSON.stringify(left.json)}`).toBe(403);
      expect(codeOf(left), path).toBe('FORBIDDEN');
    }
  });
});
