/**
 * Shared by both chat adapters below the wire format: open a streaming request with a pre-stream retry (nothing consumed yet, so a transient 429/5xx or a network hiccup is retried with backoff; mid-stream errors are NOT retried, partial output may already have been yielded) and split the body into SSE `data:` payloads.
 */

/** Transient upstream statuses worth a pre-stream retry (Vertex "high demand" surfaces as 503 through a proxy; 429 is straight rate limiting; 529 is Anthropic's overloaded). */
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
export const DEFAULT_RETRY_DELAYS_MS = [1000, 3000];

export interface OpenStreamOptions {
  fetchImpl: typeof fetch;
  url: string;
  init: () => RequestInit;
  retryDelaysMs: number[];
  signal?: AbortSignal | undefined;
  label: string;
  /** On a 400: inspect the body, drop the offending optional field and return true to retry at once without spending a backoff attempt. */
  degrade?: ((body: string) => boolean) | undefined;
}

export async function openStream(
  o: OpenStreamOptions,
): Promise<{ body: ReadableStream<Uint8Array> } | { error: string }> {
  let lastError = '';
  for (let attempt = 0; ; attempt++) {
    let res: Response | null = null;
    try {
      res = await o.fetchImpl(o.url, o.init());
    } catch (err) {
      lastError = errorMessage(err);
    }
    if (res?.ok && res.body) return { body: res.body };
    if (res) {
      const body = await safeReadText(res);
      lastError = `${o.label} http ${res.status}${body ? `: ${body.slice(0, 500)}` : ''}`;
      if (res.status === 400 && o.degrade?.(body)) {
        attempt--;
        continue;
      }
      if (!RETRYABLE_STATUS.has(res.status)) return { error: lastError };
    }
    if (attempt >= o.retryDelaysMs.length || o.signal?.aborted) return { error: lastError };
    await new Promise((r) => setTimeout(r, o.retryDelaysMs[attempt]));
  }
}

const FRAME_BOUNDARY = /(?:\r\n|\r(?!\n)|\n){2}/;

/** The `data:` payload of one SSE frame, or '' when it carries no data line. */
function frameData(raw: string): string {
  return raw
    .split(/\r\n|[\n\r]/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let boundary = FRAME_BOUNDARY.exec(buf);
      while (boundary) {
        const data = frameData(buf.slice(0, boundary.index));
        buf = buf.slice(boundary.index + boundary[0].length);
        if (data) yield data;
        boundary = FRAME_BOUNDARY.exec(buf);
      }
    }
    const tail = frameData(buf);
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
