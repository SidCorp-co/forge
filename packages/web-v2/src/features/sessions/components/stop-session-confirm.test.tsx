// @vitest-environment jsdom
//
// ISS-1228 round 13: Stop session ended a running agent with nothing asked. Every stop now asks once,
// naming the session and, where known, its box, and says what the stop ends.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StopSessionConfirm, stopSessionMessage } from "./stop-session-confirm";

expect.extend(matchers);
afterEach(cleanup);

describe("the stop confirmation", () => {
  it("opens on the session as a capitalised sentence, names its box, and says what the stop ends", () => {
    expect(stopSessionMessage({ name: "run: r2", box: "j34-a" })).toBe(
      "Session r2 on j34-a stops now. Core lets go of any issue it holds, and its box is told to end the agent's process. It reads Stopped from then on, and Rerun starts a fresh session.",
    );
    expect(stopSessionMessage({ name: "run: r2" })).toMatch(/^Session r2 stops now\. /);
  });

  it("never says the raw title or Session twice, whatever name a surface has for it", () => {
    expect(stopSessionMessage({ name: "Fix the export" })).toMatch(/^Session Fix the export stops now\. /);
    expect(stopSessionMessage({ name: "This session", box: "bravo" })).toMatch(/^This session on bravo stops now\. /);
    expect(stopSessionMessage({ name: "Session 77777777" })).toMatch(/^Session 77777777 stops now\. /);
    expect(stopSessionMessage({ name: "run: r2" })).not.toMatch(/run:/);
  });

  it("is closed until a session is named, and stops nothing on Keep it running", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <StopSessionConfirm target={null} loading={false} onConfirm={onConfirm} onClose={onClose} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<StopSessionConfirm target={{ name: "run: r2" }} loading={false} onConfirm={onConfirm} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep it running" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
