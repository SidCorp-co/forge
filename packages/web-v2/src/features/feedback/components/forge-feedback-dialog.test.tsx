// REQ-47 BC-9: the shell's Feedback to Forge entry files about Forge itself, as the signed-in person,
// into Forge's own home project through `/api/forge/feedback` — never into the project the page is on,
// which it names only as where the report came from.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentProjectProvider, type ProjectListItem } from "@/features/projects";
import { fakeCore, renderWithQuery } from "@/test/render";
import { ForgeFeedbackButton } from "./forge-feedback-dialog";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

afterEach(() => vi.unstubAllGlobals());

const HOP = { id: "p-hop", slug: "hop", name: "HOP" } as ProjectListItem;
const ITEM = (key: string) => ({
  key,
  title: "The board drops a card",
  kind: "bug",
  severity: "medium",
  phase: "new",
  route: null,
  origin: null,
  createdAt: "2026-10-21T08:00:00.000Z",
  updatedAt: "2026-10-21T08:00:00.000Z",
  progress: { says: "Waiting to be triaged.", running: false, eta: { estimate: false } },
});

function served(filing: { status?: number; body: unknown }) {
  return fakeCore((c) =>
    c.path === "/version"
      ? { body: { version: "0.4.0-dev.258", sourceCommit: null, uptimeSeconds: 10 } }
      : c.method === "POST" && c.path === "/forge/feedback"
        ? filing
        : undefined,
  );
}

async function fileFrom(path: string) {
  window.history.replaceState(null, "", path);
  const user = userEvent.setup();
  renderWithQuery(
    <CurrentProjectProvider project={HOP}>
      <ForgeFeedbackButton />
    </CurrentProjectProvider>,
  );
  await user.click(screen.getByTestId("forge-feedback-open"));
  await user.type(screen.getByLabelText(/^Title/), "The board drops a card");
  await user.type(screen.getByLabelText("What happened"), "Dragging a card to Done loses it.");
  await waitFor(() => expect(screen.getByTestId("forge-feedback-where").textContent).toContain(path));
  await user.click(screen.getByRole("button", { name: "Send to Forge" }));
  return user;
}

describe("Feedback to Forge", () => {
  it("files into the Forge door as the signed-in person, naming the page and project it came from", async () => {
    const calls = served({ status: 201, body: { created: true, feedback: ITEM("FB-12") } });
    await fileFrom("/projects/hop/issues?status=open");
    await screen.findByText("FB-12 filed.");
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual(["/forge/feedback"]);
    expect(posts[0]?.body).toEqual({
      kind: "bug",
      title: "The board drops a card",
      body: "Dragging a card to Done loses it.",
      whereSeen: "/projects/hop/issues?status=open",
      clientVersion: "web 0.4.0-dev.258",
      from: { project: "p-hop" },
    });
    expect(screen.getByRole("link", { name: "Your feedback to Forge" }).getAttribute("href")).toBe("/forge-feedback");
  });

  it("says a report of an open item joined it rather than filing another", async () => {
    served({ body: { created: false, feedback: ITEM("FB-7") } });
    await fileFrom("/settings");
    await screen.findByText("Added to FB-7, already reported.");
  });

  it("shows the refusal by name when the instance names no home project", async () => {
    served({
      status: 409,
      body: {
        error: {
          code: "FORGE_HOME_NOT_SET",
          message: "refused",
          refusals: [{ code: "FORGE_HOME_NOT_SET", path: "", detail: "this Forge instance names no project as its home" }],
        },
      },
    });
    await fileFrom("/settings");
    await screen.findByText(/names no project as its home/);
    expect(screen.queryByTestId("forge-feedback-filed")).toBeNull();
  });
});
