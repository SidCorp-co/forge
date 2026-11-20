/**
 * ISS-1279: a master whose issue owes a part another project builds hands it over through the
 * ecosystem channel, with no person carrying it. adminhub-api's master was refused
 * PAT_PROJECT_OUTSIDE_FENCE writing adminhub-fe's half of ISS-243 (2026-11-17), heard nothing of the
 * channel, and wrote that carrying the note into adminhub-fe was a person's job, its master's or the
 * owner's.
 * Here forge plays the API (it publishes forge/forge-api) and forge-plugin its consumer: the fence
 * refusal names the change request, the master sends it, and the plugin's master reads it as owed.
 *
 * @direct-test-of packages/core/src/middleware/pat-fence.ts
 * @direct-test-of packages/core/src/ecosystem/fence-way.ts
 * @direct-test-of packages/core/src/ecosystem/channel-members.ts
 *
 * ISS-1360 (FB-774) adds the first change request of a fenced master that knows its counterparty
 * only by slug: `to` takes the member's slug, and the channel's members read names who it may address.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  type ChannelWorld,
  ok,
  openChannelWorld,
  type Reply,
  speaker,
} from '../helpers/channel-world.js';
import { closeWorld, settleOutbox } from '../helpers/ecosystem-world.js';
import { bindTestRunner, createTestDevice } from '../helpers/factories.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;
let publish: MockInstance;
let pluginBox = '';

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
  pluginBox = await createTestDevice(w.user.plugin);
  await bindTestRunner(w.project.plugin, pluginBox);
  const { roomManager } = await import('../../src/lib/rooms.js');
  publish = vi.spyOn(roomManager, 'publish');
}, 120_000);

afterAll(async () => {
  publish?.mockRestore();
  await closeWorld();
});

/** The UI half of an API issue, as the API's master tried to file it on the sibling. */
const uiPart = {
  title: 'Paste a column of PO codes into the paycheck search',
  description: 'The API takes many PO codes now; the search box keeps only the first line.',
};

interface FenceWay {
  ecosystem: { id: string; slug: string };
  from: { id: string; slug: string };
  to: { id: string; slug: string };
  contract: string | null;
}

const refusalOf = (r: Reply) => {
  expect([r.status, r.json?.error?.code], JSON.stringify(r.json)).toEqual([
    403,
    'PAT_PROJECT_OUTSIDE_FENCE',
  ]);
  return {
    detail: String(r.json.detail),
    ways: r.json.details.channel as FenceWay[],
  };
};

