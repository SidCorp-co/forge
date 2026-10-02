import { z } from 'zod';
import {
  SCHEMA_BASE,
  type STOREFRONT_PROVIDERS,
  slug,
  unique,
  uuid,
} from '../project-config/schema.js';

type StorefrontProvider = (typeof STOREFRONT_PROVIDERS)[number];

export const LINK_SCHEMA_ID = `${SCHEMA_BASE}/link-v1.json`;
export const BUILDER_RUN_SCHEMA_ID = `${SCHEMA_BASE}/builder-run-v1.json`;

export const LINK_STATES = ['building', 'current', 'behind', 'breaking', 'unverified'] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const BUILDER_TRIGGERS = ['joined', 'push', 'manual'] as const;
export const STEP_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'superseded',
] as const;
export const FINDING_CLASSIFICATIONS = ['matched', 'outside_ecosystem', 'unknown'] as const;

export const LIMITS = {
  path: 400,
  artefactId: 200,
  operation: 200,
  field: 200,
  note: 280,
  callSites: 500,
  fieldsUsed: 500,
  outsideContract: 100,
  notes: 20,
  steps: 50,
  reason: 1000,
  findings: 1000,
  links: 500,
} as const;

// cm:why a segment is anything but a separator, a backslash or a control character, and never `.` or `..`: the path names a file inside the checkout, so it neither starts at a root nor climbs out of one
export const REPO_PATH =
  /^(?![A-Za-z]:)(?!(?:.*\/)?\.{1,2}(?:\/|$))[^/\\\p{Cc}]+(?:\/[^/\\\p{Cc}]+)*$/u;
const SHA = /^[0-9a-f]{40}$/;
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const timestamp = () => z.iso.datetime({ offset: true });
const sha = () => z.string().regex(SHA);
export const REPO_PATH_MESSAGE =
  'a repository-relative path: no leading `/` or drive, no `.` or `..` segment, no empty segment, no backslash';
export const repoPath = () =>
  z.string().min(1).max(LIMITS.path).regex(REPO_PATH, { message: REPO_PATH_MESSAGE });
const operation = () => z.string().min(1).max(LIMITS.operation);

/** The artefacts a storefront provider holds, which a gitless consumer's call site names in place of a file. */
export const ARTEFACT_KINDS: Readonly<Partial<Record<StorefrontProvider, readonly string[]>>> = {
  autoflow: ['workflow', 'route', 'node'],
};

const CALL_SITE_SHAPE =
  'a call site names either a repository path and line (a git consumer) or a storefront artefact (a storefront consumer), exactly one of the two';

// cm:why one site, two readings: a git consumer's code is a file and a line, a storefront consumer's is an artefact the provider holds; which one the consumer may write is its source type's, checked in `link-rules.ts:callSiteRefusals`
export const callSiteSchema = z
  .strictObject({
    path: repoPath().optional(),
    line: z.number().int().min(1).max(10_000_000).optional(),
    artefact: z
      .strictObject({ kind: slug(), id: z.string().min(1).max(LIMITS.artefactId) })
      .optional(),
    operation: operation(),
  })
  .refine(
    (s) =>
      s.artefact === undefined
        ? s.path !== undefined && s.line !== undefined
        : s.path === undefined && s.line === undefined,
    { message: CALL_SITE_SHAPE },
  )
  .meta({
    oneOf: [
      { required: ['path', 'line'], not: { required: ['artefact'] } },
      { required: ['artefact'], not: { anyOf: [{ required: ['path'] }, { required: ['line'] }] } },
    ],
  });
export type CallSite = z.infer<typeof callSiteSchema>;

export const callSiteAt = (s: CallSite): string =>
  s.artefact ? `${s.artefact.kind}:${s.artefact.id}` : `${s.path}:${s.line}`;

const contractRefSchema = z.strictObject({ provider: uuid(), slug: slug() });

