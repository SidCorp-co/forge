// @vitest-environment jsdom
//
// ISS-1229 r50, judge-152 on criteria 451 and 481: with the stored active organization's read answering 500, the
// app fell to the personal workspace with nothing saying the read failed, so /projects listed Personal's projects
// as if the person had switched. A stand-in may show, but every page says the read failed, names what is shown
// instead, and offers Retry where a second read can change the answer (criterion 500).

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { ToastProvider } from "@/providers/toast-provider";
import { ActiveOrgProvider, useActiveOrg } from "./active-org";
import { StoredOrgUnread } from "./components/stored-org-unread";
import type { OrgListItem } from "./types";

expect.extend(matchers);

const org = (id: string, name: string, isPersonal = false): OrgListItem => ({
  id,
  slug: id,
  name,
  isPersonal,
  role: "owner",
  createdAt: "2026-10-01T00:00:00.000Z",
});
const PERSONAL = org("me", "", true);
const QA = org("org-qa", "QA J152 org");

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("./hooks", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return { useOrgs: () => useQuery({ queryKey: ["orgs"], queryFn: async () => [PERSONAL, QA] }) };
});

let preferencesAnswer: () => Promise<{ theme: string; language: string; activeOrgId: string | null }>;
vi.mock("@/features/settings/hooks", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    usePreferences: () => useQuery({ queryKey: ["settings", "preferences"], queryFn: () => preferencesAnswer() }),
  };
});
vi.mock("@/features/settings/api", () => ({ settingsApi: { updatePreferences: vi.fn() } }));

function Shown() {
  const { activeOrg, scopeRead } = useActiveOrg();
  return <p data-testid="shown">{scopeRead ? (activeOrg?.isPersonal ? "Personal" : activeOrg?.name) : "unread"}</p>;
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <ActiveOrgProvider>
          <StoredOrgUnread />
          <Shown />
        </ActiveOrgProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  preferencesAnswer = async () => {
    throw new ApiError(500, "");
  };
});
afterEach(cleanup);

describe("the stored active organization, where it cannot be read (criterion 500)", () => {
  it("says the read failed and names the organization shown in its place, with Retry", async () => {
    mount();
    const line = await screen.findByTestId("stored-org-unread");
    expect(line).toHaveTextContent(
      "Couldn't load which organization you were working in, so Personal is shown until it loads or you pick one.",
    );
    expect(line).toHaveTextContent("The server ran into a problem and could not finish the request.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("reads it again on Retry, and leaves the line once the stored organization answers", async () => {
    mount();
    await screen.findByTestId("stored-org-unread");
    preferencesAnswer = async () => ({ theme: "system", language: "en", activeOrgId: QA.id });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    await waitFor(() => expect(screen.queryByTestId("stored-org-unread")).toBeNull());
    expect(screen.getByTestId("shown")).toHaveTextContent("QA J152 org");
  });

  it("offers no Retry where the read was refused for good, and still says it failed", async () => {
    preferencesAnswer = async () => {
      throw new ApiError(403, "You do not have access to this.");
    };
    mount();
    const line = await screen.findByTestId("stored-org-unread");
    expect(line).toHaveTextContent("You do not have access to this.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows no line where the stored organization answered", async () => {
    preferencesAnswer = async () => ({ theme: "system", language: "en", activeOrgId: QA.id });
    mount();
    await waitFor(() => expect(screen.getByTestId("shown")).toHaveTextContent("QA J152 org"));
    expect(screen.queryByTestId("stored-org-unread")).toBeNull();
  });
});
