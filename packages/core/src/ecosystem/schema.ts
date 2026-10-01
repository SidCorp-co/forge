import { z } from 'zod';
import { SCHEMA_BASE, sized, slug, unique, uuid } from '../project-config/schema.js';

export const DOCUMENT_TYPES = [
  'change-notice',
  'acknowledgement',
  'rfi',
  'change-request',
  'decision',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const CONTRACT_TYPES = [
  'openapi',
  'asyncapi',
  'mcp-tools',
  'json-schema',
  'graphql',
  'protobuf',
  'opaque',
] as const;

export const MEMBERSHIP_STATES = ['invited', 'active', 'declined', 'left', 'removed'] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

export const VISIBILITY_MODES = ['counterparties', 'all'] as const;
export type VisibilityMode = (typeof VISIBILITY_MODES)[number];

const replyDays = () => z.number().int().min(1).max(90);
const gateMode = () => z.enum(['publish', 'approve']);
const timestamp = () => z.iso.datetime({ offset: true });

export const ecosystemDocumentSchema = z.strictObject({
  $schema: z.literal(`${SCHEMA_BASE}/ecosystem-v1.json`),
  version: z.literal(1),
  ecosystem: z.strictObject({
    id: uuid(),
    slug: slug(),
    name: z.string().min(1).max(120),
    purpose: z.string().min(1).max(1000).optional(),
    steward: uuid(),
  }),
  channel: z.strictObject({
    code: z.string().regex(/^[A-Z][A-Z0-9]{1,5}$/),
    responseDays: z.strictObject({
      'change-notice': replyDays(),
      rfi: replyDays(),
      'change-request': replyDays(),
    }),
  }),
  gate: z.strictObject({
    'change-notice': gateMode(),
    acknowledgement: gateMode(),
    rfi: gateMode(),
    'change-request': gateMode(),
    decision: gateMode(),
  }),
  visibility: z.strictObject({ members: z.enum(VISIBILITY_MODES) }),
});

export type EcosystemDocument = z.infer<typeof ecosystemDocumentSchema>;

// cm:why JSON Schema's keyword is `then`, which biome refuses as an object-literal key.
const ifThen = (condition: object, consequence: object, alternative?: object): object =>
  Object.fromEntries([
    ['if', condition],
    ['then', consequence],
    ...(alternative ? [['else', alternative]] : []),
  ]);

const DECIDED = ['active', 'declined', 'left', 'removed'] as const;
const ENDED = ['left', 'removed'] as const;

// cm:why zod emits no if/then: the refine holds the rule and the meta makes the emitted schema say it.
export const membershipDocumentSchema = z
  .strictObject({
    $schema: z.literal(`${SCHEMA_BASE}/membership-v1.json`),
    version: z.literal(1),
    ecosystem: uuid(),
    project: uuid(),
    state: z.enum(MEMBERSHIP_STATES),
    invitedBy: uuid(),
    invitedAt: timestamp(),
    decidedBy: uuid().optional(),
    decidedAt: timestamp().optional(),
    endedAt: timestamp().optional(),
    endedReason: z.string().min(1).max(500).optional(),
  })
  .refine(
    (m) =>
      !(DECIDED as readonly string[]).includes(m.state) ||
      (m.decidedBy !== undefined && m.decidedAt !== undefined),
    { message: 'an accepted, declined or ended membership names who decided it and when' },
  )
  .refine(
    (m) =>
      !(ENDED as readonly string[]).includes(m.state) ||
      (m.endedAt !== undefined && m.endedReason !== undefined),
    { message: 'a membership that was left or removed carries when and why' },
  )
  .meta({
    allOf: [
      ifThen(
        { properties: { state: { enum: ['active', 'declined'] } } },
        { required: ['decidedBy', 'decidedAt'] },
      ),
      ifThen(
        { properties: { state: { enum: [...ENDED] } } },
        { required: ['decidedBy', 'decidedAt', 'endedAt', 'endedReason'] },
      ),
    ],
  });

export type MembershipDocument = z.infer<typeof membershipDocumentSchema>;

export const CONTRACT_REF = /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})$/;

const publicationSchema = z
  .strictObject({
    title: z.string().min(1).max(120),
    summary: z.string().min(1).max(1000).optional(),
    type: z.enum(CONTRACT_TYPES),
    artifact: z.union([
      z.strictObject({ path: z.string().regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9._/-]+$/) }),
      z.strictObject({ upload: z.literal(true) }),
      z.null(),
    ]),
    lifecycle: z.enum(['experimental', 'production', 'deprecated']),
    ecosystems: unique(z.array(uuid()).min(1).max(10)),
    implementedBy: unique(z.array(slug()).max(20)).optional(),
  })
  .meta({
    allOf: [
      ifThen(
        { properties: { type: { const: 'opaque' } } },
        { properties: { artifact: { type: 'null' } } },
        { properties: { artifact: { type: 'object' } } },
      ),
    ],
  });

export type Publication = z.infer<typeof publicationSchema>;

const consumptionSchema = z.strictObject({
  contract: z.string().regex(CONTRACT_REF),
  ecosystem: uuid(),
  builtAgainst: z.string().min(1).max(40),
  usedBy: unique(z.array(slug()).max(20)).optional(),
  elements: unique(z.array(z.string().min(1).max(200)).max(200)).optional(),
});

export const interfaceDocumentSchema = z.strictObject({
  $schema: z.literal(`${SCHEMA_BASE}/interface-v1.json`),
  version: z.literal(1),
  project: uuid(),
  publishes: sized(z.record(slug(), publicationSchema), { max: 20 }),
  consumes: z.array(consumptionSchema).max(50),
  commitments: z.strictObject({
    versioning: z.enum(['dated', 'semver']),
    deprecationNoticeDays: z.number().int().min(0).max(365),
    responseDays: z.strictObject({ rfi: replyDays(), 'change-request': replyDays() }),
  }),
});

export type InterfaceDocument = z.infer<typeof interfaceDocumentSchema>;
