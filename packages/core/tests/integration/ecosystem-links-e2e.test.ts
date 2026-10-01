import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emittedAccepts } from '../../src/ecosystem/ecosystem.fixture.js';
import {
  type ChannelWorld,
  ok,
  openChannelWorld,
  type Reply,
  refusal,
  speaker,
} from '../helpers/channel-world.js';
import { type Doc, example, refusedByDb } from '../helpers/ecosystem-world.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
}, 120_000);

afterAll(async () => {
  await w.harness.cleanup();
});

const links = () => `/api/projects/${w.project.plugin}/links`;
const runs = () => `/api/projects/${w.project.plugin}/builder-runs`;
const ids: Record<string, string> = {};

function linkDoc(patch: (d: Doc) => void = () => {}): Doc {
  const d = example('forge-plugin.link.json');
  delete d.id;
  delete d.createdAt;
  delete d.updatedAt;
  d.ecosystem = w.eco;
  d.consumer.project = w.project.plugin;
  d.contract.provider = w.project.forge;
  patch(d);
  return d;
}

function runDoc(patch: (d: Doc) => void = () => {}): Doc {
  const d = example('forge-plugin.builder-run.json');
  delete d.id;
  delete d.createdAt;
  delete d.updatedAt;
  d.ecosystem = w.eco;
  d.project = w.project.plugin;
  d.findings[0].contract.provider = w.project.forge;
  d.links = [ids.link];
  patch(d);
  return d;
}

const create = (document: Doc, who: Parameters<typeof say>[0] = 'masterPlugin') =>
  say(who, 'POST', links(), { baseRevision: null, document });

const deniedAs = (r: Reply) => {
  expect(r.status, JSON.stringify(r.json)).toBe(403);
  expect(r.json.details.refusals.map((x: Doc) => x.code)).toEqual([r.json.code]);
  return r.json.code as string;
};

describe("the consumer's master writes a link", () => {
  it('stores revision 1 and answers the link-v1 record', async () => {
    const made = ok(await create(linkDoc()));
    expect(made).toMatchObject({ revision: 1, created: true, writer: w.agent.plugin });
    expect(emittedAccepts(made.document)).toBe(true);
    expect(made.document).toMatchObject({ ...linkDoc(), id: expect.any(String) });
    ids.link = made.document.id;
  });

  it('refuses a person, a viewer and another project’s master by name', async () => {
    expect(deniedAs(await create(linkDoc(), 'plugin'))).toBe('LINK_WRITER_NOT_CONSUMER');
    expect(deniedAs(await create(linkDoc(), 'viewer'))).toBe('LINK_WRITER_NOT_CONSUMER');
    expect(deniedAs(await create(linkDoc(), 'masterForge'))).toBe('LINK_WRITER_NOT_CONSUMER');
  });

  const plants: [string, (d: Doc) => void, string[]][] = [
    [
      'an absolute path',
      (d) => (d.callSites[0].path = '/etc/passwd'),
      ['PATH_OUTSIDE_REPO /callSites/0/path'],
    ],
    [
      'a climbing path',
      (d) => (d.callSites[0].path = 'a/../../b'),
      ['PATH_OUTSIDE_REPO /callSites/0/path'],
    ],
    [
      'an unrecorded pin',
      (d) => (d.pinnedVersion = '2025-01-01'),
      ['VERSION_UNKNOWN /pinnedVersion'],
    ],
    ['a state outside the enum', (d) => (d.state = 'stale'), ['LINK_STATE_UNKNOWN /state']],
    [
      'a guide with no call site',
      (d) => (d.callSites = []),
      ['LINK_GUIDE_WITHOUT_CALL_SITE /callSites'],
    ],
    [
      'the same module and contract again',
      (d) => (d.consumer.module = 'cli/src'),
      ['LINK_DUPLICATE /consumer/module'],
    ],
    [
      'a provider outside the ecosystem',
      (d) => (d.contract.provider = w.project.internal),
      ['LINK_PROVIDER_NOT_MEMBER /contract/provider'],
    ],
    [
      'an ecosystem neither side is in',
      (d) => (d.ecosystem = w.otherEco),
      ['LINK_CONSUMER_NOT_MEMBER /ecosystem', 'LINK_PROVIDER_NOT_MEMBER /contract/provider'],
    ],
    [
      'another consumer',
      (d) => (d.consumer.project = w.project.forge),
      ['PROJECT_ID_IMMUTABLE /consumer/project'],
    ],
  ];

  it.each(plants)('refuses %s by its code and writes nothing', async (_name, patch, codes) => {
    const planted = linkDoc((d) => {
      d.consumer.module = 'cli/plant';
      patch(d);
    });
    expect(refusal(await create(planted))).toEqual(codes);
    expect(ok(await say('plugin', 'GET', links())).returned).toBe(1);
  });

  it('is held by the database too, whatever writes past the service', async () => {
    const insert = (patch: Record<string, string>) => {
      const v = {
        eco: w.eco,
        consumer: w.project.plugin,
        provider: w.project.forge,
        module: 'db/plant',
        version: '2026-09-20',
        state: 'current',
        ...patch,
      };
      return w.harness.db.execute(sql`
        INSERT INTO ecosystem_links (ecosystem_id, consumer_project_id, module_path, provider_project_id,
          contract_slug, pinned_version, state, revision, document, written_by_user)
        VALUES (${v.eco}, ${v.consumer}, ${v.module}, ${v.provider}, 'forge-api', ${v.version},
          ${v.state}, 1, '{}'::jsonb, ${w.agent.plugin})`);
    };
    await refusedByDb(insert({ version: '2025-01-01' }), /ecosystem_links_pinned_version_fk/);
    await refusedByDb(insert({ state: 'stale' }), /ecosystem_links_state_chk/);
    await refusedByDb(
      insert({ provider: w.project.plugin }),
      /ecosystem_links_not_self_chk|pinned_version_fk/,
    );
    await refusedByDb(insert({ module: 'cli/src' }), /ecosystem_links_identity_uq/);
  });
});

