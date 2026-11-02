// Docs shows the page titles and a search on its face (REQ-11 BC-18, ISS-903); a page opens on a
// click in a side drawer, never as a column beside the list, and `?path=` opens one from a link. A
// link naming no page says so, and opens nothing in its place.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HELP_DOCS } from "../help-content.generated";
import { DocsScreen } from "./docs-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const first = HELP_DOCS.find((d) => d.slug === "getting-started");

beforeEach(() => window.history.replaceState(null, "", "/docs"));

describe("Docs", () => {
  it("draws every page's title and no article on its first view", () => {
    render(<DocsScreen />);
    const nav = screen.getByRole("navigation", { name: "Docs" });
    expect(within(nav).getAllByRole("button")).toHaveLength(HELP_DOCS.length);
    expect(screen.queryByRole("article")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a page in the drawer on a click, and the address carries it", async () => {
    const user = userEvent.setup();
    render(<DocsScreen />);
    await user.click(screen.getByRole("button", { name: first?.title }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("article")).toBeInTheDocument();
    expect(window.location.search).toBe("?path=getting-started");
  });

  it("opens the page a link names, and shuts back to the list on Escape", async () => {
    window.history.replaceState(null, "", "/docs?path=pair-a-runner");
    const user = userEvent.setup();
    render(<DocsScreen />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(window.location.search).toBe("");
  });

  it("says a link names no page, and opens no other in its place", () => {
    window.history.replaceState(null, "", "/docs?path=nowhere");
    render(<DocsScreen />);
    expect(screen.getByText("No such help page")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filters the titles as the person types", async () => {
    const user = userEvent.setup();
    render(<DocsScreen />);
    await user.type(screen.getByRole("textbox", { name: "Search docs" }), "runner");
    const found = within(screen.getByRole("list", { name: "Search results" })).getAllByRole("button");
    expect(found.map((b) => b.textContent)).toContain("Pair a runner");
  });
});
