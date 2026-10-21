// @vitest-environment jsdom
//
// ISS-1229 r29, the master's ruling: after adding @retired was refused because its project had been
// deleted, the panel kept offering "Add @retired", which could only be refused again.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { AddAgentDialog } from "./add-agent-dialog";

const candidate = (handle: string, projectId: string, name: string) => ({
  userId: `u-${handle}`,
  handle,
  project: { id: projectId, name, slug: handle },
  losesReaders: [],
});
const refetch = vi.fn();
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
    data: { people: [], handles: [candidate("retired", "p-gone", "Retired"), candidate("desk", "p1", "Desk")] },
  }),
  useAddHandle: () => add,
}));

afterEach(cleanup);

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
});
