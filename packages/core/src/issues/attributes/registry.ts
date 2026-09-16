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

export const ATTRIBUTE_REGISTRY: readonly AttributeDef[] = [
  {
    key: 'obligation',
    label: 'Outstanding',
    valueType: 'text',
    cardinality: 'many',
    writtenBy: 'agent',
    surfaces: ['state', 'exception'],
    required: false,
  },
  {
    key: 'obligation_owner',
    label: 'Owed by',
    valueType: 'ref_user',
    cardinality: 'one',
    writtenBy: 'agent',
    surfaces: ['state'],
    required: true,
  },
  {
    key: 'obligation_carrier',
    label: 'Carried by',
    valueType: 'ref_issue',
    cardinality: 'one',
    writtenBy: 'agent',
    surfaces: ['state'],
    required: false,
  },
  {
    key: 'delivered',
    label: 'Delivered',
    valueType: 'number',
    cardinality: 'one',
    writtenBy: 'agent',
    surfaces: ['state', 'pulse'],
    required: false,
  },
  {
    key: 'delivered_of',
    label: 'Of',
    valueType: 'number',
    cardinality: 'one',
    writtenBy: 'agent',
    surfaces: ['state', 'pulse'],
    required: false,
  },
  {
    key: 'blocking',
    label: 'Blocking',
    valueType: 'ref_issue',
    cardinality: 'many',
    writtenBy: 'agent',
    surfaces: ['state'],
    required: false,
  },
  {
    key: 'supersedes',
    label: 'Supersedes',
    valueType: 'ref_issue',
    cardinality: 'one',
    writtenBy: 'agent',
    surfaces: ['state'],
    required: false,
  },
  {
    key: 'human_required',
    label: 'Needs a person',
    valueType: 'bool',
    cardinality: 'one',
    writtenBy: 'agent',
    surfaces: ['state', 'exception'],
    required: false,
  },
  {
    key: 'irreversible_if_wrong',
    label: 'Irreversible if wrong',
    valueType: 'text',
    cardinality: 'one',
    writtenBy: 'agent',
    surfaces: ['decision'],
    required: false,
  },
  {
    key: 'source',
    label: 'Source',
    valueType: 'ref_comment',
    cardinality: 'one',
    writtenBy: 'agent',
    surfaces: ['evidence'],
    required: false,
  },
];

const BY_KEY = new Map(ATTRIBUTE_REGISTRY.map((d) => [d.key, d]));

export function attributeDef(key: string): AttributeDef | undefined {
  return BY_KEY.get(key);
}

export function writableKeys(): readonly string[] {
  return ATTRIBUTE_REGISTRY.map((d) => d.key);
}
