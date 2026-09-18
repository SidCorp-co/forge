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

// cm:why Select scrolls its active option into view and jsdom has no scrollIntoView, so opening the picker throws without this stub
Element.prototype.scrollIntoView = vi.fn();

const mutate = vi.fn();
let agents: unknown[] = [];
let orgRole = "admin";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("code=ABC-1234"),
}));
vi.mock("../hooks", () => ({
  useApproveDevice: () => ({ mutate, data: undefined, isError: false, isPending: false }),
}));
vi.mock("@/features/agent-accounts/hooks", () => ({
  useAgentAccounts: (orgId: string | null) => ({ data: orgId ? agents : undefined }),
}));
vi.mock("@/features/orgs/active-org", () => ({
  useActiveOrg: () => ({ activeOrg: { id: "org-1", name: "Acme", role: orgRole } }),
}));
vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { email: "admin@acme.test" } }),
}));

beforeEach(() => {
  mutate.mockClear();
  orgRole = "admin";
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

  // cm:guard the AGENT ID is what is asserted, not that approve was called. Approve is
  // called on every pairing there has ever been; the id is the only thing this change adds
  // and the only thing whose absence is invisible from the screen.
  it("sends the chosen agent's id with the approval", () => {
    renderScreen();
    chooseTheAgent();
    fireEvent.click(screen.getByRole("button", { name: /Approve device/ }));
    expect(mutate).toHaveBeenCalledWith({ pairingCode: "ABC-1234", agentUserId: "agent-1" });
  });

  // cm:guard `agentUserId: null` and never the id left over from a picker that was opened
  // and closed. The default is the identity every existing pairing already has.
  it("sends no agent when the approver leaves it as themselves", () => {
    renderScreen();
    fireEvent.click(screen.getByRole("button", { name: /Approve device/ }));
    expect(mutate).toHaveBeenCalledWith({ pairingCode: "ABC-1234", agentUserId: null });
  });

  // cm:guard the sentence names the agent and the reach, because approving is a GRANT that
  // outlives the tab: the box holds the identity until the token is revoked.
  it("says in words which identity the box will carry", () => {
    renderScreen();
    expect(screen.getByText(/will act as you/)).toBeInTheDocument();
    chooseTheAgent();
    expect(screen.getByText(/will act as The box \(@forge-vm\) and reach 2 project/)).toBeInTheDocument();
  });

  it("shows no picker to a member who is not an org admin", () => {
    orgRole = "member";
    renderScreen();
    expect(screen.queryByLabelText("Pair this device as")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Approve device/ }));
    expect(mutate).toHaveBeenCalledWith({ pairingCode: "ABC-1234", agentUserId: null });
  });

  it("shows no picker when the organization has no agents", () => {
    agents = [];
    renderScreen();
    expect(screen.queryByLabelText("Pair this device as")).not.toBeInTheDocument();
  });
});