describe('an API master hands its sibling the UI part through the channel (ISS-1279)', () => {
  let way: FenceWay;
  let number = '';

  it('is refused filing the part on the sibling, and the refusal names the change request to send', async () => {
    const refused = refusalOf(
      await say('masterForge', 'POST', `/api/projects/${w.project.plugin}/issues`, uiPart),
    );
    expect(refused.detail).toMatch(/names project \S+, which it does not reach/);
    expect(refused.detail).toContain(
      'forge and forge-plugin are counterparties in ecosystem forge-platform',
    );
    expect(refused.detail).toContain(`POST /api/projects/${w.project.forge}/channel/drafts`);
    expect(refused.detail).toContain('"type": "change-request"');
    expect(refused.detail).toContain(`"to": ["${w.project.plugin}"]`);
    expect(refused.detail).toContain(
      `POST /api/projects/${w.project.forge}/channel/documents/<the draft's id>/submit`,
    );
    expect(refused.ways).toEqual([
      {
        ecosystem: { id: w.eco, slug: 'forge-platform' },
        from: { id: w.project.forge, slug: 'forge' },
        to: { id: w.project.plugin, slug: 'forge-plugin' },
        contract: 'forge/forge-api',
      },
    ]);
    way = refused.ways[0] as FenceWay;
  });

  // a master refused filing feedback on another project learnt of the handoff door only from its guide
  it('is refused filing a finding as feedback on the sibling, and the refusal names the handoff door', async () => {
    const refused = refusalOf(
      await say('masterForge', 'POST', `/api/projects/${w.project.plugin}/feedback`, {
        kind: 'bug',
        title: uiPart.title,
        body: uiPart.description,
      }),
    );
    expect(refused.detail).toContain(`POST /api/projects/${w.project.forge}/channel/handoffs`);
    expect(refused.detail).toContain(`"to": "${w.project.plugin}"`);
  });

  it('sends the change request the refusal named, published with no person approving it', async () => {
    await settleOutbox();
    publish.mockClear();
    const own = `/api/projects/${way.from.id}/channel`;
    const draft = ok(
      await say('masterForge', 'POST', `${own}/drafts`, {
        ecosystem: way.ecosystem.id,
        type: 'change-request',
        to: [way.to.id],
        subject: 'Let the paycheck search take a pasted column of PO codes',
        body: {
          contract: way.contract,
          need: 'The search box keeps every pasted line as one PO code, and sends them all.',
          rationale: 'Finance pastes a whole column of codes from a spreadsheet.',
          impactIfDeclined: 'Only the first pasted code is searched, and the rest are lost.',
          urgency: 'normal',
        },
      }),
    );
    expect(draft.document.authoredBy).toMatchObject({ kind: 'agent', via: 'master' });
    const sent = ok(await say('masterForge', 'POST', `${own}/documents/${draft.id}/submit`));
    expect(sent.document).toMatchObject({ type: 'change-request', state: 'published' });
    number = sent.document.number;
    expect(number).toMatch(/^FP-CR-\d+$/);
  });

  it("arrives in the sibling's inbox as owed, wakes its master, and its master's read names it", async () => {
    const owed = ok(
      await say('masterPlugin', 'GET', `/api/projects/${w.project.plugin}/channel/unanswered`),
    );
    expect(JSON.stringify(owed)).toContain(number);
    await settleOutbox();
    const wakes = publish.mock.calls
      .map(([room, envelope]) => ({ room, ...(envelope as { event: string; data: unknown }) }))
      .filter((e) => e.event === 'master.wake');
    expect(wakes).toContainEqual({
      room: `device:${pluginBox}`,
      event: 'master.wake',
      data: { projectId: w.project.plugin, source: 'channel' },
    });
    const { readMasterWork } = await import('../../src/masters/owed.js');
    const read = await readMasterWork(pluginBox, w.project.plugin);
    expect(read.work.owedLine).toContain(`The ecosystem channel owes 1 reply (${number})`);
  });
});

describe('where no channel carries a document, the refusal says so and who links them', () => {
  const unlinked = (ref: string) =>
    `No ecosystem channel carries a document from forge to project ${ref}: `;

  it('names the steward who invites a project with no ecosystem shared', async () => {
    const refused = refusalOf(
      await say('masterForge', 'POST', `/api/projects/${w.project.internal}/issues`, uiPart),
    );
    expect(refused.ways).toEqual([]);
    expect(refused.detail).toContain(unlinked(w.project.internal));
    expect(refused.detail).toContain(`for forge-platform, ${w.eco})`);
    expect(refused.detail).toContain('`POST /api/ecosystems/<ecosystem>/invitations`');
    expect(refused.detail).toContain('`POST /api/memberships/<membership>/accept`');
  });

  it('reads the same for a member it is not shown, and for a project that does not exist', async () => {
    const said = async (projectId: string) =>
      refusalOf(await say('masterForge', 'POST', `/api/projects/${projectId}/issues`, uiPart));
    const hidden = await said(w.project.store);
    const none = randomUUID();
    const absent = await said(none);
    expect(hidden.ways).toEqual([]);
    expect(absent.ways).toEqual([]);
    expect(hidden.detail.replaceAll(w.project.store, '<p>')).toBe(
      absent.detail.replaceAll(none, '<p>'),
    );
  });
});

