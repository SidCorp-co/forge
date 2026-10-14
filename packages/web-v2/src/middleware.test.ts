// ISS-1292 — what the public docs' middleware does to a client-side navigation to an address it
// refuses. Next 16's middleware adapter deletes the `RSC` header (and strips `_rsc`) before
// middleware runs, so the router's flight fetch reaches it as the headers below, measured on
// Next 16.3.8 with a real browser: `next-url` and `sec-fetch-dest: empty`, no `rsc`.
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const fetchGuide = vi.fn(async () => ({ status: 404 }));
vi.stubGlobal("fetch", fetchGuide);

const { middleware } = await import("./middleware");
const { BUNDLED_WAYS_IN } = await import("./features/guides/missing");

afterEach(() => {
  fetchGuide.mockReset();
  fetchGuide.mockImplementation(async () => ({ status: 404 }));
});

const ORIGIN = "http://localhost:3100";

/** The router's flight fetch as middleware receives it. */
const FLIGHT = { "next-url": "/guides", "sec-fetch-dest": "empty", "sec-fetch-mode": "cors" };
/** A browser loading the address as a document, or curl and a crawler, which send neither. */
const DOCUMENT = { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" };

const REFUSED = [
  "/guides?for=bogus-door",
  "/guides?path=no-such-page",
  "/guides?path=getting-started&for=user",
];

async function ask(path: string, headers: Record<string, string>) {
  return middleware(new NextRequest(`${ORIGIN}${path}`, { headers }));
}

describe("a client-side navigation to a refused /guides address", () => {
  it.each(REFUSED)("passes %s through to the page, which renders the refusal in the docs shell", async (path) => {
    const res = await ask(path, FLIGHT);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("content-type") ?? "").not.toMatch(/text\/html/);
  });

  it("passes it through when only next-url says so, as a prefetch may send it", async () => {
    const res = await ask(REFUSED[0], { "next-url": "/guides" });

    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("passes it through when only sec-fetch-dest says so, as a prefetch of a route that cannot be intercepted may send it", async () => {
    const res = await ask(REFUSED[0], { "sec-fetch-dest": "empty" });

    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("passes /guides/<unknown slug> through to the guide's own not-found without asking core", async () => {
    const res = await ask("/guides/no-such-guide", FLIGHT);

    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(fetchGuide).not.toHaveBeenCalled();
  });
});

describe("a plain request for a refused /guides address", () => {
  it.each([
    [REFUSED[0], "The documentation has no door called “bogus-door”"],
    [REFUSED[1], "Forge publishes no page called “no-such-page”"],
    [REFUSED[2], "An address names a page or a door, not both"],
  ])("answers %s with a 404 document naming what was asked for", async (path, heading) => {
    for (const headers of [DOCUMENT, {}]) {
      const res = await ask(path, headers);

      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(await res.text()).toContain(heading);
    }
  });

  it("answers /guides/<unknown slug> with the 404 document once core says there is no such guide", async () => {
    const res = await ask("/guides/no-such-guide", DOCUMENT);

    expect(res.status).toBe(404);
    expect(await res.text()).toContain("no-such-guide");
    expect(fetchGuide).toHaveBeenCalledTimes(1);
  });

  it.each([
    ...REFUSED.slice(0, 3),
    "/guides/no-such-guide",
  ])("answers %s inside Forge documentation's own header and doors, not a bare document", async (path) => {
    const html = await (await ask(path, DOCUMENT)).text();

    expect(html).toContain('<a class="brand" href="/guides">Forge documentation</a>');
    expect(html).toContain('href="/guides?for=user"');
    expect(html).toContain('href="/guides?for=assistant-setup"');
    expect(html).toContain('href="/guides?for=agent"');
    expect(html).not.toMatch(/Forge guides/i);
  });

  it("varies on the headers that tell the two apart, so a cache keeps them apart", async () => {
    const res = await ask(REFUSED[0], DOCUMENT);

    const vary = (res.headers.get("vary") ?? "").toLowerCase();
    expect(vary).toContain("next-url");
    expect(vary).toContain("sec-fetch-dest");
  });

  it("passes a request for a real door through to the page", async () => {
    fetchGuide.mockResolvedValueOnce({ status: 200 });
    const res = await ask("/guides?for=agent", DOCUMENT);

    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

/** Built from core's guide index: the landing, the agents' door and an agent guide. */
const FROM_CORE = ["/guides?for=agent", "/guides", "/guides/issue-dependencies"];
/** Built from the help pages bundled into the web: a help page and the doors they fill. */
const BUNDLED = ["/guides?for=user", "/guides?for=assistant-setup", "/guides?path=getting-started"];

describe("a plain request for a real /guides address while core cannot answer for the guides", () => {
  const down = () => fetchGuide.mockRejectedValue(new TypeError("fetch failed"));

  it.each(FROM_CORE)("answers %s with a 503 and a Retry-After, in the docs' own header, offering only the doors that still open", async (path) => {
    down();
    const res = await ask(path, DOCUMENT);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain("<h1>The guides could not be loaded</h1>");
    expect(html).toContain('<a class="brand" href="/guides">Forge documentation</a>');
    expect(html).toContain(BUNDLED_WAYS_IN);
    for (const door of ["user", "assistant-setup"]) expect(html).toContain(`href="/guides?for=${door}"`);
    expect(html).not.toContain('href="/guides?for=agent"');
    expect(html).not.toContain("All three ways in");
    expect(html).not.toMatch(/ways in below/);
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it.each(BUNDLED)("passes %s through to the page, which renders it from the bundled pages, without asking core", async (path) => {
    down();
    const res = await ask(path, DOCUMENT);

    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(fetchGuide).not.toHaveBeenCalled();
  });

  it.each([
    ["/guides?for=agent", 502],
    ["/guides", 404],
    ["/guides/issue-dependencies", 500],
  ])("answers %s with a 503 when core says %i rather than the guides", async (path, status) => {
    fetchGuide.mockResolvedValueOnce({ status });
    expect((await ask(path, DOCUMENT)).status).toBe(503);
  });

  it.each(FROM_CORE)("passes %s through when core answers for it and for the index", async (path) => {
    fetchGuide.mockResolvedValue({ status: 200 });
    const res = await ask(path, DOCUMENT);
    fetchGuide.mockResolvedValue({ status: 404 });

    expect(res.headers.get("x-middleware-next")).toBe("1");
    const asked = fetchGuide.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(asked.some((url) => url.endsWith("/guides"))).toBe(true);
  });

  it("answers a guide core has with a 503 while the index its page is built from does not answer", async () => {
    fetchGuide.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 503 });
    const res = await ask("/guides/issue-dependencies", DOCUMENT);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.text()).toContain("<h1>The guides could not be loaded</h1>");
  });

  it("leaves a client-side navigation to the page, which renders the same shell, without asking core", async () => {
    const res = await ask("/guides?for=agent", FLIGHT);

    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(fetchGuide).not.toHaveBeenCalled();
  });
});
