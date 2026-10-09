// REQ-41 BC-17 and BC-19 in the chat: a turn that read `forge_recording` shows the recording's
// timeline and the Reproduce entry under its reply, and a turn that proposed a cause and a fix shows
// them with the recommended answer, whose button posts the item's own issue route carrying that
// diagnosis as the person who presses it. Drawn from a stored tool call, as the thread stores it.

import { BUILD_THE_FIX, type RecordingToolResult, recordingToolResultSchema } from "@forge/contracts/reproduce";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { recordingReadIn, TurnReproduce } from "./reproduce-turn";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const REC = "99999999-9999-4999-8999-999999999999";
const REPRO_ID = "77777777-7777-4777-8777-777777777777";

const read = (proposal: RecordingToolResult["proposal"] = null): RecordingToolResult =>
  recordingToolResultSchema.parse({
    projectId: PROJECT_ID,
    feedback: { key: "FB-52", title: "Saving an order fails", phase: "new" },
    recordings: [
      {
        id: REC,
        projectId: PROJECT_ID,
        feedbackId: "88888888-8888-4888-8888-888888888888",
        previewId: REPRO_ID,
        build: { sha: "c".repeat(40), release: "1.4.0" },
        state: "stopped",
        reason: null,
        recordedBy: "66666666-6666-4666-8666-666666666666",
        startedAt: "2026-10-09T10:00:00.000Z",
        stoppedAt: "2026-10-09T10:03:00.000Z",
        expiresAt: "2026-11-08T10:03:00.000Z",
        events: 42,
        bytes: 2048,
        timeline: [
          { at: 3400, kind: "click", text: "Clicked Save order" },
          { at: 3520, kind: "request_failed", text: "POST https://shop.test/api/orders answered 500" },
        ],
      },
    ],
    proposal,
  });

const diagnosis = { recording: REC, cause: "Save posts the order without its currency.", fix: "Send the selected currency with the order." };

/** A turn's blocks with one `forge_recording` call, its result stored as an MCP content envelope. */
const blocks = (result: unknown) => [
  { type: "text", text: "Here is what FB-52's recording shows." },
  { type: "tool", toolCall: { name: "forge_recording", isError: false, output: JSON.stringify({ content: [{ type: "text", text: JSON.stringify(result) }] }) } },
];

afterEach(() => {
  vi.unstubAllGlobals();
  push.mockReset();
});

describe("the recording a turn read, under its reply", () => {
  it("reads only a forge_recording result that is the read's own shape", () => {
    expect(recordingReadIn(blocks(read()))?.feedback.key).toBe("FB-52");
    expect(recordingReadIn(blocks({ feedback: "FB-52", recordings: "lots" })), "a drifted result draws nothing").toBeNull();
    expect(recordingReadIn([{ type: "tool", toolCall: { name: "forge_recording", isError: true, output: "RECORDING_FORBIDDEN" } }])).toBeNull();
  });

  it("shows the timeline and opens a reproduce from the chat, landing on the item with it open", async () => {
    const calls = fakeCore((c) =>
      c.method === "POST" && c.path === `/projects/${PROJECT_ID}/previews`
        ? {
            status: 201,
            body: {
              preview: {
                id: REPRO_ID,
                projectId: PROJECT_ID,
                subject: { kind: "reproduce", feedback: "FB-52", build: { sha: "c".repeat(40), release: "1.4.0" }, record: true },
                issueId: null,
                sessionId: null,
                deviceId: "55555555-5555-4555-8555-555555555555",
                url: "https://p-abcdefghijklmnop.preview.localhost:8443/",
                state: "starting",
                reason: null,
                detail: null,
                command: "npm run dev",
                port: null,
                idleMinutes: 30,
                approvedPatchId: null,
                approvedBy: null,
                createdBy: "66666666-6666-4666-8666-666666666666",
                createdAt: "2026-10-09T10:00:00.000Z",
                liveAt: null,
                lastViewedAt: null,
                closedAt: null,
              },
            },
          }
        : undefined,
    );
    renderWithQuery(<TurnReproduce blocks={blocks(read())} slug="shop" />);
    expect(screen.getByTestId("turn-timeline")).toHaveTextContent("POST https://shop.test/api/orders answered 500");
    expect(screen.queryByTestId("turn-diagnosis")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reproduce FB-52" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/projects/shop/feedback/FB-52?reproduce=${REPRO_ID}`));
    expect(calls[0]?.body).toEqual({ kind: "reproduce", feedback: "FB-52" });
  });

  it("offers the recommended answer, and pressing it routes the item to an issue carrying the diagnosis", async () => {
    const calls = fakeCore((c) =>
      c.method === "POST" && c.path === `/projects/${PROJECT_ID}/feedback/FB-52/triage`
        ? { body: { feedback: { key: "FB-52", route: { route: "issue", carriers: [{ key: "ISS-7", status: "draft" }], answer: null } } } }
        : undefined,
    );
    renderWithQuery(<TurnReproduce blocks={blocks(read({ diagnosis, recommended: BUILD_THE_FIX, pressable: true, why: null }))} slug="shop" />);
    const card = screen.getByTestId("turn-diagnosis");
    expect(card).toHaveTextContent("Cause. Save posts the order without its currency.");
    expect(card).toHaveTextContent("Fix. Send the selected currency with the order.");
    expect(card).toHaveTextContent("Recommended");
    fireEvent.click(screen.getByRole("button", { name: "Build the fix, ask the reporter to confirm" }));
    expect(await screen.findByTestId("turn-diagnosis-done")).toHaveTextContent("Routed FB-52 to ISS-7. Its run builds the fix");
    expect(calls[0]?.body).toEqual({ route: "issue", diagnosis });
  });

  it("does not let a person press what they may not do, and says why", () => {
    fakeCore(() => undefined);
    renderWithQuery(
      <TurnReproduce
        blocks={blocks(read({ diagnosis, recommended: BUILD_THE_FIX, pressable: false, why: "FB-52 reads triaged: a route is picked by a holder of feedback.approve" }))}
        slug="shop"
      />,
    );
    expect(screen.getByRole("button", { name: BUILD_THE_FIX })).toBeDisabled();
    expect(screen.getByTestId("turn-diagnosis")).toHaveTextContent("a route is picked by a holder of feedback.approve");
  });
});
