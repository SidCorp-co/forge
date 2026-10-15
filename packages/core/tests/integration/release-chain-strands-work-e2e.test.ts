/**
 * ISS-1171 — a project write that would strand work is refused by name, by both doors, against the
 * rows Postgres actually holds.
 *
 * Two writes change what happens to work already under way, with nothing said: taking a release
 * chain from some branches to none while issues wait at `awaiting_release` (nothing ever releases
 * them again), and changing `kind` so a merge mark an issue already carries stops counting as a
 * landing. Each is planted, refused through REST and through `forge_projects.update`, and then
 * taken once the way out the refusal names has been taken.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { callRest, callTool, type Door } from '../helpers/door-parity.js';
import { createTestProject, createTestUser } from '../helpers/factories.js';
import {
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let projectId: string;
let ownerId: string;
let jwt: string;
let pat: string;
let seq = 0;
/** Each planted issue's id, by the key a refusal names it with. */
const idOf = new Map<string, string>();

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.close();
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  seq = 0;
  const owner = await createTestUser(harness.db);
  ownerId = owner.id;
  await harness.db.execute(sql`UPDATE users SET email_verified_at = now() WHERE id = ${ownerId}`);
  projectId = (await createTestProject(harness.db, ownerId)).id;
  await harness.db.execute(sql`
    UPDATE projects SET base_branch = 'main', release_chain = '[{"branch":"main"}]'::jsonb
     WHERE id = ${projectId}`);
  const { signUserToken } = await import('../../src/auth/jwt.js');
  const { mintPat } = await import('../../src/auth/pat.js');
  jwt = await signUserToken(ownerId);
  pat = (await mintPat({ userId: ownerId, name: 'owner', scopes: ['read', 'write', 'admin'] }))
    .plaintext;
});

async function issue(
  status: string,
  mark: { landing?: string; commit?: string } | null = null,
  declared: 'git' | 'outside_git' | null = null,
): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id,
                        merged_at, merged_landing, merged_commit_sha, declared_landing_shape)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId},
            ${mark ? sql`now()` : null}, ${mark?.landing ?? null}, ${mark?.commit ?? null},
            ${declared})`);
  idOf.set(`ISS-${seq}`, id);
  return `ISS-${seq}`;
}

async function stored(): Promise<{ kind: string; chain: unknown }> {
  const rows = (await harness.db.execute(
    sql`SELECT kind, release_chain AS chain FROM projects WHERE id = ${projectId}`,
  )) as unknown as Array<{ kind: string; chain: unknown }>;
  return rows[0] as { kind: string; chain: unknown };
}

type Write = (patch: Record<string, unknown>) => Promise<Door>;

const doors: Record<string, Write> = {
  'REST PATCH /api/projects/:id': (patch) =>
    callRest(server.baseUrl, jwt, 'PATCH', `/api/projects/${projectId}`, patch),
  'forge_projects.update': (patch) => callTool(pat, 'forge_projects.update', { projectId, patch }),
};

describe.each(Object.entries(doors))('%s', (_door, write) => {
  describe('RELEASE_CHAIN_STRANDS_WORK', () => {
    it('refuses emptying a chain while issues wait at awaiting_release, naming them and writing nothing', async () => {
      const a = await issue('awaiting_release');
      const b = await issue('awaiting_release');
      await issue('developed');

      const out = await write({ releaseChain: [] });

      expect(out.refused).toContain('RELEASE_CHAIN_STRANDS_WORK');
      expect(out.refused).toContain(`${a}, ${b}`);
      expect(out.refused).not.toContain('ISS-3');
      expect(out.refused).toContain('return each one to Developed');
      expect((await stored()).chain).toEqual([{ branch: 'main' }]);
    });

    it('takes the same write once nothing waits', async () => {
      await issue('developed');
      await issue('dropped');

      const out = await write({ releaseChain: [] });

      expect(out.refused).toBeUndefined();
      expect((await stored()).chain).toEqual([]);
    });

    it('does not refuse a chain that was already empty, whatever waits', async () => {
      await harness.db.execute(
        sql`UPDATE projects SET release_chain = '[]'::jsonb WHERE id = ${projectId}`,
      );
      await issue('awaiting_release');

      const out = await write({ releaseChain: [] });

      expect(out.refused).toBeUndefined();
    });

    it('does not refuse a chain that changes but still ships', async () => {
      await issue('awaiting_release');

      const out = await write({
        baseBranch: 'main',
        releaseChain: [{ branch: 'main' }, { branch: 'live', from: 'merge-branch' }],
      });

      expect(out.refused).toBeUndefined();
    });
  });

  describe('PROJECT_KIND_STRANDS_WORK', () => {
    it('refuses a kind change that would make a written mark stop counting, naming the issue', async () => {
      // A bare mark is a landing in git and is not one outside git.
      const bare = await issue('developed', {});
      // A mark naming a commit counts on both lanes, so it is not stranded.
      await issue('developed', { commit: 'a'.repeat(40) });
      // A closed issue's mark has done its work.
      await issue('closed', { commit: 'b'.repeat(40) });
      await issue('dropped', {});
      // An issue that declares its own lane is not moved by the project's kind.
      await issue('developed', {}, 'git');

      const out = await write({ kind: 'website' });

      expect(out.refused).toContain('PROJECT_KIND_STRANDS_WORK');
      expect(out.refused).toContain(bare);
      expect(out.refused).toContain('1 unclosed issue');
      expect(out.refused).toContain('`landingShape: git`');
      expect((await stored()).kind).toBe('standard');
    });

    it('takes the kind change once each issue has taken the way out the refusal names, through the issue doors', async () => {
      const key = await issue('developed', {});
      const id = idOf.get(key) as string;
      const issueDoor = (method: string, path: string, body?: unknown) =>
        callRest(server.baseUrl, jwt, method, path, body);

      // A landing shape is not taken over a standing mark, so declaring it first is refused.
      expect((await issueDoor('PATCH', `/api/issues/${id}`, { landingShape: 'git' })).status).toBe(
        409,
      );

      expect((await issueDoor('DELETE', `/api/issues/${id}/merge`, {})).status).toBe(200);
      expect((await issueDoor('PATCH', `/api/issues/${id}`, { landingShape: 'git' })).status).toBe(
        200,
      );
      const remark = await issueDoor('POST', `/api/issues/${id}/merge`, { target: 'main' });
      expect(remark.refused).toBeUndefined();

      const out = await write({ kind: 'website' });

      expect(out.refused).toBeUndefined();
      expect((await stored()).kind).toBe('website');
      const rows = (await harness.db.execute(
        sql`SELECT merged_at, declared_landing_shape FROM issues WHERE id = ${id}`,
      )) as unknown as Array<{ merged_at: unknown; declared_landing_shape: string }>;
      expect(rows[0]?.merged_at).not.toBeNull();
      expect(rows[0]?.declared_landing_shape).toBe('git');
    });

    it('refuses the reverse move for a landing that only counts outside git', async () => {
      await harness.db.execute(
        sql`UPDATE projects SET kind = 'website', release_chain = '[]'::jsonb WHERE id = ${projectId}`,
      );
      const landed = await issue('testing', { landing: 'https://store.example.com/p/1' });

      const out = await write({ kind: 'standard' });

      expect(out.refused).toContain('PROJECT_KIND_STRANDS_WORK');
      expect(out.refused).toContain(landed);
      expect(out.refused).toContain('`landingShape: outside_git`');
    });

    it('takes a kind write that changes nothing', async () => {
      await issue('developed', {});

      const out = await write({ kind: 'standard' });

      expect(out.refused).toBeUndefined();
    });
  });
});
