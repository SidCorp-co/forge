import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  example,
  formEcosystem,
  ok,
  openWorld,
  type Reply,
  seedContractVersion,
  sender,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';

let w: EcosystemWorld;
let say: ReturnType<typeof sender>;
let link = '';

const adopt = () => `/api/projects/${w.project.plugin}/interface/adopt`;
const refusedAt = (r: Reply): string[] => {
  expect(r.status, JSON.stringify(r.json)).toBe(422);
  return (r.json.error?.refusals ?? []).map((x: Doc) => `${x.code} ${x.path}`);
};

async function pins(): Promise<{ builtAgainst: string; link: string; revision: number }> {
  const iface = ok(await say('plugin', 'GET', `/api/projects/${w.project.plugin}/interface`));
  const api = iface.document.consumes.find((c: Doc) => c.contract === 'forge/forge-api');
  const held = ok(await say('plugin', 'GET', `/api/projects/${w.project.plugin}/links/${link}`));
  return {
    builtAgainst: api.builtAgainst,
    link: held.document.pinnedVersion,
    revision: iface.revision,
  };
}

/** The operations the plugin's interface says it consumes: every indexed version must hold them. */
const OPS = [
  'GET /api/issues/{id}',
  'POST /api/issues/{id}/phase',
  'POST /api/devices/me/run-sessions',
];

const elementsOf = (version: string, fields: string[]) => {
  const elements = [...OPS, ...fields];
  return db.execute(sql`
    UPDATE contract_versions SET elements = ${`{${elements.map((e) => `"${e}"`).join(',')}}`}::text[]
    WHERE provider_project_id = ${w.project.forge} AND contract_slug = 'forge-api' AND version = ${version}
  `);
};

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
  const measured = { providerId: w.project.forge, ref: 'forge/forge-api' };
  await seedContractVersion({
    ...measured,
    version: '2026-10-01',
    previous: '2026-09-20',
    classification: 'non-breaking',
  });
  await seedContractVersion({
    ...measured,
    version: '2026-10-10',
    previous: '2026-10-01',
    classification: 'non-breaking',
    approval: 'proposed',
  });
  await seedContractVersion({
    ...measured,
    version: '2026-10-20',
    previous: '2026-10-01',
    classification: 'unknown',
  });
  await seedContractVersion({
    providerId: w.project.forge,
    ref: 'forge/forge-mcp',
    version: '2026-10-05',
    previous: '2026-09-20',
    classification: 'breaking',
    type: 'mcp-tools',
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('adopt refuses by name, and moves nothing', () => {
  it('refuses a viewer by the permission it lacks', async () => {
    const res = await say('viewer', 'POST', adopt(), {
      contract: 'forge/forge-api',
      version: '2026-10-01',
    });
    expect([res.status, res.json.error.code]).toEqual([403, 'PERMISSION_FORBIDDEN']);
    expect(await pins()).toEqual({ builtAgainst: '2026-09-20', link: '2026-09-20', revision: 1 });
  });

  const plants: [string, Doc, string[]][] = [
    [
      'a contract the interface does not consume',
      { contract: 'forge-plugin/driver-skill', version: '2026-09-28' },
      ['ADOPT_CONTRACT_NOT_CONSUMED /contract'],
    ],
    [
      'a version not yet approved',
      { contract: 'forge/forge-api', version: '2026-10-10' },
      ['CONTRACT_VERSION_NOT_APPROVED /version'],
    ],
    [
      'a version never recorded',
      { contract: 'forge/forge-api', version: '2026-12-31' },
      ['VERSION_UNKNOWN /version'],
    ],
    [
      'a breaking step',
      { contract: 'forge/forge-mcp', version: '2026-10-05' },
      ['ADOPT_VERSION_BREAKING /version'],
    ],
    [
      'a step no differ measured as additive',
      { contract: 'forge/forge-api', version: '2026-10-20' },
      ['ADOPT_VERSION_UNMEASURED /version'],
    ],
  ];

  it.each(plants)('refuses %s', async (_name, body, want) => {
    expect(refusedAt(await say('plugin', 'POST', adopt(), body))).toEqual(want);
    expect(await pins()).toEqual({ builtAgainst: '2026-09-20', link: '2026-09-20', revision: 1 });
  });

  it('refuses a version that drops a field a link reads, at that link', async () => {
    await elementsOf('2026-09-20', ['issue.status', 'issue.key']);
    await elementsOf('2026-10-01', ['issue.key']);
    expect(
      refusedAt(
        await say('plugin', 'POST', adopt(), {
          contract: 'forge/forge-api',
          version: '2026-10-01',
        }),
      ),
    ).toEqual([`ADOPT_FIELD_MISSING /links/${link}/fieldsUsed`]);
    expect(await pins()).toEqual({ builtAgainst: '2026-09-20', link: '2026-09-20', revision: 1 });
  });
});

describe('adopt moves the consumption and every link in one act', () => {
  it('moves builtAgainst and the link pin to the additive version', async () => {
    await elementsOf('2026-10-01', ['issue.status', 'issue.key']);
    const res = ok(
      await say('plugin', 'POST', adopt(), { contract: 'forge/forge-api', version: '2026-10-01' }),
    );
    expect(res).toMatchObject({
      adopted: { contract: 'forge/forge-api', version: '2026-10-01' },
      moved: {
        consumptions: [{ index: 0, from: '2026-09-20' }],
        links: [{ id: link, module: 'cli/src', from: '2026-09-20' }],
      },
      staleRequirements: [],
    });
    expect(await pins()).toEqual({ builtAgainst: '2026-10-01', link: '2026-10-01', revision: 2 });
  });

  it('refuses a step back behind the pin it now holds', async () => {
    expect(
      refusedAt(
        await say('plugin', 'POST', adopt(), {
          contract: 'forge/forge-api',
          version: '2026-09-20',
        }),
      ),
    ).toEqual([
      'ADOPT_VERSION_BEHIND_PIN /consumes/0/builtAgainst',
      `ADOPT_VERSION_BEHIND_PIN /links/${link}/pinnedVersion`,
    ]);
  });

  it('writes nothing new for the version it already holds', async () => {
    const res = ok(
      await say('plugin', 'POST', adopt(), { contract: 'forge/forge-api', version: '2026-10-01' }),
    );
    expect(res.moved).toEqual({ consumptions: [], links: [] });
    expect(await pins()).toEqual({ builtAgainst: '2026-10-01', link: '2026-10-01', revision: 2 });
  });
});
