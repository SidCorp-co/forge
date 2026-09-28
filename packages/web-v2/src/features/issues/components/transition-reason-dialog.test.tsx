// @vitest-environment jsdom
//
// ISS-1257 — a close that withdraws open questions is one move. A second click on the confirm,
// landing before the mutation reports it is pending, sent a second move that came back
// STALE_TRANSITION and could leave the dialog open over a close that had already landed.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransitionReasonDialog } from "./transition-reason-dialog";

expect.extend(matchers);
afterEach(cleanup);

function open(onConfirm = vi.fn(), loading = false) {
  const view = render(
    <TransitionReasonDialog
      status="void_questions"
      openQuestions={1}
      loading={loading}
      onConfirm={onConfirm}
      onClose={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "the fix shipped without it" } });
  return { onConfirm, view };
}

const confirm = () => screen.getByRole("button", { name: /Withdraw them and continue/ });

describe("TransitionReasonDialog's confirm", () => {
  it("sends one move for a double click", () => {
    const { onConfirm } = open();
    fireEvent.click(confirm());
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("the fix shipped without it", undefined);
    expect(confirm()).toBeDisabled();
  });

  it("can be sent again once a refused move has stopped loading", () => {
    const onConfirm = vi.fn();
    const { view } = open(onConfirm);
    fireEvent.click(confirm());
    const rerender = (loading: boolean) =>
      view.rerender(
        <TransitionReasonDialog
          status="void_questions"
          openQuestions={1}
          loading={loading}
          onConfirm={onConfirm}
          onClose={vi.fn()}
        />,
      );
    rerender(true);
    rerender(false);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
