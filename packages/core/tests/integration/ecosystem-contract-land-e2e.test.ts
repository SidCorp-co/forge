import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ChannelWorld,
  changeNotice,
  inDays,
  ok,
  openChannelWorld,
  refusal,
  speaker,
} from '../helpers/channel-world.js';
import { type Doc, forgeInterface, pluginInterface } from '../helpers/ecosystem-world.js';
import { seedProjectDocument } from '../helpers/factories.js';

const BINDING = 'b1d1a7e0-0000-4000-8000-000000000001';
const TOOLS_PATH = 'contracts/forge-tools.json';
const SPEC_PATH = 'contracts/forge-spec.json';

const repo = new Map<string, Map<string, string>>();
const order: string[] = [];
const sent: { data: { measurementIds: string[] } }[] = [];

vi.mock('../../src/queue/boss.js', async (orig) => {
  const real = await orig<typeof import('../../src/queue/boss.js')>();
  const fake = {
    send: async (_q: string, data: { measurementIds: string[] }) => {
      sent.push({ data });
      return 'job';
    },
  };
  return { ...real, boss: fake };
});

const blobSha = (text: string) => {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
};

vi.mock('../../src/integrations/github/client.js', async (orig) => {
  const real = await orig<typeof import('../../src/integrations/github/client.js')>();
  const blobs = new Map<string, string>();
  const fake = {
    bindingId: BINDING,
    appId: '1',
    owner: 'acme',
    repo: 'forge',
    fullName: 'acme/forge',
    async get(path: string) {
      const contents = /\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(path);
      if (contents?.[1] && contents[2]) {
        const text = repo.get(contents[2])?.get(decodeURIComponent(contents[1]));
        if (text === undefined)
          throw new real.GitHubReadError(404, `GET ${path} returned HTTP 404`);
        const sha = blobSha(text);
        blobs.set(sha, text);
        return { type: 'file', sha, size: Buffer.byteLength(text) };
      }
      const blob = /\/git\/blobs\/([0-9a-f]{40})$/.exec(path)?.[1];
      if (blob)
        return {
          encoding: 'base64',
          content: Buffer.from(blobs.get(blob) ?? '').toString('base64'),
        };
      const cmp = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
      if (cmp?.[1] && cmp[2]) {
        const [a, b] = [order.indexOf(cmp[1]), order.indexOf(cmp[2])];
        return { status: a === b ? 'identical' : b < a ? 'behind' : 'ahead' };
      }
      throw new Error(`the fake repository has no answer for ${path}`);
    },
  };
  return { ...real, githubRepoClient: async () => fake };
});

// The lifecycle reads ask the project's source host (ISS-50); this test's host is the faked GitHub
// client above, wrapped as the GitHub host is in production.
vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>();
  const { githubRepoClient } = await import('../../src/integrations/github/client.js');
  const { githubSourceHostOf } = await import('../../src/integrations/github/source-host.js');
  return {
    ...real,
    resolveSourceHost: async (projectId: string) =>
      githubSourceHostOf(await githubRepoClient(projectId), () => {
        throw new Error('no agent verb in this test');
      }),
  };
});

const tools = (names: string[]) =>
  JSON.stringify({
    tools: names.map((name) => ({
      name,
      description: name,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string' } },
      },
    })),
  });

let commits = 0;
function commit(files: Record<string, string>): string {
  commits += 1;
  const sha = createHash('sha1').update(`commit ${commits}`).digest('hex');
  const parent = order.at(-1);
  repo.set(sha, new Map([...(parent ? (repo.get(parent) ?? []) : []), ...Object.entries(files)]));
  order.push(sha);
  return sha;
}

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;
let land: typeof import('../../src/ecosystem/contract/land.js');

async function push(sha: string, branch = 'main'): Promise<number> {
  sent.length = 0;
  const n = await land.observeLand({
    projectId: w.project.forge,
    bindingId: BINDING,
    branch,
    commit: sha,
  });
  for (const job of sent)
    await land.measureLand({
      projectId: w.project.forge,
      bindingId: BINDING,
      measurementIds: job.data.measurementIds,
    });
  return n;
}

