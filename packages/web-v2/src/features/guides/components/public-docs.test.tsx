// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import type { Guide, GuideScope } from "../api";
import { BUNDLED_AUDIENCES, ONE_CORPUS } from "../audience";
import { buildCorpus, helpPageHref, searchPlaceholder } from "../corpus";
import { BUNDLED_WAYS_IN, HELP_ONLY_SEARCH, missingDoor, SEARCH_UNAVAILABLE } from "../missing";

// The address a client component reads is the window's, as Next's own hook reads it in a browser.
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(window.location.search) }));
const { PublicLanding, PublicReader, PublicRefusal, QUERY_PARAM } = await import("./public-docs");

expect.extend(matchers);
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

const GUIDES: Guide[] = [
  {
    slug: "what-is-an-issue",
    audience: "agent",
    title: "What is an issue?",
    summary: "The four admission gates.",
    version: 1,
    body: "## What is an issue?\nAn issue is a unit of work.\n\n## Admission gates\nFour of them.",
  },
  {
    slug: "issue-dependencies",
    audience: "agent",
    title: "Issue dependencies",
    summary: "Blocks edges.",
    version: 1,
    body: "## Issue dependencies\nOnly a blocks edge gates dispatch.",
  },
];
const SCOPE: GuideScope = {
  complete: false,
  listed: "Listed: what core serves.",
  elsewhere: "Elsewhere: the method guides are served by the cli, and not by core.",
  reach: "Reach: `cli guide` lists them.",
  authority: "Authority: the cli list wins.",
  cliServed: [{ slug: "dispatch", covers: "running a wave" }],
};
const corpus = buildCorpus(HELP_DOCS, GUIDES);
const placeholder = searchPlaceholder(corpus);

function landing() {
  return render(<PublicLanding corpus={corpus} placeholder={placeholder} scope={SCOPE} />);
}

