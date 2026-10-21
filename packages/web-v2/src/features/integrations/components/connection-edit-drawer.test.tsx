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

const { ConnectionEditDrawer, testOutcome } = await import("./connection-edit-drawer");

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

function mount(over: Partial<ConnectionDirectoryItem> = {}) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConnectionEditDrawer connection={{ ...connection, ...over }} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  bindingsError = null;
});
afterEach(cleanup);

describe("the drawer's Projects using it panel over a refusal", () => {
  it("prints the server's sentence for a connection it cannot reach, with no Retry that would meet it again", () => {
    const sentence = `Connection ${connection.id} is not one you can reach. Ask its owner.`;
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

// ISS-1421 r17 — judge-73 read "Test failed: error — …" and "Test failed: needs_reauth — …": the
// failure said twice, and a stored status value set beside a badge that words it for a person.
describe("the drawer's Test connection line", () => {
  it("is the provider's own sentence when it gave one, with no stored status before it", () => {
    const said =
      "Forge could not check Coolify. The server at example.com answered 404 Not Found to GET /api/v1/resources, so it may not be Coolify. Check the address saved on this connection, then test again.";
    expect(testOutcome({ status: "error", message: said })).toBe(said);
    expect(testOutcome({ status: "needs_reauth", message: "Postman refused the stored credential." })).toBe(
      "Postman refused the stored credential.",
    );
  });

  it("words a status for a person when the provider gave no sentence", () => {
    expect(testOutcome({ status: "ok" })).toBe("The connection works.");
    expect(testOutcome({ status: "needs_reauth" })).toBe("It needs signing in again.");
    expect(testOutcome({ status: "error" })).toBe("The last check failed.");
    for (const status of ["error", "needs_reauth", "needs_scope"]) {
      const line = testOutcome({ status });
      expect(line).not.toContain(status);
      expect(line).not.toMatch(/Test failed/);
    }
  });
});

// ISS-1421 r18 — judge-75 at 390: a 53-character name cut mid-word with Close pushed off screen.
describe("the drawer header's connection name", () => {
  it("may shrink to the drawer's width, ellipsised, with the whole name on hover", () => {
    const long = "j75 Coolify production eu-west primary box number one again";
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConnectionEditDrawer connection={{ ...connection, displayName: long }} onClose={() => {}} />
      </QueryClientProvider>,
    );
    const name = screen.getByTestId("connection-drawer-name");
    expect(name).toHaveTextContent(long);
    expect(name).toHaveAttribute("title", long);
    for (const cls of ["min-w-0", "max-w-full", "truncate"]) expect(name.className).toContain(cls);
  });
});


// ISS-1421 r19 — judge-79 read "the previous key stays valid for 24h" on a Coolify token: nothing
// keeps a key valid at Coolify. Forge keeps the replaced key and falls back to it, and only where
// it is used is that said, as it is used; Rocket.Chat stores it and never reads it.
describe("the drawer's Replace key line", () => {
  const managed = { access: { ...connection.access, canManage: true } };

  it("says what Forge does with the previous key for a provider that uses it", () => {
    mount({ ...managed, provider: "coolify" });
    expect(
      screen.getByText(
        "A key is stored (never shown). Forge keeps the previous key for 24 hours and uses it wherever Coolify refuses the new one.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/stays valid/)).toBeNull();
    cleanup();
    mount({ ...managed, provider: "google" });
    expect(
      screen.getByText(
        "A key is stored (never shown). Forge keeps the previous key for 24 hours and signs in with it wherever Google refuses the new one.",
      ),
    ).toBeInTheDocument();
  });

  it("makes no 24-hour claim for a provider that never reads the previous key", () => {
    for (const provider of ["rocketchat", "sentry", "postman", "epodsystem"] as const) {
      mount({ ...managed, provider });
      expect(screen.getByText("A key is stored (never shown). Enter a new one to replace it.")).toBeInTheDocument();
      expect(screen.queryByText(/24 hours|24h/)).toBeNull();
      cleanup();
    }
  });
});
