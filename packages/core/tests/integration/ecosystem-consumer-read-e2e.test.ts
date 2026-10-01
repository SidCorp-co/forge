import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ChannelWorld, openChannelWorld, speaker } from '../helpers/channel-world.js';

let w: ChannelWorld;
let say: ReturnType<typeof speaker>;

const COMMIT = 'c0ffee'.padEnd(40, '0');
const SHA = 'ab'.repeat(32);

beforeAll(async () => {
  w = await openChannelWorld();
  say = speaker(w);
  await w.harness.db.execute(sql`
    UPDATE contract_versions
       SET document = jsonb_set(document, '{artifact}', ${JSON.stringify({ sha256: SHA, sourceCommit: COMMIT })}::jsonb)
     WHERE provider_project_id = ${w.project.forge} AND contract_slug = 'forge-api' AND version = '2026-10-01'
  `);
  await w.harness.db.execute(sql`
    INSERT INTO contract_measurements
      (provider_project_id, contract_slug, commit_sha, branch, environments, outcome, version, reason, settled_at)
    VALUES (${w.project.forge}, 'forge-api', ${COMMIT}, 'release/internal-codename', ARRAY['beta']::text[],
            'recorded', '2026-10-01', 'measured from the internal monorepo path', now())
  `);
}, 120_000);

afterAll(async () => {
  await w.harness.cleanup();
});

const consumed = (consumer: string, provider: string, contract: string, what: string) =>
  `/api/projects/${consumer}/consumes/${provider}/${contract}/${what}`;

const code = (r: { json: { code?: string } }) => r.json.code;

describe('a consumer reads the versions of a contract it consumes', () => {
  it('reads forge/forge-api as forge-plugin, which consumes it', async () => {
    const r = await say(
      'plugin',
      'GET',
      consumed(w.project.plugin, w.project.forge, 'forge-api', 'versions'),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.contract).toBe('forge/forge-api');
    expect(r.json.ecosystems).toEqual([w.eco]);
    expect(r.json.versions.map((v: { contractVersion: string }) => v.contractVersion)).toEqual([
      '2026-10-01',
      '2026-09-20',
    ]);
  });

  it('is read by a viewer of the consuming project too, since reading takes any role', async () => {
    const r = await say(
      'viewer',
      'GET',
      consumed(w.project.plugin, w.project.forge, 'forge-api', 'measurements'),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.measurements).toHaveLength(1);
  });

  it('exposes nothing internal to the provider: no commit, branch, uploader or reason', async () => {
    const versions = await say(
      'plugin',
      'GET',
      consumed(w.project.plugin, w.project.forge, 'forge-api', 'versions'),
    );
    const measured = await say(
      'plugin',
      'GET',
      consumed(w.project.plugin, w.project.forge, 'forge-api', 'measurements'),
    );
    const served = JSON.stringify([versions.json, measured.json]);
    expect(served).not.toContain(COMMIT);
    expect(served).not.toContain('internal-codename');
    expect(served).not.toContain('monorepo');
    expect(served).not.toContain('sourceCommit');
    expect(versions.json.versions[0].artifact).toEqual({ sha256: SHA });
    expect(measured.json.measurements[0]).toEqual({
      outcome: 'recorded',
      version: '2026-10-01',
      environments: ['beta'],
      observedAt: expect.any(String),
      settledAt: expect.any(String),
    });
  });
});

describe('nobody else reads them', () => {
  it('refuses a member project that consumes nothing of the provider, by name', async () => {
    const r = await say(
      'store',
      'GET',
      consumed(w.project.store, w.project.forge, 'forge-api', 'versions'),
    );
    expect([r.status, code(r)]).toEqual([403, 'CONTRACT_NOT_A_PARTY']);
  });

  it('refuses a contract the consumer does not consume, even from a provider it does', async () => {
    const r = await say(
      'plugin',
      'GET',
      consumed(w.project.plugin, w.project.forge, 'forge-internal-api', 'measurements'),
    );
    expect([r.status, code(r)]).toEqual([403, 'CONTRACT_NOT_A_PARTY']);
  });

  it('refuses reading as a consumer the person holds no role on', async () => {
    const r = await say(
      'store',
      'GET',
      consumed(w.project.plugin, w.project.forge, 'forge-api', 'versions'),
    );
    expect([r.status, code(r)]).toEqual([403, 'CHANNEL_NO_ROLE']);
  });

  it('refuses a token fenced away from the consumer it names', async () => {
    const r = await say(
      'masterForge',
      'GET',
      consumed(w.project.plugin, w.project.forge, 'forge-api', 'versions'),
    );
    expect([r.status, code(r)]).toEqual([403, 'CHANNEL_NO_ROLE']);
  });

  it('leaves the provider-side reads to the provider: a consumer is refused there', async () => {
    const r = await say(
      'plugin',
      'GET',
      `/api/projects/${w.project.forge}/contracts/forge-api/measurements`,
    );
    expect(r.status).toBe(403);
  });

  it('stops reading once the consumer takes the contract out of its interface', async () => {
    const path = `/api/projects/${w.project.plugin}/interface`;
    const held = await say('plugin', 'GET', path);
    const document = {
      ...held.json.document,
      consumes: held.json.document.consumes.filter(
        (c: { contract: string }) => c.contract !== 'forge/forge-api',
      ),
    };
    const put = await say('plugin', 'PUT', path, { baseRevision: held.json.revision, document });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const r = await say(
      'plugin',
      'GET',
      consumed(w.project.plugin, w.project.forge, 'forge-api', 'versions'),
    );
    expect([r.status, code(r)]).toEqual([403, 'CONTRACT_NOT_A_PARTY']);
    const still = await say(
      'plugin',
      'GET',
      consumed(w.project.plugin, w.project.forge, 'forge-mcp', 'versions'),
    );
    expect(still.status, JSON.stringify(still.json)).toBe(200);
  });
});
