// @vitest-environment jsdom
//
// ISS-1228 round 14 — the master read "Sweep zombies" as jargon, and it ended sessions on one press with
// nothing asked, where Stop session asks first.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const { mutate } = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("../hooks", () => ({ useSweepZombies: () => ({ mutate, isPending: false }) }));

import { endedSilentText } from "../status-sentences";
import { EndSilentSessions } from "./end-silent-sessions";

afterEach(() => {
  cleanup();
  mutate.mockReset();
});

describe("End silent sessions on the sessions page", () => {
  it("names what it does and ends nothing until a person confirms", () => {
    render(<EndSilentSessions projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "End silent sessions" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Every step or agent chat on this project that stopped checking in, never reported a turn, never had a client attach, or waited in the queue past its limit, ends now as failed, as core would end it on its next pass. Run sessions and masters keep their own clock.",
    );
    expect(mutate).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep them" }));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("ends them on confirm", () => {
    render(<EndSilentSessions projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "End silent sessions" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "End silent sessions" }));
    expect(mutate).toHaveBeenCalledWith("p1", expect.anything());
  });

  it("is offered only on a project's page, named the same", () => {
    render(<EndSilentSessions projectId={null} />);
    expect(screen.getByRole("button", { name: "End silent sessions" })).toBeDisabled();
    expect(screen.queryByText(/zombie/i)).toBeNull();
  });

  it("counts every session each pass ended, in words, and says when there was none", () => {
    const none = { queueTimedOut: 0, turnNeverReported: 0, heartbeatTimedOut: 0, noClientAcked: 0 };
    expect(endedSilentText({ ...none, queueTimedOut: 1 })).toBe("Ended 1 silent session.");
    expect(endedSilentText({ queueTimedOut: 1, turnNeverReported: 1, heartbeatTimedOut: 1, noClientAcked: 1 })).toBe(
      "Ended 4 silent sessions.",
    );
    expect(endedSilentText({ ...none, noClientAcked: 2 })).toBe("Ended 2 silent sessions.");
    expect(endedSilentText(none)).toBe("No session was silent.");
  });
});
