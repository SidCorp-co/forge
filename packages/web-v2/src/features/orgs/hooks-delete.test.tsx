// @vitest-environment jsdom
//
// ISS-1229 r23 — deleting an organization refetched its own members, projects and invitations into
// three 404s: the list's key ["orgs"] is a prefix of every per-organization read.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const list = vi.fn(async () => []);
const listMembers = vi.fn(async () => []);
vi.mock("./api", () => ({
  orgsApi: {
    list,
    remove: vi.fn(async () => undefined),
    listMembers,
  },
}));

const { useDeleteOrg, useOrgMembers, useOrgs } = await import("./hooks");

afterEach(cleanup);

function harness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

describe("deleting an organization", () => {
  it("refreshes the organization list and never asks again for the deleted one's members", async () => {
    const { wrapper } = harness();
    const { result } = renderHook(
      () => ({ orgs: useOrgs(), members: useOrgMembers("o1"), remove: useDeleteOrg() }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.members.isSuccess).toBe(true));
    const [listed, asked] = [list.mock.calls.length, listMembers.mock.calls.length];

    await act(() => result.current.remove.mutateAsync("o1"));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(listed + 1));
    expect(listMembers).toHaveBeenCalledTimes(asked);
  });
});
