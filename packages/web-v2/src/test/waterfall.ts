import { vi } from "vitest";

/** One request as the page sent it: when it left and when its answer came back, in ms from the first. */
export interface Sent {
  method: string;
  path: string;
  start: number;
  end: number | null;
  status: number | null;
}

/**
 * Stands in for core with a fixed round trip, recording when each request left and returned, so a
 * test reads a page's waterfall the way devtools draws it: which reads waited on which.
 */
export function slowCore(reply: (method: string, path: string) => unknown, roundTripMs = 40) {
  const sent: Sent[] = [];
  const t0 = performance.now();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://forge.test");
      const method = init?.method ?? "GET";
      const path = `${url.pathname.replace(/^\/api/, "")}${url.search}`;
      const row: Sent = { method, path, start: performance.now() - t0, end: null, status: null };
      sent.push(row);
      await new Promise((r) => setTimeout(r, roundTripMs));
      const body = reply(method, path);
      row.end = performance.now() - t0;
      row.status = body === undefined ? 404 : 200;
      if (body === undefined) return new Response(JSON.stringify({ code: "NOT_SERVED" }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return sent;
}

/**
 * How many round trips deep a request sits: one for a request sent before any answer it could have
 * waited on came back, one more than the deepest answer that landed before it left.
 */
export function depthOf(sent: readonly Sent[], row: Sent, slopMs = 2): number {
  const before = sent.filter((q) => q !== row && q.end !== null && q.end <= row.start + slopMs);
  return 1 + Math.max(0, ...before.map((q) => depthOf(sent, q, slopMs)));
}

/** A path with the project and issue spelled one way, so the same read sent by slug and by uuid counts once. */
export function samePlace(path: string, aliases: Record<string, string>): string {
  let out = path;
  for (const [from, to] of Object.entries(aliases)) out = out.split(from).join(to);
  return out;
}
