// @vitest-environment jsdom
//
// ISS-1229 r35, judge-95: the project drawer offered a viewer of its project a new room, from its
// history list and its chat alike, which core refuses them.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const reader = { role: "viewer" as string | null };
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", name: "Ops", slug: "ops", role: reader.role }] }),
}));
vi.mock("./conversation-chat", () => ({
  ConversationChat: ({
    onNew,
    onOpenHistory,
    emptyBody,
  }: {
    onNew?: () => void;
    onOpenHistory?: () => void;
    emptyBody?: React.ReactNode;
  }) => (
    <div>
      {onNew && <span data-testid="chat-offers-new" />}
      {onOpenHistory && (
        <button type="button" onClick={onOpenHistory}>
          History
        </button>
      )}
      {emptyBody}
    </div>
  ),
}));
vi.mock("./conversation-list", () => ({
  ConversationList: ({ onNew }: { onNew?: () => void }) =>
    onNew ? <span data-testid="list-offers-new" /> : <span data-testid="list-offers-none" />,
}));

const { ConversationPanel } = await import("./conversation-panel");

afterEach(cleanup);

const offers = () => [
  screen.queryByTestId("chat-offers-new") !== null,
  screen.queryByTestId("list-offers-new") !== null,
];

describe("the project drawer's offer of a new room", () => {
  it("is not made to a viewer of the project, from its chat or its list", () => {
    reader.role = "viewer";
    render(<ConversationPanel projectId="p1" />);
    expect(offers()).toEqual([false, false]);
    expect(screen.getByTestId("list-offers-none")).toBeTruthy();
  });

  it.each(["member", "admin"])("is made to a reader holding the %s role", (role) => {
    reader.role = role;
    render(<ConversationPanel projectId="p1" />);
    expect(offers()).toEqual([true, true]);
  });
});

// ISS-1229 r47: the panel sits over a page whose own title is its h1, so its title is never a second one.
describe("the project drawer's own title", () => {
  it("is a section heading over the page, never an h1", () => {
    reader.role = "member";
    render(<ConversationPanel projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("heading", { level: 2, name: "Conversations" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });
});
