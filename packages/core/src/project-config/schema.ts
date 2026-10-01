import { z } from 'zod';
import type { IssueStatus } from '../db/schema.js';
import { ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import { AUTONOMOUS_DRIVER_STATUSES } from '../pipeline/autonomous-mode.js';

export const SCHEMA_BASE = 'https://forge.sidcorp.co/schemas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
const SHORT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const GIT_REF = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]+(?<!\/)(?<!\.lock)$/;

export const uuid = () => z.string().regex(UUID);
export const slug = () => z.string().regex(SLUG);
const gitRef = () => z.string().min(1).max(200).regex(GIT_REF);
const httpsUrl = () =>
  z
    .string()
    .regex(/^https:\/\//)
    .refine((v) => URL.canParse(v), { message: 'Invalid URI' })
    .meta({ format: 'uri' });

// cm:why zod has no uniqueItems: the refine enforces it and the meta makes the emitted schema say it.
export function unique<T extends z.ZodArray<z.ZodType>>(schema: T): T {
  return schema
    .refine((items) => new Set(items.map((i) => JSON.stringify(i))).size === items.length, {
      message: 'Items must be unique',
    })
    .meta({ uniqueItems: true }) as unknown as T;
}

export function sized<T extends z.ZodType<Record<string, unknown>>>(
  schema: T,
  bounds: { min?: number; max?: number },
): T {
  const { min, max } = bounds;
  return schema
    .refine((o) => min === undefined || Object.keys(o).length >= min, {
      message: `Expected at least ${min} properties`,
    })
    .refine((o) => max === undefined || Object.keys(o).length <= max, {
      message: `Expected at most ${max} properties`,
    })
    .meta({
      ...(min === undefined ? {} : { minProperties: min }),
      ...(max === undefined ? {} : { maxProperties: max }),
    }) as unknown as T;
}

const gitSourceSchema = z.strictObject({
  type: z.literal('git'),
  git: z.strictObject({
    repository: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    defaultBranch: gitRef(),
    branches: unique(z.array(gitRef()).min(1).max(10)),
  }),
});

const storefrontSourceSchema = z.strictObject({
  type: z.literal('storefront'),
  storefront: z.strictObject({
    provider: z.enum(['epodsystem', 'shopify']),
    binding: uuid(),
  }),
});

const noSourceSchema = z.strictObject({ type: z.literal('none') });

const runtimeProbeSchema = z.strictObject({
  type: z.literal('http'),
  url: httpsUrl(),
  path: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/),
  identifies: z.enum(['source', 'artifact']),
});

export const DEPLOYMENT_TRIGGERS = ['on-land', 'on-request', 'provider'] as const;
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

const environmentSchema = z.strictObject({
  tier: z.enum(['production', 'staging', 'preview', 'dev']),
  deploysFrom: gitRef().optional(),
  deployment: z.union([
    z.strictObject({ binding: uuid(), trigger: z.enum(DEPLOYMENT_TRIGGERS) }),
    z.strictObject({ mode: z.literal('external') }),
  ]),
  services: sized(z.record(slug(), httpsUrl()), { max: 10 }).optional(),
  testing: slug().optional(),
  url: httpsUrl().optional(),
  verification: z.strictObject({ runtime: z.array(runtimeProbeSchema).min(1).max(3) }).optional(),
});

export const projectDocumentSchema = z.strictObject({
  $schema: z.literal(`${SCHEMA_BASE}/project-v1.json`),
  version: z.literal(1),
  project: z.strictObject({
    id: uuid(),
    slug: slug(),
    name: z.string().min(1).max(120),
  }),
  source: z.discriminatedUnion('type', [gitSourceSchema, storefrontSourceSchema, noSourceSchema]),
  workspace: z.strictObject({
    isolation: z.enum(['worktree', 'branch', 'remote-draft', 'none']),
    setup: z.string().min(1).max(4000).optional(),
  }),
  validation: z.strictObject({
    gate: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('github-check'), name: z.string().min(1).max(100) }),
      z.strictObject({ type: z.literal('none') }),
    ]),
  }),
  environments: sized(z.record(slug(), environmentSchema), { max: 10 }),
  promotions: unique(
    z
      .array(
        z.strictObject({
          from: gitRef(),
          to: gitRef(),
          via: z.enum(['merge', 'cherry-pick']),
        }),
      )
      .max(5),
  ),
  rollback: z.strictObject({
    strategy: z.enum([
      'revert-and-redeploy',
      'redeploy-previous',
      'restore-previous-theme',
      'none',
    ]),
  }),
  execution: z.strictObject({
    plugin: z.strictObject({
      source: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      ref: z.string().regex(/^[0-9a-f]{40}$/),
    }),
  }),
});

