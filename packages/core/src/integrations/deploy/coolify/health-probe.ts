const HEALTH_PROBE_TIMEOUT_MS = 10_000;

export type HealthReading = { healthy: true } | { healthy: false; reason: string };

/**
 * One reading of the running application.
 */
export async function probeHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthReading> {
  const target = new URL(url);
  target.searchParams.set('_forge_cb', String(Date.now()));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(target, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { healthy: false, reason: `http ${res.status}` };
    return readBody(text);
  } catch (err) {
    return {
      healthy: false,
      reason: `unreachable (${err instanceof Error ? err.message : 'unknown error'})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function readBody(text: string): HealthReading {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { healthy: false, reason: 'http 200 with an unparseable body' };
  }
  if (typeof body !== 'object' || body === null) {
    return { healthy: false, reason: 'http 200 with a non-object body' };
  }
  const obj = body as Record<string, unknown>;
  if (obj.ok === true) return { healthy: true };
  const down = Object.entries(obj)
    .filter(([, v]) => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false)
    .map(([k]) => k);
  return {
    healthy: false,
    reason: down.length > 0 ? `ok:false (${down.join(', ')} down)` : 'ok:false',
  };
}