const linkFields = {
  $schema: z.literal(LINK_SCHEMA_ID),
  version: z.literal(1),
  ecosystem: uuid(),
  consumer: z.strictObject({ project: uuid(), module: repoPath() }),
  contract: contractRefSchema,
  pinnedVersion: z.string().min(1).max(40),
  state: z.enum(LINK_STATES),
  callSites: z.array(callSiteSchema).max(LIMITS.callSites),
  fieldsUsed: unique(z.array(z.string().min(1).max(LIMITS.field)).max(LIMITS.fieldsUsed)),
  outsideContract: unique(z.array(operation()).max(LIMITS.outsideContract)),
  notes: z.array(z.string().min(1).max(LIMITS.note)).max(LIMITS.notes),
  writtenBy: z.strictObject({ runId: uuid().optional(), sessionId: uuid().optional(), sha: sha() }),
  refreshedAtSha: sha(),
};

export const linkWriteSchema = z.strictObject(linkFields);
export type LinkWrite = z.infer<typeof linkWriteSchema>;

export const linkDocumentSchema = z.strictObject({
  ...linkFields,
  id: uuid(),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});
export type LinkDocument = z.infer<typeof linkDocumentSchema>;

const findingSite = { site: callSiteSchema };

export const findingSchema = z.discriminatedUnion('classification', [
  z.strictObject({
    classification: z.literal('matched'),
    ...findingSite,
    contract: contractRefSchema,
  }),
  z.strictObject({
    classification: z.literal('outside_ecosystem'),
    ...findingSite,
    host: z.string().regex(HOST),
  }),
  z.strictObject({
    classification: z.literal('unknown'),
    ...findingSite,
    note: z.string().min(1).max(LIMITS.note).optional(),
  }),
]);
export type Finding = z.infer<typeof findingSchema>;

const stepSchema = z.strictObject({
  name: slug(),
  status: z.enum(STEP_STATUSES),
  detail: z.string().min(1).max(1000).optional(),
});

// cm:why a repository run names the commit it reads; a storefront has no commit, so its run says where it reads instead of a sha that names nothing (never git's empty tree)
const triggerSchema = z
  .strictObject({
    kind: z.enum(BUILDER_TRIGGERS),
    sha: sha().nullable(),
    source: z.literal('storefront').optional(),
  })
  .refine((t) => (t.sha === null) === (t.source === 'storefront'), {
    message:
      'a trigger names a 40-hex commit sha, or sha null with source "storefront" for a storefront project; never both, never neither',
    path: ['sha'],
  });

const builderRunFields = {
  $schema: z.literal(BUILDER_RUN_SCHEMA_ID),
  version: z.literal(1),
  ecosystem: uuid(),
  project: uuid(),
  trigger: triggerSchema,
  steps: z
    .array(stepSchema)
    .min(1)
    .max(LIMITS.steps)
    .refine((steps) => new Set(steps.map((s) => s.name)).size === steps.length, {
      message: 'each step is named once',
    }),
  findings: z.array(findingSchema).max(LIMITS.findings),
  links: unique(z.array(uuid()).max(LIMITS.links)),
  supersededBy: z
    .strictObject({ run: uuid(), reason: z.string().trim().min(1).max(LIMITS.reason) })
    .optional(),
};

// cm:why a superseded run says so twice, in the run (who replaced it and why) and in each step it never reached; one without the other is refused, so neither reading can disagree with the other
const supersededAgrees = (doc: {
  steps: { status: string }[];
  supersededBy?: unknown;
}): boolean => {
  const marked = doc.steps.some((s) => s.status === 'superseded');
  const open = doc.steps.some((s) => s.status === 'pending' || s.status === 'running');
  return doc.supersededBy === undefined ? !marked : marked && !open;
};

const SUPERSEDED_MESSAGE =
  'a step is superseded exactly when the run names supersededBy, and a superseded run has no step pending or running';

export const builderRunWriteSchema = z
  .strictObject(builderRunFields)
  .refine(supersededAgrees, { message: SUPERSEDED_MESSAGE, path: ['supersededBy'] });
export type BuilderRunWrite = z.infer<typeof builderRunWriteSchema>;

export const builderRunDocumentSchema = z
  .strictObject({
    ...builderRunFields,
    id: uuid(),
    createdAt: timestamp(),
    updatedAt: timestamp(),
  })
  .refine(supersededAgrees, { message: SUPERSEDED_MESSAGE, path: ['supersededBy'] });
export type BuilderRunDocument = z.infer<typeof builderRunDocumentSchema>;
