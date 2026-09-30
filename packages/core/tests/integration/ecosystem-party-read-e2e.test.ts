import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Doc,
  type EcosystemWorld,
  forgeInterface,
  formEcosystem,
  openWorld,
  pluginInterface,
  recordVersions,
  refusalCodes,
  refusedByDb,
  sender,
} from '../helpers/ecosystem-world.js';

let w: EcosystemWorld;
let send: ReturnType<typeof sender>;

beforeAll(async () => {
  w = await openWorld();
  send = sender(w);
  await formEcosystem(w);
});

afterAll(async () => {
  await w.harness.cleanup();
});

const putInterface = (side: 'forge' | 'plugin', baseRevision: number | null, document: unknown) =>
  send(
    side === 'forge' ? 'platform' : 'plugin',
    'PUT',
    `/api/projects/${w.project[side]}/interface`,
    {
      baseRevision,
      document,
    },
  );

describe('an interface is written against the ecosystem it names', () => {
  it('refuses builtAgainst while no version of the contract is recorded', async () => {
    expect((await putInterface('forge', null, { ...forgeInterface(w), consumes: [] })).status).toBe(
      200,
    );
    const res = await putInterface('plugin', null, pluginInterface(w));
    expect(refusalCodes(res)).toEqual(['VERSION_UNKNOWN', 'VERSION_UNKNOWN']);
  });

  it('writes both sides once the versions are recorded', async () => {
    await recordVersions(w);
    const plugin = await putInterface('plugin', null, pluginInterface(w));
    expect(plugin.status).toBe(200);
    expect(plugin.json).toMatchObject({ declared: true, revision: 1, created: true });
    const forge = await putInterface('forge', 1, forgeInterface(w));
    expect(forge.json).toMatchObject({ revision: 2 });
  });

  const plants: [string, 'forge' | 'plugin', (d: Doc) => Doc][] = [
    [
      'REF_NOT_PUBLISHED',
      'plugin',
      (d) => {
        d.consumes[0].contract = 'forge/runner';
        return d;
      },
    ],
    [
      'SELF_CONSUMPTION',
      'plugin',
      (d) => {
        d.consumes.push({
          contract: 'forge-plugin/driver-skill',
          ecosystem: w.eco,
          builtAgainst: '2026-09-28',
        });
        return d;
      },
    ],
    [
      'ECOSYSTEM_NOT_MEMBER',
      'plugin',
      (d) => {
        d.publishes['driver-skill'].ecosystems = [w.eco, w.otherEco];
        return d;
      },
    ],
    [
      'ECOSYSTEM_NOT_SHARED',
      'plugin',
      (d) => {
        d.consumes[0].ecosystem = w.otherEco;
        return d;
      },
    ],
    [
      'RESPONSE_WINDOW_EXCEEDS_ECOSYSTEM',
      'plugin',
      (d) => {
        d.commitments.responseDays.rfi = 30;
        return d;
      },
    ],
    [
      'REF_UNRESOLVED',
      'plugin',
      (d) => {
        d.consumes[0].contract = 'nobody/forge-api';
        return d;
      },
    ],
    [
      'CONTRACT_TYPE_UNKNOWN',
      'plugin',
      (d) => {
        d.publishes['driver-skill'].type = 'swagger';
        return d;
      },
    ],
    [
      'PROJECT_ID_IMMUTABLE',
      'plugin',
      (d) => {
        d.project = w.project.forge;
        return d;
      },
    ],
    ['UNKNOWN_KEY', 'plugin', (d) => ({ ...d, extra: true })],
    [
      'CONTRACT_IN_USE',
      'forge',
      (d) => {
        delete d.publishes['forge-api'];
        return d;
      },
    ],
  ];

  it.each(plants)('refuses %s through the API, writing nothing', async (code, side, plant) => {
    const base = side === 'forge' ? 2 : 1;
    const doc = side === 'forge' ? forgeInterface(w) : pluginInterface(w);
    const res = await putInterface(side, base, plant(doc));
    expect(res.status).toBe(422);
    expect(refusalCodes(res)).toEqual([code]);
    const who = side === 'forge' ? 'platform' : 'plugin';
    const after = await send(who, 'GET', `/api/projects/${w.project[side]}/interface`);
    expect(after.json.revision).toBe(base);
  });

  it('refuses a stale base', async () => {
    expect(refusalCodes(await putInterface('plugin', null, pluginInterface(w)))).toEqual([
      'STALE_BASE',
    ]);
  });

  it('keeps every interface revision write-once', async () => {
    await refusedByDb(
      w.harness.db.execute(
        sql`UPDATE project_interface_revisions SET revision = 9 WHERE project_id = ${w.project.forge}`,
      ),
      /project_interface_revisions is write-once/,
    );
  });
});

