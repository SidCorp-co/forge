// @vitest-environment jsdom
//
// ISS-1071 — the one grant control.
//
// Three things it must never do, each here because the model it replaced did exactly that: render
// a switch for a provider no agent can reach; describe a `direct-mcp` grant in the words of a
// `core-mediated` one, when the first hands the project's credential to a runner box and the second
// does not; and leave an answer on the row that no server ever stored.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationSummary } from "../types";
import { AgentAccessChoice, AgentAccessControl } from "./agent-access-control";

expect.extend(matchers);
afterEach(cleanup);

const updateMutate =
  vi.fn<
    (
      vars: { id: string; body: Record<string, unknown> },
      cbs: { onSuccess: () => void; onError: (e: unknown) => void },
    ) => void
  >();

vi.mock("../hooks", () => ({
  useIsOrgAdmin: () => true,
  useUpdateProviderIntegration: () => ({ mutate: updateMutate }),
}));

function binding(over: Partial<IntegrationSummary> = {}): IntegrationSummary {
  return {
    id: "bind-1",
    connectionId: "conn-1",
    projectId: "proj-1",
    provider: "epodsystem",
    role: "service",
    stages: [],
    config: {},
    bindingConfig: {},
    label: "",
    active: true,
    bindingActive: true,
    connectionActive: true,
    lastHealthStatus: "ok",
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    integrationSecretSet: false,
    agentAccess: "none",
    agentPathKind: "direct-mcp",
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    ...over,
  } as IntegrationSummary;
}

const theSwitch = () => screen.getByRole("switch");

beforeEach(() => updateMutate.mockReset());

describe("AgentAccessChoice", () => {
  it("renders nothing at all for a provider with no agent path", () => {
    const { container } = render(
      <AgentAccessChoice value="none" onChange={vi.fn()} pathKind="none" canEdit />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("says the credential leaves Forge for a direct-mcp provider", () => {
    render(<AgentAccessChoice value="none" onChange={vi.fn()} pathKind="direct-mcp" canEdit />);
    const said = screen.getByText(/runner box/i).textContent ?? "";
    expect(said).toMatch(/credential/i);
    expect(said).toMatch(/directly/i);
    expect(said).toMatch(/outside that call path/i);
  });

  it("says Forge keeps the credential for a core-mediated provider, and never borrows the other wording", () => {
    render(<AgentAccessChoice value="none" onChange={vi.fn()} pathKind="core-mediated" canEdit />);
    expect(screen.getByText(/Forge holds the credential/i)).toBeInTheDocument();
    expect(screen.queryByText(/runner box/i)).not.toBeInTheDocument();
  });

  // cm:guard core may grow a fourth `AgentPath` arm before the web knows its wording; the control
  // must then offer nothing rather than a switch it cannot explain.
  it("renders nothing for a kind this build has no wording for", () => {
    const { container } = render(
      <AgentAccessChoice
        value="none"
        onChange={vi.fn()}
        pathKind={"telepathy" as never}
        canEdit
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("emits the open answer when switched on and the closed one when switched off", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AgentAccessChoice value="none" onChange={onChange} pathKind="direct-mcp" canEdit />,
    );
    fireEvent.click(theSwitch());
    expect(onChange).toHaveBeenLastCalledWith("all");

    rerender(<AgentAccessChoice value="all" onChange={onChange} pathKind="direct-mcp" canEdit />);
    fireEvent.click(theSwitch());
    expect(onChange).toHaveBeenLastCalledWith("none");
  });

  it("shows the state DISABLED rather than absent to someone who may not change it, and says who may", () => {
    render(
      <AgentAccessChoice
        value="all"
        onChange={vi.fn()}
        pathKind="direct-mcp"
        canEdit={false}
        disabledReason="Only an org owner/admin can grant it."
      />,
    );
    expect(theSwitch()).toBeDisabled();
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/Only an org owner\/admin can grant it\./)).toBeInTheDocument();
  });
});

describe("AgentAccessControl", () => {
  it("renders nothing for a binding whose provider has no agent path", () => {
    const { container } = render(
      <AgentAccessControl
        projectId="proj-1"
        binding={binding({ agentPathKind: "none", agentAccess: "none" })}
        canEdit
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("writes the grant with the binding PATCH", () => {
    render(<AgentAccessControl projectId="proj-1" binding={binding()} canEdit />);
    fireEvent.click(theSwitch());
    expect(updateMutate.mock.calls[0]?.[0]).toEqual({
      id: "bind-1",
      body: { agentAccess: "all" },
    });
  });

  it("shows the asked-for state while the write is in flight", () => {
    render(<AgentAccessControl projectId="proj-1" binding={binding()} canEdit />);
    fireEvent.click(theSwitch());
    // The mock never calls back, so the request is still open here.
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    expect(theSwitch()).toBeDisabled();
  });

  // cm:guard the request is held OPEN and then rejected, rather than rejected synchronously: an
  // optimistic value that is never applied and one that is applied and rolled back are
  // indistinguishable if the failure arrives before the first render.
  it("leaves the last confirmed state on the row when the write is refused, and says why inline", () => {
    render(<AgentAccessControl projectId="proj-1" binding={binding()} canEdit />);
    fireEvent.click(theSwitch());
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");

    const [, cbs] = updateMutate.mock.calls[0] ?? [];
    act(() => cbs?.onError(new Error("only an org admin may grant a direct-mcp integration")));

    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
    expect(theSwitch()).not.toBeDisabled();
    expect(
      screen.getByText(/only an org admin may grant a direct-mcp integration/i),
    ).toBeInTheDocument();
  });

  it("keeps the new state once the server confirms it", () => {
    const { rerender } = render(
      <AgentAccessControl projectId="proj-1" binding={binding()} canEdit />,
    );
    fireEvent.click(theSwitch());
    const [, cbs] = updateMutate.mock.calls[0] ?? [];
    act(() => cbs?.onSuccess());
    rerender(
      <AgentAccessControl projectId="proj-1" binding={binding({ agentAccess: "all" })} canEdit />,
    );
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText(/only an org admin/i)).not.toBeInTheDocument();
  });

  it("offers no write to someone who may not grant it, and still shows the state", () => {
    render(
      <AgentAccessControl
        projectId="proj-1"
        binding={binding({ agentAccess: "all" })}
        canEdit={false}
        disabledReason="Only an org owner/admin can grant it."
      />,
    );
    expect(theSwitch()).toBeDisabled();
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
    fireEvent.click(theSwitch());
    expect(updateMutate).not.toHaveBeenCalled();
  });
});
