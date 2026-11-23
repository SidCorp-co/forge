// The run door of a project's environment variables (REQ-80 BC-8): a declared run, or a running
// job, receives the effective variables of the environment it targets, the way a GitLab pipeline
// receives its CI/CD variables. It names its run the way the testing-profile door does
// (`testing-secrets.ts`), under its own credential; every delivery is audited by key and
// fingerprint, and each secret or file value is handed to the scrubber for that run's output. A
// protected variable on a production-tier environment is opened by the run's work landing there, or
// by a person's ruling for the production act on an issue it works (BC-11): who reads is settled
// first, and each value read under a ruling is audited naming the ruling, the issue and the run,
// committed before the value leaves, and scrubbed whatever its type. Protection itself never moves.

import { SELF_JOB } from '@forge/contracts/project-config';
import {
  MASKED_VARIABLE_TYPES,
  type RunVariablesView,
  type VariableRefusalCode,
} from '@forge/contracts/variables';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs, projects } from '../db/schema.js';
import { decryptSecret, isVaultConfigured } from '../integrations/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { RefusalError, refuser } from '../lib/refusal.js';
import type { PatPrincipal } from '../middleware/require-pat.js';
import { namedHolders } from '../permissions/index.js';
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
import {
  askRefusals,
  type DecisionNamingProduction,
  type DeclaredEnvironment,
  effectiveVariables,
  type RulingAsk,
  type RulingRead,
  rulingRead,
  withheldWhy,
} from './variables-rules.js';
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

/** The run's issues by key, in the order it works them. */
async function runIssuesOf(run: CallingRun): Promise<Array<{ id: string; key: string }>> {
  if (run.issueIds.length === 0) return [];
  const rows = await db
    .select({ id: issues.id, issSeq: issues.issSeq, prefix: projects.issuePrefix })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(inArray(issues.id, run.issueIds));
  const byId = new Map(rows.map((r) => [r.id, formatIssueRef(r.prefix, r.issSeq)]));
  return run.issueIds.flatMap((id) => {
    const key = byId.get(id);
    return key ? [{ id, key }] : [];
  });
}

/**
 * Whether a person's ruling on an issue the run works opens `environment`'s protected variables
 * (BC-11): the decisions naming it, their writers by name, and who holds project.admin, decided by
 * `rulingRead`.
 */
async function rulingOf(run: CallingRun, environment: DeclaredEnvironment): Promise<RulingRead> {
  const [decisions, admins, runIssues] = await Promise.all([
    projectConfigPorts().decisionsNamingProduction(run.projectId, run.issueIds),
    namedHolders('project.admin', run.projectId),
    runIssuesOf(run),
  ]);
  const people = await peopleOf(decisions.map((d) => d.writer.id));
  return rulingRead({
    decisions: decisions.map((d) => ({
      ...d,
      writer: { ...d.writer, name: people.get(d.writer.id)?.name ?? 'an unnamed account' },
    })),
    environment,
    runIssues,
    admins,
    now: new Date(),
  });
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
    ? environmentsOf(held.document).map((e) => ({
        name: e.name,
        tier: e.declaration.tier,
        deploysFrom: e.declaration.deploysFrom,
      }))
    : [];
  const environment = declared.find((e) => e.name === args.environment);
  if (!held || !environment) {
    throw refuse(
      'VARIABLE_ENVIRONMENT_UNKNOWN',
      `project ${run.projectId} declares no environment \`${args.environment}\`; it declares ${declared.map((e) => `\`${e.name}\``).join(', ') || 'none'}. Nothing was delivered.`,
      '/environment',
    );
  }
  const landed =
    environment.tier === 'production' && (await landedOn(run, environment.deploysFrom));
  const listed = await listVariables(run.projectId);
  let read = effectiveVariables(listed, environment, landed);
  // a production key still withheld is opened by a person's ruling on the run's issue, or the run
  // is told the ruling it lacks and who gives it (BC-11, BC-12)
  let ruling: DecisionNamingProduction | null = null;
  let ask: RulingAsk | null = null;
  if (environment.tier === 'production' && !landed && read.withheld.length > 0) {
    const ruled = await rulingOf(run, environment);
    if (ruled.kind === 'ruled') {
      ruling = ruled.ruling;
      read = effectiveVariables(listed, environment, true);
    } else ask = ruled.ask;
  }
  if (args.keys !== null) {
    const refusals = askRefusals(args.keys, read, environment, ask);
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
      detail: {
        run: run.view,
        environment: environment.name,
        ...(ruling && v.protected
          ? {
              ruling: {
                id: ruling.id,
                issue: ruling.issueKey,
                issueId: ruling.issueId,
                by: ruling.writer.id,
              },
            }
          : {}),
      },
    })),
  );
  // a value a ruling opened is scrubbed whatever its type: it reached this run by a person's word
  const ruled = new Set(ruling ? chosen.filter((v) => v.protected).map((v) => v.key) : []);
  projectConfigPorts().rememberHandedOut(
    run.scrubKey,
    variables
      .filter((v) => MASKED_VARIABLE_TYPES.includes(v.type) || ruled.has(v.key))
      .map((v) => v.value),
  );
  return {
    ok: true,
    delivered: {
      environment: environment.name,
      run: run.view,
      variables,
      withheld: args.keys === null ? read.withheld : [],
      // each with the words a `?key=` read refuses it with, so no run guesses why (ISS-1392)
      withheldWhy:
        args.keys === null
          ? read.withheld.map((key) => ({ key, why: withheldWhy(environment, ask) }))
          : [],
    },
  };
}
