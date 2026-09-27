// @vitest-environment jsdom
//
// ISS-1257 — a close or drop refused because questions on the issue are still
// open asks the person why they died with the work, then sends the same move
// again carrying that sentence as `voidQuestions`.

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

for (const target of ["closed", "dropped"] as const) {
  describe(`a ${target} move held up by open questions`, () => {
    it("opens the withdraw dialog, then resends the same move with the person's sentence", () => {
      const { result } = renderHook(() => useGuardedTransition());
      act(() => result.current.requestTransition("iss-1", target));
      const first = mutate.mock.calls.at(-1);
      if (!first) throw new Error("the move was never sent");
      expect(first[0]).toEqual({ id: "iss-1", toStatus: target });

      act(() => first[1].onOpenQuestions(["q-1", "q-2"]));
      const dialog = result.current.dialog as Dialog;
      expect(dialog.props.status).toBe("void_questions");
      expect(dialog.props.openQuestions).toBe(2);

      act(() => dialog.props.onConfirm("the fix shipped without the tenant answer"));
      const second = mutate.mock.calls.at(-1);
      expect(second?.[0]).toEqual({
        id: "iss-1",
        toStatus: target,
        voidQuestions: "the fix shipped without the tenant answer",
      });
      act(() => second?.[1].onSuccess());
      expect(toast.mock.calls.at(-1)?.[0]?.tone).toBe("success");
    });
  });
}
