// @vitest-environment jsdom
//
// ISS-1285 — the top bar and the ⌘K palette open New issue by pushing `?new=1` onto the Issues
// list. On the list itself Next keeps the screen mounted, so only a screen that follows the query
// after mount can answer; a mount-time read cannot. The fake router below changes the URL and
// never remounts, which is the case the screen's own mount cannot see.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useSyncExternalStore } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildWorkspaceCommands } from "@/features/shell/commands";
import { IssuesScreen } from "./issues-screen";

expect.extend(matchers);
afterEach(() => {
  cleanup();
  next.replaced.length = 0;
  next.list.drawn = 0;
});

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
  /** Each replace the router was asked for, with how many times the list had drawn by then. */
  const replaced: { href: string; drawn: number }[] = [];
  const list = { drawn: 0 };
  const commit = (href: string) => {
    state.href = href;
    native.replace({ __NA: true }, "", href);
    for (const l of listeners) l();
  };
  const here = () => `${window.location.pathname}${window.location.search}`;
  return {
    native,
    state,
    replaced,
    list,
    listeners,
    commit,
    here,
    router: {
      push: (href: string) => {
        native.push({ __NA: true }, "", href);
        commit(href);
      },
      replace: (href: string) => {
        replaced.push({ href, drawn: list.drawn });
        native.replace({ __NA: true }, "", href);
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

vi.mock("./issues-list-view", () => ({
  IssuesListView: () => {
    next.list.drawn += 1;
    return <div data-testid="issues-list" />;
  },
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

it("opens the form when the top bar pushes ?new=1 onto the mounted Issues list", () => {
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
  mountAt("/projects/forge-dev/issues?filter=awaiting_release&new=1");
  expect(form()).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(form()).toBeNull();
  expect(window.location.pathname).toBe("/projects/forge-dev/issues");
  expect(window.location.search).toBe("?filter=awaiting_release");

  act(() => router.push("/projects/forge-dev/issues?filter=awaiting_release&new=1"));
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

// ISS-1154 — the Issues screen has no tabs, and an old `?tab=` link goes where its content lives now.
// The router model above is Next's: `replace` moves `useSearchParams`, a same-route
// `replaceState` of an entry Next wrote does not, which is why the screen reads the address bar.
describe("an old ?tab= link", () => {
  const list = () => screen.queryByTestId("issues-list");

  it("drops ?tab=board and shows the list, which holds the states the board drew (ISS-1228)", () => {
    mountAt("/projects/forge-dev/issues?tab=board&q=crash");

    expect(window.location.pathname).toBe("/projects/forge-dev/issues");
    expect(window.location.search).toBe("?q=crash");
    expect(list()).toBeInTheDocument();
  });

  it("sends ?tab=insights to the project dashboard", () => {
    mountAt("/projects/forge-dev/issues?tab=insights");

    expect(next.replaced).toEqual([{ href: "/projects/forge-dev", drawn: 0 }]);
  });

  it("opens the list grouped by module for ?tab=modules, over a groupBy, keeping q", () => {
    mountAt("/projects/forge-dev/issues?tab=modules&groupBy=priority&q=crash");

    expect(window.location.pathname).toBe("/projects/forge-dev/issues");
    expect(new URLSearchParams(window.location.search).get("groupBy")).toBe("module");
    expect(new URLSearchParams(window.location.search).get("q")).toBe("crash");
    expect(window.location.search).not.toContain("tab=");
    expect(list()).toBeInTheDocument();
  });

  it("drops the parameter for ?tab=list and shows the list", () => {
    mountAt("/projects/forge-dev/issues?tab=list&module=m1");

    expect(window.location.search).toBe("?module=m1");
    expect(list()).toBeInTheDocument();
  });

  it("keeps the list and names a tab the screen never had", () => {
    mountAt("/projects/forge-dev/issues?tab=nope");

    expect(list()).toBeInTheDocument();
    expect(screen.getByTestId("unknown-tab-line")).toHaveTextContent("nope");
    expect(window.location.search).toBe("?tab=nope");
  });

  it("says nothing for a link with no tab", () => {
    mountAt("/projects/forge-dev/issues");

    expect(list()).toBeInTheDocument();
    expect(screen.queryByTestId("unknown-tab-line")).toBeNull();
  });
});
