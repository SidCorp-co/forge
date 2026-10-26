// @vitest-environment jsdom
//
// ISS-1229 r46, judge-135: Integrations, What's New and Private keys, each a page whose one read failed,
// titled the error "Couldn't load" under the page's own heading and left the tab at "Forge". A state that
// is a page's only content under its title names what failed, is the page's one h1, and names the tab.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const failed = {
  data: undefined,
  isLoading: false,
  isError: true,
  error: new Error("The server did not answer."),
  refetch: vi.fn(),
};

vi.mock("@/features/integrations/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/integrations/hooks")>()),
  useConnections: () => failed,
}));
vi.mock("@/features/orgs/active-org", () => ({
  useActiveOrg: () => ({ activeOrg: { id: "o1", name: "Desk", isPersonal: false, role: "owner" }, orgs: [] }),
}));
vi.mock("@/features/orgs/hooks", () => ({ useOrgs: () => ({ data: [] }) }));
vi.mock("@/features/projects/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/projects/hooks")>()),
  useProjectsIncludingArchived: () => ({ data: [] }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/features/whats-new/hooks", () => ({
  useWhatsNewStatus: () => ({ ...failed, markSeen: vi.fn(), topId: null }),
}));
vi.mock("@/features/resources/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/resources/hooks")>()),
  useOrgSshKeys: () => failed,
  useDeleteSshKey: () => ({ mutate: vi.fn(), isPending: false }),
  useTestSshKey: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
  keyInUseDetails: () => null,
}));

const { IntegrationsScreen } = await import("@/features/integrations/components/integrations-screen");
const { WhatsNewScreen } = await import("@/features/whats-new/components/whats-new-screen");
const { PrivateKeysScreen } = await import("@/features/resources/components/private-keys-screen");

afterEach(cleanup);

function mount(page: ReactNode) {
  render(<QueryClientProvider client={new QueryClient()}>{page}</QueryClientProvider>);
}

describe("a page whose one read failed", () => {
  for (const [page, element, title] of [
    ["Integrations", <IntegrationsScreen key="i" />, "Couldn't load your connections"],
    ["What's New", <WhatsNewScreen key="w" />, "Couldn't load release notes"],
    ["Private keys", <PrivateKeysScreen key="k" orgId="o1" />, "Couldn't load private keys"],
  ] as const) {
    it(`${page}: names what failed as the page's one heading and in the tab`, () => {
      mount(element);
      expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([title]);
      expect(document.title).toBe(`${title} · Forge`);
      expect(screen.queryByRole("heading", { name: "Couldn't load" })).toBeNull();
      expect(screen.getByText(page)).toBeTruthy();
    });
  }
});
