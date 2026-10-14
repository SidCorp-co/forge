// @vitest-environment jsdom
//
// ISS-1251 — every surface that puts an issue on hold goes through `requestTransition`, and a hold
// is entered with a reason: nothing is sent until the dialog confirms one, and what is sent carries it.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

type Dialog = { props: { status: string | null; onConfirm: (reason: string) => void } };

describe("requestTransition into on_hold", () => {
  it("sends no move and opens the reason dialog for a hold", () => {
    const { result } = renderHook(() => useGuardedTransition());
    act(() => result.current.requestTransition("iss-1", "on_hold"));
    expect(mutate).not.toHaveBeenCalled();
    expect((result.current.dialog as Dialog).props.status).toBe("on_hold");
  });

  it("sends the typed reason with the hold, and says the issue was put on hold", () => {
    const { result } = renderHook(() => useGuardedTransition());
    act(() => result.current.requestTransition("iss-1", "on_hold"));
    act(() => (result.current.dialog as Dialog).props.onConfirm("waiting for the migration window"));
    const call = mutate.mock.calls.at(-1);
    expect(call?.[0]).toEqual({
      id: "iss-1",
      toStatus: "on_hold",
      reason: "waiting for the migration window",
    });
    act(() => call?.[1].onSuccess());
    expect(toast.mock.calls.at(-1)?.[0]?.title).toBe("Issue put on hold");
  });

  it("still sends a move that needs no reason straight away", () => {
    const { result } = renderHook(() => useGuardedTransition());
    act(() => result.current.requestTransition("iss-1", "developed"));
    expect(mutate.mock.calls.at(-1)?.[0]).toEqual({ id: "iss-1", toStatus: "developed" });
  });
});
