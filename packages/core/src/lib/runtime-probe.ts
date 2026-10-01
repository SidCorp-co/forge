/**
 * The one reader of a runtime probe, for release verification (`release-batch/verify.ts`) and an
 * environment's state (`project-config/environment-state.ts`): each keeps its own refusal codes,
 * and what a reading IS is decided here.
 *
 * Where the two readers differed, the stricter rule was taken: exactly 200 (not any 2xx), a
 * string at the path that is non-empty once trimmed and at most {@link PROBE_VALUE_MAX}
 * characters, a path walked over own keys only, a request capped at {@link PROBE_TIMEOUT_MS}, and
 * every request sent past a cache.
 */

export interface RuntimeProbeTarget {
  url: string;
  /** Dot path into the JSON body. Omitted → the whole body, trimmed. */
  path?: string | undefined;
}

/**
 * One probe's answer, kept as the shape it had: `unreachable` and `http-error` are a failure to
 * answer; `no-value`, `unparseable` and `oversized` are an answer that names nothing.
 */
export type ProbeReading =
  | { kind: 'value'; value: string }
  | { kind: 'no-value' }
  | { kind: 'unparseable' }
  | { kind: 'oversized'; length: number }
  | { kind: 'http-error'; status: number }
  | { kind: 'unreachable'; detail: string };

export const PROBE_TIMEOUT_MS = 5_000;
export const PROBE_VALUE_MAX = 200;

/** Whether this reading says the application answered at all. */
export function probeAnswered(r: ProbeReading): boolean {
  return r.kind !== 'unreachable' && r.kind !== 'http-error';
}

const where = (probe: RuntimeProbeTarget) => `\`${probe.path ?? '(whole body)'}\``;

export function describeProbeReading(probe: RuntimeProbeTarget, r: ProbeReading): string {
  switch (r.kind) {
    case 'value':
      return `${probe.url} -> ${r.value}`;
    case 'no-value':
      return `GET ${probe.url} carries no string at ${where(probe)}`;
    case 'unparseable':
      return `GET ${probe.url} answered a body that is not JSON`;
    case 'oversized':
      return `GET ${probe.url} carries ${r.length} characters at ${where(probe)}, over the ${PROBE_VALUE_MAX} an identity may hold`;
    case 'http-error':
      return `GET ${probe.url} answered HTTP ${r.status}`;
    case 'unreachable':
      return `GET ${probe.url} did not answer (${r.detail})`;
  }
}

function readPath(body: unknown, path: string): unknown {
  let at: unknown = body;
  for (const key of path.split('.')) {
    if (at === null || typeof at !== 'object' || !Object.hasOwn(at, key)) return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

function readingOf(raw: unknown): ProbeReading {
  if (typeof raw !== 'string' || raw.trim() === '') return { kind: 'no-value' };
  const value = raw.trim();
  if (value.length > PROBE_VALUE_MAX) return { kind: 'oversized', length: value.length };
  return { kind: 'value', value };
}

/**
 * Read one probe. The URL is built before the request, so a probe url that does not parse throws
 * rather than becoming a reading; every caller's door screens the declaration ahead of it.
 */
export async function readRuntimeProbe(
  probe: RuntimeProbeTarget,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<ProbeReading> {
  const url = new URL(probe.url);
  url.searchParams.set('_forge_cb', String(Math.random()).slice(2));
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS));
  const fetchImpl = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      kind: 'unreachable',
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
  if (res.status !== 200) return { kind: 'http-error', status: res.status };
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    return {
      kind: 'unreachable',
      detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
  if (probe.path === undefined) return readingOf(text);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'unparseable' };
  }
  return readingOf(readPath(body, probe.path));
}
