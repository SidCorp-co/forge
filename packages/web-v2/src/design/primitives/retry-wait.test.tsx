// @vitest-environment jsdom
//
// ISS-1229 r53, judge-165 on 479: on the issue list's filter lines and in the phone drawer the wait before Retry
// counted inside role="alert", so a screen reader was interrupted every second of it (38 announcements in 20 s).
// r54, judge-168 on 511: each place showing one read's wait had a status of its own, so one read was told two to four
// times each way, and a sheet opened mid-wait told it again. What every live region on the page is handed over a
// whole wait is counted here, per read: its start once and its end once, however many places show it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/projects/hooks", () => ({ useProjects: () => ({ data: [], isError: false, error: null, refetch: () => {} }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/features/orgs/components/org-switcher", () => ({ OrgSwitcher: () => null }));

const { ProjectsUnreadLine, projectsUnreadOf } = await import("@/features/projects/components/projects-unread");
const { NavRailCompact } = await import("@/features/shell/nav-rail-compact");
const { ApiError } = await import("@/lib/api/client");
const { forgetWaits } = await import("@/design/hooks/wait-announcer");
const { ReadFailedLine } = await import("./read-failed-line");
const { RetryButton } = await import("./retry-button");
const { RetryLink } = await import("./retry-link");

expect.extend(matchers);

const LIVE = '[role="alert"], [role="status"], [role="log"], [aria-live="polite"], [aria-live="assertive"]';

/** What a screen reader is handed: each text a live region gains, by an added node or a changed text inside it. */
function listen(): { said: string[]; take: () => void; stop: () => void } {
  const said: string[] = [];
  const watch = new MutationObserver(() => {});
  const take = () => {
    for (const record of watch.takeRecords()) {
      const at = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!at?.closest(LIVE)) continue;
      if (record.type === "characterData") said.push(record.target.textContent ?? "");
      for (const node of record.addedNodes) if (node.textContent?.trim()) said.push(node.textContent);
    }
  };
  watch.observe(document.body, { subtree: true, childList: true, characterData: true });
  return { said, take, stop: () => watch.disconnect() };
}

/** Everything told while `seconds` pass, sampled each half second. */
function toldOver(seconds: number, ear = listen()): string[] {
  for (let t = 0; t < seconds * 2; t++) {
    act(() => void vi.advanceTimersByTime(500));
    ear.take();
  }
  ear.stop();
  return ear.said;
}

const waitWords = (said: string[]) => said.filter((text) => /server asked|retry now|retry in/i.test(text));

const limited = (seconds: number, read = "GET /runs") =>
  new ApiError(429, "Too many requests in a short time. Try again in 20 seconds.", "RATE_LIMITED", undefined, undefined, seconds * 1000, true, read);

/** The same read, held by the client: a new answer carrying the wait the first one started. */
const heldCopy = (first: InstanceType<typeof ApiError>) =>
  new ApiError(first.status, first.message, first.code, undefined, undefined, first.retryAfterMs, first.retryAt, first.read);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  forgetWaits();
  vi.useRealTimers();
});

const rail = (e: unknown) => (
  <NavRailCompact
    workspaceItems={[{ key: "overview", label: "Overview", icon: "grid" }]}
    activeKey="overview"
    switcherProjects={[]}
    projectsUnread={projectsUnreadOf(e, () => {})}
    onNavigate={() => {}}
    onSelectProject={() => {}}
    onTogglePin={() => {}}
    onAllProjects={() => {}}
    onNewProject={() => {}}
  />
);

const parts: [string, (error: unknown) => ReactElement][] = [
  ["a read-failed line, as the issue list's filters draw it", (e) => <ReadFailedLine what="the labels the Label filter offers" why="Too many requests in a short time." error={e} onRetry={() => {}} />],
  ["the phone drawer's projects line", (e) => <ProjectsUnreadLine unread={projectsUnreadOf(e, () => {})} />],
  ["a Retry button on its own", (e) => <RetryButton error={e} onRetry={() => {}} />],
  ["a Retry word inside a sentence", (e) => <p>Couldn&apos;t load more. <RetryLink error={e} onRetry={() => {}} /></p>],
  ["the narrow rail", rail],
];

