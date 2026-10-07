// The New requirement form shares the New issue form's shape (HOP ISS-125): it is done when core
// answers the create, not when the requirement list or the waiting-on-you counts have been read
// again, and two submits in one tick send one create.

import { useQuery } from "@tanstack/react-query";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NEEDS_YOU_ROOT } from "@/features/needs-you/hooks";
import { apiClient } from "@/lib/api/client";
import { createQueryClient } from "@/providers/query-provider";
import { type Call, fakeCore, HANG, renderWithQuery } from "@/test/render";
import { useRequirements } from "../hooks";
import { CreateRequirementForm } from "./requirements-screen";

afterEach(() => vi.unstubAllGlobals());

/** The list and the menu's counts, mounted beside the form the way the screen and the shell mount them. */
function Reads() {
  useRequirements("p1");
  useQuery({ queryKey: [...NEEDS_YOU_ROOT, "p1"], queryFn: () => apiClient("/projects/p1/needs-you") });
  return null;
}

/** Each read answers once, then never again; the create answers at once, or never with `hold`. */
function core({ hold = false } = {}) {
  const seen = new Map<string, number>();
  return fakeCore((c: Call) => {
    if (c.method === "POST") return hold ? HANG : { status: 201, body: { key: "REQ-7" } };
    const n = (seen.get(c.path) ?? 0) + 1;
    seen.set(c.path, n);
    if (c.path === "/projects/p1/requirements") return n === 1 ? { body: { requirements: [], returned: 0 } } : HANG;
    if (c.path === "/projects/p1/needs-you") return n === 1 ? { body: { items: [] } } : HANG;
    return undefined;
  });
}

function mount(onDone = vi.fn()) {
  renderWithQuery(
    <>
      <Reads />
      <CreateRequirementForm projectId="p1" onDone={onDone} />
    </>,
    createQueryClient(),
  );
  fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Staff open the root page" } });
  return onDone;
}

describe("the New requirement form", () => {
  it("is done with the new key once core answers, while the list and the counts are still being re-read", async () => {
    const calls = core();
    const onDone = mount();
    await waitFor(() => expect(calls.filter((c) => c.method === "GET")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Create requirement" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("REQ-7"));
  });

  it("sends one create for two submits in one tick", async () => {
    const calls = core({ hold: true });
    mount();
    const form = screen.getByTestId("requirement-create");
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole("button", { name: /Create requirement/ })).toBeDisabled());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});
