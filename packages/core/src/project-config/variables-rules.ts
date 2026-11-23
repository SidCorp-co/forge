// The rules a project's environment variables answer to (REQ-80, design `environment-variables`
// r3), with no storage: which variable is effective on an environment, which a run is not given,
// whether a person's ruling opens a protected one (BC-11), and what a write is refused for. The
// service reads the rows and the project document; these decide.

import { ISSUE_TERMINAL_STATUSES, type IssueStatus } from '@forge/contracts/issue-machine';
import { RULING_ENVIRONMENT_FIELD } from '@forge/contracts/record-events';
import type { Refusal } from '@forge/contracts/refusal';
import {
  MASKED_VARIABLE_TYPES,
  type VariableRefusalCode,
  type VariableType,
} from '@forge/contracts/variables';
import { SCRUB_MIN_SECRET_LENGTH } from '@forge/observability';

/** An environment as the project document declares it: its name, its tier and its deploy branch. */
export interface DeclaredEnvironment {
  name: string;
  tier: 'production' | 'staging' | 'preview' | 'dev';
  deploysFrom?: string | undefined;
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
 * (BC-8). A protected variable reaches only a production-tier environment, and only a reader it is
 * opened to (`opened`): its work landed there (BC-8), or a person ruled the production act it works
 * (BC-11). Where the variable that would win is one it does not reach, the key is withheld rather
 * than answered with the less specific variable, so a run never runs on a value nobody chose for it.
 */
export function effectiveVariables<V extends HeldVariable>(
  held: readonly V[],
  environment: DeclaredEnvironment,
  opened: boolean,
): { effective: Map<string, V>; withheld: string[] } {
  const winner = new Map<string, V>();
  for (const v of held) {
    if (v.environment !== null && v.environment !== environment.name) continue;
    const prior = winner.get(v.key);
    if (!prior || (prior.environment === null && v.environment !== null)) winner.set(v.key, v);
  }
  const reaches = environment.tier === 'production' && opened;
  const effective = new Map<string, V>();
  const withheld: string[] = [];
  for (const [key, v] of [...winner].sort(([a], [b]) => a.localeCompare(b))) {
    if (v.protected && !reaches) withheld.push(key);
    else effective.set(key, v);
  }
  return { effective, withheld };
}

/** The ruling a protected variable is opened by (BC-11), in the words every reader of it is told. */
const rulingReaders = (environment: DeclaredEnvironment): string =>
  `a run working an open issue that carries a project admin's ruling for a production act on \`${environment.name}\``;

/**
 * Which runs read a protected variable on this production-tier environment (BC-8, BC-11), in the
 * words the asker of a slot and a run refused one both read (ISS-1392).
 */
export function protectedReaders(environment: DeclaredEnvironment): string {
  return environment.deploysFrom
    ? `only a run with an issue merged on \`${environment.deploysFrom}\`, the branch \`${environment.name}\` deploys from, or ${rulingReaders(environment)}, reads it`
    : `\`${environment.name}\` names no branch it deploys from, so only ${rulingReaders(environment)} reads it`;
}

/**
 * A `decision` record on an issue of the project that names a production-tier environment in its
 * `production` field (`RULING_ENVIRONMENT_FIELD`), as the door read it: whether it is a ruling that
 * opens that environment is decided here.
 */
export interface DecisionNamingProduction {
  /** The record's id, which the audit of every read it opens names. */
  id: string;
  issueId: string;
  issueKey: string;
  issueStatus: string;
  /** What its `production` field names. */
  environment: string;
  /** The act it rules, its `decision` field; null where it names none. */
  act: string | null;
  /** The date its `until` field ends it on, read as every decision's is; null for none or a condition. */
  untilAt: Date | null;
  writer: { type: string; id: string; agency: 'human' | 'agent'; name: string };
}

/** What a run lacks to read a protected variable, and who gives it, in words it asks with (BC-12). */
export interface RulingAsk {
  lacks: string;
  who: string;
}

export type RulingRead =
  | { kind: 'ruled'; ruling: DecisionNamingProduction }
  | { kind: 'lacking'; ask: RulingAsk };

const isOpen = (status: string): boolean =>
  !(ISSUE_TERMINAL_STATUSES as readonly string[]).includes(status as IssueStatus);

/** Why one decision on the run's own issue naming the environment is no ruling, or null where it is. */
function faultOf(
  d: DecisionNamingProduction,
  env: string,
  admins: ReadonlySet<string>,
  now: Date,
): string | null {
  if (!isOpen(d.issueStatus)) {
    return `${d.issueKey}'s ruling for \`${env}\` no longer holds: ${d.issueKey} is ${d.issueStatus}, and a ruling holds only while its issue is open`;
  }
  if (d.writer.type !== 'user' || d.writer.agency !== 'human') {
    return `the decision on ${d.issueKey} naming \`${env}\` was written by an agent, and a ruling is a person's`;
  }
  if (!admins.has(d.writer.id)) {
    return `the decision on ${d.issueKey} naming \`${env}\` was written by ${d.writer.name}, who holds no project.admin here`;
  }
  if (!d.act?.trim()) {
    return `the decision on ${d.issueKey} naming \`${env}\` names no act in its \`decision\` field`;
  }
  if (d.untilAt && d.untilAt <= now) {
    return `${d.issueKey}'s ruling for \`${env}\` lapsed at ${d.untilAt.toISOString()} (its \`until\`)`;
  }
  return null;
}

/**
 * Whether a ruling opens `environment`'s protected variables to a run working `runIssues` (BC-11):
 * a standing decision on one of those issues, while it is open, written by a person who holds
 * project.admin, naming the act and this environment. Where none does, what the nearest one lacks,
 * and who gives it.
 */
export function rulingRead(input: {
  decisions: readonly DecisionNamingProduction[];
  environment: DeclaredEnvironment;
  runIssues: readonly { id: string; key: string }[];
  admins: readonly { id: string; name: string }[];
  now: Date;
}): RulingRead {
  const env = input.environment.name;
  const admins = new Set(input.admins.map((a) => a.id));
  const mine = new Set(input.runIssues.map((i) => i.id));
  const onRun = input.decisions.filter((d) => mine.has(d.issueId));
  const here = onRun.filter((d) => d.environment === env);
  const ruled = here.find((d) => faultOf(d, env, admins, input.now) === null);
  if (ruled) return { kind: 'ruled', ruling: ruled };
  const who =
    input.admins.length > 0
      ? `a person holding project.admin on this project (${input.admins.map((a) => a.name).join(', ')})`
      : 'a person holding project.admin on this project (nobody holds project.admin here now; an org owner grants it)';
  const keys = input.runIssues.map((i) => i.key).join(', ');
  const failed = here.find(() => true);
  const elsewhere = onRun.find((d) => d.environment !== env);
  const other = input.decisions.find(
    (d) =>
      !mine.has(d.issueId) && d.environment === env && faultOf(d, env, admins, input.now) === null,
  );
  const lacks =
    input.runIssues.length === 0
      ? 'this run works no issue, and a ruling is read off the issue a run works'
      : failed
        ? (faultOf(failed, env, admins, input.now) as string)
        : elsewhere
          ? `${elsewhere.issueKey}'s ruling names \`${elsewhere.environment}\`, not \`${env}\``
          : other
            ? `${other.issueKey} carries a ruling for \`${env}\`, and this run works ${keys}, not ${other.issueKey}`
            : `none of this run's issues (${keys}) carries a ruling for a production act on \`${env}\``;
  return { kind: 'lacking', ask: { lacks, who } };
}

/**
 * Why a protected key is not given on this environment, in words the run reads: on a production-tier
 * one, the ruling it lacks and whom to ask for it, once, naming the act and the environment (BC-12).
 */
export function withheldWhy(environment: DeclaredEnvironment, ask: RulingAsk | null): string {
  if (environment.tier !== 'production') {
    return `environment \`${environment.name}\` is ${environment.tier}-tier, and a protected variable reaches only a production-tier environment`;
  }
  const lacks = ask ? ` ${ask.lacks}.` : '';
  const who = ask?.who ?? 'a person holding project.admin on this project';
  return `environment \`${environment.name}\` is production-tier: ${protectedReaders(environment)}.${lacks} Ask ${who} once, in plain words, for a ruling on the act this run is to do, naming that act and \`${environment.name}\`; they record it on the issue as a decision whose \`${RULING_ENVIRONMENT_FIELD}\` field is \`${environment.name}\`, and the variable stays protected`;
}

/** The keys a run asked for that nothing effective holds, refused naming each (BC-8). */
export function askRefusals(
  asked: readonly string[],
  read: { effective: ReadonlyMap<string, unknown>; withheld: readonly string[] },
  environment: DeclaredEnvironment,
  ask: RulingAsk | null,
): VariableRefusal[] {
  const out: VariableRefusal[] = [];
  for (const key of new Set(asked)) {
    if (read.effective.has(key)) continue;
    out.push(
      read.withheld.includes(key)
        ? refusal(
            'VARIABLE_PROTECTED_WITHHELD',
            `${key} is a protected variable: ${withheldWhy(environment, ask)}.`,
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
