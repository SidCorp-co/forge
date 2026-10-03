// @vitest-environment jsdom
//
// ISS-1257 — a close or drop refused because questions on the issue are still
// open asks the person why they died with the work, then sends the same move
// again carrying that sentence as `voidQuestions` (and, for a drop, its own reason).

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

type Dialog = {
  props: { status: string | null; openQuestions?: number; onConfirm: (r: string) => void };
};

describe("a closed move held up by open questions", () => {
  it("opens the withdraw dialog, then resends the same move with the person's sentence", () => {
    const { result } = renderHook(() => useGuardedTransition());
    act(() => result.current.requestTransition("iss-1", "closed"));
    const first = mutate.mock.calls.at(-1);
    if (!first) throw new Error("the move was never sent");
    expect(first[0]).toEqual({ id: "iss-1", toStatus: "closed" });

    act(() => first[1].onOpenQuestions(["q-1", "q-2"]));
    const dialog = result.current.dialog as Dialog;
    expect(dialog.props.status).toBe("void_questions");
    expect(dialog.props.openQuestions).toBe(2);

    act(() => dialog.props.onConfirm("the fix shipped without the tenant answer"));
    const second = mutate.mock.calls.at(-1);
    expect(second?.[0]).toEqual({
      id: "iss-1",
      toStatus: "closed",
      voidQuestions: "the fix shipped without the tenant answer",
    });
    act(() => second?.[1].onSuccess());
    expect(toast.mock.calls.at(-1)?.[0]?.tone).toBe("success");
  });
});

// ISS-54 — a drop needs a reason of its own, so it is asked for first; the withdrawal then resends
// the move with that reason as well as the withdrawal's sentence, or the server refuses it again.
describe("a dropped move held up by open questions", () => {
  it("asks why first, then opens the withdraw dialog, then resends the move with both sentences", () => {
    const { result } = renderHook(() => useGuardedTransition());
    act(() => result.current.requestTransition("iss-1", "dropped"));
    expect(mutate).not.toHaveBeenCalled();
    const ask = result.current.dialog as Dialog;
    expect(ask.props.status).toBe("dropped");

    act(() => ask.props.onConfirm("superseded by ISS-9"));
    const first = mutate.mock.calls.at(-1);
    if (!first) throw new Error("the move was never sent");
    expect(first[0]).toEqual({ id: "iss-1", toStatus: "dropped", reason: "superseded by ISS-9" });

    act(() => first[1].onOpenQuestions(["q-1", "q-2"]));
    const dialog = result.current.dialog as Dialog;
    expect(dialog.props.status).toBe("void_questions");
    expect(dialog.props.openQuestions).toBe(2);

    act(() => dialog.props.onConfirm("moot once it is superseded"));
    const second = mutate.mock.calls.at(-1);
    expect(second?.[0]).toEqual({
      id: "iss-1",
      toStatus: "dropped",
      voidQuestions: "moot once it is superseded",
      reason: "superseded by ISS-9",
    });
    act(() => second?.[1].onSuccess());
    expect(toast.mock.calls.at(-1)?.[0]?.tone).toBe("success");
  });
});
