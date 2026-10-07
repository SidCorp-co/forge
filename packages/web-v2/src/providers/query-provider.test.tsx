// A write settles when core answers it, not when the waiting-on-you counts it refreshes have been
// read again: the counts took ~5 s on dev, and the New issue form held its spinner that long after
// a 201, open to a second submit that would file a duplicate (HOP ISS-125, 2026-10-07).

import { useMutation, useQuery } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NEEDS_YOU_ROOT } from "@/features/needs-you/hooks";
import { apiClient } from "@/lib/api/client";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";
import { createQueryClient } from "./query-provider";

afterEach(() => vi.unstubAllGlobals());

function Probe() {
  useQuery({ queryKey: [...NEEDS_YOU_ROOT, "p1"], queryFn: () => apiClient("/projects/p1/needs-you") });
  const write = useMutation({ mutationFn: () => apiClient("/projects/p1/things", { method: "POST", body: "{}" }) });
  return (
    <button type="button" onClick={() => write.mutate()}>
      {write.status}
    </button>
  );
}

describe("the app's query client", () => {
  it("settles a write on core's answer while the counts it re-reads are still in flight, and still re-reads them", async () => {
    let reads = 0;
    const calls = fakeCore((c) => {
      if (c.method === "POST") return { status: 201, body: { id: "t1" } };
      if (c.path === "/projects/p1/needs-you") return ++reads === 1 ? { body: { items: [] } } : HANG;
      return undefined;
    });
    renderWithQuery(<Probe />, createQueryClient());
    await waitFor(() => expect(reads).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "idle" }));
    await screen.findByRole("button", { name: "success" });
    expect(reads).toBe(2);
    expect(calls.filter((c) => c.path === "/projects/p1/needs-you")).toHaveLength(2);
  });
});
