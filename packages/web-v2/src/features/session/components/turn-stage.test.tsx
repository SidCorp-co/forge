// @vitest-environment jsdom
//
// ISS-1083 — what a turn says about itself while it is running, and the one rule both surfaces read
// it by. Before this, the session screen drew a mascot card reading "Agent is working…" under prose
// the agent had already written, and the chat panel drew the same card only in the gap before the
// first frame and then nothing at all for the rest of the turn.
//
// Matchers are extended on vitest's OWN `expect` for the reason `thinking-line.test.tsx` gives.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@/features/chat/components/chat-composer";
import type { RenderBlock } from "../types";
import { QUIET_HOLD, TurnStage, sessionActivity, sessionComposerState, sessionTurnStage, turnStageOf } from "./turn-stage";

expect.extend(matchers);

afterEach(cleanup);

const text = (t = "Two issues left."): RenderBlock => ({ type: "text", text: t });
const tool = (): RenderBlock => ({ type: "tool", tool: { id: "t1", name: "forge_issues" } });
const thinking = (): RenderBlock => ({ type: "thinking", count: 1 });

describe("the stage a turn is in", () => {
  // Criterion 15. This is the case the whole component exists for: `parseMessages` drops an entry
  // carrying nothing, so a turn that has been dispatched and has emitted nothing renders NO blocks
  // at all, and without this line the thread showed the question and then blank space.
  it("says a turn that has produced nothing is working", () => {
    expect(turnStageOf({ live: true, blocks: [] })).toBe("working");
    expect(turnStageOf({ live: true })).toBe("working");
  });

  // Criterion 16's line at the turn's own scale: the card says `Running…` for the call, and the
  // turn says it is working rather than claiming to be writing.
  it("says a turn whose tail is a tool call is working", () => {
    expect(turnStageOf({ live: true, blocks: [tool()] })).toBe("working");
  });

  it("says a turn whose tail is prose is responding", () => {
    expect(turnStageOf({ live: true, blocks: [text()] })).toBe("responding");
  });

  it("says a turn paused to think is working", () => {
    expect(turnStageOf({ live: true, blocks: [thinking()] })).toBe("working");
  });

  it("reads the tail rather than whether the turn has written anything at all", () => {
    expect(turnStageOf({ live: true, blocks: [text(), tool()] })).toBe("working");
    expect(turnStageOf({ live: true, blocks: [text(), tool(), text("Here it is.")] })).toBe(
      "responding",
    );
  });

  // Criterion 19.
  it("says a failed turn failed instead of leaving a working line running", () => {
    expect(turnStageOf({ live: true, failed: true, blocks: [tool()] })).toBe("failed");
    expect(turnStageOf({ failed: true })).toBe("failed");
  });

  it("says nothing at all about a turn that has settled", () => {
    expect(turnStageOf({ live: false, blocks: [text()] })).toBeNull();
    expect(turnStageOf({})).toBeNull();
    expect(turnStageOf({ blocks: [text(), tool()] })).toBeNull();
  });
});

describe("what a runner session's newest turn says", () => {
  const agent = { kind: "agent" as const, blocks: [text()] };

  it("says a running session's newest turn is responding to what it is writing", () => {
    expect(sessionTurnStage({ live: true, display: "running", tail: agent })).toBe("responding");
  });

  // Criterion 15 on this surface: a session that has just started has no items at all, so the
  // screen renders no thread and the line is the only thing that says anything.
  it("says a session that has started and produced nothing is working", () => {
    expect(sessionTurnStage({ live: true, display: "running" })).toBe("working");
  });

  // A session whose heartbeat is overdue is still running, but nobody has heard it working: the
  // line says it is quiet rather than spinning a working line over the silence.
  it("says a session whose heartbeat has lapsed is quiet, whatever its transcript holds", () => {
    expect(sessionTurnStage({ live: true, display: "stalled" })).toBe("quiet");
    expect(sessionTurnStage({ live: true, display: "stalled", tail: agent })).toBe("quiet");
    expect(sessionTurnStage({ live: true, display: "stalled", fromMessages: true })).toBe("quiet");
  });

  // Criterion 19. `live` is false by the time the status is failed, which is exactly why the failed
  // stage cannot be read off liveness: with only `live` there would be no line here at all.
  it("says a failed session's turn failed", () => {
    expect(sessionTurnStage({ live: false, display: "failed", tail: agent })).toBe("failed");
  });

  it("says nothing over a session a person stopped themselves", () => {
    expect(sessionTurnStage({ live: false, display: "cancelled" })).toBeNull();
    expect(sessionTurnStage({ live: false, display: "cancelled_stale" })).toBeNull();
    expect(sessionTurnStage({ live: false, display: "completed", tail: agent })).toBeNull();
  });

  it("says a live session on the messages fallback is working, whatever its transcript holds", () => {
    expect(sessionTurnStage({ live: true, display: "running", fromMessages: true })).toBe("working");
    expect(
      sessionTurnStage({ live: true, display: "running", fromMessages: true, tail: agent }),
    ).toBe("working");
    expect(
      sessionTurnStage({ live: false, display: "failed", fromMessages: true, tail: agent }),
    ).toBe("failed");
  });

  it("reads no blocks off a turn that is the person's own question", () => {
    expect(
      sessionTurnStage({
        live: true,
        display: "running",
        tail: { kind: "prompt", blocks: [] },
      }),
    ).toBe("working");
  });
});

