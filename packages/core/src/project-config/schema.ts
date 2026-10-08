import {
  CONTENT_LANGUAGE_LIMITS,
  keepTermsInEnglishSchema,
} from '@forge/contracts/content-language';
import { SENSITIVE_DATA_LEVELS } from '@forge/contracts/data-policy';
import { deliveryPolicySchema } from '@forge/contracts/delivery-policy';
import { FEEDBACK_VERIFY_WINDOW } from '@forge/contracts/feedback';
import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { REQUIREMENT_READINESS_GATES } from '@forge/contracts/requirements';
import { rewriteThresholdSchema } from '@forge/contracts/workflow-health';
import {
  projectWorkflowTemplateSchema,
  TEMPLATE_LIMITS,
} from '@forge/contracts/workflow-templates';
import { z } from 'zod';
import { agentAccessValues } from '../db/release-axes.js';
import { releaseRuleSchema } from './release-rule-schema.js';
import { surfacesSchema } from './surfaces-schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLUG = /^[a-z][a-z0-9-]{0,62}$/;
export const SHORT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const GIT_REF = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*@\{)[A-Za-z0-9._/-]+(?<!\/)(?<!\.lock)$/;

/** A project's one-line description: what the system is, as the Workflows overview leads with it. */
const PROJECT_DESCRIPTION_MAX = 280;

export const uuid = () => z.string().regex(UUID);
export const slug = () => z.string().regex(SLUG);
const gitRef = () => z.string().min(1).max(200).regex(GIT_REF);

/** `host.tld/owner/repo`, `user@host.tld:owner/repo[.git]`, or an absolute path with no whitespace and no `.`/`..` segment. */
export const GIT_REPOSITORY =
  /^(?:[a-z0-9.-]+\.[a-z]{2,}\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|(?:\/(?!\.\.?(?:\/|$))[^/\s]+)+\/?)$/;
export const gitRepository = () =>
  z.string().max(500).regex(GIT_REPOSITORY, {
    message:
      'source.git.repository names a repository one of three ways: host.tld/owner/repo (a hosted repository), git@host.tld:owner/repo (an SSH remote), or an absolute local path such as /srv/git/repo.git (no whitespace, no `.` or `..` segment); a URL with a scheme (https://, file://) is not one of them',
  });
const httpsUrl = () =>
  z
    .string()
    .regex(/^https:\/\//)
    .refine((v) => URL.canParse(v), { message: 'Invalid URI' })
    .meta({ format: 'uri' });

// zod has no uniqueItems: the refine enforces it and the meta makes the emitted schema say it.
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
    repository: gitRepository(),
    defaultBranch: gitRef(),
    branches: unique(z.array(gitRef()).min(1).max(10)),
  }),
});

const DESIGN_APPROVERS = ['owner', 'master'] as const;

export const STOREFRONT_PROVIDERS = ['epodsystem', 'shopify', 'autoflow'] as const;

// a deliverable that lives only on the provider: no repository holds it, so a git project
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
    // what the system is, in one line a person reads first (owner, 2026-10-04): the Workflows
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
  // plan approval held as a project rule: `required` makes the kernel refuse a move into
  // `approved` by an actor without plans.approve (`issues/transition-guards.ts:planGuard`, refusal
  // PERMISSION_FORBIDDEN); absent is not required, and a run's own plan checkpoint is enough.
  plan: z
    .strictObject({
      approval: z.strictObject({ required: z.boolean() }),
    })
    .optional(),
  release: releaseRuleSchema.optional(),
  // which surface each changed path of a git landing touches (`surfaces-schema.ts`); absent, a
  // landing's paths are shown unclassified
  surfaces: surfacesSchema.optional(),
  // what the delivery gate asks of an issue (owner ruling on dev, 2026-10-04):
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
      // When a marked node is due a rewrite rather than a patch (REQ-17 BC-25, policy): absent values
      // read as `REWRITE_THRESHOLD_DEFAULTS` and are reported as defaults on the health read.
      rewriteThreshold: rewriteThresholdSchema.optional(),
    })
    .optional(),
  // `contracts.approver` is retired the same way and under the same amnesty as
  // `workflows.designApprover` above.
  contracts: z
    .strictObject({
      approver: z.enum(DESIGN_APPROVERS).optional(),
    })
    .optional(),
  // what of this project's content may leave for an embedding or LLM provider (decision Q8,
  // owner ruling 2026-10-03): `redact` scrubs on write and lets only redacted text out, `no_egress`
  // scrubs on write and lets nothing out. One guard reads it (`lib/data-egress.ts`). Absent is `off`.
  sensitiveData: z.enum(SENSITIVE_DATA_LEVELS).optional(),
  // whether the assistant may run a short computation over this project's data in an isolated
  // sandbox (REQ-32 C1, `reports/compute.ts`), and which sandboxes may take it. Absent is off: a
  // project turns execution on with `enabled: true`. `zdrOnly` (a zero-retention obligation) admits
  // only a sandbox declaring itself ZDR-eligible; `thirdParty: false` admits only one whose data
  // stays with Forge. A request no admitted sandbox can serve is refused by name, never routed on.
  compute: z
    .strictObject({
      enabled: z.boolean(),
      zdrOnly: z.boolean().optional(),
      thirdParty: z.boolean().optional(),
    })
    .optional(),
  // what a requirement's agree reads of its readiness result (decision on ISS-58,
  // 2026-10-04): `warn` records it on the baseline, `block` refuses an agree that is not ready
  // (`requirements/rules.ts:readinessRefusal`, REQUIREMENT_NOT_READY). Absent is `off`.
  requirements: z
    .strictObject({
      readinessGate: z.enum(REQUIREMENT_READINESS_GATES).optional(),
    })
    .optional(),
  // how long a resolved feedback item waits for anyone to confirm the fix before Forge verifies it
  // itself (owner, 2026-10-07): whole days, `FEEDBACK_VERIFY_WINDOW.defaultDays` where absent. A
  // value outside the bounds is refused naming the field, never clamped.
  feedback: z
    .strictObject({
      verifyWindowDays: z
        .number()
        .int({ error: 'feedback.verifyWindowDays is a whole number of days' })
        .min(FEEDBACK_VERIFY_WINDOW.minDays, {
          error: `feedback.verifyWindowDays is at least ${FEEDBACK_VERIFY_WINDOW.minDays} day: a window of none would verify every fix the moment it shipped`,
        })
        .max(FEEDBACK_VERIFY_WINDOW.maxDays, {
          error: `feedback.verifyWindowDays is at most ${FEEDBACK_VERIFY_WINDOW.maxDays} days: a longer window is a fix nobody is ever told was verified`,
        })
        .optional(),
    })
    .optional(),
  // the language agents write this project's prose in (owner, 2026-10-04): a BCP-47 tag,
  // absent is `en`. Policy over the kernel: no write is refused for its language, only a tag that
  // is not one (`rules.ts:checkContentLanguage`, CONTENT_LANGUAGE_INVALID). Code, identifiers,
  // commits, PR text, machine-read fields and Forge's UI chrome are English whatever it says.
  contentLanguage: z.string().min(1).max(CONTENT_LANGUAGE_LIMITS.tagMax).optional(),
  // terms the prose keeps in English beyond the built-in technical ones
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
  targetOf('rocketchat', { rids: z.array(z.string().min(1).max(200)).min(1).max(20).optional() }),
  targetOf('agent', {}),
] as const;

const BINDING_TARGET_PROVIDERS: readonly string[] = BINDING_TARGETS.map(
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
