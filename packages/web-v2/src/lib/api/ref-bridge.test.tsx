// A page reads by the slug or display key it holds and switches to the uuid once it is known:
// what it already read, or is still reading, moves with it, and a live change that named the uuid
// in between is not lost on the way.
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { INVALIDATE_WINDOW_MS, scheduleInvalidation } from "@/lib/ws/invalidation-coalescer";
import { bridgeQueries, noteInvalidated } from "./ref-bridge";

const ID = "3f0c2a9e-6a51-4f7e-9d3c-0b6f1e2a7c11";
const bySlug = (segment: unknown) => (segment === "forge" ? ID : undefined);

describe("handing reads from a slug to its uuid", () => {
  it("moves an answer with its age, and sends nothing", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    qc.setQueryData(["requirements", "forge"], { rows: 1 }, { updatedAt: 1234 });
    expect(bridgeQueries(qc, bySlug)).toBe(1);
    expect(qc.getQueryData(["requirements", ID])).toEqual({ rows: 1 });
    expect(qc.getQueryState(["requirements", ID])?.dataUpdatedAt).toBe(1234);
  });

  it("hands over a read still in flight instead of sending it again", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    let answer: (v: unknown) => void = () => {};
    const sent = vi.fn(() => new Promise((r) => (answer = r)));
    void qc.prefetchQuery({ queryKey: ["needs-you", "forge"], queryFn: sent });
    bridgeQueries(qc, bySlug);
    const viaUuid = vi.fn(async () => "second read");
    const read = qc.fetchQuery({ queryKey: ["needs-you", ID], queryFn: viaUuid });
    answer({ items: [] });
    expect(await read).toEqual({ items: [] });
    expect(sent).toHaveBeenCalledTimes(1);
    expect(viaUuid).not.toHaveBeenCalled();
  });

  it("renames the slug inside a plain-object segment too, and keeps a read the uuid already has", () => {
    const qc = new QueryClient();
    qc.setQueryData(["comments", { issue: "ISS-7", project: "forge" }], ["slug's"]);
    qc.setQueryData(["releases", "forge"], ["slug's"]);
    qc.setQueryData(["releases", ID], ["uuid's own"]);
    bridgeQueries(qc, (s) =>
      s === "forge" ? ID : typeof s === "object" && s && (s as { project?: string }).project === "forge" ? { ...(s as object), project: ID } : undefined,
    );
    expect(qc.getQueryData(["comments", { issue: "ISS-7", project: ID }])).toEqual(["slug's"]);
    expect(qc.getQueryData(["releases", ID])).toEqual(["uuid's own"]);
  });

  it("marks a handed-over answer stale when a live change named its uuid before the switch", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
    qc.setQueryData(["projects", "forge", "runners"], []);
    qc.setQueryData(["requirements", "forge"], []);
    noteInvalidated(qc, ["projects", ID]);
    bridgeQueries(qc, bySlug);
    expect(qc.getQueryState(["projects", ID, "runners"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["requirements", ID])?.isInvalidated).toBe(false);
  });

  it("does not hand over a read in flight that a live change has since overtaken", () => {
    const qc = new QueryClient();
    void qc.prefetchQuery({ queryKey: ["issue", "forge"], queryFn: () => new Promise(() => {}) });
    noteInvalidated(qc, ["issue", ID]);
    expect(bridgeQueries(qc, bySlug)).toBe(0);
    expect(qc.getQueryCache().find({ queryKey: ["issue", ID], exact: true })).toBeUndefined();
  });

  it("remembers a live change the socket delivered while no read sat under its uuid", async () => {
    vi.useFakeTimers();
    try {
      const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } });
      qc.setQueryData(["issue", "forge"], {});
      scheduleInvalidation(qc, ["issue", ID]);
      await vi.advanceTimersByTimeAsync(INVALIDATE_WINDOW_MS + 10);
      bridgeQueries(qc, bySlug);
      expect(qc.getQueryState(["issue", ID])?.isInvalidated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
