// @vitest-environment jsdom
//
// ISS-1028 — what a person can do TO a room from the list.
//
// The three propositions here are the ones a screenshot cannot settle: the
// actions are siblings of the open target rather than nested inside it, they are
// revealed by focus as well as by hover, and the rename commits what was typed
// rather than what the row was called.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListedConversation } from "../hooks";
import { ConversationRow } from "./conversation-row";

expect.extend(matchers);
afterEach(cleanup);

const row: ListedConversation = {
  id: "c1",
  adapter: "web",
  externalId: "v1",
  shape: "direct", mode: null,
  title: "Release plan",
  updatedAt: "2026-09-14T00:00:00.000Z",
  archivedAt: null,
  projectId: "p1",
};

const project = { name: "Alpha", slug: "alpha" };

function mount(overrides: Partial<Parameters<typeof ConversationRow>[0]> = {}) {
  const props = {
    row,
    project,
    onOpen: vi.fn(),
    onRename: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  render(<ConversationRow {...props} />);
  return props;
}

describe("ConversationRow · the actions on a row", () => {
  it("offers rename, archive and delete, each named for the room it acts on", () => {
    mount();
    expect(screen.getByRole("button", { name: "Rename Release plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Release plan" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Release plan" })).toBeInTheDocument();
  });

  it("keeps every action outside the button that opens the room", () => {
    mount();
    const opener = screen.getByRole("button", { name: "Open Release plan in Alpha" });
    for (const name of ["Rename Release plan", "Archive Release plan", "Delete Release plan"]) {
      expect(opener).not.toContainElement(screen.getByRole("button", { name }));
    }
  });

  it("reveals the actions on focus and not on hover alone", () => {
    mount();
    const actions = screen.getByRole("button", { name: "Delete Release plan" }).parentElement;
    expect(actions?.className).toContain("group-hover:opacity-100");
    expect(actions?.className).toContain("group-focus-within:opacity-100");
  });

  it("renders no action a caller gave no handler for", () => {
    cleanup();
    render(<ConversationRow row={row} project={project} onOpen={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Rename/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Archive/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it("offers to unarchive rather than to archive a room already archived", () => {
    mount({ row: { ...row, archivedAt: "2026-09-14T01:00:00.000Z" } });
    expect(screen.getByRole("button", { name: "Unarchive Release plan" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unarchive Release plan" }));
  });

  it("asks for the archive it does not yet have", () => {
    const props = mount();
    fireEvent.click(screen.getByRole("button", { name: "Archive Release plan" }));
    expect(props.onArchive).toHaveBeenCalledWith(true);
  });

  it("asks to clear the archive on a room that has one", () => {
    const props = mount({ row: { ...row, archivedAt: "2026-09-14T01:00:00.000Z" } });
    fireEvent.click(screen.getByRole("button", { name: "Unarchive Release plan" }));
    expect(props.onArchive).toHaveBeenCalledWith(false);
  });
});

describe("ConversationRow · renaming in place", () => {
  it("commits what was typed rather than what the row was called", () => {
    const props = mount();
    fireEvent.click(screen.getByRole("button", { name: "Rename Release plan" }));
    const field = screen.getByLabelText("Conversation name");
    fireEvent.change(field, { target: { value: "Release plan v2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onRename).toHaveBeenCalledWith("Release plan v2");
  });

  it("seeds the editor with the name the row already carries", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Rename Release plan" }));
    expect(screen.getByLabelText("Conversation name")).toHaveValue("Release plan");
  });

  it("writes nothing when the editor is dismissed with Escape", () => {
    const props = mount();
    fireEvent.click(screen.getByRole("button", { name: "Rename Release plan" }));
    const field = screen.getByLabelText("Conversation name");
    fireEvent.change(field, { target: { value: "never sent" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Rename Release plan" })).toBeInTheDocument();
  });

  it("writes nothing when the name is cleared to whitespace", () => {
    const props = mount();
    fireEvent.click(screen.getByRole("button", { name: "Rename Release plan" }));
    const field = screen.getByLabelText("Conversation name");
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("writes nothing when the name comes back unchanged", () => {
    const props = mount();
    fireEvent.click(screen.getByRole("button", { name: "Rename Release plan" }));
    fireEvent.keyDown(screen.getByLabelText("Conversation name"), { key: "Enter" });
    expect(props.onRename).not.toHaveBeenCalled();
  });
});
