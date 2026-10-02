/** One GraphQL POST against an Autoflow platform, bearer-authenticated and time-boxed. */

export type AutoflowGqlResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'unauthorized'; status: number; message: string }
  | { kind: 'http-error'; status: number }
  | { kind: 'graphql-error'; message: string };

/**
 * The platform answers a rejected bearer with HTTP 200 and an `UNAUTHENTICATED` GraphQL error, so
 * an auth refusal is read from the error's code or wording as well as from the status.
 */
export async function autoflowGql(
  url: string,
  token: string,
  query: string,
  timeoutMs: number,
): Promise<AutoflowGqlResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { kind: 'unauthorized', status: res.status, message: `HTTP ${res.status}` };
    }
    if (!res.ok) return { kind: 'http-error', status: res.status };
    const body = (await res.json()) as {
      data?: Record<string, unknown> | null;
      errors?: Array<{ message?: string; extensions?: { code?: string } }> | null;
    };
    const first = body.errors?.[0];
    if (first) {
      const message = first.message ?? 'graphql error';
      const auth =
        first.extensions?.code === 'UNAUTHENTICATED' ||
        /unauthenticated|invalid (access )?token|token (is )?expired/i.test(message);
      return auth
        ? { kind: 'unauthorized', status: 200, message }
        : { kind: 'graphql-error', message };
    }
    return { kind: 'ok', data: body.data ?? {} };
  } finally {
    clearTimeout(timer);
  }
}
