// @vitest-environment jsdom
//
// The switch reads one tier and writes the same one. Before this control the
// card bound `active` (bindingActive && connectionActive) yet PATCHed only the
// binding, so with the credential disabled it reported success and snapped
// back — forge-dev's Rocket.Chat could not be turned on from the UI at all.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationSummary } from "../types";
import { IntegrationEnabledControl } from "./integration-enabled-control";

expect.extend(matchers);
afterEach(cleanup);

const updateBinding = vi.fn();
const updateConnection = vi.fn();
const orgLocked = vi.fn();

vi.mock("../hooks", () => ({
  useUpdateProviderIntegration: () => ({ mutate: updateBinding }),
  useUpdateConnection: () => ({ mutate: updateConnection, isPending: false }),
  useOrgConnectionLocked: (...args: unknown[]) => orgLocked(...args),
}));

function summary(over: Partial<IntegrationSummary> = {}): IntegrationSummary {
  return {
    id: "bind-1",
    connectionId: "conn-1",
    projectId: "proj-1",
    provider: "rocketchat",
    environment: "prod",
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
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
    ...over,
  } as IntegrationSummary;
}

function renderControl(over: Partial<IntegrationSummary> = {}) {
  return render(
    <IntegrationEnabledControl projectId="proj-1" binding={summary(over)} />,
  );
}

const theSwitch = () => screen.getByRole("switch");

describe("IntegrationEnabledControl", () => {
  beforeEach(() => {
    updateBinding.mockReset();
    updateConnection.mockReset();
    orgLocked.mockReset().mockReturnValue(false);
  });

  it("reads the binding tier, not the AND, when the credential is disabled", () => {
    renderControl({ active: false, bindingActive: true, connectionActive: false });
    expect(theSwitch()).toHaveAttribute("aria-checked", "true");
  });

  it("reads off when the project has opted out even though the credential is live", () => {
    renderControl({ active: false, bindingActive: false, connectionActive: true });
    expect(theSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("writes the binding tier only", () => {
    renderControl({ active: true, bindingActive: true, connectionActive: true });
    fireEvent.click(theSwitch());
    expect(updateBinding).toHaveBeenCalledWith({
      id: "bind-1",
      body: { active: false },
    });
    expect(updateConnection).not.toHaveBeenCalled();
  });

  it("surfaces the credential tier as its own action when that is the tier that is off", () => {
    renderControl({ active: false, bindingActive: true, connectionActive: false });
    expect(screen.getByText(/shared credential is disabled/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /enable credential/i }));
    expect(updateConnection).toHaveBeenCalledWith({
      id: "conn-1",
      body: { active: true },
    });
    expect(updateBinding).not.toHaveBeenCalled();
  });

  it("says nothing about the credential when both tiers are on", () => {
    renderControl({ active: true, bindingActive: true, connectionActive: true });
    expect(screen.queryByText(/shared credential/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /enable credential/i }),
    ).not.toBeInTheDocument();
  });

  it("offers no write to a member who cannot manage the org credential", () => {
    orgLocked.mockReturnValue(true);
    renderControl({ active: false, bindingActive: true, connectionActive: false });
    expect(theSwitch()).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /enable credential/i }),
    ).toBeDisabled();
  });
});
