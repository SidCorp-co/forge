// @vitest-environment jsdom
//
// ISS-1229 r48: with the project's members or labels unread, the Creator and Label filters offered only
// "anyone" and "any", as if the project held nobody and no label. The failed read is said, with Retry.
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";

expect.extend(matchers);

const reads = vi.hoisted(() => ({ membersFail: false, labelsFail: false, readMembers: vi.fn(), readLabels: vi.fn() }));
const down = new Error("The server is down.");

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
    useProjectMembers: () =>
      reads.membersFail
        ? { data: undefined, isError: true, error: down, refetch: reads.readMembers }
        : { data: [], isError: false, error: null, refetch: reads.readMembers },
    useProjectLabels: () =>
      reads.labelsFail
        ? { data: undefined, isError: true, error: down, refetch: reads.readLabels }
        : { data: [], isError: false, error: null, refetch: reads.readLabels },
    useProjectModules: () => ({ modules: [], data: [], isLoading: false, isError: false, error: null, refetch: vi.fn() }),
    usePatchIssue: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

const { IssuesListView } = await import("./issues-list-view");

function mount() {
  window.history.replaceState({}, "", "/projects/forge-dev/issues");
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
  reads.membersFail = false;
  reads.labelsFail = false;
  reads.readMembers.mockClear();
  reads.readLabels.mockClear();
});
afterEach(cleanup);

describe("the issue list's filters whose choices could not be read", () => {
  it("say the people the Creator filter offers could not be loaded, and Retry reads them again", () => {
    reads.membersFail = true;
    mount();
    const failure = screen.getByTestId("filters-unread");
    expect(failure).toHaveTextContent("Couldn't load the people the Creator filter offers. The server is down.");
    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(reads.readMembers).toHaveBeenCalledTimes(1);
  });

  it("say the labels the Label filter offers could not be loaded, and Retry reads them again", () => {
    reads.labelsFail = true;
    mount();
    const failure = screen.getByTestId("filters-unread");
    expect(failure).toHaveTextContent("Couldn't load the labels the Label filter offers. The server is down.");
    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(reads.readLabels).toHaveBeenCalledTimes(1);
  });

  it("say nothing of the kind while both are read", () => {
    mount();
    expect(screen.queryByTestId("filters-unread")).toBeNull();
  });
});
