// @vitest-environment jsdom
//
// ISS-1229 r28, judge-80 at 390: the history drawer on the Conversations page filled the phone's width
// while the room list inside it kept its 280px column, so the rest of the screen was blank white.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
