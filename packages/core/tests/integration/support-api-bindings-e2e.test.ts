import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and each support API's credential are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { SupportWorld } from '../helpers/support-world.js';

// ISS-1011 (FB-519): one Agenfold key reads one workspace, so a project reaching two workspaces binds
// two support APIs, each with its own key. The support door served the first binding and dropped the
// others in silence. Here a project binds the world's catalog API and two workspaces, each a stub
// server that answers its own key and refuses the other's: every tool is listed with its binding,
// each call reaches its own workspace with its own key, and a tool name two bindings would share is
// refused at the write.

const w = new SupportWorld();

/** A workspace's API: it answers its own key, and refuses any other with 401. */
class Workspace {
  base = '';
  readonly calls: { url: string; key: string | undefined }[] = [];
  private server!: Server;
  constructor(
    readonly name: string,
    readonly key: string,
  ) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const key = req.headers['x-api-key'] as string | undefined;
      this.calls.push({ url: req.url ?? '', key });
      res.writeHead(key === this.key ? 200 : 401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          key === this.key
            ? { workspace: this.name, machines: [`${this.name}-m1`] }
            : { error: `not a key of workspace ${this.name}` },
        ),
      );
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const moc = new Workspace('moc', 'agf_moc_key_0123456789');
const sidcorp = new Workspace('sidcorp', 'agf_sidcorp_key_9876543210');

const machinesTool = (name: string) => ({
  name,
  kind: 'diagnose',
  method: 'GET',
  path: '/machines',
  summary: `list the machines (${name})`,
});

/** Connect a support API and bind it to the world's project under `label`, as a project admin does. */
function connect(
  displayName: string,
  ws: Workspace,
  targets: { label: string; tools: Record<string, unknown>[] }[],
) {
  return api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'support-api',
    displayName,
    config: { baseUrl: ws.base },
    secrets: { headers: { 'X-Api-Key': ws.key } },
    bindings: targets.map((t) => ({
      projectId: w.projectId,
      role: 'service',
      target: { provider: 'support-api', label: t.label, tools: t.tools },
    })),
  });
}

async function bindingOf(label: string): Promise<string> {
  const [b] = await rows<{ id: string }>(sql`
    SELECT id FROM integration_bindings
     WHERE project_id = ${w.projectId}::uuid AND provider = 'support-api' AND label = ${label}`);
  if (!b) throw new Error(`no support-api binding labelled "${label}"`);
  return b.id;
}

let mocId = '';
let sidcorpId = '';

beforeAll(async () => {
  await w.start();
  await moc.start();
  await sidcorp.start();
}, 120_000);

afterAll(async () => {
  await moc.close();
  await sidcorp.close();
  await w.stop();
});

describe('ISS-1011: a project binds one support API per workspace', () => {
  it('binds two more support APIs beside the first, each under its own label', async () => {
    await w.bind();
    await w.untilWarm();
    const a = await connect('Agenfold Moc', moc, [
      { label: 'moc', tools: [machinesTool('machines_moc')] },
    ]);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await connect('Agenfold SidCorp', sidcorp, [
      { label: 'sidcorp', tools: [machinesTool('machines_sidcorp')] },
    ]);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    mocId = await bindingOf('moc');
    sidcorpId = await bindingOf('sidcorp');
    await w.settleWarm();
  });

  it('lists every tool of every binding to the session and the read view, each with its binding (criterion 1)', async () => {
    let listed: Record<string, unknown> | null = null;
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge') continue;
        listed = await act({ action: 'tools' });
        await act({ action: 'reply', thread: m.thread, text: 'I can read both workspaces.' });
      }
    };
    await w.chat.say(w.chat.alice, 'Which workspaces can you read?');
    await expect.poll(() => listed, { timeout: 15_000 }).not.toBeNull();
    const tools = Object.values(listed as unknown as Record<string, unknown>).filter(
      (v): v is { name: string; binding: string } =>
        typeof v === 'object' && v !== null && 'binding' in v,
    );
    expect(tools.map((t) => [t.name, t.binding])).toEqual([
      ['order_status', 'Catalog API'],
      ['follow_elsewhere', 'Catalog API'],
      ['resend_invoice', 'Catalog API'],
      ['machines_moc', 'moc'],
      ['machines_sidcorp', 'sidcorp'],
    ]);
    expect(JSON.stringify(listed)).not.toContain(moc.key);
    // the tool's path under the base URL stays in core, as it did with one binding
    expect(tools.filter((t) => 'path' in t)).toEqual([]);

    const [room] = await w.rooms();
    expect(room?.supportApis).toEqual([
      expect.objectContaining({ name: 'Catalog API', fault: null }),
      {
        bindingId: mocId,
        name: 'moc',
        tools: [{ name: 'machines_moc', kind: 'diagnose' }],
        fault: null,
      },
      {
        bindingId: sidcorpId,
        name: 'sidcorp',
        tools: [{ name: 'machines_sidcorp', kind: 'diagnose' }],
        fault: null,
      },
    ]);
    await w.settleWarm();
    // the resident session was told the tools the new bindings grant, each on its workspace
    const told = w.box.turns.filter((t) =>
      t.text.includes('- machines_sidcorp (diagnose) on sidcorp:'),
    );
    expect(told.length).toBeGreaterThan(0);
    expect(told.at(-1)?.text).toContain('- machines_moc (diagnose) on moc:');
  });

  it("calls each tool on its own workspace with its own key, never the other's (criterion 2)", async () => {
    const ran: Record<string, unknown>[] = [];
    w.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from === 'forge') continue;
        for (const tool of ['machines_moc', 'machines_sidcorp']) {
          ran.push(await act({ action: 'run', thread: m.thread, tool, args: {} }));
        }
        await act({ action: 'reply', thread: m.thread, text: 'Both workspaces have one machine.' });
      }
    };
    await w.chat.say(w.chat.alice, 'Do both workspaces use a machine?');
    await expect.poll(() => ran.length, { timeout: 15_000 }).toBe(2);
    expect(ran[0], JSON.stringify(ran[0])).toMatchObject({
      status: 200,
      body: { workspace: 'moc' },
    });
    expect(ran[1], JSON.stringify(ran[1])).toMatchObject({
      status: 200,
      body: { workspace: 'sidcorp' },
    });
    expect(moc.calls).toEqual([{ url: '/api/machines', key: moc.key }]);
    expect(sidcorp.calls).toEqual([{ url: '/api/machines', key: sidcorp.key }]);
    expect(w.product.calls.filter((c) => c.url.includes('machines'))).toEqual([]);
    for (const line of await w.chat.botLines()) {
      expect(line.text).not.toContain(moc.key);
      expect(line.text).not.toContain(sidcorp.key);
    }
    await w.settleWarm();
  });
});

