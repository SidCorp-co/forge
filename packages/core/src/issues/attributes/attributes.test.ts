import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_REGISTRY } from './registry.js';
import { type AttributeRow, renderAttribute } from './render.js';
import { AttributeRefusal, writeAttributes } from './write.js';

const MIGRATION = 'drizzle/migrations/0245_issue_attributes.sql';

function fakeTx() {
  const inserted: unknown[] = [];
  const deleted: unknown[] = [];
  return {
    inserted,
    deleted,
    tx: {
      insert: () => ({
        values: (rows: unknown) => {
          inserted.push(rows);
          return Promise.resolve();
        },
      }),
      delete: () => ({
        where: (w: unknown) => {
          deleted.push(w);
          return Promise.resolve();
        },
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

describe('the registry and its seed are one list', () => {
  it('seeds every registered key, and seeds nothing it has not registered', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const seeded = [...sql.matchAll(/^\t\('([a-z_]+)',/gm)].map((m) => m[1]).sort();
    expect(seeded).toEqual(ATTRIBUTE_REGISTRY.map((d) => d.key).sort());
  });

  it('seeds each key with the type and writer the registry declares', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    for (const def of ATTRIBUTE_REGISTRY) {
      const line = sql.split('\n').find((l) => l.startsWith(`\t('${def.key}',`));
      expect(line, `no seed row for ${def.key}`).toBeDefined();
      expect(line).toContain(`'${def.valueType}'`);
      expect(line).toContain(`'${def.writtenBy}'`);
    }
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
  it('replaces a cardinality-one key and appends a many one', async () => {
    const one = fakeTx();
    await writeAttributes([{ issueId: UUID, key: 'delivered', value: 1 }], one.tx);
    expect(one.deleted).toHaveLength(1);

    const many = fakeTx();
    await writeAttributes(
      [
        { issueId: UUID, key: 'obligation', value: 'a' },
        { issueId: UUID, key: 'obligation_carrier', value: UUID },
      ],
      many.tx,
    );
    expect(many.deleted).toHaveLength(1);
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
