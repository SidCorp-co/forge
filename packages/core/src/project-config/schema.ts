import {
  CONTENT_LANGUAGE_LIMITS,
  keepTermsInEnglishSchema,
} from '@forge/contracts/content-language';
import { SENSITIVE_DATA_LEVELS } from '@forge/contracts/data-policy';
import { deliveryPolicySchema } from '@forge/contracts/delivery-policy';
import { REQUIREMENT_READINESS_GATES } from '@forge/contracts/requirements';
import {
  projectWorkflowTemplateSchema,
  TEMPLATE_LIMITS,
} from '@forge/contracts/workflow-templates';
import { z } from 'zod';
import { agentAccessValues } from '../db/release-axes.js';
import type { IssueStatus } from '../db/schema.js';
import { ISSUE_TERMINAL_STATUSES } from '../issues/status-sets.js';
import { AUTONOMOUS_DRIVER_STATUSES } from '../pipeline/autonomous-mode.js';
import { releaseRuleSchema } from './release-rule-schema.js';

export const SCHEMA_BASE = 'https://forge.sidcorp.co/schemas';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
const SHORT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const GIT_REF = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]+(?<!\/)(?<!\.lock)$/;

/** A project's one-line description: what the system is, as the Workflows overview leads with it. */
export const PROJECT_DESCRIPTION_MAX = 280;

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

export const DESIGN_APPROVERS = ['owner', 'master'] as const;
export type DesignApprover = (typeof DESIGN_APPROVERS)[number];

export const STOREFRONT_PROVIDERS = ['epodsystem', 'shopify', 'autoflow'] as const;

// cm:why a deliverable that lives only on the provider: no repository holds it, so a git project
// has nothing to send there — `rules.ts:checkGitlessBindings` refuses the pairing by name.
export const GITLESS_PROVIDERS: readonly string[] = ['autoflow'];

