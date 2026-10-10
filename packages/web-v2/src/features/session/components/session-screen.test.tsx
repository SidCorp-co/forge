// A session's page as a record page (REQ-43): the person's view reads the session's state and what it
// produced; the agent's text — its tool calls, file paths, raw output, ids, tokens and the box it ran
// on — sits behind the Developer view (BC-7), and each fact is said once (BC-5).

import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREENS } from "@/test/vi-chrome-sessions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/projects/hop/agents/s-run",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

// jsdom lays nothing out, so the thread's stick-to-bottom has nothing to scroll
Element.prototype.scrollIntoView = () => {};
// a session's reads are stale at once, so the seeded page reads again on mount: that read stays in
// flight, or its failure would replace the page with the error state (the setup unstubs after each test)
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))));
afterEach(() => window.history.replaceState(null, "", "/"));

type Fixture = "Session · run report" | "Session · run report · developer" | "Session · chat" | "Session · chat · developer";

/** The fixture's session page; a `· developer` fixture opens it at `?view=developer`. */
async function open(name: Fixture) {
  const hit = SCREENS.find((s) => s.name === name);
  if (!hit) throw new Error(`no fixture screen "${name}"`);
  render(hit.render());
  await screen.findAllByText("Da xong phan mot.");
  return document.body;
}

describe("a run session's page, person's view", () => {
  it("carries the Developer view switch in its header", async () => {
    await open("Session · run report");
    expect(screen.getByTestId("record-view-switch")).toBeInTheDocument();
  });

  it("reads the outcome and its cost, with no tool calls, paths, output, ids or tokens (BC-7)", async () => {
    const page = await open("Session · run report");
    expect(await screen.findByText("Da xong phan mot.")).toBeInTheDocument();
    expect(screen.getByTestId("session-summary")).toHaveTextContent("$1.25");
    for (const agentText of ["src/dang-nhap.ts", "that bai: 1 loi", "s-run", "/srv/hop", "Tokens in / out", "Ran pnpm test"])
      expect(within(page).queryByText(agentText, { exact: false }), agentText).toBeNull();
    expect(screen.queryByRole("button", { name: "Transcript" })).toBeNull();
  });

  it("says each fact once: one Open issue, one status, one cost (BC-5)", async () => {
    await open("Session · run report");
    await screen.findByText("Da xong phan mot.");
    expect(screen.getAllByRole("button", { name: "Open issue" })).toHaveLength(1);
    expect(screen.getAllByText("Failed")).toHaveLength(1);
    expect(screen.getAllByText("$1.25")).toHaveLength(1);
  });
});

describe("a run session's page, developer view", () => {
  it("draws the files, the lenses, the raw output and the id (BC-7)", async () => {
    await open("Session · run report · developer");
    expect(await screen.findByRole("button", { name: "Transcript" })).toBeInTheDocument();
    expect(screen.getAllByText("src/dang-nhap.ts").length).toBeGreaterThan(0);
    expect(screen.getAllByText("that bai: 1 loi", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("s-run")).toBeInTheDocument();
  });

  it("still says each fact once: one Open issue, and the error count only where the error is shown (BC-5)", async () => {
    await open("Session · run report · developer");
    await screen.findByRole("button", { name: "Transcript" });
    expect(screen.getAllByRole("button", { name: "Open issue" })).toHaveLength(1);
    expect(screen.queryByText(/· 1 errors/)).toBeNull();
    expect(screen.getAllByText("$1.25")).toHaveLength(1);
  });
});

describe("a chat session's page", () => {
  it("reads the conversation without the agent's tool calls, task list or rail in the person's view (BC-7)", async () => {
    const page = await open("Session · chat");
    expect(await screen.findByText("Hay sua loi dang nhap")).toBeInTheDocument();
    expect(screen.getByText("Da xong phan mot.")).toBeInTheDocument();
    for (const agentText of ["Ran pnpm test", "Viec mot", "may-1", "src/moi.ts", "s-chat"])
      expect(within(page).queryByText(agentText, { exact: false }), agentText).toBeNull();
  });

  it("draws tool calls and the rail in the developer view, the status and task count once (BC-5, BC-7)", async () => {
    await open("Session · chat · developer");
    expect(await screen.findByText("Ran pnpm test")).toBeInTheDocument();
    expect(screen.getAllByText("may-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Idle")).toHaveLength(1);
    expect(screen.queryByText("2 tasks")).toBeNull();
  });
});
