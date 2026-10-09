// Pure rules of a preview: which setting and environment it starts with, whether a state lets an act
// through, and when the sweep moves it. Each answers a refusal or a decision; none touches the
// database.

import { BUILT_IN_FULL_GATE_PATHS, globToRegExp } from '@forge/contracts/fast-lane';
import { ROOM_NEVER_MERGES_INTO, type RoomRefusalCode } from '@forge/contracts/poc-room';
import {
  PREVIEW_LIMITS,
  PREVIEW_MACHINE,
  PREVIEW_SERVING_STATES,
  type PreviewFailureReason,
  type PreviewRefusalCode,
  type PreviewSettings,
  type PreviewState,
  type PreviewSubjectKind,
  previewEnvironmentProblem,
  reproduceDataOf,
} from '@forge/contracts/preview';
import { TERMINAL_AGENT_SESSION_STATUSES } from '@forge/contracts/session-machine';
import type { Refusal } from '../lib/refusal.js';
import type { ProjectDocument } from '../project-config/index.js';

type EnvironmentDeclaration = ProjectDocument['environments'][string];

export interface PreviewPlan {
  /** Null: the project has no setting, so the box reports the repository's facts first. */
  settings: PreviewSettings | null;
  /** The variables of the environment the dev server talks to. */
  env: Record<string, string>;
  /** The demo seed a reproduce runs in its checkout before the dev server (REQ-41 BC-22). */
  seed: string | null;
  /** Where the dev server's data comes from: the project's demo data, or the environment named. */
  data: 'demo' | 'environment';
}

const refusal = (code: PreviewRefusalCode, detail: string, path = ''): Refusal => ({
  code,
  path,
  detail,
});

const envName = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/** What an environment hands a dev server: its name, its URL and each service's URL. */
function variablesOf(name: string, environment: EnvironmentDeclaration): Record<string, string> {
  const vars: Record<string, string> = { FORGE_PREVIEW: '1', FORGE_ENVIRONMENT: name };
  if (environment.url) vars.FORGE_ENVIRONMENT_URL = environment.url;
  for (const [service, url] of Object.entries(environment.services ?? {})) {
    vars[`FORGE_SERVICE_${envName(service)}_URL`] = url;
  }
  return vars;
}

type Environments = Record<string, EnvironmentDeclaration>;

/**
 * The variables of the environment `named` at `path` of the setting: one the project declares and
 * whose tier is not production (REQ-39 BC-13), else the project's one `dev`-tier environment when
 * none is named, else none.
 */
function environmentOf(
  environments: Environments,
  named: string | undefined,
  path: string,
): { ok: true; env: Record<string, string> } | { ok: false; refusal: Refusal } {
  if (named !== undefined) {
    const problem = previewEnvironmentProblem(named, environments, path);
    if (problem) return { ok: false, refusal: refusal(problem.code, problem.detail, path) };
    const environment = environments[named] as EnvironmentDeclaration;
    return { ok: true, env: variablesOf(named, environment) };
  }
  const dev = Object.entries(environments).filter(([, e]) => e.tier === 'dev');
  const only = dev.length === 1 ? dev[0] : undefined;
  return { ok: true, env: only ? variablesOf(only[0], only[1]) : { FORGE_PREVIEW: '1' } };
}

/**
 * The setting a preview starts with and the environment it talks to (BC-11, BC-13): the project's
 * `preview` key, or none so the repository is read; the environment it names, else the project's
 * one `dev`-tier environment, else none. A reproduce (REQ-41 BC-22) reads its data through
 * `reproduceDataOf`: the demo environment and seed `preview.demo` names, else the same environment
 * as any preview. One whose tier is production is refused by name, as is a name the project does
 * not declare.
 */
