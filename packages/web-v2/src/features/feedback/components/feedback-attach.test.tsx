// FB-106: a feedback item took no attachment from the web, at filing or afterwards, though core stores
// one (POST …/feedback/:fb/attachments) and the item page listed them by name only. The form now
// stages files the way an issue comment does and sends each once the item is filed; the item page
// offers Attach to whoever core says may, and shows an image as a preview, not a file name.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { FeedbackAttachments } from "./feedback-attachments";
import { FeedbackForm } from "./feedback-form";

afterEach(() => vi.unstubAllGlobals());

const png = (name = "board.png") => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
const PNG_BASE64 = "iVBORw0KGgo=";
const mp4 = (name = "spinner.mp4") => new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], name, { type: "video/mp4" });
const MP4_BASE64 = "AAAAGGZ0eXA=";

const ATTACHED = {
  id: "a1",
  from: null,
  name: "board.png",
  mime: "image/png",
  size: 8,
  flagged: false,
  uploadedBy: "u1",
  uploadedByName: "Ann",
  createdAt: "2026-10-07T00:00:00.000Z",
  url: "/api/projects/p1/feedback/FB-4/attachments/a1",
};
const PDF = { ...ATTACHED, id: "a2", name: "steps.pdf", mime: "application/pdf", url: "/api/projects/p1/feedback/FB-4/attachments/a2" };
const view = (over: Partial<FeedbackView> = {}) =>
  ({ key: "FB-4", redacted: false, attachments: [], can: { attach: true }, ...over }) as unknown as FeedbackView;

describe("attaching to a feedback item that exists", () => {
  it("stages a picked image and sends it as the route core serves takes it", async () => {
    const calls = fakeCore((c) => (c.method === "POST" ? { status: 201, body: { feedback: view({ attachments: [ATTACHED] }) } } : undefined));
    const { container } = renderWithQuery(<FeedbackAttachments projectId="p1" f={view()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [png()] } });
    expect(screen.getByText("board.png")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Attach 1 file" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        { method: "POST", path: "/projects/p1/feedback/FB-4/attachments", body: { name: "board.png", mime: "image/png", contentBase64: PNG_BASE64 } },
      ]),
    );
  });

  it("refuses before sending a file larger than an item keeps, naming the limit", () => {
    const calls = fakeCore(() => undefined);
    const { container } = renderWithQuery(<FeedbackAttachments projectId="p1" f={view()} />);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.png", { type: "image/png" });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [big] } });
    expect(screen.getByText("Too large (max 5 MB): huge.png")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Attach \d/ })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("stages a picked MP4 recording and sends it as a video (REQ-35 BC-8)", async () => {
    const calls = fakeCore((c) => (c.method === "POST" ? { status: 201, body: { feedback: view() } } : undefined));
    const { container } = renderWithQuery(<FeedbackAttachments projectId="p1" f={view()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept.split(",")).toEqual(expect.arrayContaining(["video/mp4", "video/webm", "video/quicktime"]));
    fireEvent.change(input, { target: { files: [mp4()] } });
    expect(screen.queryByText(/File type not allowed/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Attach 1 file" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST").map((c) => c.body)).toEqual([{ name: "spinner.mp4", mime: "video/mp4", contentBase64: MP4_BASE64 }]),
    );
  });

  it("offers no Attach where core says the viewer may not, and lists the files the evidence above does not show", () => {
    fakeCore(() => undefined);
    renderWithQuery(<FeedbackAttachments projectId="p1" f={view({ attachments: [ATTACHED, PDF], can: { attach: false } as FeedbackView["can"] })} />);
    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
    expect(screen.getByRole("link", { name: /steps\.pdf/ }).getAttribute("href")).toBe(PDF.url);
    expect(screen.queryByRole("img"), "a screenshot is shown once, in the evidence").toBeNull();
  });
});

describe("attaching while filing", () => {
  it("files the item, then sends each staged file to the key core answered with", async () => {
    const calls = fakeCore((c) =>
      c.path === "/projects"
        ? { body: [{ id: "p1", role: "member" }] }
        : c.path === "/projects/p1/requirements"
          ? { body: { requirements: [{ key: "REQ-3", title: "The board keeps its cards" }], returned: 1 } }
          : c.method === "POST" && c.path === "/projects/p1/feedback"
            ? { status: 201, body: { feedback: { key: "FB-9" } } }
            : c.method === "POST" && c.path === "/projects/p1/feedback/FB-9/attachments"
              ? { status: 201, body: { feedback: { key: "FB-9" } } }
              : undefined,
    );
    const onDone = vi.fn();
    const { container } = renderWithQuery(<FeedbackForm projectId="p1" onDone={onDone} />);
    await screen.findByTestId("feedback-choices");
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Cards vanish" } });
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "The board keeps its cards" } });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [png(), mp4()] } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("FB-9"));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([
      "/projects/p1/feedback",
      "/projects/p1/feedback/FB-9/attachments",
      "/projects/p1/feedback/FB-9/attachments",
    ]);
    expect(calls.slice(-2).map((c) => c.body)).toEqual([
      { name: "board.png", mime: "image/png", contentBase64: PNG_BASE64 },
      { name: "spinner.mp4", mime: "video/mp4", contentBase64: MP4_BASE64 },
    ]);
  });

  it("says which file core refused, that the item is filed, and opens it to attach again", async () => {
    fakeCore((c) =>
      c.path === "/projects"
        ? { body: [{ id: "p1", role: "member" }] }
        : c.path === "/projects/p1/requirements"
          ? { body: { requirements: [{ key: "REQ-3", title: "The board keeps its cards" }], returned: 1 } }
          : c.method === "POST" && c.path === "/projects/p1/feedback"
            ? { status: 201, body: { feedback: { key: "FB-9" } } }
            : c.method === "POST"
              ? { status: 422, body: { error: "FEEDBACK_REFUSED", refusals: [{ code: "FEEDBACK_ATTACHMENT_INVALID", path: "/mime", detail: "this type is not stored here" }] } }
              : undefined,
    );
    const onDone = vi.fn();
    const { container } = renderWithQuery(<FeedbackForm projectId="p1" onDone={onDone} />);
    await screen.findByTestId("feedback-choices");
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Cards vanish" } });
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "The board keeps its cards" } });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [png()] } });
    fireEvent.click(screen.getByRole("button", { name: "Send feedback" }));
    expect(await screen.findByTestId("feedback-attach-failed")).toHaveTextContent("FB-9 is filed, but board.png was not attached");
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open FB-9" }));
    expect(onDone).toHaveBeenCalledWith("FB-9");
  });
});
