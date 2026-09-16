// @vitest-environment jsdom
//
// ISS-1040 — the all-projects Conversations screen, wired to both sets.
//
// Every row in this screen's sidebar offered Archive and archiving worked: the
// room left the list. Nothing here could then ask for the other set, because
// `useConversationsAcrossProjects` took no `archived` argument and hard-coded
// the trailing `"live"` key segment — so a room archived from `/conversations`
// could be neither seen nor brought back from `/conversations`.
//
// These cases run the REAL hooks over a mocked `../api`, because the defect was
// never in a component: it was in what the screen asked the network for. A test
// that mocked `../hooks` would assert the wiring against a double of the very
// thing that was wrong.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const list = vi.fn();
const setArchived = vi.fn();
const rename = vi.fn();
const remove = vi.fn();

vi.mock("../api", () => ({
  conversationsApi: {
    list: (...a: unknown[]) => list(...a),
    setArchived: (...a: unknown[]) => setArchived(...a),
    rename: (...a: unknown[]) => rename(...a),
    remove: (...a: unknown[]) => remove(...a),
  },
}));

const projects = [
  { id: "p1", name: "Alpha", slug: "alpha" },
  { id: "p2", name: "Beta", slug: "beta" },
];
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: projects, isLoading: false, error: null }),
  useOrgScopedProjects: () => ({
    projects,
    projectIds: new Set(projects.map((p) => p.id)),
    projectSlugs: new Set(projects.map((p) => p.slug)),
    activeOrgId: "o1",
    isLoading: false,
    error: null,
  }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./conversation-chat", () => ({ ConversationChat: () => <div data-testid="chat" /> }));
vi.mock("./start-conversation", () => ({ StartConversation: () => <div data-testid="start" /> }));

const { ConversationsScreen } = await import("./conversations-screen");

const ROOMS = [
  { id: "c1", projectId: "p1", title: "Release plan", updatedAt: "2026-09-14T03:00:00.000Z" },
  { id: "c2", projectId: "p2", title: "Runner budget", updatedAt: "2026-09-14T02:00:00.000Z" },
  { id: "c3", projectId: "p1", title: "Old migration", updatedAt: "2026-09-14T01:00:00.000Z" },
];

/** What the server would call archived right now — the unarchive mutation moves a room out of it. */
let archivedIds: Set<string>;

afterEach(cleanup);

beforeEach(() => {
  for (const m of [list, setArchived, rename, remove]) m.mockReset();
  archivedIds = new Set(["c3"]);
  // cm:guard the mock branches on the ARCHIVED argument, for the reason `conversation-panel.test.tsx`
  // gives over the same two reads: a mock answering one set for every call would let a screen that
  // never sends the flag still look like its toggle worked.
  list.mockImplementation(async (projectId: string, _pageSize: number, wantArchived: boolean) => {
    const items = ROOMS.filter(
      (r) => r.projectId === projectId && archivedIds.has(r.id) === wantArchived,
    ).map((r) => ({
      id: r.id,
      adapter: "web",
      externalId: `v-${r.id}`,
      shape: "direct", mode: null,
      title: r.title,
      updatedAt: r.updatedAt,
      archivedAt: archivedIds.has(r.id) ? "2026-09-10T00:00:00.000Z" : null,
    }));
    return { items, total: items.length };
  });
  setArchived.mockImplementation(async (id: string, archived: boolean) => {
    if (archived) archivedIds.add(id);
    else archivedIds.delete(id);
    return { id, archivedAt: archived ? "2026-09-10T00:00:00.000Z" : null };
  });
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConversationsScreen />
    </QueryClientProvider>,
  );
}

const opener = (title: string, project: string) => `Open ${title} in ${project}`;
const railToggle = () => screen.getAllByRole("button", { name: "Archived" })[0] as HTMLElement;

describe("ConversationsScreen · the archived set is reachable from the screen that files into it", () => {
  it("shows the live rooms of every org-scoped project, and none of the archived ones", async () => {
    mount();
    expect(await screen.findByRole("button", { name: opener("Release plan", "Alpha") })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: opener("Runner budget", "Beta") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: opener("Old migration", "Alpha") })).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledWith("p1", 50, false);
    expect(list).toHaveBeenCalledWith("p2", 50, false);
    expect(list).not.toHaveBeenCalledWith("p1", 50, true);
  });

  it("asks every project for its archived rooms once the toggle is pressed, and lists them", async () => {
    mount();
    await screen.findByRole("button", { name: opener("Release plan", "Alpha") });

    fireEvent.click(railToggle());

    expect(await screen.findByRole("button", { name: opener("Old migration", "Alpha") })).toBeInTheDocument();
    expect(list).toHaveBeenCalledWith("p1", 50, true);
    expect(list).toHaveBeenCalledWith("p2", 50, true);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: opener("Release plan", "Alpha") })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Archived conversations")).toBeInTheDocument();
  });

  it("renders a room the archived side returned with Unarchive rather than Archive", async () => {
    mount();
    await screen.findByRole("button", { name: opener("Release plan", "Alpha") });
    fireEvent.click(railToggle());

    expect(await screen.findByRole("button", { name: "Unarchive Old migration" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Archive Old migration" })).not.toBeInTheDocument();
  });

  // cm:guard the person is asserted to STAY on the archived side: bringing a room back is not a
  // request to leave the list somebody is working through, and a screen that jumped to the live set
  // on each unarchive would lose their place after the first one.
  it("brings a room back, leaves the person where they were, and lists it live when they switch back", async () => {
    mount();
    await screen.findByRole("button", { name: opener("Release plan", "Alpha") });
    fireEvent.click(railToggle());
    fireEvent.click(await screen.findByRole("button", { name: "Unarchive Old migration" }));

    await waitFor(() => expect(setArchived).toHaveBeenCalledWith("c3", false));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: opener("Old migration", "Alpha") })).not.toBeInTheDocument(),
    );
    expect(railToggle()).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Nothing archived")).toBeInTheDocument();

    fireEvent.click(railToggle());
    expect(await screen.findByRole("button", { name: opener("Old migration", "Alpha") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Archive Old migration" })).toBeInTheDocument();
  });

  // cm:guard the two mounts are asserted to agree: the rail and the mobile drawer render the same
  // component, and a toggle each of them owned would leave the drawer on the live rooms while the
  // rail behind it showed the archived ones — one screen disagreeing with itself.
  it("opens the mobile drawer on the same set the rail is showing", async () => {
    mount();
    await screen.findByRole("button", { name: opener("Release plan", "Alpha") });
    fireEvent.click(railToggle());
    await screen.findByRole("button", { name: opener("Old migration", "Alpha") });

    fireEvent.click(screen.getByRole("button", { name: "Conversation history" }));

    const toggles = screen.getAllByRole("button", { name: "Archived" });
    expect(toggles).toHaveLength(2);
    for (const t of toggles) expect(t).toHaveAttribute("aria-pressed", "true");
    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByRole("button", { name: opener("Old migration", "Alpha") })).toBeInTheDocument();
    expect(within(drawer).queryByRole("button", { name: opener("Release plan", "Alpha") })).not.toBeInTheDocument();
  });
});
