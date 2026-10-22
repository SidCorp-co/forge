// @vitest-environment jsdom
//
// ISS-1229 r25, judge-72: the room starter listed the reader themself among the people to add, as a
// second "Another member" beside the one who really was. The opener is in the room by opening it, so
// they are listed once, as "You", and never offered to themself.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationCandidates } from "../types";

let candidates: ConversationCandidates = {
  people: [],
  handles: [],
  beyondReach: { named: [], unnamed: 0 },
};

vi.mock("@/providers/auth-provider", () => ({ useAuth: () => ({ user: { id: "me" } }) }));
let loading = false;
let projects: Array<{ id: string; name: string; slug: string; role: string | null }> = [
  { id: "p1", name: "Billing", slug: "billing", role: "member" },
];
vi.mock("@/features/projects/hooks", () => ({
  useOrgScopedProjects: () => ({ projects, isLoading: loading }),
}));
let openers: Array<{ projectId: string; handle: string; reachable: boolean }> = [];
let openersLoading = false;
vi.mock("../hooks", () => ({
  useProjectCandidates: () => ({ data: candidates, isLoading: false, isError: false }),
  useOpenConversation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useRoomOpeners: () => ({ data: { openers }, isLoading: openersLoading }),
}));

const { StartConversation } = await import("./start-conversation");

afterEach(() => {
  cleanup();
  loading = false;
  openers = [];
  openersLoading = false;
});
// jsdom lays nothing out, and the project picker scrolls its chosen option into view.
Element.prototype.scrollIntoView = () => {};

function pickTheProject() {
  render(<StartConversation onStarted={vi.fn()} />);
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(screen.getByRole("option", { name: "Billing" }));
}

describe("the people a room starts with", () => {
  it('lists the reader once, as "You", and another unnamed member as another member', () => {
    candidates = {
      people: [
        { userId: "me", displayName: null, email: "me@example.com", addedAt: "2026-10-01T09:00:00.000Z" },
        { userId: "u2", displayName: null, email: "mai@example.com", addedAt: "2026-10-02T09:00:00.000Z" },
      ],
      handles: [],
      beyondReach: { named: [], unnamed: 0 },
    };
    pickTheProject();
    const labels = [...document.querySelectorAll("[data-person-label]")].map((l) => l.textContent);
    expect(labels).toEqual(["You", "Another member"]);
    expect(screen.queryByText("me@example.com")).toBeNull();
  });

  // ISS-1229 r28, judge-80: the people offered followed address order, so an unnamed person joined
  // last could lead the list and a named one trail it.
  it("offers the named by name, then the unnamed by when each joined", () => {
    candidates = {
      people: [
        { userId: "u-late", displayName: null, email: "a-late@example.com", addedAt: "2026-10-03T09:00:00.000Z" },
        { userId: "u-zed", displayName: "Zed", email: "b-zed@example.com", addedAt: "2026-10-04T09:00:00.000Z" },
        { userId: "u-early", displayName: null, email: "c-early@example.com", addedAt: "2026-10-01T09:00:00.000Z" },
        { userId: "u-an", displayName: "An", email: "d-an@example.com", addedAt: "2026-10-05T09:00:00.000Z" },
      ],
      handles: [],
      beyondReach: { named: [], unnamed: 0 },
    };
    pickTheProject();
    const offered = [...document.querySelectorAll("[data-person-detail]")].map((l) => l.textContent);
    expect(offered).toEqual(["d-an@example.com", "b-zed@example.com", "c-early@example.com", "a-late@example.com"]);
    const labels = [...document.querySelectorAll("[data-person-label]")].map((l) => l.textContent);
    expect(labels[0]).toBe("You");
  });
});