describe('the master refreshes its link', () => {
  const put = (baseRevision: number, document: Doc) =>
    say('masterPlugin', 'PUT', `${links()}/${ids.link}`, { baseRevision, document });

  it('moves the pin and state on the same identity', async () => {
    const next = ok(
      await put(
        1,
        linkDoc((d) => Object.assign(d, { state: 'behind', pinnedVersion: '2026-10-01' })),
      ),
    );
    expect(next).toMatchObject({ revision: 2, created: false, document: { state: 'behind' } });
  });

  it('refuses a stale base and a moved identity by name', async () => {
    expect(refusal(await put(1, linkDoc()))).toEqual(['STALE_BASE /baseRevision']);
    expect(
      refusal(
        await put(
          2,
          linkDoc((d) => (d.consumer.module = 'cli/moved')),
        ),
      ),
    ).toEqual(['LINK_IDENTITY_IMMUTABLE /consumer/module']);
  });
});

describe('the read shapes', () => {
  it('reads one link with its guide to the consumer and to the provider, never to a stranger', async () => {
    const mine = ok(await say('plugin', 'GET', `${links()}/${ids.link}`));
    expect(mine).toMatchObject({ revision: 2, currentVersion: '2026-10-01' });
    expect(mine.document.callSites).toEqual(linkDoc().callSites);
    expect(emittedAccepts(mine.document)).toBe(true);
    const provider = ok(await say('platform', 'GET', `${links()}/${ids.link}`));
    expect(provider.document).toEqual(mine.document);
    expect((await say('store', 'GET', `${links()}/${ids.link}`)).status).toBe(403);
  });

  it("puts the link on the ecosystem's bus with its state, pin and the contract's current version", async () => {
    const bus = ok(await say('platform', 'GET', `/api/ecosystems/${w.eco}/bus`));
    expect(bus.ecosystem).toMatchObject({ id: w.eco, slug: 'forge-platform' });
    expect(bus.projects.map((p: Doc) => p.id)).toEqual(
      expect.arrayContaining([w.project.forge, w.project.plugin]),
    );
    expect(bus.contracts).toContainEqual(
      expect.objectContaining({
        provider: w.project.forge,
        slug: 'forge-api',
        currentVersion: '2026-10-01',
      }),
    );
    expect(bus.links).toEqual([
      {
        id: ids.link,
        consumer: w.project.plugin,
        module: 'cli/src',
        contract: { provider: w.project.forge, slug: 'forge-api' },
        state: 'behind',
        pinnedVersion: '2026-10-01',
        outsideContract: linkDoc().outsideContract.length,
        updatedAt: expect.any(String),
      },
    ]);
    expect(bus.projects.find((p: Doc) => p.id === w.project.plugin).builder).toMatchObject({
      trigger: { kind: 'joined' },
      findings: 0,
      links: 0,
    });
    const store = ok(await say('store', 'GET', `/api/ecosystems/${w.eco}/bus`));
    expect(store.links).toEqual([]);
  });
});

