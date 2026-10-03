/**
 * Migration `0344_an_issue_update_records_what_changed.sql`, read off disk and run against real
 * Postgres inside a transaction that is rolled back, the way the 0325 migration test holds its own.
 *
 * The proposition: every snapshot an `issue.updated` row held is recovered from the converted
 * chain, the SQL walk orders its changes exactly as `@forge/contracts` field-changes does, and a
 * row that is not the snapshot shape stops the migration by name rather than being skipped.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyFieldChanges,
  diffFieldValue,
  type FieldChange,
  type IssueUpdatedPayload,
} from '@forge/contracts/field-changes';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

const MIGRATION = readFileSync(
  resolvePath(
    dirname(fileURLToPath(import.meta.url)),
    '../../drizzle/migrations/0344_an_issue_update_records_what_changed.sql',
  ),
  'utf8',
);

let harness: TestDatabase;
let client: Sql;
let projectId: string;
let userId: string;
let seq = 0;

class Rollback extends Error {}

/** The element at `i`, or a throw naming the index: a missing row is the failure, never `undefined`. */
function at<T>(xs: readonly T[], i: number): T {
  const v = xs[i];
  if (v === undefined) throw new Error(`no element ${i} of ${xs.length}`);
  return v;
}

type Legacy = { fields: string[]; before: Record<string, unknown>; after: Record<string, unknown> };
type Converted = IssueUpdatedPayload & Record<string, unknown>;

