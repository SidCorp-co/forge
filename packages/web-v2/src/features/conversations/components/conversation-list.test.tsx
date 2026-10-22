// @vitest-environment jsdom
//
// ISS-1229 r35, judge-95: the project drawer's room list offered a viewer of the project a new room,
// and asked them to "ask the agent something", which their role does not let them do.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const rows: Array<Record<string, unknown>> = [];
const projects: Array<Record<string, unknown>> = [{ id: "p1", name: "Ops", slug: "ops", role: "viewer" }];
vi.mock("@/features/projects/hooks", () => ({ useProjects: () => ({ data: projects }) }));
vi.mock("../hooks", () => ({
  listedUnder: (row: unknown) => row,
  useConversations: () => ({ data: { items: rows }, isLoading: false, error: null, refetch: () => {} }),
  useRenameConversation: () => ({ mutate: () => {} }),
  useArchiveConversation: () => ({ mutate: () => {} }),
  useDeleteConversation: () => ({ mutate: () => {} }),
}));

const { ConversationList } = await import("./conversation-list");
const { VIEWER_LIST_EMPTY } = await import("../membership");

afterEach(cleanup);

const props = { projectId: "p1", projectName: "Ops", projectSlug: "ops", onOpen: vi.fn(), onGone: vi.fn() };

describe("the drawer's room list", () => {
  it("offers a member a new room", () => {
    render(<ConversationList {...props} onNew={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: /new conversation/i })).toHaveLength(2);
  });

  it("offers a viewer none, and says the list is only to read", () => {
    render(<ConversationList {...props} />);
    expect(screen.queryByRole("button", { name: /new conversation/i })).toBeNull();
    expect(screen.getByText(VIEWER_LIST_EMPTY)).toBeTruthy();
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
