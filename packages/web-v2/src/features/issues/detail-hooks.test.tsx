// @vitest-environment jsdom
//
// ISS-1327 — the issue screen is opened by its display key (ISS-1160), and every invalidation of
// one issue — the rail's Mark merged and Unmark, the WS router — names the row's uuid. Read under
// the display key alone, the screen never refreshed after a mark, which is what invited the second
// press that dropped a corrected landing. The key and the uuid differ here on purpose: were they
// equal, this would pass against the defect.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const UUID = "5fb7e758-e403-4568-bebb-b568260ff175";
const DISPLAY_KEY = "ISS-5";
const PROJECT = "11111111-1111-4111-8111-111111111111";
const LANDING = "https://mowmentbrand.com/products/linen-tee";

/** What the server holds; the mocked API reads and writes it. */
const server = { mergedAt: null as string | null, mergedLanding: null as string | null };
const toast = vi.fn();

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

vi.mock("./detail-api", () => ({
  issueDetailApi: {
    get: vi.fn(async (id: string) => {
      if (id !== UUID && id !== DISPLAY_KEY) throw new Error(`unexpected id ${id}`);
      return { id: UUID, displayId: DISPLAY_KEY, ...server };
    }),
  },
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    issuesApi: {
      ...actual.issuesApi,
      markMerged: vi.fn(async (_id: string, body: { landing?: string }) => {
        // The first mark stands: the same landing re-sent moves nothing.
        if (server.mergedAt) return { id: UUID, action: "already_merged" as const };
        server.mergedAt = "2026-09-29T18:10:53.405Z";
        server.mergedLanding = body.landing ?? null;
        return { id: UUID, action: "merged" as const };
      }),
      unmarkMerged: vi.fn(async () => {
        server.mergedAt = null;
        server.mergedLanding = null;
        return { id: UUID, action: "unmarked" as const };
      }),
    },
  };
});

const { useIssue } = await import("./detail-hooks");
const { useMergeMarker } = await import("./hooks");

afterEach(() => {
  cleanup();
  toast.mockReset();
  server.mergedAt = null;
  server.mergedLanding = null;
});

function Probe() {
  const issueQ = useIssue(DISPLAY_KEY, PROJECT);
  // The rail is handed the row's uuid, exactly as `properties-rail.tsx` passes `issue.id`.
  const marker = useMergeMarker(issueQ.data?.id ?? "");
  if (!issueQ.data) return <p>loading</p>;
  return (
    <div>
      <p data-testid="merged">{issueQ.data.mergedAt ? `landed ${issueQ.data.mergedLanding}` : "unmarked"}</p>
      <button type="button" onClick={() => marker.mark({ landing: LANDING })}>
        mark
      </button>
      <button type="button" onClick={() => marker.unmark()}>
        unmark
      </button>
    </div>
  );
}

function mount(): void {
  // The app's own staleness: an entry nobody invalidates is not refetched for a minute.
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
  const wrap = (node: ReactNode) => <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
  render(wrap(<Probe />));
}

describe("the issue screen opened by its display key refreshes on the uuid's invalidations", () => {
  it("shows the mark as soon as Mark merged is answered, without a reload", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("merged")).toHaveTextContent("unmarked"));
    await act(async () => screen.getByRole("button", { name: "mark" }).click());
    await waitFor(() => expect(screen.getByTestId("merged")).toHaveTextContent(`landed ${LANDING}`));
  });

  it("shows the mark gone as soon as Unmark is answered, without a reload", async () => {
    server.mergedAt = "2026-09-29T18:10:53.405Z";
    server.mergedLanding = LANDING;
    mount();
    await waitFor(() => expect(screen.getByTestId("merged")).toHaveTextContent("landed"));
    await act(async () => screen.getByRole("button", { name: "unmark" }).click());
    await waitFor(() => expect(screen.getByTestId("merged")).toHaveTextContent("unmarked"));
  });

  it("says nothing changed, and names Unmark, when the answer is already_merged", async () => {
    server.mergedAt = "2026-09-29T18:10:53.405Z";
    server.mergedLanding = LANDING;
    mount();
    await waitFor(() => expect(screen.getByTestId("merged")).toHaveTextContent("landed"));
    await act(async () => screen.getByRole("button", { name: "mark" }).click());
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const shown = toast.mock.calls.at(-1)?.[0] as { title: string; description?: string };
    expect(shown.title).toContain("nothing changed");
    expect(shown.description).toContain("Unmark");
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Marked merged" }));
  });
});
