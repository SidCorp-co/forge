// @vitest-environment jsdom
//
// ISS-767 — the Testing tab is where a human writes the usage notes that stop an
// acceptance criterion from being discovered as unwalkable at the gate. The tab
// saves `previewDeploy` as ONE blob, so the risk that matters is not whether the
// note saves: it is whether saving a note takes the test credentials with it.
//
// Per-file jsdom + matchers-on-vitest's-own-expect, for the reasons written up in
// project-dashboard/awaiting-release-card.test.tsx.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetail } from "@/features/projects/types";
import { TestingTab } from "./components/testing-tab";

expect.extend(matchers);

const mutate = vi.fn();
vi.mock("./hooks", () => ({
  useUpdateProject: () => ({ mutate, isPending: false }),
}));

const STORED = {
  stagingUrl: "https://beta.example.com",
  stagingApiUrl: null,
  testingUrls: [{ label: "Beta", url: "https://beta.example.com" }],
  testCredentials: [{ label: "Admin", username: "bot@example.com", password: "keep-me" }],
  notes: "The QA account cannot reach every project.",
  someFutureKnob: "round-trips",
};

function renderTab(previewDeploy: unknown = STORED, canEdit = true) {
  const qc = new QueryClient();
  const project = { id: "proj-1", previewDeploy } as unknown as ProjectDetail;
  return render(
    <QueryClientProvider client={qc}>
      <TestingTab project={project} canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

const notesBox = () => screen.getByLabelText("Testing usage notes") as HTMLTextAreaElement;
const saveBtn = () => screen.getByRole("button", { name: /save testing config/i });

beforeEach(() => {
  mutate.mockClear();
});
afterEach(cleanup);

describe("Testing tab · usage notes (ISS-767)", () => {
  it("shows the stored note so a human can see what is already documented", () => {
    renderTab();
    expect(notesBox()).toHaveValue("The QA account cannot reach every project.");
  });

  it("starts clean — loading a project does not read as unsaved changes", () => {
    renderTab();
    expect(saveBtn()).toBeDisabled();
  });

  it("enables save once the note is edited, and sends the new text", () => {
    renderTab();
    fireEvent.change(notesBox(), { target: { value: "No issue ever rests at the release gate." } });
    expect(saveBtn()).toBeEnabled();
    fireEvent.click(saveBtn());
    const sent = mutate.mock.calls[0]?.[0] as { previewDeploy: Record<string, unknown> };
    expect(sent.previewDeploy.notes).toBe("No issue ever rests at the release gate.");
  });

  // cm:guard the whole previewDeploy blob is PATCHed as one object, so a save that rebuilds it from form state alone would delete the credentials and URLs sitting beside the note — the same clobber the server-side scoped write guards against
  it("saving a note keeps the credentials, URLs and unknown keys beside it", () => {
    renderTab();
    fireEvent.change(notesBox(), { target: { value: "updated" } });
    fireEvent.click(saveBtn());
    const pd = (mutate.mock.calls[0]?.[0] as { previewDeploy: Record<string, unknown> })
      .previewDeploy;
    expect(pd.testCredentials).toEqual([
      { label: "Admin", username: "bot@example.com", password: "keep-me" },
    ]);
    expect(pd.testingUrls).toEqual([{ label: "Beta", url: "https://beta.example.com" }]);
    expect(pd.stagingUrl).toBe("https://beta.example.com");
    expect(pd.someFutureKnob).toBe("round-trips");
  });

  it("clearing the note sends null rather than an empty string", () => {
    renderTab();
    fireEvent.change(notesBox(), { target: { value: "   " } });
    fireEvent.click(saveBtn());
    const pd = (mutate.mock.calls[0]?.[0] as { previewDeploy: Record<string, unknown> })
      .previewDeploy;
    expect(pd.notes).toBeNull();
  });

  it("renders an empty note without crashing on a project that has no previewDeploy", () => {
    renderTab(null);
    expect(notesBox()).toHaveValue("");
  });

  it("is read-only for a member who cannot edit settings", () => {
    renderTab(STORED, false);
    expect(notesBox()).toBeDisabled();
    expect(screen.queryByRole("button", { name: /save testing config/i })).toBeNull();
  });

  it("tells the reader not to put secrets in it, next to the field itself", () => {
    renderTab();
    expect(screen.getByText(/never put a password here/i)).toBeInTheDocument();
  });
});
