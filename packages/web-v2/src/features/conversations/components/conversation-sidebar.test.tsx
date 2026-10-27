// @vitest-environment jsdom
//
// ISS-1229 r28, judge-80 at 390: the history drawer on the Conversations page filled the phone's width
// while the room list inside it kept its 280px column, so the rest of the screen was blank white.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListedConversation } from "../hooks";
import { changesRoom, READ_ONLY_LIST_EMPTY } from "../membership";
import { ConversationSidebar } from "./conversation-sidebar";

afterEach(cleanup);

const props = {
  rows: [],
  nameById: new Map(),
  now: Date.now(),
  collapsed: false,
  onToggleCollapse: vi.fn(),
  onNew: vi.fn(),
  onOpen: vi.fn(),
  showArchived: false,
  onToggleArchived: vi.fn(),
  loading: false,
  error: null,
  errorTitle: "Couldn't load conversations",
  onRetry: vi.fn(),
};

describe("the room list", () => {
  it("fills the drawer it is opened in, leaving nothing blank beside it", () => {
    render(<ConversationSidebar {...props} onClose={vi.fn()} />);
    const list = screen.getByTestId("conversation-sidebar");
    expect(list.className).toContain("w-full");
    expect(list.className).not.toContain("w-[280px]");
  });

  it("keeps its own column beside the room on a wide screen", () => {
    render(<ConversationSidebar {...props} />);
    expect(screen.getByTestId("conversation-sidebar").className).toContain("w-[280px]");
  });
});

// ISS-1229 r35, judge-95: a reader holding only the viewer role was offered "New conversation" twice
// and told to start one on any project, beside a chooser saying they cannot.
describe("the room list, for a reader who may start no room", () => {
  const { onNew: _offered, ...noOffer } = props;

  it("offers no new conversation and says why its list is only to read", () => {
    render(<ConversationSidebar {...noOffer} />);
    expect(screen.queryByRole("button", { name: /new conversation/i })).toBeNull();
    expect(screen.getByText(READ_ONLY_LIST_EMPTY)).toBeTruthy();
    expect(screen.getByTestId("conversation-sidebar").textContent).not.toMatch(/start/i);
  });

  it("offers none collapsed either", () => {
    render(<ConversationSidebar {...noOffer} collapsed />);
    expect(screen.queryByRole("button", { name: /new conversation/i })).toBeNull();
  });

  it("still offers one to a reader who may", () => {
    render(<ConversationSidebar {...props} />);
    expect(screen.getAllByRole("button", { name: /new conversation/i })).toHaveLength(2);
  });
});

// ISS-1229 r35: a viewer of one project of a two-project room was shown its rename, archive and delete
// controls, each of which core refuses them.
describe("a row's changes", () => {
  const pair: ListedConversation = {
    id: "c2",
    adapter: "web",
    externalId: "x",
    shape: "group",
    mode: null,
    title: "Desk and Ops handover",
    updatedAt: new Date().toISOString(),
    archivedAt: null,
    scope: ["desk", "ops"],
    projectId: "desk",
  };
  const role: Record<string, string> = { desk: "member", ops: "viewer" };
  const changers = { onRename: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn() };
  const controls = () => screen.queryAllByRole("button", { name: /^(Rename|Archive|Delete) Desk and Ops/ });

  it("are not offered to a reader holding only the viewer role on one of its projects", () => {
    render(
      <ConversationSidebar
        {...props}
        {...changers}
        rows={[pair]}
        mayChange={(row) => changesRoom(row, (id) => role[id])}
      />,
    );
    expect(screen.getByText("Desk and Ops handover")).toBeTruthy();
    expect(controls()).toHaveLength(0);
  });

  it("are offered to a member of both", () => {
    role.ops = "member";
    render(
      <ConversationSidebar
        {...props}
        {...changers}
        rows={[pair]}
        mayChange={(row) => changesRoom(row, (id) => role[id])}
      />,
    );
    expect(controls()).toHaveLength(3);
  });
});

// ISS-1229 r48, judge-142: the list's failure is titled after the read that failed, which its caller names.
describe("the room list whose read failed", () => {
  it("heads its failure with the title it is given, and offers Retry", () => {
    render(<ConversationSidebar {...props} error={new Error("down")} errorTitle="Couldn't load your projects" />);
    expect(screen.getByRole("heading", { name: "Couldn't load your projects" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Couldn't load conversations" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
