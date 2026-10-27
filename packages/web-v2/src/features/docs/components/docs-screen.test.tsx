// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

let query = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query) }));

const { DocsScreen } = await import("./docs-screen");

function open(search: string) {
  query = search;
  return render(<DocsScreen />);
}

function breadcrumb(): string | null {
  return screen.queryByRole("navigation", { name: "Breadcrumb" })?.textContent ?? null;
}

describe("the Docs screen opened from a link", () => {
  it("opens the page the link names", () => {
    open("path=what-done-means");
    expect(breadcrumb()).toContain("Tell when an issue is done");
  });

  it("keeps its breadcrumb as plain text, with no link to search beside it", () => {
    open("path=what-done-means");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryByRole("link", { name: "Search" })).toBeNull();
    expect(crumbs.parentElement?.className).not.toContain("sticky");
  });

  it("opens the first page when no page is asked for", () => {
    open("");
    expect(breadcrumb()).toContain("Getting started");
  });

  it("says a page does not exist instead of showing a different one", () => {
    open("path=no-such-page");
    expect(screen.getByText("No such help page")).toBeInTheDocument();
    expect(screen.getByText(/No help page is called "no-such-page"/)).toBeInTheDocument();
    expect(breadcrumb()).toBeNull();
  });

  it("says a link naming no page names none", () => {
    open("path=");
    expect(screen.getByText("No such help page")).toBeInTheDocument();
    expect(screen.getByText(/names no help page/)).toBeInTheDocument();
    expect(breadcrumb()).toBeNull();
  });
});

describe("the Connect an assistant section (ISS-1175)", () => {
  it("opens a page in the section's folder from its link", () => {
    open("path=connect-an-assistant/claude-code");
    expect(breadcrumb()).toContain("Connect an assistant");
    expect(breadcrumb()).toContain("Connect Claude Code");
  });

  it("lists the section after Guides, with its seven pages in reading order", () => {
    open("");
    const groups = [...document.querySelectorAll('nav[aria-label="Docs"] > div')].map((group) => ({
      name: group.querySelector("span")?.textContent,
      pages: [...group.querySelectorAll("button")].map((b) => b.textContent),
    }));
    const names = groups.map((g) => g.name);
    expect(names.indexOf("Connect an assistant")).toBe(names.indexOf("Guides") + 1);
    expect(groups.find((g) => g.name === "Connect an assistant")?.pages).toEqual([
      "What connecting an assistant does",
      "Connect Claude Desktop",
      "Connect Claude Code",
      "Connect Cursor",
      "Connect another app",
      "What you can ask",
      "When it does not work",
    ]);
  });
});

describe("the in-app search, which shares the public docs' results", () => {
  it("lists the page named for the words first, and says where each other page holds them", () => {
    open("");
    fireEvent.change(screen.getByRole("textbox", { name: "Search docs" }), { target: { value: "status" } });
    const results = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("button");
    expect(results[0]).toHaveTextContent(/^Read an issue's status/);
    const mentionOnly = results.find((r) => !r.querySelector("span.flex-col > span")?.textContent?.includes("status"));
    expect(mentionOnly?.querySelector("span.line-clamp-2 mark")?.textContent?.toLowerCase()).toBe("status");
  });
});

// ISS-1229 r48, the master's ruling on judge-142: /docs named the tab "Docs" whichever document was open.
describe("the Docs screen's tab", () => {
  it("names the open document, which is the page's one h1", async () => {
    open("path=what-done-means");
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Tell when an issue is done");
    await new Promise((r) => setTimeout(r, 0));
    expect(document.title).toBe(`${h1s[0]?.textContent} · Forge`);
  });

  it("is named Docs while no document is open", async () => {
    open("path=no-such-page");
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Docs"]);
    await new Promise((r) => setTimeout(r, 0));
    expect(document.title).toBe("Docs · Forge");
  });
});
