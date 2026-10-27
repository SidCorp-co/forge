// @vitest-environment jsdom
//
// ISS-1229 r35, judge-95: the project drawer's room list offered a viewer of the project a new room,
// and asked them to "ask the agent something", which their role does not let them do.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const rows: Array<Record<string, unknown>> = [];
const projects: Array<Record<string, unknown>> = [{ id: "p1", name: "Ops", slug: "ops", role: "viewer" }];
const projectsRead = vi.hoisted(() => ({ failed: false, refetch: () => {} }));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () =>
    projectsRead.failed
      ? { data: undefined, isError: true, error: new Error("down"), refetch: projectsRead.refetch }
      : { data: projects, isError: false, error: null, refetch: projectsRead.refetch },
}));
vi.mock("../hooks", () => ({
  listedUnder: (row: unknown) => row,
  useConversations: () => ({ data: { items: rows }, isLoading: false, error: null, refetch: () => {} }),
  useRenameConversation: () => ({ mutate: () => {} }),
  useArchiveConversation: () => ({ mutate: () => {} }),
  useDeleteConversation: () => ({ mutate: () => {} }),
}));

const { ConversationList } = await import("./conversation-list");
const { READ_ONLY_LIST_EMPTY } = await import("../membership");

afterEach(cleanup);

const props = { projectId: "p1", projectName: "Ops", projectSlug: "ops", onOpen: vi.fn(), onGone: vi.fn() };

describe("the drawer's room list, as its panel asks it", () => {
  it("offers a new room where it is given one to offer", () => {
    render(<ConversationList {...props} onNew={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: /new conversation/i })).toHaveLength(2);
  });

  it("offers none where it is given none, and says the list is only to read", () => {
    render(<ConversationList {...props} />);
    expect(screen.queryByRole("button", { name: /new conversation/i })).toBeNull();
    expect(screen.getByText(READ_ONLY_LIST_EMPTY)).toBeTruthy();
    expect(screen.queryByText(/ask the agent something/i)).toBeNull();
  });
});

describe("the drawer's room rows", () => {
  it("offer no rename, archive or delete on a room whose project the reader only views", () => {
    rows.push({
      id: "c1",
      title: "Ops handover",
      scope: ["p1"],
      projectId: "p1",
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      adapter: "web",
      externalId: "x",
      shape: "group",
      mode: null,
    });
    render(<ConversationList {...props} />);
    expect(screen.getByText("Ops handover")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^(Rename|Archive|Delete) Ops handover/ })).toHaveLength(0);
    projects.splice(0, 1, { id: "p1", name: "Ops", slug: "ops", role: "member" });
    cleanup();
    render(<ConversationList {...props} />);
    expect(screen.queryAllByRole("button", { name: /^(Rename|Archive|Delete) Ops handover/ })).toHaveLength(3);
  });
});

// ISS-1229 r48: a room about another project read "Unknown project" while the projects read had failed.
describe("the drawer's room rows, while the projects cannot be read", () => {
  it("say the other project's name was not loaded, never that the project is unknown", () => {
    rows.splice(0, rows.length, {
      id: "c2",
      title: "Cross-team",
      scope: ["p9"],
      projectId: "p9",
      updatedAt: new Date().toISOString(),
      archivedAt: null,
      adapter: "web",
      externalId: "y",
      shape: "group",
      mode: null,
    });
    projectsRead.failed = true;
    render(<ConversationList {...props} />);
    expect(screen.queryByText("Unknown project")).toBeNull();
    expect(screen.getByText("1 project not loaded")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /an unknown project/ })).toBeNull();
    projectsRead.failed = false;
  });

  it("say the projects could not be loaded above the rows, and Retry reads them again", () => {
    projectsRead.failed = true;
    const refetch = vi.fn();
    projectsRead.refetch = refetch;
    render(<ConversationList {...props} />);
    const failure = screen.getByRole("alert");
    expect(failure.textContent).toContain("Couldn't load your projects");
    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    projectsRead.failed = false;
  });
});
