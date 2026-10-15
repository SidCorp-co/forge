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

const { BUNDLED_WAYS_IN, GUIDES_UNAVAILABLE, HELP_ONLY_SEARCH, LANDING_WHILE_DOWN, SEARCH_UNAVAILABLE } = await import(
  "@/features/guides/missing"
);
const { default: GuidesPage, generateMetadata } = await import("./page");

const BUNDLED_DOORS = ["/guides?for=user", "/guides?for=assistant-setup"];
const EVERY_READER = "For people using Forge, people connecting an assistant, and agents.";
const PEOPLE_ONLY = "For people using Forge and people connecting an assistant.";
const PEOPLE_SEARCH = "Search the pages for people";

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
    expect(screen.getByText(EVERY_READER)).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Other ways in" })).getAllByRole("link")).toHaveLength(4);
  });
});

describe("/guides refusing an address, with the guide index down", () => {
  it.each(REFUSED)("still renders the refusal for %o, says there is no search, and offers the doors that still open", async (params, heading) => {
    await open({ ...params });
    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByText(SEARCH_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(PEOPLE_ONLY)).toBeInTheDocument();
    const doors = within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link");
    expect(doors.map((d) => d.getAttribute("href"))).toEqual(BUNDLED_DOORS);
  });
});

describe("/guides naming the landing, with the guide index down", () => {
  it("builds the landing from the bundled pages: says why, searches them, and offers only the doors that open", async () => {
    await open({});
    expect(screen.getByRole("link", { name: "Forge documentation" })).toHaveAttribute("href", "/guides");
    expect(screen.queryByRole("heading", { name: GUIDES_UNAVAILABLE.heading })).toBeNull();
    expect(screen.getByRole("heading", { name: "Forge documentation" })).toBeInTheDocument();
    expect(screen.getByText(LANDING_WHILE_DOWN)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: PEOPLE_SEARCH })).toHaveAttribute("placeholder", "Try “status”, “Claude”");
    expect(screen.queryByRole("textbox", { name: "Search every page" })).toBeNull();
    expect(screen.getByText(PEOPLE_ONLY)).toBeInTheDocument();
    expect(screen.queryByText(EVERY_READER)).toBeNull();
    const doors = within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link");
    expect(doors.map((d) => d.getAttribute("href"))).toEqual(BUNDLED_DOORS);
    expect(screen.queryByText(/also markdown an agent can fetch/)).toBeNull();
  });

  it("names the documentation in the tab, not the outage, and describes only the pages that open", async () => {
    const meta = await generateMetadata({ searchParams: Promise.resolve({}) });
    expect(meta.title).toBe("Forge documentation");
    expect(meta.description).toBe("Forge's documentation, for people using Forge and people connecting an assistant.");
  });
});

describe("/guides naming the agents' door, with the guide index down", () => {
  it.each([[{ for: "agent" }]])(
    "renders in the docs' shell for %o: the site, that the guides could not be loaded, and only the doors that still open",
    async (params) => {
      await open(params);
      expect(screen.getByRole("link", { name: "Forge documentation" })).toHaveAttribute("href", "/guides");
      expect(screen.getByRole("heading", { name: GUIDES_UNAVAILABLE.heading })).toBeInTheDocument();
      expect(screen.getByText(GUIDES_UNAVAILABLE.body)).toBeInTheDocument();
      expect(GUIDES_UNAVAILABLE.body).not.toMatch(/ways in below/);
      expect(screen.getByText(BUNDLED_WAYS_IN)).toBeInTheDocument();
      expect(screen.getByText(PEOPLE_ONLY)).toBeInTheDocument();
      const doors = within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link");
      expect(doors.map((d) => d.getAttribute("href"))).toEqual(BUNDLED_DOORS);
    },
  );
});

describe("/guides naming a help page or a door of help pages, with the guide index down", () => {
  it("renders the help page from the bundle, its search saying it covers the help pages only", async () => {
    await open({ path: "getting-started" });
    expect(screen.queryByRole("heading", { name: GUIDES_UNAVAILABLE.heading })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Getting started with Forge" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: PEOPLE_SEARCH })).toHaveAttribute("placeholder", PEOPLE_SEARCH);
    expect(screen.queryByPlaceholderText("Search every page")).toBeNull();
    expect(screen.getByText(HELP_ONLY_SEARCH)).toBeInTheDocument();
    expect(screen.getByText(PEOPLE_ONLY)).toBeInTheDocument();
    expect(screen.queryByText(EVERY_READER)).toBeNull();
    const onward = within(screen.getByRole("navigation", { name: "Other ways in" })).getAllByRole("link");
    expect(onward.map((d) => d.getAttribute("href"))).toEqual(["/guides?for=assistant-setup"]);
    expect(screen.queryByText(/also markdown an agent can fetch/)).toBeNull();
  });

  it.each([
    ["user", "I use Forge"],
    ["assistant-setup", "I'm connecting an AI assistant"],
  ])("renders the %s door from the bundle", async (door, label) => {
    await open({ for: door });
    expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
    expect(screen.getByText(HELP_ONLY_SEARCH)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: PEOPLE_SEARCH })).toHaveAttribute("placeholder", PEOPLE_SEARCH);
    expect(screen.getByText(PEOPLE_ONLY)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Pages" })).getAllByRole("link").length).toBeGreaterThan(0);
  });

  it("names the page in the tab, not the outage", async () => {
    expect((await generateMetadata({ searchParams: Promise.resolve({ path: "getting-started" }) })).title).toBe(
      "Getting started — Forge documentation",
    );
    expect((await generateMetadata({ searchParams: Promise.resolve({ for: "agent" }) })).title).toBe(
      `${GUIDES_UNAVAILABLE.heading} — Forge documentation`,
    );
  });

  it("throws an error that is not an unreadable index, rather than calling it one", async () => {
    fetchGuideCorpus.mockRejectedValueOnce(new TypeError("a defect"));
    await expect(GuidesPage({ searchParams: Promise.resolve({ for: "agent" }) })).rejects.toThrow("a defect");
  });
});