describe("the public documentation landing", () => {
  it("says the corpus is one, above the doors", () => {
    landing();
    const sentence = screen.getByText(ONE_CORPUS);
    const doors = screen.getByRole("navigation", { name: "Ways in" });
    expect(sentence.compareDocumentPosition(doors) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(ONE_CORPUS).toMatch(/same content, three ways in/);
  });

  it("offers three doors in the reader's own words, each opening its own door", () => {
    landing();
    const doors = within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link");
    expect(doors.map((d) => d.querySelector("span")?.textContent)).toEqual([
      "I use Forge",
      "I'm connecting an AI assistant",
      "I'm an agent or a script",
    ]);
    expect(doors.map((d) => d.getAttribute("href"))).toEqual([
      "/guides?for=user",
      "/guides?for=assistant-setup",
      "/guides?for=agent",
    ]);
  });

  it("teaches the corpus in the search placeholder", () => {
    landing();
    const field = screen.getByRole("textbox", { name: "Search every page" });
    expect(field).toHaveAttribute("placeholder", placeholder);
    expect(placeholder).toBe("Try “status”, “Claude”, “dependencies”");
  });

  it("finds pages behind every door and says which door each sits behind", () => {
    landing();
    const field = screen.getByRole("textbox", { name: "Search every page" });
    for (const [q, door] of [
      ["pair a runner", "I use Forge"],
      ["Claude Desktop", "I'm connecting an AI assistant"],
      ["blocks edge gates dispatch", "I'm an agent or a script"],
    ] as const) {
      fireEvent.change(field, { target: { value: q } });
      const results = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("link");
      expect(results.some((r) => r.textContent?.includes(door)), `${q} → ${door}`).toBe(true);
    }
  });

  it("says beside the agent door's count that the list is not the whole corpus, in core's words", () => {
    landing();
    const agent = within(screen.getByRole("navigation", { name: "Ways in" })).getByRole("link", {
      name: /I'm an agent or a script/,
    });
    expect(agent).toHaveTextContent(/2 pages/);
    expect(agent).toHaveTextContent(SCOPE.elsewhere);
    const text = agent.textContent ?? "";
    expect(text.indexOf("2 pages")).toBeLessThan(text.indexOf(SCOPE.elsewhere));
  });

  it("says it of no other door, whose pages are the whole of what it counts", () => {
    landing();
    const doors = within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link");
    expect(doors.filter((d) => d.textContent?.includes(SCOPE.elsewhere))).toHaveLength(1);
  });

  it("says no page matches rather than showing nothing", () => {
    landing();
    fireEvent.change(screen.getByRole("textbox", { name: "Search every page" }), {
      target: { value: "zzz-no-such-word" },
    });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});

function reader(view: Parameters<typeof PublicReader>[0]["view"]) {
  return render(<PublicReader corpus={corpus} view={view} scope={SCOPE} />);
}

describe("a door", () => {
  it("lists every page written for its audience and none written for another", () => {
    reader({ kind: "door", audience: "assistant-setup" });
    const pages = within(screen.getByRole("list", { name: "Pages" })).getAllByRole("link");
    const expected = HELP_DOCS.filter((d) => d.audience === "assistant-setup").map((d) => helpPageHref(d.slug));
    expect(pages.map((p) => p.getAttribute("href")).sort()).toEqual(expected.sort());
    const nav = screen.getByRole("navigation", { name: "I'm connecting an AI assistant" });
    expect(within(nav).getAllByRole("link")).toHaveLength(expected.length);
  });

  it("for agents says every page is markdown with no credential, and lists each address", () => {
    reader({ kind: "door", audience: "agent" });
    expect(screen.getByRole("region", { name: "Plain markdown" })).toHaveTextContent(
      /also plain markdown, with no credential[\s\S]*\/api\/guides\/<slug>\.md/,
    );
    const listed = within(screen.getByRole("list", { name: "Pages" })).getAllByRole("link");
    expect(listed.map((l) => l.querySelector("code")?.textContent)).toEqual([
      expect.stringMatching(/\/api\/guides\/what-is-an-issue\.md$/),
      expect.stringMatching(/\/api\/guides\/issue-dependencies\.md$/),
    ]);
  });

  it("for agents says the pages are not the whole corpus and how to reach the rest, in core's words", () => {
    reader({ kind: "door", audience: "agent" });
    const region = screen.getByRole("region", { name: "Plain markdown" });
    expect(region).toHaveTextContent("There are 2 pages.");
    expect(region).toHaveTextContent(SCOPE.elsewhere);
    expect(region).toHaveTextContent("Reach: cli guide lists them.");
    expect(within(region).getByText("cli guide").tagName).toBe("CODE");
    expect(region).not.toHaveTextContent("`");
  });

  it("says it on no other door", () => {
    reader({ kind: "door", audience: "user" });
    expect(screen.queryByText(SCOPE.elsewhere, { exact: false })).toBeNull();
  });

  it("offers the other two doors and the way back to all three", () => {
    reader({ kind: "door", audience: "user" });
    const other = within(screen.getByRole("navigation", { name: "Other ways in" })).getAllByRole("link");
    expect(other.map((l) => l.textContent)).toEqual([
      "I'm connecting an AI assistant",
      "I'm an agent or a script",
      "All three ways in",
    ]);
  });
});

describe("a page", () => {
  it("states that an agent guide is a rule agents are held to, with its markdown address", () => {
    reader({ kind: "page", href: "/guides/what-is-an-issue" });
    const notice = screen.getByRole("complementary", { name: "Written for" });
    expect(notice).toHaveTextContent("Written for agents: a rule Forge's agents are held to, not a how-to for using Forge.");
    expect(within(notice).getByRole("link")).toHaveAttribute(
      "href",
      expect.stringMatching(/\/api\/guides\/what-is-an-issue\.md$/),
    );
    expect(screen.getByRole("navigation", { name: "On this page" })).toHaveTextContent("Admission gates");
  });

  it.each(HELP_DOCS.map((d) => [d.slug, d.audience] as const))("%s states its audience", (slug, audience) => {
    reader({ kind: "page", href: helpPageHref(slug) });
    expect(screen.getByRole("complementary", { name: "Written for" })).toHaveTextContent(
      audience === "user" ? "Written for people using Forge." : "Written for people connecting an AI assistant to Forge.",
    );
  });

  it("keeps a link to another help page on /guides", () => {
    reader({ kind: "page", href: helpPageHref("getting-started") });
    const links = [...document.querySelectorAll("a")]
      .filter((a) => !a.closest("nav"))
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h.includes("?path="));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((h) => h.startsWith("/guides?path="))).toBe(true);
  });
});

describe("a phone reader on a page, before scrolling past it", () => {
  it("is given the door the page sits behind as a link, at the head of the breadcrumb", () => {
    reader({ kind: "page", href: helpPageHref("getting-started") });
    const crumbs = within(screen.getByRole("navigation", { name: "Breadcrumb" }));
    const door = crumbs.getByRole("link", { name: "I use Forge" });
    expect(door).toHaveAttribute("href", "/guides?for=user");
    expect(crumbs.getAllByRole("link")).toHaveLength(1);
  });

  it("names the agent door for an agent page", () => {
    reader({ kind: "page", href: "/guides/what-is-an-issue" });
    const door = within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", {
      name: "I'm an agent or a script",
    });
    expect(door).toHaveAttribute("href", "/guides?for=agent");
  });

  it("is given a link beside the breadcrumb that takes it to the search field and focuses it", () => {
    reader({ kind: "page", href: helpPageHref("getting-started") });
    const jump = screen.getByRole("link", { name: "Search" });
    const field = screen.getByRole("textbox", { name: "Search every page" });
    expect(jump).toHaveAttribute("href", `#${field.id}`);
    expect(field.id).not.toBe("");
    expect(jump.className).toContain("lg:hidden");
    expect(document.activeElement).not.toBe(field);
    fireEvent.click(jump);
    expect(document.activeElement).toBe(field);
  });

  it("keeps the breadcrumb row at the top of the screen below lg, so it is there partway down", () => {
    reader({ kind: "page", href: helpPageHref("getting-started") });
    const row = screen.getByRole("navigation", { name: "Breadcrumb" }).parentElement;
    expect(row?.className).toContain("sticky");
    expect(row?.className).toContain("top-0");
    expect(row?.className).toContain("lg:static");
  });

  it("keeps the article ahead of the sidebar it jumps to, below lg", () => {
    reader({ kind: "page", href: helpPageHref("getting-started") });
    const field = screen.getByRole("textbox", { name: "Search every page" });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.closest(".order-1")).not.toBeNull();
    expect(field.closest(".order-2")).not.toBeNull();
  });

  it.each([
    ["a door", { kind: "door", audience: "user" }],
    ["a refused address", { kind: "refused", refusal: missingDoor("users") }],
  ] as const)("is given the same link on %s", (_name, view) => {
    reader(view);
    const field = screen.getByRole("textbox", { name: "Search every page" });
    expect(screen.getByRole("link", { name: "Search" })).toHaveAttribute("href", `#${field.id}`);
  });

  it("is given none where there is no search to reach", () => {
    render(<PublicRefusal refusal={missingDoor("users")} />);
    expect(screen.queryByRole("link", { name: "Search" })).toBeNull();
  });
});

