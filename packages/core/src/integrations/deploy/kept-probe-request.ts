// The send of one kept request probe a verified deploy replays (REQ-36 BC-12; ISS-470): the build's
// own answer, never a redirect followed on its behalf, and never longer than the caller's timeout.
// What the answer means is `release-batch/probe-run.ts`'s.

export interface KeptProbeRequest {
  method: string;
  headers: Headers;
  body?: string | undefined;
  timeoutMs: number;
}

export async function sendKeptProbeRequest(
  url: string,
  request: KeptProbeRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(url, {
    method: request.method,
    headers: request.headers,
    ...(request.body !== undefined ? { body: request.body } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(request.timeoutMs),
  });
}