beforeAll(async () => {
  harness = await setupTestDatabase();
  client = harness.client;
  const user = await createTestUser(harness.db);
  userId = user.id;
  projectId = (await createTestProject(harness.db, user.id)).id;
}, 120_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

/**
 * Seed one issue's rows, run the migration, read the rows back and roll everything away. Each
 * payload is written as given, so a malformed one reaches the migration exactly as a stored row.
 */
async function migrate(
  payloads: unknown[],
  extra: { action: string; payload: unknown }[] = [],
): Promise<{
  rows: { id: string; action: string; payload: unknown }[];
  ids: string[];
  error: string | null;
}> {
  let out: {
    rows: { id: string; action: string; payload: unknown }[];
    ids: string[];
    error: string | null;
  } = {
    rows: [],
    ids: [],
    error: null,
  };
  try {
    await client.begin(async (tx) => {
      seq += 1;
      const issueId = at(
        await tx`
        INSERT INTO issues (project_id, created_by_id, iss_seq, title, status)
        VALUES (${projectId}, ${userId}, ${seq}, 'migration subject', 'open') RETURNING id`,
        0,
      ).id as string;
      const ids: string[] = [];
      const all = [...payloads.map((payload) => ({ action: 'issue.updated', payload })), ...extra];
      for (const [i, row] of all.entries()) {
        const inserted = await tx`
          INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload, created_at)
          VALUES (${issueId}, 'user', ${userId}, 'agent', ${row.action}, ${JSON.stringify(row.payload)}::jsonb,
                  now() - make_interval(mins => ${all.length - i}))
          RETURNING id`;
        ids.push(at(inserted, 0).id as string);
      }
      let error: string | null = null;
      try {
        await tx.savepoint(async (sp) => {
          await sp.unsafe(MIGRATION);
        });
      } catch (err) {
        error = (err as Error).message;
      }
      const rows = await tx`
        SELECT id, action, payload FROM activity_log WHERE issue_id = ${issueId} ORDER BY created_at, id`;
      out = {
        rows: rows.map((r) => ({
          id: r.id as string,
          action: r.action as string,
          payload: r.payload,
        })),
        ids,
        error,
      };
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out;
}

const worklog = { head: '9d2e6d1', notes: 'n'.repeat(6000) };
const lease1 = { holder: 'iss-1-a', renewedAt: 't1', history: [{ how: 'claim', at: 't0' }] };
const sc1 = { lease: lease1, worklog };
const sc2 = {
  lease: { ...lease1, renewedAt: 't2', history: [...lease1.history, { how: 'write', at: 't2' }] },
  worklog,
};
const sc2Moved = { ...sc2, worklog: { head: 'ffff000', notes: 'n'.repeat(6000) } };
const sc3 = { ...sc2Moved, strand: 'S-1' };

/** A sequence with every case a snapshot row held on beta. */
const SEQUENCE: Legacy[] = [
  {
    fields: ['sessionContext', 'title'],
    before: { sessionContext: null, title: 'a' },
    after: { sessionContext: sc1, title: 'b' },
  },
  { fields: ['sessionContext'], before: { sessionContext: sc1 }, after: { sessionContext: sc2 } },
  // A write nothing recorded moved the worklog between these two rows.
  {
    fields: ['sessionContext'],
    before: { sessionContext: sc2Moved },
    after: { sessionContext: sc3 },
  },
  // The merge marker recorded `mergedAt` alone on its before side.
  {
    fields: ['mergedAt', 'mergedCommitSha', 'mergedLanding'],
    before: { mergedAt: null },
    after: { mergedAt: '2026-10-01T00:00:00.000Z', mergedCommitSha: 'abc123', mergedLanding: null },
  },
  // The snapshot writer compared documents by reference, so an identical re-send was a row.
  {
    fields: ['sessionContext'],
    before: { sessionContext: sc3 },
    after: { sessionContext: structuredClone(sc3) },
  },
];

/**
 * Walk the converted chain the way any reader recovering history would: a field's value before a
 * row is the row's anchor where it carries one, else the value the previous row left.
 */
function reconstruct(
  converted: Converted[],
): Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> {
  const state: Record<string, unknown> = {};
  return converted.map((row) => {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const field of [...row.fields, ...(row.unchanged ?? [])]) {
      const prior = row.anchor && field in row.anchor ? row.anchor[field] : state[field];
      before[field] = prior;
      after[field] = applyFieldChanges(field, prior ?? null, row.changes, 'forward');
      state[field] = after[field];
    }
    return { before, after };
  });
}

describe('0344 rewrites every issue.updated snapshot into the changes it made', () => {
  it('recovers every snapshot the rows held from the converted chain', async () => {
    const { rows, error } = await migrate(SEQUENCE);
    expect(error).toBeNull();
    const converted = rows.map((r) => r.payload as Converted);
    for (const row of converted) {
      expect(row).not.toHaveProperty('before');
      expect(row).not.toHaveProperty('after');
    }
    const recovered = reconstruct(converted);
    SEQUENCE.forEach((legacy, i) => {
      for (const field of legacy.fields) {
        expect(at(recovered, i).after[field], `row ${i} ${field} after`).toEqual(
          legacy.after[field],
        );
        if (field in legacy.before) {
          expect(at(recovered, i).before[field], `row ${i} ${field} before`).toEqual(
            legacy.before[field],
          );
        }
      }
    });
  });

  it('anchors a field only where the previous row does not give its before', async () => {
    const { rows } = await migrate(SEQUENCE);
    const anchors = rows.map((r) => (r.payload as Converted).anchor ?? null);
    expect(anchors[0]).toEqual({ sessionContext: null, title: 'a' });
    expect(anchors[1]).toBeNull();
    expect(anchors[2]).toEqual({ sessionContext: sc2Moved });
    expect(anchors[3]).toEqual({ mergedAt: null });
    expect(anchors[4]).toBeNull();
  });

  it('orders and shapes each change exactly as the contracts walk does', async () => {
    const { rows } = await migrate(SEQUENCE);
    SEQUENCE.forEach((legacy, i) => {
      const expected = legacy.fields.flatMap((f): FieldChange[] =>
        f in legacy.before
          ? diffFieldValue(f, legacy.before[f], legacy.after[f])
          : [{ path: [f], op: 'set', after: legacy.after[f] }],
      );
      expect((at(rows, i).payload as Converted).changes, `row ${i}`).toEqual(expected);
    });
  });

  it('keeps a no-op row, its listed fields named as unchanged and no change recorded', async () => {
    const { rows } = await migrate(SEQUENCE);
    expect(at(rows, 4).payload).toEqual({ fields: [], changes: [], unchanged: ['sessionContext'] });
  });

  it('records a lease renewal as the keys it moved, a fraction of the snapshot', async () => {
    const { rows } = await migrate(SEQUENCE);
    const legacyBytes = JSON.stringify(SEQUENCE[1]).length;
    const convertedBytes = JSON.stringify(at(rows, 1).payload).length;
    expect(convertedBytes).toBeLessThan(legacyBytes / 20);
  });

  it('keeps keys beside the snapshot (an evaluation) and leaves other actions untouched', async () => {
    const evaluation = { verdict: 'approve', note: null };
    const statusRow = { from: 'open', to: 'confirmed' };
    const { rows, error } = await migrate(
      [{ ...SEQUENCE[0], evaluation }],
      [{ action: 'issue.statusChanged', payload: statusRow }],
    );
    expect(error).toBeNull();
    expect(at(rows, 0).payload).toMatchObject({ evaluation, fields: ['sessionContext', 'title'] });
    expect(at(rows, 1).payload).toEqual(statusRow);
  });
});

describe('0344 stops on a row it cannot convert, naming it', () => {
  const malformed: Array<[string, unknown, RegExp]> = [
    [
      'fields is not an array',
      { fields: 'title', before: {}, after: {} },
      /"fields" is title, where an array/,
    ],
    ['after is missing', { fields: ['title'], before: { title: 'a' } }, /"after" is absent/],
    [
      'a listed field has no after',
      { fields: ['title', 'plan'], before: {}, after: { title: 'b' } },
      /field "plan" is listed/,
    ],
    ['the payload is an array', [1, 2], /the payload is a array/],
  ];

  for (const [name, payload, says] of malformed) {
    it(`aborts when ${name}, naming the row and converting nothing`, async () => {
      const { rows, ids, error } = await migrate([SEQUENCE[0], payload]);
      expect(error).toMatch(new RegExp(`activity_log row ${ids[1]}`));
      expect(error).toMatch(says);
      expect(at(rows, 0).payload).toEqual(SEQUENCE[0]);
    });
  }
});
