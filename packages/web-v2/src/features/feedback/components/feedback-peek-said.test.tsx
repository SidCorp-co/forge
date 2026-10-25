// The feedback peek says what the reporter said and showed, so a reader rarely needs the full page:
// the reporter's text held to a few lines, screenshots as thumbnails (four, the last counting the
// rest), recordings counted. An item with no text and no evidence draws neither section, and a
// redacted item says its text was deleted rather than showing it.
//
// @direct-test-of packages/web-v2/src/features/feedback/components/feedback-peek.tsx

import { RECORDING_ROUTES, type RecordingRecord, recordingRecordSchema } from "@forge/contracts/reproduce";
import { QueryClient } from "@tanstack/react-query";
import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import type { FeedbackView } from "../types";
import { FeedbackPeek } from "./feedback-peek";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(() => vi.unstubAllGlobals());

const P = "22222222-2222-4222-8222-222222222222";
const ANN = "66666666-6666-4666-8666-666666666666";
const LIST = RECORDING_ROUTES.ofFeedback.replace(":id", P).replace(":fb", "FB-52").replace(/^\/api/, "");
const NONE = { triage: false, drop: false, verify: false, reopen: false, askVerify: false, redact: false, retarget: false, snooze: false, message: false, tellShipped: false, note: false, attach: false, clarify: false };

const file = (id: string, mime: string) => ({
  id,
  from: null,
  name: `${id}.bin`,
  mime,
  size: 4096,
  flagged: false,
  redacted: false,
  uploadedBy: ANN,
  uploadedByName: "Ann",
  createdAt: "2026-10-09T10:00:00.000Z",
  url: `/api/projects/${P}/feedback/FB-52/attachments/${id}`,
});

const view = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f52",
    key: "FB-52",
    title: "Save order fails",
    writtenLang: "en",
    kind: "bug",
    severity: "high",
    status: "new",
    phase: "new",
    attentionGroup: "needs_you",
    waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.triageIt"), rule: RULE }),
    target: { type: "screen", key: "Orders", title: null },
    route: null,
    reporter: { id: ANN, name: "Ann", agency: "human" },
    body: "Clicking Save shows a spinner forever.\nThe order is never stored.",
    whereSeen: null,
    duplicateOf: null,
    duplicates: [],    occurrences: [],
    origin: null,
    decisions: [],
    attachments: [],
    reporters: [],
    messages: [],
    clarification: null,
    questions: [],
    openSuggestions: 0,
    verified: null,
    recordCheck: null,
    verifyHeld: null,
    shipNotice: null,
    snoozed: null,
    redacted: false,
    redactedAt: null,
    createdAt: "2026-10-09T09:00:00.000Z",
    updatedAt: "2026-10-09T09:00:00.000Z",
    can: NONE,
    ...over,
  }) as FeedbackView;

const recording = (i: number): RecordingRecord =>
  recordingRecordSchema.parse({
    id: `9999999${i}-9999-4999-8999-999999999999`,
    projectId: P,
    feedbackId: "88888888-8888-4888-8888-888888888888",
    previewId: "77777777-7777-4777-8777-777777777777",
    build: { sha: "c".repeat(40), release: "1.4.0" },
    state: "stopped",
    reason: null,
    recordedBy: ANN,
    startedAt: "2026-10-09T10:00:00.000Z",
    stoppedAt: "2026-10-09T10:03:00.000Z",
    expiresAt: "2026-11-08T10:03:00.000Z",
    events: 42,
    bytes: 2048,
    timeline: [],
  });

/** The peek over `f`, core answering one reproduce recording per `recorded` and holding every other read. */
async function peekAt(f: FeedbackView, recorded = 0) {
  fakeCore((c) =>
    c.path === LIST
      ? { body: { recordings: Array.from({ length: recorded }, (_, i) => recording(i)) } }
      : HANG,
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["feedback-item", P, f.key], { feedback: f });
  const peek = { open: f.key, position: { at: 1, of: 1 }, set: () => {}, move: () => {} };
  renderWithQuery(<FeedbackPeek projectId={P} slug="hop" fbKey={f.key} peek={peek} full={{ href: `/projects/hop/feedback/${f.key}`, origin: null }} />, client);
  await screen.findByTestId("feedback-facts");
}

describe("the feedback peek says what the reporter said and showed", () => {
  it("shows the reporter's text, held to a few lines, above the facts", async () => {
    await peekAt(view());
    const said = screen.getByTestId("feedback-peek-body");
    expect(within(said).getByRole("heading", { name: "What the reporter said" })).toBeInTheDocument();
    expect(within(said).getByTestId("peek-excerpt")).toHaveTextContent("Clicking Save shows a spinner forever. The order is never stored.");
    expect(said.compareDocumentPosition(screen.getByTestId("feedback-facts")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows four screenshots as thumbnails, the last counting the rest, and opens any in the lightbox", async () => {
    await peekAt(view({ attachments: ["s1", "s2", "s3", "s4", "s5", "s6"].map((id) => file(id, "image/png")) }));
    const shots = within(screen.getByTestId("feedback-peek-shots")).getAllByRole("button");
    expect(shots).toHaveLength(4);
    expect(shots[0]).toHaveAccessibleName("Screenshot 1 of 6 for FB-52: Save order fails");
    expect(shots[3]).toHaveAccessibleName("Screenshot 4 of 6 for FB-52: Save order fails, and 2 more");
    expect(screen.getByTestId("feedback-peek-more")).toHaveTextContent("+2");
    fireEvent.click(shots[1]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("names a screenshot whose file does not load, in its tile, instead of a broken image", async () => {
    await peekAt(view({ attachments: [file("s1", "image/png"), file("s2", "image/png")] }));
    const tiles = screen.getByTestId("feedback-peek-shots");
    fireEvent.error(tiles.querySelectorAll("img")[1]);
    expect(within(tiles).getAllByTestId("attached-image-failed")).toHaveLength(1);
    expect(within(tiles).getByRole("img", { name: "Couldn't load s2.bin" })).toBeInTheDocument();
    expect(tiles.querySelectorAll("img")).toHaveLength(1);
  });

  it("counts recordings, uploaded and reproduced, as played on the full page", async () => {
    await peekAt(view({ attachments: [file("v1", "video/webm")] }), 2);
    expect(await screen.findByText("3 recordings, played on the full page")).toBeInTheDocument();
    expect(screen.queryByTestId("feedback-peek-shots")).toBeNull();
  });

  it("draws neither section for an item with no text and no evidence", async () => {
    await peekAt(view({ body: "  " }));
    expect(screen.queryByTestId("feedback-peek-body")).toBeNull();
    expect(screen.queryByTestId("feedback-peek-evidence")).toBeNull();
    expect(screen.queryByTestId("feedback-peek-said")).toBeNull();
  });

  it("says a redacted item's text was deleted, and shows none of it", async () => {
    await peekAt(view({ redacted: true, body: "Ann's phone is 555-0100" }));
    expect(within(screen.getByTestId("feedback-peek-body")).getByText("Reporter data deleted")).toBeInTheDocument();
    expect(screen.queryByText(/555-0100/)).toBeNull();
  });
});
