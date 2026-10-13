/**
 * The copy of the policy a run was decided under, as the box that opened it names it.
 *
 * The policy, which work to take and in what order, is forge-plugin's (owner ruling
 * 2026-09-20), so the version that decided a run is a plugin copy. Core does not read the
 * project's designation for it: a designation is what a box was asked to run, and a run
 * stamped with it would state a copy the box may not have installed yet
 * (`VISION: state-never-lies`). The box reports the copy its pane loaded, core validates it
 * and records exactly that, and a box that cannot name one says so with a reason (ISS-1303).
 */

import { z } from 'zod';
import { logger } from '../logger.js';

export const POLICY_AT_OPEN_METADATA_KEY = 'policyAtOpen';

/**
 * Why a box named no copy. A closed list: the reason is what a reader acts on, and free text
 * here would be the free-text version string this refuses to store.
 */
export const boxUnnamedReasons = [
  'plugins_unknown',
  'policy_plugin_absent',
  'policy_plugin_not_enabled',
  'more_than_one_copy',
  'copy_unreadable',
  'not_recorded',
] as const;

/** `not_reported` is core's own answer for a box that sent no field, so a box may not send it. */
export const storedUnnamedReasons = [...boxUnnamedReasons, 'not_reported'] as const;

// `<plugin>@<marketplace>`, the id Claude Code's install registry keys a plugin by.
const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// The same shape `plugins/designation.ts` holds a pinned ref to.
const COMMIT = /^[0-9a-f]{7,40}$/;

/**
 * A refusal carries the field it is about in its own text: `z.flattenError` keys a nested
 * issue under its top-level field, so without this a box told `policy` is wrong is not told
 * which part of it.
 */
const text = (field: string, shape: string) =>
  z.string({ error: `policy.${field}: must be ${shape}` });

const namedCopy = z.strictObject(
  {
    named: z.literal(true),
    plugin: text('plugin', 'a plugin id such as forge@forge-local').regex(
      PLUGIN_ID,
      'policy.plugin: must be a plugin id such as forge@forge-local',
    ),
    version: text('version', 'a semantic version such as 3.36.542')
      .max(64, 'policy.version: must be at most 64 characters')
      .regex(SEMVER, 'policy.version: must be a semantic version such as 3.36.542'),
    commit: text('commit', '7 to 40 lower-case hex characters')
      .regex(COMMIT, 'policy.commit: must be 7 to 40 lower-case hex characters')
      .optional(),
  },
  { error: (issue) => objectError(issue) },
);

function objectError(issue: { code: string; keys?: string[] }): string | undefined {
  if (issue.code === 'unrecognized_keys') {
    return `policy: ${(issue.keys ?? []).map((k) => `"${k}"`).join(', ')} is not a field of a policy copy`;
  }
  if (issue.code === 'invalid_type') return 'policy: must be an object';
  return undefined;
}

const unnamed = <const R extends readonly [string, ...string[]]>(reasons: R) =>
  z.strictObject(
    {
      named: z.literal(false),
      reason: z.enum(reasons, {
        error: `policy.reason: must be one of ${reasons.join(', ')}`,
      }),
    },
    { error: (issue) => objectError(issue) },
  );

const NAMED_ERROR = 'policy.named: must be true, with plugin and version, or false, with a reason';

/** What a box sends on the open. */
export const policyCopySchema = z.discriminatedUnion(
  'named',
  [namedCopy, unnamed(boxUnnamedReasons)],
  { error: NAMED_ERROR },
);

/** What a run holds: the same, plus core's own answer for a box that sent nothing. */
const storedPolicySchema = z.discriminatedUnion(
  'named',
  [namedCopy, unnamed(storedUnnamedReasons)],
  { error: NAMED_ERROR },
);

export type PolicyCopy = z.infer<typeof policyCopySchema>;
export type StoredPolicy = z.infer<typeof storedPolicySchema>;

/**
 * What the run is stamped with. A box too old to send the field says nothing, and nothing
 * is recorded as that: a run that carries no copy and a run that carries a wrong one are
 * different failures, and only the first is true here.
 */
export function stampPolicy(sent: PolicyCopy | undefined): StoredPolicy {
  return sent ?? { named: false, reason: 'not_reported' };
}

/**
 * The run's own record of the policy it opened under, out of `pipeline_runs.metadata`.
 * `null` is a run opened before the stamp existed; one core cannot read says so.
 */
export type RunPolicy =
  | { read: 'ok'; policy: StoredPolicy }
  | { read: 'unreadable'; reason: string };

export function readRunPolicy(metadata: unknown, runId: string): RunPolicy | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const stored = (metadata as Record<string, unknown>)[POLICY_AT_OPEN_METADATA_KEY];
  if (stored === undefined) return null;
  const parsed = storedPolicySchema.safeParse(stored);
  if (parsed.success) return { read: 'ok', policy: parsed.data };
  const reason = parsed.error.issues[0]?.message ?? 'not a policy copy core can read';
  logger.warn({ runId, reason }, 'pipeline run: this run carries a policy copy core cannot read');
  return { read: 'unreadable', reason };
}
