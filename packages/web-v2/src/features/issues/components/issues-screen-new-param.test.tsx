// @vitest-environment jsdom
//
// ISS-1285 — the ⌘K palette opens New issue by pushing `?new=1` onto the Issues
// list. On the list itself Next keeps the screen mounted, so only a screen that follows the query
// after mount can answer; a mount-time read cannot. The fake router below changes the URL and
// never remounts, which is the case the screen's own mount cannot see.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo, useSyncExternalStore } from "react";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { buildWorkspaceCommands } from "@/features/shell/commands";
import { IssuesScreen } from "./issues-screen";

expect.extend(matchers);
afterEach(cleanup);

// A model of the one thing Next 16's app router does that this change stands on: `useSearchParams`
// reads the router's own URL, not `window.location`. A router push and a popstate move it; an
// outside `pushState`/`replaceState` moves it only when its state carries no `__NA` marker, which
// is what Next stamps on the entries it writes itself. After each move the router writes its URL
// back to the address bar, as Next's HistoryUpdater does.
const next = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const native = {
    push: window.history.pushState.bind(window.history),
    replace: window.history.replaceState.bind(window.history),
  };
  const state = { href: "/" };
  const commit = (href: string) => {
    state.href = href;
    native.replace({ __NA: true }, "", href);
    for (const l of listeners) l();
  };
  const here = () => `${window.location.pathname}${window.location.search}`;
  return {
    native,
    state,
    listeners,
    commit,
    here,
    router: {
      push: (href: string) => {
        native.push({ __NA: true }, "", href);
        commit(href);
      },
    },
    install() {
      window.history.pushState = (data, unused, url) => {
        native.push(data, unused, url);
        if (!data?.__NA && url != null) commit(here());
      };
      window.history.replaceState = (data, unused, url) => {
        native.replace(data, unused, url);
        if (!data?.__NA && url != null) commit(here());
      };
      window.addEventListener("popstate", onPop);
    },
    uninstall() {
      window.history.pushState = native.push;
      window.history.replaceState = native.replace;
      window.removeEventListener("popstate", onPop);
    },
  };
  function onPop() {
    const href = `${window.location.pathname}${window.location.search}`;
    state.href = href;
    for (const l of listeners) l();
  }
});
const router = next.router;

beforeAll(() => next.install());
afterAll(() => next.uninstall());

vi.mock("next/navigation", () => ({
  usePathname: () => new URL(next.state.href, "http://x").pathname,
  useRouter: () => next.router,
  useSearchParams: () => {
    const href = useSyncExternalStore(
      (onChange) => {
        next.listeners.add(onChange);
        return () => next.listeners.delete(onChange);
      },
      () => next.state.href,
    );
    return useMemo(() => new URL(href, "http://x").searchParams, [href]);
  },
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", slug: "forge-dev", role: "admin" }] }),
}));
vi.mock("./issues-list-view", () => ({ IssuesListView: () => <div data-testid="table-view" /> }));
vi.mock("./issues-board", () => ({ IssuesBoard: ({ mode }: { mode: string }) => <div data-testid="board" data-mode={mode} /> }));
vi.mock("../hooks", () => ({
  useProjectModules: () => ({ data: [{ id: "m1" }], modules: [{ id: "m1" }] }),
  useIssueStanding: () => ({ data: undefined }),
}));
// The dialog's own behaviour has its own tests; this stub keeps the two exits it hands back to
// the screen — a plain close, and the close that the real dialog makes before it routes to the
// issue it created.
vi.mock("./new-issue-dialog", () => ({
  NewIssueDialog: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? (
      <div role="dialog" aria-label="New issue form">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            onClose();
            router.push("/projects/forge-dev/issues/ISS-9");
          }}
        >
          Create
        </button>
      </div>
    ) : null,
}));

function mountAt(href: string) {
  next.native.replace({ __NA: true }, "", href);
  next.state.href = href;
  render(<IssuesScreen scope={{ projectId: "p1", slug: "forge-dev" }} />);
}

const form = () => screen.queryByRole("dialog", { name: "New issue form" });

function paletteCreateIssue() {
  const commands = buildWorkspaceCommands({
    router,
    slug: "forge-dev",
    onNewChat: () => {},
    activeProjectName: "forge-dev",
    scopedProjects: [],
    pinnedIds: new Set(),
    pinnedViews: [],
    recents: [],
    toast: () => {},
  });
  const create = commands.find((c) => c.label === "Create issue");
  const run = create?.onRun;
  if (!run) throw new Error("the palette has no runnable Create issue command");
  act(() => run());
}

it("opens the form when ?new=1 is pushed onto the mounted Issues list", () => {
  mountAt("/projects/forge-dev/issues");
  expect(form()).toBeNull();

  act(() => router.push("/projects/forge-dev/issues?new=1"));

  expect(form()).toBeInTheDocument();
});

it("opens the form when the palette's Create issue runs on the mounted Issues list", () => {
  mountAt("/projects/forge-dev/issues");
  expect(form()).toBeNull();

  paletteCreateIssue();

  expect(window.location.search).toBe("?new=1");
  expect(form()).toBeInTheDocument();
});

it("opens the form when the list mounts fresh at ?new=1, as it does from another page", () => {
  mountAt("/projects/forge-dev/issues?new=1");

  expect(form()).toBeInTheDocument();
});

it("clears new=1 on close, keeps the list's other parameters, and opens again on the next push", () => {
  mountAt("/projects/forge-dev/issues?status=open&new=1");
  expect(form()).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(form()).toBeNull();
  expect(window.location.pathname).toBe("/projects/forge-dev/issues");
  expect(window.location.search).toBe("?status=open");

  act(() => router.push("/projects/forge-dev/issues?status=open&new=1"));
  expect(form()).toBeInTheDocument();
});

it("leaves no entry that reopens the form when Back is taken from the issue just created", async () => {
  mountAt("/projects/forge-dev/issues");
  act(() => router.push("/projects/forge-dev/issues?new=1"));
  expect(form()).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  expect(window.location.pathname).toBe("/projects/forge-dev/issues/ISS-9");

  act(() => window.history.back());
  await waitFor(() => expect(window.location.pathname).toBe("/projects/forge-dev/issues"));
  expect(window.location.search).toBe("");
  expect(form()).toBeNull();
});

it("switches between the four view modes from the header, the mode held in ?group=", () => {
  mountAt("/projects/forge-dev/issues");
  const header = screen.getByTestId("view-mode-header");
  for (const name of ["Attention", "Module", "Waves", "Table"]) {
    expect(within(header).getByRole("button", { name })).toBeInTheDocument();
  }
  expect(screen.getByTestId("board").dataset.mode).toBe("attention");
  fireEvent.click(within(header).getByRole("button", { name: "Waves" }));
  expect(window.location.search).toBe("?group=waves");
  expect(screen.getByTestId("board").dataset.mode).toBe("waves");
  fireEvent.click(within(header).getByRole("button", { name: "Table" }));
  expect(screen.getByTestId("table-view")).toBeInTheDocument();
});
