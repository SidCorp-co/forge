// BC-3 in chat: the dock beside an issue page shows that issue's preview, compact, with the message box
// that asks the run for a change (BC-6); beside any other page, or an issue with no preview, it draws nothing.

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { DockPreview, issuePageOf } from "./dock-preview";
import { ISSUE_ID, PREVIEW_ID, PROJECT_ID, previewOf, ticketBody } from "@/features/previews/fixtures";

const issue = (over: Record<string, unknown> = {}) => ({
  id: ISSUE_ID,
  displayId: "ISS-491",
  projectId: PROJECT_ID,
  agentSessions: [{ id: "s1", status: "running" }],
  ...over,
});
const projects = [{ id: PROJECT_ID, slug: "forge", name: "Forge", role: "member" }];

function core(preview: unknown) {
  return fakeCore((c) => {
    if (c.method === "GET" && c.path.startsWith("/issues/ISS-491")) return { body: issue() };
    if (c.method === "GET" && c.path === "/projects") return { body: projects };
    if (c.method === "GET" && c.path === `/issues/${ISSUE_ID}/preview`) return { body: { preview } };
    if (c.method === "POST" && c.path === `/previews/${PREVIEW_ID}/ticket`) return { body: ticketBody("t") };
    if (c.method === "POST" && c.path === `/previews/${PREVIEW_ID}/messages`) return { status: 202, body: { sent: true, seq: 1 } };
    return undefined;
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("issuePageOf", () => {
  it("reads the issue a page path is the page of, by key or uuid", () => {
    expect(issuePageOf("/projects/forge/issues/ISS-491")).toBe("ISS-491");
    expect(issuePageOf(`/projects/forge/issues/${ISSUE_ID}`)).toBe(ISSUE_ID);
  });
  it("is null for every other page", () => {
    for (const p of ["/projects/forge/issues", "/projects/forge/requirements/REQ-39", "/", null]) expect(issuePageOf(p)).toBeNull();
  });
});

describe("the dock's preview", () => {
  it("shows the issue's live preview compact, and a message sent from it reaches the run", async () => {
    const calls = core(previewOf());
    renderWithQuery(<DockPreview pathname="/projects/forge/issues/ISS-491" projectId={PROJECT_ID} />);
    expect(await screen.findByTitle("Preview of ISS-491")).toBeInTheDocument();
    expect(screen.getByTestId("preview-panel")).toBeInTheDocument();
    expect(screen.queryByText("Live preview")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "Ask for a change" }), { target: { value: "darker header" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.find((c) => c.path.endsWith("/messages"))?.body).toEqual({ text: "darker header" }));
  });

  it("never offers to start one: beside the chat a preview is only shown", async () => {
    const calls = core(null);
    renderWithQuery(<DockPreview pathname="/projects/forge/issues/ISS-491" projectId={PROJECT_ID} />);
    await waitFor(() => expect(calls.some((c) => c.path === `/issues/${ISSUE_ID}/preview`)).toBe(true));
    await waitFor(() => expect(screen.queryByTestId("preview-panel")).toBeNull());
    expect(screen.queryByRole("button", { name: "Start preview" })).toBeNull();
    expect(document.body.querySelector("[class*=border-b]")).toBeNull();
  });

  it("reads nothing on a page that is not an issue", () => {
    const calls = core(previewOf());
    renderWithQuery(<DockPreview pathname="/projects/forge/requirements/REQ-39" projectId={PROJECT_ID} />);
    expect(calls).toHaveLength(0);
    expect(screen.queryByTestId("preview-panel")).toBeNull();
  });
});
