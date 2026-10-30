// The run door of a project's environment variables (REQ-80 BC-8): a declared run, or a running
// job, receives the effective variables of the environment it targets, the way a GitLab pipeline
// receives its CI/CD variables. It names its run the way the testing-profile door does
// (`testing-secrets.ts`), under its own credential; every delivery is audited by key and
// fingerprint, and each secret or file value is handed to the scrubber for that run's output.

import { SELF_JOB } from '@forge/contracts/project-config';
import {
  MASKED_VARIABLE_TYPES,
  type RunVariablesView,
  type VariableRefusalCode,
} from '@forge/contracts/variables';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs } from '../db/schema.js';
import { decryptSecret, isVaultConfigured } from '../integrations/index.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import type { PatPrincipal } from '../middleware/require-pat.js';
import { projectConfigPorts } from './ports.js';
import { environmentsOf } from './release-path.js';
import { readProjectConfig } from './service.js';
import { type Refused, refuse as refuseRun } from './testing-secret-values.js';
import {
  boxCallRefusal,
  boxlessCallRefusal,
  credentialJob,
  DECLARED_RUN_REFUSAL,
} from './testing-secrets.js';
import { askRefusals, type DeclaredEnvironment, effectiveVariables } from './variables-rules.js';
import { insertEvents, listVariables, valuesOf } from './variables-store.js';

const refuse = refuser<VariableRefusalCode>('VARIABLE_REFUSED');

/** The run a call names: a declared run on the caller's box, or the job its credential runs. */
interface CallingRun {
  projectId: string;
  issueIds: string[];
  view: RunVariablesView['run'];
  /** What the scrubber keys this run's output by: the job, or the declared run's session. */
  scrubKey: string;
}

async function callingRun(
  principal: PatPrincipal,
  asked: string,
): Promise<Refused | { ok: true; run: CallingRun }> {
  if (asked !== SELF_JOB && principal.deviceId) {
    const declared = await projectConfigPorts().declaredRunOfCall(principal, asked);
    if (declared.kind === 'refused') {
      return refuseRun(
        403,
        DECLARED_RUN_REFUSAL[declared.reason],
        `${declared.detail} Nothing was delivered.`,
      );
    }
    if (declared.kind === 'run') {
      return {
        ok: true,
        run: {
          projectId: declared.projectId,
          issueIds: declared.issueIds,
          view: { kind: 'run', id: declared.runId, session: declared.sessionId },
          scrubKey: declared.sessionId,
        },
      };
    }
  }
  const own = await credentialJob(principal, asked);
  if (!own.ok) {
    if (principal.deviceId) return boxCallRefusal(own, asked);
    if (asked !== SELF_JOB) {
      return boxlessCallRefusal(own, principal, { jobId: asked, profileId: '<profile>' });
    }
    return own;
  }
  const [job] = await db
    .select({ projectId: jobs.projectId, issueId: jobs.issueId })
    .from(jobs)
    .where(eq(jobs.id, own.jobId))
    .limit(1);
  if (!job)
    return refuseRun(403, 'TESTING_SECRETS_FOREIGN_JOB', `job ${own.jobId} does not exist.`);
  return {
    ok: true,
    run: {
      projectId: job.projectId,
      issueIds: job.issueId ? [job.issueId] : [],
      view: { kind: 'job', id: own.jobId },
      scrubKey: own.jobId,
    },
  };
}

/**
 * Whether the run's work landed on the branch `deploysFrom` names: the fact a protected variable is
 * given on, as GitLab gives one only to a protected ref (BC-8). Read off each issue's merge mark, the
 * same mark the testing-profile door names the judged environment by.
 */
async function landedOn(run: CallingRun, deploysFrom: string | undefined): Promise<boolean> {
  if (!deploysFrom || run.issueIds.length === 0) return false;
  const [hit] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        inArray(issues.id, run.issueIds),
        eq(issues.mergedTarget, deploysFrom),
        isNotNull(issues.mergedAt),
      ),
    )
    .limit(1);
  return hit !== undefined;
}

/** `GET /api/jobs/:id/variables/:environment[?key=…]`: what the run gets on that environment (BC-8). */
export async function deliverRunVariables(args: {
  principal: PatPrincipal;
  asked: string;
  environment: string;
  keys: readonly string[] | null;
}): Promise<Refused | { ok: true; delivered: RunVariablesView }> {
  const calling = await callingRun(args.principal, args.asked);
  if (!calling.ok) return calling;
  const { run } = calling;
  const held = await readProjectConfig(run.projectId);
  const declared: DeclaredEnvironment[] = held
    ? environmentsOf(held.document).map((e) => ({ name: e.name, tier: e.declaration.tier }))
    : [];
  const environment = declared.find((e) => e.name === args.environment);
  if (!held || !environment) {
    throw refuse(
      'VARIABLE_ENVIRONMENT_UNKNOWN',
      `project ${run.projectId} declares no environment \`${args.environment}\`; it declares ${declared.map((e) => `\`${e.name}\``).join(', ') || 'none'}. Nothing was delivered.`,
      '/environment',
    );
  }
  const deploysFrom = held.document.environments[environment.name]?.deploysFrom;
  const landed = environment.tier === 'production' && (await landedOn(run, deploysFrom));
  const read = effectiveVariables(await listVariables(run.projectId), environment, landed);
  if (args.keys !== null) {
    const refusals = askRefusals(args.keys, read, environment);
    if (refusals.length > 0) throw new RefusalError(refusals, 'VARIABLE_REFUSED');
  }
  const chosen = [...read.effective.values()].filter(
    (v) => args.keys === null || args.keys.includes(v.key),
  );
  if (chosen.length > 0 && !isVaultConfigured()) {
    throw refuse(
      'VARIABLE_VAULT_NOT_CONFIGURED',
      'INTEGRATION_MASTER_KEY is not set on this core, so no variable value can be read; nothing was delivered.',
    );
  }
  const stored = await valuesOf(
    run.projectId,
    chosen.map((v) => v.secretName),
  );
  const variables = chosen.map((v) => {
    const enc = stored.get(v.secretName);
    if (!enc)
      throw refuse(
        'VARIABLE_VALUE_UNREADABLE',
        `${v.key} names a value the store does not hold; nothing was delivered.`,
      );
    try {
      return { key: v.key, type: v.type, value: decryptSecret(enc) };
    } catch {
      throw refuse(
        'VARIABLE_VALUE_UNREADABLE',
        `${v.key} does not decrypt under this core's INTEGRATION_MASTER_KEY; nothing was delivered.`,
      );
    }
  });
  await insertEvents(
    db,
    chosen.map((v) => ({
      projectId: run.projectId,
      variableId: v.id,
      act: 'delivered' as const,
      key: v.key,
      environment: environment.name,
      actorId: args.principal.userId,
      actorTokenId: args.principal.tokenId,
      agency: args.principal.agency,
      newFingerprint: v.fingerprint,
      detail: { run: run.view, environment: environment.name },
    })),
  );
  projectConfigPorts().rememberHandedOut(
    run.scrubKey,
    variables.filter((v) => MASKED_VARIABLE_TYPES.includes(v.type)).map((v) => v.value),
  );
  return {
    ok: true,
    delivered: {
      environment: environment.name,
      run: run.view,
      variables,
      withheld: args.keys === null ? read.withheld : [],
    },
  };
}
