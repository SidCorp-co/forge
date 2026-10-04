import { repoPath } from '@forge/contracts/repo-path';
import { z } from 'zod';
import { CONTRACT_DECISION_REASON_MAX, CONTRACT_DECISIONS } from './contract/approval.js';
import { MAX_ARTIFACT_BYTES } from './contract/measure.js';
import { SOURCE_REF } from './contract/version-schema.js';
import type { EcosystemRefusal } from './refusals.js';

export const READS = [
  'interface',
  'links',
  'link',
  'builder_runs',
  'builder_run',
  'bus',
  'context',
] as const;
export const WRITES = [
  'interface_write',
  'link_create',
  'link_update',
  'builder_run_create',
  'builder_run_update',
  'builder_run_supersede',
  'contract_version_publish',
  'contract_version_decide',
] as const;
export const ACTIONS = [...READS, ...WRITES] as const;
export type Action = (typeof ACTIONS)[number];

const envelope = {
  baseRevision: z.number().int().min(1).nullable(),
  document: z.unknown().refine((v) => v !== undefined, 'document is required'),
};

/** What each action takes; a key another action takes is refused here, not dropped. */
const BY_ACTION = {
  interface: z.strictObject({}),
  links: z.strictObject({}),
  link: z.strictObject({ link: z.uuid() }),
  builder_runs: z.strictObject({}),
  builder_run: z.strictObject({ run: z.uuid() }),
  bus: z.strictObject({ ecosystem: z.uuid() }),
  context: z.strictObject({
    paths: z.array(repoPath()).min(1).max(200),
    session: z.uuid().optional(),
  }),
  interface_write: z.strictObject(envelope),
  link_create: z.strictObject(envelope),
  link_update: z.strictObject({ link: z.uuid(), ...envelope }),
  builder_run_create: z.strictObject(envelope),
  builder_run_update: z.strictObject({ run: z.uuid(), ...envelope }),
  builder_run_supersede: z.strictObject({ run: z.uuid(), reason: z.unknown().optional() }),
  contract_version_publish: z.strictObject({
    contract: z
      .string()
      .regex(
        /^(?:[a-z][a-z0-9-]{0,62}\/)?[a-z][a-z0-9-]{0,62}$/,
        'contract is the publication slug, or <this project slug>/<slug>',
      ),
    version: z.string().min(1).max(40),
    kind: z.string().min(1).max(40),
    source: z.union([z.string().min(1).max(MAX_ARTIFACT_BYTES), z.record(z.string(), z.unknown())]),
    sourceRef: z
      .string()
      .regex(
        SOURCE_REF,
        'sourceRef is <repository path>@<commit sha>, e.g. schema.graphql@1a2b3c4',
      ),
  }),
  contract_version_decide: z.strictObject({
    contract: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'contract is the publication slug'),
    version: z.string().min(1).max(40),
    decision: z.enum(CONTRACT_DECISIONS),
    reason: z.string().max(CONTRACT_DECISION_REASON_MAX).optional(),
  }),
} satisfies Record<Action, z.ZodType>;

const SHAPES: Record<Action, string> = {
  interface: '{}',
  links: '{}',
  link: '{ link: a link uuid }',
  builder_runs: '{}',
  builder_run: '{ run: a builder run uuid }',
  bus: '{ ecosystem: an ecosystem uuid }',
  context:
    '{ paths: the repository paths this run touches, session?: the agent session to record the load on }',
  interface_write: '{ baseRevision: the revision read, or null for a first write, document }',
  link_create: '{ baseRevision: null, document: a link-v1 document }',
  link_update: '{ link, baseRevision, document: a link-v1 document }',
  builder_run_create: '{ baseRevision: null, document: a builder-run-v1 document }',
  builder_run_update: '{ run, baseRevision, document: a builder-run-v1 document }',
  builder_run_supersede: '{ run: the open builder run uuid, reason: why it is replaced }',
  contract_version_publish:
    '{ contract: the publication slug, version, kind: graphql | mcp-tools | openapi | json-schema, source: SDL text or the { tools } JSON, sourceRef: <repo path>@<sha> }',
  contract_version_decide:
    '{ contract: the publication slug, version: a proposed version, decision: approve | return, reason?: why, required to return }',
};

type Parsed =
  | { ok: true; action: Action; args: Record<string, unknown> }
  | { ok: false; refusals: EcosystemRefusal[] };

export function parse(raw: Record<string, unknown>): Parsed {
  const { action, ...rest } = raw;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      refusals: [
        {
          code: 'ECOSYSTEM_ARGUMENT_INVALID',
          path: '/action',
          detail: `action is one of ${ACTIONS.join(', ')}`,
        },
      ],
    };
  }
  const act = action as Action;
  const parsed = BY_ACTION[act].safeParse(rest);
  if (parsed.success) return { ok: true, action: act, args: parsed.data };
  return {
    ok: false,
    refusals: parsed.error.issues.map((issue) => {
      const keys = issue.code === 'unrecognized_keys' ? issue.keys : [];
      return {
        code: 'ECOSYSTEM_ARGUMENT_INVALID',
        path: `/${[...issue.path, ...keys.slice(0, 1)].map(String).join('/')}`,
        detail: `${act} takes ${SHAPES[act]}; ${issue.message}`,
      };
    }),
  };
}

export const isWrite = (a: Action) => (WRITES as readonly string[]).includes(a);
