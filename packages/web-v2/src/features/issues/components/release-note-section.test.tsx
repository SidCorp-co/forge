// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReleaseNotes } from "@forge/contracts";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";
import type { IssueStatus } from "../types";
import { BUILT_NOT_RELEASED, NOTE_WRITTEN_HERE, ReleaseNoteSection } from "./release-note-section";

expect.extend(matchers);
vi.mock("@sentry/react", () => ({ captureException: vi.fn() }));
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    async () => new Response(JSON.stringify({ id: "iss-1" }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrapped(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

const FIXED: ReleaseNotes = {
  section: "Fixed",
  userFacing: "The invoice PDF now shows the customer's billing address.",
};
const SKIP: ReleaseNotes = { section: "Skip", userFacing: "-" };

function show(status: IssueStatus, releaseNotes: ReleaseNotes | null | undefined, canWrite = false) {
  return wrapped(<ReleaseNoteSection issue={{ id: "iss-1", status, releaseNotes }} canWrite={canWrite} />);
}

describe("the release note on an issue's page", () => {
  it("says what changed on a closed issue, in the note's own words", () => {
    show("closed", FIXED);
    expect(screen.getByText("What changed")).toBeInTheDocument();
    expect(screen.getByText(FIXED.userFacing)).toBeInTheDocument();
  });

  it("speaks of a change still to be released at Awaiting release, the status the done page names", () => {
    show("awaiting_release", FIXED);
    expect(screen.getByText("What will change once it is released")).toBeInTheDocument();
  });

  it.each([...BUILT_NOT_RELEASED])(
    "speaks of a change still to be released at %s",
    (status) => {
      show(status, FIXED);
      expect(screen.getByText("What will change once it is released")).toBeInTheDocument();
      expect(screen.getByText(FIXED.userFacing)).toBeInTheDocument();
    },
  );

  it.each(["reopen", "needs_info", "on_hold", "in_progress"] as const)(
    "keeps a neutral heading at %s, where nothing says whether it shipped",
    (status) => {
      show(status, FIXED);
      expect(screen.getByText("Release note")).toBeInTheDocument();
      expect(screen.queryByText("What will change once it is released")).toBeNull();
      expect(screen.queryByText("What changed")).toBeNull();
    },
  );

  it("says nothing you would see changed when the note records no user-facing part", () => {
    show("closed", SKIP);
    expect(screen.getByText("What changed")).toBeInTheDocument();
    expect(screen.getByText(/Nothing you would see changed/)).toBeInTheDocument();
    expect(screen.queryByText("-")).toBeNull();
  });

  it.each([null, undefined])("draws nothing when the issue carries no note (%s)", (note) => {
    const { container } = show("closed", note);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the note's markdown instead of showing its markup", () => {
    const { container } = show("testing", {
      section: "Fixed",
      userFacing: "Run `forge-runner status` to see **which** version is live.",
    });
    expect(container.textContent).toContain("Run forge-runner status to see which version is live.");
    expect(container.textContent).not.toMatch(/[`*]/);
    expect(container.querySelector("code")).toHaveTextContent("forge-runner status");
  });

  it("draws nothing on a dropped issue, whatever note it carries", () => {
    const { container } = show("dropped", FIXED);
    expect(container).toBeEmptyDOMElement();
  });
});

// ISS-1421 r38, judge-155: the release gate told a person to "ask for" a release note, and no field
// anywhere in the web let a person write one.
describe("a release note the release gate asks for, written on the issue's page", () => {
  function sent(): unknown {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/issues\/iss-1$/);
    expect(init.method).toBe("PATCH");
    return JSON.parse(String(init.body));
  }

  it.each([...NOTE_WRITTEN_HERE])("offers a member the field at %s, where none is written", (status) => {
    show(status, null, true);
    expect(screen.getByRole("region", { name: "Release note" })).toHaveTextContent(
      "This issue has no release note, and a release will not close it without one.",
    );
    expect(screen.getByRole("button", { name: "Save release note" })).toBeDisabled();
  });

  // ISS-1421 r39, judge-160: a note typed with no kind chosen left Save dimmed and said nothing.
  it("says beside a disabled Save what it waits for, and nothing once it may be pressed", () => {
    show("awaiting_release", null, true);
    const save = () => screen.getByRole("button", { name: "Save release note" });
    fireEvent.change(screen.getByRole("textbox", { name: /What a user will see/ }), {
      target: { value: "Invoices show the tax line." },
    });
    expect(save()).toBeDisabled();
    expect(save()).toHaveAccessibleDescription("Choose what kind of change this is to save the note.");
    fireEvent.change(screen.getByRole("textbox", { name: /What a user will see/ }), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("radio", { name: "A fix" }));
    expect(save()).toHaveAccessibleDescription("Write what a user will see to save the note.");
    fireEvent.change(screen.getByRole("textbox", { name: /What a user will see/ }), {
      target: { value: "Invoices show the tax line." },
    });
    expect(save()).toBeEnabled();
    expect(save()).not.toHaveAttribute("aria-describedby");
  });

  it("saves the line a user would read under the kind picked", async () => {
    show("awaiting_release", null, true);
    fireEvent.click(screen.getByRole("radio", { name: "A fix" }));
    fireEvent.change(screen.getByRole("textbox", { name: /What a user will see/ }), {
      target: { value: "  Invoices show the billing address.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save release note" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual({ releaseNotes: { section: "Fixed", userFacing: "Invoices show the billing address." } });
  });

  it("saves that nothing a user sees changes without asking for a line", async () => {
    show("awaiting_release", null, true);
    fireEvent.click(screen.getByRole("radio", { name: "Nothing a user sees changes" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save release note" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual({ releaseNotes: { section: "Skip", userFacing: "-" } });
  });

  it("offers no field to a reader who may not change the issue", () => {
    const { container } = show("awaiting_release", null, false);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["in_progress", "releasing", "closed"] as const)("offers no field at %s, where no gate asks", (status) => {
    const { container } = show(status, null, true);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a note already written rather than the field", () => {
    show("awaiting_release", FIXED, true);
    expect(screen.queryByRole("button", { name: "Save release note" })).toBeNull();
    expect(screen.getByText(FIXED.userFacing)).toBeInTheDocument();
  });
});