export function previewPlan(
  document: {
    preview?: PreviewSettings | undefined;
    environments: Environments;
  } | null,
  subject: PreviewSubjectKind = 'issue',
  /** A POC room's idea (REQ-44 BC-12) takes the reproduce's data: the demo data where declared. */
  throwaway = false,
): { ok: true; plan: PreviewPlan } | { ok: false; refusal: Refusal } {
  const settings = document?.preview ?? null;
  const environments = document?.environments ?? {};
  if (subject === 'reproduce' || throwaway) {
    const data = reproduceDataOf(settings ?? {});
    const demoNamed = data.kind === 'demo' && settings?.demo?.environment !== undefined;
    const path = demoNamed ? '/preview/demo/environment' : '/preview/environment';
    const env = environmentOf(environments, data.environment ?? undefined, path);
    if (!env.ok) return env;
    return {
      ok: true,
      plan: {
        settings,
        env: env.env,
        seed: data.kind === 'demo' ? data.seed : null,
        data: data.kind,
      },
    };
  }
  const env = environmentOf(environments, settings?.environment, '/preview/environment');
  if (!env.ok) return env;
  return { ok: true, plan: { settings, env: env.env, seed: null, data: 'environment' } };
}

/** The states a preview leaves only by a move: a run's one preview stands at one of these. */
export const OPEN_STATES: readonly PreviewState[] = PREVIEW_MACHINE.states.filter(
  (s) => !(PREVIEW_MACHINE.terminal as readonly string[]).includes(s),
);

const CLOSED_BY: Record<string, string> = {
  approved: 'was approved',
  abandoned: 'was abandoned',
  failed: 'failed',
};

/** Why an act cannot take a preview standing at `state`, or null when `allowed` holds it. */
export function stateRefusal(
  previewId: string,
  state: PreviewState,
  allowed: readonly PreviewState[],
  act: string,
): Refusal | null {
  if (allowed.includes(state)) return null;
  if (!OPEN_STATES.includes(state)) {
    return refusal(
      'PREVIEW_CLOSED',
      `preview ${previewId} ${CLOSED_BY[state] ?? `is ${state}`}, so it cannot ${act}; open a new preview from the issue`,
    );
  }
  return refusal(
    'PREVIEW_NOT_LIVE',
    `preview ${previewId} is ${state}, so it cannot ${act}; it can when it is ${allowed.join(' or ')}`,
  );
}

/** Whether the link serves (or is about to): every other state answers the closed page. */
export const serves = (state: PreviewState) =>
  (PREVIEW_SERVING_STATES as readonly PreviewState[]).includes(state);

export interface SweepFacts {
  state: PreviewState;
  idleMinutes: number;
  liveAt: number | null;
  lastViewedAt: number | null;
  /** When the box was last asked to start it. */
  startedAt: number;
  tunnel: { up: boolean; upAt: number | null; lostAt: number | null };
  /** Whether the box holds its control socket now. */
  boxConnected: boolean;
  /** When this process began watching tunnels: a tunnel lost before it is not dated. */
  watchingSince: number;
}

export type SweepMove =
  | { to: 'idle_closed'; why: string }
  | { to: 'failed'; reason: PreviewFailureReason; detail: string }
  | null;

/**
 * The move the sweep owes a preview (BC-9, BC-10): idle past its setting with no viewer, its box's
 * tunnel away past the grace, a box that never opened one, or a dev server that never answered.
 */
export function sweepMove(f: SweepFacts, now: number): SweepMove {
  const grace = PREVIEW_LIMITS.tunnelGraceSeconds * 1000;
  if (f.state === 'starting') {
    if (!f.tunnel.up && !(f.tunnel.upAt !== null && f.tunnel.upAt >= f.startedAt)) {
      if (now - f.startedAt <= grace) return null;
      return f.boxConnected
        ? {
            to: 'failed',
            reason: 'RUNNER_CANNOT_PREVIEW',
            detail: `the box is connected but opened no preview tunnel within ${PREVIEW_LIMITS.tunnelGraceSeconds}s of being asked to start: its forge-runner predates previews (forge-runner update)`,
          }
        : {
            to: 'failed',
            reason: 'RUNNER_OFFLINE',
            detail: `the box holding the worktree is not connected and opened no preview tunnel within ${PREVIEW_LIMITS.tunnelGraceSeconds}s`,
          };
    }
    const limit = (PREVIEW_LIMITS.readyTimeoutSeconds + PREVIEW_LIMITS.tunnelGraceSeconds) * 1000;
    if (now - f.startedAt > limit) {
      return {
        to: 'failed',
        reason: 'DEV_SERVER_NOT_LISTENING',
        detail: `the box reported neither the dev server live nor its failure within ${limit / 1000}s of being asked to start it`,
      };
    }
    return null;
  }
  if (f.state !== 'live') return null;
  if (!f.tunnel.up) {
    const since = f.tunnel.lostAt ?? f.watchingSince;
    if (now - since > grace) {
      return {
        to: 'failed',
        reason: 'RUNNER_OFFLINE',
        detail: `the box's preview tunnel has been away for more than ${PREVIEW_LIMITS.tunnelGraceSeconds}s`,
      };
    }
    return null;
  }
  const seen = f.lastViewedAt ?? f.liveAt ?? f.startedAt;
  if (now - seen > f.idleMinutes * 60_000) {
    return {
      to: 'idle_closed',
      why: `nobody viewed it for ${f.idleMinutes} minutes, the project's idle setting`,
    };
  }
  return null;
}

