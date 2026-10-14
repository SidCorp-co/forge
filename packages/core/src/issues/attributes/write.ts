import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issueAttributes, singleRowKeys } from '../../db/schema.js';
import { type AttributeDef, attributeDef, writableKeys } from './registry.js';

export type AttributeValue = string | number | boolean | Date;

export interface AttributeWrite {
  readonly issueId: string;
  readonly key: string;
  readonly value: AttributeValue;
  readonly sourceCommentId?: string | null;
  readonly assertedByUserId?: string | null;
}

/**
 * Every way a write is refused, by name. One list, because the writer owns all
 * of them and a door renders whatever it is handed (ISS-1158) — a code here
 * that no door maps is a refusal a caller reads as an unexplained failure.
 */
export type AttributeRefusalCode =
  | 'UNREGISTERED_KEY'
  | 'WRONG_TYPE'
  | 'OBLIGATION_UNOWNED'
  | 'EMPTY_TEXT'
  | 'SOURCE_COMMENT_NOT_FOUND'
  | 'SOURCE_COMMENT_OFF_ISSUE'
  | 'DUPLICATE_SINGLE_KEY';

export class AttributeRefusal extends Error {
  constructor(
    readonly code: AttributeRefusalCode,
    message: string,
    /** What the refusal names, for a door that renders structured errors. */
    readonly details?: unknown,
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

/** What the writer needs of a transaction: the one door every row goes through. */
export type AttributeExecutor = Pick<Tx, 'insert'>;

/** A single-row key named twice for one issue in one batch has no second row to land on, so it is refused rather than left to the later value. */
function refuseRepeatedSingleRowKey(
  rows: readonly { def: AttributeDef; row: { issueId: string; key: string } }[],
): void {
  const seen = new Set<string>();
  for (const { def, row } of rows) {
    if (def.cardinality !== 'one') continue;
    const at = `${row.issueId}\u0000${row.key}`;
    if (seen.has(at))
      throw new AttributeRefusal(
        'DUPLICATE_SINGLE_KEY',
        `\`${row.key}\` holds one row per issue and this batch names it twice for issue ${row.issueId}. Send the one value you mean.`,
        { key: row.key, issueId: row.issueId },
      );
    seen.add(at);
  }
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
  refuseRepeatedSingleRowKey(rows);

  const many = rows.filter((r) => r.def.cardinality !== 'one').map((r) => r.row);
  const single = rows.filter((r) => r.def.cardinality === 'one').map((r) => r.row);
  if (many.length > 0) await tx.insert(issueAttributes).values(many);
  if (single.length > 0)
    await tx
      .insert(issueAttributes)
      .values(single)
      .onConflictDoUpdate({
        target: [issueAttributes.issueId, issueAttributes.key],
        targetWhere: singleRowKeys(issueAttributes.key),
        set: {
          valueText: sql`excluded.value_text`,
          valueNum: sql`excluded.value_num`,
          valueBool: sql`excluded.value_bool`,
          valueTs: sql`excluded.value_ts`,
          valueRef: sql`excluded.value_ref`,
          sourceCommentId: sql`excluded.source_comment_id`,
          assertedByUserId: sql`excluded.asserted_by_user_id`,
          assertedAt: sql`now()`,
        },
      });
  return rows.length;
}
