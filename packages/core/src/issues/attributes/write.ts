import { and, eq, type SQL } from 'drizzle-orm';
import { issueAttributes } from '../../db/schema.js';
import { type AttributeDef, attributeDef, writableKeys } from './registry.js';

export type AttributeValue = string | number | boolean | Date;

export interface AttributeWrite {
  readonly issueId: string;
  readonly key: string;
  readonly value: AttributeValue;
  readonly sourceCommentId?: string | null;
  readonly assertedByUserId?: string | null;
}

export class AttributeRefusal extends Error {
  constructor(
    readonly code: 'UNREGISTERED_KEY' | 'WRONG_TYPE' | 'OBLIGATION_UNOWNED' | 'EMPTY_TEXT',
    message: string,
  ) {
    super(message);
    this.name = 'AttributeRefusal';
  }
}

type ValueColumns = Pick<
  typeof issueAttributes.$inferInsert,
  'valueText' | 'valueNum' | 'valueBool' | 'valueTs' | 'valueRef'
>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function columnsFor(def: AttributeDef, value: AttributeValue): ValueColumns {
  const empty: ValueColumns = {
    valueText: null,
    valueNum: null,
    valueBool: null,
    valueTs: null,
    valueRef: null,
  };
  const wrong = (want: string): never => {
    throw new AttributeRefusal(
      'WRONG_TYPE',
      `\`${def.key}\` is declared ${def.valueType}; ${want} was given \`${String(value)}\`. Register a different key or send the declared shape.`,
    );
  };

  switch (def.valueType) {
    case 'text': {
      if (typeof value !== 'string') return wrong('a non-string');
      if (value.trim() === '')
        throw new AttributeRefusal(
          'EMPTY_TEXT',
          `\`${def.key}\` was given an empty string. An attribute with nothing in it is not an assertion — omit the key instead.`,
        );
      return { ...empty, valueText: value.trim() };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return wrong('a non-number');
      return { ...empty, valueNum: value };
    }
    case 'bool': {
      if (typeof value !== 'boolean') return wrong('a non-boolean');
      return { ...empty, valueBool: value };
    }
    case 'timestamp': {
      const ts = value instanceof Date ? value : new Date(String(value));
      if (Number.isNaN(ts.getTime())) return wrong('an unparseable timestamp');
      return { ...empty, valueTs: ts };
    }
    case 'ref_issue':
    case 'ref_user':
    case 'ref_comment': {
      if (typeof value !== 'string' || !UUID_RE.test(value)) return wrong('a non-uuid');
      return { ...empty, valueRef: value };
    }
  }
}

export function checkWritable(key: string): AttributeDef {
  const def = attributeDef(key);
  if (!def)
    throw new AttributeRefusal(
      'UNREGISTERED_KEY',
      `\`${key}\` is not a registered attribute. Registered keys: ${attributeKeyList()}. A new key is a row in the registry, not a free-form field.`,
    );
  return def;
}

function attributeKeyList(): string {
  return writableKeys().join(', ');
}

export function checkObligationPair(writes: readonly AttributeWrite[]): void {
  const hasObligation = writes.some((w) => w.key === 'obligation');
  const hasOwner = writes.some(
    (w) => w.key === 'obligation_owner' || w.key === 'obligation_carrier',
  );
  if (hasObligation && !hasOwner)
    throw new AttributeRefusal(
      'OBLIGATION_UNOWNED',
      'An `obligation` was written with neither `obligation_owner` nor `obligation_carrier`. Name who owes it — a person, or the issue that carries it forward. An obligation nobody owns is not recorded, it is lost.',
    );
}

export interface AttributeExecutor {
  insert: (table: typeof issueAttributes) => {
    values: (rows: (typeof issueAttributes.$inferInsert)[]) => PromiseLike<unknown>;
  };
  delete: (table: typeof issueAttributes) => {
    where: (w: SQL | undefined) => PromiseLike<unknown>;
  };
}

export async function writeAttributes(
  writes: readonly AttributeWrite[],
  tx: AttributeExecutor,
): Promise<number> {
  if (writes.length === 0) return 0;
  checkObligationPair(writes);

  const rows = writes.map((w) => {
    const def = checkWritable(w.key);
    return {
      def,
      row: {
        issueId: w.issueId,
        key: w.key,
        ...columnsFor(def, w.value),
        sourceCommentId: w.sourceCommentId ?? null,
        assertedByUserId: w.assertedByUserId ?? null,
      },
    };
  });

  for (const { def, row } of rows) {
    if (def.cardinality === 'one')
      await tx
        .delete(issueAttributes)
        .where(and(eq(issueAttributes.issueId, row.issueId), eq(issueAttributes.key, row.key)));
  }
  await tx.insert(issueAttributes).values(rows.map((r) => r.row));
  return rows.length;
}
