// @vitest-environment jsdom
//
// ISS-1229 r25, judge-72: at 390 wide a read-only project-deleted room with a long title was laid out
// 611px wide, and its title, read-only line and messages were cut off at the right edge with nothing
// to scroll. A flex item's automatic minimum width is its content's, so the column holding the view
// grew to the title's unbroken width. jsdom lays nothing out, so what is held here is the rule that
// prevents it: every flex item between the screen's row and the view may shrink below its content.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomWithoutAProject } from "../types";

const longTitle =
  "Before we retire this project: the old invoices, the export we promised finance, and who keeps the keys";
const orphan: RoomWithoutAProject = {
  id: "r1",
  title: longTitle,
  shape: "group",
  archivedAt: null,
  createdAt: "2026-10-20T06:33:00Z",
  updatedAt: "2026-10-20T06:40:00Z",
  deletedProjectNames: ["Billing"],
  lastMessageAt: "2026-10-20T06:40:00Z",
};

vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrgId: "o1" }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [] }),
  useOrgScopedProjects: () => ({ projects: [], projectIds: [] }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {} }));
vi.mock("@/lib/utils/use-persisted-state", async () => {
  const { useState } = await import("react");
  return { usePersistedState: <T,>(_key: string, initial: T) => useState(initial) };
});
vi.mock("../hooks", () => ({
  useConversationsAcrossProjects: () => ({ rows: [], isLoading: false, error: null, refetch: () => {} }),
  useRenameConversation: () => ({ mutate: () => {} }),
  useArchiveConversation: () => ({ mutate: () => {} }),
  useDeleteConversation: () => ({ mutate: () => {}, isPending: false }),
  useRoomsWithoutAProject: () => ({ data: [orphan], isError: false, refetch: () => {} }),
  useConversation: () => ({
    data: {
      messages: [
        {
          id: "m1",
          seq: 0,
          role: "user",
          authorUserId: "u2",
          authorLabel: "Mai Tran",
          content: "Noted. I copied the ledger before the project went.",
          silenceReason: null,
          createdAt: "2026-10-20T06:40:00Z",
        },
      ],
      windows: [],
    },
    isLoading: false,
    isError: false,
  }),
}));
vi.mock("./conversation-sidebar", () => ({
  ConversationSidebar: ({ below }: { below?: ReactNode }) => <aside>{below}</aside>,
}));
vi.mock("./conversation-chat", () => ({ ConversationChat: () => null }));
vi.mock("./start-conversation", () => ({ StartConversation: () => null }));
vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));

const { ConversationsScreen } = await import("./conversations-screen");

afterEach(cleanup);

/** Whether an element is laid out as a row of flex items, the axis a long title widens. */
const isFlexRow = (el: Element) => el.classList.contains("flex") && !el.classList.contains("flex-col");

function openTheRoom() {
  render(<ConversationsScreen />);
  const opens = screen.getAllByRole("button", { name: /^Open Before we retire this project/ });
  fireEvent.click(opens[0] as HTMLElement);
}

describe("a project-deleted room opened read-only", () => {
  it("lets every flex item between the screen's row and the view shrink below its content", () => {
    openTheRoom();
    const view = screen.getByTestId("orphan-room-view");
    const unbounded: string[] = [];
    for (let el: Element | null = view; el?.parentElement; el = el.parentElement) {
      if (isFlexRow(el.parentElement) && !el.classList.contains("min-w-0")) {
        unbounded.push(`<${el.tagName.toLowerCase()} class="${el.className}">`);
      }
    }
    expect(unbounded).toEqual([]);
    expect(screen.getByTestId("conversation-main").classList.contains("min-w-0")).toBe(true);
  });

  it("cuts its long title to the column rather than letting it set the width", () => {
    openTheRoom();
    const view = screen.getByTestId("orphan-room-view");
    const title = [...view.querySelectorAll("h1, h2, h3")].find((h) => h.textContent === longTitle);
    expect(title?.classList.contains("truncate")).toBe(true);
    expect(title?.parentElement?.classList.contains("min-w-0")).toBe(true);
  });
});
