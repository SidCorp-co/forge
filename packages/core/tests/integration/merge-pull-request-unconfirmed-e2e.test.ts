/**
 * A merge whose answer the host never gave is read back, never answered 500 (adminhub-fe !1994,
 * 2026-10-26): GitLab merged it at 8ab74c9f through the relay, the relay's answer timed out, and
 * `merge-pull-request` answered 500 "retryable", which a caller reads as "merge again". Core reads
 * the request back: merged answers success with the landing it observed, unmerged a named refusal,
 * and an unreadable one a named refusal that says not to send the merge again. A second call on a
 * merged request answers it merged without merging again.
 *
 * @direct-test-of packages/core/src/integrations/source-host/merge-unknown.ts
 * @direct-test-of packages/core/src/integrations/source-host/merge.ts
 * @direct-test-of packages/core/src/integration-door/issue-merge-routes.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWorld, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  issue,
  issueRow,
  mergeOf,
  mergeRequest,
  rows,
  seedWorld,
} from '../helpers/host-merge-world.js';
import { callFails, merged, merges } from '../helpers/planted-gitlab-merges.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const planted = await import('../helpers/planted-gitlab-merges.js');
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => planted.plantedRepository(),
    sourceHostForBinding: async () => planted.plantedSourceHost(),
  };
});

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(() => seedWorld(null));

type Refusal = { code: string; detail: string };
const refusalsOf = (body: unknown) =>
  ((body as { error?: { refusals?: Refusal[] } }).error?.refusals ?? []) as Refusal[];

const deliveries = () =>
  rows<{ status: string }>(sql`
    SELECT status FROM integration_deliveries WHERE event_name = 'pull_request.merge'
     ORDER BY created_at`);

async function waiting(n: number): Promise<string> {
  const id = await issue(n, 'in_progress');
  await mergeRequest(1994, `fix/iss-${n}`, 'ab'.repeat(20), null);
  return id;
}

describe('a merge the host took and whose answer was lost', () => {
  it('answers success with the landing it read back, and a second call does not merge again', async () => {
    const id = await waiting(50);
    callFails.set(1994, 'after');

    const res = await mergeOf(id, 1994);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const landing = merged.get(1994) as string;
    expect(res.body).toMatchObject({
      merged: true,
      alreadyMerged: false,
      commitSha: landing,
      target: 'release/stg',
      observedAfter: 'The operation was aborted due to timeout',
    });
    expect((await issueRow(id))?.merged_commit_sha).toBe(landing);
    expect(merges).toEqual([1994]);

    const again = await mergeOf(id, 1994);

    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ merged: true, alreadyMerged: true, commitSha: landing });
    expect(merges).toEqual([1994]);
    expect((await deliveries()).map((d) => d.status)).toEqual(['ok', 'ok']);
  });
});

describe('a merge whose answer was lost before the host took it', () => {
  it('is refused by name, saying it did not land and that merging again is safe', async () => {
    const id = await waiting(51);
    callFails.set(1994, 'before');

    const res = await mergeOf(id, 1994);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const [refusal] = refusalsOf(res.body);
    expect(refusal?.code).toBe('MERGE_REFUSED');
    expect(refusal?.detail).toContain('(merge-unconfirmed)');
    expect(refusal?.detail).toContain('is `open`, not merged, so nothing landed');
    expect(refusal?.detail).toContain('sending the merge again is safe');
    expect((await issueRow(id))?.merged_at).toBeNull();
    expect(merges).toEqual([]);
  });
});

describe('a merge whose answer was lost and whose request cannot be read back', () => {
  it('is refused by name as unknown, saying not to send it again', async () => {
    const id = await waiting(52);
    callFails.set(1994, 'unreadable');

    const res = await mergeOf(id, 1994);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    const [refusal] = refusalsOf(res.body);
    expect(refusal?.code).toBe('MERGE_REFUSED');
    expect(refusal?.detail).toContain('(merge-outcome-unknown)');
    expect(refusal?.detail).toContain('whether it merged is unknown. Do not send the merge again');
    expect((await deliveries()).map((d) => d.status)).toEqual(['refused']);
  });
});