describe('a member of one project reads only what it is a party to', () => {
  const page = (
    who: 'platform' | 'plugin' | 'store' | 'viewer',
    key: keyof EcosystemWorld['project'],
  ) => send(who, 'GET', `/api/projects/${w.project[key]}/api-page`);

  it('shows the counterparty its published surface and nothing private', async () => {
    const res = await page('viewer', 'forge');
    expect(res.status).toBe(200);
    expect(res.json.reader).toMatchObject({ access: 'party' });
    expect(res.json.publishes.map((p: Doc) => p.contract).sort()).toEqual([
      'forge/forge-api',
      'forge/forge-mcp',
    ]);
    const api = res.json.publishes.find((p: Doc) => p.slug === 'forge-api');
    expect(api).toMatchObject({
      lifecycle: 'production',
      artifact: 'repository',
      versions: ['2026-09-20'],
    });
    expect(api.consumers).toEqual([
      expect.objectContaining({
        project: expect.objectContaining({ slug: 'forge-plugin' }),
        builtAgainst: '2026-09-20',
      }),
    ]);
    expect(res.json.commitments).toMatchObject({ versioning: 'dated' });
    const text = JSON.stringify(res.json);
    for (const hidden of ['implementedBy', 'usedBy', 'packages/core/openapi.json', 'elements']) {
      expect(text).not.toContain(hidden);
    }
  });

  it('refuses the counterparty everything else of that project', async () => {
    for (const path of ['interface', 'interface/revisions', 'config', 'issues', 'ecosystems']) {
      const res = await send('viewer', 'GET', `/api/projects/${w.project.forge}/${path}`);
      expect(res.status, path).toBe(403);
    }
  });

  it('refuses the api page of a project in the same org that is no counterparty', async () => {
    expect((await page('viewer', 'internal')).status).toBe(403);
  });

  it('keeps a member that is no counterparty out of sight under counterparties', async () => {
    expect((await page('viewer', 'store')).status).toBe(403);
    expect((await page('store', 'forge')).status).toBe(403);
    const members = await send('viewer', 'GET', `/api/ecosystems/${w.eco}/members`);
    expect(members.json.memberships.map((m: Doc) => m.document.project).sort()).toEqual(
      [w.project.forge, w.project.plugin].sort(),
    );
  });

  it('shows the provider which of its counterparties consumes it', async () => {
    const res = await page('platform', 'plugin');
    expect(res.status).toBe(200);
    expect(res.json.publishes[0].consumers[0].project.slug).toBe('forge');
    expect(res.json.consumes.map((c: Doc) => c.contract).sort()).toEqual([
      'forge/forge-api',
      'forge/forge-mcp',
    ]);
  });

  it('shows every member once the steward sets visibility to all', async () => {
    const current = await send('platform', 'GET', `/api/ecosystems/${w.eco}`);
    const d = current.json.document;
    d.visibility.members = 'all';
    const put = await send('platform', 'PUT', `/api/ecosystems/${w.eco}`, {
      baseRevision: current.json.revision,
      document: d,
    });
    expect(put.status).toBe(200);
    expect((await page('viewer', 'store')).status).toBe(200);
    const members = await send('viewer', 'GET', `/api/ecosystems/${w.eco}/members`);
    expect(members.json.memberships).toHaveLength(3);
    expect((await page('viewer', 'internal')).status).toBe(403);
  });

  it('hides a removed member from a party read', async () => {
    const res = await send('platform', 'POST', `/api/memberships/${w.membership.store}/remove`, {
      reason: 'the store closed',
    });
    expect(res.status).toBe(200);
    expect((await page('viewer', 'store')).status).toBe(403);
  });
});
