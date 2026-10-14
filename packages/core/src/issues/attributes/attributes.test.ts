import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { singleRowAttributeKeys } from '../../db/issue-vocabulary.js';
import { ATTRIBUTE_REGISTRY, attributeDef } from './registry.js';
import { type AttributeRow, renderAttribute } from './render.js';
import { AttributeRefusal, writeAttributes } from './write.js';

const MIGRATION = 'drizzle/migrations/0329_the_issue_data_plane_sheds_what_nothing_reads.sql';

/** The one door a write goes through: a plain `values` for many-row keys, `onConflictDoUpdate` for single-row ones. */
function fakeTx() {
  const inserted: unknown[] = [];
  const upserted: unknown[] = [];
  return {
    inserted,
    upserted,
    tx: {
      insert: () => ({
        values: (rows: unknown) => ({
          then: (resolve: () => unknown, reject: () => unknown) => {
            inserted.push(rows);
            return Promise.resolve().then(resolve, reject);
          },
          onConflictDoUpdate: () => {
            upserted.push(rows);
            return Promise.resolve();
          },
        }),
      }),
    } as never,
  };
}

const UUID = '11111111-2222-4333-8444-555555555555';
const row = (over: Partial<AttributeRow>): AttributeRow => ({
  key: 'obligation',
  valueText: null,
  valueNum: null,
  valueBool: null,
  valueTs: null,
  valueRef: null,
  sourceCommentId: null,
  assertedByUserId: null,
  assertedAt: new Date('2026-09-14T03:48:00Z'),
  ...over,
});

describe('the registry and the single-row list are one declaration', () => {
  it('derives cardinality one for exactly the keys the list names', () => {
    expect(
      ATTRIBUTE_REGISTRY.filter((d) => d.cardinality === 'one')
        .map((d) => d.key)
        .sort(),
    ).toEqual([...singleRowAttributeKeys].sort());
  });

  it('registers every key the list names, so the index cannot cover a key no write can reach', () => {
    for (const key of singleRowAttributeKeys) expect(attributeDef(key), key).toBeDefined();
  });

  it('builds the migration index over exactly the keys the list names', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const index =
      sql.match(/CREATE UNIQUE INDEX "issue_attributes_single_row_uq"[^;]*;/s)?.[0] ?? '';
    const keys = [...index.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(keys).toEqual([...singleRowAttributeKeys].sort());
  });

  it('no longer registers the keys that asserted a relation nothing read', () => {
    expect(attributeDef('blocking')).toBeUndefined();
    expect(attributeDef('supersedes')).toBeUndefined();
  });
});

describe('a write is refused by name', () => {
  it('refuses a key nobody registered, and names the registered ones', async () => {
    const { tx } = fakeTx();
    await expect(
      writeAttributes([{ issueId: UUID, key: 'vibes', value: 'good' }], tx),
    ).rejects.toMatchObject({ code: 'UNREGISTERED_KEY' });
    await expect(
      writeAttributes([{ issueId: UUID, key: 'vibes', value: 'good' }], tx),
    ).rejects.toBeInstanceOf(AttributeRefusal);
    await expect(
      writeAttributes([{ issueId: UUID, key: 'vibes', value: 'good' }], tx),
    ).rejects.toThrow(/obligation/);
  });

  it('refuses a value of the wrong declared type', async () => {
    const { tx } = fakeTx();
    await expect(
      writeAttributes([{ issueId: UUID, key: 'delivered', value: 'one' }], tx),
    ).rejects.toMatchObject({ code: 'WRONG_TYPE' });
    await expect(
      writeAttributes([{ issueId: UUID, key: 'obligation_owner', value: 'colin' }], tx),
    ).rejects.toMatchObject({ code: 'WRONG_TYPE' });
  });

  it('refuses an obligation nobody owns — the ISS-1002 shape', async () => {
    const { tx } = fakeTx();
    await expect(
      writeAttributes([{ issueId: UUID, key: 'obligation', value: 'steps 2-5' }], tx),
    ).rejects.toMatchObject({ code: 'OBLIGATION_UNOWNED' });
  });

  it('accepts an obligation carried by another issue', async () => {
    const { tx, inserted } = fakeTx();
    await expect(
      writeAttributes(
        [
          { issueId: UUID, key: 'obligation', value: 'steps 2-5' },
          { issueId: UUID, key: 'obligation_carrier', value: UUID },
        ],
        tx,
      ),
    ).resolves.toBe(2);
    expect(inserted).toHaveLength(1);
  });

  it('refuses an empty string rather than storing a non-assertion', async () => {
    const { tx } = fakeTx();
    await expect(
      writeAttributes([{ issueId: UUID, key: 'irreversible_if_wrong', value: '   ' }], tx),
    ).rejects.toMatchObject({ code: 'EMPTY_TEXT' });
  });
});

describe('cardinality', () => {
  it('upserts a single-row key and plainly inserts a many-row one', async () => {
    const one = fakeTx();
    await writeAttributes([{ issueId: UUID, key: 'delivered', value: 1 }], one.tx);
    expect(one.upserted).toHaveLength(1);
    expect(one.inserted).toHaveLength(0);

    const many = fakeTx();
    await writeAttributes(
      [
        { issueId: UUID, key: 'obligation', value: 'a' },
        { issueId: UUID, key: 'obligation_carrier', value: UUID },
      ],
      many.tx,
    );
    expect(many.inserted).toHaveLength(1);
    expect(many.upserted).toHaveLength(1);
  });

  it('refuses one batch that names a single-row key twice for one issue, writing nothing', async () => {
    const { tx, upserted } = fakeTx();
    await expect(
      writeAttributes(
        [
          { issueId: UUID, key: 'delivered', value: 1 },
          { issueId: UUID, key: 'delivered', value: 2 },
        ],
        tx,
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_SINGLE_KEY' });
    expect(upserted).toHaveLength(0);
  });

  it('takes a many-row key twice, and a single-row key once on each of two issues', async () => {
    const OTHER = '66666666-7777-4888-8999-aaaaaaaaaaaa';
    const { tx } = fakeTx();
    await expect(
      writeAttributes(
        [
          { issueId: UUID, key: 'obligation', value: 'a' },
          { issueId: UUID, key: 'obligation', value: 'b' },
          { issueId: UUID, key: 'obligation_owner', value: UUID },
          { issueId: UUID, key: 'delivered', value: 1 },
          { issueId: OTHER, key: 'delivered', value: 1 },
        ],
        tx,
      ),
    ).resolves.toBe(5);
  });
});

describe('a rendered attribute says what was asserted, and resolves what it points at', () => {
  it('resolves a ref to the thing it names rather than a uuid', () => {
    const rendered = renderAttribute(
      row({ key: 'obligation_carrier', valueRef: UUID }),
      new Map([[UUID, 'ISS-1004']]),
    );
    expect(rendered.value).toBe('ISS-1004');
    expect(rendered.ref).toBe(UUID);
  });

  it('carries the registered label and declared type, not the raw column', () => {
    const rendered = renderAttribute(row({ key: 'delivered', valueNum: 1 }), new Map());
    expect(rendered.label).toBe('Delivered');
    expect(rendered.valueType).toBe('number');
    expect(rendered.value).toBe(1);
  });

  it('keeps the source so a reader lands on the record, not the thread', () => {
    const rendered = renderAttribute(
      row({ key: 'obligation', valueText: 'steps 2-5', sourceCommentId: UUID }),
      new Map(),
    );
    expect(rendered.sourceCommentId).toBe(UUID);
  });
});
