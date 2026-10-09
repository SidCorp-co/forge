// Running one kept probe against the build a verified deploy serves (REQ-36 BC-12; ISS-470).
//
// A `request` probe is an HTTP call from core to the production environment's origin: its `url`,
// or the origin of the service the probe names. `as: "replayer"` sends it with the credential the
// caller hands in for that origin, which never appears in what this answers. A `command` probe is
// never run here: it runs stored argv, which belongs on a runner in a checkout of the served commit,
// and no runner leg replays one yet, so it is answered not replayed, naming why.

import {
  type CriterionProbe,
  criterionProbeSchema,
  type ProbeReplayOutcome,
  type ProbeRouting,
  probeRouteFault,
} from '@forge/contracts/criterion-probes';
import { sendKeptProbeRequest } from '../integrations/deploy/index.js';

/** The production environment a replay runs against: its origin, its services and their routes. */
export type ReplayOrigins = ProbeRouting;

/** The `Authorization` value a `replayer` request goes out with, or why there is none for `origin`. */
export type ReplayCredential = (
  origin: string,
) => Promise<{ ok: true; authorization: string } | { ok: false; why: string }>;

export interface ProbeRun {
  outcome: ProbeReplayOutcome;
  detail: string;
  /** Where the request went; null where none was sent. */
  url: string | null;
}

export interface ProbeRunContext {
  origins: ReplayOrigins;
  credential: ReplayCredential;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/** How long one request may take before it counts as unanswered. */
export const PROBE_REPLAY_TIMEOUT_MS = 15_000;
/** How much of a response body is read for the texts a probe expects. */
const BODY_CAP_CHARS = 1_000_000;

export const COMMAND_NOT_REPLAYED =
  'a command probe runs stored argv, which runs only on a runner in a checkout of the served commit and never in core, and no runner replays one yet';

function couldNotRun(detail: string, url: string | null = null): ProbeRun {
  return { outcome: 'could_not_run', detail, url };
}

/**
 * The origin a request probe's path is joined to, or why there is none: the same routing the verdict
 * door holds a probe to, so one kept before the environment declared its routes is not sent to an
 * origin that does not answer it and read as a regression.
 */
export function originOf(
  probe: Extract<CriterionProbe, { kind: 'request' }>,
  origins: ReplayOrigins,
): { ok: true; origin: string } | { ok: false; why: string } {
  const fault = probeRouteFault(probe.request, origins);
  if (fault !== null) return { ok: false, why: fault };
  const { service } = probe.request;
  const declared = service === undefined ? origins.url : origins.services[service];
  // probeRouteFault refuses a probe with no origin, so this holds whenever it answered null
  if (!declared) {
    throw new Error(`probe routing answered no fault and no origin for ${probe.request.path}`);
  }
  return { ok: true, origin: new URL(declared).origin };
}

async function bodyOf(response: Response): Promise<string> {
  const text = await response.text();
  return text.length > BODY_CAP_CHARS ? text.slice(0, BODY_CAP_CHARS) : text;
}

async function runRequest(
  probe: Extract<CriterionProbe, { kind: 'request' }>,
  ctx: ProbeRunContext,
): Promise<ProbeRun> {
  const origin = originOf(probe, ctx.origins);
  if (!origin.ok) return couldNotRun(origin.why);
  const url = `${origin.origin}${probe.request.path}`;
  const headers = new Headers(probe.request.headers ?? {});
  if (probe.request.as === 'replayer') {
    const credential = await ctx.credential(origin.origin);
    if (!credential.ok) return couldNotRun(credential.why, url);
    headers.set('authorization', credential.authorization);
  }
  let response: Response;
  try {
    response = await sendKeptProbeRequest(
      url,
      {
        method: probe.request.method,
        headers,
        body: probe.request.body,
        timeoutMs: ctx.timeoutMs ?? PROBE_REPLAY_TIMEOUT_MS,
      },
      ctx.fetchImpl,
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return couldNotRun(`${probe.request.method} ${url} was not answered: ${why}`, url);
  }
  const { status, bodyIncludes = [] } = probe.expect;
  const said = `${probe.request.method} ${probe.request.path} answered ${response.status}`;
  if (response.status !== status) {
    await response.body?.cancel().catch(() => {});
    return { outcome: 'failed', detail: `${said}, and the probe expects ${status}`, url };
  }
  const body = bodyIncludes.length > 0 ? await bodyOf(response) : '';
  if (bodyIncludes.length === 0) await response.body?.cancel().catch(() => {});
  const missing = bodyIncludes.filter((text) => !body.includes(text));
  if (missing.length > 0) {
    const texts = missing.map((t) => `\`${t}\``).join(', ');
    return { outcome: 'failed', detail: `${said} without ${texts}, which the probe expects`, url };
  }
  const withTexts = bodyIncludes.length > 0 ? ' with every text it expects' : '';
  return { outcome: 'held', detail: `${said}${withTexts}`, url };
}

/** One kept probe, as stored, run against the served build. */
export async function runKeptProbe(stored: unknown, ctx: ProbeRunContext): Promise<ProbeRun> {
  const parsed = criterionProbeSchema.safeParse(stored);
  if (!parsed.success) {
    const at = parsed.error.issues.map((i) => `/${i.path.join('/')}: ${i.message}`).join('; ');
    return couldNotRun(`the kept probe is not one the replayer can read (${at})`);
  }
  const probe = parsed.data;
  if (probe.kind === 'command') {
    return { outcome: 'not_replayed', detail: COMMAND_NOT_REPLAYED, url: null };
  }
  return runRequest(probe, ctx);
}