describe('the joining project records its builder run', () => {
  const post = (document: Doc, who: Parameters<typeof say>[0] = 'masterPlugin') =>
    say(who, 'POST', runs(), { baseRevision: null, document });

  it('stores the run the join opened with its steps, findings and the links it wrote', async () => {
    const [joined] = ok(await say('plugin', 'GET', runs())).runs;
    ids.run = joined.document.id;
    const made = ok(
      await say('masterPlugin', 'PUT', `${runs()}/${ids.run}`, {
        baseRevision: 1,
        document: runDoc(),
      }),
    );
    expect(emittedAccepts(made.document)).toBe(true);
    expect(made.document).toMatchObject({ links: [ids.link], trigger: { kind: 'joined' } });
    const progressed = ok(
      await say('masterPlugin', 'PUT', `${runs()}/${ids.run}`, {
        baseRevision: 2,
        document: runDoc((d) => (d.steps[2].status = 'succeeded')),
      }),
    );
    expect(progressed.revision).toBe(3);
    const listed = ok(await say('plugin', 'GET', runs()));
    expect(listed.runs.map((r: Doc) => r.document.id)).toEqual([ids.run]);
  });

  it("puts the project's latest run on the bus as step states and counts, never its findings", async () => {
    const bus = ok(await say('platform', 'GET', `/api/ecosystems/${w.eco}/bus`));
    const builder = bus.projects.find((p: Doc) => p.id === w.project.plugin).builder;
    expect(builder).toMatchObject({
      id: ids.run,
      trigger: { kind: 'joined' },
      findings: runDoc().findings.length,
      links: 1,
    });
    expect(builder.steps.map((s: Doc) => s.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);
    expect(JSON.stringify(builder)).not.toContain('api.github.com');
  });

  it('refuses by name what the run cannot claim', async () => {
    const put = (document: Doc) =>
      say('masterPlugin', 'PUT', `${runs()}/${ids.run}`, { baseRevision: 3, document });
    expect(deniedAs(await post(runDoc(), 'plugin'))).toBe('BUILDER_RUN_WRITER_NOT_PROJECT');
    const foreign = runDoc((d) => (d.links = ['00000000-0000-4000-8000-000000000000']));
    expect(refusal(await put(foreign))).toEqual(['BUILDER_RUN_LINK_UNKNOWN /links/0']);
    const unpublished = runDoc((d) => (d.findings[0].contract.slug = 'runner'));
    expect(refusal(await put(unpublished))).toEqual(['REF_NOT_PUBLISHED /findings/0/contract']);
    expect(refusal(await put(runDoc((d) => (d.steps[0].status = 'done'))))).toEqual([
      'STEP_STATUS_UNKNOWN /steps/0/status',
    ]);
    const moved = runDoc((d) => (d.trigger.kind = 'push'));
    expect(
      refusal(
        await say('masterPlugin', 'PUT', `${runs()}/${ids.run}`, {
          baseRevision: 3,
          document: moved,
        }),
      ),
    ).toEqual(['BUILDER_RUN_IMMUTABLE /trigger']);
  });
});