async function ledger(sha: string): Promise<Record<string, Doc>> {
  const rows = await w.harness.db.execute<Doc>(sql`
    SELECT contract_slug, outcome, version, reason FROM contract_measurements
    WHERE provider_project_id = ${w.project.forge} AND commit_sha = ${sha}`);
  return Object.fromEntries(rows.map((r) => [r.contract_slug, r]));
}

const forgePath = (rest: string) => `/api/projects/${w.project.forge}/contracts/${rest}`;

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
  land = await import('../../src/ecosystem/contract/land.js');
  await seedProjectDocument(w.harness.db, w.project.forge, w.user.platform, {
    environments: {
      production: { tier: 'production', deploysFrom: 'main', deployment: { mode: 'external' } },
    },
  });
  const iface = forgeInterface(w);
  iface.publishes['forge-tools'] = {
    title: 'Tools',
    type: 'mcp-tools',
    artifact: { path: TOOLS_PATH },
    lifecycle: 'production',
    ecosystems: [w.eco],
  };
  iface.publishes['forge-spec'] = {
    title: 'Spec',
    type: 'openapi',
    artifact: { path: SPEC_PATH },
    lifecycle: 'production',
    ecosystems: [w.eco],
  };
  ok(
    await say('platform', 'PUT', `/api/projects/${w.project.forge}/interface`, {
      baseRevision: 2,
      document: iface,
    }),
  );
}, 120_000);

afterAll(async () => {
  await w.harness.cleanup();
});

const SPEC = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 's', version: '1' },
  paths: { '/api/a': { get: { responses: { default: { description: 'u' } } } } },
});
const ids = { c1: '', c2: '' };
const names: Record<string, string> = {};

