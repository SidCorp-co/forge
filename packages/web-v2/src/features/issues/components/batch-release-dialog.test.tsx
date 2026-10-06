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

function accepted(verification: "probed" | "unverified", more: Record<string, unknown> = {}) {
  answer(201, {
    runId: "run-1",
    jobId: "job-1",
    issueIds: ISSUES.map((i) => i.id),
    gateStatus: "awaiting_release",
    verification,
    carried: null,
    warnings: [],
    ...more,
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

describe("what the dialog promises before the press", () => {
  it("promises a release and a close, not a deploy some projects never take", () => {
    draw();

    const drawer = screen.getByRole("dialog");
    expect(drawer).toHaveTextContent(/will be released together and closed in one batch/);
    expect(drawer.textContent).not.toMatch(/deployed/);
  });
});

describe("a batch release the server accepts", () => {
  it("closes the dialog and hands the parent its success", async () => {
    accepted("probed");
    draw();
    press();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Batch release started — 2 issues")).toBeInTheDocument();
    expect(screen.queryByText(/unverified/i)).not.toBeInTheDocument();
  });

  it("says a release with no probe will close unverified", async () => {
    accepted("unverified");
    draw();
    press();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Batch release started — 2 issues")).toBeInTheDocument();
    expect(screen.getByText(/close unverified/i)).toBeInTheDocument();
  });

  it("says the cut it promotes and each warning the server answered with", async () => {
    accepted("probed", {
      carried: { kind: "read", live: "production", start: "main", cut: "d".repeat(40), issues: [], cutBelow: [] },
      warnings: [{ code: "RELEASE_CARRIED_UNREAD", message: "Nothing read what this release carries." }],
    });
    draw();
    press();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/It promotes dddddddddddd\./)).toBeInTheDocument();
    expect(screen.getByText(/Nothing read what this release carries\./)).toBeInTheDocument();
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

// ISS-1386 — a release whose range carries issues the roster does not name is refused until each
// holds a decision, and the dialog is where a person makes them.
const CARRIES = {
  code: "RELEASE_CARRIES_UNDECIDED",
  message: "This release promotes `main` onto `production`, and that range carries ISS-7 at `needs_info`.",
  details: {
    carried: [
      { issueId: "iss-7", displayId: "ISS-7", status: "needs_info", landing: "b".repeat(40) },
      { issueId: "iss-8", displayId: "ISS-8", status: "testing", landing: "c".repeat(40) },
    ],
  },
};

const radios = (id: string) => screen.getByTestId(`carried-${id}`).querySelectorAll('[role="radio"]');
const sentBody = (call: number) => JSON.parse(String(fetchMock.mock.calls[call]?.[1]?.body));

describe("issues the release would ship without naming them", () => {
  it("lists each one with the three choices once a press is refused for them", async () => {
    answer(409, CARRIES);
    draw();
    press();

    const seven = await screen.findByTestId("carried-ISS-7");
    for (const row of [seven, screen.getByTestId("carried-ISS-8")]) {
      for (const label of ["Ship unverified", "Reverted", "Cut below"]) expect(row).toHaveTextContent(label);
    }
    expect(seven).toHaveTextContent("at needs_info");
  });

  it("holds the release until each is decided, and a Ship unverified carries its reason", async () => {
    answer(409, CARRIES);
    draw();
    press();
    await screen.findByTestId("carried-ISS-7");
    const button = () => screen.getByRole("button", { name: /release 2 now/i });
    expect(button()).toBeDisabled();

    fireEvent.click(radios("ISS-7")[0] as Element);
    fireEvent.click(radios("ISS-8")[2] as Element);
    expect(button()).toBeDisabled();

    fireEvent.change(screen.getByLabelText("What is unverified in ISS-7"), {
      target: { value: "criterion 2 needs payroll writes" },
    });
    expect(button()).toBeEnabled();
  });

  it("keeps a decision already made when the next refusal names only a newly landed issue", async () => {
    answer(409, { ...CARRIES, details: { carried: [CARRIES.details.carried[0]] } });
    draw();
    press();
    await screen.findByTestId("carried-ISS-7");
    fireEvent.click(radios("ISS-7")[1] as Element);

    answer(409, { ...CARRIES, details: { carried: [CARRIES.details.carried[1]] } });
    press();
    await screen.findByTestId("carried-ISS-8");
    expect(screen.getByTestId("carried-ISS-7")).toBeInTheDocument();
    fireEvent.click(radios("ISS-8")[1] as Element);
    accepted("probed");
    press();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(sentBody(2).carried).toEqual([
      { issueId: "iss-7", decision: "revert" },
      { issueId: "iss-8", decision: "revert" },
    ]);
  });

  it("sends each decision with the batch when pressed again, and none on the first press", async () => {
    answer(409, CARRIES);
    draw();
    press();
    await screen.findByTestId("carried-ISS-7");
    expect(sentBody(0)).toEqual({ issueIds: ["iss-a", "iss-b"] });

    fireEvent.click(radios("ISS-7")[0] as Element);
    fireEvent.change(screen.getByLabelText("What is unverified in ISS-7"), {
      target: { value: "  criterion 2 needs payroll writes  " },
    });
    fireEvent.click(radios("ISS-8")[1] as Element);
    accepted("probed");
    press();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(sentBody(1)).toEqual({
      issueIds: ["iss-a", "iss-b"],
      carried: [
        { issueId: "iss-7", decision: "ship-unverified", why: "criterion 2 needs payroll writes" },
        { issueId: "iss-8", decision: "revert" },
      ],
    });
  });
});
