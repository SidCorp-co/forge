import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type EcosystemWorld,
  ecosystemDoc,
  openWorld,
  refusalCodes,
  refusedByDb,
  sender,
  writeInterfaces,
} from '../helpers/ecosystem-world.js';

let w: EcosystemWorld;
let send: ReturnType<typeof sender>;

beforeAll(async () => {
  w = await openWorld();
  send = sender(w);
});

afterAll(async () => {
  await w.harness.cleanup();
});

const create = (who: 'platform' | 'plugin' | 'store', document: unknown) =>
  send(who, 'POST', '/api/ecosystems', { baseRevision: null, document });

describe('a steward org creates an ecosystem', () => {
  it('assigns the id and stores revision 1', async () => {
    const res = await create('platform', ecosystemDoc(w.org.platform, 'forge-platform', 'FP'));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ revision: 1, created: true });
    w.eco = res.json.id;
    expect(res.json.document.ecosystem.id).toBe(w.eco);
  });

  it('refuses a document that names its own id', async () => {
    const d = ecosystemDoc(w.org.platform, 'other', 'OT');
    d.ecosystem.id = '5c1f0a3e-7b2d-4e8a-9f10-2a3b4c5d6e70';
    const res = await create('platform', d);
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe('ECOSYSTEM_ID_IMMUTABLE');
  });

  it('refuses a person who is not an admin of the steward org', async () => {
    const res = await create('plugin', ecosystemDoc(w.org.platform, 'hijack', 'HJ'));
    expect(res.status).toBe(403);
  });

  it('refuses a slug and a channel code another ecosystem holds', async () => {
    const slug = await create('platform', ecosystemDoc(w.org.platform, 'forge-platform', 'ZZ'));
    expect(refusalCodes(slug)).toEqual(['ECOSYSTEM_SLUG_TAKEN']);
    const code = await create('platform', ecosystemDoc(w.org.platform, 'fresh', 'FP'));
    expect(refusalCodes(code)).toEqual(['CHANNEL_CODE_TAKEN']);
  });

  it('refuses an unknown key by name', async () => {
    const res = await create('platform', {
      ...ecosystemDoc(w.org.platform, 'x', 'XX'),
      members: [],
    });
    expect(refusalCodes(res)).toEqual(['UNKNOWN_KEY']);
  });

  it('lets a second org steward its own ecosystem', async () => {
    const res = await create('store', ecosystemDoc(w.org.store, 'storefronts', 'EPS'));
    expect(res.status).toBe(200);
    w.otherEco = res.json.id;
  });
});

describe('membership needs both sides, across two orgs', () => {
  const invite = (who: 'platform' | 'plugin', project: string) =>
    send(who, 'POST', `/api/ecosystems/${w.eco}/invitations`, { project });
  const move = (who: 'platform' | 'plugin' | 'store' | 'viewer', id: string, verb: string) =>
    send(who, 'POST', `/api/memberships/${id}/${verb}`);

  it('lets the steward invite projects of other orgs', async () => {
    for (const key of ['forge', 'plugin', 'store'] as const) {
      const res = await invite('platform', w.project[key]);
      expect(res.status).toBe(200);
      expect(res.json.document).toMatchObject({ state: 'invited', project: w.project[key] });
      w.membership[key] = res.json.id;
    }
  });

  it('refuses an invitation from outside the steward org', async () => {
    expect((await invite('plugin', w.project.internal)).status).toBe(403);
  });

  it('refuses a second open invitation, and one to a project that does not exist', async () => {
    expect(refusalCodes(await invite('platform', w.project.plugin))).toEqual(['MEMBERSHIP_EXISTS']);
    const ghost = await invite('platform', '00000000-0000-4000-8000-000000000000');
    expect(refusalCodes(ghost)).toEqual(['REF_UNRESOLVED']);
  });

  it('shows the invitation to the invited project, and the ecosystem it is for', async () => {
    const mine = await send('plugin', 'GET', `/api/projects/${w.project.plugin}/ecosystems`);
    expect(mine.json.memberships).toHaveLength(1);
    expect(mine.json.memberships[0]).toMatchObject({
      id: w.membership.plugin,
      document: { state: 'invited' },
      ecosystem: { slug: 'forge-platform', channel: 'FP' },
    });
    expect((await send('plugin', 'GET', `/api/ecosystems/${w.eco}`)).status).toBe(200);
  });

  it('lets only an admin of the invited project accept', async () => {
    const id = w.membership.plugin ?? '';
    expect((await move('platform', id, 'accept')).status).toBe(403);
    expect((await move('viewer', id, 'accept')).status).toBe(403);
    w.head.mockRejectedValueOnce(new Error('this project has no active source host binding'));
    const blind = await move('plugin', id, 'accept');
    expect(refusalCodes(blind)).toEqual(['BUILDER_RUN_HEAD_UNREADABLE']);
    const still = await send('plugin', 'GET', `/api/memberships/${id}`);
    expect(still.json.document).toMatchObject({ state: 'invited' });
    const res = await move('plugin', id, 'accept');
    expect(res.status).toBe(200);
    expect(res.json.document).toMatchObject({ state: 'active', decidedBy: w.user.plugin });
  });

  it('refuses a transition the lifecycle does not have', async () => {
    const res = await move('plugin', w.membership.plugin ?? '', 'accept');
    expect(refusalCodes(res)).toEqual(['MEMBERSHIP_TRANSITION_NOT_ALLOWED']);
  });

  it('activates the other two', async () => {
    expect((await move('platform', w.membership.forge ?? '', 'accept')).status).toBe(200);
    expect((await move('store', w.membership.store ?? '', 'accept')).status).toBe(200);
  });

  it('keeps the transition graph in the database too', async () => {
    await refusedByDb(
      w.harness.db.execute(
        sql`UPDATE ecosystem_memberships SET state = 'invited' WHERE id = ${w.membership.plugin}`,
      ),
      /active -> invited is not a transition/,
    );
    await refusedByDb(
      w.harness.db.execute(
        sql`UPDATE ecosystem_memberships SET decided_by = ${w.user.plugin} WHERE id = ${w.membership.forge}`,
      ),
      /who decided it, and when, is fixed/,
    );
  });

  it('lets both sides declare their interfaces', async () => {
    await writeInterfaces(w);
  });
});

