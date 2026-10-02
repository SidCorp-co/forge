/**
 * ISS-38 — a coding agent reaches the ecosystem channel, the interface and its links on `/mcp`.
 *
 * Every call goes through the `/mcp` transport with the token a master holds, and the box's half is
 * read through the device route its sweep calls. The chat door's own suite
 * (`assistant-channel-e2e`) covers the same tool under a turn token.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ChannelWorld,
  changeRequest,
  decision,
  ok,
  openChannelWorld,
  speaker,
} from '../helpers/channel-world.js';
import { type Doc, example } from '../helpers/ecosystem-world.js';
import { bindTestRunner } from '../helpers/factories.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;
let deviceToken: string;
let cr: string;

type Answer = { isError: boolean; json: Doc; text: string };

async function mcp(
  token: string,
  name: string,
  args: Doc,
  headers: Record<string, string> = {},
): Promise<Answer> {
  const res = await w.app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  expect(res.status).toBe(200);
  const out = (await res.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  const text = out.result.content.map((c) => c.text).join('');
  let json: Doc = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  return { isError: out.result.isError === true, json, text };
}

const channel = (token: string, args: Doc, headers?: Record<string, string>) =>
  mcp(token, 'forge_channel', args, headers);
const ecosystem = (token: string, args: Doc) => mcp(token, 'forge_ecosystem', args);

const done = (r: Answer): Doc => {
  expect(r.isError, r.text).toBe(false);
  return r.json;
};

const refusedAs = (r: Answer): string[] => {
  expect(r.isError, r.text).toBe(true);
  expect(r.json.error, r.text).toBeDefined();
  return (r.json.error?.refusals ?? []).map((x: Doc) => `${x.code} ${x.path}`);
};

async function boxReads(projectId: string | null): Promise<{ status: number; json: Doc }> {
  const query = projectId === null ? '' : `?projectId=${projectId}`;
  const res = await w.app.request(`/api/devices/me/channel/unanswered${query}`, {
    headers: { authorization: `Bearer ${deviceToken}` },
  });
  return { status: res.status, json: (await res.json()) as Doc };
}

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

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
  const { pairDevice } = await import('../helpers/pair-device.js');
  const issued = await pairDevice({
    ownerId: w.user.platform,
    name: 'forge-box',
    platform: 'linux',
  });
  deviceToken = issued.plaintext;
  await bindTestRunner(w.harness.db, { projectId: w.project.forge, deviceId: issued.device.id });
  const id = ok(
    await say('masterPlugin', 'POST', `/api/projects/${w.project.plugin}/channel/drafts`, {
      ...changeRequest(w),
    }),
  ).id;
  cr = ok(
    await say(
      'masterPlugin',
      'POST',
      `/api/projects/${w.project.plugin}/channel/documents/${id}/submit`,
    ),
  ).document.number;
}, 120_000);

afterAll(async () => {
  await w.harness.cleanup();
});

describe('the /mcp door lists the ecosystem tools', () => {
  it('serves forge_channel and forge_ecosystem to a master token', async () => {
    const res = await w.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${w.tokens.masterForge}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const names = (
      (await res.json()) as { result: { tools: Array<{ name: string }> } }
    ).result.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['forge_channel', 'forge_ecosystem']));
  });
});

describe('a published change request is work the master can claim', () => {
  it('reads as unanswered on /mcp and on the device route the sweep calls', async () => {
    const owed = done(
      await channel(w.tokens.masterForge, { action: 'unanswered', projectId: w.project.forge }),
    );
    expect(owed.documents.map((d: Doc) => [d.number, d.type, d.from])).toEqual([
      [cr, 'change-request', w.project.plugin],
    ]);
    const box = await boxReads(w.project.forge);
    expect(box.status).toBe(200);
    expect(box.json).toMatchObject({ projectId: w.project.forge, count: 1 });
    expect(box.json.items.map((d: Doc) => d.number)).toEqual([cr]);
  });

  it('refuses the device route a project its box is not bound to, and a missing project', async () => {
    expect((await boxReads(w.project.plugin)).status).toBe(403);
    expect((await boxReads(null)).status).toBe(400);
  });

  it('owes nothing to the side that sent it', async () => {
    const theirs = done(
      await channel(w.tokens.masterPlugin, { action: 'unanswered', projectId: w.project.plugin }),
    );
    expect(theirs.documents).toEqual([]);
  });
});

describe('the side is named, never guessed', () => {
  it('refuses a call that names no project on an unbound token', async () => {
    expect(refusedAs(await channel(w.tokens.masterForge, { action: 'inbox' }))).toEqual([
      'CHANNEL_PROJECT_UNNAMED /projectId',
    ]);
  });

  it('refuses a projectId that is not a uuid', async () => {
    expect(
      refusedAs(await channel(w.tokens.platformCli, { action: 'inbox', projectId: 'forge' })),
    ).toEqual(['CHANNEL_ARGUMENT_INVALID /projectId']);
  });

  it('refuses a slug header naming a project the token does not reach', async () => {
    expect(
      refusedAs(
        await channel(
          w.tokens.masterForge,
          { action: 'inbox' },
          { 'x-forge-project-slug': 'forge-plugin' },
        ),
      ),
    ).toEqual(['CHANNEL_PROJECT_OUTSIDE_TOKEN /projectId']);
  });

  it('acts for the slug header when the token reaches it', async () => {
    const inbox = done(
      await channel(w.tokens.masterForge, { action: 'inbox' }, { 'x-forge-project-slug': 'forge' }),
    );
    expect(inbox.documents.map((d: Doc) => d.document.number)).toEqual([cr]);
  });

  it('refuses a projectId outside the token at the transport, before the tool runs', async () => {
    const r = await channel(w.tokens.masterForge, { action: 'inbox', projectId: w.project.plugin });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/NOT_FOUND/);
  });
});

describe('the master answers, and the author is the token', () => {
  const reply = () => {
    const { inReplyTo, ecosystem: _e, to: _t, ...rest } = decision(w, cr);
    return { action: 'reply', projectId: w.project.forge, inReplyTo, ...rest };
  };

  it('refuses an author named in the arguments, and writes nothing', async () => {
    for (const key of ['authoredBy', 'author', 'from']) {
      const planted = { ...reply(), [key]: { kind: 'person', id: w.user.platform, via: 'web' } };
      expect(refusedAs(await channel(w.tokens.masterForge, planted))).toEqual([
        `CHANNEL_ARGUMENT_INVALID /${key}`,
      ]);
    }
    const out = done(
      await channel(w.tokens.masterForge, { action: 'outbox', projectId: w.project.forge }),
    );
    expect(out.documents).toEqual([]);
  });

  it('replies and submits as the agent, via master, and the document leaves unanswered', async () => {
    const asMaster = { kind: 'agent', id: w.agent.forge, via: 'master' };
    const draft = done(await channel(w.tokens.masterForge, reply()));
    expect(draft.document).toMatchObject({ state: 'draft', authoredBy: asMaster });
    const sent = done(
      await channel(w.tokens.masterForge, {
        action: 'submit',
        projectId: w.project.forge,
        ref: draft.id,
      }),
    );
    expect(sent.document).toMatchObject({ state: 'published', authoredBy: asMaster });
    expect(sent.events.map((e: Doc) => e.by)).toEqual([asMaster, asMaster, asMaster]);
    const owed = done(
      await channel(w.tokens.masterForge, { action: 'unanswered', projectId: w.project.forge }),
    );
    expect(owed.documents).toEqual([]);
    expect((await boxReads(w.project.forge)).json).toMatchObject({ items: [], count: 0 });
  });
});

describe('forge_ecosystem writes a link through the ISS-37 services', () => {
  const create = (token: string, document: Doc, extra: Doc = {}) =>
    ecosystem(token, {
      action: 'link_create',
      projectId: w.project.plugin,
      baseRevision: null,
      document,
      ...extra,
    });

  it("refuses a person's token by the link rule's own code", async () => {
    expect(refusedAs(await create(w.tokens.platformCli, linkDoc()))).toEqual([
      'LINK_WRITER_NOT_CONSUMER ',
    ]);
  });

  it('refuses a writer named in the arguments, and an envelope missing its document', async () => {
    expect(
      refusedAs(await create(w.tokens.masterPlugin, linkDoc(), { writer: w.user.plugin })),
    ).toEqual(['ECOSYSTEM_ARGUMENT_INVALID /writer']);
    expect(
      refusedAs(
        await ecosystem(w.tokens.masterPlugin, {
          action: 'link_create',
          projectId: w.project.plugin,
          baseRevision: null,
        }),
      ),
    ).toEqual(['ECOSYSTEM_ARGUMENT_INVALID /document']);
  });

  it('refuses a planted path and an unknown state by their link-v1 codes', async () => {
    expect(
      refusedAs(
        await create(
          w.tokens.masterPlugin,
          linkDoc((d) => (d.callSites[0].path = '/etc/passwd')),
        ),
      ),
    ).toEqual(['PATH_OUTSIDE_REPO /callSites/0/path']);
    expect(
      refusedAs(
        await create(
          w.tokens.masterPlugin,
          linkDoc((d) => (d.state = 'stale')),
        ),
      ),
    ).toEqual(['LINK_STATE_UNKNOWN /state']);
  });

  it("stores the consumer master's link, written by the token, and lists it", async () => {
    const made = done(await create(w.tokens.masterPlugin, linkDoc()));
    expect(made).toMatchObject({ revision: 1, created: true, writer: w.agent.plugin });
    const listed = done(
      await ecosystem(w.tokens.masterPlugin, { action: 'links', projectId: w.project.plugin }),
    );
    expect(listed.links.map((l: Doc) => l.document.id)).toEqual([made.document.id]);
    expect(refusedAs(await create(w.tokens.masterPlugin, linkDoc()))).toEqual([
      'LINK_DUPLICATE /consumer/module',
    ]);
  });

  it("takes an interface write from the project's own agent, and says who set its commitments", async () => {
    const held = done(
      await ecosystem(w.tokens.masterForge, { action: 'interface', projectId: w.project.forge }),
    );
    expect(held.declared).toBe(true);
    const written = done(
      await ecosystem(w.tokens.masterForge, {
        action: 'interface_write',
        projectId: w.project.forge,
        baseRevision: held.revision,
        document: held.document,
      }),
    );
    expect(written).toMatchObject({ declared: true, created: false });
    expect(written.commitmentsSetBy).toMatchObject({ agency: 'human' });
    expect(
      refusedAs(
        await ecosystem(w.tokens.masterForge, {
          action: 'interface_write',
          projectId: w.project.forge,
          baseRevision: written.revision,
          document: {
            ...held.document,
            commitments: { ...held.document.commitments, deprecationNoticeDays: 1 },
          },
        }),
      ),
    ).toEqual(['COMMITMENTS_SET_BY_PERSON /commitments']);
  });

  it('refuses an action it does not take, and a projectId on the bus', async () => {
    const unknown = await ecosystem(w.tokens.masterPlugin, { action: 'delete_link' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/forge_ecosystem.*delete_link/);
    const { mintPat } = await import('../../src/auth/pat.js');
    const { PAT_GRANT_EPOCH } = await import('../../src/auth/pat-permissions.js');
    const current = (
      await mintPat({ userId: w.user.platform, name: 'laptop-now', grantEpoch: PAT_GRANT_EPOCH })
    ).plaintext;
    const bus = done(await ecosystem(current, { action: 'bus', ecosystem: w.eco }));
    expect(bus.ecosystem.id).toBe(w.eco);
    expect(
      refusedAs(
        await ecosystem(current, { action: 'bus', ecosystem: w.eco, projectId: w.project.forge }),
      ),
    ).toEqual(['ECOSYSTEM_ARGUMENT_INVALID /projectId']);
  });
});

describe("a provider's own agent publishes its GraphQL contract on /mcp", () => {
  const SDL = `type Query {
  products(first: Int): [Product!]!
  order(id: ID!): Order
}
type Product { id: ID! title: String! }
type Order { id: ID! }`;
  const publish = (token: string, over: Doc = {}) =>
    ecosystem(token, {
      action: 'contract_version_publish',
      projectId: w.project.forge,
      contract: 'shop-graphql',
      version: '2026-10-02',
      kind: 'graphql',
      source: SDL,
      sourceRef: 'schema/shop.graphql@1a2b3c4',
      ...over,
    });

  beforeAll(async () => {
    const held = done(
      await ecosystem(w.tokens.masterForge, { action: 'interface', projectId: w.project.forge }),
    );
    done(
      await ecosystem(w.tokens.masterForge, {
        action: 'interface_write',
        projectId: w.project.forge,
        baseRevision: held.revision,
        document: {
          ...held.document,
          publishes: {
            ...held.document.publishes,
            'shop-graphql': {
              title: 'Shop GraphQL',
              type: 'graphql',
              artifact: { upload: true },
              lifecycle: 'production',
              ecosystems: [w.eco],
            },
          },
        },
      }),
    );
  });

  it("refuses another project's agent by name, even through a token that reaches the project", async () => {
    const { mintPat } = await import('../../src/auth/pat.js');
    const stranger = (await mintPat({ userId: w.agent.plugin, name: 'unfenced' })).plaintext;
    expect(refusedAs(await publish(stranger))).toEqual(['CONTRACT_WRITER_NOT_PROVIDER ']);
    const held = done(
      await ecosystem(w.tokens.masterForge, { action: 'interface', projectId: w.project.forge }),
    );
    expect(
      refusedAs(
        await ecosystem(stranger, {
          action: 'interface_write',
          projectId: w.project.forge,
          baseRevision: held.revision,
          document: held.document,
        }),
      ),
    ).toEqual(['INTERFACE_WRITER_NOT_PROJECT ']);
  });

  it('refuses an unknown kind, a kind the publication is not, and an SDL that does not parse', async () => {
    expect(refusedAs(await publish(w.tokens.masterForge, { kind: 'soap' }))).toEqual([
      'CONTRACT_KIND_UNKNOWN /kind',
    ]);
    expect(refusedAs(await publish(w.tokens.masterForge, { kind: 'mcp-tools' }))).toEqual([
      'CONTRACT_KIND_MISMATCH /kind',
    ]);
    expect(
      refusedAs(await publish(w.tokens.masterForge, { source: 'query { products { id } }' })),
    ).toEqual(['ARTIFACT_UNREADABLE /source']);
    expect(refusedAs(await publish(w.tokens.masterForge, { sourceRef: 'schema.graphql' }))).toEqual(
      ['ECOSYSTEM_ARGUMENT_INVALID /sourceRef'],
    );
    expect(refusedAs(await publish(w.tokens.masterForge, { contract: 'forge-plugin/x' }))).toEqual([
      'CONTRACT_NOT_PUBLISHED /contract',
    ]);
  });

  it('records the version with its operations indexed, and measures the next one against it', async () => {
    const first = done(await publish(w.tokens.masterForge));
    expect(first).toMatchObject({
      recorded: true,
      version: {
        contractVersion: '2026-10-02',
        artifact: { sourceRef: 'schema/shop.graphql@1a2b3c4' },
        diff: { classification: 'initial' },
      },
    });
    const read = ok(
      await say(
        'platform',
        'GET',
        `/api/projects/${w.project.forge}/contracts/shop-graphql/versions/2026-10-02`,
      ),
    );
    expect(read.elements).toEqual(
      expect.arrayContaining(['Query.products', 'Query.products(first)', 'Product.title']),
    );
    expect(
      refusedAs(
        await publish(w.tokens.masterForge, {
          version: '2026-10-01',
          source: `${SDL}\ntype Extra { a: Int }`,
        }),
      ),
    ).toEqual(['VERSION_BUMP_TOO_SMALL /version']);
    const next = done(
      await publish(w.tokens.masterForge, {
        version: '2026-10-03',
        source: SDL.replace('  order(id: ID!): Order\n', ''),
      }),
    );
    expect(next.version.diff.classification).toBe('breaking');
    expect(next.version.diff.changes.map((c: Doc) => c.element)).toContain('Query.order');
  });
});
