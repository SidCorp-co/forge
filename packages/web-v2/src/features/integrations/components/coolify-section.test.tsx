// @vitest-environment jsdom
//
// cm:why the hazard this file covers is the SAVE, not the field — a config PATCH replaces the whole `targets` array, so a save that drops `healthUrl` disarms the post-deploy health gate on a target an operator armed, and nothing in the UI would show it (ISS-971)

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationSummary } from "../types";

expect.extend(matchers);
afterEach(cleanup);

type UpdateArgs = { id: string; body: { config: { targets: Record<string, unknown>[] } } };
const updateMutate = vi.fn(async (_args: UpdateArgs) => ({}));
const listRefetch = vi.fn();
let existing: IntegrationSummary | undefined;

vi.mock("../hooks", () => ({
  useIntegrationsList: () => ({
    data: { items: existing ? [existing] : [] },
    refetch: listRefetch,
  }),
  useCreateProviderIntegration: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateProviderIntegration: () => ({ mutateAsync: updateMutate, isPending: false }),
  useDeleteProviderIntegration: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTestIntegration: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useConfirmProdDeploy: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useOrgConnectionLocked: () => false,
  useCoolifyApplications: () => ({ data: { applications: [] }, isError: false }),
  useCoolifyTargets: () => ({ data: { targets: [] }, isError: false }),
}));

vi.mock("@/features/project-settings/hooks", () => ({
  isFeatureOff: () => false,
  usePipelineConfig: () => ({ data: {} }),
  useUpdatePipelineConfig: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("./connection-owner-field", () => ({ ConnectionOwnerField: () => null }));

const { CoolifySection } = await import("./coolify-section");

function binding(healthUrl?: string): IntegrationSummary {
  const target = {
    id: "t1",
    label: "Backend",
    resourceUuid: "app-1",
    ...(healthUrl ? { healthUrl } : {}),
  };
  return {
    id: "b1",
    provider: "coolify",
    environment: "staging",
    active: true,
    connectionId: "c1",
    config: { baseUrl: "https://coolify.example", targets: [target] },
    bindingConfig: { targets: [target] },
  } as unknown as IntegrationSummary;
}

beforeEach(() => {
  existing = binding("https://api.example/health");
});

describe("saving a Coolify binding", () => {
  it("carries a stored health URL through the PATCH that replaces targets", async () => {
    render(<CoolifySection projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(updateMutate).toHaveBeenCalled();
    const sent = updateMutate.mock.calls.at(-1)?.[0];
    expect(sent?.body.config.targets[0]).toMatchObject({
      label: "Backend",
      resourceUuid: "app-1",
      healthUrl: "https://api.example/health",
    });
  });

  it("stores no health URL for a target that has none, rather than a derived one", async () => {
    existing = binding();
    render(<CoolifySection projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    const sent = updateMutate.mock.calls.at(-1)?.[0];
    expect(sent?.body.config.targets[0]).not.toHaveProperty("healthUrl");
  });
});
