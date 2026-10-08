// @vitest-environment jsdom
//
// ISS-1156 — the strip is a partition. Each segment is one work state, the counts on the six add up
// to the count on All, Findings is a Source filter that narrows every count, and a link naming a
// segment the strip no longer has is said so rather than shown as an empty or mislabelled list.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORK_STATE_LABELS, WORK_STATES } from "@forge/contracts/work-state";
import { ToastProvider } from "@/providers/toast-provider";
import { IssuesListView } from "./components/issues-list-view";
import type { IssueSearchOpts } from "./types";

expect.extend(matchers);
afterEach(cleanup);
Element.prototype.scrollIntoView = vi.fn();

const BY_WORK_STATE = {
  open: 56,
  in_flight: 11,
  awaiting_release: 1,
  blocked_on_person: 4,
  draft: 24,
  finished: 1306,
};

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
      return {
        data: {
          items: [],
          totalCount: 0,
          extra: { buckets: { byStatus: {}, byWorkState: BY_WORK_STATE } },
        },
        isLoading: false,
        isError: false,
        error: null,
        refetch: vi.fn(),
      };
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

const escaped = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The segment's button, found by its word, with the count it prints. */
function segment(word: string): { button: HTMLElement; count: number } {
  const button = screen.getByRole("button", { name: new RegExp(`^${escaped(word)}\\s*\\d`) });
  const figure = within(button).getByText(/^\d+\+?$/);
  return { button, count: Number(figure.textContent?.replace("+", "")) };
}

describe("the Issues strip", () => {
  it("offers one segment per work state, in the state's own words, and All", () => {
    mountAt("");
    for (const state of WORK_STATES) {
      expect(segment(WORK_STATE_LABELS[state]).button).toBeInTheDocument();
    }
    expect(segment("All").button).toBeInTheDocument();
  });

  it("offers no segment for a retired tab or for Findings", () => {
    mountAt("");
    for (const gone of ["Needs you", "With agent", "Findings"]) {
      expect(screen.queryByRole("button", { name: new RegExp(`^${gone}`) })).toBeNull();
    }
  });

  it("prints each segment's own state's count, and the six add up to All", () => {
    mountAt("");
    const counts = WORK_STATES.map((s) => segment(WORK_STATE_LABELS[s]).count);
    expect(counts).toEqual(WORK_STATES.map((s) => BY_WORK_STATE[s]));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(segment("All").count);
  });

  it("asks the search for the segment's state, and for nothing under All", () => {
    mountAt("?filter=blocked_on_person");
    expect(capturedOpts?.filter).toBe("blocked_on_person");
    cleanup();
    mountAt("");
    expect(capturedOpts?.filter).toBe("all");
  });

  // The counts are narrowed by the status in the link, so a segment that kept reading its count
  // after choosing it would have to keep the status too: the figure is the list it opens.
  it("keeps a status filter when another segment is chosen, so the count the segment printed is the list it opens", () => {
    mountAt("?filter=finished&status=closed");
    expect(capturedOpts?.status).toEqual(["closed"]);
    fireEvent.click(segment(WORK_STATE_LABELS.in_flight).button);
    const params = new URLSearchParams(window.location.search);
    expect(params.get("filter")).toBe("in_flight");
    expect(params.get("status")).toBe("closed");
  });

  it("keeps a status filter when All is chosen", () => {
    mountAt("?filter=in_flight&status=in_progress");
    fireEvent.click(segment("All").button);
    const params = new URLSearchParams(window.location.search);
    expect(params.has("filter")).toBe(false);
    expect(params.get("status")).toBe("in_progress");
  });

  it("moves the list to a state when its segment is chosen", () => {
    mountAt("");
    fireEvent.click(segment(WORK_STATE_LABELS.in_flight).button);
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("in_flight");
  });
});