describe("a wait before Retry, as a screen reader hears it (criteria 479, 511)", () => {
  it.each(parts)("is told once as it starts and once as it ends, for %s", (_, draw) => {
    const ear = listen();
    const { container } = render(draw(limited(20)));
    const said = toldOver(22, ear);
    expect(waitWords(said)).toEqual(["The server asked for 20 seconds before Retry.", "You can retry now."]);
    expect(said.filter((text) => /retry in \d/i.test(text))).toEqual([]);
    expect(container.querySelector('[role="timer"]')).toBeNull();
  });

  it.each(parts)("still counts on screen, in a timer read only when asked, for %s", (_, draw) => {
    render(draw(limited(20)));
    act(() => void vi.advanceTimersByTime(7_000));
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("You can retry in 13 seconds.");
    expect(timer.closest(LIVE)).toBeNull();
  });

  it("is told once for a read shown in every place at once, the narrow rail among them", () => {
    const refused = limited(20, "GET /projects");
    const ear = listen();
    render(
      <div>
        {parts.map(([name, draw]) => (
          <div key={name}>{draw(refused)}</div>
        ))}
      </div>,
    );
    expect(waitWords(toldOver(22, ear))).toEqual(["The server asked for 20 seconds before Retry.", "You can retry now."]);
  });

  it("tells nothing more where a place opens mid-wait, as the phone's Filters sheet does", () => {
    const refused = limited(20);
    const ear = listen();
    const { rerender } = render(<ReadFailedLine what="the labels" why="Too many requests." error={refused} onRetry={() => {}} />);
    for (let t = 0; t < 6; t++) {
      act(() => void vi.advanceTimersByTime(500));
      ear.take();
    }
    rerender(
      <>
        <ReadFailedLine what="the labels" why="Too many requests." error={refused} onRetry={() => {}} />
        <div role="dialog" aria-modal="true">
          <ReadFailedLine what="the labels" why="Too many requests." error={heldCopy(refused)} onRetry={() => {}} />
        </div>
      </>,
    );
    expect(waitWords(toldOver(20, ear))).toEqual(["The server asked for 20 seconds before Retry.", "You can retry now."]);
    // r54 review: a screen reader confined to the open dialog hears the end there.
    expect(screen.getByRole("dialog")).toHaveTextContent("You can retry now.");
  });

  it("tells each of two reads, refused apart, its own start and end", () => {
    const ear = listen();
    const people = limited(20, "GET /members");
    const { rerender } = render(<ReadFailedLine what="the people" why="x" error={people} onRetry={() => {}} />);
    for (let t = 0; t < 6; t++) {
      act(() => void vi.advanceTimersByTime(500));
      ear.take();
    }
    const first = screen.getAllByRole("timer").length;
    rerender(
      <>
        <ReadFailedLine what="the people" why="x" error={people} onRetry={() => {}} />
        <ReadFailedLine what="the labels" why="x" error={limited(10, "GET /labels")} onRetry={() => {}} />
      </>,
    );
    expect(first).toBe(1);
    expect(waitWords(toldOver(25, ear))).toEqual([
      "The server asked for 20 seconds before Retry.",
      "The server asked for 10 seconds before Retry.",
      "You can retry now.",
      "You can retry now.",
    ]);
  });

  // r54 review F2: two reads given the same wait a second apart are two waits, each told its start and its end.
  it("tells two reads given the same wait a second apart each their own start and end", () => {
    const ear = listen();
    const people = limited(20, "GET /members");
    const { rerender } = render(<ReadFailedLine what="the people" why="x" error={people} onRetry={() => {}} />);
    act(() => void vi.advanceTimersByTime(1_000));
    ear.take();
    rerender(
      <>
        <ReadFailedLine what="the people" why="x" error={people} onRetry={() => {}} />
        <ReadFailedLine what="the labels" why="x" error={limited(20, "GET /labels")} onRetry={() => {}} />
      </>,
    );
    expect(waitWords(toldOver(22, ear))).toEqual([
      "The server asked for 20 seconds before Retry.",
      "The server asked for 20 seconds before Retry.",
      "You can retry now.",
      "You can retry now.",
    ]);
  });

  it("is told nothing of an end where nothing shows the read any more", () => {
    const ear = listen();
    const { unmount } = render(<RetryButton error={limited(5)} onRetry={() => {}} />);
    act(() => void vi.advanceTimersByTime(1_000));
    unmount();
    expect(waitWords(toldOver(8, ear))).toEqual(["The server asked for 5 seconds before Retry."]);
  });

  // A region stood up already holding its words is not announced by most screen readers: the start must arrive as an
  // addition inside a region that already stands.
  it("puts the start into a region already standing", () => {
    const ear = listen();
    render(<RetryButton error={limited(20)} onRetry={() => {}} />);
    const region = screen.getByTestId("wait-announcer");
    expect(region).toBeEmptyDOMElement();
    act(() => void vi.advanceTimersByTime(500));
    ear.take();
    ear.stop();
    expect(region).toHaveTextContent("The server asked for 20 seconds before Retry.");
    expect(ear.said).toContain("The server asked for 20 seconds before Retry.");
  });

  it("says nothing of a wait where the answer named none", () => {
    const ear = listen();
    render(<ReadFailedLine what="the devices" why="The server is unavailable right now." error={new ApiError(503, "")} onRetry={() => {}} />);
    ear.take();
    expect(waitWords(toldOver(5, ear))).toEqual([]);
    expect(screen.queryByTestId("wait-announcer")).toBeNull();
  });
});
