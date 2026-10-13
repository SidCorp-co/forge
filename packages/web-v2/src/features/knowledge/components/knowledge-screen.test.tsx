// @vitest-environment jsdom
//
// ISS-1164 — Knowledge offers its seven readers from one grouped list (a picker below lg) instead
// of a second row of tabs, a stale `sub=memory` falls to the overview, and an empty product-map
// reader names a button on the page for an admin and tells nobody to type a command.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeScreen } from "./knowledge-screen";

expect.extend(matchers);

let sub: string | null = null;
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "forge-dev" }),
  useRouter: () => ({ push }),
  useSearchParams: () => ({ get: (k: string) => (k === "sub" ? sub : null) }),
}));
vi.mock("../hooks", () => ({
  useKnowledgeEntries: () => ({ data: { rows: [] }, isLoading: false, isError: false }),
}));
vi.mock("./rules-tab", () => ({ RulesTab: () => <p>rules reader</p> }));
vi.mock("./diagrams-tab", () => ({ DiagramsTab: () => <p>diagrams reader</p> }));
vi.mock("./graph-tab", () => ({ GraphTab: () => <p>graph reader</p> }));
vi.mock("./entry-card", () => ({ EntryCard: () => null }));

beforeEach(() => {
  sub = null;
  push.mockClear();
});
afterEach(cleanup);

const READERS = ["Overview", "Scenarios", "Workflow", "Diagrams", "Graph", "Rules", "References"];

function renderScreen(canManage = true) {
  render(<KnowledgeScreen scope={{ projectId: "p1", canManage }} />);
}

describe("Knowledge readers", () => {
  it("lists the seven readers once, in one nav, with no tab row and no Memory", () => {
    renderScreen();
    const nav = screen.getByRole("navigation", { name: "Knowledge readers" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(READERS);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText("Memory")).toBeNull();
  });

  it("marks the overview as current and shows another reader's content when it is chosen", () => {
    renderScreen();
    const nav = screen.getByRole("navigation", { name: "Knowledge readers" });
    expect(within(nav).getByRole("button", { name: "Overview" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(nav).getByRole("button", { name: "Rules" }));
    expect(screen.getByText("rules reader")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Rules" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("opens the Rules reader from sub=rules and the overview from a stale sub=memory", () => {
    sub = "rules";
    renderScreen();
    expect(screen.getByText("rules reader")).toBeInTheDocument();
    cleanup();
    sub = "memory";
    renderScreen();
    expect(screen.getByText("No overview entry yet")).toBeInTheDocument();
  });
});

describe("empty product-map readers", () => {
  it("gives an admin an Open Automation button that goes to Automation, and no command", () => {
    renderScreen(true);
    expect(screen.getByText("No overview entry yet")).toBeInTheDocument();
    expect(screen.queryByText(/forge-product-map|bootstrap/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Automation" }));
    expect(push).toHaveBeenCalledWith("/projects/forge-dev/automation");
  });

  it("gives anyone else no button and no words about running it", () => {
    renderScreen(false);
    expect(screen.getByText("No overview entry yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Open Automation/ })).toBeNull();
    expect(screen.queryByText(/Run it|forge-product-map|bootstrap/i)).toBeNull();
  });

  it.each([
    ["Scenarios", "No scenario entries yet"],
    ["Workflow", "No workflow entries yet"],
  ])("does the same in the %s reader", (reader, title) => {
    renderScreen(true);
    const nav = screen.getByRole("navigation", { name: "Knowledge readers" });
    fireEvent.click(within(nav).getByRole("button", { name: reader }));
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Automation" })).toBeInTheDocument();
    expect(screen.queryByText(/forge-product-map|bootstrap/i)).toBeNull();
  });
});
