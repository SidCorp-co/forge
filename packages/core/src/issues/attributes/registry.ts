import { singleRowAttributeKeys } from '../../db/issue-vocabulary.js';
import type { AttributeValueType, AttributeWriter } from '../../db/schema.js';

export interface AttributeDef {
  readonly key: string;
  readonly label: string;
  readonly valueType: AttributeValueType;
  readonly cardinality: 'one' | 'many';
  readonly writtenBy: AttributeWriter;
  readonly surfaces: readonly string[];
  readonly required: boolean;
}

type AttributeDeclaration = Omit<AttributeDef, 'cardinality'>;

const DECLARED: readonly AttributeDeclaration[] = [
  {
    key: 'obligation',
    label: 'Outstanding',
    valueType: 'text',
    writtenBy: 'agent',
    surfaces: ['state', 'exception'],
    required: false,
  },
  {
    key: 'obligation_owner',
    label: 'Owed by',
    valueType: 'ref_user',
    writtenBy: 'agent',
    surfaces: ['state'],
    required: true,
  },
  {
    key: 'obligation_carrier',
    label: 'Carried by',
    valueType: 'ref_issue',
    writtenBy: 'agent',
    surfaces: ['state'],
    required: false,
  },
  {
    key: 'delivered',
    label: 'Delivered',
    valueType: 'number',
    writtenBy: 'agent',
    surfaces: ['state', 'pulse'],
    required: false,
  },
  {
    key: 'delivered_of',
    label: 'Of',
    valueType: 'number',
    writtenBy: 'agent',
    surfaces: ['state', 'pulse'],
    required: false,
  },
  {
    key: 'human_required',
    label: 'Needs a person',
    valueType: 'bool',
    writtenBy: 'agent',
    surfaces: ['state', 'exception'],
    required: false,
  },
  {
    key: 'irreversible_if_wrong',
    label: 'Irreversible if wrong',
    valueType: 'text',
    writtenBy: 'agent',
    surfaces: ['decision'],
    required: false,
  },
  {
    key: 'source',
    label: 'Source',
    valueType: 'ref_comment',
    writtenBy: 'agent',
    surfaces: ['evidence'],
    required: false,
  },
];

const SINGLE_ROW: ReadonlySet<string> = new Set(singleRowAttributeKeys);

/** A key is single-row exactly when `singleRowAttributeKeys` lists it, the list the unique index is built from. */
export const ATTRIBUTE_REGISTRY: readonly AttributeDef[] = DECLARED.map((d) => ({
  ...d,
  cardinality: SINGLE_ROW.has(d.key) ? 'one' : 'many',
}));

const BY_KEY = new Map(ATTRIBUTE_REGISTRY.map((d) => [d.key, d]));

export function attributeDef(key: string): AttributeDef | undefined {
  return BY_KEY.get(key);
}

export function writableKeys(): readonly string[] {
  return ATTRIBUTE_REGISTRY.map((d) => d.key);
}
