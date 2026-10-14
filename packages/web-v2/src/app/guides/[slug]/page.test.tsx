// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

class GuideFetchError extends Error {}
const down = async (): Promise<never> => {
  throw new GuideFetchError("core is down");
};
const fetchGuide = vi.fn(down);
const fetchGuideCorpus = vi.fn(down);
const fetchGuideScope = vi.fn(down);
vi.mock("@/features/guides/api", () => ({ fetchGuide, fetchGuideCorpus, fetchGuideScope, GuideFetchError }));
vi.spyOn(console, "error").mockImplementation(() => {});

const { GUIDES_UNAVAILABLE, SEARCH_UNAVAILABLE } = await import("@/features/guides/missing");
const { default: GuidePage, generateMetadata } = await import("./page");

const params = Promise.resolve({ slug: "issue-dependencies" });

describe("/guides/<slug> while core cannot answer for the guides", () => {
  it("renders in the docs' shell: the site, that the guides could not be loaded, and every way in", async () => {
    render(await GuidePage({ params }));
    expect(screen.getByRole("link", { name: "Forge documentation" })).toHaveAttribute("href", "/guides");
    expect(screen.getByRole("heading", { name: GUIDES_UNAVAILABLE.heading })).toBeInTheDocument();
    expect(screen.getByText(SEARCH_UNAVAILABLE)).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link")).toHaveLength(4);
  });

  it("names the outage in the tab and asks not to be indexed", async () => {
    expect(await generateMetadata({ params })).toEqual({
      title: `${GUIDES_UNAVAILABLE.heading} — Forge documentation`,
      robots: { index: false },
    });
  });

  it("throws an error that is not an unreadable guide, rather than calling it one", async () => {
    fetchGuide.mockRejectedValueOnce(new TypeError("a defect"));
    await expect(GuidePage({ params: Promise.resolve({ slug: "other" }) })).rejects.toThrow("a defect");
  });
});
