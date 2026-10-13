// @vitest-environment jsdom
//
// ISS-1263 — the console's Sort select, its search box, its needs-attention filter and the list's
// column headers act on one set of rows, and the cards and the list both show it. A header that
// sorted only the list, or a select that left the headers unmarked, would be two controls for one
// thing; these drive the console as a person does and read both views.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectConsoleItem } from "../types";
import { ProjectsConsole } from "./projects-console";

expect.extend(matchers);

const state: { items: ProjectConsoleItem[] } = { items: [] };
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrg: null, activeOrgId: null }) }));
vi.mock("./new-project-dialog", () => ({ NewProjectDialog: () => null }));
vi.mock("../hooks", () => ({
  useProjectsConsole: () => ({
    items: state.items,
    isLoading: false,
    isError: false,
    error: null,
    healthRead: "read",
    projectsRead: "read",
    refetch: () => {},
    toggle: () => {},
  }),
}));
// jsdom has no layout; the Select scrolls its active option into view on open.
Element.prototype.scrollIntoView = vi.fn();

const project = (name: string, over: Partial<ProjectConsoleItem> = {}): ProjectConsoleItem => ({
  id: name, slug: name, name, orgId: "o1", orgName: "Org", orgIsPersonal: false, role: "admin",
  createdAt: "2026-10-01T00:00:00Z", description: `${name} desc`, repoPath: `repo/${name}`, healthRead: "read",
  health: "healthy", liveRuns: 0, openIssues: 1, runnerCount: 1, spend24hUsd: 1, memberCount: 1, members: ["AB"],
  lastActivityAt: "2026-10-02T00:00:00Z", pinned: false, ...over,
});

beforeEach(() => {
  state.items = [
    project("bravo", { lastActivityAt: "2026-10-03T00:00:00Z" }),
    project("alpha", { health: "idle", lastActivityAt: "2026-10-09T00:00:00Z" }),
    project("charlie", { health: "attention", lastActivityAt: "2026-10-01T00:00:00Z" }),
  ];
});
afterEach(cleanup);

const showList = () => fireEvent.click(screen.getByRole("button", { name: "List" }));
const showCards = () => fireEvent.click(screen.getByRole("button", { name: "Cards" }));
const header = (name: RegExp | string) => screen.getByRole("columnheader", { name });
const press = (name: RegExp | string) => fireEvent.click(within(header(name)).getByRole("button"));
const listNames = () =>
  within(screen.getByRole("table", { name: "Projects" }))
    .getAllByRole("row")
    .slice(1)
    .map((tr) => within(tr).getAllByRole("cell")[0]?.querySelector(".truncate")?.textContent);
const cardNames = () => screen.queryAllByText(/^(alpha|bravo|charlie)$/).map((el) => el.textContent);
const sortSelect = () => screen.getByRole("combobox", { name: "Sort projects" });
function choose(label: string) {
  fireEvent.click(sortSelect());
  fireEvent.click(screen.getByRole("option", { name: label }));
}

describe("the projects list, sorted from its headers", () => {
  it("orders by name on the first activation of Project and reverses it on the second", () => {
    render(<ProjectsConsole />);
    showList();
    press("Project");
    expect(listNames()).toEqual(["alpha", "bravo", "charlie"]);
    expect(header("Project")).toHaveAttribute("aria-sort", "ascending");
    press("Project");
    expect(listNames()).toEqual(["charlie", "bravo", "alpha"]);
    expect(header("Project")).toHaveAttribute("aria-sort", "descending");
  });

  it("marks Active as sorted newest first before anything is pressed", () => {
    render(<ProjectsConsole />);
    showList();
    expect(header(/Active/)).toHaveAttribute("aria-sort", "descending");
    expect(listNames()).toEqual(["alpha", "bravo", "charlie"]);
  });
});

