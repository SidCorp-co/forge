// @vitest-environment jsdom
//
// ISS-1229 r14, judge-35: Needs you's stuck overflow linked to an unfiltered Issues list that marks
// nothing as stuck, so the sixth stuck issue could not be found. `?stuck=1` reaches the search as
// `stuck`, the list says it is showing only those, and a value it does not take is named.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuesListView } from "./components/issues-list-view";
import { ToastProvider } from "@/providers/toast-provider";
import type { IssueSearchOpts } from "./types";

expect.extend(matchers);
afterEach(cleanup);
Element.prototype.scrollIntoView = vi.fn();


let capturedOpts: IssueSearchOpts | undefined;

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/forge-dev/issues",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/shell", async () => {
  const actual = await vi.importActual<typeof import("@/features/shell")>("@/features/shell");
  return { ...actual, usePinnedViews: () => ({ isPinned: () => false, toggle: vi.fn(), remove: vi.fn() }) };
});
vi.mock("./hooks", async () => {
  const actual = await vi.importActual<typeof import("./hooks")>("./hooks");
  return {
    ...actual,
    useIssues: (_p: string, opts: IssueSearchOpts) => {
      capturedOpts = opts;
      return { data: { items: [], totalCount: 0 }, isLoading: false, isError: false, error: null, refetch: vi.fn() };
    },
    useProjectMembers: () => ({ data: [] }),
    useProjectLabels: () => ({ data: [] }),
    useProjectModules: () => ({ modules: [], data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    usePatchIssue: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

function mountAt(query: string) {
  window.history.replaceState({}, "", `/projects/forge-dev/issues${query}`);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <IssuesListView scope={{ projectId: "p1", slug: "forge-dev" }} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  capturedOpts = undefined;
});

describe("Issues list · the stuck issues", () => {
  it("sends `?stuck=1` to the search as `stuck` and says only the stuck issues are shown", () => {
    mountAt("?stuck=1");
    expect(capturedOpts?.stuck).toBe(true);
    expect(screen.getByTestId("stuck-filter-line")).toHaveTextContent(
      "Only the issues reported stuck are shown",
    );
    expect(screen.getByRole("button", { name: "Show every issue" })).toBeInTheDocument();
  });

  it("sends no stuck filter where the link names none", () => {
    mountAt("");
    expect(capturedOpts?.stuck).toBe(false);
    expect(screen.queryByTestId("stuck-filter-line")).toBeNull();
  });

  it("names a stuck value it does not take and shows every issue", () => {
    mountAt("?stuck=yes");
    expect(capturedOpts?.stuck).toBe(false);
    expect(screen.getByTestId("stuck-filter-line")).toHaveTextContent("stuck=yes");
  });
});