describe("the line a reader sees", () => {
  it("says which stage it is, and carries the stage for a test to read", () => {
    render(<TurnStage stage="working" />);
    const line = screen.getByTestId("turn-stage");
    expect(line).toHaveTextContent("Working…");
    expect(line).toHaveAttribute("data-stage", "working");
  });

  it("spins nothing on a quiet session, and says what it last reported and how long ago", () => {
    render(<TurnStage stage="quiet" elapsed="31m" silentForMs={101_000} />);
    const line = screen.getByTestId("turn-stage");
    expect(line).toHaveTextContent("Quiet · last reported working 1m ago");
    expect(line).not.toHaveTextContent("Working…");
    expect(line).toHaveAttribute("data-stage", "quiet");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says a quiet session's line without a time where none was measured", () => {
    render(<TurnStage stage="quiet" />);
    expect(screen.getByTestId("turn-stage")).toHaveTextContent(/^Quiet · last reported working$/);
  });

  it("spins while the turn is running and does not once it has failed", () => {
    const { rerender } = render(<TurnStage stage="responding" />);
    expect(screen.getByTestId("turn-stage")).toHaveTextContent("Responding…");
    expect(screen.queryByRole("status")).not.toBeNull();

    rerender(<TurnStage stage="failed" />);
    expect(screen.getByTestId("turn-stage")).toHaveTextContent("Failed");
    expect(screen.queryByRole("status")).toBeNull();
  });

  // Criterion 17, asserted as NODE IDENTITY rather than as a position: React keeps the same element
  // across these three renders only if the three stages are one component drawing one line. Two
  // components, or a conditional wrapper, and the line a reader is watching is removed from the
  // document and a different one is inserted — which is the jump this criterion refuses.
  it("holds one position for the whole turn", () => {
    const { rerender } = render(<TurnStage stage="working" />);
    const first = screen.getByTestId("turn-stage");
    rerender(<TurnStage stage="responding" />);
    expect(screen.getByTestId("turn-stage")).toBe(first);
    rerender(<TurnStage stage="failed" />);
    expect(screen.getByTestId("turn-stage")).toBe(first);
  });

  it("keeps the icon slot the same width whichever stage it holds", () => {
    const { rerender } = render(<TurnStage stage="working" />);
    const slot = () => screen.getByTestId("turn-stage").firstElementChild;
    const working = slot()?.getAttribute("class") ?? "";
    rerender(<TurnStage stage="failed" />);
    expect(slot()?.getAttribute("class")).toBe(working);
    expect(working).toMatch(/w-\[14px\]/);
  });

  it("shows the clock it is given and nothing where it is given none", () => {
    const { rerender } = render(<TurnStage stage="working" elapsed="1m 12s" />);
    expect(screen.getByTestId("turn-stage")).toHaveTextContent("1m 12s");
    rerender(<TurnStage stage="working" />);
    expect(screen.getByTestId("turn-stage").textContent).toBe("Working…");
  });

  it("is announced without stealing focus", () => {
    render(<TurnStage stage="working" />);
    expect(screen.getByTestId("turn-stage")).toHaveAttribute("aria-live", "polite");
  });
});

describe("what a quiet session's page draws (ISS-1228 criterion 29)", () => {
  it("calls a running session answering and a quiet one live but not answering", () => {
    expect(sessionActivity("running")).toEqual({ live: true, answering: true, quiet: false });
    expect(sessionActivity("stalled")).toEqual({ live: true, answering: false, quiet: true });
    expect(sessionActivity("completed")).toEqual({ live: false, answering: false, quiet: false });
  });

  it("draws no spinner on a quiet session's composer and says why it takes no message", () => {
    render(<ChatComposer onSend={vi.fn()} {...sessionComposerState("stalled", false)} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "still there?" } });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Send message")).toBeDisabled();
    expect(screen.getByText(QUIET_HOLD)).toBeVisible();
  });

  it("keeps the spinner for a session that is answering", () => {
    render(<ChatComposer onSend={vi.fn()} {...sessionComposerState("running", false)} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText(QUIET_HOLD)).not.toBeInTheDocument();
  });

  it("spins for this browser's own send even on a quiet session", () => {
    expect(sessionComposerState("stalled", true)).toEqual({ busy: true });
  });
});
