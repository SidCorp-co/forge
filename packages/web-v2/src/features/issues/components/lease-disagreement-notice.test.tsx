// @vitest-environment jsdom
//
// ISS-1228 round 12: core still held ISS-3 for run r6 while r6's box said it returned it, so another
// run on ISS-3 was refused, and the issue's page said nothing. It now says so in the sentences every
// surface uses, stops the session from here and links to it; where box and core agree it says nothing.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Holder, SessionsAndHolds } from "@/features/pipeline/types";
import { LeaseDisagreementNotice } from "./lease-disagreement-notice";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
let reading: SessionsAndHolds | undefined;
vi.mock("@/features/pipeline/hooks", () => ({ useSessionsAndHolds: () => ({ data: reading }) }));
const stop = vi.fn((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
vi.mock("@/features/sessions/hooks", () => ({
  useCancelSession: () => ({ mutate: stop, isPending: false, variables: undefined }),
}));

const holder = (boxReturned: boolean): Holder => ({
  by: "session",
  sessionId: "s6",
  sessionTitle: "run: r6-lease-disagree",
  sessionKind: "run_session",
  deviceName: "j31-a",
  since: "2026-10-17T07:35:00.000Z",
  boxReturned,
});

const read = (holders: Holder[]): SessionsAndHolds => ({
  readAt: "2026-10-17T07:45:00.000Z",
  sessions: [],
  holds: [{ issueId: "i3", displayId: "ISS-3", title: "j31 charlie", status: "in_progress", holders }],
});

const notice = () => render(<LeaseDisagreementNotice projectId="p1" issueId="i3" slug="qa" />);

describe("the issue page's word on a lease its box returned (ISS-1228 round 12)", () => {
  it("says core still holds it though the box returned it, stops that session, and links to it", () => {
    reading = read([holder(true)]);
    notice();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Held by run: r6-lease-disagree on j31-a. The box says it returned ISS-3. Core still holds it. Stop the session to free it.",
    );
    expect(screen.getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/projects/qa/agents/s6");
  });

  // ISS-1228 round 13: judge-34's press ended a running agent with no question asked, and the notice
  // with its button stayed about five seconds after the stop while a toast said it was done.
  it("asks before it stops, naming the session and its box, and leaves at once once stopped", () => {
    stop.mockClear();
    reading = read([holder(true)]);
    notice();
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    expect(stop).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Session r6-lease-disagree on j31-a stops now.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop session" }));
    expect(stop).toHaveBeenCalledWith("s6", expect.anything());
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the session running where the person changes their mind", () => {
    stop.mockClear();
    reading = read([holder(true)]);
    notice();
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep it running" }));
    expect(stop).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("says nothing where the box and core agree, where a person holds it, or before the read", () => {
    for (const r of [
      read([holder(false)]),
      read([{ by: "person", status: "needs_info", owes: null, since: null, why: null }]),
      undefined,
    ]) {
      reading = r;
      const { container } = notice();
      expect(container).toBeEmptyDOMElement();
      cleanup();
    }
  });
});