describe('an ecosystem edit keeps what members and documents rely on', () => {
  const current = async () => (await send('platform', 'GET', `/api/ecosystems/${w.eco}`)).json;
  const put = (baseRevision: number, document: unknown) =>
    send('platform', 'PUT', `/api/ecosystems/${w.eco}`, { baseRevision, document });

  it('refuses a stale base and a changed id', async () => {
    const now = await current();
    expect(refusalCodes(await put(now.revision + 1, now.document))).toEqual(['STALE_BASE']);
    const moved = { ...now.document, ecosystem: { ...now.document.ecosystem, id: w.otherEco } };
    expect(refusalCodes(await put(now.revision, moved))).toEqual(['ECOSYSTEM_ID_IMMUTABLE']);
    const { id: _id, ...unnamed } = now.document.ecosystem;
    const dropped = { ...now.document, ecosystem: unnamed };
    expect(refusalCodes(await put(now.revision, dropped))).toEqual(['ECOSYSTEM_ID_IMMUTABLE']);
  });

  it('refuses an edit from outside the steward org', async () => {
    const now = await current();
    const res = await send('plugin', 'PUT', `/api/ecosystems/${w.eco}`, {
      baseRevision: now.revision,
      document: now.document,
    });
    expect(res.status).toBe(403);
  });

  it('refuses a window shorter than a member promises', async () => {
    const now = await current();
    now.document.channel.responseDays.rfi = 2;
    expect(refusalCodes(await put(now.revision, now.document))).toEqual([
      'RESPONSE_WINDOW_EXCEEDS_ECOSYSTEM',
    ]);
  });

  it('renames the channel code until a number is reserved, then refuses', async () => {
    const now = await current();
    now.document.channel.code = 'FPX';
    const renamed = await put(now.revision, now.document);
    expect(renamed.status).toBe(200);
    await w.harness.db.execute(
      sql`INSERT INTO channel_counters (ecosystem_id, type, last_number) VALUES (${w.eco}, 'change-notice', 1)`,
    );
    renamed.json.document.channel.code = 'FP';
    expect(refusalCodes(await put(renamed.json.revision, renamed.json.document))).toEqual([
      'CHANNEL_CODE_IN_USE',
    ]);
  });

  it('keeps every ecosystem revision write-once', async () => {
    await refusedByDb(
      w.harness.db.execute(
        sql`UPDATE ecosystem_revisions SET revision = 9 WHERE ecosystem_id = ${w.eco}`,
      ),
      /ecosystem_revisions is write-once/,
    );
    await refusedByDb(
      w.harness.db.execute(sql`DELETE FROM ecosystem_revisions WHERE ecosystem_id = ${w.eco}`),
      /ecosystem_revisions is write-once: a row cannot be delete/,
    );
  });
});

describe('a membership ends by its own transitions', () => {
  const end = (
    who: 'platform' | 'plugin' | 'store',
    key: 'plugin' | 'store',
    verb: string,
    body: unknown,
  ) => send(who, 'POST', `/api/memberships/${w.membership[key]}/${verb}`, body);

  it('asks for a reason', async () => {
    expect(refusalCodes(await end('plugin', 'plugin', 'leave', {}))).toEqual([
      'MEMBERSHIP_REASON_REQUIRED',
    ]);
  });

  it('refuses leaving while the interface still names the ecosystem', async () => {
    const res = await end('plugin', 'plugin', 'leave', { reason: 'moving on' });
    expect(res.status).toBe(422);
    expect(new Set(refusalCodes(res))).toEqual(new Set(['MEMBERSHIP_IN_USE']));
  });

  it('lets only the steward remove, keeps the reason, and allows a fresh invitation', async () => {
    expect((await end('store', 'store', 'remove', { reason: 'x' })).status).toBe(403);
    const res = await end('platform', 'store', 'remove', { reason: 'the store closed' });
    expect(res.json.document).toMatchObject({ state: 'removed', endedReason: 'the store closed' });
    expect(refusalCodes(await end('store', 'store', 'accept', undefined))).toEqual([
      'MEMBERSHIP_TRANSITION_NOT_ALLOWED',
    ]);
    const again = await send('platform', 'POST', `/api/ecosystems/${w.eco}/invitations`, {
      project: w.project.store,
    });
    expect(again.json.document.state).toBe('invited');
    expect(again.json.id).not.toBe(w.membership.store);
  });
});

describe('the published ecosystem schema says what create and update take', () => {
  it('does not require ecosystem.id, which a create leaves out and core assigns', async () => {
    const res = await w.app.request('/api/schemas/ecosystem-v1.json');
    const schema = (await res.json()) as {
      properties: { ecosystem: { required: string[]; properties: { id: object } } };
    };
    expect(schema.properties.ecosystem.required).not.toContain('id');
    expect(schema.properties.ecosystem.properties.id).toBeDefined();
  });
});

describe('the three schemas are served publicly', () => {
  it.each(['ecosystem-v1.json', 'membership-v1.json', 'interface-v1.json'])('%s', async (file) => {
    const res = await w.app.request(`/api/schemas/${file}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { $id: string }).$id).toBe(
      `https://forge.sidcorp.co/schemas/${file}`,
    );
  });
});
