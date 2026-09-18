// @vitest-environment jsdom
//
// ISS-1097 — which of the three toast paths takes the status word.
//
// `requestTransition` confirms a move three different ways and only one of them
// is reporting a status: the default. The other two report an ACTION a person
// took ("Information requested") or carry a caller's own sentence ("Issue
// resumed"), and replacing either with a status word loses what the toast is
// for. So this file pins all three, not just the one that changed.

import { cleanup, renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueStatus } from "../types";

const toast = vi.fn();
const mutate = vi.fn();

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));
vi.mock("../hooks", () => ({
  useTransitionIssue: () => ({ mutate, isPending: false }),
}));

const { useGuardedTransition } = await import("./use-guarded-transition");

afterEach(() => {
  cleanup();
  toast.mockClear();
  mutate.mockClear();
});

/** Fire a move and return the title the success toast carried. */
function movedTo(status: IssueStatus, opts?: { successMessage?: string }): string {
  const { result } = renderHook(() => useGuardedTransition());
  act(() => result.current.requestTransition("id", status, opts));
  const call = mutate.mock.calls.at(-1);
  if (!call) throw new Error("the transition was never fired");
  act(() => call[1].onSuccess());
  return toast.mock.calls.at(-1)?.[0]?.title ?? "";
}

describe("the default success toast", () => {
  // cm:guard the reported shape: `developed`, `testing` and `releasing` are three different things
  // that happened, and the lane word called all three "Running".
  it("names the kernel status the issue moved to", () => {
    expect(movedTo("developed")).toBe("Moved to Developed");
    expect(movedTo("testing")).toBe("Moved to Testing");
    expect(movedTo("releasing")).toBe("Moved to Releasing");
  });

  it("gives three statuses the lane folds together three different sentences", () => {
    const said = ["in_progress", "developed", "releasing"].map((s) =>
      movedTo(s as IssueStatus),
    );
    expect(new Set(said).size).toBe(3);
    expect(said.some((t) => t.includes("Running"))).toBe(false);
  });
});

describe("the two paths that deliberately do NOT name a status", () => {
  // cm:guard a reason-required move is confirmed by what the person did, and ISS-1097 left it so.
  // This case is here to fail if a later change widens the status word across all three paths.
  it("keeps the reason-required move's own action wording", () => {
    const { result } = renderHook(() => useGuardedTransition());
    act(() => result.current.requestTransition("id", "needs_info"));
    // The reason dialog owns the write, so nothing is fired and no toast is shown yet.
    expect(mutate).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    // Confirm through the dialog the hook returned, which is the real second half of this path.
    const dialog = result.current.dialog as { props: { onConfirm: (r: string) => void } };
    act(() => dialog.props.onConfirm("because a person has to look"));
    const call = mutate.mock.calls.at(-1);
    if (!call) throw new Error("the confirmed transition was never fired");
    act(() => call[1].onSuccess());
    const said = toast.mock.calls.at(-1)?.[0]?.title ?? "";
    expect(said).toBe("Information requested");
    expect(said).not.toMatch(/Moved to/);
    expect(said).not.toContain("Needs info");
  });

  it("gives each reason-required move its own action sentence, none of them a status word", () => {
    const said = (["reopen", "waiting", "needs_info"] as const).map((s) => {
      const { result } = renderHook(() => useGuardedTransition());
      act(() => result.current.requestTransition("id", s));
      const dialog = result.current.dialog as { props: { onConfirm: (r: string) => void } };
      act(() => dialog.props.onConfirm("a reason"));
      const call = mutate.mock.calls.at(-1);
      if (!call) throw new Error("no transition fired");
      act(() => call[1].onSuccess());
      return toast.mock.calls.at(-1)?.[0]?.title ?? "";
    });
    expect(new Set(said).size).toBe(3);
    expect(said.some((t) => t.startsWith("Moved to"))).toBe(false);
  });

  it("lets a caller's own success message through untouched", () => {
    expect(movedTo("open", { successMessage: "Issue resumed" })).toBe("Issue resumed");
  });
});
