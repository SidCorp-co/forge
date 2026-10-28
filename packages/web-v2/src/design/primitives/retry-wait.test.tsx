// @vitest-environment jsdom
//
// ISS-1229 r53, judge-165 on 479: on the issue list's filter lines and in the phone drawer the wait before Retry
// counted inside role="alert", so a screen reader was interrupted every second of it (38 announcements in 20 s).
// What a live region says over a whole wait is counted here: the start and the end, never a tick.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsUnreadLine, projectsUnreadOf } from "@/features/projects/components/projects-unread";
import { ApiError } from "@/lib/api/client";
import { ReadFailedLine } from "./read-failed-line";
import { RetryButton } from "./retry-button";
import { RetryLink } from "./retry-link";

expect.extend(matchers);

const LIVE = '[role="alert"], [role="status"], [role="log"], [aria-live="polite"], [aria-live="assertive"]';

/** Every change a screen reader is handed while a wait of `seconds` runs out, sampled each half second. */
function announcedOver(seconds: number): string[] {
  const said: string[] = [];
  let last = new Map<Element, string>();
  const sample = () => {
    const now = new Map([...document.querySelectorAll(LIVE)].map((el) => [el, el.textContent ?? ""] as const));
    for (const [el, text] of now) if (last.get(el) !== text && text.trim() !== "") said.push(text);
    last = now;
  };
  sample();
  for (let t = 0; t < (seconds + 2) * 2; t++) {
    act(() => void vi.advanceTimersByTime(500));
    sample();
  }
  return said;
}

const limited = (seconds: number) =>
  new ApiError(429, "Too many requests in a short time. Try again in 20 seconds.", "RATE_LIMITED", undefined, undefined, seconds * 1000);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const parts: [string, (error: unknown) => ReactElement][] = [
  ["a read-failed line, as the issue list's filters draw it", (e) => <ReadFailedLine what="the labels the Label filter offers" why="Too many requests in a short time." error={e} onRetry={() => {}} />],
  ["the phone drawer's projects line", (e) => <ProjectsUnreadLine unread={projectsUnreadOf(e, () => {})} />],
  ["a Retry button on its own", (e) => <RetryButton error={e} onRetry={() => {}} />],
  ["a Retry word inside a sentence", (e) => <p>Couldn&apos;t load more. <RetryLink error={e} onRetry={() => {}} /></p>],
];

describe("a wait before Retry, as a screen reader hears it (criterion 479)", () => {
  it.each(parts)("is said once as it starts and once as it ends, for %s", (_, draw) => {
    const { container } = render(draw(limited(20)));
    const said = announcedOver(20);
    const wait = said.filter((text) => /server asked|retry now|retry in/i.test(text));
    expect(wait).toEqual(["The server asked for 20 seconds before Retry.", "You can retry now."]);
    expect(said.filter((text) => /retry in \d/i.test(text))).toEqual([]);
    expect(said.length).toBeLessThanOrEqual(3);
    expect(container.querySelector('[role="timer"]')).toBeNull();
  });

  it.each(parts)("still counts on screen, in a timer read only when asked, for %s", (_, draw) => {
    render(draw(limited(20)));
    act(() => void vi.advanceTimersByTime(7_000));
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("You can retry in 13 seconds.");
    expect(timer.closest(LIVE)).toBeNull();
  });

  it("says nothing of a wait where the answer named none", () => {
    render(<ReadFailedLine what="the devices" why="The server is unavailable right now." error={new ApiError(503, "")} onRetry={() => {}} />);
    expect(announcedOver(5)).toEqual(["Couldn't load the devices. The server is unavailable right now."]);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
