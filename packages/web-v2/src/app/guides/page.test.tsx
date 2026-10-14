// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

class GuideFetchError extends Error {}
const fetchGuideCorpus = vi.fn(async (): Promise<unknown[]> => {
  throw new GuideFetchError("core is down");
});
const fetchGuideScope = vi.fn(async (): Promise<unknown> => {
  throw new GuideFetchError("core is down");
});
vi.mock("@/features/guides/api", () => ({ fetchGuideCorpus, fetchGuideScope, GuideFetchError }));
vi.spyOn(console, "error").mockImplementation(() => {});

const { GUIDES_UNAVAILABLE, SEARCH_UNAVAILABLE } = await import("@/features/guides/missing");
const { default: GuidesPage } = await import("./page");

async function open(params: Record<string, string>) {
  render(await GuidesPage({ searchParams: Promise.resolve(params) }));
}

const GUIDE = {
  slug: "issue-dependencies",
  audience: "agent",
  title: "Issue dependencies",
  summary: "Blocks edges.",
  version: 1,
  body: "## Issue dependencies\nOnly a blocks edge gates dispatch.",
};
const SCOPE = {
  complete: false,
  listed: "Listed.",
  elsewhere: "Elsewhere.",
  reach: "Reach.",
  authority: "Authority.",
  cliServed: [],
};
const REFUSED = [
  [{ for: "users" }, "The documentation has no door called “users”"],
  [{ path: "no-such-page" }, "Forge publishes no page called “no-such-page”"],
  [{ path: "getting-started", for: "user" }, "An address names a page or a door, not both"],
] as const;

describe("/guides refusing an address, with the guide index reachable", () => {
  it.each(REFUSED)("offers the docs' search beside the refusal for %o", async (params, heading) => {
    fetchGuideCorpus.mockResolvedValueOnce([GUIDE]);
    fetchGuideScope.mockResolvedValueOnce(SCOPE);
    await open({ ...params });
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Search every page" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Other ways in" })).getAllByRole("link")).toHaveLength(4);
  });
});

describe("/guides refusing an address, with the guide index down", () => {
  it.each(REFUSED)("still renders the refusal for %o, and says there is no search", async (params, heading) => {
    await open({ ...params });
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByText(SEARCH_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

});

describe("/guides naming a real door, page or the landing, with the guide index down", () => {
  it.each([[{ for: "user" }], [{ for: "agent" }], [{ path: "getting-started" }], [{}]])(
    "renders in the docs' shell for %o: the site, that the guides could not be loaded, and every way in",
    async (params) => {
      await open(params);
      expect(screen.getByRole("link", { name: "Forge documentation" })).toHaveAttribute("href", "/guides");
      expect(screen.getByRole("heading", { name: GUIDES_UNAVAILABLE.heading })).toBeInTheDocument();
      expect(screen.getByText(GUIDES_UNAVAILABLE.body)).toBeInTheDocument();
      expect(screen.getByText(SEARCH_UNAVAILABLE)).toBeInTheDocument();
      expect(within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link")).toHaveLength(4);
    },
  );

  it("throws an error that is not an unreadable index, rather than calling it one", async () => {
    fetchGuideCorpus.mockRejectedValueOnce(new TypeError("a defect"));
    await expect(GuidesPage({ searchParams: Promise.resolve({ for: "user" }) })).rejects.toThrow("a defect");
  });
});
