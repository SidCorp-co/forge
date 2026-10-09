// Pure rules of a preview: which setting and environment it starts with, whether a state lets an act
// through, and when the sweep moves it. Each answers a refusal or a decision; none touches the
// database.

import {
  PREVIEW_LIMITS,
  PREVIEW_MACHINE,
  PREVIEW_SERVING_STATES,
  type PreviewFailureReason,
  type PreviewRefusalCode,
  type PreviewSettings,
  type PreviewState,
} from '@forge/contracts/preview';
import type { Refusal } from '../lib/refusal.js';
import type { ProjectDocument } from '../project-config/index.js';

type EnvironmentDeclaration = ProjectDocument['environments'][string];

export interface PreviewPlan {
  /** Null: the project has no setting, so the box reports the repository's facts first. */
  settings: PreviewSettings | null;
  /** The variables of the environment the dev server talks to. */
  env: Record<string, string>;
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

/**
 * The setting a preview starts with and the environment it talks to (BC-11, BC-13): the project's
 * `preview` key, or none so the repository is read; the environment it names, else the project's
 * one `dev`-tier environment, else none. One whose tier is production is refused by name, as is a
 * name the project does not declare.
 */
export function previewPlan(
  document: {
    preview?: PreviewSettings | undefined;
    environments: Record<string, EnvironmentDeclaration>;
  } | null,
): { ok: true; plan: PreviewPlan } | { ok: false; refusal: Refusal } {
  const settings = document?.preview ?? null;
  const environments = document?.environments ?? {};
  const named = settings?.environment;
  if (named !== undefined) {
    const environment = environments[named];
    if (!environment) {
      return {
        ok: false,
        refusal: refusal(
          'PREVIEW_SETTINGS_INVALID',
          `preview.environment names ${named}, which the project document does not declare; name one of: ${Object.keys(environments).join(', ') || 'none is declared'}`,
          '/preview/environment',
        ),
      };
    }
    if (environment.tier === 'production') {
      return {
        ok: false,
        refusal: refusal(
          'PREVIEW_PRODUCTION_ENVIRONMENT',
          `preview.environment names ${named}, whose tier is production: a preview talks to a dev environment, never production (REQ-39 BC-13)`,
          '/preview/environment',
        ),
      };
    }
    return { ok: true, plan: { settings, env: variablesOf(named, environment) } };
  }
  const dev = Object.entries(environments).filter(([, e]) => e.tier === 'dev');
  const only = dev.length === 1 ? dev[0] : undefined;
  return {
    ok: true,
    plan: { settings, env: only ? variablesOf(only[0], only[1]) : { FORGE_PREVIEW: '1' } },
  };
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
