// @vitest-environment jsdom
//
// Per-file jsdom opt-in — see the docblock on
// project-dashboard/awaiting-release-card.test.tsx for why the shared config
// stays `environment: 'node'`.
//
// ISS-1322. The real dialog, the real hook and the real `apiClient`, over a
// stubbed `fetch`. The refusal has to be found INSIDE the dialog: the hook's
// toast is in the document too, but it paints beneath the drawer's scrim, and a
// test that looked at the whole document passed while the owner saw nothing.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
import { BatchReleaseDialog } from "./batch-release-dialog";

expect.extend(matchers);

vi.mock("@sentry/react", () => ({ captureException: vi.fn() }));

const REFUSAL =
  "A declared verification probe holds a url that is not a url, so no request could ever be made to it and the release would fail while reading what production is serving. Correct the probe, including its scheme.";

const ISSUES = [
  { id: "iss-a", displayId: "ISS-1", title: "Signup accepts a plan that is not sold" },
  { id: "iss-b", displayId: "ISS-2", title: "Dropdown renders flat" },
];

const fetchMock = vi.fn();

function answer(status: number, body: unknown) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

function accepted(verification: "probed" | "unverified") {
  answer(201, {
    runId: "run-1",
    ownerDeadlineAt: "2026-09-30T10:30:00.000Z",
    issueIds: ISSUES.map((i) => i.id),
    gateStatus: "awaiting_release",
    verification,
  });
}

const onClose = vi.fn();
const onSuccess = vi.fn();

function dialog(open: boolean): ReactElement {
  return (
    <BatchReleaseDialog
      projectId="proj-1"
      selectedIssues={ISSUES}
      open={open}
      onClose={onClose}
      onSuccess={onSuccess}
    />
  );
}

function draw() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrap = (node: ReactElement) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>
  );
  const view = render(wrap(dialog(true)));
  return { ...view, reopen: (open: boolean) => view.rerender(wrap(dialog(open))) };
}

function press() {
  fireEvent.click(screen.getByRole("button", { name: /release 2 now/i }));
}

beforeEach(() => {
  fetchMock.mockReset();
  onClose.mockReset();
  onSuccess.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a batch release the server refuses", () => {
  it("shows the server's own sentence inside the dialog", async () => {
    answer(409, { code: "RELEASE_PROBES_UNREADABLE", message: REFUSAL });
    draw();
    press();

    const drawer = screen.getByRole("dialog");
    const alert = await within(drawer).findByRole("alert");
    expect(alert).toHaveTextContent(REFUSAL);
  });

  it("keeps the dialog open with the same issues listed", async () => {
    answer(409, { code: "RELEASE_PROBES_UNREADABLE", message: REFUSAL });
    draw();
    press();

    const drawer = screen.getByRole("dialog");
    await within(drawer).findByRole("alert");
    expect(onClose).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(within(drawer).getByText("ISS-1")).toBeInTheDocument();
    expect(within(drawer).getByText("ISS-2")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: /release 2 now/i })).toBeEnabled();
  });

  it("raises no started toast", async () => {
    answer(409, { code: "RELEASE_PROBES_UNREADABLE", message: REFUSAL });
    draw();
    press();

    await within(screen.getByRole("dialog")).findByRole("alert");
    expect(screen.queryByText(/batch release started/i)).not.toBeInTheDocument();
  });

  it("does not carry the refusal into the dialog when it is opened again", async () => {
    answer(409, { code: "RELEASE_PROBES_UNREADABLE", message: REFUSAL });
    const view = draw();
    press();
    await within(screen.getByRole("dialog")).findByRole("alert");

    view.reopen(false);
    view.reopen(true);

    // React Query hands the reset to its notify scheduler, a tick after the effect.
    const drawer = screen.getByRole("dialog");
    await waitFor(() => expect(within(drawer).queryByRole("alert")).not.toBeInTheDocument());
    expect(within(drawer).queryByText(REFUSAL)).not.toBeInTheDocument();
  });

  it("answers a gateway page with no JSON body by its status, never by nothing", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway" }));
    draw();
    press();

    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert.textContent?.trim().length).toBeGreaterThan(0);
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

