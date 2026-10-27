// @vitest-environment jsdom
//
// ISS-1229 r21, the coordinator's amended ruling: a picker is where a member chooses an identity, so
// the creator filter offers each member by name, else "A member", with their address as
// secondary text — two members with no display name can be told apart there.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
import { IssuesListView } from "./issues-list-view";
import type { ProjectMember } from "../types";

afterEach(cleanup);
Element.prototype.scrollIntoView = vi.fn();

const member = (userId: string, email: string, displayName: string | null): ProjectMember => ({
  userId,
  email,
  displayName,
  kind: "human",
  role: "member",
  createdAt: "2026-09-01T00:00:00.000Z",
});

const MEMBERS = [
  member("u1", "lan.pham@example.com", null),
  member("u2", "kim@example.com", "kim@example.com"),
  member("u3", "mai.tran@example.com", "Mai Tran"),
];

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/forge-dev/issues",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/shell", async () => {
  const actual = await vi.importActual<typeof import("@/features/shell")>("@/features/shell");
  return { ...actual, usePinnedViews: () => ({ isPinned: () => false, toggle: vi.fn(), remove: vi.fn() }) };
});
vi.mock("./release-gate-panel", () => ({ ReleaseGatePanel: () => null }));
vi.mock("../hooks", async () => {
  const actual = await vi.importActual<typeof import("../hooks")>("../hooks");
  return {
    ...actual,
    useIssues: () => ({ data: { items: [], totalCount: 0 }, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    useModuleRollup: () => ({ data: undefined, isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    useProjectMembers: () => ({ data: MEMBERS }),
    useProjectLabels: () => ({ data: [] }),
    useProjectModules: () => ({ modules: [], data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    usePatchIssue: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

describe("the issue list's creator filter", () => {
  it("offers two members with no display name as A member, each beside their own address", () => {
    window.history.replaceState({}, "", "/projects/forge-dev/issues");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ToastProvider>
          <IssuesListView scope={{ projectId: "p1", slug: "forge-dev" }} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Creator filter" }));
    const offered = screen.getAllByRole("option").map((o) =>
      [o.querySelector("[data-option-label]"), o.querySelector("[data-option-detail]")]
        .map((n) => n?.textContent ?? "")
        .join(" · "),
    );
    expect(offered).toEqual([
      "Creator: anyone · ",
      "Creator: any agent · ",
      "A member · lan.pham@example.com",
      "A member · kim@example.com",
      "Mai Tran · mai.tran@example.com",
    ]);
  });
});
