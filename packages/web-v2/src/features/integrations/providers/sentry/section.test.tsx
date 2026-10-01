// @vitest-environment jsdom
//
// A Sentry binding still in the shape ISS-526 retired (top-level `organizationSlug`/`projectSlug`)
// is refused by core as `target_old_shape`; the screen must say so, not seed a row from it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationSummary } from "../../types";

expect.extend(matchers);

let items: IntegrationSummary[] = [];
const pending = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock("../../hooks", () => ({
  useIntegrationsList: () => ({ data: { items } }),
  useCreateProviderIntegration: () => pending,
  useUpdateProviderIntegration: () => pending,
  useDeleteProviderIntegration: () => pending,
  useTestIntegration: () => pending,
  useIsOrgAdmin: () => true,
  useOrgConnectionLocked: () => false,
}));
vi.mock("../../components/agent-access-control", () => ({
  AGENT_ACCESS_CLOSED: "closed",
  AgentAccessChoice: () => null,
  AgentAccessControl: () => null,
  agentAccessBody: () => ({}),
  agentAccessDeniedReason: () => undefined,
  mayWriteAgentAccess: () => true,
}));
vi.mock("../../components/connection-owner-field", () => ({ ConnectionOwnerField: () => null }));
vi.mock("../../components/integration-enabled-control", () => ({
  IntegrationEnabledControl: () => null,
}));

const { SentrySection, initialTargets, retiredSlugs } = await import("./section");

function binding(config: Record<string, unknown>): IntegrationSummary {
  return {
    id: "b1",
    connectionId: "c1",
    projectId: "p1",
    provider: "sentry",
    role: "service",
    config,
    bindingConfig: {},
    label: "",
    active: true,
    bindingActive: true,
    connectionActive: true,
    lastHealthStatus: null,
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    integrationSecretSet: false,
    agentAccess: "closed",
    agentPathKind: "direct-mcp",
    revision: 1,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  } as IntegrationSummary;
}

afterEach(() => {
  cleanup();
  items = [];
});

describe("Sentry section — the target shape only", () => {
  it("seeds rows from targets[] and never from the retired top-level slugs", () => {
    const legacy = { host: "sentry.io", organizationSlug: "acme", projectSlug: "web" };
    expect(initialTargets(legacy)).toEqual([
      { label: "", organizationSlug: "", projectSlug: "", environment: "", notes: "" },
    ]);
    expect(retiredSlugs(legacy)).toEqual(["organizationSlug", "projectSlug"]);
    expect(retiredSlugs({ host: "sentry.io", targets: [] })).toEqual([]);
  });

  it("shows the target_old_shape refusal plainly and offers no save for an old-shape binding", () => {
    items = [binding({ host: "sentry.io", organizationSlug: "acme", projectSlug: "web" })];
    render(<SentrySection projectId="p1" />);
    expect(screen.getByText(/target_old_shape/)).toHaveTextContent(
      "`organizationSlug` and `projectSlug`",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByDisplayValue("sentry.io")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("acme")).not.toBeInTheDocument();
  });

  it("shows no refusal for a binding in the target shape", () => {
    items = [
      binding({ host: "sentry.io", targets: [{ label: "Backend", organizationSlug: "acme" }] }),
    ];
    render(<SentrySection projectId="p1" />);
    expect(screen.queryByText(/target_old_shape/)).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("acme")).toBeInTheDocument();
  });
});
