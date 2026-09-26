import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGuide, fetchGuideCorpus, fetchGuideIndex } from "./api";

const BASE = "http://core.test/api";

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const spy = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function withBase() {
  vi.stubEnv("NEXT_PUBLIC_API_URL", `${BASE}/`);
}

describe("fetchGuideIndex", () => {
  it("returns the guides the core index carries", async () => {
    withBase();
    const spy = stubFetch(() =>
      Response.json({ guides: [{ slug: "a", title: "A", summary: "s", version: 1 }] }),
    );
    await expect(fetchGuideIndex()).resolves.toEqual([
      { slug: "a", title: "A", summary: "s", version: 1 },
    ]);
    expect(String(spy.mock.calls[0][0])).toBe(`${BASE}/guides`);
  });

  it("throws by name when core answers 500, rather than reading as an empty corpus", async () => {
    withBase();
    stubFetch(() => new Response("boom", { status: 500 }));
    await expect(fetchGuideIndex()).rejects.toThrow(/guide index[\s\S]*answered 500/);
  });

  it("throws by name when core answers 200 with no guides array", async () => {
    withBase();
    stubFetch(() => Response.json({ ok: true }));
    await expect(fetchGuideIndex()).rejects.toThrow(/no `guides` array/);
  });

  it("throws by name when core cannot be reached", async () => {
    withBase();
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(fetchGuideIndex()).rejects.toThrow(/could not be reached/);
  });
});

describe("fetchGuide", () => {
  it("returns the guide core serves for a known slug", async () => {
    withBase();
    const spy = stubFetch(() =>
      Response.json({ guide: { slug: "b", title: "B", summary: "s", version: 2, body: "# B" } }),
    );
    await expect(fetchGuide("b")).resolves.toMatchObject({ slug: "b", body: "# B" });
    expect(String(spy.mock.calls[0][0])).toBe(`${BASE}/guides/b`);
  });

  it("returns null for a slug core does not publish", async () => {
    withBase();
    stubFetch(() => new Response("nope", { status: 404 }));
    await expect(fetchGuide("no-such-guide")).resolves.toBeNull();
  });

  it("refuses a slug carrying a path separator without reaching the network", async () => {
    withBase();
    const spy = stubFetch(() => Response.json({ guide: {} }));
    await expect(fetchGuide("../admin/whoami")).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws by name when core answers 200 with no guide body", async () => {
    withBase();
    stubFetch(() => Response.json({ guide: { slug: "c" } }));
    await expect(fetchGuide("c")).rejects.toThrow(/no `guide` body/);
  });
});

describe("fetchGuideCorpus", () => {
  const index = {
    guides: [
      { slug: "a", title: "A", summary: "s", version: 1 },
      { slug: "b", title: "B", summary: "t", version: 1 },
    ],
  };

  it("returns every guide the index lists with its body, in index order", async () => {
    withBase();
    stubFetch((url) => {
      if (url.endsWith("/guides")) return Response.json(index);
      const slug = url.split("/").pop() ?? "";
      return Response.json({ guide: { slug, title: slug.toUpperCase(), summary: "", version: 1, body: `# ${slug}` } });
    });
    const guides = await fetchGuideCorpus();
    expect(guides.map((g) => [g.slug, g.body])).toEqual([
      ["a", "# a"],
      ["b", "# b"],
    ]);
  });

  it("throws naming a slug the index lists and core then answers 404 for, rather than dropping it", async () => {
    withBase();
    stubFetch((url) => {
      if (url.endsWith("/guides")) return Response.json(index);
      if (url.endsWith("/guides/b")) return new Response("nope", { status: 404 });
      return Response.json({ guide: { slug: "a", title: "A", summary: "", version: 1, body: "# a" } });
    });
    await expect(fetchGuideCorpus()).rejects.toThrow(/the index lists b and core answers 404 for it/);
  });
});
