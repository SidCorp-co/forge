import { PERSON_VIAS } from '@forge/contracts/ecosystem';
import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { z } from 'zod';
import { unique, uuid } from '../project-config/index.js';
import type { DocumentType } from './schema.js';

export const DOCUMENT_SCHEMA_ID = `${SCHEMA_BASE}/document-v1.json`;
export const HOLD_SCHEMA_ID = `${SCHEMA_BASE}/hold-v1.json`;

export const TYPE_ABBREVIATIONS: Readonly<Record<DocumentType, string>> = {
  'change-notice': 'CN',
  acknowledgement: 'ACK',
  rfi: 'RFI',
  'change-request': 'CR',
  decision: 'DEC',
};

const DOCUMENT_STATES = [
  'draft',
  'submitted',
  'returned',
  'published',
  'withdrawn',
  'superseded',
] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];

export const NUMBER_PATTERN = /^[A-Z][A-Z0-9]{1,5}-(CN|ACK|RFI|CR|DEC)-[1-9][0-9]{0,5}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THREAD_PATTERN = /^[A-Z][A-Z0-9]{1,5}-(CN|RFI|CR)-[1-9][0-9]*$/;
const CONTRACT_REF = /^[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/;

const docNumber = () => z.string().regex(NUMBER_PATTERN);
const date = () => z.iso.date();
const timestamp = () => z.iso.datetime({ offset: true });
const prose = () => z.string().min(1).max(4000);
const element = () => z.string().min(1).max(200);
const contractRef = () => z.string().regex(CONTRACT_REF);

export const authorSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('agent'),
    id: z.string().min(1).max(100),
    via: z.literal('master'),
  }),
  z.strictObject({
    kind: z.literal('person'),
    id: z.string().min(1).max(100),
    via: z.enum(PERSON_VIAS),
  }),
]);
export type Author = z.infer<typeof authorSchema>;
export type PersonVia = Extract<Author, { kind: 'person' }>['via'];

const exampleSchema = z.strictObject({
  element: element(),
  direction: z.enum(['request', 'response', 'event', 'tool-input', 'tool-output']),
  status: z.number().int().min(100).max(599).optional(),
  payload: z.unknown(),
});

export const CLASSIFICATIONS = ['breaking', 'non-breaking', 'unknown'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

const changeNoticeBody = z.strictObject({
  contract: contractRef(),
  contractVersion: z.string().min(1).max(40),
  classification: z.enum(CLASSIFICATIONS),
  binding: z.boolean(),
  effectiveOn: date(),
  deprecation: z
    .strictObject({
      elements: unique(z.array(element()).min(1).max(100)),
      deprecatedOn: date(),
      sunsetOn: date(),
      replacement: prose().optional(),
    })
    .optional(),
  summary: prose(),
  changes: z
    .array(
      z.strictObject({
        element: element(),
        kind: z.enum(['added', 'removed', 'changed', 'deprecated']),
        text: prose(),
      }),
    )
    .min(1)
    .max(200),
  migration: prose(),
  examples: z.array(exampleSchema).max(10).optional(),
  requestedBy: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,5}-CR-[1-9][0-9]{0,5}$/)
    .optional(),
});

const blockedOn = z
  .array(z.strictObject({ element: element(), reason: prose() }))
  .min(1)
  .max(20);
const ackShared = { adaptBy: date().optional(), note: prose().optional() };
const acknowledgementBody = z.discriminatedUnion('disposition', [
  z.strictObject({
    disposition: z.literal('no-impact'),
    evidence: prose(),
    blockedOn: blockedOn.optional(),
    ...ackShared,
  }),
  z.strictObject({
    disposition: z.literal('will-adapt'),
    ...ackShared,
    adaptBy: date(),
    blockedOn: blockedOn.optional(),
    evidence: prose().optional(),
  }),
  z.strictObject({
    disposition: z.literal('blocked'),
    blockedOn,
    evidence: prose().optional(),
    ...ackShared,
  }),
]);

const rfiBody = z.strictObject({
  question: prose(),
  references: z
    .array(
      z.strictObject({
        contract: contractRef(),
        contractVersion: z.string().max(40).optional(),
        element: element(),
      }),
    )
    .min(1)
    .max(20),
  proposedReading: prose().optional(),
  reason: prose(),
  examples: z.array(exampleSchema).max(5).optional(),
});

const changeRequestBody = z.strictObject({
  contract: contractRef(),
  need: prose(),
  rationale: prose(),
  impactIfDeclined: prose(),
  urgency: z.enum(['low', 'normal', 'high', 'critical']),
  examples: z.array(exampleSchema).max(5).optional(),
  relatesTo: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{1,5}-(CN|ACK|RFI)-[1-9][0-9]{0,5}$/)
    .optional(),
});

