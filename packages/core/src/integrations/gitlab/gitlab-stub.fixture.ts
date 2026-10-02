/**
 * A recorded GitLab: requests are answered from a table keyed by method and path (query included),
 * and every request is kept with the token it carried, so a test reads what was SENT rather than
 * trusting what the code meant to send. No live GitLab is reached.
 */

export interface SentRequest {
  method: string;
  path: string;
  token: string | null;
  body: unknown;
}

export interface Answer {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

export function gitlabStub(answers: Record<string, Answer | ((sent: SentRequest) => Answer)>) {
  const sent: SentRequest[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname.replace(/^\/api\/v4/, '')}${url.search}`;
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const request: SentRequest = {
      method,
      path,
      token: headers.get('PRIVATE-TOKEN'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(request);
    const entry = answers[`${method} ${path}`];
    const answer = typeof entry === 'function' ? entry(request) : entry;
    if (!answer) {
      return new Response(JSON.stringify({ message: '404 Not found' }), { status: 404 });
    }
    const body = answer.text ?? JSON.stringify(answer.body ?? {});
    return new Response(body, { status: answer.status ?? 200, headers: answer.headers ?? {} });
  }) as typeof fetch;
  return { fetchStub, sent };
}
