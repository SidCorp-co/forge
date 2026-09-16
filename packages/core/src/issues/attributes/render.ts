import { attributeDef } from './registry.js';

export interface AttributeRow {
  readonly key: string;
  readonly valueText: string | null;
  readonly valueNum: number | null;
  readonly valueBool: boolean | null;
  readonly valueTs: Date | null;
  readonly valueRef: string | null;
  readonly sourceCommentId: string | null;
  readonly assertedByUserId: string | null;
  readonly assertedAt: Date;
}

export interface RenderedAttribute {
  readonly key: string;
  readonly label: string;
  readonly valueType: string;
  readonly value: string | number | boolean | null;
  readonly ref: string | null;
  readonly sourceCommentId: string | null;
  readonly assertedAt: string;
}

export function renderAttribute(row: AttributeRow, labels: Map<string, string>): RenderedAttribute {
  const def = attributeDef(row.key);
  const value =
    row.valueRef != null
      ? (labels.get(row.valueRef) ?? row.valueRef)
      : (row.valueText ?? row.valueNum ?? row.valueBool ?? row.valueTs?.toISOString() ?? null);
  return {
    key: row.key,
    label: def?.label ?? row.key,
    valueType: def?.valueType ?? 'text',
    value,
    ref: row.valueRef,
    sourceCommentId: row.sourceCommentId,
    assertedAt: row.assertedAt.toISOString(),
  };
}