describe('a land on a branch an environment deploys from records each changed contract', () => {
  it('records the first artifact of each contract as initial, hashed by core from the bytes at that commit', async () => {
    ids.c1 = commit({ [TOOLS_PATH]: tools(['forge_a', 'forge_b']), [SPEC_PATH]: SPEC });
    expect(await push(ids.c1)).toBe(4);
    const l = await ledger(ids.c1);
    expect(l['forge-api']).toMatchObject({
      outcome: 'refused',
      reason: `packages/core/openapi.json does not exist at ${ids.c1}`,
    });
    expect(l['forge-tools']).toMatchObject({ outcome: 'recorded' });
    expect(l['forge-spec']).toMatchObject({ outcome: 'recorded' });
    names.first = String(l['forge-tools']?.version);
    const v = ok(await say('platform', 'GET', forgePath(`forge-tools/versions/${names.first}`)));
    expect(v.version).toMatchObject({
      contract: 'forge/forge-tools',
      previous: null,
      artifact: {
        sha256: createHash('sha256')
          .update(tools(['forge_a', 'forge_b']))
          .digest('hex'),
        sourceCommit: ids.c1,
      },
      diff: { tool: 'none', classification: 'initial', changes: [] },
    });
    expect(v.elements).toEqual([
      'forge_a',
      'forge_a/properties/id',
      'forge_b',
      'forge_b/properties/id',
    ]);
  });

  it('measures a removed tool as breaking and names the next dated version', async () => {
    ids.c2 = commit({ [TOOLS_PATH]: tools(['forge_a']) });
    await push(ids.c2);
    const l = await ledger(ids.c2);
    expect(l['forge-spec']).toMatchObject({ outcome: 'unchanged', version: null });
    expect(l['forge-tools']?.outcome).toBe('recorded');
    names.second = String(l['forge-tools']?.version);
    expect(names.second).toBe(`${names.first}.1`);
    const v = ok(
      await say('platform', 'GET', forgePath(`forge-tools/versions/${names.second}`)),
    ).version;
    expect(v).toMatchObject({
      previous: names.first,
      diff: { tool: 'json-schema-diff', classification: 'breaking' },
    });
    expect(v.diff.changes).toEqual([
      {
        element: 'forge_b',
        kind: 'removed',
        level: 'breaking',
        text: 'tool forge_b was removed',
        check: 'tool-removed',
      },
    ]);
  });

  it('takes a redelivered push once', async () => {
    expect(await push(ids.c2)).toBe(0);
  });

  it('settles an older commit that arrives late as stale, never as a version that undoes the newer one', async () => {
    const before = ok(await say('platform', 'GET', forgePath('forge-tools/versions'))).versions
      .length;
    await w.harness.db.execute(sql`DELETE FROM contract_measurements WHERE commit_sha = ${ids.c1}`);
    await push(ids.c1);
    expect((await ledger(ids.c1))['forge-tools']).toMatchObject({
      outcome: 'stale',
      reason: expect.stringContaining(`is behind ${ids.c2}`),
    });
    expect(
      ok(await say('platform', 'GET', forgePath('forge-tools/versions'))).versions,
    ).toHaveLength(before);
  });

  it('observes nothing on a branch no environment deploys from', async () => {
    expect(await push(commit({ [TOOLS_PATH]: tools([]) }), 'feature/x')).toBe(0);
    order.pop();
  });

  it('refuses by name a land whose artifact is gone or unreadable, and says so on the ledger', async () => {
    const gone = commit({});
    repo.get(gone)?.delete(TOOLS_PATH);
    await push(gone);
    expect((await ledger(gone))['forge-tools']).toMatchObject({
      outcome: 'refused',
      reason: `${TOOLS_PATH} does not exist at ${gone}`,
    });
    const broken = commit({ [TOOLS_PATH]: '{"tools": [' });
    await push(broken);
    expect((await ledger(broken))['forge-tools']?.reason).toMatch(
      /^ARTIFACT_UNREADABLE: a mcp-tools artifact is JSON/,
    );
  });

  it('refuses an OpenAPI land by name when the pinned oasdiff is absent, and records nothing for it', async () => {
    const was = process.env.OASDIFF_BIN;
    process.env.OASDIFF_BIN = '/nonexistent/oasdiff';
    try {
      const c = commit({
        [TOOLS_PATH]: tools(['forge_a']),
        [SPEC_PATH]: SPEC.replace('/api/a', '/api/b'),
      });
      await push(c);
      expect((await ledger(c))['forge-spec']?.reason).toMatch(
        /^DIFFER_UNAVAILABLE: oasdiff is not at \/nonexistent\/oasdiff/,
      );
    } finally {
      if (was === undefined) delete process.env.OASDIFF_BIN;
      else process.env.OASDIFF_BIN = was;
    }
  });

  it('lists the ledger of lands for the contract, newest first', async () => {
    const m = ok(await say('platform', 'GET', forgePath('forge-tools/measurements'))).measurements;
    expect(m[0]).toMatchObject({ branch: 'main', environments: ['production'] });
    expect(new Set(m.map((r: Doc) => r.outcome))).toEqual(
      new Set(['recorded', 'unchanged', 'stale', 'refused']),
    );
  });
});

