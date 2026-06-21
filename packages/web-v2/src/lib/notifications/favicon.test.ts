import { afterEach, describe, expect, it, vi } from "vitest";

// The vitest env is `node`, so there is no DOM. Each test installs the exact
// globals (document / Image / canvas) it needs and tears them down after, since
// favicon.ts reads `typeof document` lazily at call time. The module caches an
// AudioContext-like singleton state (originalHref / variants), so tests that
// exercise the canvas path re-import via freshFavicon() to avoid leakage.

/** Build a minimal fake document with a single `<link rel="icon">` and a canvas
 *  factory. `Image` is captured so a test can fire its onload synchronously. */
function installDom(opts: {
  hasCanvasContext?: boolean;
  initialHref?: string;
} = {}) {
  const { hasCanvasContext = true, initialHref = "/icon.png?abc" } = opts;
  const link: Record<string, unknown> = { rel: "icon", href: initialHref };
  let lastImage: Record<string, unknown> | null = null;

  const canvas = {
    width: 0,
    height: 0,
    getContext: (_: string) =>
      hasCanvasContext
        ? {
            drawImage: () => {},
            beginPath: () => {},
            arc: () => {},
            fill: () => {},
            set fillStyle(_v: string) {},
          }
        : null,
    toDataURL: (_: string) => "data:image/png;base64,FAKE",
  };

  const doc: Record<string, unknown> = {
    title: "Forge",
    head: { appendChild: () => {} },
    querySelector: (sel: string) => (sel === 'link[rel="icon"]' ? link : null),
    createElement: (tag: string) => (tag === "canvas" ? canvas : ({ rel: "", href: "" } as unknown)),
  };

  class FakeImage {
    crossOrigin = "";
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    private _src = "";
    constructor() {
      lastImage = this as unknown as Record<string, unknown>;
    }
    set src(v: string) {
      this._src = v;
    }
    get src() {
      return this._src;
    }
  }

  (globalThis as { document?: unknown }).document = doc;
  (globalThis as { Image?: unknown }).Image = FakeImage as unknown;
  return { link, doc, fireLoad: () => (lastImage?.onload as (() => void) | undefined)?.() };
}

/** Fresh import so the module-level originalHref / variant cache doesn't leak. */
async function freshFavicon() {
  vi.resetModules();
  return import("./favicon");
}

afterEach(() => {
  // biome-ignore lint/performance/noDelete: test global teardown
  delete (globalThis as { document?: unknown }).document;
  // biome-ignore lint/performance/noDelete: test global teardown
  delete (globalThis as { Image?: unknown }).Image;
  vi.restoreAllMocks();
});

describe("setTitleUnread", () => {
  it("prefixes the count, caps at 99+, and restores the bare title at 0", async () => {
    installDom();
    const { setTitleUnread } = await freshFavicon();
    setTitleUnread(3);
    expect((globalThis as { document: { title: string } }).document.title).toBe("(3) Forge");
    setTitleUnread(150);
    expect((globalThis as { document: { title: string } }).document.title).toBe("(99+) Forge");
    setTitleUnread(0);
    expect((globalThis as { document: { title: string } }).document.title).toBe("Forge");
  });

  it("never throws when document is absent (SSR)", async () => {
    const { setTitleUnread } = await freshFavicon();
    expect(() => setTitleUnread(5)).not.toThrow();
  });
});

describe("setFaviconBadge", () => {
  it("swaps the icon href to a data URL once the base image loads, and restores it", async () => {
    const { link, fireLoad } = installDom({ initialHref: "/icon.png?v1" });
    const { setFaviconBadge } = await freshFavicon();

    setFaviconBadge(true);
    // Before the image loads, href is unchanged (no synchronous swap).
    expect(link.href).toBe("/icon.png?v1");
    fireLoad();
    // Badged variant applied.
    expect(link.href).toBe("data:image/png;base64,FAKE");

    setFaviconBadge(false);
    // Restored to the captured original href.
    expect(link.href).toBe("/icon.png?v1");
  });

  it("degrades to a no-op (keeps the static favicon) when canvas has no 2d context", async () => {
    const { link, fireLoad } = installDom({ hasCanvasContext: false, initialHref: "/icon.png?v2" });
    const { setFaviconBadge } = await freshFavicon();
    setFaviconBadge(true);
    fireLoad();
    expect(link.href).toBe("/icon.png?v2");
  });

  it("never throws when document is absent (SSR)", async () => {
    const { setFaviconBadge } = await freshFavicon();
    expect(() => setFaviconBadge(true)).not.toThrow();
    expect(() => setFaviconBadge(false)).not.toThrow();
  });
});
