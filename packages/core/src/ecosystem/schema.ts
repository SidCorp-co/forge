import { PROVIDER_LIVE_MODES } from '@forge/contracts/contract-waits';
import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { z } from 'zod';
import { sized, slug, unique, uuid } from '../project-config/index.js';

export const DOCUMENT_TYPES = [
  'change-notice',
  'acknowledgement',
  'rfi',
  'change-request',
  'decision',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

const CONTRACT_TYPES = [
  'openapi',
  'asyncapi',
  'mcp-tools',
  'json-schema',
  'graphql',
  'protobuf',
  'opaque',
] as const;

const MEMBERSHIP_STATES = ['invited', 'active', 'declined', 'left', 'removed'] as const;
export type MembershipState = (typeof MEMBERSHIP_STATES)[number];

const VISIBILITY_MODES = ['counterparties', 'all'] as const;
export type VisibilityMode = (typeof VISIBILITY_MODES)[number];

const replyDays = () => z.number().int().min(1).max(90);
const gateMode = () => z.enum(['publish', 'approve']);
const timestamp = () => z.iso.datetime({ offset: true });

const ecosystemFields = <I extends z.ZodType>(id: I) => ({
  $schema: z.literal(`${SCHEMA_BASE}/ecosystem-v1.json`),
  version: z.literal(1),
  ecosystem: z.strictObject({
    id,
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
  // absent is `required`: a consumer's production release waits for its provider to serve the
  // version it waits on unless the ecosystem turns that off (E4)
  releases: z.strictObject({ providerLive: z.enum(PROVIDER_LIVE_MODES) }).optional(),
});

// cm:why core assigns an ecosystem its id, so the id is core's to write: a create carries none and an update carries the one core assigned (`ecosystem-service.ts:parseEcosystem` refuses either otherwise as ECOSYSTEM_ID_IMMUTABLE). The written shape is what ecosystem-v1.json publishes, so the schema a client authors against never asks for an id a create refuses.
const ECOSYSTEM_ID_RULE =
  'assigned by core: leave it out when creating; when updating, it is the id core assigned and never changes';

export const ecosystemWriteSchema = z.strictObject(
  ecosystemFields(uuid().optional().meta({ description: ECOSYSTEM_ID_RULE })),
);

export const ecosystemDocumentSchema = z.strictObject(ecosystemFields(uuid()));

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
    artifact: z.strictObject({ upload: z.literal(true) }).nullable(),
    lifecycle: z.enum(['experimental', 'production', 'deprecated']),
    // cm:why zero ecosystems is an in-project contract: the project's own modules consume it (Q11, 2026-10-03) and no other project can, since a cross-project consumption names an ecosystem the contract is published in
    ecosystems: unique(z.array(uuid()).max(10)),
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

// cm:why a consumption with no ecosystem is in-project — the project consuming its own contract; one of another project's contract always names the ecosystem both share (`interface-rules.ts:consumptionRefusals`)
const consumptionSchema = z.strictObject({
  contract: z.string().regex(CONTRACT_REF),
  ecosystem: uuid().optional(),
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
