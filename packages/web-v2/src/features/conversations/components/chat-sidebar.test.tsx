// @vitest-environment jsdom
//
// ISS-36 — the chat sidebar carries three rows of controls before its list: the New chat split
// button, whose menu picks the scope the chat starts in, and one conversation search with a filter
// menu. ISS-34 still holds: an ecosystem chat never quietly becomes a project chat (F-3), and the
// list reads every project the person holds a role on (F-4).

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);
Element.prototype.scrollIntoView = vi.fn();

const PROJECT = { id: "p1", slug: "alpha", name: "Alpha", orgId: "o1" };
const INVITED = { id: "p2", slug: "beta", name: "Beta", orgId: "o-not-mine" };
const ECO = "e1";
const listed = vi.hoisted(() => ({ projectIds: [] as string[], archived: false }));
const ecosystems = vi.hoisted(() => ({ asked: [] as string[] }));

const row = (id: string, projectId: string, title: string, ecosystemId: string | null = null) => ({
  id,
  projectId,
  title,
  ecosystemId,
  adapter: "web",
  externalId: id,
  shape: "direct",
  mode: "assistant",
  updatedAt: "2026-10-01T10:00:00.000Z",
  archivedAt: null,
});
const LIVE = [row("c1", "p1", "Alpha release"), row("c2", "p2", "Beta backlog"), row("c3", "p1", "Platform drift", ECO)];
const ARCHIVED = [{ ...row("c9", "p1", "Old alpha thread"), archivedAt: "2026-09-01T00:00:00.000Z" }];

vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [PROJECT, INVITED] }),
  useOrgScopedProjects: () => ({ projects: [PROJECT] }),
}));
vi.mock("@/features/ecosystem/hooks", () => ({
  useProjectEcosystems: (projectId: string) => {
    ecosystems.asked.push(projectId);
    return {
      isError: false,
      isLoading: false,
      data: projectId
        ? { memberships: [{ document: { state: "active" }, ecosystem: { id: ECO, name: "Platform" } }] }
        : undefined,
    };
  },
}));
vi.mock("../hooks", () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useConversationsAcrossProjects: (projectIds: string[], archived: boolean) => {
      listed.projectIds = projectIds;
      listed.archived = archived;
      return { rows: archived ? ARCHIVED : LIVE, isLoading: false, error: null, refetch: vi.fn() };
    },
    useArchiveConversation: idle,
    useDeleteConversation: idle,
    usePinConversation: idle,
    useRenameConversation: idle,
  };
});

const { ChatSidebar } = await import("./chat-sidebar");

beforeEach(() => {
  ecosystems.asked = [];
});

function sidebar(slug: string | null = "alpha") {
  const onNavigate = vi.fn();
  render(<ChatSidebar slug={slug} conversationId={null} onNavigate={onNavigate} />);
  return { onNavigate };
}

const scopeMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: "Choose where the new chat starts" }));
  return within(screen.getByRole("menu"));
};
const filterMenu = () => {
  fireEvent.click(screen.getByRole("button", { name: /^Filter conversations/ }));
  return within(screen.getByRole("menu"));
};
const listedTitles = () => screen.queryAllByText(/release|backlog|drift|thread/).map((el) => el.textContent);

describe("the chat sidebar's controls", () => {
  it("holds no scope toggle row and no project picker row", () => {
    sidebar();
    expect(screen.queryByRole("button", { name: "Project" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ecosystem" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show archived" })).toBeNull();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});

describe("New chat", () => {
  it("names the project it starts in, and starts the project chat", () => {
    const { onNavigate } = sidebar();
    fireEvent.click(screen.getByRole("button", { name: "New chat · Alpha" }));
    expect(onNavigate).toHaveBeenCalledWith("/chat/alpha");
  });

  it("starts a chat in the project picked from its menu", () => {
    const { onNavigate } = sidebar();
    fireEvent.click(scopeMenu().getByRole("menuitemcheckbox", { name: "Beta" }));
    expect(onNavigate).toHaveBeenLastCalledWith("/chat/beta");
  });

  it("starts an ecosystem chat from its menu, asked from the open project, and keeps that scope", () => {
    const { onNavigate } = sidebar();
    const menu = scopeMenu();
    expect(within(menu.getByRole("group", { name: "Ecosystem" })).getByRole("menuitemcheckbox", { name: "Platform" })).toBeInTheDocument();
    fireEvent.click(menu.getByRole("menuitemcheckbox", { name: "Platform" }));
    expect(onNavigate).toHaveBeenLastCalledWith("/chat/alpha?ecosystem=e1");
    fireEvent.click(screen.getByRole("button", { name: "New chat · Platform" }));
    expect(onNavigate).toHaveBeenLastCalledWith("/chat/alpha?ecosystem=e1");
    expect(onNavigate).not.toHaveBeenCalledWith("/chat/alpha");
  });

  it("offers a room with other people, on the page that starts one", () => {
    const { onNavigate } = sidebar();
    fireEvent.click(scopeMenu().getByRole("menuitem", { name: "Start a room with other people…" }));
    expect(onNavigate).toHaveBeenLastCalledWith("/chat");
  });

  it("offers no ecosystem while no project is open, and says why", () => {
    sidebar(null);
    const item = scopeMenu().getByRole("menuitem", { name: "Open a project to reach its ecosystems" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
  });
});

describe("the filter menu", () => {
  it("lists every conversation until a filter is chosen, and is not pressed", () => {
    sidebar();
    expect(listedTitles()).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Filter conversations" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("active-filter")).toBeNull();
  });

  it("filters to one project and shows that it is filtered", () => {
    sidebar();
    fireEvent.click(filterMenu().getByRole("menuitemcheckbox", { name: "Beta" }));
    expect(listedTitles()).toEqual(["Beta backlog"]);
    expect(screen.getByRole("button", { name: "Filter conversations, showing Beta" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("active-filter")).toHaveTextContent("Showing Beta");
  });

  it("filters to an ecosystem's rooms", () => {
    sidebar();
    fireEvent.click(filterMenu().getByRole("menuitemcheckbox", { name: "Platform" }));
    expect(listedTitles()).toEqual(["Platform drift"]);
  });

  it("reaches the archived conversations, and Show all brings the full list back", () => {
    sidebar();
    fireEvent.click(filterMenu().getByRole("menuitemcheckbox", { name: "Archived" }));
    expect(listed.archived).toBe(true);
    expect(listedTitles()).toEqual(["Old alpha thread"]);
    expect(screen.getByTestId("active-filter")).toHaveTextContent("Showing archived");
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(listed.archived).toBe(false);
    expect(listedTitles()).toHaveLength(3);
  });

  it("ticks the filter in force", () => {
    sidebar();
    fireEvent.click(filterMenu().getByRole("menuitemcheckbox", { name: "Alpha" }));
    expect(filterMenu().getByRole("menuitemcheckbox", { name: "Alpha" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("the conversations a person is in, across the projects they hold a role on", () => {
  it("lists every project's rooms, not only the active org's", () => {
    sidebar();
    expect(listed.projectIds).toEqual(["p1", "p2"]);
  });

  it("offers each of those projects in the New chat menu and the filter", () => {
    sidebar();
    expect(scopeMenu().getByRole("menuitemcheckbox", { name: "Beta" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(filterMenu().getByRole("menuitemcheckbox", { name: "Beta" })).toBeInTheDocument();
  });
});
