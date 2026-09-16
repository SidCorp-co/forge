// @vitest-environment jsdom
//
// ISS-1040 — the all-projects sidebar's archived side.
//
// Every row in this rail offered Archive and archiving worked, so a room left
// the list; nothing on the screen could then ask for the other set, and the
// row's own Unarchive branch was unreachable here for want of a listed archived
// row. The propositions below are the ones a screenshot of the live side cannot
// settle: the toggle is a pressed state and not a link, the rail says which of
// the two sets is on screen, an empty archived side does not invite a new
// conversation into a list that would not show it, and a row listed on the
// archived side asks to be brought back rather than filed away again.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListedConversation } from "../hooks";
import { ConversationSidebar } from "./conversation-sidebar";

expect.extend(matchers);
afterEach(cleanup);

const room = (id: string, title: string, archivedAt: string | null): ListedConversation => ({
  id,
  adapter: "web",
  externalId: `v-${id}`,
  shape: "direct", mode: null,
  title,
  updatedAt: "2026-09-14T00:00:00.000Z",
  archivedAt,
  projectId: "p1",
});

const nameById = new Map([["p1", { name: "Alpha", slug: "alpha" }]]);

function mount(overrides: Partial<Parameters<typeof ConversationSidebar>[0]> = {}) {
  const props = {
    rows: [room("c1", "Release plan", null)],
    nameById,
    now: Date.parse("2026-09-14T01:00:00.000Z"),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    onNew: vi.fn(),
    onOpen: vi.fn(),
    showArchived: false,
    onToggleArchived: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    loading: false,
    error: null,
    onRetry: vi.fn(),
    ...overrides,
  };
  render(<ConversationSidebar {...props} />);
  return props;
}

describe("ConversationSidebar · the two sets and the way between them", () => {
  it("offers an Archived control that reports which set is on screen as aria-pressed", () => {
    mount();
    expect(screen.getByRole("button", { name: "Archived" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    cleanup();
    mount({ showArchived: true, rows: [room("c3", "Old migration", "2026-09-10T00:00:00.000Z")] });
    expect(screen.getByRole("button", { name: "Archived" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("asks the caller for the other set when that control is pressed", () => {
    const props = mount();
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(props.onToggleArchived).toHaveBeenCalledTimes(1);
  });

  it("names the set on screen", () => {
    mount();
    expect(screen.getByText("Your conversations")).toBeInTheDocument();
    expect(screen.queryByText("Archived conversations")).not.toBeInTheDocument();
    cleanup();
    mount({ showArchived: true, rows: [] });
    expect(screen.getByText("Archived conversations")).toBeInTheDocument();
  });

  // cm:guard the count of New-conversation controls is what this asserts rather than their absence:
  // the rail's own header carries one at all times, so an empty state that wrongly offered a second
  // would still leave `getByRole` finding one and the assertion passing.
  it("tells an empty archived side that nothing is archived, without offering a new conversation", () => {
    mount({ showArchived: true, rows: [] });
    expect(screen.getByText("Nothing archived")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New conversation" })).toHaveLength(1);
  });

  it("still tells an empty live side to start one", () => {
    mount({ rows: [] });
    expect(screen.getByText("No conversations yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New conversation" })).toHaveLength(2);
  });

  it("offers Unarchive on a row listed on the archived side, where the live side offers Archive", () => {
    mount({ showArchived: true, rows: [room("c3", "Old migration", "2026-09-10T00:00:00.000Z")] });
    expect(screen.getByRole("button", { name: "Unarchive Old migration" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Old migration" })).not.toBeInTheDocument();
    cleanup();
    mount();
    expect(screen.getByRole("button", { name: "Archive Release plan" })).toBeInTheDocument();
  });

  it("asks to bring a room back, rather than to file it away again, from the archived side", () => {
    const props = mount({
      showArchived: true,
      rows: [room("c3", "Old migration", "2026-09-10T00:00:00.000Z")],
    });
    fireEvent.click(screen.getByRole("button", { name: "Unarchive Old migration" }));
    expect(props.onArchive).toHaveBeenCalledWith(false, expect.objectContaining({ id: "c3" }));
  });

  // cm:guard the collapsed rail renders no toggle: it renders no list either, so a control there
  // would swap a set nobody can see and read as having done nothing.
  it("shows no Archived control while the rail is collapsed", () => {
    mount({ collapsed: true });
    expect(screen.queryByRole("button", { name: "Archived" })).not.toBeInTheDocument();
  });
});