// ISS-1229 r35, judge-95: a viewer of Ops was offered Ops, then three steps later refused "Not a
// project member." A conversation is started only on a project the reader holds the member role on.
describe("the projects a room can be started in", () => {
  const offered = () => screen.queryAllByRole("option").map((o) => o.textContent);

  it("offers only projects the reader holds the member role or above on", () => {
    projects = [
      { id: "p1", name: "Billing", slug: "billing", role: "member" },
      { id: "p2", name: "Ops", slug: "ops", role: "viewer" },
      { id: "p3", name: "Desk", slug: "desk", role: "admin" },
      { id: "p4", name: "Vault", slug: "vault", role: null },
    ];
    render(<StartConversation onStarted={vi.fn()} />);
    fireEvent.click(screen.getByRole("combobox"));
    expect(offered()).toEqual(["Billing", "Desk"]);
  });

  // The coordinator on PR #1151: the heading "Start a conversation" over that line was itself the
  // invitation nobody could act on.
  it("says to a reader who only views projects what they can do, and nothing of starting one", () => {
    projects = [
      { id: "p2", name: "Ops", slug: "ops", role: "viewer" },
      { id: "p5", name: "Archive", slug: "archive", role: "viewer" },
    ];
    const { container } = render(<StartConversation onStarted={vi.fn()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Conversations you can read")).toBeTruthy();
    expect(
      screen.getByText("You hold the viewer role on every project here, so their conversations are yours to read from the list."),
    ).toBeTruthy();
    expect(container.textContent).not.toMatch(/start/i);
  });

  it("offers nothing, and says nothing of starting, while the reader's projects are read", () => {
    projects = [{ id: "p2", name: "Ops", slug: "ops", role: "viewer" }];
    loading = true;
    const { container } = render(<StartConversation onStarted={vi.fn()} />);
    expect(screen.getByTestId("start-loading")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(container.textContent).not.toMatch(/start/i);
  });

  it("tells a reader who can see no project that there is none, offering no picker", () => {
    projects = [];
    const { container } = render(<StartConversation onStarted={vi.fn()} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("No project here yet")).toBeTruthy();
    expect(container.textContent).not.toMatch(/start|pick a project/i);
  });
});

// ISS-1229 r35, judge-95: an agent whose project role was taken away was offered to a new room unmarked.
describe("an agent offered to a new room that lost its role on its project", () => {
  it("says why it cannot answer and cannot be ticked", () => {
    projects = [{ id: "p1", name: "Billing", slug: "billing", role: "member" }];
    candidates = {
      people: [],
      handles: [
        { userId: "u-ledger", handle: "ledger", project: { id: "p9", name: "Ledger", slug: "ledger" }, losesReaders: [], reachable: false },
      ],
      beyondReach: { named: [], unnamed: 0 },
    };
    pickTheProject();
    expect(screen.getByText("This agent no longer holds a role on Ledger, so it cannot answer here.")).toBeTruthy();
    const tick = screen.getByRole("checkbox", { name: /@ledger/ });
    expect(tick.hasAttribute("disabled") || tick.getAttribute("aria-disabled") === "true").toBe(true);
  });
});


// ISS-1229 r36, judge-97: the Project picker offered Ledger, whose own agent had lost its role there, with
// nothing marked; the agent was picked and confirmed and only Open the room was refused 409.
describe("a project whose own agent lost its role there", () => {
  it("is offered marked with its agent and the reason its row gives, and cannot be picked", () => {
    projects = [
      { id: "p1", name: "Billing", slug: "billing", role: "member" },
      { id: "p9", name: "Ledger", slug: "ledger", role: "admin" },
    ];
    openers = [
      { projectId: "p1", handle: "billing", reachable: true },
      { projectId: "p9", handle: "ledger", reachable: false },
    ];
    render(<StartConversation onStarted={vi.fn()} />);
    fireEvent.click(screen.getByRole("combobox"));
    const ledger = screen.getByRole("option", { name: /Ledger/ });
    expect(ledger.getAttribute("aria-disabled")).toBe("true");
    expect(ledger.textContent).toContain(
      "@ledger can't answer. This agent no longer holds a role on Ledger, so it cannot answer here.",
    );
    // r36 after-shot at 390: break-all split the reason mid-word ("on L / edger").
    const detail = ledger.querySelector("[data-option-detail]") as HTMLElement;
    expect(detail.className).not.toMatch(/break-all/);
    expect(detail.className).toMatch(/overflow-wrap:anywhere/);
    fireEvent.click(ledger);
    expect(screen.queryByText("The room starts with this project's own agent, and is about this project.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start the room" })).toBeNull();
    const billing = screen.getByRole("option", { name: "Billing" });
    expect(billing.getAttribute("aria-disabled")).toBeNull();
  });

  it("offers no project while whose agent can answer is still being read", () => {
    openersLoading = true;
    render(<StartConversation onStarted={vi.fn()} />);
    expect(screen.getByTestId("start-loading")).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
