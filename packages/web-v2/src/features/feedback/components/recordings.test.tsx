// REQ-41 BC-18, BC-21 on the feedback page: an item's recordings as flat rows, the newest's timeline
// read as what was done and what the page logged, a replay through rrweb's own player over the
// scrubbed events, and a stranger's refusal named as core names it. Core is stood in for over
// `fetch`; rrweb's player is stood in for, since jsdom cannot lay out a replayed page.

import { RECORDING_ROUTES, type RecordingRecord, recordingRecordSchema } from "@forge/contracts/reproduce";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { atOf } from "@/features/previews/reproduce-timeline";
import { Recordings } from "./recordings";

const replayed = vi.hoisted(() => ({ events: [] as unknown[], played: 0 }));
vi.mock("rrweb", () => ({
  Replayer: class {
    constructor(events: unknown[], config: { root: Element }) {
      replayed.events = events;
      config.root.append(Object.assign(document.createElement("div"), { className: "replayer-wrapper" }));
    }
    play() {
      replayed.played += 1;
    }
    destroy() {}
  },
}));

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const REPORTER = "66666666-6666-4666-8666-666666666666";
const REC = "99999999-9999-4999-8999-999999999999";
const LIST = RECORDING_ROUTES.ofFeedback.replace(":id", PROJECT_ID).replace(":fb", "FB-52").replace(/^\/api/, "");

const recording = (over: Partial<RecordingRecord> = {}): RecordingRecord =>
  recordingRecordSchema.parse({
    id: REC,
    projectId: PROJECT_ID,
    feedbackId: "88888888-8888-4888-8888-888888888888",
    previewId: "77777777-7777-4777-8777-777777777777",
    build: { sha: "c".repeat(40), release: "1.4.0" },
    state: "stopped",
    reason: null,
    recordedBy: REPORTER,
    startedAt: "2026-10-09T10:00:00.000Z",
    stoppedAt: "2026-10-09T10:03:00.000Z",
    expiresAt: "2026-11-08T10:03:00.000Z",
    events: 42,
    bytes: 2048,
    timeline: [
      { at: 0, kind: "navigate", text: "Opened https://shop.test/orders/new" },
      { at: 3400, kind: "click", text: "Clicked Save order" },
      { at: 3520, kind: "request_failed", text: "POST https://shop.test/api/orders answered 500" },
      { at: 3530, kind: "console_error", text: "console.error: Order save failed: 500" },
    ],
    ...over,
  });

const item = { key: "FB-52", title: "Save order fails", reporter: { id: REPORTER, name: "Ann", agency: "human" }, route: null, redacted: false, attachments: [] } as unknown as FeedbackView;

