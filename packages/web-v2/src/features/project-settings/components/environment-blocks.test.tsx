// @vitest-environment jsdom
//
// ISS-1228 round 23 (master's read of the r23 after-shots, criterion 243): a deploy-connections read
// that failed said "…then try again." with no way to try again.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsForm } from "@/design";
import { ApiError } from "@/lib/api/client";
import { type EnvironmentsDraft, parseEnvironments } from "../environments-form";

expect.extend(matchers);

const refetch = vi.fn();
let error: unknown = null;
vi.mock("@/features/integrations/hooks", () => ({
  useIntegrationsList: () => ({ data: undefined, isLoading: false, isError: true, error, refetch }),
}));

const { EnvironmentBlocks } = await import("./environment-blocks");

function mount() {
  const form = { draft: parseEnvironments({}), setDraft: vi.fn(), errorAt: () => undefined } as unknown as SettingsForm<EnvironmentsDraft>;
  render(<EnvironmentBlocks projectId="p1" form={form} canEdit={false} liveBranch="main" shipsNothing={false} />);
}

beforeEach(() => refetch.mockClear());
afterEach(cleanup);

describe("a deploy-connections read that failed", () => {
  it("offers Retry under a refusal, and reads the connections again", () => {
    error = new ApiError(409, "Try again in a minute.", "X");
    mount();
    const retries = screen.getAllByRole("button", { name: "Retry" });
    expect(retries.length).toBeGreaterThan(0);
    fireEvent.click(retries[0] as HTMLElement);
    expect(refetch).toHaveBeenCalled();
  });

  it("offers no Retry under a 401, which signs the person out", () => {
    error = new ApiError(401, "Unauthenticated", "UNAUTHENTICATED");
    mount();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
