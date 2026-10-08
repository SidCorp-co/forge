// @vitest-environment jsdom
//
// ISS-1216 — the drawer's "Projects using it" panel over a refusal. A 404 or 403 answers the same
// way every time, so the panel prints the server's sentence and offers no Retry; a 5xx or a lost
// connection can answer differently, so it keeps one.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

let bindingsError: unknown = null;

vi.mock("../hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks")>()),
  useConnectionBindings: () => ({
    data: undefined,
    isLoading: false,
    isError: bindingsError !== null,
    error: bindingsError,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({ data: [] }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { ConnectionEditDrawer } = await import("./connection-edit-drawer");

expect.extend(matchers);

const connection: ConnectionDirectoryItem = {
  id: "2679a042-4da4-48dd-bcfa-933c70ba91da",
  ownerType: "user",
  ownerId: "someone-else",
  provider: "github",
  displayName: "Forge GitHub App",
  config: {},
  active: true,
  lastHealthStatus: "ok",
  lastHealthAt: "2026-09-20T00:00:00.000Z",
  breakerOpenedAt: null,
  hasSecrets: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  usage: { bindings: [] },
  access: { reach: "binding", canManage: false, ownerName: "Dana Reyes" },
};

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionEditDrawer connection={connection} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  bindingsError = null;
});
afterEach(cleanup);

describe("the drawer's Projects using it panel over a refusal", () => {
  it("prints the server's sentence for a connection it cannot reach, with no Retry that would meet it again", () => {
    const sentence = `connection ${connection.id} is not one you can reach. Ask its owner.`;
    bindingsError = new ApiError(404, sentence, "CONNECTION_NOT_REACHABLE");

    mount();

    expect(screen.getByText(sentence)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("keeps Retry for a server failure, which can answer differently the next time", () => {
    bindingsError = new ApiError(503, "unavailable", "INTERNAL_ERROR");

    mount();

    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
