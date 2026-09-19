// @vitest-environment jsdom
//
// ISS-1093 — the pair screen's agent picker.
//
// What this file can and cannot prove is the point of it. It proves the picker
// is rendered for an org admin, that choosing an agent puts that agent's id in
// what `useApproveDevice` is called with, and that an ordinary member is shown
// no picker at all. It CANNOT prove criterion 31 — a screen that renders the
// picker into a detached subtree, or a route that never mounts this component,
// leaves every assertion here green. Criterion 31 is a real browser drive
// through `/pair`, which the plan binds the issue to.
import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PairScreen } from "./pair-screen";

expect.extend(matchers);

Element.prototype.scrollIntoView = vi.fn();

const mutate = vi.fn();
let agents: unknown[] = [];
let orgRole = "admin";
let orgId: string | null = "org-1";
let queryState: { isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };
const refetch = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("code=ABC-1234"),
}));
vi.mock("../hooks", () => ({
  useApproveDevice: () => ({ mutate, data: undefined, isError: false, isPending: false }),
}));
vi.mock("@/features/agent-accounts/hooks", () => ({
  useAgentAccounts: (orgId: string | null) => ({
    data: orgId && !queryState.isError ? agents : undefined,
    ...queryState,
    refetch,
  }),
}));
vi.mock("@/features/orgs/active-org", () => ({
  useActiveOrg: () => ({
    activeOrg: orgId === null ? null : { id: orgId, name: "Acme", role: orgRole },
  }),
}));
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { email: "admin@acme.test" } }),
}));

beforeEach(() => {
  mutate.mockClear();
  refetch.mockClear();
  orgRole = "admin";
  queryState = { isLoading: false, isError: false };
  orgId = "org-1";
  agents = [
    {
      userId: "agent-1",
      handle: "forge-vm",
      displayName: "The box",
      email: "forge-vm.aaa@agents.forge.invalid",
      projects: [
        { id: "p1", role: "member" },
        { id: "p2", role: "member" },
      ],
      createdAt: "2026-01-01T00:00:00Z",
      activeTokens: 1,
      canAct: true,
    },
  ];
});
afterEach(cleanup);

const renderScreen = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PairScreen />
    </QueryClientProvider>,
  );

function chooseTheAgent() {
  fireEvent.click(screen.getByLabelText("Pair this device as"));
  fireEvent.click(screen.getByRole("option", { name: "The box (@forge-vm)" }));
}

describe("choosing the identity a box will carry (ISS-1093)", () => {
  it("offers the signed-in person and every agent of the active org", () => {
    renderScreen();
    fireEvent.click(screen.getByLabelText("Pair this device as"));
    const offered = screen.getAllByRole("option").map((o) => o.textContent);
    expect(offered).toEqual(["Me — admin@acme.test", "The box (@forge-vm)"]);
  });

  it("sends the chosen agent's id with the approval", () => {
    renderScreen();
    chooseTheAgent();
    fireEvent.click(screen.getByRole("button", { name: /Approve device/ }));
    expect(mutate).toHaveBeenCalledWith({ pairingCode: "ABC-1234", agentUserId: "agent-1" });
  });

  it("sends no agent when the approver leaves it as themselves", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Approve device/ }));
    expect(mutate).toHaveBeenCalledWith({ pairingCode: "ABC-1234", agentUserId: null });
  });

  it("says in words which identity the box will carry", () => {
    renderScreen();
    expect(screen.getByText(/will act as you/)).toBeInTheDocument();
    chooseTheAgent();
    expect(
      screen.getByText(/will act as The box \(@forge-vm\) — not as you — and reach that agent's 2 project/),
    ).toBeInTheDocument();
  });

  it("shows no picker to a member who is not an org admin", () => {
    orgRole = "member";
    renderScreen();
    expect(screen.queryByLabelText("Pair this device as")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Approve device/ }));
    expect(mutate).toHaveBeenCalledWith({ pairingCode: "ABC-1234", agentUserId: null });
  });

  it("does not promise a person's box the person's own project reach", () => {
    renderScreen();
    const said = screen.getByText(/will act as you/).textContent ?? "";
    expect(said).toMatch(/reaches no project/i);
    expect(said).not.toMatch(/reach what you reach/i);
  });

  it("says an organization has no agents rather than just hiding the choice", () => {
    agents = [];
    renderScreen();
    expect(screen.getByText(/no agents yet/i)).toBeInTheDocument();
  });

  it("does not present a failed agent query as an organization with no agents", () => {
    queryState = { isLoading: false, isError: true };
    renderScreen();
    expect(screen.queryByText(/no agents yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(refetch).toHaveBeenCalled();
  });

  it("does not present a pending agent query as an organization with no agents", () => {
    agents = [];
    queryState = { isLoading: true, isError: false };
    renderScreen();
    expect(screen.queryByText(/no agents yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Looking for the agents/i)).toBeInTheDocument();
  });

  it("will not approve while the agent list is still loading", () => {
    queryState = { isLoading: true, isError: false };
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Approve device/ }));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("still approves while loading for someone who is shown no choice at all", () => {
    orgRole = "member";
    queryState = { isLoading: true, isError: false };
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Approve device/ }));
    expect(mutate).toHaveBeenCalledWith({ pairingCode: "ABC-1234", agentUserId: null });
  });
});

describe("the identity submitted is the identity shown", () => {
  it("never sends an agent the current organization does not have", () => {
    orgId = "org-1";
    const view = renderScreen();
    chooseTheAgent();
    expect(screen.getByText(/will act as The box/)).toBeInTheDocument();

    // The admin switches organization. Its agents are different; the chosen one is not among them.
    orgId = "org-2";
    agents = [];
    view.rerender(
      <QueryClientProvider client={new QueryClient()}>
        <PairScreen />
      </QueryClientProvider>,
    );

    expect(screen.getByText(/will act as you/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Approve device/ }));
    expect(mutate).toHaveBeenCalledWith({ pairingCode: "ABC-1234", agentUserId: null });

    expect(screen.getByLabelText("Pair this device as")).toHaveTextContent(
      "Me — admin@acme.test",
    );
  });

  it("will not approve before the active organization has resolved", () => {
    orgId = null;
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Approve device/ }));
    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText(/Looking for the agents/i)).toBeInTheDocument();
  });
});