describe("the Sort select and the headers are one control", () => {
  it("marks the Health header when Health is chosen in the select, and the rows follow", () => {
    render(<ProjectsConsole />);
    showList();
    choose("Health (worst first)");
    expect(header(/Health/)).toHaveAttribute("aria-sort", "ascending");
    expect(header(/Active/)).toHaveAttribute("aria-sort", "none");
    expect(listNames()).toEqual(["charlie", "bravo", "alpha"]);
  });

  it("shows the select on the header just pressed", () => {
    render(<ProjectsConsole />);
    showList();
    press("Project");
    expect(sortSelect()).toHaveTextContent("Name (A–Z)");
  });

  it("names the direction the list is in after a header reverses it, and says so again in the other", () => {
    render(<ProjectsConsole />);
    showList();
    press("Project");
    expect(sortSelect()).toHaveTextContent("Name (A–Z)");
    press("Project");
    expect(sortSelect()).toHaveTextContent("Name (Z–A)");
    expect(listNames()).toEqual(["charlie", "bravo", "alpha"]);
    press("Health");
    expect(sortSelect()).toHaveTextContent("Health (worst first)");
    press("Health");
    expect(sortSelect()).toHaveTextContent("Health (best first)");
    press(/Active/);
    expect(sortSelect()).toHaveTextContent("Recently active");
    press(/Active/);
    expect(sortSelect()).toHaveTextContent("Least recently active");
  });

  it("keeps the direction when the sort already chosen is chosen again in the select", () => {
    render(<ProjectsConsole />);
    showList();
    press("Project");
    press("Project");
    choose("Name (Z–A)");
    expect(listNames()).toEqual(["charlie", "bravo", "alpha"]);
    expect(header("Project")).toHaveAttribute("aria-sort", "descending");
    expect(sortSelect()).toHaveTextContent("Name (Z–A)");
  });

  it("offers both directions of every sort, so Name (A–Z) is chosen from the select once Name is sorted descending", () => {
    render(<ProjectsConsole />);
    showList();
    press("Project");
    press("Project");
    expect(listNames()).toEqual(["charlie", "bravo", "alpha"]);
    fireEvent.click(sortSelect());
    const offered = screen.getAllByRole("option").map((o) => o.textContent);
    expect(offered).toEqual([
      "Recently active",
      "Least recently active",
      "Name (A–Z)",
      "Name (Z–A)",
      "Health (worst first)",
      "Health (best first)",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "Name (A–Z)" }));
    expect(listNames()).toEqual(["alpha", "bravo", "charlie"]);
    expect(header("Project")).toHaveAttribute("aria-sort", "ascending");
    expect(sortSelect()).toHaveTextContent("Name (A–Z)");
  });

  it("reverses a sort from the select as well, in either direction", () => {
    render(<ProjectsConsole />);
    showList();
    choose("Least recently active");
    expect(header(/Active/)).toHaveAttribute("aria-sort", "ascending");
    expect(listNames()).toEqual(["charlie", "bravo", "alpha"]);
    choose("Health (best first)");
    expect(header(/Health/)).toHaveAttribute("aria-sort", "descending");
  });

  it("gives the cards the order the select chose, the same one the list shows", () => {
    render(<ProjectsConsole />);
    choose("Name (A–Z)");
    expect(cardNames()).toEqual(["alpha", "bravo", "charlie"]);
    showList();
    expect(listNames()).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("keeps the order a header chose when the view goes back to cards", () => {
    render(<ProjectsConsole />);
    showList();
    press("Project");
    press("Project");
    showCards();
    expect(cardNames()).toEqual(["charlie", "bravo", "alpha"]);
  });
});

describe("the projects list keeps its Project column in view", () => {
  it("holds the start edge with the Project column, which carries the project's mark with its name", () => {
    render(<ProjectsConsole />);
    showList();
    expect(header("Project")).toHaveClass("sticky");
    const firstRow = within(screen.getByRole("table", { name: "Projects" })).getAllByRole("row")[1] as HTMLElement;
    const [first, second] = within(firstRow).getAllByRole("cell");
    expect(first).toHaveClass("sticky");
    expect(second).not.toHaveClass("sticky");
    expect(first?.textContent).toContain("alpha");
  });
});

describe("search and the needs-attention filter, in both views", () => {
  it("keeps the projects the search matches, in the cards and in the list", () => {
    render(<ProjectsConsole />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "CHAR" } });
    expect(cardNames()).toEqual(["charlie"]);
    showList();
    expect(listNames()).toEqual(["charlie"]);
  });

  it("matches the organization and the description as well as the name", () => {
    render(<ProjectsConsole />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "bravo desc" } });
    expect(cardNames()).toEqual(["bravo"]);
  });

  it("says nothing matches when the search matches nothing", () => {
    render(<ProjectsConsole />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search projects" }), { target: { value: "zzz" } });
    expect(screen.getByText("No projects match your filters.")).toBeInTheDocument();
  });

  it("keeps only the projects that need attention when that filter is on", () => {
    render(<ProjectsConsole />);
    fireEvent.click(screen.getByRole("button", { name: "Show only these" }));
    expect(cardNames()).toEqual(["charlie"]);
    showList();
    expect(listNames()).toEqual(["charlie"]);
  });
});
