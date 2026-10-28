/**
 * A token fenced to its project still reads, read-only, what that project builds against: the
 * contract versions of a provider it consumes, and the bus of an ecosystem it is a member of (FB-320
 * on dev Forge, 2026-10-28). From 2026-10-27 a job pane went out on its project's checkout
 * credential, fenced to that project, and catalog-fe's builder runs were refused
 * PAT_PROJECT_OUTSIDE_FENCE on catalog-api's and adminhub-api's contract versions and
 * PAT_ACCOUNT_ROUTE on their ecosystem's bus. Anything wider stays fenced: another route of the
 * provider, a write, a contract the project does not consume, an ecosystem it is not in, a steward's
 * whole sight, the account's ecosystem list.
 *
 * @direct-test-of packages/core/src/middleware/pat-fence.ts
 */

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
let as: (who: 'plugin' | 'store', method: string, path: string, body?: unknown) => Promise<Reply>;

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
  });
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

  it('reads the bus of the ecosystem its project is a member of', async () => {
    const bus = await as('plugin', 'GET', `/api/ecosystems/${w.eco}/bus`);
    expect(bus.status, JSON.stringify(bus.json)).toBe(200);
  });
});

describe('anything wider stays fenced', () => {
  it('refuses a contract its project does not consume, though the ecosystem offers it', async () => {
    const r = await as(
      'store',
      'GET',
      `/api/projects/${w.project.forge}/contracts/forge-api/versions/2026-09-20`,
    );
    expect(r.status, JSON.stringify(r.json)).toBe(403);
  });

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
