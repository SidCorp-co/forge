// The target door of a project's environment variables (REQ-80 BC-10): Forge writes the effective
// variables of an environment into its forge-ops compose target's env file, server-side, on a deploy
// through Forge and on an explicit sync, so a value a person enters on the Variables page reaches
// the running app with no agent copying it. Each value goes from the store to the project's box in
// the call core makes (`support/declared-read.ts:runOpsCall`) and never into the caller's answer,
// a log or the record: every write is audited by key and fingerprint (`delivered`, naming the
// target), and whatever the box answered is cut of every secret value before anyone reads it. A
// protected variable reaches only a production-tier environment's target (BC-2, BC-8); another
// deployment is refused by name, naming what to bind. The value does sit in the forge-ops call's
// argv on the box for that call, as the CLI takes its arguments.

import {
  FORGE_OPS_DEPLOY_TOOL,
  SCRIPT_OPS_TIMEOUT_DEFAULT_MS,
  SCRIPT_OPS_TIMEOUT_MAX_MS,
} from '@forge/contracts/script-sandbox';
import type {
  ForgeOpsDeployRequest,
  TargetDeployView,
  TargetVariablesView,
} from '@forge/contracts/variables';
import { db } from '../db/client.js';
import { RefusalError } from '../lib/refusal.js';
import { projectConfigPorts } from './ports.js';
import { environmentsOf } from './release-path.js';
import type { ForgeOpsTargetDeclaration } from './schema.js';
import { readProjectConfig } from './service.js';
import { effectiveVariables } from './variables-rules.js';
import {
  type Caller,
  callerOf,
  decrypted,
  eventOf,
  refuse,
  requireVault,
} from './variables-service.js';
import { insertEvents, listVariables, valuesOf } from './variables-store.js';
import { cutOf, envWritesOf, forgeOpsTargetOf, type HeldValue } from './variables-target.js';

type Via = TargetVariablesView['via'];

/** The environment `name` declares, and the forge-ops target it is written into, or refused. */
async function targetOf(projectId: string, name: string) {
  const held = await readProjectConfig(projectId);
  const environments = held ? environmentsOf(held.document) : [];
  const env = environments.find((e) => e.name === name);
  if (!env) {
    throw refuse(
      'VARIABLE_ENVIRONMENT_UNKNOWN',
      `this project declares no environment \`${name}\`; it declares ${environments.map((e) => `\`${e.name}\``).join(', ') || 'none'}. Nothing was written.`,
      '/environment',
    );
  }
  const target = forgeOpsTargetOf(name, env.declaration);
  if (!target.ok) throw new RefusalError([target.refusal], 'VARIABLE_REFUSED');
  return { environment: { name, tier: env.declaration.tier }, target: target.target };
}

/** The effective variables of the environment with their values, read from the one store. */
async function heldValues(
  projectId: string,
  environment: { name: string; tier: 'production' | 'staging' | 'preview' | 'dev' },
): Promise<{ effective: HeldValue[]; withheld: string[] }> {
  const listed = await listVariables(projectId);
  // the target is the environment itself, so a protected variable reaches it where it is production-tier
  const read = effectiveVariables(listed, environment, true);
  const chosen = [...read.effective.values()];
  if (chosen.length === 0) return { effective: [], withheld: read.withheld };
  requireVault();
  const stored = await valuesOf(
    projectId,
    chosen.map((v) => v.secretName),
  );
  return {
    effective: chosen.map((v) => ({
      id: v.id,
      key: v.key,
      type: v.type,
      protected: v.protected,
      fingerprint: v.fingerprint,
      value: decrypted(v, stored.get(v.secretName)),
    })),
    withheld: read.withheld,
  };
}

const outputOf = (ran: { exitCode: number | null; stdout: string; stderr: string }): string =>
  (ran.stderr.trim() || ran.stdout.trim() || 'nothing').slice(0, 600);

/** Audit each key written into the target, by fingerprint and never by value. */
async function auditWrites(
  projectId: string,
  caller: Caller,
  written: readonly HeldValue[],
  at: { environment: string; target: string; via: Via },
): Promise<void> {
  if (written.length === 0) return;
  await insertEvents(
    db,
    written.map((v) =>
      eventOf(caller, { projectId, key: v.key, environment: at.environment }, 'delivered', {
        variableId: v.id,
        newFingerprint: v.fingerprint,
        detail: {
          environment: at.environment,
          target: { kind: 'forge-ops', name: at.target },
          via: at.via,
        },
      }),
    ),
  );
}

/**
 * Write the environment's effective variables into its forge-ops target's env file, one forge-ops
 * call per key, audited as each is written. The first call that fails stops the write and is
 * refused by name, the keys written before it named and audited.
 */
async function writeTarget(args: {
  projectId: string;
  userId: string;
  environment: string;
  via: Via;
}): Promise<{
  view: TargetVariablesView;
  target: ForgeOpsTargetDeclaration;
  cut: Record<string, string>;
}> {
  const caller = await callerOf(args.projectId, args.userId);
  const { environment, target } = await targetOf(args.projectId, args.environment);
  const held = await heldValues(args.projectId, environment);
  const plan = envWritesOf(target, held.effective, held.withheld, environment);
  const cut = cutOf(held.effective);
  const written: HeldValue[] = [];
  const at = { environment: environment.name, target: target.target, via: args.via };
  for (const w of plan.writes) {
    const ran = await projectConfigPorts().runOpsCall({
      projectId: args.projectId,
      name: `env set ${w.variable.key}`,
      argv: w.argv,
      secrets: target.secrets,
      timeoutMs: SCRIPT_OPS_TIMEOUT_DEFAULT_MS,
      cut,
    });
    const why = !ran.ok
      ? ran.why
      : ran.value.exitCode !== 0 || ran.value.timedOut
        ? `forge-ops answered${ran.value.timedOut ? ' past its time' : ''} with exit ${ran.value.exitCode ?? 'none'}: ${outputOf(ran.value)}`
        : null;
    if (why) {
      await auditWrites(args.projectId, caller, written, at);
      const before = written.length
        ? ` Written before it, and audited: ${written.map((v) => v.key).join(', ')}.`
        : ' Nothing was written.';
      throw refuse(
        'VARIABLE_TARGET_WRITE_FAILED',
        `writing ${w.variable.key} into forge-ops target \`${target.target}\`'s env file did not happen: ${why}.${before}`,
        `/key/${w.variable.key}`,
      );
    }
    written.push(w.variable);
  }
  await auditWrites(args.projectId, caller, written, at);
  return {
    view: {
      environment: environment.name,
      target: { kind: 'forge-ops', name: target.target },
      via: args.via,
      written: written.map((v) => ({ key: v.key, type: v.type, fingerprint: v.fingerprint })),
      withheld: plan.withheld,
    },
    target,
    cut,
  };
}