describe("a refused address, reached by a client navigation", () => {
  const refusal = missingDoor("users");
  const refused = () => reader({ kind: "refused", refusal });

  it("says what the middleware's 404 says, in the reader's content", () => {
    refused();
    expect(screen.getByRole("heading", { name: refusal.heading })).toBeInTheDocument();
    expect(screen.getByText(refusal.body)).toBeInTheDocument();
  });

  it("offers the docs' search, and finds a page behind any door", () => {
    refused();
    fireEvent.change(screen.getByRole("textbox", { name: "Search every page" }), {
      target: { value: "dependencies" },
    });
    const results = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("link");
    expect(results.map((l) => l.getAttribute("href"))).toContain(`/guides/issue-dependencies`);
  });

  it("offers every door as the way on, in the sidebar a door page has", () => {
    refused();
    const ways = within(screen.getByRole("navigation", { name: "Other ways in" })).getAllByRole("link");
    expect(ways.map((l) => l.getAttribute("href"))).toEqual([
      "/guides?for=user",
      "/guides?for=assistant-setup",
      "/guides?for=agent",
      "/guides",
    ]);
  });
});

describe("a refused address when the guide index cannot be reached", () => {
  it("keeps the refusal, says there is no search and why, and offers only the doors that open without the index", () => {
    const refusal = missingDoor("users");
    render(<PublicRefusal refusal={refusal} />);
    expect(screen.getByRole("heading", { name: refusal.heading })).toBeInTheDocument();
    expect(screen.getByText(SEARCH_UNAVAILABLE)).toBeInTheDocument();
    expect(screen.getByText(BUNDLED_WAYS_IN)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    const doors = within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link");
    expect(doors.map((d) => d.getAttribute("href"))).toEqual(["/guides?for=user", "/guides?for=assistant-setup"]);
  });

  it("opens without the index exactly the doors every help page sits behind", () => {
    expect([...BUNDLED_AUDIENCES].sort()).toEqual([...new Set(HELP_DOCS.map((d) => d.audience))].sort());
  });
});

describe("a search result in the reader's sidebar", () => {
  it("puts its door under the title, so the title keeps the row's width", () => {
    reader({ kind: "door", audience: "user" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search every page" }), {
      target: { value: "Claude" },
    });
    const result = within(screen.getByRole("list", { name: "Search results" }))
      .getAllByRole("link")
      .find((l) => l.textContent?.startsWith("Connect Claude Code"));
    const column = result?.querySelector("span.flex-col");
    const rows = [...(column?.children ?? [])];
    expect(rows[0]?.textContent).toBe("Connect Claude Code");
    expect(rows.at(-1)?.textContent).toBe("I'm connecting an AI assistant");
  });

  it("says under which heading the body holds the words typed, with the words marked", () => {
    reader({ kind: "door", audience: "agent" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search every page" }), {
      target: { value: "four of them" },
    });
    const [result] = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("link");
    const rows = [...(result.querySelector("span.flex-col")?.children ?? [])].map((r) => r.textContent);
    expect(rows).toEqual(["What is an issue?", "Admission gates", "Four of them.", "I'm an agent or a script"]);
    expect(result.querySelector("span.line-clamp-2")?.textContent).toBe("Four of them.");
    expect([...result.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Four of them"]);
  });

  it("lists the pages whose title holds the words first, each with the words marked in it", () => {
    reader({ kind: "door", audience: "agent" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search every page" }), {
      target: { value: "issue" },
    });
    const results = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("link");
    const titled = results.map((r) => r.querySelector("span.flex-col > span")?.textContent ?? "");
    const firstWithout = titled.findIndex((t) => !t.toLowerCase().includes("issue"));
    expect(firstWithout).toBeGreaterThan(1);
    expect(titled.slice(firstWithout).some((t) => t.toLowerCase().includes("issue"))).toBe(false);
    expect(results[0].querySelector("span.flex-col > span mark")?.textContent?.toLowerCase()).toBe("issue");
  });
});

describe("the tab's title", () => {
  it("follows the reader to every door, page and refusal it is navigated to, without a reload", () => {
    const { rerender } = reader({ kind: "page", href: helpPageHref("pair-a-runner") });
    expect(document.title).toBe("Pair a runner — Forge documentation");
    const to = (view: Parameters<typeof PublicReader>[0]["view"]) =>
      rerender(<PublicReader corpus={corpus} view={view} scope={SCOPE} />);
    to({ kind: "door", audience: "agent" });
    expect(document.title).toBe("I'm an agent or a script — Forge documentation");
    to({ kind: "page", href: "/guides/issue-dependencies" });
    expect(document.title).toBe("Issue dependencies — Forge documentation");
    const refusal = missingDoor("users");
    to({ kind: "refused", refusal });
    expect(document.title).toBe(`${refusal.heading} — Forge documentation`);
  });

  it("names only the site on the landing, and the refusal where the index cannot be reached", () => {
    landing();
    expect(document.title).toBe("Forge documentation");
    cleanup();
    const refusal = missingDoor("users");
    render(<PublicRefusal refusal={refusal} />);
    expect(document.title).toBe(`${refusal.heading} — Forge documentation`);
  });
});

describe("the furniture", () => {
  it("is the same components on the public reader and the in-app /docs screen", () => {
    const src = (p: string) => readFileSync(resolve(__dirname, p), "utf8");
    const docsScreen = src("../../docs/components/docs-screen.tsx");
    const publicDocs = src("./public-docs.tsx");
    for (const name of ["DocsLayout", "DocsSidebar", "DocsArticle"]) {
      expect(docsScreen, `docs-screen uses ${name}`).toMatch(new RegExp(`<${name}\\b`));
      expect(publicDocs, `public-docs uses ${name}`).toMatch(new RegExp(`<${name}\\b`));
    }
    for (const own of ["function deriveToc", "function groupSections", "aria-label=\"On this page\""]) {
      expect(docsScreen).not.toContain(own);
      expect(publicDocs).not.toContain(own);
    }
  });
});

const CODE_TITLED: Guide = {
  slug: "conformance-and-verify",
  audience: "agent",
  title: "Conformance gates & `pnpm verify`",
  summary: "One checker per axis.",
  version: 1,
  body: "## Conformance gates & `pnpm verify`\nA repo may carry gates, and `pnpm verify` is the entrypoint.",
};
const withCode = buildCorpus(HELP_DOCS, [...GUIDES, CODE_TITLED]);

describe("a title carrying code", () => {
  it("shows its code as code and never its backticks, in the results, the sidebar and the door's list", () => {
    render(<PublicReader corpus={withCode} view={{ kind: "door", audience: "agent" }} scope={SCOPE} />);
    const sidebar = screen.getByRole("navigation", { name: "I'm an agent or a script" });
    const listed = screen.getByRole("list", { name: "Pages" });
    for (const where of [sidebar, listed]) {
      const link = within(where).getByRole("link", { name: /Conformance gates/ });
      expect(link.textContent).not.toContain("`");
      expect(link.querySelector("code")?.textContent).toBe("pnpm verify");
    }
    fireEvent.change(screen.getByRole("textbox", { name: "Search every page" }), { target: { value: "gates & pnpm" } });
    const result = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("link")[0];
    expect(result.textContent).not.toContain("`");
    expect([...result.querySelectorAll("mark")].map((m) => m.textContent).join("")).toBe("gates & pnpm");
    expect(result.querySelector("mark code")?.textContent).toBe("pnpm");
  });

  it("is named without its backticks in the tab", () => {
    render(<PublicReader corpus={withCode} view={{ kind: "page", href: "/guides/conformance-and-verify" }} scope={SCOPE} />);
    expect(document.title).toBe("Conformance gates & pnpm verify — Forge documentation");
  });

  it("shows no body line for a search only its title and the heading repeating it hold", () => {
    landingOf(withCode);
    fireEvent.change(screen.getByRole("textbox", { name: "Search every page" }), { target: { value: "Conformance gates &" } });
    const result = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("link")[0];
    expect(result.querySelector("span.flex-col")?.children).toHaveLength(2);
  });
});

function landingOf(docs: typeof corpus) {
  return render(<PublicLanding corpus={docs} placeholder={placeholder} scope={SCOPE} />);
}

describe("what was typed into the search, kept in the address", () => {
  it("writes the words into the address as they are typed, replacing the entry rather than adding one", () => {
    landing();
    const before = window.history.length;
    const field = screen.getByRole("textbox", { name: "Search every page" });
    fireEvent.change(field, { target: { value: "st" } });
    fireEvent.change(field, { target: { value: "status" } });
    expect(new URLSearchParams(window.location.search).get(QUERY_PARAM)).toBe("status");
    expect(window.history.length).toBe(before);
    fireEvent.change(field, { target: { value: "" } });
    expect(window.location.search).toBe("");
  });

  it("opens on the words the address holds, as Back to a search or a reload of one does", () => {
    window.history.replaceState(null, "", "/guides?q=status");
    landing();
    expect(screen.getByRole("textbox", { name: "Search every page" })).toHaveValue("status");
    expect(within(screen.getByRole("list", { name: "Search results" })).getAllByRole("link")[0]).toHaveTextContent(
      /^Read an issue's status/,
    );
    cleanup();
    window.history.replaceState(null, "", "/guides?path=pair-a-runner&q=runner");
    reader({ kind: "page", href: helpPageHref("pair-a-runner") });
    expect(screen.getByRole("textbox", { name: "Search every page" })).toHaveValue("runner");
  });
});

describe("the landing's ways in", () => {
  it("are flat rows parted by hairlines, with no card around a door", () => {
    landing();
    for (const door of within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link")) {
      expect(door.className).not.toMatch(/\b(rounded|shadow|border|bg-surface)/);
    }
  });
});

describe("a help page or door while the guide index cannot be reached", () => {
  it("searches the bundled pages, says so, and offers only the doors that open without the index", () => {
    render(
      <PublicReader corpus={buildCorpus(HELP_DOCS, [])} view={{ kind: "page", href: helpPageHref("pair-a-runner") }} scope={null} />,
    );
    expect(screen.getByText(HELP_ONLY_SEARCH)).toBeInTheDocument();
    const onward = within(screen.getByRole("navigation", { name: "Other ways in" })).getAllByRole("link");
    expect(onward.map((l) => l.getAttribute("href"))).toEqual(["/guides?for=assistant-setup"]);
  });
});

