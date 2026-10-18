// @vitest-environment jsdom
//
// ISS-1421 round 7 — a Mark merged whose commit carries the one the mark held moves the landing,
// and the notice says so, naming both commits; it never says nothing changed.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const ISSUE = "5fb7e758-e403-4568-bebb-b568260ff175";
const MOVED =
  "The landing moved from commit 1a1a1a1 to commit 2b2b2b2, which carries it. Forge saw this merge land at commit 2b2b2b2.";

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

let answer: Record<string, unknown> = {};
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, issuesApi: { ...actual.issuesApi, markMerged: vi.fn(async () => answer) } };
});

const { useMergeMarker } = await import("./hooks");

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

async function markOnce() {
  toast.mockClear();
  const { result } = renderHook(() => useMergeMarker(ISSUE), { wrapper });
  act(() => result.current.mark({ target: "main" }));
  await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
  return toast.mock.calls[0]?.[0] as { title: string; description?: string };
}

describe("the notice after Mark merged", () => {
  it("says the landing moved, naming both commits, where the mark moved forward", async () => {
    answer = { id: ISSUE, action: "merged", mark: "observed", detail: MOVED, movedFrom: "1a1a1a1" };
    const said = await markOnce();
    expect(said.title).toBe("Landing moved");
    expect(said.description).toBe(MOVED);
    expect(said.title).not.toContain("nothing changed");
  });

  it("still says nothing changed where the mark moved nothing, with the answer's reason", async () => {
    const unread =
      "Already marked merged on 16 Oct 2026, so this call changed nothing. Commit 2b2b2b2 was not compared with commit 1a1a1a1, so the landing stays at 1a1a1a1. The reason:\n> SidCorp-co/forge could not compare";
    answer = { id: ISSUE, action: "already_merged", mark: "observed", detail: unread, movedFrom: null };
    const said = await markOnce();
    expect(said.title).toBe("Already marked merged — nothing changed");
    // The title already says nothing changed; the description is the reason, its quote inline.
    expect(said.description).toBe(
      "Commit 2b2b2b2 was not compared with commit 1a1a1a1, so the landing stays at 1a1a1a1. The reason: SidCorp-co/forge could not compare",
    );
  });

  it("says Marked merged on a first mark", async () => {
    answer = { id: ISSUE, action: "merged", mark: "observed", detail: "x", movedFrom: null };
    expect((await markOnce()).title).toBe("Marked merged");
  });
});
