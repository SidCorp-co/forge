// @vitest-environment jsdom
//
// ISS-767, ISS-1069 — the Testing tab is where a human writes the two things no job can derive:
// the limits that stop an acceptance criterion from being discovered as unwalkable at the gate,
// and the live address a release ships to, which until ISS-1069 had no field anywhere in the
// schema. The tab saves `environments` as ONE blob against a server that REPLACES the column
// outright, so the risk that matters is not whether a field saves: it is whether saving one field
// takes the credentials, the other side, or a key this screen does not render with it.
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
  preview: {
    url: "https://beta.example.com",
    apiUrl: null,
    urls: [{ label: "Beta", url: "https://beta.example.com" }],
  },
  live: {
    url: "https://app.example.com",
    // cm:guard `live.apiUrl` is STORED and NOT RENDERED, deliberately: it is the key that proves
    // the save spreads the stored side rather than rebuilding it from the four inputs on screen.
    apiUrl: "https://api.example.com",
    commitUrl: "https://api.example.com/health",
    commitPath: "data.commit",
  },
  testCredentials: [{ label: "Admin", username: "bot@example.com", password: "keep-me" }],
  limits: "The QA account cannot reach every project.",
  someFutureKnob: "round-trips",
};

function renderTab(environments: unknown = STORED, canEdit = true) {
  const qc = new QueryClient();
  const project = { id: "proj-1", environments } as unknown as ProjectDetail;
  return render(
    <QueryClientProvider client={qc}>
      <TestingTab project={project} canEdit={canEdit} />
    </QueryClientProvider>,
  );
}

const limitsBox = () => screen.getByLabelText("Environment limits") as HTMLTextAreaElement;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const saveBtn = () => screen.getByRole("button", { name: /save testing config/i });
const sent = () =>
  (mutate.mock.calls[0]?.[0] as { environments: Record<string, unknown> }).environments;

beforeEach(() => {
  mutate.mockClear();
});
afterEach(cleanup);

