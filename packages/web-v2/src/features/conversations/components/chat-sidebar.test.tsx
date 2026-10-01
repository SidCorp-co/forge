// @vitest-environment jsdom
//
// ISS-34 — the chat sidebar's New chat starts the chat its scope names, or none: an Ecosystem
// scope with no ecosystem picked starts nothing, rather than a Project chat.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);
Element.prototype.scrollIntoView = vi.fn();

const PROJECT = { id: "p1", slug: "alpha", name: "Alpha", orgId: "o1" };
const INVITED = { id: "p2", slug: "beta", name: "Beta", orgId: "o-not-mine" };
const ECO = "e1";
const listed = vi.hoisted(() => ({ projectIds: [] as string[] }));

vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [PROJECT, INVITED] }),
  useOrgScopedProjects: () => ({ projects: [PROJECT] }),
}));
vi.mock("@/features/ecosystem/hooks", () => ({
  useProjectEcosystems: () => ({
    isError: false,
    isLoading: false,
    data: {
      memberships: [
        { document: { state: "active" }, ecosystem: { id: ECO, name: "Platform" } },
      ],
    },
  }),
}));
vi.mock("../hooks", () => {
  const idle = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useConversationsAcrossProjects: (projectIds: string[]) => {
      listed.projectIds = projectIds;
      return { rows: [], isLoading: false, error: null, refetch: vi.fn() };
    },
    useArchiveConversation: idle,
    useDeleteConversation: idle,
    usePinConversation: idle,
    useRenameConversation: idle,
  };
});

const { ChatSidebar } = await import("./chat-sidebar");

function sidebar() {
  const onNavigate = vi.fn();
  render(<ChatSidebar slug="alpha" conversationId={null} onNavigate={onNavigate} />);
  return { onNavigate };
}

describe("New chat under the Ecosystem scope", () => {
  it("is not offered until an ecosystem is picked, and says why", () => {
    const { onNavigate } = sidebar();
    fireEvent.click(screen.getByRole("button", { name: "Ecosystem" }));
    const start = screen.getByRole("button", { name: /New chat/ });
    expect(start).toBeDisabled();
    expect(screen.getByText("Pick an ecosystem to start an ecosystem chat.")).toBeInTheDocument();
    fireEvent.click(start);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("starts the project chat under the Project scope", () => {
    const { onNavigate } = sidebar();
    fireEvent.click(screen.getByRole("button", { name: /New chat/ }));
    expect(onNavigate).toHaveBeenCalledWith("/chat/alpha");
  });
});

describe("the conversations a person is in, across the projects they hold a role on", () => {
  it("lists every project's rooms, not only the active org's", () => {
    sidebar();
    expect(listed.projectIds).toEqual(["p1", "p2"]);
  });

  it("offers each of those projects in the project picker", () => {
    sidebar();
    fireEvent.click(screen.getByRole("combobox", { name: "Chat scope project" }));
    expect(screen.getByRole("option", { name: "Beta" })).toBeInTheDocument();
  });
});