/**
 * ISS-1360 (FB-774): epod's master, fenced to its own project, could not address its first change
 * request to sid-desk: `to` took only a uuid, and no door it reached named its ecosystem's members.
 */
describe('a fenced master addresses its first change request by the member’s slug (ISS-1360)', () => {
  const own = () => `/api/projects/${w.project.forge}/channel`;
  const request = (to: string[]) => ({
    ecosystem: w.eco,
    type: 'change-request',
    to,
    subject: 'Let the form webhook carry signed file links',
    body: {
      contract: 'forge/forge-api',
      need: 'The form webhook carries a signed link to each uploaded file.',
      rationale: 'The receiver cannot read a file the webhook only names.',
      impactIfDeclined: 'Each upload is fetched again by hand.',
      urgency: 'normal',
    },
  });
  const mcp = async (args: Record<string, unknown>) => {
    const res = await w.app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${w.tokens.masterForge}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'forge_channel', arguments: { projectId: w.project.forge, ...args } },
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    const text = body.result?.content?.map((c) => c.text ?? '').join('') ?? '';
    return { isError: body.result?.isError ?? false, text, json: JSON.parse(text || 'null') };
  };
  const pluginName = async () => {
    const { db } = await import('../../src/db/client.js');
    const { sql } = await import('drizzle-orm');
    const rows = (await db.execute(
      sql`SELECT name FROM projects WHERE id = ${w.project.plugin}`,
    )) as unknown as { name: string }[];
    return String(rows[0]?.name);
  };

  it('reads its ecosystem’s members, id, slug and name only, on the channel’s route and tool', async () => {
    const expected = {
      project: w.project.forge,
      ecosystems: [
        {
          ecosystem: { id: w.eco, slug: 'forge-platform' },
          members: [{ id: w.project.plugin, slug: 'forge-plugin', name: await pluginName() }],
        },
      ],
    };
    expect(ok(await say('masterForge', 'GET', `${own()}/members`))).toEqual(expected);
    const tool = await mcp({ action: 'members' });
    expect(tool.isError, tool.text).toBe(false);
    expect(tool.json).toEqual(expected);
    const outside = await say(
      'masterForge',
      'GET',
      `/api/projects/${w.project.plugin}/channel/members`,
    );
    expect(outside.json?.error?.code, JSON.stringify(outside.json)).toBe(
      'PAT_PROJECT_OUTSIDE_FENCE',
    );
  });

  it('drafts to a member by its slug, on the tool and the route, and the draft holds its uuid', async () => {
    const tool = await mcp({ action: 'draft', ...request(['forge-plugin']) });
    expect(tool.isError, tool.text).toBe(false);
    expect(tool.json.document.to).toEqual([w.project.plugin]);
    const rest = ok(await say('masterForge', 'POST', `${own()}/drafts`, request(['forge-plugin'])));
    expect(rest.document.to).toEqual([w.project.plugin]);
  });

  it('refuses a slug or uuid naming no member it is shown, listing the members it may address', async () => {
    for (const to of ['sid-desk', 'store-x', 'forge-internal', randomUUID()]) {
      const r = await say('masterForge', 'POST', `${own()}/drafts`, request([to]));
      expect(r.status, JSON.stringify(r.json)).toBe(422);
      const [refusal] = r.json.error.refusals as { code: string; path: string; detail: string }[];
      expect([refusal?.code, refusal?.path], to).toEqual(['CHANNEL_TO_NOT_MEMBER', '/to/0']);
      expect(refusal?.detail).toContain(`forge-plugin (${await pluginName()})`);
      expect(refusal?.detail).not.toContain(w.project.store);
      expect(refusal?.detail).not.toMatch(/store-x \(|forge-internal \(/);
    }
    const tool = await mcp({ action: 'draft', ...request(['sid-desk']) });
    expect(tool.isError, tool.text).toBe(true);
    expect(tool.text).toContain('CHANNEL_TO_NOT_MEMBER');
    expect(tool.text).toContain('forge-plugin');
  });
});
