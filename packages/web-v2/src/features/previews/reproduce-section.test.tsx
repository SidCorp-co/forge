// REQ-41 BC-17 and BC-20 as a member sees them on a feedback item: Reproduce opens a preview of the
// build its reporter used, says which build and that it records, and names what core refused; the
// routed issue's live preview takes the reporter's Fixed or Not fixed, which core binds to the patch
// it serves. Core is stood in for over `fetch` with the contracts' own routes and schemas.

import { PREVIEW_ROUTES } from "@forge/contracts/preview";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { PREVIEW_ID, PROJECT_ID, previewOf, ticketBody } from "./fixtures";
import { ReproduceSection } from "./reproduce-section";

const REPRO_ID = "77777777-7777-4777-8777-777777777777";
const BUILD = "c".repeat(40);
const PATCH = "a".repeat(40);
const OPEN = PREVIEW_ROUTES.ofProject.replace(":id", PROJECT_ID).replace(/^\/api/, "");
const ISSUE_PREVIEW = `/issues/ISS-7/preview?projectId=${PROJECT_ID}`;

const reproduce = (over: Partial<ReturnType<typeof previewOf>> = {}) =>
  previewOf({
    id: REPRO_ID,
    subject: { kind: "reproduce", feedback: "FB-52", build: { sha: BUILD, release: "1.4.0" }, record: true },
    issueId: null,
    sessionId: null,
    ...over,
  });

const refusal = (code: string, message: string) => ({ error: { code, message, refusals: [] } });

function core(handlers: Record<string, (c: Call) => { status?: number; body: unknown } | undefined>): Call[] {
  return fakeCore((c) => handlers[`${c.method} ${c.path}`]?.(c));
}

const mount = (carriers: string[] = []) =>
  renderWithQuery(<ReproduceSection projectId={PROJECT_ID} fbKey="FB-52" carriers={carriers} redacted={false} />);

beforeEach(() => window.history.replaceState(null, "", "/projects/shop/feedback/FB-52"));
afterEach(() => vi.unstubAllGlobals());

describe("BC-17: Reproduce on the feedback item", () => {
  it("opens a reproduce of the item with one POST, keeps its id in the URL, and says its build and that it records", async () => {
    const calls = core({
      [`POST ${OPEN}`]: () => ({ status: 201, body: { preview: reproduce({ state: "starting", liveAt: null }) } }),
      [`GET /previews/${REPRO_ID}`]: () => ({ body: { preview: reproduce({ state: "starting", liveAt: null }) } }),
    });
    mount();
    expect(screen.getByText(/never production\. For members of this project only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reproduce FB-52" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ kind: "reproduce", feedback: "FB-52" }));
    expect(await screen.findByTestId("reproduce-state")).toHaveTextContent("Starting");
    expect(screen.getByTestId("reproduce-preview")).toHaveTextContent("build 1.4.0 (cccccccccccc)");
    expect(screen.getByTestId("reproduce-preview")).toHaveTextContent("recording, inputs masked");
    expect(window.location.search).toBe(`?reproduce=${REPRO_ID}`);
    expect(screen.queryByRole("button", { name: "Reproduce FB-52" }), "no second reproduce while one serves").toBeNull();
  });

  it("serves the live reproduce in the frame, entered with a ticket", async () => {
    window.history.replaceState(null, "", `/projects/shop/feedback/FB-52?reproduce=${REPRO_ID}`);
    core({
      [`GET /previews/${REPRO_ID}`]: () => ({ body: { preview: reproduce() } }),
      [`POST /previews/${REPRO_ID}/ticket`]: () => ({ body: ticketBody("tk-r") }),
    });
    mount();
    const frame = (await screen.findByTitle("Preview of FB-52")) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toContain("enter?ticket=tk-r");
  });

  it("names what core refused, in core's words: a build it cannot tell, a stranger", async () => {
    core({
      [`POST ${OPEN}`]: () => ({
        status: 422,
        body: refusal("PREVIEW_BUILD_UNKNOWN", "FB-52 names no release and none had shipped when it was filed: name a release or a sha"),
      }),
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Reproduce FB-52" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't open the reproduce: FB-52 names no release");
  });

  it("names why the build would not serve", async () => {
    window.history.replaceState(null, "", `/projects/shop/feedback/FB-52?reproduce=${REPRO_ID}`);
    core({
      [`GET /previews/${REPRO_ID}`]: () => ({
        body: { preview: reproduce({ state: "failed", reason: "REF_NOT_FOUND", detail: "fatal: remote error: upload-pack: not our ref" }) },
      }),
    });
    mount();
    const failure = await screen.findByTestId("reproduce-failure");
    expect(failure).toHaveAttribute("data-reason", "REF_NOT_FOUND");
    expect(failure).toHaveTextContent("not our ref");
  });
});

describe("BC-20: the reporter confirms the fix in its preview", () => {
  const issuePreview = previewOf();

  it("takes Fixed on the routed issue's live preview and says the patch it is bound to", async () => {
    const calls = core({
      [`GET ${ISSUE_PREVIEW}`]: () => ({ body: { preview: issuePreview } }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ body: ticketBody("tk-f") }),
      [`POST /previews/${PREVIEW_ID}/confirm`]: () => ({
        status: 201,
        body: {
          confirmations: [
            {
              feedbackId: "88888888-8888-4888-8888-888888888888",
              previewId: PREVIEW_ID,
              patchId: PATCH,
              verdict: "fixed",
              note: null,
              by: "66666666-6666-4666-8666-666666666666",
              at: "2026-10-09T12:00:00.000Z",
            },
          ],
        },
      }),
    });
    mount(["ISS-7"]);
    fireEvent.click(await screen.findByRole("button", { name: "Fixed" }));
    expect(await screen.findByTestId("fix-recorded")).toHaveTextContent("Recorded: fixed, on patch aaaaaaaaaaaa. When this change ships it closes FB-52.");
    expect(calls.find((c) => c.path === `/previews/${PREVIEW_ID}/confirm`)?.body).toEqual({ verdict: "fixed" });
  });

  it("asks what is still wrong before it sends Not fixed", async () => {
    const calls = core({
      [`GET ${ISSUE_PREVIEW}`]: () => ({ body: { preview: issuePreview } }),
      [`POST /previews/${PREVIEW_ID}/ticket`]: () => ({ body: ticketBody("tk-n") }),
      [`POST /previews/${PREVIEW_ID}/confirm`]: () => ({ status: 409, body: refusal("PREVIEW_CONFIRM_NOT_FIX", "no feedback item routes to the issue preview serves") }),
    });
    mount(["ISS-7"]);
    fireEvent.click(await screen.findByRole("button", { name: "Not fixed" }));
    const send = screen.getByRole("button", { name: "Send Not fixed" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText("What is still wrong"), { target: { value: "Still 500 with EUR." } });
    fireEvent.click(send);
    await waitFor(() =>
      expect(calls.find((c) => c.path === `/previews/${PREVIEW_ID}/confirm`)?.body).toEqual({ verdict: "not_fixed", note: "Still 500 with EUR." }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't record your answer: no feedback item routes");
  });

  it("says the fix has no live preview yet rather than offering a word on nothing", async () => {
    core({ [`GET ${ISSUE_PREVIEW}`]: () => ({ body: { preview: null } }) });
    mount(["ISS-7"]);
    expect(await screen.findByTestId("fix-not-live")).toHaveTextContent("ISS-7 has no live preview of its fix yet");
    expect(screen.queryByRole("button", { name: "Fixed" })).toBeNull();
  });
});
