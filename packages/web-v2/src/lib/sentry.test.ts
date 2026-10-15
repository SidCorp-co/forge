// @vitest-environment jsdom
/**
 * ISS-1342 — the web Sentry client as it ships, sending to a stand-in ingest on loopback, so what
 * is asserted is what Sentry 11's browser client actually puts on the wire.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let ingest: Server;
const envelopes: string[] = [];

beforeAll(async () => {
  ingest = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      envelopes.push(
        req.headers["content-encoding"] === "gzip" ? gunzipSync(body).toString() : body.toString(),
      );
      res.writeHead(200, { "access-control-allow-origin": "*" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => ingest.listen(0, "127.0.0.1", resolve));
  const { port } = ingest.address() as AddressInfo;
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", `http://public@127.0.0.1:${port}/1`);
  // A session with no release is discarded before it is sent.
  vi.stubEnv("NEXT_PUBLIC_SOURCE_COMMIT", "0123456789abcdef0123456789abcdef01234567");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => ingest.close(() => resolve()));
});

/** One secret per field the scrub covers, each a string no other part of the event can carry. */
const PLANTED = {
  header: "hdr-planted-7c1",
  url: "url-planted-7c2",
  body: "body-planted-7c3",
  crumb: `forge_pat_prd_${"7c".repeat(16)}`,
  crumbData: "crumbdata-planted-7c5",
};

describe("the web Sentry client", () => {
  it("sends none of a secret planted in each field the scrub covers", async () => {
    const { initSentry, Sentry } = await import("./sentry");
    expect(initSentry()).toBe(true);
    const before = envelopes.length;
    Sentry.addBreadcrumb({ message: `called with ${PLANTED.crumb}`, data: { token: PLANTED.crumbData } });
    Sentry.captureEvent({
      message: "planted web event",
      request: {
        url: `https://forge.test/issues?token=${PLANTED.url}`,
        headers: { Authorization: `Bearer ${PLANTED.header}` },
        data: { password: PLANTED.body, note: "kept" },
      },
    });
    expect(await Sentry.flush(5000)).toBe(true);
    const sent = envelopes.slice(before).join("\n");
    expect(sent).toContain("planted web event");
    expect(sent).toContain("forge.test/issues");
    for (const secret of Object.values(PLANTED)) expect(sent).not.toContain(secret);
  });

  it("asks the ingest to record no client address for the session it sends", async () => {
    const { initSentry, Sentry } = await import("./sentry");
    expect(initSentry()).toBe(true);
    const before = envelopes.length;
    // The page's own session goes out when the browser is idle or hidden; this sends it now.
    Sentry.captureSession();
    expect(await Sentry.flush(5000)).toBe(true);
    const sent = envelopes.slice(before).join("\n");
    expect(sent).toContain('"type":"session"');
    expect(sent).not.toContain("{{auto}}");
  });
});