describe("Findings is a Source filter, not a segment", () => {
  it("sends the machine-filed source to the search beside whichever segment is chosen", () => {
    mountAt("?filter=draft&origin=detector");
    expect(capturedOpts?.origin).toBe("detector");
    expect(capturedOpts?.filter).toBe("draft");
  });

  it("sends no source when none is chosen, and ignores one that is not a source", () => {
    mountAt("?origin=bogus");
    expect(capturedOpts?.origin).toBeUndefined();
  });

  it("names a source the filter does not offer, as it names a segment the strip does not have", () => {
    mountAt("?origin=bogus");
    expect(screen.getByTestId("unknown-origin-line")).toHaveTextContent("bogus");
    expect(screen.getByTestId("unknown-origin-line")).toHaveTextContent("every source");
  });

  it("says nothing for a source it offers", () => {
    mountAt("?origin=detector");
    expect(screen.queryByTestId("unknown-origin-line")).toBeNull();
    expect(screen.queryByTestId("dropped-origin-line")).toBeNull();
  });

  it("applies the first of a repeated source and names the ones it leaves out", () => {
    mountAt("?origin=detector&origin=human&origin=agent");
    expect(capturedOpts?.origin).toBe("detector");
    const line = screen.getByTestId("dropped-origin-line");
    expect(line).toHaveTextContent("detector");
    expect(line).toHaveTextContent("human, agent");
    expect(line).toHaveTextContent("are left out");
  });

  it("says nothing for a source repeated as the same value", () => {
    mountAt("?origin=detector&origin=detector");
    expect(capturedOpts?.origin).toBe("detector");
    expect(screen.queryByTestId("dropped-origin-line")).toBeNull();
  });

  it("names a source dropped behind an empty one, since no source is then applied", () => {
    mountAt("?origin=&origin=detector");
    expect(capturedOpts?.origin).toBeUndefined();
    expect(screen.getByTestId("dropped-origin-line")).toHaveTextContent("no source");
    expect(screen.getByTestId("dropped-origin-line")).toHaveTextContent("detector");
  });

  it("offers the source as a filter of its own", () => {
    mountAt("");
    expect(screen.getAllByLabelText("Source filter").length).toBeGreaterThan(0);
  });
});

describe("a link naming a segment the strip does not have", () => {
  it.each(["you", "agent", "findings", "done"])("shows every issue and names %s", (gone) => {
    mountAt(`?filter=${gone}`);
    expect(capturedOpts?.filter).toBe("all");
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent(gone);
    expect(note).toHaveTextContent("every issue is shown");
  });

  it("says nothing for a segment the strip has", () => {
    mountAt("?filter=finished");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("a status filter in the link", () => {
  it("says a status filter is on, names it, and says the counts are for those issues", () => {
    mountAt("?status=in_progress");
    const line = screen.getByTestId("status-filter-line");
    expect(line).toHaveTextContent("A status filter is on: In progress");
    expect(line).toHaveTextContent("counts above are for those issues only");
  });

  it("names every status it was given", () => {
    mountAt("?filter=finished&status=closed,dropped");
    expect(screen.getByTestId("status-filter-line")).toHaveTextContent("Closed, Dropped");
  });

  it("applies every value of a repeated status parameter and names each", () => {
    mountAt("?status=open&status=closed");
    expect(capturedOpts?.status).toEqual(["open", "closed"]);
    expect(screen.getByTestId("status-filter-line")).toHaveTextContent("Open, Closed");
  });

  it("names a status the lifecycle does not have instead of dropping it", () => {
    mountAt("?status=open&status=banana");
    expect(capturedOpts?.status).toEqual(["open"]);
    const line = screen.getByTestId("unknown-status-line");
    expect(line).toHaveTextContent("banana");
    expect(line).toHaveTextContent("only the statuses named below are applied");
  });

  it("says no status filter is applied when every word named is unknown", () => {
    mountAt("?status=banana");
    expect(capturedOpts?.status).toBeUndefined();
    expect(screen.getByTestId("unknown-status-line")).toHaveTextContent("no status filter is applied");
    expect(screen.queryByTestId("status-filter-line")).toBeNull();
  });

  it("clears the status and keeps the segment, so the counts widen back to the whole project", () => {
    mountAt("?filter=finished&status=closed");
    fireEvent.click(screen.getByRole("button", { name: "Clear the status filter" }));
    const params = new URLSearchParams(window.location.search);
    expect(params.has("status")).toBe(false);
    expect(params.get("filter")).toBe("finished");
  });

  it("says nothing when no status is named", () => {
    mountAt("?filter=finished");
    expect(screen.queryByTestId("status-filter-line")).toBeNull();
  });
});