export type ProjectDocument = z.infer<typeof projectDocumentSchema>;
export type EnvironmentDeclaration = ProjectDocument['environments'][string];

// cm:edge naming -> packages/core/src/pipeline/autonomous-mode.ts — the driver statuses minus the
// terminal ones, not every status: nothing dispatches at `awaiting_release` or past it.
export const POLICY_STATE_STATUSES: readonly IssueStatus[] = AUTONOMOUS_DRIVER_STATUSES.filter(
  (s) => !ISSUE_TERMINAL_STATUSES.includes(s),
);

function nonEmpty<T>(values: readonly T[]): [T, ...T[]] {
  const [first, ...rest] = values;
  // cm:guard an empty list would emit a states object no policy can satisfy; refuse to load.
  if (first === undefined) {
    throw new Error(
      'project-config/schema.ts: POLICY_STATE_STATUSES derived empty from AUTONOMOUS_DRIVER_STATUSES; a policy needs at least one dispatchable status.',
    );
  }
  return [first, ...rest];
}

const profileName = () => z.string().regex(SHORT_NAME);

// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/terminal.rs:job_argv — the grammar of
// one `--disallowed-tools` entry a job pane is started with: a built-in tool, optionally with a
// specifier (`Bash(git push:*)`), or an MCP server or tool (`mcp__forge__forge_issues`, `mcp__x__*`).
export const TOOL_PATTERN =
  /^(?:[A-Z][A-Za-z0-9]*(?:\((?! )[^()\n]{1,200}(?<! )\))?|mcp__[A-Za-z0-9-][A-Za-z0-9_-]*(?<!_)(?:__\*)?)$/;

export const policyDocumentSchema = z.strictObject({
  $schema: z.literal(`${SCHEMA_BASE}/policy-v1.json`),
  version: z.literal(1),
  qa: z.enum(['self', 'independent']),
  intake: z.strictObject({ mode: z.enum(['auto', 'manual']) }),
  permissions: sized(
    z.record(
      profileName(),
      z.strictObject({
        deny: unique(z.array(z.string().max(220).regex(TOOL_PATTERN)).max(100)),
      }),
    ),
    { min: 1, max: 10 },
  ),
  states: sized(
    z.partialRecord(
      z.enum(nonEmpty(POLICY_STATE_STATUSES)),
      z.strictObject({
        model: z.enum(['opus', 'sonnet', 'haiku', 'fable']),
        permissions: profileName(),
      }),
    ),
    { min: 1 },
  ),
});

export type PolicyDocument = z.infer<typeof policyDocumentSchema>;