/** What the sweep reads of the run a preview names: its session's status and its box's ledger marks. */
export interface RunFacts {
  sessionStatus: string;
  /** The box reports the run's checkout released. */
  checkoutReleased: boolean;
  /** The box records the run's session as closed by core. */
  sessionClosedOnBox: boolean;
}

/**
 * Why an open preview's run has ended, or null while it has not. An issue's preview serves the run's
 * own worktree, so it ends with the run: the session reached a terminal status, or the box reports
 * it closed or its checkout released. A preview of any other subject holds a checkout of its own: an
 * idea's sketch run is a chat session whose turn completes once it has built the change, and the
 * preview has to outlive that turn and take the next (REQ-41 BC-14, BC-15). Only the box reporting
 * the checkout released ends it here; keep, abandon and idle close are the person's and the sweep's.
 */
export function runEndedWhy(subjectKind: PreviewSubjectKind, run: RunFacts): string | null {
  const releasedOnBox = run.checkoutReleased || (subjectKind === 'issue' && run.sessionClosedOnBox);
  if (releasedOnBox) {
    return 'the run holding the worktree ended: its box reports the checkout released';
  }
  if (subjectKind !== 'issue') return null;
  return (TERMINAL_AGENT_SESSION_STATUSES as readonly string[]).includes(run.sessionStatus)
    ? `the run holding the worktree ended: its session is ${run.sessionStatus}`
    : null;
}

/**
 * The branch a settled POC room merges into (REQ-44 BC-2, BC-8): the project's git default branch,
 * where work lands. Refused by name where there is none, or where it is main, master or the branch
 * production deploys from: a POC never merges straight into production.
 */
export function roomLanding(
  document: Pick<ProjectDocument, 'source' | 'environments'> | null,
): { ok: true; into: string } | { ok: false; code: RoomRefusalCode; detail: string } {
  const into = document?.source.type === 'git' ? document.source.git.defaultBranch : null;
  if (!into) {
    return {
      ok: false,
      code: 'ROOM_NO_DEV_BRANCH',
      detail:
        'the project document declares no git source with a default branch, so a settled room has no dev branch to merge into: declare source.git.defaultBranch',
    };
  }
  // every production environment, not the first: any one deploying from the branch is production's
  const production = Object.entries(document?.environments ?? {}).find(
    ([, e]) => e.tier === 'production' && e.deploysFrom === into,
  );
  if ((ROOM_NEVER_MERGES_INTO as readonly string[]).includes(into) || production) {
    return {
      ok: false,
      code: 'ROOM_PRODUCTION_BRANCH',
      detail: `the project's default branch is ${into}${production ? `, which production environment ${production[0]} deploys from` : ''}: a POC branch merges straight into a dev branch only, never main or production's. Land work on a dev branch (source.git.defaultBranch) promoted to production`,
    };
  }
  return { ok: true, into };
}

/** The files of a change that alter the schema: the migration globs every lane holds, and the project's own. */
export function schemaFilesOf(files: readonly string[], extra: readonly string[] = []): string[] {
  const globs = [...BUILT_IN_FULL_GATE_PATHS.migrations, ...extra].map(globToRegExp);
  return files.filter((f) => globs.some((re) => re.test(f)));
}