describe('a provider declares what the artifact does not show', () => {
  it('records a semantic change with tool none and the provider classification', async () => {
    const r = await say('platform', 'POST', forgePath('forge-tools/versions'), {
      semantic: {
        classification: 'breaking',
        reason: 'forge_a now refuses an id it used to accept.',
        elements: ['forge_a'],
      },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.version).toMatchObject({
      previous: names.second,
      diff: { tool: 'none', classification: 'breaking' },
    });
    names.third = r.json.version.contractVersion;
  });

  it.each([
    [
      'a version smaller than the latest',
      {
        version: '2020-01-01',
        semantic: { classification: 'unknown', reason: 'r', elements: ['forge_a'] },
      },
      'VERSION_BUMP_TOO_SMALL /version',
    ],
    [
      'bytes for a contract core reads from git',
      { artifact: '{}' },
      'ARTIFACT_MEASURED_FROM_GIT /artifact',
    ],
    [
      'a semantic change to a tool the version lacks',
      { semantic: { classification: 'breaking', reason: 'r', elements: ['forge_b'] } },
      'ELEMENT_NOT_IN_CONTRACT /semantic/elements/0',
    ],
  ])('refuses %s', async (_n, body, want) => {
    expect(
      refusal(await say('platform', 'POST', forgePath('forge-tools/versions'), body)),
    ).toContain(want);
  });
});

describe('the channel reads the measured diff of the version a notice cites', () => {
  beforeAll(async () => {
    const p = pluginInterface(w);
    p.consumes.push({
      contract: 'forge/forge-tools',
      ecosystem: w.eco,
      builtAgainst: names.first,
      elements: ['forge_a', 'forge_b'],
    });
    ok(
      await say('plugin', 'PUT', `/api/projects/${w.project.plugin}/interface`, {
        baseRevision: 1,
        document: p,
      }),
    );
  });

  const notice = (over: Doc): Doc => {
    const d = changeNotice(w);
    d.body = { ...d.body, contract: 'forge/forge-tools', contractVersion: names.second, ...over };
    return d;
  };
  const draftRefusals = async (d: Doc) => {
    const made = ok(
      await say('masterForge', 'POST', `/api/projects/${w.project.forge}/channel/drafts`, d),
    );
    return refusal(
      await say(
        'masterForge',
        'POST',
        `/api/projects/${w.project.forge}/channel/documents/${made.id}/submit`,
      ),
    );
  };

  it('refuses a notice that lowers the measured classification (CLASSIFICATION_BELOW_MEASURED)', async () => {
    const d = notice({
      classification: 'non-breaking',
      changes: [{ element: 'forge_b', kind: 'removed', text: 'The tool is gone.' }],
    });
    expect(await draftRefusals(d)).toContain('CLASSIFICATION_BELOW_MEASURED /body/classification');
  });

  it('refuses a notice that leaves out a measured breaking change (MEASURED_CHANGE_OMITTED)', async () => {
    const d = notice({
      changes: [
        { element: 'forge_a', kind: 'changed', text: 'The tool reads its id more strictly.' },
      ],
    });
    expect(await draftRefusals(d)).toContain('MEASURED_CHANGE_OMITTED /body/changes');
  });

  it('refuses a notice naming an element no version of the contract has (ELEMENT_NOT_IN_CONTRACT)', async () => {
    const d = notice({
      changes: [
        { element: 'forge_b', kind: 'removed', text: 'The tool is gone.' },
        { element: 'forge_zz', kind: 'changed', text: 'Changed.' },
      ],
    });
    expect(await draftRefusals(d)).toContain('ELEMENT_NOT_IN_CONTRACT /body/changes/1/element');
  });

  it('publishes the notice that states the measured breaking change, naming the removed tool from the version before', async () => {
    // forge promises 30 days of notice, so a breaking change takes effect no sooner than that after it was recorded
    const d = notice({
      changes: [{ element: 'forge_b', kind: 'removed', text: 'The tool is gone.' }],
      effectiveOn: inDays(31),
    });
    const made = ok(
      await say('masterForge', 'POST', `/api/projects/${w.project.forge}/channel/drafts`, d),
    );
    const res = ok(
      await say(
        'masterForge',
        'POST',
        `/api/projects/${w.project.forge}/channel/documents/${made.id}/submit`,
      ),
    );
    expect(res.document.state).toBe('published');
  });

  it('refuses a consumer declaring a tool its builtAgainst version lacks', async () => {
    const p = pluginInterface(w);
    p.consumes.push({
      contract: 'forge/forge-tools',
      ecosystem: w.eco,
      builtAgainst: names.second,
      elements: ['forge_b'],
    });
    expect(
      refusal(
        await say('plugin', 'PUT', `/api/projects/${w.project.plugin}/interface`, {
          baseRevision: 2,
          document: p,
        }),
      ),
    ).toEqual(['ELEMENT_NOT_IN_CONTRACT /consumes/2/elements/0']);
  });
});
