// @vitest-environment jsdom
//
// ISS-1229 r21: every surface names a member by their display name, so Settings → Account is where a
// person gives one — and clears it — and what reads the signed-in person follows without a reload.

import * as matchers from "@testing-library/jest-dom/matchers";
import { personInitials } from "@forge/contracts/person-name";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LeaveGuardProvider } from "@/design";
import { AuthProvider, useAuth } from "@/providers/auth-provider";
import { AccountTab } from "./components/account-tab";

expect.extend(matchers);

let me: { id: string; email: string; displayName: string | null };
let writes: Array<string | null>;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("@/lib/api/auth-api", () => ({
  authApi: {
    me: async () => ({ ...me, emailVerifiedAt: null, createdAt: "", lastFreshAuthAt: null, hasPassword: true, oauthProviders: [] }),
    setDisplayName: async (displayName: string | null) => {
      writes.push(displayName);
      me = { ...me, displayName };
      return { ...me };
    },
  },
}));
vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return {
    ...actual,
    apiClient: async (path: string) => {
      if (path === "/auth/me/preferences") return { theme: "system", language: "en" };
      if (path === "/auth/preferences") return { theme: "system", language: "en", answerStyle: "default", assistantInstructions: null };
      if (path === "/auth/preferences/changes") return { items: [] };
      throw new Error(`unmocked ${path}`);
    },
  };
});
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

/** What the rail's account avatar reads: the signed-in person's initials. */
function RailAvatar() {
  const { user } = useAuth();
  return <span data-testid="rail-avatar">{user ? personInitials(user.displayName) : ""}</span>;
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <LeaveGuardProvider>
          <RailAvatar />
          <AccountTab />
        </LeaveGuardProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

const nameField = () => screen.getByLabelText("Display name") as HTMLInputElement;

beforeEach(() => {
  me = { id: "u1", email: "lan.pham@example.com", displayName: null };
  writes = [];
});
afterEach(cleanup);

describe("a person's display name, from Settings → Account", () => {
  it("is set there, and the rail's avatar follows it without a reload", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("rail-avatar")).toHaveTextContent("AM"));
    expect(nameField().value).toBe("");
    fireEvent.change(nameField(), { target: { value: "  Lan Pham " } });
    fireEvent.click(screen.getByRole("button", { name: "Set name" }));
    await waitFor(() => expect(screen.getByTestId("rail-avatar")).toHaveTextContent("LP"));
    expect(writes).toEqual(["Lan Pham"]);
    expect(nameField().value).toBe("Lan Pham");
  });

  it("is cleared there, and the avatar reads Another member's initials again", async () => {
    me = { ...me, displayName: "Lan Pham" };
    mount();
    await waitFor(() => expect(nameField().value).toBe("Lan Pham"));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.getByTestId("rail-avatar")).toHaveTextContent("AM"));
    expect(writes).toEqual([null]);
  });
});