const secretRef = () => z.string().regex(/^secret:\/\/[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{0,62}$/);

export const testingProfileSchema = z.strictObject({
  $schema: z.literal(`${SCHEMA_BASE}/testing-profile-v1.json`),
  version: z.literal(1),
  id: slug(),
  actors: sized(
    z.record(
      z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
      z.strictObject({
        role: z.enum([
          'deployment-admin',
          'org-owner',
          'org-admin',
          'org-member',
          'project-admin',
          'project-member',
          'viewer',
        ]),
        credential: secretRef(),
        scope: unique(z.array(slug())).optional(),
      }),
    ),
    { max: 20 },
  ),
  services: sized(
    z.record(
      z.string().regex(SHORT_NAME),
      z.strictObject({
        access: z.enum(['readonly', 'readwrite']),
        credential: secretRef(),
        endpoint: z.string().min(1).max(300).optional(),
      }),
    ),
    { max: 20 },
  ),
  limits: unique(z.array(z.strictObject({ id: slug(), note: z.string().min(1).max(500) })).max(30)),
});

export type TestingProfile = z.infer<typeof testingProfileSchema>;

export const BINDING_ROLES = ['deploy', 'source', 'service'] as const;
export type BindingRole = (typeof BINDING_ROLES)[number];

const BINDING_TARGETS = [
  z.strictObject({
    provider: z.literal('coolify'),
    applicationUuid: z.string().regex(/^[a-z0-9]{20,40}$/),
  }),
  z.strictObject({
    provider: z.literal('shopify'),
    store: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    themeRole: z.enum(['main', 'unpublished']).optional(),
  }),
  z.strictObject({
    provider: z.literal('epodsystem'),
    store: z.string().min(1).max(100),
  }),
] as const;

export const BINDING_TARGET_PROVIDERS: readonly string[] = BINDING_TARGETS.map(
  (target) => target.shape.provider.value,
);

function providerNamed(input: unknown): string {
  const provider =
    typeof input === 'object' && input !== null
      ? (input as { provider?: unknown }).provider
      : input;
  if (provider === undefined) return 'a target with no provider';
  return `provider ${JSON.stringify(provider)}`;
}

export const bindingDocumentSchema = z.strictObject({
  $schema: z.literal(`${SCHEMA_BASE}/binding-v1.json`),
  version: z.literal(1),
  id: uuid(),
  role: z.enum(BINDING_ROLES),
  connection: uuid(),
  target: z.discriminatedUnion('provider', BINDING_TARGETS, {
    error: (issue) =>
      issue.code === 'invalid_union'
        ? `${providerNamed(issue.input)} is not a binding target; target.provider is one of ${BINDING_TARGET_PROVIDERS.join(', ')}, each with the fields binding-v1.json names for it.`
        : undefined,
  }),
});

export type BindingDocument = z.infer<typeof bindingDocumentSchema>;

const observedIdentity = () => z.string().min(1).max(200);
const probeIdentity = { url: httpsUrl(), identifies: z.enum(['source', 'artifact']) };

const probeOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    ...probeIdentity,
    status: z.literal('confirmed'),
    observed: observedIdentity(),
  }),
  z.strictObject({
    ...probeIdentity,
    status: z.literal('mismatch'),
    observed: observedIdentity(),
    expected: observedIdentity(),
  }),
  z.strictObject({
    ...probeIdentity,
    status: z.literal('uncompared'),
    observed: observedIdentity(),
    error: z.string().min(1).max(500),
  }),
  z.strictObject({
    ...probeIdentity,
    status: z.literal('unreachable'),
    error: z.string().min(1).max(500),
  }),
]);

const unknownEnvironmentStateSchema = z.strictObject({
  environment: slug(),
  state: z.literal('unknown'),
  evidence: z.literal('none'),
  reason: z.strictObject({
    cause: z.enum(['external', 'no-record', 'adapter-error', 'binding-refused']),
    message: z.string().min(1).max(1000),
  }),
});

const recordedEnvironmentStateSchema = z.strictObject({
  environment: slug(),
  state: z.enum(['deployed', 'deploying', 'failed', 'cancelled']),
  evidence: z.enum([
    'runtime-confirmed',
    'runtime-mismatch',
    'runtime-unreachable',
    'deployment-record',
  ]),
  deployment: z.strictObject({
    id: z.string().min(1).max(100),
    provider: z.enum(['coolify', 'shopify', 'epodsystem']),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
    at: z.iso.datetime({ offset: true }),
  }),
  release: z
    .strictObject({ id: z.string().min(1).max(100) })
    .nullable()
    .optional(),
  artifact: z
    .strictObject({
      kind: z.enum(['container-image', 'theme', 'bundle']),
      id: z.string().min(1).max(200),
    })
    .nullable(),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('revision'), revision: z.string().regex(/^[0-9a-f]{7,40}$/) }),
    z.strictObject({ kind: z.literal('unrecorded') }),
    z.strictObject({ kind: z.literal('non-git') }),
  ]),
  probes: z.array(probeOutcomeSchema).min(1).max(3).optional(),
});

export const environmentStateSchema = z.discriminatedUnion('state', [
  unknownEnvironmentStateSchema,
  recordedEnvironmentStateSchema,
]);

export type EnvironmentState = z.infer<typeof environmentStateSchema>;
export type RecordedEnvironmentState = z.infer<typeof recordedEnvironmentStateSchema>;
export type ProbeOutcomeState = z.infer<typeof probeOutcomeSchema>;