describe("a batch release the server accepts", () => {
  it("closes the dialog and hands the parent its success", async () => {
    accepted("probed");
    draw();
    press();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText("Release handed to this project's master — 2 issues"),
    ).toBeInTheDocument();
    expect(screen.getByText(/If no master takes it by .+, it is cancelled/)).toBeInTheDocument();
    expect(screen.queryByText(/unverified/i)).not.toBeInTheDocument();
  });

  it("says a release with no probe will close unverified", async () => {
    accepted("unverified");
    draw();
    press();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("Release handed to this project's master — 2 issues"),
    ).toBeInTheDocument();
    expect(screen.getByText(/close unverified/i)).toBeInTheDocument();
  });
});

// The judge's findings at ea73cf8 (bd150873): backticks shown raw, a retry nothing on screen
// told apart from the first press, and a hidden toast that repeated the banner after Cancel.
const EMPTY_ROSTER =
  "Nothing is waiting at the release gate, so there is no release to cut. An issue reaches it by moving to `awaiting_release`, which is an act of its own.";

function held() {
  let settle: (status: number, body: unknown) => void = () => {};
  fetchMock.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      settle = (status, body) =>
        resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    }),
  );
  return (status: number, body: unknown) => settle(status, body);
}

describe("a refusal, said once and where it can be read", () => {
  it("shows the sentence's code spans as code, with no backtick left in it", async () => {
    answer(409, { code: "RELEASE_ROSTER_EMPTY", message: EMPTY_ROSTER });
    draw();
    press();

    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert.textContent).not.toContain("`");
    expect(within(alert).getByText("awaiting_release").tagName).toBe("CODE");
    expect(alert).toHaveTextContent("moving to awaiting_release, which is an act of its own");
  });

  it("shows that a second press went out, and that it failed as well", async () => {
    answer(409, { code: "RELEASE_PROBES_UNREADABLE", message: REFUSAL });
    draw();
    press();
    const drawer = screen.getByRole("dialog");
    await within(drawer).findByRole("alert");

    const second = held();
    press();
    await waitFor(() => expect(within(drawer).getByRole("alert")).toHaveTextContent(/sending try 2/i));

    second(409, { code: "RELEASE_PROBES_UNREADABLE", message: REFUSAL });
    await waitFor(() => expect(within(drawer).getByRole("alert")).toHaveTextContent(/try 2 failed as well/i));
    expect(within(drawer).getByRole("alert")).toHaveTextContent(REFUSAL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("raises no failure toast while the dialog that shows the refusal is open", async () => {
    answer(409, { code: "RELEASE_PROBES_UNREADABLE", message: REFUSAL });
    draw();
    press();

    await within(screen.getByRole("dialog")).findByRole("alert");
    expect(screen.queryByText("Batch release failed")).not.toBeInTheDocument();
  });

  it("toasts a refusal that lands after the dialog was closed, with the server's sentence", async () => {
    const answerLate = held();
    const view = draw();
    press();
    view.reopen(false);

    answerLate(409, { code: "RELEASE_PROBES_UNREADABLE", message: REFUSAL });
    const title = await screen.findByText("Batch release failed");
    expect(title.parentElement?.parentElement).toHaveTextContent(REFUSAL);
  });

  it("shows a press still in flight when the dialog is opened again, in that dialog", async () => {
    const answerLate = held();
    const view = draw();
    press();
    view.reopen(false);
    view.reopen(true);

    answerLate(409, { code: "RELEASE_PROBES_UNREADABLE", message: REFUSAL });
    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert).toHaveTextContent(REFUSAL);
    expect(screen.queryByText("Batch release failed")).not.toBeInTheDocument();
  });
});
