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

const candidate = (handle: string, projectId: string, name: string, reachable = true) => ({
  userId: `u-${handle}`,
  handle,
  project: { id: projectId, name, slug: handle },
  losesReaders: [],
  reachable,
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
      "Ask a member of Ops to add Ops's agent; you hold the viewer role there.",
      "Another project in this organization has its own agent; you hold no role on it, so a member of that project adds it.",
    ]);
    const empty = screen.getByTestId("agent-candidates-empty").textContent ?? "";
    expect(empty).toMatch(/^Every agent you can add is already in this room\./);
    expect(empty).toContain("Or start a new project, which comes with its own agent.");
    expect(screen.getByRole("link", { name: "start a new project" }).getAttribute("href")).toBe("/projects?new=1");
  });

  // r34, judge-93: after naming two projects the panel said "Ask a member of the project", leaving which to guess.
  it("says in each sentence whose members add an agent, one sentence per project it names", () => {
    handles = [];
    beyondReach = {
      named: [
        { id: "p-ops", name: "Ops", slug: "ops" },
        { id: "p-ledger", name: "Ledger", slug: "ledger" },
      ],
      unnamed: 2,
    };
    render(<AddAgentDialog conversationId="c1" room={{ shape: "group", scopeProjects: [] }} open onClose={() => {}} />);
    expect(screen.getAllByTestId("agent-beyond-reach").map((p) => p.textContent)).toEqual([
      "Ask a member of Ops to add Ops's agent; you hold the viewer role there.",
      "Ask a member of Ledger to add Ledger's agent; you hold the viewer role there.",
      "2 other projects in this organization have their own agents; you hold no role on them, so a member of each of those projects adds its agent.",
    ]);
    const empty = screen.getByTestId("agent-candidates-empty").textContent ?? "";
    const sentences = empty.split(/(?<=\.)\s*/).filter((s) => /member/.test(s));
    expect(sentences.length).toBe(3);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/a member of (Ops|Ledger|each of those projects)\b/);
    }
    expect(empty).not.toMatch(/a member of the project/);
  });

  it("counts several projects it cannot name, and says it under a list that still offers agents", () => {
    handles = [candidate("desk", "p1", "Desk")];
    beyondReach = { named: [], unnamed: 3 };
    render(<AddAgentDialog conversationId="c1" room={{ shape: "group", scopeProjects: [] }} open onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /@desk/ })).toBeTruthy();
    expect(screen.getByTestId("agent-beyond-reach").textContent).toBe(
      "3 other projects in this organization have their own agents; you hold no role on them, so a member of each of those projects adds its agent.",
    );
  });
});

// ISS-1229 r35, judge-95: the owner was offered @j95-ledger and @j95-ops, two agents that had lost their
// project roles, with nothing saying either could not answer once added.
describe("an agent that lost its role on its project", () => {
  it("is offered with the reason it cannot answer, in its room row's words, and cannot be picked", () => {
    handles = [candidate("ledger", "p-ledger", "Ledger", false), candidate("desk", "p1", "Desk")];
    render(<AddAgentDialog conversationId="c1" room={{ shape: "group", scopeProjects: [] }} open onClose={() => {}} />);
    const row = screen.getByRole("button", { name: /@ledger/ });
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(row.textContent).toContain("This agent no longer holds a role on Ledger, so it cannot answer here.");
    fireEvent.click(row);
    expect(screen.queryByRole("button", { name: "Add @ledger" })).toBeNull();
    expect((screen.getByRole("button", { name: /@desk/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

