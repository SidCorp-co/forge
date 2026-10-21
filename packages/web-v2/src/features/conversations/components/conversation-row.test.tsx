// @vitest-environment jsdom
//
// ISS-1229 r25, judge-72: the conversation history list cut each title to about nine characters. The
// row's rename, archive and delete controls were invisible until hovered but still sat beside the
// title in the flow, so the width they held was taken from the title. They now lie over the row's end,
// and the title runs to the column's edge.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListedConversation } from "../hooks";
import { ConversationRow } from "./conversation-row";

afterEach(cleanup);

const row: ListedConversation = {
  id: "c1",
  adapter: "web",
  externalId: "x",
  shape: "direct",
  mode: null,
  title: "Quarterly invoice export for the finance team",
  updatedAt: "2026-10-20T06:40:00Z",
  archivedAt: null,
  projectId: "p1",
};

describe("a row of the conversation history", () => {
  it("holds no width for controls that are not shown, so the title runs to the column", () => {
    render(
      <ConversationRow
        row={row}
        project={{ name: "Billing", slug: "billing" }}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const actions = screen.getByTestId("conversation-row-actions");
    expect(actions.classList.contains("absolute")).toBe(true);
    expect(actions.parentElement?.classList.contains("relative")).toBe(true);
    const open = screen.getByRole("button", { name: /^Open Quarterly invoice export/ });
    expect(open.classList.contains("flex-1")).toBe(true);
    expect(open.nextElementSibling).toBe(actions);
    expect(screen.getByText(row.title as string).classList.contains("truncate")).toBe(true);
  });

  it("still offers rename, archive and delete by name", () => {
    render(
      <ConversationRow
        row={row}
        project={{ name: "Billing", slug: "billing" }}
        onOpen={vi.fn()}
        onRename={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: `Rename ${row.title}` })).toBeTruthy();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(4);
  });
});
