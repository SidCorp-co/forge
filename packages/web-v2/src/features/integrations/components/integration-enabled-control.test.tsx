// @vitest-environment jsdom
//
// ISS-1421 r22, judge-91: a project bound to a removed connection offered Enable credential, which
// core refuses (CONNECTION_HAS_NO_KEY) with a sentence pointing back at the same screen. A removed
// connection is switched off and holds no key; one switched off that holds its key keeps the button.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationSummary } from "../types";

vi.mock("../hooks", () => ({
  useUpdateProviderIntegration: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useOrgConnectionLocked: () => false,
}));

const { IntegrationEnabledControl } = await import("./integration-enabled-control");

expect.extend(matchers);
afterEach(cleanup);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";

function binding(over: Partial<IntegrationSummary>): IntegrationSummary {
  return {
    id: "3f7c1a44-9e52-4d6b-8a21-0b5c9d2e7f61",
    connectionId: "b1d6b9c2-5f3a-4a1e-9f0e-6c2a7d8e4f10",
    projectId: PROJECT,
    provider: "sentry",
    role: "service",
    stages: [],
    config: {},
    bindingConfig: {},
    label: "",
    active: false,
    bindingActive: true,
    connectionActive: false,
    lastHealthStatus: null,
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: false,
    integrationSecretSet: true,
    agentAccess: "none",
    agentPathKind: "core-mediated",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  } as IntegrationSummary;
}

describe("the binding controls over a removed connection (criterion 228)", () => {
  it("offer no Enable credential for a key provider, and say a new key turns it back on", () => {
    render(<IntegrationEnabledControl projectId={PROJECT} binding={binding({})} />);

    expect(screen.queryByRole("button", { name: /enable credential/i })).toBeNull();
    expect(
      screen.getByText(
        "The shared connection was removed, so it holds no key. Saving a new key on it on the Integrations page turns it back on.",
      ),
    ).toBeInTheDocument();
  });

  it("offer no Enable credential for GitHub, and say the install turns it back on", () => {
    render(
      <IntegrationEnabledControl projectId={PROJECT} binding={binding({ provider: "github" })} />,
    );

    expect(screen.queryByRole("button", { name: /enable credential/i })).toBeNull();
    expect(screen.getByText(/Installing the GitHub App again here turns it back on/)).toBeInTheDocument();
  });

  // r23 ruling: a key saved from the project's own drawer leaves the connection off, and the save
  // said nothing; the line beside Enable credential now says the connection is still off.
  it("say a key saved here left the connection off, with Enable credential beside it", () => {
    const { rerender } = render(
      <IntegrationEnabledControl projectId={PROJECT} binding={binding({})} />,
    );
    rerender(<IntegrationEnabledControl projectId={PROJECT} binding={binding({ hasSecrets: true })} />);

    const line = screen.getByText(
      "The key is saved, but the shared connection is still off, so no project can use it yet.",
    );
    const enable = screen.getByRole("button", { name: /enable credential/i });
    expect(line.parentElement).toBe(enable.parentElement);
    expect(screen.queryByText(/Shared credential is disabled/)).toBeNull();

    rerender(
      <IntegrationEnabledControl
        projectId={PROJECT}
        binding={binding({ hasSecrets: true, connectionActive: true, active: true })}
      />,
    );
    expect(screen.queryByText(/still off/)).toBeNull();
  });

  it("keep Enable credential where the connection is only switched off and still holds its key", () => {
    render(
      <IntegrationEnabledControl projectId={PROJECT} binding={binding({ hasSecrets: true })} />,
    );

    expect(screen.getByRole("button", { name: /enable credential/i })).toBeInTheDocument();
    expect(screen.queryByText(/was removed/)).toBeNull();
  });
});
