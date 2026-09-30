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

// ISS-1310 — the two ways out of a park that leave its question unanswered each ask why.
describe("TransitionReasonDialog, leaving a park without the answer", () => {
  it("sends Move anyway only once a target is picked and a reason is typed", () => {
    const onConfirm = vi.fn();
    render(
      <TransitionReasonDialog
        status="move_anyway"
        targets={["open", "in_progress", "needs_info", "on_hold", "dropped"]}
        loading={false}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    const move = () => screen.getByRole("button", { name: "Move" });
    expect(move()).toBeDisabled();
    fireEvent.click(screen.getByLabelText("In progress"));
    expect(move()).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "settled on the call" } });
    expect(move()).toBeEnabled();
    fireEvent.click(move());
    expect(onConfirm).toHaveBeenCalledWith("settled on the call", undefined, "in_progress");
  });

  it("lists every target it was given, unchanged", () => {
    const targets = ["open", "in_progress", "needs_info", "on_hold", "dropped"] as const;
    render(
      <TransitionReasonDialog
        status="move_anyway"
        targets={[...targets]}
        loading={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("radio")).toHaveLength(targets.length);
  });

  it("refuses Not needed until a reason is typed", () => {
    const onConfirm = vi.fn();
    render(
      <TransitionReasonDialog status="not_needed" loading={false} onConfirm={onConfirm} onClose={vi.fn()} />,
    );
    const send = () => screen.getByRole("button", { name: /Withdraw it and resume/ });
    expect(send()).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(send()).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "decided in standup" } });
    fireEvent.click(send());
    expect(onConfirm).toHaveBeenCalledWith("decided in standup", undefined);
  });
});

describe("TransitionReasonDialog's words for leaving without the answer", () => {
  it.each(["move_anyway", "not_needed"] as const)("%s speaks no kernel word — park, rung", (status) => {
    const { container } = render(
      <TransitionReasonDialog
        status={status}
        targets={["open", "in_progress"]}
        loading={false}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const said = `${document.body.textContent ?? ""} ${container.textContent ?? ""}`;
    expect(said).not.toMatch(/\b(park|parked|rung|decision round)\b/i);
  });
});
