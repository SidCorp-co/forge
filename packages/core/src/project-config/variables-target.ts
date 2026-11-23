// The rules of writing a project's variables into a deploy target (REQ-80 BC-10), with no storage
// and no box: which target Forge may write, which effective variables it writes there and which it
// does not, and the one forge-ops call each write is. The exception is a forge-ops compose target
// alone (the Steward's question f88c3727); every other deployment is refused by name, naming what to
// bind. The door (`variables-target-door.ts`) reads the rows and runs the calls.

import { BOX_ARG_MAX_CHARS, FORGE_OPS_ENV_TOOL } from '@forge/contracts/script-sandbox';
import { MASKED_VARIABLE_TYPES, type VariableType } from '@forge/contracts/variables';
import type { EnvironmentDeclaration, ForgeOpsTargetDeclaration } from './schema.js';
import type { VariableRefusal } from './variables-rules.js';

/** What an environment's deployment declares to be written into, in the shape the refusal teaches. */
export const FORGE_OPS_BIND_SHAPE =
  '{"mode": "external", "target": "forge-ops", "forgeOps": {"program": "<the forge-ops CLI on the box, such as /home/dev/.local/bin/forge-ops>", "target": "<the target as forge-ops list_targets names it, with env enabled>", "secrets": [{"env": "<the variable the CLI reads its credential from>", "secret": "secret://<scope>/<name>"}]}}';

/**
 * The forge-ops compose target `environment` declares Forge writes its env file in, or the refusal
 * naming what to bind: a deployment through a binding, or one outside Forge naming no forge-ops
 * target, is no target Forge writes to.
 */
export function forgeOpsTargetOf(
  name: string,
  env: Pick<EnvironmentDeclaration, 'deployment'>,
): { ok: true; target: ForgeOpsTargetDeclaration } | { ok: false; refusal: VariableRefusal } {
  const { deployment } = env;
  if ('mode' in deployment && deployment.forgeOps) {
    return { ok: true, target: deployment.forgeOps };
  }
  const how =
    'binding' in deployment
      ? `deploys through binding ${deployment.binding}, and Forge writes variables only into a forge-ops compose target's env file (REQ-80 BC-10); a run on that deployment reads them at GET /api/jobs/<run id>/variables/${name}`
      : `is deployed outside Forge${deployment.target ? ` by \`${deployment.target}\`` : ''} and names no forge-ops compose target Forge can write its env file in`;
  return {
    ok: false,
    refusal: {
      code: 'VARIABLE_TARGET_UNBOUND',
      path: `/environments/${name}/deployment/forgeOps`,
      detail: `environment \`${name}\` ${how}. Where it runs on a forge-ops compose target, bind it on the project document: environments.${name}.deployment = ${FORGE_OPS_BIND_SHAPE}, with the forge-ops credential written as that project secret first. Nothing was written.`,
    },
  };
}

/** One effective variable with its value, as the door read it from the store. */
export interface HeldValue {
  id: string;
  key: string;
  type: VariableType;
  protected: boolean;
  fingerprint: string;
  value: string;
}

/** One write the door runs: the variable, and the forge-ops call that sets it on the target. */
export interface EnvWrite {
  variable: HeldValue;
  argv: string[];
}

/** The forge-ops call that sets `key` in `target`'s env file: no shell, the arguments one JSON item. */
export function envSetArgv(
  target: ForgeOpsTargetDeclaration,
  key: string,
  value: string,
): string[] {
  return [
    target.program,
    FORGE_OPS_ENV_TOOL,
    JSON.stringify({ target: target.target, action: 'set', key, value }),
  ];
}

/** Why an effective variable is not written into an env file, or null where it is. */
function unwritable(v: HeldValue, argv: string[]): string | null {
  if (v.type === 'file') {
    return `${v.key} is a file variable, a file's content, and an env file holds one line per key; mount it on the target instead`;
  }
  if (/[\r\n]/.test(v.value)) {
    return `${v.key} holds a line break, and an env file holds one line per key`;
  }
  if ((argv[2] ?? '').length > BOX_ARG_MAX_CHARS) {
    return `${v.key}'s value is past what one forge-ops argument carries through the box (${BOX_ARG_MAX_CHARS} characters with its key and target)`;
  }
  return null;
}

/**
 * The writes of `effective` into `target`, each in key order, and every key not written with why:
 * the protected keys `effectiveVariables` withheld from this environment, and any value an env file
 * cannot hold. Nothing is left out unsaid.
 */
export function envWritesOf(
  target: ForgeOpsTargetDeclaration,
  effective: readonly HeldValue[],
  withheld: readonly string[],
  environment: { name: string; tier: string },
): { writes: EnvWrite[]; withheld: { key: string; why: string }[] } {
  const writes: EnvWrite[] = [];
  const out = withheld.map((key) => ({
    key,
    why: `${key} is protected, and environment \`${environment.name}\` is ${environment.tier}-tier: a protected variable reaches only a production-tier environment`,
  }));
  for (const v of [...effective].sort((a, b) => a.key.localeCompare(b.key))) {
    const argv = envSetArgv(target, v.key, v.value);
    const why = unwritable(v, argv);
    if (why) out.push({ key: v.key, why });
    else writes.push({ variable: v, argv });
  }
  return { writes, withheld: out.sort((a, b) => a.key.localeCompare(b.key)) };
}

/**
 * Each secret, file or protected value as the box's output may echo it, named by its key, for the
 * port to cut: as stored, and as the call's JSON argument escapes it where that differs. A plain
 * value is no secret (BC-1), and cutting a short one would cut that word out of every answer.
 */
export function cutOf(values: readonly HeldValue[]): Record<string, string> {
  return Object.fromEntries(
    values.flatMap((v) => {
      if (!MASKED_VARIABLE_TYPES.includes(v.type) && !v.protected) return [];
      const escaped = JSON.stringify(v.value).slice(1, -1);
      return [
        [`variable ${v.key}`, v.value],
        ...(escaped === v.value ? [] : [[`variable ${v.key} (escaped)`, escaped]]),
      ];
    }),
  );
}