const BO = "55555555-5555-4555-8555-555555555555";
/** A video someone attached to the item: core serves it from the item's own attachment route. */
const upload = (over: Record<string, unknown> = {}) => ({
  id: "v1",
  from: null,
  name: "spinner.mp4",
  mime: "video/mp4",
  size: 900_000,
  flagged: false,
  uploadedBy: BO,
  uploadedByName: "Bo",
  createdAt: "2026-10-09T11:00:00.000Z",
  url: `/api/projects/${PROJECT_ID}/feedback/FB-52/attachments/v1`,
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("the item's recordings", () => {
  it("lists each recording and reads the newest's timeline, marking what failed", async () => {
    fakeCore((c) => (c.path === LIST ? { body: { recordings: [recording()] } } : undefined));
    renderWithQuery(<Recordings projectId={PROJECT_ID} f={item} />);
    const row = await screen.findByTestId("recording-row");
    expect(row).toHaveTextContent("Ann");
    expect(row).toHaveTextContent("1.4.0");
    expect(row).toHaveTextContent("Stopped");
    const timeline = screen.getByTestId("recording-timeline");
    const lines = within(timeline).getAllByRole("row");
    expect(lines.map((l) => l.getAttribute("data-kind"))).toEqual(["navigate", "click", "request_failed", "console_error"]);
    expect(lines[2]).toHaveTextContent("0:03.5Request failedPOST https://shop.test/api/orders answered 500");
  });

  it("replays the scrubbed events with rrweb's player once asked", async () => {
    const events = [{ type: 4, timestamp: 1, data: { href: "https://shop.test/orders/new", width: 1280, height: 720 } }];
    const calls = fakeCore((c) => {
      if (c.path === LIST) return { body: { recordings: [recording()] } };
      if (c.path === `/recordings/${REC}/events`) return { body: { events } };
      return undefined;
    });
    renderWithQuery(<Recordings projectId={PROJECT_ID} f={item} />);
    fireEvent.click(await screen.findByTestId("recording-replay"));
    await waitFor(() => expect(replayed.played).toBe(1));
    expect(replayed.events).toEqual(events);
    expect(calls.some((c) => c.path === `/recordings/${REC}/events`)).toBe(true);
  });

  it("says why a recording failed, and keeps an expired one's timeline with no replay", async () => {
    fakeCore((c) =>
      c.path === LIST
        ? {
            body: {
              recordings: [
                recording({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", state: "failed", reason: "RECORDER_BLOCKED", events: 0, timeline: [] }),
                recording({ state: "expired", startedAt: "2026-09-01T10:00:00.000Z" }),
              ],
            },
          }
        : undefined,
    );
    renderWithQuery(<Recordings projectId={PROJECT_ID} f={item} />);
    const rows = await screen.findAllByTestId("recording-row");
    expect(rows[0]).toHaveTextContent("Failed · the app's own security policy kept the recorder out");
    fireEvent.click(within(rows[1] as HTMLElement).getByRole("button", { name: "Show" }));
    expect(await screen.findByText("Its events were deleted after 30 days. The timeline stays.")).toBeInTheDocument();
    expect(screen.getByTestId("recording-timeline")).toHaveTextContent("Clicked Save order");
    expect(screen.queryByTestId("recording-replay")).toBeNull();
  });

  it("names a stranger's refusal as core names it (BC-21)", async () => {
    fakeCore((c) =>
      c.path === LIST
        ? { status: 403, body: { error: { code: "RECORDING_FORBIDDEN", message: "recordings open only for signed-in members of the project", refusals: [] } } }
        : undefined,
    );
    renderWithQuery(<Recordings projectId={PROJECT_ID} f={item} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't read the recordings: recordings open only for signed-in members of the project");
    expect(screen.queryByTestId("recordings-table")).toBeNull();
  });

  it("lists an uploaded video and a reproduce recording as one list, newest first, each naming who made it", async () => {
    fakeCore((c) => (c.path === LIST ? { body: { recordings: [recording()] } } : undefined));
    renderWithQuery(<Recordings projectId={PROJECT_ID} f={{ ...item, attachments: [upload(), { ...upload({ id: "i1", name: "shot.png", mime: "image/png" }) }] } as unknown as FeedbackView} />);
    await screen.findByText("1.4.0");
    const rows = screen.getAllByTestId("recording-row");
    expect(rows.map((r) => r.getAttribute("data-kind")), "a screenshot is not a recording").toEqual(["upload", "reproduce"]);
    expect(rows[0]).toHaveTextContent("Bo");
    expect(rows[0]).toHaveTextContent("Uploaded");
    expect(rows[1]).toHaveTextContent("Ann");
  });

  it("plays an uploaded video in the page, read by its text alternative, not its file name", async () => {
    fakeCore((c) => (c.path === LIST ? { body: { recordings: [] } } : undefined));
    renderWithQuery(<Recordings projectId={PROJECT_ID} f={{ ...item, attachments: [upload({ uploadedBy: REPORTER, uploadedByName: "Ann" })] } as unknown as FeedbackView} />);
    const video = await screen.findByTestId("recording-video");
    expect(video.tagName).toBe("VIDEO");
    expect(video.getAttribute("src")).toBe(upload().url);
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.getAttribute("aria-label")).toBe("Recording 1 of 1 for FB-52: Save order fails");
    expect(screen.getByTestId("recording-row")).toHaveTextContent("Ann");
    expect(screen.queryByText("spinner.mp4")).toBeNull();
  });

  it("opens a reproduce recording from the list in place of the video", async () => {
    fakeCore((c) => (c.path === LIST ? { body: { recordings: [recording()] } } : undefined));
    renderWithQuery(<Recordings projectId={PROJECT_ID} f={{ ...item, attachments: [upload()] } as unknown as FeedbackView} />);
    await screen.findByText("1.4.0");
    expect(screen.getByTestId("recording-video"), "the newest, the upload, is open first").toBeTruthy();
    fireEvent.click(within(screen.getAllByTestId("recording-row")[1] as HTMLElement).getByRole("button", { name: "Show" }));
    expect(await screen.findByTestId("recording-timeline")).toHaveTextContent("Clicked Save order");
    expect(screen.queryByTestId("recording-video")).toBeNull();
  });

  it("describes a replay by its timeline, the text a screen reader reads for it", async () => {
    fakeCore((c) => {
      if (c.path === LIST) return { body: { recordings: [recording()] } };
      if (c.path === `/recordings/${REC}/events`) return { body: { events: [] } };
      return undefined;
    });
    renderWithQuery(<Recordings projectId={PROJECT_ID} f={item} />);
    fireEvent.click(await screen.findByTestId("recording-replay"));
    const player = await screen.findByRole("figure", { name: "Recording replay" });
    const described = document.getElementById(player.getAttribute("aria-describedby") ?? "");
    expect(described).toHaveTextContent("Clicked Save order");
  });

  it("writes times from the recording's start", () => {
    expect(atOf(0)).toBe("0:00.0");
    expect(atOf(3520)).toBe("0:03.5");
    expect(atOf(75_200)).toBe("1:15.2");
  });
});
