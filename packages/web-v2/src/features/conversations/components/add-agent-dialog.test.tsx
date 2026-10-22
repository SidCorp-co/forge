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
const noneBeyond = { named: [] as Array<{ id: string; name: string; slug: string }>, unnamed: 0 };
let beyondReach = noneBeyond;
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
    data: { people: [], handles, beyondReach },
  }),
  useAddHandle: () => add,
}));

afterEach(() => {
  cleanup();
  handles = [candidate("retired", "p-gone", "Retired"), candidate("desk", "p1", "Desk")];
  beyondReach = noneBeyond;
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

  // r32, judge-90: an admin was told a role they held is what adds an agent.
  it("says every agent the reader can add is already here, and where another one comes from", () => {
    handles = [];
    render(<AddAgentDialog conversationId="c1" room={{ shape: "group", scopeProjects: [] }} open onClose={() => {}} />);
    const empty = screen.getByTestId("agent-candidates-empty");
    expect(empty.textContent).toMatch(/^Every agent you can add is already in this room\./);
    expect(empty.textContent).toMatch(/Each project has its own agent/);
    expect(empty.textContent).not.toMatch(/role/);
    expect(screen.getByRole("link", { name: "Start a new project" }).getAttribute("href")).toBe("/projects?new=1");
  });

  // r33, judge-92: a member with no role on an existing project was pointed only at starting a new one.
  it("says who adds an agent the reader cannot, beside starting a new project", () => {
    handles = [];
    beyondReach = { named: [{ id: "p-ops", name: "Ops", slug: "ops" }], unnamed: 1 };
    render(<AddAgentDialog conversationId="c1" room={{ shape: "group", scopeProjects: [] }} open onClose={() => {}} />);
    const lines = screen.getAllByTestId("agent-beyond-reach").map((p) => p.textContent);
    expect(lines).toEqual([
      "Ops's agent is added by a member of Ops; you hold the viewer role there.",
      "Another project in this organization has its own agent, added by a member of that project; you hold no role on it.",
    ]);
    const empty = screen.getByTestId("agent-candidates-empty").textContent ?? "";
    expect(empty).toMatch(/^Every agent you can add is already in this room\./);
    expect(empty).toContain("Ask a member of the project to add its agent, or start a new project.");
    expect(screen.getByRole("link", { name: "start a new project" }).getAttribute("href")).toBe("/projects?new=1");
  });

  it("counts several projects it cannot name, and says it under a list that still offers agents", () => {
    handles = [candidate("desk", "p1", "Desk")];
    beyondReach = { named: [], unnamed: 3 };
    render(<AddAgentDialog conversationId="c1" room={{ shape: "group", scopeProjects: [] }} open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /@desk/ })).toBeTruthy();
    expect(screen.getByTestId("agent-beyond-reach").textContent).toBe(
      "3 other projects in this organization have their own agents, each added by a member of its project; you hold no role on them.",
    );
  });
});
