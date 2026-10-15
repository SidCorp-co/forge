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

const { BUNDLED_WAYS_IN, GUIDES_UNAVAILABLE } = await import("@/features/guides/missing");
const { default: GuidePage, generateMetadata } = await import("./page");

const params = Promise.resolve({ slug: "issue-dependencies" });

describe("/guides/<slug> while core cannot answer for the guides", () => {
  it("renders in the docs' shell: the site, that the guides could not be loaded, and the doors that still open", async () => {
    render(await GuidePage({ params }));
    expect(screen.getByRole("link", { name: "Forge documentation" })).toHaveAttribute("href", "/guides");
    expect(screen.getByRole("heading", { name: GUIDES_UNAVAILABLE.heading })).toBeInTheDocument();
    expect(screen.getByText(BUNDLED_WAYS_IN)).toBeInTheDocument();
    const doors = within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link");
    expect(doors.map((d) => d.getAttribute("href"))).toEqual(["/guides?for=user", "/guides?for=assistant-setup"]);
  });

  it("names the outage in the tab and asks not to be indexed", async () => {
    expect(await generateMetadata({ params })).toEqual({
      title: `${GUIDES_UNAVAILABLE.heading} — Forge documentation`,
      robots: { index: false },
    });
  });

  it("throws an error that is not an unreadable guide, rather than calling it one", async () => {
    fetchGuideScope.mockResolvedValueOnce({} as never);
    fetchGuide.mockRejectedValueOnce(new TypeError("a defect"));
    await expect(GuidePage({ params: Promise.resolve({ slug: "other" }) })).rejects.toThrow("a defect");
  });
});

const SCOPE = { complete: false, listed: "l", elsewhere: "e", reach: "r", authority: "a", cliServed: [] };

describe("/guides/<slug> naming no guide core publishes", () => {
  it("names the refusal in the tab, so a client-side navigation onto it does not keep the site's bare name", async () => {
    fetchGuideScope.mockResolvedValueOnce(SCOPE as never);
    fetchGuide.mockResolvedValueOnce(null as never);
    expect(await generateMetadata({ params: Promise.resolve({ slug: "no-such-guide" }) })).toEqual({
      title: "Forge publishes no guide called “no-such-guide” — Forge documentation",
      robots: { index: false },
    });
  });

  it("names the address-less refusal where the slug is empty", async () => {
    fetchGuideScope.mockResolvedValueOnce(SCOPE as never);
    fetchGuide.mockResolvedValueOnce(null as never);
    expect(await generateMetadata({ params: Promise.resolve({ slug: "" }) })).toEqual({
      title: "Forge publishes no guide at that address — Forge documentation",
      robots: { index: false },
    });
  });
});

describe("/guides/<slug> whose guide the fetch cache still holds while the live index does not answer", () => {
  it("says the guides could not be loaded rather than serving the cached guide and every door", async () => {
    fetchGuide.mockResolvedValueOnce({ slug: "cached", title: "Cached", summary: "s", version: 1, body: "# Cached" } as never);
    const params = Promise.resolve({ slug: "cached" });

    render(await GuidePage({ params }));

    expect(screen.getByRole("heading", { name: GUIDES_UNAVAILABLE.heading })).toBeInTheDocument();
    expect(screen.queryByText("The pages for agents and scripts are also markdown", { exact: false })).toBeNull();
  });
});
