// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HELP_DOCS } from "@/features/docs/help-content.generated";
import type { Guide } from "../api";
import { ONE_CORPUS } from "../audience";
import { buildCorpus, helpPageHref, searchPlaceholder } from "../corpus";
import { missingDoor } from "../missing";
import { PublicLanding, PublicReader, PublicRefusal } from "./public-docs";

expect.extend(matchers);
afterEach(cleanup);

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
const corpus = buildCorpus(HELP_DOCS, GUIDES);
const placeholder = searchPlaceholder(corpus);

function landing() {
  return render(<PublicLanding corpus={corpus} placeholder={placeholder} />);
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

  it("says no page matches rather than showing nothing", () => {
    landing();
    fireEvent.change(screen.getByRole("textbox", { name: "Search every page" }), {
      target: { value: "zzz-no-such-word" },
    });
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });
});

function reader(view: Parameters<typeof PublicReader>[0]["view"]) {
  return render(<PublicReader corpus={corpus} view={view} />);
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
    const links = [...document.querySelectorAll("article a, [aria-label='Breadcrumb'] ~ * a")]
      .map((a) => a.getAttribute("href") ?? "")
      .filter((h) => h.includes("?path="));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((h) => h.startsWith("/guides?path="))).toBe(true);
  });
});

describe("a refused address, reached by a client navigation", () => {
  it("shows the same refusal the middleware serves, with every door as the way on", () => {
    const refusal = missingDoor("users");
    render(<PublicRefusal refusal={refusal} />);
    expect(screen.getByRole("heading", { name: refusal.heading })).toBeInTheDocument();
    expect(screen.getByText(refusal.body)).toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Ways in" })).getAllByRole("link")).toHaveLength(4);
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
    const [title, door] = [...(result?.querySelectorAll("span > span") ?? [])];
    expect(title?.textContent).toBe("Connect Claude Code");
    expect(door?.textContent).toBe("I'm connecting an AI assistant");
    expect(title?.parentElement?.className).toContain("flex-col");
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
