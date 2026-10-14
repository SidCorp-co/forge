// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

const fetchGuideCorpus = vi.fn(async (): Promise<unknown[]> => {
  throw new Error("core is down");
});
const fetchGuideScope = vi.fn(async (): Promise<unknown> => {
  throw new Error("core is down");
});
vi.mock("@/features/guides/api", () => ({ fetchGuideCorpus, fetchGuideScope }));

const { SEARCH_UNAVAILABLE } = await import("@/features/guides/missing");
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

  it("still asks core, and fails loudly, for an address naming a real door", async () => {
    await expect(GuidesPage({ searchParams: Promise.resolve({ for: "user" }) })).rejects.toThrow("core is down");
  });
});