describe("Testing tab · limits (ISS-767, ISS-1069)", () => {
  it("shows the stored limits so a human can see what is already documented", () => {
    renderTab();
    expect(limitsBox()).toHaveValue("The QA account cannot reach every project.");
  });

  it("starts clean — loading a project does not read as unsaved changes", () => {
    renderTab();
    expect(saveBtn()).toBeDisabled();
  });

  it("enables save once the limits are edited, and sends the new text", () => {
    renderTab();
    fireEvent.change(limitsBox(), {
      target: { value: "No issue ever rests at the release gate." },
    });
    expect(saveBtn()).toBeEnabled();
    fireEvent.click(saveBtn());
    expect(sent().limits).toBe("No issue ever rests at the release gate.");
  });

  it("clearing the limits sends null rather than an empty string", () => {
    renderTab();
    fireEvent.change(limitsBox(), { target: { value: "   " } });
    fireEvent.click(saveBtn());
    expect(sent().limits).toBeNull();
  });

  // cm:guard the field ASKS A QUESTION rather than inviting anything, which is the whole reason it
  // was renamed: the field it replaced said "notes" and was filled on 4 of 32 projects. A screen
  // that renamed the key and kept the invitation would have changed nothing that was measured.
  it("names the field for what it asks, not for notes in general", () => {
    renderTab();
    expect(screen.getByText("What this environment does not have")).toBeInTheDocument();
    expect(screen.getByText(/what a test account cannot reach/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("Testing usage notes")).toBeNull();
    expect(screen.queryByText(/usage notes/i)).toBeNull();
  });

  it("tells the reader not to put secrets in it, next to the field itself", () => {
    renderTab();
    expect(screen.getByText(/never put a password here/i)).toBeInTheDocument();
  });

  it("renders empty without crashing on a project that has no environments at all", () => {
    renderTab(null);
    expect(limitsBox()).toHaveValue("");
    expect(field("Live URL")).toHaveValue("");
  });

  it("is read-only for a member who cannot edit settings", () => {
    renderTab(STORED, false);
    expect(limitsBox()).toBeDisabled();
    expect(screen.queryByRole("button", { name: /save testing config/i })).toBeNull();
  });
});

describe("Testing tab · the live side (ISS-1069)", () => {
  it("offers a field for the live URL, the commit endpoint and the commit path", () => {
    renderTab();
    expect(field("Live URL")).toHaveValue("https://app.example.com");
    expect(field("Live commit endpoint")).toHaveValue("https://api.example.com/health");
    expect(field("Live commit path")).toHaveValue("data.commit");
  });

  // cm:guard the commit path's own hint has to carry BOTH fleet shapes and the empty case, because
  // it is the one field an operator cannot guess: `sid-desk` answers `{"commit":…}` and `sidpeak`
  // answers `{"data":{"commit":…}}`, and a blank path means the whole body is the commit.
  it("says what a commit path looks like, including what blank means", () => {
    renderTab();
    const hint = screen.getByText(/dot path to the commit/i).textContent ?? "";
    expect(hint).toContain("commit");
    expect(hint).toContain("data.commit");
    expect(hint).toMatch(/blank/i);
    expect(hint).toMatch(/whole response body/i);
  });

  it("saves all three live fields and the limits together", () => {
    renderTab();
    fireEvent.change(field("Live URL"), { target: { value: "https://new.example.com" } });
    fireEvent.change(field("Live commit endpoint"), {
      target: { value: "https://new.example.com/version" },
    });
    fireEvent.change(field("Live commit path"), { target: { value: "commit" } });
    fireEvent.change(limitsBox(), { target: { value: "no outbound email" } });
    fireEvent.click(saveBtn());

    const live = sent().live as Record<string, unknown>;
    expect(live.url).toBe("https://new.example.com");
    expect(live.commitUrl).toBe("https://new.example.com/version");
    expect(live.commitPath).toBe("commit");
    expect(sent().limits).toBe("no outbound email");
  });

  it("refuses to save a live URL that is not a URL, and says so", () => {
    renderTab();
    fireEvent.change(field("Live URL"), { target: { value: "not-a-url" } });
    expect(screen.getAllByText(/enter a valid url/i).length).toBeGreaterThan(0);
    expect(saveBtn()).toBeDisabled();
  });
});

describe("Testing tab · what a save must not take with it (ISS-1069)", () => {
  // cm:guard the server REPLACES `environments` outright — nothing merges, at any depth — so a save
  // that rebuilt the blob from form state alone would delete every key this screen does not render.
  // `live.apiUrl` and `someFutureKnob` are the two shapes of that: a field the schema names and one
  // it does not.
  it("keeps the credentials, the preview side, live.apiUrl and an unknown key", () => {
    renderTab();
    fireEvent.change(limitsBox(), { target: { value: "updated" } });
    fireEvent.click(saveBtn());

    const env = sent();
    expect(env.testCredentials).toEqual([
      { label: "Admin", username: "bot@example.com", password: "keep-me" },
    ]);
    expect(env.preview).toEqual({
      url: "https://beta.example.com",
      apiUrl: null,
      urls: [{ label: "Beta", url: "https://beta.example.com" }],
    });
    expect((env.live as Record<string, unknown>).apiUrl).toBe("https://api.example.com");
    expect(env.someFutureKnob).toBe("round-trips");
  });

  // cm:guard `preview: null` is a one-box project SAYING it has no other side. Writing `{}` over it
  // turns a statement into a gap every reader has to re-derive, and would make the project look
  // half-configured on a screen that reports gaps.
  it("leaves a null preview null rather than writing an empty preview object", () => {
    renderTab({ ...STORED, preview: null });
    fireEvent.change(limitsBox(), { target: { value: "updated" } });
    fireEvent.click(saveBtn());
    expect(sent().preview).toBeNull();
  });

  it("writes a preview object once a preview field is filled in", () => {
    renderTab({ ...STORED, preview: null });
    fireEvent.change(field("Preview URL"), { target: { value: "https://stg.example.com" } });
    fireEvent.click(saveBtn());
    expect(sent().preview).toEqual({
      url: "https://stg.example.com",
      apiUrl: null,
      urls: [],
    });
  });

  it("clears the preview back to null when its last field is emptied", () => {
    renderTab({ ...STORED, preview: { url: "https://stg.example.com" } });
    fireEvent.change(field("Preview URL"), { target: { value: "  " } });
    fireEvent.click(saveBtn());
    expect(sent().preview).toBeNull();
  });
});
