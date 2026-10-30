// The rules a project's environment variables answer to (REQ-80, design `environment-variables`
// r3), with no storage: which variable is effective on an environment, which a run is not given,
// and what a write is refused for. The service reads the rows and the project document; these
// decide.

import type { Refusal } from '@forge/contracts/refusal';
import {
  MASKED_VARIABLE_TYPES,
  type VariableRefusalCode,
  type VariableType,
} from '@forge/contracts/variables';
import { SCRUB_MIN_SECRET_LENGTH } from '@forge/observability';

/** An environment as the project document declares it: its name and its tier. */
export interface DeclaredEnvironment {
  name: string;
  tier: 'production' | 'staging' | 'preview' | 'dev';
}

/** What the rules read of a stored variable. */
export interface HeldVariable {
  id: string;
  key: string;
  environment: string | null;
  type: VariableType;
  protected: boolean;
}

export type VariableRefusal = Refusal & { code: VariableRefusalCode };

const refusal = (code: VariableRefusalCode, detail: string, path = ''): VariableRefusal => ({
  code,
  path,
  detail,
});

/**
 * Which variable each key resolves to on `environment`: the one scoped to it over the all-scope one
 * (BC-8). A protected variable reaches only a production-tier environment, and only a reader whose
 * work landed on it (`landed`); where the variable that would win is one it does not reach, the key
 * is withheld rather than answered with the less specific variable, so a run never runs on a value
 * nobody chose for it.
 */
export function effectiveVariables<V extends HeldVariable>(
  held: readonly V[],
  environment: DeclaredEnvironment,
  landed: boolean,
): { effective: Map<string, V>; withheld: string[] } {
  const winner = new Map<string, V>();
  for (const v of held) {
    if (v.environment !== null && v.environment !== environment.name) continue;
    const prior = winner.get(v.key);
    if (!prior || (prior.environment === null && v.environment !== null)) winner.set(v.key, v);
  }
  const reaches = environment.tier === 'production' && landed;
  const effective = new Map<string, V>();
  const withheld: string[] = [];
  for (const [key, v] of [...winner].sort(([a], [b]) => a.localeCompare(b))) {
    if (v.protected && !reaches) withheld.push(key);
    else effective.set(key, v);
  }
  return { effective, withheld };
}

/** Why a protected key is not given on this environment, in words the run reads. */
export function withheldWhy(environment: DeclaredEnvironment): string {
  return environment.tier === 'production'
    ? `environment \`${environment.name}\` is production-tier, and none of this run's issues landed on the branch it deploys from, so its protected variables are not given to it`
    : `environment \`${environment.name}\` is ${environment.tier}-tier, and a protected variable reaches only a production-tier environment`;
}

/** The keys a run asked for that nothing effective holds, refused naming each (BC-8). */
export function askRefusals(
  asked: readonly string[],
  read: { effective: ReadonlyMap<string, unknown>; withheld: readonly string[] },
  environment: DeclaredEnvironment,
): VariableRefusal[] {
  const out: VariableRefusal[] = [];
  for (const key of new Set(asked)) {
    if (read.effective.has(key)) continue;
    out.push(
      read.withheld.includes(key)
        ? refusal(
            'VARIABLE_PROTECTED_WITHHELD',
            `${key} is a protected variable: ${withheldWhy(environment)}.`,
            `/key/${key}`,
          )
        : refusal(
            'VARIABLE_KEY_UNKNOWN',
            `${key} is no variable of this project effective on environment \`${environment.name}\`; nothing was delivered.`,
            `/key/${key}`,
          ),
    );
  }
  return out;
}

/** What a variable's scope, protection and value are refused for before anything is stored (BC-2). */
export function writeRefusals(
  input: {
    key: string;
    environment: string | null;
    type: VariableType;
    protected: boolean;
    value: string | undefined;
  },
  environments: readonly DeclaredEnvironment[],
): VariableRefusal[] {
  const out: VariableRefusal[] = [];
  if (input.environment !== null) {
    const env = environments.find((e) => e.name === input.environment);
    if (!env) {
      out.push(
        refusal(
          'VARIABLE_ENVIRONMENT_UNKNOWN',
          `this project declares no environment \`${input.environment}\`; it declares ${environments.map((e) => `\`${e.name}\``).join(', ') || 'none'}. Scope the variable to one of them, or to every environment with null.`,
          '/environment',
        ),
      );
    } else if (input.protected && env.tier !== 'production') {
      out.push(
        refusal(
          'VARIABLE_PROTECTED_NOT_PRODUCTION',
          `${input.key} is protected, and environment \`${env.name}\` is ${env.tier}-tier: a protected variable reaches only a production-tier environment. Scope it to one, to every environment (it then reaches only the production-tier ones), or leave it unprotected.`,
          '/protected',
        ),
      );
    }
  }
  if (
    input.value !== undefined &&
    MASKED_VARIABLE_TYPES.includes(input.type) &&
    input.value.length < SCRUB_MIN_SECRET_LENGTH
  ) {
    out.push(
      refusal(
        'VARIABLE_SECRET_TOO_SHORT',
        `${input.key} is a ${input.type} variable of ${input.value.length} characters, and the log scrubber replaces only values of at least ${SCRUB_MIN_SECRET_LENGTH}, so it would reach a run's output in plain text; store a longer value or make it plain.`,
        '/value',
      ),
    );
  }
  return out;
}
