// @vitest-environment jsdom
//
// ISS-1229 r49, judge-146: one failed projects read showed in three places on Settings -> Agents, each
// with its own Retry, and pressing one left the others failed: each Retry read only its own query.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const list = vi.hoisted(() => ({ fail: true, reads: { projects: 0, all: 0 } }));

vi.mock("./api", () => ({
  projectApi: {
    list: async (opts?: { includeArchived?: boolean }) => {
      if (opts?.includeArchived) list.reads.all += 1;
      else list.reads.projects += 1;
      if (list.fail) throw new Error("The server is down.");
      return [{ id: "p1", slug: "desk", name: "Desk", orgId: "o1" }];
    },
  },
}));
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrgId: "o1" }) }));

const { useProjects, useProjectsIncludingArchived, useRetryProjects } = await import("./hooks");

afterEach(cleanup);

function Places() {
  const live = useProjects();
  const all = useProjectsIncludingArchived();
  const retry = useRetryProjects();
  return (
    <div>
      <p data-testid="rail">{live.isError ? "Projects not loaded" : `${live.data?.length ?? 0} projects`}</p>
      <p data-testid="agents">{all.isError ? "Couldn't load your projects" : `${all.data?.length ?? 0} named`}</p>
      <button type="button" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

function withClient(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("a Retry on a failed projects read", () => {
  it("reads it again for every place showing that failure", async () => {
    list.fail = true;
    render(withClient(<Places />));
    await screen.findByText("Projects not loaded");
    await screen.findByText("Couldn't load your projects");
    const before = { ...list.reads };

    list.fail = false;
    await act(async () => {
      screen.getByRole("button", { name: "Retry" }).click();
    });

    await screen.findByText("1 projects");
    await screen.findByText("1 named");
    expect(list.reads.projects).toBe(before.projects + 1);
    expect(list.reads.all).toBe(before.all + 1);
  });
});
