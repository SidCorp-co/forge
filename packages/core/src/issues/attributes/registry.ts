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

// cm:guard The seed, not the schema, is where a key is added — that is the whole of "open set of keys". Adding one here plus a migration row costs no table change; adding a column instead defeats the design (ISS-1010).
// cm:edge lockstep -> packages/core/drizzle/migrations/0245_issue_attributes.sql — the migration seeds exactly these rows; a key added here with no seed row is refused at every write with "unregistered".
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
    // cm:guard Required WITH `obligation`, not on its own: an obligation nobody owns is how steps 2-5 of ISS-1002 fell out of sight. Paired-required is checked in write.ts, which is the only place that sees both.
    required: true,
  },
  {
    key: 'obligation_carrier',
    label: 'Carried by',
    valueType: 'ref_issue',
    cardinality: 'one',
    writtenBy: 'agent',
    // cm:why The other legal answer to "who owes it": not a person but the issue the work moved to. ISS-1002 owed steps 2-5 and the answer was ISS-1004, which `obligation_owner` alone cannot say.
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
    // cm:why The interrupt bar's enforceable half: a question that cannot name what becomes irreversible is a question the agent should have answered itself (ISS-1010).
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
