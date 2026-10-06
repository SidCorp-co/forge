// Asking for designs runs a job on the project's box, so nothing starts on one click (dev.55): the
// ask opens a confirm naming what the job does and what it costs, the owner's request rides the start
// as its first thread message, and a refused start says why by name inside the dialog.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { useAskForDesigns } from "./ask-for-designs";

const show = vi.hoisted(() => vi.fn());
vi.mock("@/features/chat-dock/dock", () => ({ useChatDock: () => ({ show }) }));
beforeEach(() => show.mockReset());

function Door({ action }: { action: "start" | "reanalyze" | "open" }) {
  const ask = useAskForDesigns("p1");
  return (
    <>
      <button type="button" onClick={() => ask.ask(action)}>
        ask
      </button>
      {ask.error ? <p data-testid="join-refused">{ask.error}</p> : null}
      {ask.dialog}
    </>
  );
}

function renderDoor(action: "start" | "reanalyze" | "open") {
  renderWithQuery(<Door action={action} />);
  return { show, user: userEvent.setup() };
}

const opened = { onboarding: { conversationId: "room-1" } };

describe("asking for the first designs", () => {
  it("starts nothing on the ask: it opens a confirm saying what the job does and costs", async () => {
    const calls = fakeCore(() => undefined);
    const { user } = renderDoor("start");
    await user.click(screen.getByRole("button", { name: "ask" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Ask for the first designs" });
    expect(dialog).toHaveTextContent("Nothing starts until you confirm");
    expect(calls).toEqual([]);
  });

  it("carries the owner's request to the start, and opens the onboarding room", async () => {
    const calls = fakeCore(() => ({ body: opened }));
    const { show, user } = renderDoor("start");
    await user.click(screen.getByRole("button", { name: "ask" }));
    await user.type(await screen.findByTestId("ask-for-designs-request"), "draw against REQ-1");
    await user.click(screen.getByRole("button", { name: "Start the analysis" }));
    await waitFor(() => expect(show).toHaveBeenCalledWith({ kind: "room", projectId: "p1", conversationId: "room-1" }));
    expect(calls).toEqual([{ method: "POST", path: "/projects/p1/onboarding/start", body: { request: "draw against REQ-1" } }]);
  });

  it("sends no request when the owner wrote none", async () => {
    const calls = fakeCore(() => ({ body: opened }));
    const { show, user } = renderDoor("start");
    await user.click(screen.getByRole("button", { name: "ask" }));
    await user.click(await screen.findByRole("button", { name: "Start the analysis" }));
    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(calls[0]?.body).toEqual({});
  });

  it("names a refused start inside the dialog and opens no room", async () => {
    fakeCore(() => ({
      status: 409,
      body: {
        error: {
          code: "ONBOARDING_REFUSED",
          message: "refused",
          refusals: [{ code: "ONBOARDING_ALREADY_RUNNING", path: "", detail: "an analysis job is already running for this project" }],
        },
      },
    }));
    const { show, user } = renderDoor("start");
    await user.click(screen.getByRole("button", { name: "ask" }));
    await user.click(await screen.findByRole("button", { name: "Start the analysis" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("an analysis job is already running for this project");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(show).not.toHaveBeenCalled();
  });
});

describe("asking for a re-analysis", () => {
  it("confirms first and carries the reason to the re-analysis", async () => {
    const calls = fakeCore(() => ({ body: opened }));
    const { show, user } = renderDoor("reanalyze");
    await user.click(screen.getByRole("button", { name: "ask" }));
    await screen.findByRole("alertdialog", { name: "Ask for a re-analysis" });
    expect(calls).toEqual([]);
    await user.type(screen.getByTestId("ask-for-designs-request"), "orders were rewritten");
    await user.click(screen.getByRole("button", { name: "Start the re-analysis" }));
    await waitFor(() => expect(show).toHaveBeenCalled());
    expect(calls).toEqual([{ method: "POST", path: "/projects/p1/onboarding/reanalyze", body: { reason: "orders were rewritten" } }]);
  });
});

describe("opening a thread that exists", () => {
  it("costs nothing, so it joins at once with no confirm", async () => {
    const calls = fakeCore(() => ({ body: opened }));
    const { show, user } = renderDoor("open");
    await user.click(screen.getByRole("button", { name: "ask" }));
    await waitFor(() => expect(show).toHaveBeenCalledWith({ kind: "room", projectId: "p1", conversationId: "room-1" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.map((c) => c.path)).toEqual(["/projects/p1/onboarding/join"]);
  });
});