describe('ISS-1011: a tool name calls one API (criterion 3)', () => {
  const taken = (out: { body: Record<string, unknown> }) =>
    (
      ((out.body.error as { refusals?: unknown[] } | undefined)?.refusals ?? []) as {
        code: string;
        path: string;
        detail: string;
      }[]
    ).filter((r) => r.code === 'SUPPORT_TOOL_NAME_TAKEN');

  it('refuses a new binding granting a name another binding grants, naming the tool and both bindings', async () => {
    const out = await connect('Agenfold Dup', sidcorp, [
      { label: 'dup', tools: [machinesTool('machines_moc')] },
    ]);
    expect(out.status, JSON.stringify(out.body)).toBe(422);
    const [refusal] = taken(out);
    expect(refusal?.detail).toContain('"machines_moc"');
    expect(refusal?.detail).toContain(`binding ${mocId} (moc)`);
    expect(refusal?.detail).toContain('(dup)');
    // a refused bind leaves no connection and no binding behind
    const [left] = await rows<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM integration_connections WHERE display_name = 'Agenfold Dup'`);
    expect(left?.n).toBe(0);
    await expect(bindingOf('dup')).rejects.toThrow('no support-api binding');
  });

  it("refuses a binding document that takes another binding's name, through the binding door", async () => {
    const path = `/api/projects/${w.projectId}/bindings/${sidcorpId}`;
    const got = await api(w.owner, 'GET', path);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    const document = got.body.document as { target: { tools: unknown[] } };
    const out = await api(w.owner, 'PUT', path, {
      baseRevision: got.body.revision,
      document: {
        ...document,
        target: {
          ...document.target,
          tools: [...document.target.tools, machinesTool('order_status')],
        },
      },
    });
    expect(out.status, JSON.stringify(out.body)).toBe(422);
    const [refusal] = taken(out);
    expect(refusal).toMatchObject({ path: '/target/tools/1/name' });
    expect(refusal?.detail).toContain('"order_status"');
    expect(refusal?.detail).toContain(`binding ${await bindingOf('')} (Catalog API)`);
    expect(refusal?.detail).toContain(`binding ${sidcorpId} (sidcorp)`);

    // a name no other binding grants is accepted
    const unique = await api(w.owner, 'PUT', path, {
      baseRevision: got.body.revision,
      document: {
        ...document,
        target: {
          ...document.target,
          tools: [...document.target.tools, machinesTool('jobs_sidcorp')],
        },
      },
    });
    expect(unique.status, JSON.stringify(unique.body)).toBe(200);
    await w.settleWarm();
  });

  it('refuses two bindings of one write that share a name, naming each to the other', async () => {
    const out = await connect('Agenfold Pair', moc, [
      { label: 'pair-a', tools: [machinesTool('machines_shared')] },
      { label: 'pair-b', tools: [machinesTool('machines_shared')] },
    ]);
    expect(out.status, JSON.stringify(out.body)).toBe(422);
    const refused = taken(out);
    expect(refused).toHaveLength(2);
    expect(refused[0]?.detail).toContain('(pair-b)');
    expect(refused[1]?.detail).toContain('(pair-a)');
  });
});

describe('ISS-1011: a stored binding that no longer parses', () => {
  it('throws by name, and the read view shows its fault beside the bindings that still serve', async () => {
    await db.execute(sql`
      UPDATE integration_bindings SET config = jsonb_set(config, '{tools}', '[]'::jsonb)
       WHERE id = ${sidcorpId}::uuid`);
    const { supportApisOf } = await import('../../src/integrations/support-api/index.js');
    await expect(supportApisOf(w.projectId)).rejects.toThrow(`binding ${sidcorpId} (sidcorp)`);
    const [room] = await w.rooms();
    const apis = room?.supportApis as { name: string; fault: string | null }[];
    expect(apis.map((a) => [a.name, a.fault === null])).toEqual([
      ['Catalog API', true],
      ['moc', true],
      ['sidcorp', false],
    ]);
  });
});