const decisionShared = {
  reason: prose(),
  answer: prose().optional(),
  conditions: prose().optional(),
  plannedVersion: z.string().max(40).optional(),
  plannedOn: date().optional(),
  revisitOn: date().optional(),
};
const decisionBody = z.discriminatedUnion('disposition', [
  z.strictObject({ ...decisionShared, disposition: z.literal('accepted'), plannedOn: date() }),
  z.strictObject({
    ...decisionShared,
    disposition: z.literal('accepted-with-conditions'),
    conditions: prose(),
    plannedOn: date(),
  }),
  z.strictObject({ ...decisionShared, disposition: z.literal('declined') }),
  z.strictObject({ ...decisionShared, disposition: z.literal('deferred'), revisitOn: date() }),
  z.strictObject({ ...decisionShared, disposition: z.literal('answered'), answer: prose() }),
]);

const gateSchema = z.strictObject({
  mode: z.enum(['publish', 'approve']),
  decision: z.enum(['approved', 'returned']).optional(),
  decidedBy: uuid().optional(),
  decidedAt: timestamp().optional(),
  note: z.string().max(1000).optional(),
});
export type Gate = z.infer<typeof gateSchema>;

const envelope = {
  $schema: z.literal(DOCUMENT_SCHEMA_ID),
  version: z.literal(1),
  id: uuid(),
  number: docNumber().nullable().optional(),
  ecosystem: uuid(),
  from: uuid(),
  to: unique(z.array(uuid()).min(1).max(50)),
  inReplyTo: docNumber().nullable().optional(),
  subject: z.string().min(8).max(160),
  dueBy: date().optional(),
  state: z.enum(DOCUMENT_STATES),
  authoredBy: authorSchema,
  gate: gateSchema.optional(),
  publishedAt: timestamp().optional(),
  supersededBy: docNumber().optional(),
  withdrawnReason: z.string().min(1).max(500).optional(),
};

const answers = { inReplyTo: docNumber().nullable() };
const owesDue = { dueBy: date() };

// cm:why JSON Schema's keyword is `then`, which biome refuses as an object-literal key.
const ifThen = (condition: object, consequence: object): object =>
  Object.fromEntries([
    ['if', { type: 'object', ...condition }],
    ['then', { type: 'object', ...consequence }],
  ]);

const STATE_NEEDS: readonly [readonly DocumentState[], readonly string[]][] = [
  [['published'], ['number', 'publishedAt', 'gate']],
  [['superseded'], ['number', 'supersededBy']],
  [['withdrawn'], ['number', 'withdrawnReason']],
  [
    ['submitted', 'returned'],
    ['number', 'gate'],
  ],
];

// cm:why zod emits no if/then: the superRefine holds the state rules and the meta makes the emitted schema say them.
export const documentSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      ...envelope,
      type: z.literal('change-notice'),
      body: changeNoticeBody,
    }),
    z.strictObject({
      ...envelope,
      ...answers,
      type: z.literal('acknowledgement'),
      body: acknowledgementBody,
    }),
    z.strictObject({ ...envelope, ...owesDue, type: z.literal('rfi'), body: rfiBody }),
    z.strictObject({
      ...envelope,
      ...owesDue,
      type: z.literal('change-request'),
      body: changeRequestBody,
    }),
    z.strictObject({ ...envelope, ...answers, type: z.literal('decision'), body: decisionBody }),
  ])
  .superRefine((d, ctx) => {
    const held = d as Record<string, unknown>;
    for (const [states, keys] of STATE_NEEDS) {
      if (!states.includes(d.state)) continue;
      for (const key of keys) {
        if (held[key] === undefined || held[key] === null) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `a ${d.state} document carries ${key}`,
          });
        }
      }
    }
    if (
      (d.state === 'submitted' || d.state === 'returned') &&
      d.gate &&
      d.gate.mode !== 'approve'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['gate', 'mode'],
        message: `a ${d.state} document is held at an approve gate; a publish gate never holds one`,
      });
    }
  })
  .meta({
    allOf: [
      ...STATE_NEEDS.map(([states, keys]) =>
        ifThen(
          { properties: { state: { enum: [...states] } } },
          {
            required: [...keys],
            properties: { ...(keys.includes('number') ? { number: { type: 'string' } } : {}) },
          },
        ),
      ),
      ifThen(
        { properties: { state: { enum: ['submitted', 'returned'] } } },
        { properties: { gate: { type: 'object', properties: { mode: { const: 'approve' } } } } },
      ),
    ],
  });

export type ChannelDocument = z.infer<typeof documentSchema>;

export const HOLD_ACTIONS = ['hold', 'release'] as const;
export type HoldAction = (typeof HOLD_ACTIONS)[number];

export const holdSchema = z
  .strictObject({
    $schema: z.literal(HOLD_SCHEMA_ID),
    version: z.literal(1),
    id: uuid(),
    ecosystem: uuid(),
    thread: z.string().regex(THREAD_PATTERN),
    action: z.enum(HOLD_ACTIONS),
    by: authorSchema,
    side: uuid(),
    at: timestamp(),
    reason: z.string().max(1000).regex(/\S/).optional(),
  })
  .refine((h) => h.action !== 'hold' || h.reason !== undefined, {
    path: ['reason'],
    message: 'a hold says why',
  })
  .meta({
    allOf: [ifThen({ properties: { action: { const: 'hold' } } }, { required: ['reason'] })],
  });

export type ThreadHold = z.infer<typeof holdSchema>;
