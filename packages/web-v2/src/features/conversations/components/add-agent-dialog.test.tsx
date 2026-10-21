// @vitest-environment jsdom
//
// ISS-1229 r29, the master's ruling: after adding @retired was refused because its project had been
// deleted, the panel kept offering "Add @retired", which could only be refused again.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { AddAgentDialog } from "./add-agent-dialog";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const candidate = (handle: string, projectId: string, name: string) => ({
  userId: `u-${handle}`,
  handle,
  project: { id: projectId, name, slug: handle },
  losesReaders: [],
});
const refetch = vi.fn();
let handles = [candidate("retired", "p-gone", "Retired"), candidate("desk", "p1", "Desk")];
const gone = new ApiError(
  404,
  "The project this agent would bring into this room no longer exists, so there is no agent of it to add.",
  "PROJECT_GONE",
);
const add = {
  isPending: false,
  isError: false,
  error: null as unknown,
  reset: vi.fn(),
  mutate: (_args: unknown, opts?: { onError?: (err: unknown) => void }) => {
    add.isError = true;
    add.error = gone;
    opts?.onError?.(gone);
  },
};
vi.mock("../hooks", () => ({
  useConversationCandidates: () => ({
    isLoading: false,
    isError: false,
    refetch,
    data: { people: [], handles },
  }),
  useAddHandle: () => add,
}));

afterEach(() => {
  cleanup();
  handles = [candidate("retired", "p-gone", "Retired"), candidate("desk", "p1", "Desk")];
});

describe("adding the agent of a project that was deleted", () => {
  it("drops that agent, reads the list again and says why, offering no second try", () => {
    render(<AddAgentDialog conversationId="c1" room={{ shape: "group", scopeProjects: [] }} open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /@retired/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add @retired" }));

    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Add @retired" })).toBeNull();
    expect(screen.queryByRole("button", { name: /@retired/ })).toBeNull();
    expect(screen.getByRole("button", { name: /@desk/ })).toBeTruthy();
    expect(screen.getByTestId("add-agent-error").textContent).toContain("no longer exists");
  });

  // r30, judge-86: with nothing left to offer, the panel said an agent is added by somebody holding a
  // member role on its project, which was not why there was none.
  it("says the agent's project was deleted when that leaves no agent to offer", () => {
    handles = [candidate("retired", "p-gone", "Retired")];
    render(<AddAgentDialog conversationId="c1" room={{ shape: "group", scopeProjects: [] }} open onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /@retired/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add @retired" }));

    const empty = screen.getByTestId("agent-candidates-empty").textContent ?? "";
    expect(empty).toMatch(/project .*was deleted/);
    expect(empty).not.toMatch(/member role/);
  });

  // r32, judge-90: an admin whose project's one agent was already in the room read that an agent is
  // added by somebody holding a member role, a role they held. The panel says what is true instead.
  it("says every agent the reader can add is already here, and where another one comes from", () => {
    handles = [];
    render(<AddAgentDialog conversationId="c1" room={{ shape: "group", scopeProjects: [] }} open onClose={() => {}} />);
    const empty = screen.getByTestId("agent-candidates-empty");
    expect(empty.textContent).toMatch(/^Every agent you can add is already in this room\./);
    expect(empty.textContent).toMatch(/Each project has its own agent/);
    expect(empty.textContent).not.toMatch(/role/);
    expect(screen.getByRole("link", { name: "Start a new project" }).getAttribute("href")).toBe("/projects?new=1");
  });
});