/** `POST /api/projects/:id/environments/:environment/variables/sync`: the explicit sync act (BC-10). */
export async function syncTargetVariables(
  projectId: string,
  userId: string,
  environment: string,
): Promise<TargetVariablesView> {
  return (await writeTarget({ projectId, userId, environment, via: 'sync' })).view;
}

/**
 * `POST /api/projects/:id/environments/:environment/forge-ops/deploy`: a forge-ops deploy through
 * Forge, which writes the env file first so the deploy runs on it (BC-10). A write that fails never
 * deploys; a deploy that fails is refused by name with the keys already written.
 */
export async function deployThroughTarget(
  projectId: string,
  userId: string,
  environment: string,
  req: ForgeOpsDeployRequest,
): Promise<TargetDeployView> {
  const { view, target, cut } = await writeTarget({
    projectId,
    userId,
    environment,
    via: 'deploy',
  });
  const ran = await projectConfigPorts().runOpsCall({
    projectId,
    name: FORGE_OPS_DEPLOY_TOOL,
    argv: [
      target.program,
      FORGE_OPS_DEPLOY_TOOL,
      JSON.stringify({ ...req.args, target: target.target }),
    ],
    secrets: target.secrets,
    timeoutMs: SCRIPT_OPS_TIMEOUT_MAX_MS,
    cut,
  });
  const why = !ran.ok
    ? ran.why
    : ran.value.exitCode !== 0 || ran.value.timedOut
      ? `forge-ops answered${ran.value.timedOut ? ' past its time' : ''} with exit ${ran.value.exitCode ?? 'none'}: ${outputOf(ran.value)}`
      : null;
  if (!ran.ok || why) {
    throw refuse(
      'VARIABLE_TARGET_DEPLOY_FAILED',
      `the forge-ops deploy of target \`${target.target}\` did not happen: ${why}. Its env file was written first, audited: ${view.written.map((v) => v.key).join(', ') || 'no key'}.`,
      '/args',
    );
  }
  return {
    ...view,
    deploy: {
      exitCode: ran.value.exitCode,
      stdout: ran.value.stdout,
      stderr: ran.value.stderr,
      durationMs: ran.value.durationMs,
    },
  };
}