const storefrontSourceSchema = z.strictObject({
  type: z.literal('storefront'),
  storefront: z.strictObject({
    provider: z.enum(STOREFRONT_PROVIDERS),
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
    // cm:why what the system is, in one line a person reads first (owner, 2026-10-04): the Workflows
    // overview leads with it instead of a design's summary, which records how the design was drawn.
    // Absent is undescribed; nothing else is read in its place.
    description: z
      .string()
      .min(1)
      .max(PROJECT_DESCRIPTION_MAX)
      .regex(/^\S(?:[^\r\n]*\S)?$/, 'one line, with no leading or trailing space')
      .optional(),
  }),
  source: z.discriminatedUnion('type', [gitSourceSchema, storefrontSourceSchema, noSourceSchema]),
  workspace: z.strictObject({
    isolation: z.enum(['worktree', 'branch', 'remote-draft', 'none']),
    setup: z.string().min(1).max(4000).optional(),
  }),
  validation: z.strictObject({
    gate: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('github-check'), name: z.string().min(1).max(100) }),
      z.strictObject({ type: z.literal('gitlab-pipeline'), name: z.string().min(1).max(100) }),
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
  // cm:why plan approval held as a project rule: `required` makes the kernel refuse a move into
  // `approved` by an actor without plans.approve (`issues/transition-guards.ts:planGuard`, refusal
  // APPROVE_PERMISSION_REQUIRED); absent is not required, and a run's own plan checkpoint is enough.
  plan: z
    .strictObject({
      approval: z.strictObject({ required: z.boolean() }),
    })
    .optional(),
  release: releaseRuleSchema.optional(),
  // cm:why what the delivery gate asks of an issue (owner ruling on dev, 2026-10-04):
  // `verdictsRequired: false` lets `awaiting_release` and the release cut pass without a passing
  // verdict per criterion, and the move's record says `verdicts-waived`
  // (`issues/transition-guards.ts:verdictGuard`). Absent is `true`.
  delivery: deliveryPolicySchema.optional(),
  // `designApprover` is retired (ADR 0007): ISS-159 until:no stored project document carries
  // it — still parsed so a stored document reads, refused on write (`rules.ts:checkRetiredApprovers`),
  // never read. `templates` are the project's own diagram templates
  // (policy over the kernel's built-ins, `@forge/contracts/workflow-templates`): complete ones, or
  // extensions that add to a built-in; absent is none.
  workflows: z
    .strictObject({
      designApprover: z.enum(DESIGN_APPROVERS).optional(),
      templates: z.array(projectWorkflowTemplateSchema).max(TEMPLATE_LIMITS.templates).optional(),
    })
    .optional(),
  // `contracts.approver` is retired the same way and under the same amnesty as
  // `workflows.designApprover` above.
  contracts: z
    .strictObject({
      approver: z.enum(DESIGN_APPROVERS).optional(),
    })
    .optional(),
  // cm:why what of this project's content may leave for an embedding or LLM provider (decision Q8,
  // owner ruling 2026-10-03): `redact` scrubs on write and lets only redacted text out, `no_egress`
  // scrubs on write and lets nothing out. One guard reads it (`lib/data-egress.ts`). Absent is `off`.
  sensitiveData: z.enum(SENSITIVE_DATA_LEVELS).optional(),
  // cm:why what a requirement's agree reads of its readiness result (decision on ISS-58,
  // 2026-10-04): `warn` records it on the baseline, `block` refuses an agree that is not ready
  // (`requirements/rules.ts:readinessRefusal`, REQUIREMENT_NOT_READY). Absent is `off`.
  requirements: z
    .strictObject({
      readinessGate: z.enum(REQUIREMENT_READINESS_GATES).optional(),
    })
    .optional(),
  // cm:why the language agents write this project's prose in (owner, 2026-10-04): a BCP-47 tag,
  // absent is `en`. Policy over the kernel: no write is refused for its language, only a tag that
  // is not one (`rules.ts:checkContentLanguage`, CONTENT_LANGUAGE_INVALID). Code, identifiers,
  // commits, PR text, machine-read fields and Forge's UI chrome are English whatever it says.
  contentLanguage: z.string().min(1).max(CONTENT_LANGUAGE_LIMITS.tagMax).optional(),
  // cm:why terms the prose keeps in English beyond the built-in technical ones
  // (`@forge/contracts/content-language:TECHNICAL_TERMS_KEPT_IN_ENGLISH`); absent is none.
  keepTermsInEnglish: unique(keepTermsInEnglishSchema).optional(),
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

const releaseRunnerLabel = () => z.string().min(1).max(60).optional();
const bindingLabel = () =>
  z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional();
const targetOf = <P extends string, S extends z.ZodRawShape>(provider: P, shape: S) =>
  z.strictObject({
    provider: z.literal(provider),
    ...shape,
    label: bindingLabel(),
    releaseRunnerLabel: releaseRunnerLabel(),
  });

const coolifyApplication = z.strictObject({
  id: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(100),
  resourceUuid: z.string().regex(/^[a-z0-9]{20,40}$/),
  healthUrl: httpsUrl().optional(),
});

const BINDING_TARGETS = [
  targetOf('coolify', {
    applications: z
      .array(coolifyApplication)
      .min(1)
      .max(20)
      .refine((apps) => new Set(apps.map((a) => a.label)).size === apps.length, {
        message: 'two applications share a label; a label names one application in this binding',
      }),
  }),
  targetOf('shopify', {
    store: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    themeRole: z.enum(['main', 'unpublished']).optional(),
  }),
  targetOf('epodsystem', {}),
  targetOf('autoflow', {
    shop: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  }),
  targetOf('github', {
    installationId: z.number().int().positive(),
    owner: z.string().min(1).max(200),
    repo: z.string().min(1).max(200),
  }),
  targetOf('gitlab', {
    projectPath: z
      .string()
      .regex(/^[A-Za-z0-9_.][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)+$/)
      .max(500)
      .optional(),
    projectId: z.number().int().positive().optional(),
  }),
  targetOf('sentry', {}),
  targetOf('postman', {}),
  targetOf('rocketchat', { rids: z.array(z.string().min(1).max(200)).min(1).max(20).optional() }),
  targetOf('google', { defaultSpreadsheetId: z.string().min(1).max(200).optional() }),
  targetOf('agent', {}),
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
  agentAccess: z.enum(agentAccessValues).optional(),
  active: z.boolean().optional(),
  instructions: z.string().min(1).max(4000).optional(),
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
    provider: z.enum(['coolify', 'shopify', 'epodsystem', 'autoflow']),
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
